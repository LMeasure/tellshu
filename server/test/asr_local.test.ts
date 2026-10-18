// =============================================================================
// ASR 本地 provider 单测（Phase 1.5；fetch/spawn 全打桩，零真实调用）
//   1. buildSidecarSpawn：命令行 / env / cwd 纯函数断言
//   2. SidecarProcess 状态机：轮询就绪 / 启动即死 / 就绪后死 / 超时 / close
//   3. LocalAsrProvider：提交表单 / 查态 / 取稿 + sidecar 错误码 -> kind 分类
//   4. classifySidecarError：状态码 -> kind 映射
//   5. mediaStore：安全文件名（路径穿越清洗）/ 落盘 / 幂等清理
//   6. service + local provider 协作：AsrProviderError -> ApiError 映射
// 运行：cd server && npm test
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AsrProviderConfig } from '../src/config';
import { buildSidecarSpawn, SidecarProcess } from '../src/asr/sidecar';
import { LocalAsrProvider, classifySidecarError } from '../src/asr/providers/local';
import { mediaJobDir, removeMedia, safeMediaName, saveMedia } from '../src/asr/mediaStore';
import { AsrProviderError } from '../src/asr/providerError';
import { ASR_JOB_TTL_MS } from '../src/types';
import type { AsrProvider } from '../src/asr/provider';

function makeConfig(overrides: Partial<AsrProviderConfig> = {}): AsrProviderConfig {
  return {
    provider: 'local',
    pythonPath: 'C:/venv/python.exe',
    modelDir: 'C:/models/whisper-small',
    sidecarPort: 8177,
    sidecarTimeoutMs: 10_000,
    sidecarLoadMs: 60_000,
    dataDir: 'C:/data/asr',
    debugSaveRaw: false,
    ...overrides,
  };
}

// -----------------------------------------------------------------------------
// 1. buildSidecarSpawn（纯函数）
// -----------------------------------------------------------------------------

test('buildSidecarSpawn: uvicorn 命令行 / env / cwd 正确', () => {
  const req = buildSidecarSpawn(makeConfig());
  assert.equal(req.command, 'C:/venv/python.exe');
  assert.deepEqual(req.args, ['-m', 'uvicorn', 'app:app', '--host', '127.0.0.1', '--port', '8177']);
  assert.equal(req.options.cwd.endsWith(path.join('server', 'asr_service')), true);
  assert.equal(req.options.windowsHide, true);
  assert.equal(req.options.env.ASR_PORT, '8177');
  assert.equal(req.options.env.ASR_MODEL_DIR, 'C:/models/whisper-small');
  assert.equal(req.options.env.ASR_PRELOAD_MODEL, 'true');
  // 结果落盘目录与 Node 的 in/ 同根：data/asr/out
  assert.equal(req.options.env.ASR_OUT_DIR, path.join('C:/data/asr', 'out'));
});

test('buildSidecarSpawn: modelDir 缺省不注入（sidecar 用自己默认）', () => {
  // config 模块顶层 loadDotenv() 会把 server/.env 灌进 process.env，
  // 这里显式清掉 ambient 值再断言「不注入」
  const prev = process.env.ASR_MODEL_DIR;
  delete process.env.ASR_MODEL_DIR;
  try {
    const req = buildSidecarSpawn(makeConfig({ modelDir: null }));
    assert.equal(req.options.env.ASR_MODEL_DIR, undefined);
  } finally {
    if (prev !== undefined) process.env.ASR_MODEL_DIR = prev;
  }
});

// -----------------------------------------------------------------------------
// 2. SidecarProcess 状态机
// -----------------------------------------------------------------------------

/** 假子进程：EventEmitter + kill/stdout/stderr。kill 后下一 tick 发 exit（close 不苦等 3s）。 */
class FakeChild extends EventEmitter {
  killed = false;
  exitCode: number | null = null;
  lastSignal: string | undefined;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();

  kill(signal?: string): boolean {
    this.killed = true;
    this.lastSignal = signal;
    process.nextTick(() => this.emit('exit', 0));
    return true;
  }
}

interface FakeClock {
  now: () => number;
  advance: (ms: number) => void;
}

