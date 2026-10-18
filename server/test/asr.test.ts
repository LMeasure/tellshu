// =============================================================================
// ASR 音视频转字幕单测（Phase 1）
//   1. normalize：两种供应商响应形态 + 缺字段丢弃 + 边界值
//   2. jobStore：状态流转 + TTL 过期（410）与墓碑降解（404）
//   3. 路由（app.listen(0) + fetch 冒烟）：
//      503 未接入 / 404 不存在 / 410 已过期 / 400 字段与类型 /
//      桩供应商下 提交(202) -> 轮询(200 done) 全链路 + 媒体不落 Store
// 运行：cd server && npm test
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type express from 'express';
import type { AppConfig } from '../src/config';
import type { DictionaryRepository } from '../src/db/repository';
import type { ConvertStore } from '../src/db/convertStore';
import type { OcrPipeline } from '../src/ocr/pipeline';
import { createApp } from '../src/app';
import { AsrJobStore } from '../src/asr/jobStore';
import { normalizeProviderTranscript } from '../src/asr/normalize';
import type { AsrProvider, AsrSubmitInput } from '../src/asr/provider';
import { AsrService } from '../src/asr/service';
import { ASR_JOB_TTL_MS, ASR_MAX_FILE_BYTES } from '../src/types';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let tmpSeq = 0;
async function makeTmpDataDir(): Promise<string> {
  tmpSeq += 1;
  const dir = path.join(os.tmpdir(), `shutree-asr-test-${process.pid}-${tmpSeq}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/** 形态 A 夹具：segments（秒）。 */
const FIXTURE_SECONDS = {
  language: 'en',
  duration: 12.5,
  segments: [
    { start: 0, end: 1.5, text: 'Hello there' },
    { start: 1.5, end: 3.25, text: 'general Kenobi' },
  ],
};

/** 桩供应商：不连任何真实服务，只验证编排与归一化。 */
class StubAsrProvider implements AsrProvider {
  readonly name = 'stub';
  lastInput: AsrSubmitInput | null = null;
  state: 'queued' | 'running' | 'done' | 'failed' = 'running';
  raw: unknown = FIXTURE_SECONDS;

  async submit(input: AsrSubmitInput): Promise<{ providerJobId: string }> {
    this.lastInput = input;
    return { providerJobId: 'prov-job-1' };
  }

  async getStatus(): Promise<{ state: 'queued' | 'running' | 'done' | 'failed'; errorMessage: string | null }> {
    return { state: this.state, errorMessage: null };
  }

  async fetchTranscript(): Promise<unknown> {
    return this.raw;
  }
}

function buildApp(service: AsrService): express.Express {
  const config = {
    port: 0,
    databaseUrl: '',
    paddle: { baseUrl: '', accessToken: '', timeoutMs: 120_000, model: '' },
    adminApiKey: 'test-admin-key',
    corsOrigins: [],
    ocrPublicEnabled: false,
    translate: { url: null, apiKey: null },
    asr: {
      provider: null,
      pythonPath: null,
      modelDir: null,
      sidecarPort: 8177,
      sidecarTimeoutMs: 10_000,
      sidecarLoadMs: 60_000,
      dataDir: '',
      debugSaveRaw: false,
    },
    storageDir: '',
  } as unknown as AppConfig;
  return createApp({
    config,
    repository: {} as DictionaryRepository,
    convertStore: {} as ConvertStore,
    pipeline: {} as OcrPipeline,
    asr: service,
  });
}

async function withServer(app: express.Express, fn: (base: string) => Promise<void>): Promise<void> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function mediaForm(bytes: Buffer, name = 'clip.mp3', mime = 'audio/mpeg'): FormData {
  const form = new FormData();
  form.append('media', new Blob([bytes], { type: mime }), name);
  return form;
}

// -----------------------------------------------------------------------------
// 0. 常量
// -----------------------------------------------------------------------------

test('常量：100MB 上限与 2 小时 TTL 与方案锁定值一致', () => {
  assert.equal(ASR_MAX_FILE_BYTES, 100 * 1024 * 1024);
  assert.equal(ASR_JOB_TTL_MS, 2 * 60 * 60 * 1000);
});

// -----------------------------------------------------------------------------
// 1. normalize
// -----------------------------------------------------------------------------

test('normalize: 形态 A（segments 秒）原样收敛', () => {
  const { transcript, dropped } = normalizeProviderTranscript(FIXTURE_SECONDS);
  assert.equal(dropped, 0);
  assert.equal(transcript.language, 'en');
  assert.equal(transcript.duration, 12.5);
  assert.deepEqual(transcript.segments, [
    { start: 0, end: 1.5, text: 'Hello there' },
    { start: 1.5, end: 3.25, text: 'general Kenobi' },
  ]);
});

test('normalize: 形态 B（results.sentences 毫秒）换算成秒', () => {
  const raw = {
    results: [
      {
        sentences: [
          { start_time: 0, end_time: 1500, text: '你好' },
          { start_time: 1500, end_time: 3250, text: '世界' },
        ],
      },
    ],
  };
  const { transcript, dropped } = normalizeProviderTranscript(raw);
  assert.equal(dropped, 0);
  assert.equal(transcript.language, 'und'); // 供应商未给语言 -> und，不臆造
  assert.equal(transcript.duration, 3.25); // 由段落最大 end 推导
  assert.deepEqual(transcript.segments, [
    { start: 0, end: 1.5, text: '你好' },
    { start: 1.5, end: 3.25, text: '世界' },
  ]);
});

test('normalize: 缺字段 / end<=start / 空文本 / 负数一律丢弃并计数', () => {
  const raw = {
    segments: [
      { start: 0, end: 1, text: 'ok' },
      { start: 1, text: '缺 end' },
      { end: 2, text: '缺 start' },
      { start: 2, end: 3, text: '' },
      { start: 3, end: 2, text: '结束早于开始' },
      { start: -1, end: 2, text: '负起点' },
      { start: 4, end: 5, text: '  ' },
    ],
  };
  const { transcript, dropped } = normalizeProviderTranscript(raw);
  assert.equal(dropped, 6);
  assert.equal(transcript.segments.length, 1);
  assert.equal(transcript.segments[0]?.text, 'ok');
});

test('normalize: 数字字符串与纯标点文本的边界', () => {
  const raw = { segments: [{ start: '0', end: '1.5', text: 'x' }] };
  const { transcript, dropped } = normalizeProviderTranscript(raw);
  assert.equal(dropped, 0);
  assert.equal(transcript.segments[0]?.start, 0);
  assert.equal(transcript.segments[0]?.end, 1.5);
});

test('normalize: 非对象输入得到空结果而不是抛错', () => {
  for (const bad of [null, undefined, 42, 'nope', [1, 2]]) {
    const { transcript, dropped } = normalizeProviderTranscript(bad);
    assert.deepEqual(transcript.segments, []);
    assert.equal(transcript.duration, 0);
    assert.equal(transcript.language, 'und');
    assert.equal(dropped, 0);
  }
});

// -----------------------------------------------------------------------------
// 2. jobStore
// -----------------------------------------------------------------------------

test('jobStore: 状态流转与局部更新', () => {
  const store = new AsrJobStore({ ttlMs: 1000 });
  const record = store.create(0);
  assert.equal(record.status, 'queued');
  assert.equal(record.transcript, null);
  assert.equal(record.providerJobId, null);

  const updated = store.update(record.jobId, { status: 'done', providerJobId: 'p1' }, 10);
  assert.equal(updated?.status, 'done');
  assert.equal(updated?.providerJobId, 'p1');
  assert.equal(updated?.updatedAt, 10);
  assert.equal(store.size(), 1);
});

test('jobStore: TTL 边界——过期进墓碑（410），墓碑降解后 404', () => {
  const store = new AsrJobStore({ ttlMs: 1000 });
  const record = store.create(0);
  assert.equal(store.lookup(record.jobId, 999).kind, 'found');
  assert.equal(store.lookup(record.jobId, 1000).kind, 'expired');
  assert.equal(store.lookup(record.jobId, 1500).kind, 'expired');
  assert.equal(store.lookup(record.jobId, 2500).kind, 'missing');
  assert.equal(store.lookup('00000000-0000-4000-8000-000000000000', 0).kind, 'missing');
});

// -----------------------------------------------------------------------------
// 3. 路由冒烟
// -----------------------------------------------------------------------------

test('路由: provider 未接入时 POST /api/asr/jobs 返回 503', async () => {
  const service = new AsrService(null, new AsrJobStore({ ttlMs: ASR_JOB_TTL_MS }));
  await withServer(buildApp(service), async (base) => {
    const res = await fetch(`${base}/api/asr/jobs`, { method: 'POST', body: mediaForm(Buffer.from('x')) });
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error: { message: string } };
    assert.match(body.error.message, /未配置 ASR 供应商/);
  });
});

test('路由: 不存在的 jobId 返回 404', async () => {
  const service = new AsrService(null, new AsrJobStore({ ttlMs: ASR_JOB_TTL_MS }));
  await withServer(buildApp(service), async (base) => {
    const res = await fetch(`${base}/api/asr/jobs/00000000-0000-4000-8000-000000000000`);
    assert.equal(res.status, 404);
  });
});

test('路由: 过期 job 返回 410（与 404 区分）', async () => {
  const store = new AsrJobStore({ ttlMs: 50 });
  const service = new AsrService(null, store);
  const record = store.create();
  await sleep(150);
  await withServer(buildApp(service), async (base) => {
    const res = await fetch(`${base}/api/asr/jobs/${record.jobId}`);
    assert.equal(res.status, 410);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'job_expired');
  });
});

test('路由: 错误字段名 / 不支持的扩展名返回 400', async () => {
  const service = new AsrService(null, new AsrJobStore({ ttlMs: ASR_JOB_TTL_MS }));
  await withServer(buildApp(service), async (base) => {
    const wrongField = new FormData();
    wrongField.append('file', new Blob([Buffer.from('x')], { type: 'audio/mpeg' }), 'a.mp3');
    const res1 = await fetch(`${base}/api/asr/jobs`, { method: 'POST', body: wrongField });
    assert.equal(res1.status, 400);

    const res2 = await fetch(`${base}/api/asr/jobs`, {
      method: 'POST',
      body: mediaForm(Buffer.from('x'), 'a.exe', 'application/octet-stream'),
    });
    assert.equal(res2.status, 400);
  });
});

test('路由: 桩供应商下 提交(202) -> 轮询(200 done)，且媒体不进 JobStore', async () => {
  const provider = new StubAsrProvider();
  const store = new AsrJobStore({ ttlMs: ASR_JOB_TTL_MS });
  const dataDir = await makeTmpDataDir();
  const service = new AsrService(provider, store, dataDir);

  await withServer(buildApp(service), async (base) => {
    const res = await fetch(`${base}/api/asr/jobs`, {
      method: 'POST',
      body: mediaForm(Buffer.from('fake-audio-bytes'), 'interview.mp3', 'audio/mpeg'),
    });
    assert.equal(res.status, 202);
    const submitted = (await res.json()) as { jobId: string; status: string; error: unknown };
    assert.equal(submitted.status, 'running');
    assert.equal(submitted.error, null);

    // 媒体确实交给了 provider（本地形态：落盘路径 + 同一 jobId），随后即释放
    assert.ok(provider.lastInput !== null);
    assert.equal(provider.lastInput?.fileName, 'interview.mp3');
    assert.equal(provider.lastInput?.nodeJobId, submitted.jobId);
    assert.ok((provider.lastInput?.filePath ?? '').endsWith(path.join('in', submitted.jobId, 'interview.mp3')));
    assert.equal(await fileExists(provider.lastInput?.filePath ?? ''), true);

    // JobStore 只存任务状态 + 转录结果：记录字段全集不含任何媒体载体
    const lookup = store.lookup(submitted.jobId);
    assert.equal(lookup.kind, 'found');
    if (lookup.kind !== 'found') return;
    assert.deepEqual(Object.keys(lookup.record).sort(), [
      'createdAt',
      'error',
      'expiresAt',
      'jobId',
      'providerJobId',
      'status',
      'transcript',
      'updatedAt',
    ]);
    assert.equal(lookup.record.transcript, null);

    // 供应商侧完成后，轮询一次即拿到归一化结果
    provider.state = 'done';
    const poll = await fetch(`${base}/api/asr/jobs/${submitted.jobId}`);
    assert.equal(poll.status, 200);
    const job = (await poll.json()) as {
      status: string;
      transcript: { language: string; duration: number; segments: unknown[] } | null;
    };
    assert.equal(job.status, 'done');
    assert.equal(job.transcript?.language, 'en');
    assert.equal(job.transcript?.duration, 12.5);
    assert.equal(job.transcript?.segments.length, 2);

    // done 之后再查：直接回存储结果，不再打供应商
    const again = await fetch(`${base}/api/asr/jobs/${submitted.jobId}`);
    assert.equal(again.status, 200);
    const job2 = (await again.json()) as { status: string };
    assert.equal(job2.status, 'done');

    // 终态清理：in/<jobId>/ 媒体目录已删除（Phase 1.5 本地形态的生命周期收尾）
    assert.equal(await fileExists(path.join(dataDir, 'in', submitted.jobId)), false);
    await fs.rm(dataDir, { recursive: true, force: true });
  });
});

test('路由: 提交即败时 202 + status=failed，轮询一次即见失败原因', async () => {
  const provider = new StubAsrProvider();
  provider.submit = async () => {
    throw new Error('供应商拒绝了请求');
  };
  const store = new AsrJobStore({ ttlMs: ASR_JOB_TTL_MS });
  const dataDir = await makeTmpDataDir();
  const service = new AsrService(provider, store, dataDir);

  await withServer(buildApp(service), async (base) => {
    const res = await fetch(`${base}/api/asr/jobs`, { method: 'POST', body: mediaForm(Buffer.from('x')) });
    assert.equal(res.status, 202);
    const submitted = (await res.json()) as { jobId: string; status: string; error: { message: string } | null };
    assert.equal(submitted.status, 'failed');
    assert.equal(submitted.error?.message, '供应商拒绝了请求');

    const poll = await fetch(`${base}/api/asr/jobs/${submitted.jobId}`);
    assert.equal(poll.status, 200);
    const job = (await poll.json()) as { status: string; error: { message: string } | null };
    assert.equal(job.status, 'failed');
    assert.equal(job.error?.message, '供应商拒绝了请求');

    // 提交失败即清媒体：不留 in/<jobId>/ 残留目录
    assert.equal(await fileExists(path.join(dataDir, 'in', submitted.jobId)), false);
    await fs.rm(dataDir, { recursive: true, force: true });
  });
});