function makeClock(): FakeClock {
  let t = 0;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

/** 把事件循环让给 _boot 的轮询循环（每次一个 macrotask turn）。 */
async function pumpUntilSettled(sidecar: SidecarProcess, tries = 100): Promise<void> {
  for (let i = 0; i < tries && sidecar.getState() === 'starting'; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** 注入用 sleep：推进假时钟 + 让出事件循环（保底不挂死）。 */
function makeFakeSleep(clock: FakeClock): (ms: number) => Promise<void> {
  return (ms: number) =>
    new Promise<void>((resolve) =>
      setImmediate(() => {
        clock.advance(ms);
        resolve();
      }),
    );
}

async function withSidecar(
  options: {
    readyAfterPolls?: number;
    exitOnStart?: boolean;
    readyThenExit?: boolean;
  },
  fn: (sidecar: SidecarProcess, child: FakeChild, clock: FakeClock) => Promise<void>,
): Promise<void> {
  const clock = makeClock();
  const child = new FakeChild();
  let polls = 0;
  const spawnImpl = (() => child) as unknown as typeof import('node:child_process').spawn;
  const fetchImpl = (async () => {
    polls += 1;
    if (options.readyAfterPolls !== undefined && polls >= options.readyAfterPolls) {
      return new Response('{"status":"ok"}', { status: 200 });
    }
    throw new Error('connect ECONNREFUSED');
  }) as unknown as typeof fetch;

  const sidecar = new SidecarProcess(makeConfig(), {
    spawnImpl,
    fetchImpl,
    sleepImpl: makeFakeSleep(clock),
    nowImpl: clock.now,
  });
  sidecar.start();
  if (options.exitOnStart) {
    child.emit('exit', 1);
  }
  await pumpUntilSettled(sidecar);
  if (options.readyThenExit) {
    assert.equal(sidecar.getState(), 'ready', '前置步骤：应先就绪');
    child.emit('exit', 1);
    await pumpUntilSettled(sidecar);
  }
  try {
    await fn(sidecar, child, clock);
  } finally {
    await sidecar.close();
  }
}

/** 已就绪的桩 sidecar（provider 测试用：waitReady 立即放行）。 */
async function makeReadyStubSidecar(): Promise<SidecarProcess> {
  const child = new FakeChild();
  const spawnImpl = (() => child) as unknown as typeof import('node:child_process').spawn;
  const fetchImpl = (async () => new Response('{"status":"ok"}', { status: 200 })) as unknown as typeof fetch;
  const sidecar = new SidecarProcess(makeConfig(), {
    spawnImpl,
    fetchImpl,
    sleepImpl: (ms: number) => new Promise<void>((resolve) => setImmediate(() => resolve())),
  });
  sidecar.start();
  await pumpUntilSettled(sidecar);
  assert.equal(sidecar.getState(), 'ready');
  return sidecar;
}

test('SidecarProcess: health 轮询直到 200 -> ready，waitReady 立即放行', async () => {
  await withSidecar({ readyAfterPolls: 3 }, async (sidecar) => {
    await sidecar.waitReady(1000); // 不抛即过
    assert.equal(sidecar.getState(), 'ready');
  });
});

test('SidecarProcess: 启动即退出 -> dead 终态，waitReady 带原因拒绝', async () => {
  await withSidecar({ exitOnStart: true }, async (sidecar) => {
    assert.equal(sidecar.getState(), 'dead');
    await assert.rejects(sidecar.waitReady(1000), (error: unknown) => {
      assert.ok(error instanceof AsrProviderError);
      assert.equal(error.kind, 'unavailable');
      assert.match(error.message, /转录服务进程退出/);
      return true;
    });
  });
});

test('SidecarProcess: 就绪后进程死亡 -> dead（回归：修复前卡在 ready）', async () => {
  await withSidecar({ readyAfterPolls: 1, readyThenExit: true }, async (sidecar) => {
    assert.equal(sidecar.getState(), 'dead');
    await assert.rejects(sidecar.waitReady(1000), (error: unknown) => {
      assert.ok(error instanceof AsrProviderError);
      assert.match(error.message, /转录服务进程退出/);
      return true;
    });
  });
});

test('SidecarProcess: health 超时 -> dead（模型加载不来不装就绪）', async () => {
  const clock = makeClock();
  const child = new FakeChild();
  const spawnImpl = (() => child) as unknown as typeof import('node:child_process').spawn;
  const fetchImpl = (async () => {
    throw new Error('ECONNREFUSED');
  }) as unknown as typeof fetch;
  const sidecar = new SidecarProcess(makeConfig({ sidecarLoadMs: 2_000 }), {
    spawnImpl,
    fetchImpl,
    sleepImpl: makeFakeSleep(clock),
    nowImpl: clock.now,
  });
  sidecar.start();
  // 假时钟随轮询 sleep 推进：越过 2s 宽限后循环自行走超时分支
  await pumpUntilSettled(sidecar);
  assert.equal(sidecar.getState(), 'dead');
  await assert.rejects(sidecar.waitReady(1_000), /初始化超时/);
  await sidecar.close();
});

test('SidecarProcess: close() 发 SIGTERM（Node 退出带走子进程）', async () => {
  await withSidecar({ readyAfterPolls: 1 }, async (_s, child) => {
    await _s.close();
    assert.equal(child.killed, true);
    assert.equal(child.lastSignal, 'SIGTERM');
  });
});

// -----------------------------------------------------------------------------
// 3. LocalAsrProvider
// -----------------------------------------------------------------------------

interface StubFetchRouter {
  (url: string, init?: RequestInit): Promise<Response>;
}

function makeRouter(handler: StubFetchRouter): typeof fetch {
  return handler as unknown as typeof fetch;
}

test('local provider: submit 表单带 path/job_id/language，202 解析 providerJobId', async () => {
  // as 断言打破控制流收窄：赋值发生在桩闭包里，TS 静态看不到
  let seenBody = null as FormData | null;
  const fetchImpl = makeRouter(async (_url, init) => {
    seenBody = init?.body as FormData;
    return new Response(JSON.stringify({ job_id: 'job-abc', status: 'queued' }), { status: 202 });
  });
  const provider = new LocalAsrProvider(makeConfig(), { sidecar: await makeReadyStubSidecar(), fetchImpl });
  const result = await provider.submit({
    filePath: 'C:/data/asr/in/j1/clip.mp3',
    fileName: 'clip.mp3',
    language: 'zh',
    nodeJobId: 'j1',
  });
  assert.deepEqual(result, { providerJobId: 'job-abc' });
  assert.ok(seenBody !== null);
  assert.equal(seenBody?.get('path'), 'C:/data/asr/in/j1/clip.mp3');
  assert.equal(seenBody?.get('job_id'), 'j1');
  assert.equal(seenBody?.get('language'), 'zh');
});

test('local provider: sidecar 503/410/415/400 -> kind 分类', async () => {
  const cases: Array<{ status: number; code: string; kind: string }> = [
    { status: 503, code: 'SIDECAR_BUSY', kind: 'unavailable' },
    { status: 410, code: 'INPUT_FILE_GONE', kind: 'bad_file' },
    { status: 415, code: 'UNSUPPORTED_MEDIA_TYPE', kind: 'bad_file' },
    { status: 400, code: 'EMPTY_FILE', kind: 'bad_file' },
  ];
  for (const item of cases) {
    const fetchImpl = makeRouter(async () =>
      new Response(JSON.stringify({ success: false, code: item.code, error: '服务说不行' }), { status: item.status }),
    );
    const provider = new LocalAsrProvider(makeConfig(), { sidecar: await makeReadyStubSidecar(), fetchImpl });
    await assert.rejects(
      provider.submit({ filePath: 'x', fileName: 'x.mp3', language: null, nodeJobId: 'j' }),
      (error: unknown) => {
        assert.ok(error instanceof AsrProviderError, `${item.status} 应抛 AsrProviderError`);
        assert.equal(error.kind, item.kind, `${item.code} -> ${item.kind}`);
        return true;
      },
    );
  }
});

test('local provider: 网络错误 -> unavailable，AbortError -> timeout', async () => {
  const netDown = makeRouter(async () => {
    throw new Error('fetch failed');
  });
  const p1 = new LocalAsrProvider(makeConfig(), { sidecar: await makeReadyStubSidecar(), fetchImpl: netDown });
  await assert.rejects(
    p1.submit({ filePath: 'x', fileName: 'x.mp3', language: null, nodeJobId: 'j' }),
    (error: unknown) => {
      assert.ok(error instanceof AsrProviderError);
      assert.equal(error.kind, 'unavailable');
      return true;
    },
  );

  const aborted = makeRouter(async () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    throw err;
  });
  const p2 = new LocalAsrProvider(makeConfig(), { sidecar: await makeReadyStubSidecar(), fetchImpl: aborted });
  await assert.rejects(
    p2.getStatus('j'),
    (error: unknown) => {
      assert.ok(error instanceof AsrProviderError);
      assert.equal(error.kind, 'timeout');
      return true;
    },
  );
});

test('local provider: getStatus 四态映射 + 404 如实报 failed', async () => {
  const queue: Array<{ status: number; body: unknown }> = [
    { status: 200, body: { job_id: 'j', status: 'queued' } },
    { status: 200, body: { job_id: 'j', status: 'running' } },
    { status: 200, body: { job_id: 'j', status: 'done', transcript: { language: 'zh', duration: 1, segments: [] } } },
    { status: 200, body: { job_id: 'j', status: 'failed', error: '文件无法解码' } },
  ];
  let call = 0;
  const fetchImpl = makeRouter(async () => {
    const item = queue[call] ?? { status: 200, body: { status: 'failed', error: 'unexpected' } };
    call += 1;
    return new Response(JSON.stringify(item.body), { status: item.status });
  });
  const provider = new LocalAsrProvider(makeConfig(), { sidecar: await makeReadyStubSidecar(), fetchImpl });

  assert.deepEqual(await provider.getStatus('j'), { state: 'queued', errorMessage: null });
  assert.deepEqual(await provider.getStatus('j'), { state: 'running', errorMessage: null });
  assert.deepEqual(await provider.getStatus('j'), { state: 'done', errorMessage: null });
  assert.deepEqual(await provider.getStatus('j'), { state: 'failed', errorMessage: '文件无法解码' });

  const missing = makeRouter(async () => new Response(JSON.stringify({ code: 'JOB_NOT_FOUND' }), { status: 404 }));
  const p2 = new LocalAsrProvider(makeConfig(), { sidecar: await makeReadyStubSidecar(), fetchImpl: missing });
  const r = await p2.getStatus('gone');
  assert.equal(r.state, 'failed');
  assert.match(r.errorMessage ?? '', /不存在|重启/);
});

test('local provider: fetchTranscript 只认 done 的 canonical transcript', async () => {
  const canonical = { language: 'zh', duration: 2.5, segments: [{ start: 0, end: 2.5, text: '你好' }] };
  const fetchImpl = makeRouter(async () =>
    new Response(JSON.stringify({ job_id: 'j', status: 'done', transcript: canonical }), { status: 200 }),
  );
  const provider = new LocalAsrProvider(makeConfig(), { sidecar: await makeReadyStubSidecar(), fetchImpl });
  assert.deepEqual(await provider.fetchTranscript('j'), canonical);

  const notReady = makeRouter(async () =>
    new Response(JSON.stringify({ job_id: 'j', status: 'running' }), { status: 200 }),
  );
  const p2 = new LocalAsrProvider(makeConfig(), { sidecar: await makeReadyStubSidecar(), fetchImpl: notReady });
  await assert.rejects(p2.fetchTranscript('j'), (error: unknown) => {
    assert.ok(error instanceof AsrProviderError);
    assert.equal(error.kind, 'unknown');
    return true;
  });
});

test('local provider: debugSaveRaw 落盘 data/asr-debug（默认关）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'asr-debug-'));
  const config = makeConfig({ dataDir: path.join(tmp, 'asr'), debugSaveRaw: true });
  const fetchImpl = makeRouter(async () =>
    new Response(JSON.stringify({ job_id: 'j', status: 'done', transcript: { language: 'zh', duration: 1, segments: [] } }), { status: 200 }),
  );
  const provider = new LocalAsrProvider(config, { sidecar: await makeReadyStubSidecar(), fetchImpl });
  await provider.fetchTranscript('j');
  const debugFile = path.join(tmp, 'asr-debug', 'j.json');
  const saved = JSON.parse(await fs.readFile(debugFile, 'utf8')) as { status: string };
  assert.equal(saved.status, 'done');
  await fs.rm(tmp, { recursive: true, force: true });
});

// -----------------------------------------------------------------------------
// 4. classifySidecarError（纯函数）
// -----------------------------------------------------------------------------

test('classifySidecarError: 状态码 -> kind 映射表', () => {
  assert.equal(classifySidecarError(503, null, 'x').kind, 'unavailable');
  assert.equal(classifySidecarError(410, null, 'x').kind, 'bad_file');
  assert.equal(classifySidecarError(415, null, 'x').kind, 'bad_file');
  assert.equal(classifySidecarError(400, null, 'x').kind, 'bad_file');
  assert.equal(classifySidecarError(500, null, 'x').kind, 'unknown');
  // 有 error 字段时透传可读信息
  const err = classifySidecarError(400, { error: '文件无法解码（EOFError）' }, 'fallback');
  assert.equal(err.message, '文件无法解码（EOFError）');
});

// -----------------------------------------------------------------------------
// 5. mediaStore
// -----------------------------------------------------------------------------

test('mediaStore: safeMediaName 清洗路径穿越与保留字符', () => {
  assert.equal(safeMediaName('../../etc/passwd'), 'passwd');
  assert.equal(safeMediaName('a\\b\\c.mp4'), 'c.mp4');
  assert.equal(safeMediaName(''), 'media');
  assert.equal(safeMediaName('..'), 'media');
  assert.equal(safeMediaName('..\\..\\win.mp4'), 'win.mp4');
  assert.equal(safeMediaName('  spaced .mp3 '), 'spaced .mp3');
});

test('mediaStore: saveMedia 落盘到 in/<jobId>/<安全名>，removeMedia 幂等', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'asr-media-'));
  try {
    const saved = await saveMedia(tmp, 'job-1', '../../evil.mp3', Buffer.from('audio-bytes'));
    assert.equal(saved, path.join(tmp, 'in', 'job-1', 'evil.mp3'));
    assert.equal((await fs.readFile(saved)).toString(), 'audio-bytes');
    assert.equal(mediaJobDir(tmp, 'job-1'), path.join(tmp, 'in', 'job-1'));

    await removeMedia(tmp, 'job-1');
    assert.equal(await fs.access(path.join(tmp, 'in', 'job-1')).then(() => true, () => false), false);
    // 幂等：再删一次不抛
    await removeMedia(tmp, 'job-1');
    // 不存在的任务目录同样幂等
    await removeMedia(tmp, 'never-existed');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

// -----------------------------------------------------------------------------
// 6. service + local provider 协作
// -----------------------------------------------------------------------------

/** 桩 provider：直接抛 AsrProviderError（不碰真实 sidecar）。 */
class ThrowingProvider implements AsrProvider {
  readonly name = 'throwing';
  constructor(private readonly error: AsrProviderError) {}

  async submit(): Promise<{ providerJobId: string }> {
    throw this.error;
  }

  async getStatus(): Promise<{ state: 'queued' | 'running' | 'done' | 'failed'; errorMessage: string | null }> {
    return { state: 'failed', errorMessage: null };
  }

  async fetchTranscript(): Promise<unknown> {
    return null;
  }
}

test('service: AsrProviderError(unavailable) 提交 -> ApiError 503，不留 queued 幽灵', async () => {
  const { AsrService } = await import('../src/asr/service');
  const { ApiError } = await import('../src/http/errors');
  const { AsrJobStore } = await import('../src/asr/jobStore');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'asr-svc-'));
  try {
    const store = new AsrJobStore({ ttlMs: ASR_JOB_TTL_MS });
    const provider = new ThrowingProvider(new AsrProviderError('unavailable', '转录服务进程退出（code=1），请重启服务'));
    const service = new AsrService(provider, store, tmp);
    await assert.rejects(
      service.submit({ buffer: Buffer.from('x'), fileName: 'a.mp3', mimeType: 'audio/mpeg', language: null }),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, 503);
        assert.equal(error.code, 'provider_unavailable');
        return true;
      },
    );
    // 记录落 failed（不是 queued），且 in/<jobId>/ 媒体目录已清
    const jobs = [...(store as unknown as { jobs: Map<string, { status: string; jobId: string }> }).jobs.values()];
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.status, 'failed');
    assert.equal(await fs.access(path.join(tmp, 'in', jobs[0]?.jobId ?? '')).then(() => true, () => false), false);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('service: AsrProviderError(bad_file) 提交 -> ApiError 400', async () => {
  const { AsrService } = await import('../src/asr/service');
  const { ApiError } = await import('../src/http/errors');
  const { AsrJobStore } = await import('../src/asr/jobStore');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'asr-svc-'));
  try {
    const store = new AsrJobStore({ ttlMs: ASR_JOB_TTL_MS });
    const provider = new ThrowingProvider(new AsrProviderError('bad_file', '不支持的容器：txt'));
    const service = new AsrService(provider, store, tmp);
    await assert.rejects(
      service.submit({ buffer: Buffer.from('x'), fileName: 'a.txt', mimeType: 'text/plain', language: null }),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, 400);
        assert.equal(error.code, 'provider_bad_file');
        return true;
      },
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
