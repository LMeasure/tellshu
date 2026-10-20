// =============================================================================
// AI 学习稿生成单测（Phase 2 M2）
//   1. llm：凭据检查 + 端点归一化 + 流式累加 / [DONE] 与坏行容忍 /
//      上游错 / 未接入 / 网络不可用 / 双超时 / 外部中断
//   2. llmStudyNote：请求体解析 + 契约校验（坏项丢弃、缺 pos 回退、去重、
//      全空判败）+ 生成编排（围栏 JSON / 非 JSON / 请求体与 prompt 断言）
//   3. 路由（app.listen(0) + fetch 冒烟）：503 未接入 / 400 坏体与超段数 /
//      SSE delta+done 全链路 / 客户端断开 → 上游 abort（防白烧 token）
// 运行：cd server && npm test
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type express from 'express';
import type { AppConfig, AiConfig } from '../src/config';
import type { DictionaryRepository } from '../src/db/repository';
import type { ConvertStore } from '../src/db/convertStore';
import type { OcrPipeline } from '../src/ocr/pipeline';
import { createApp } from '../src/app';
import { isAiConfigured, resolveChatEndpoint, streamLLM, LlmError } from '../src/llm';
import { parseStudyNoteRequest, runStudyNoteGeneration, validateStudyNotePayload } from '../src/llmStudyNote';
import type { AsrTranscript, StudyNotePayload } from '../src/types';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// -----------------------------------------------------------------------------
// 打桩工具
// -----------------------------------------------------------------------------

function makeAbortError(): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

/** OpenAI 流式 chunk（delta 形态）。 */
function openaiDelta(content: string): unknown {
  return { id: 'chatcmpl-stub', choices: [{ index: 0, delta: { content }, finish_reason: null }] };
}

function sseLine(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** 完整 SSE 响应：立即吐完全部 data 行并关闭。 */
function completeResponse(lines: string[], init: { ok?: boolean; status?: number; detail?: string } = {}): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line));
      controller.close();
    },
  });
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    body: stream,
    text: async () => init.detail ?? '',
  } as unknown as Response;
}

/**
 * 挂起响应：enqueue 给定行后不关闭（read 第二块永远 pending）；
 * errorStream 由调用方在 abort 时触发，模拟真实 fetch 断连。
 */
function stallingResponse(lines: string[] = []): { response: Response; errorStream: (error: unknown) => void } {
  const encoder = new TextEncoder();
  let errorStream: ((error: unknown) => void) | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line));
      errorStream = (error) => {
        try {
          controller.error(error);
        } catch {
          /* 流已关闭：忽略 */
        }
      };
    },
  });
  return {
    response: { ok: true, status: 200, body: stream, text: async () => '' } as unknown as Response,
    errorStream: (error) => errorStream?.(error),
  };
}

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  signal: AbortSignal | null;
}

/** 记录请求详情 + 可回查 signal 的桩 fetch 工厂。 */
function makeStubFetch(
  handler: (call: { url: string; init: RequestInit }) => Response | Promise<Response>,
): typeof fetch {
  const impl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const rawUrl = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    const requestInit: RequestInit = init ?? {};
    // 真实 fetch：已中断的 signal 直接拒绝，不打网络
    if (requestInit.signal?.aborted === true) throw makeAbortError();
    return handler({ url: rawUrl, init: requestInit });
  };
  return impl as unknown as typeof fetch;
}

/** 记录调用的桩 fetch（返回给定响应；abort 时按需 error 流）。 */
function recordingStreamFetch(response: () => { response: Response; errorStream: (error: unknown) => void } | Response): {
  fetchImpl: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl = makeStubFetch(({ url, init }) => {
    const signal = (init.signal ?? null) as AbortSignal | null;
    const record: RecordedCall = {
      url,
      method: init.method ?? 'GET',
      headers: (init.headers ?? {}) as Record<string, string>,
      body:
        typeof init.body === 'string'
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : {},
      signal,
    };
    calls.push(record);
    const made = response();
    if ('errorStream' in made) {
      if (signal !== null) {
        signal.addEventListener('abort', () => made.errorStream(makeAbortError()), { once: true });
      }
      return made.response;
    }
    return made;
  });
  return { fetchImpl, calls };
}

const AI_ON: AiConfig = {
  baseUrl: 'https://llm.example.com/v1',
  apiKey: 'test-key-not-real',
  model: 'test-model',
  firstTokenMs: 30_000,
  streamMs: 120_000,
  maxSegments: 1_200,
};

const FIXTURE_TRANSCRIPT: AsrTranscript = {
  language: 'en',
  duration: 12.5,
  segments: [
    { start: 0, end: 1.5, text: 'Hello there' },
    { start: 1.5, end: 3.25, text: 'general Kenobi' },
    { start: 3.25, end: 6, text: 'You are a bold one' },
  ],
};

const GOOD_NOTE_JSON: StudyNotePayload = {
  summary: '一段关于礼貌问候的对话。',
  bilingual_notes: [{ en: 'Hello there', zh: '你好。' }],
  key_points: ['There 用于引起注意'],
  vocabulary: [{ word: 'bold', pos: 'adjective', gloss: '大胆的' }],
};

// -----------------------------------------------------------------------------
// 1. llm 基础
// -----------------------------------------------------------------------------

test('isAiConfigured: 三项齐备才 true，缺一即 false', () => {
  assert.equal(isAiConfigured(AI_ON), true);
  assert.equal(isAiConfigured({ ...AI_ON, baseUrl: null }), false);
  assert.equal(isAiConfigured({ ...AI_ON, apiKey: '   ' }), false);
  assert.equal(isAiConfigured({ ...AI_ON, model: null }), false);
});

test('resolveChatEndpoint: 裸基址自动拼、已含路径原样用、去尾斜杠', () => {
  assert.equal(resolveChatEndpoint('https://llm.example.com/v1'), 'https://llm.example.com/v1/chat/completions');
  assert.equal(resolveChatEndpoint('https://llm.example.com/v1/'), 'https://llm.example.com/v1/chat/completions');
  assert.equal(
    resolveChatEndpoint('https://llm.example.com/v1/chat/completions'),
    'https://llm.example.com/v1/chat/completions',
  );
});

// -----------------------------------------------------------------------------
// 2. streamLLM 行为
// -----------------------------------------------------------------------------

test('streamLLM: 多 chunk 流式累加，onToken 逐段回调，[DONE] 与坏行不致命', async () => {
  const { fetchImpl, calls } = recordingStreamFetch(() =>
    completeResponse([
      sseLine(openaiDelta('你')),
      sseLine(openaiDelta('好')),
      'data: [DONE]\n\n',
      'data: {坏行，直接 ignor\n\n',
      'data: \n\n',
      sseLine({ choices: [] }), // 无 delta：空 token，不回调
    ]),
  );
  const seen: string[] = [];
  const full = await streamLLM([{ role: 'user', content: 'hi' }], (token) => seen.push(token), {
    config: AI_ON,
    fetchImpl,
  });
  assert.equal(full, '你好');
  assert.deepEqual(seen, ['你', '好']);
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.ok(call !== undefined);
  assert.equal(call.url, 'https://llm.example.com/v1/chat/completions');
  assert.equal(call.method, 'POST');
  assert.equal(call.headers['Authorization'], 'Bearer test-key-not-real');
  const body = call.body as { model: string; stream: boolean; messages: unknown[] };
  assert.equal(body.model, 'test-model');
  assert.equal(body.stream, true);
  assert.equal(body.messages.length, 1);
});

test('streamLLM: 上游 4xx/5xx 抛 upstream 且带 status', async () => {
  const { fetchImpl } = recordingStreamFetch(() => completeResponse([], { ok: false, status: 429, detail: 'rate limited' }));
  await assert.rejects(
    () => streamLLM([{ role: 'user', content: 'hi' }], () => {}, { config: AI_ON, fetchImpl }),
    (error: unknown) => {
      assert.ok(error instanceof LlmError);
      assert.equal(error.kind, 'upstream');
      assert.equal(error.status, 429);
      assert.match(error.message, /rate limited/);
      return true;
    },
  );
});

test('streamLLM: 未配置直接 unconfigured（不打上游）', async () => {
  const { fetchImpl, calls } = recordingStreamFetch(() => completeResponse([sseLine(openaiDelta('x'))]));
  await assert.rejects(
    () =>
      streamLLM([{ role: 'user', content: 'hi' }], () => {}, {
        config: { ...AI_ON, apiKey: null },
        fetchImpl,
      }),
    (error: unknown) => {
      assert.ok(error instanceof LlmError);
      assert.equal(error.kind, 'unconfigured');
      return true;
    },
  );
  assert.equal(calls.length, 0);
});

test('streamLLM: fetch 抛网络错 → unavailable', async () => {
  const fetchImpl = makeStubFetch(() => {
    throw new Error('ECONNREFUSED');
  });
  await assert.rejects(
    () => streamLLM([{ role: 'user', content: 'hi' }], () => {}, { config: AI_ON, fetchImpl }),
    (error: unknown) => {
      assert.ok(error instanceof LlmError);
      assert.equal(error.kind, 'unavailable');
      assert.match(error.message, /ECONNREFUSED/);
      return true;
    },
  );
});

test('streamLLM: 首 token 超时 → timeout_first_token', async () => {
  const { fetchImpl } = recordingStreamFetch(() => stallingResponse([]));
  await assert.rejects(
    () =>
      streamLLM([{ role: 'user', content: 'hi' }], () => {}, {
        config: { ...AI_ON, firstTokenMs: 50 },
        fetchImpl,
      }),
    (error: unknown) => {
      assert.ok(error instanceof LlmError);
      assert.equal(error.kind, 'timeout_first_token');
      return true;
    },
  );
});

test('streamLLM: 总流式超时 → timeout_stream（首 token 已到，first-token 计时已解除）', async () => {
  const { fetchImpl } = recordingStreamFetch(() => stallingResponse([sseLine(openaiDelta('开'))]));
  await assert.rejects(
    () =>
      streamLLM([{ role: 'user', content: 'hi' }], () => {}, {
        config: { ...AI_ON, firstTokenMs: 10_000, streamMs: 50 },
        fetchImpl,
      }),
    (error: unknown) => {
      assert.ok(error instanceof LlmError);
      assert.equal(error.kind, 'timeout_stream');
      return true;
    },
  );
});

test('streamLLM: 调用前外部已中断 → aborted（桩模拟真 fetch 直接拒绝）', async () => {
  const outer = new AbortController();
  outer.abort();
  const { fetchImpl, calls } = recordingStreamFetch(() => completeResponse([sseLine(openaiDelta('x'))]));
  await assert.rejects(
    () =>
      streamLLM([{ role: 'user', content: 'hi' }], () => {}, {
        config: AI_ON,
        fetchImpl,
        signal: outer.signal,
      }),
    (error: unknown) => {
      assert.ok(error instanceof LlmError);
      assert.equal(error.kind, 'aborted');
      return true;
    },
  );
  // 真实 fetch 收到已中断的 signal 会直接拒绝、不打网络：桩同行为，handler 未被调用
  assert.equal(calls.length, 0);
});

test('streamLLM: 流式中外部中断 → aborted 且上游 signal 被 abort', async () => {
  const outer = new AbortController();
  const stall = stallingResponse([sseLine(openaiDelta('你'))]);
  const { fetchImpl, calls } = recordingStreamFetch(() => stall);
  await assert.rejects(
    () =>
      streamLLM(
        [{ role: 'user', content: 'hi' }],
        (token) => {
          if (token === '你') outer.abort(); // 首个 token 后模拟客户端断开
        },
        { config: AI_ON, fetchImpl, signal: outer.signal },
      ),
    (error: unknown) => {
      assert.ok(error instanceof LlmError);
      assert.equal(error.kind, 'aborted');
      return true;
    },
  );
  assert.equal(calls[0]?.signal?.aborted, true);
});

// -----------------------------------------------------------------------------
// 3. llmStudyNote：请求体解析
// -----------------------------------------------------------------------------

test('parseStudyNoteRequest: 合法 canonical 原样通过', () => {
  const result = parseStudyNoteRequest({ transcript: FIXTURE_TRANSCRIPT });
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.request.transcript, FIXTURE_TRANSCRIPT);
});

test('parseStudyNoteRequest: 坏形状族逐一拒绝', () => {
  const cases: unknown[] = [
    null,
    {},
    { transcript: 'x' },
    { transcript: { ...FIXTURE_TRANSCRIPT, language: '' } },
    { transcript: { ...FIXTURE_TRANSCRIPT, language: 42 } },
    { transcript: { ...FIXTURE_TRANSCRIPT, duration: -1 } },
    { transcript: { ...FIXTURE_TRANSCRIPT, duration: '12' } },
    { transcript: { ...FIXTURE_TRANSCRIPT, segments: {} } },
    { transcript: { ...FIXTURE_TRANSCRIPT, segments: [] } },
    { transcript: { ...FIXTURE_TRANSCRIPT, segments: [{ start: 1, end: 0.5, text: '逆序' }] } },
    { transcript: { ...FIXTURE_TRANSCRIPT, segments: [{ start: 0, end: 1, text: '  ' }] } },
    { transcript: { ...FIXTURE_TRANSCRIPT, segments: ['不是对象'] } },
  ];
  for (const body of cases) {
    const result = parseStudyNoteRequest(body);
    assert.equal(result.ok, false, `应当拒绝：${JSON.stringify(body)}`);
  }
});

// -----------------------------------------------------------------------------
// 4. llmStudyNote：契约校验
// -----------------------------------------------------------------------------

test('validateStudyNotePayload: 完整四要素原样通过', () => {
  const payload = validateStudyNotePayload(structuredClone(GOOD_NOTE_JSON));
  assert.deepEqual(payload, GOOD_NOTE_JSON);
});

test('validateStudyNotePayload: 坏项静默丢弃、缺 pos 回退空串、重复词去重', () => {
  const payload = validateStudyNotePayload({
    summary: '有摘要就不算空。',
    bilingual_notes: [
      { en: 'ok', zh: '好' },
      { en: '缺译文' }, // 丢
      { zh: '缺原文' }, // 丢
      '不是对象', // 丢
    ],
    key_points: ['保留', 42, '  '], // 数字与空串丢
    vocabulary: [
      { word: 'bold', gloss: '大胆的' }, // 缺 pos：回退空串，词保留
      { word: 'Bold', pos: 'adjective', gloss: '重复词' }, // 大小写重复：丢
      { word: '缺释义' }, // 丢
      { word: 'phrase', pos: 'phrase', gloss: '短语' },
    ],
  });
  assert.ok(payload !== null);
  assert.deepEqual(payload.bilingual_notes, [{ en: 'ok', zh: '好' }]);
  assert.deepEqual(payload.key_points, ['保留']);
  assert.deepEqual(payload.vocabulary, [
    { word: 'bold', pos: '', gloss: '大胆的' },
    { word: 'phrase', pos: 'phrase', gloss: '短语' },
  ]);
});

test('validateStudyNotePayload: 四要素全空判 null；缺 summary 但有词汇仍通过', () => {
  assert.equal(validateStudyNotePayload({ summary: '', bilingual_notes: [], key_points: [], vocabulary: [] }), null);
  assert.equal(validateStudyNotePayload({}), null);
  assert.equal(validateStudyNotePayload('not an object'), null);
  const partial = validateStudyNotePayload({ vocabulary: [{ word: 'x', pos: 'noun', gloss: '某' }] });
  assert.deepEqual(partial, { summary: '', bilingual_notes: [], key_points: [], vocabulary: [{ word: 'x', pos: 'noun', gloss: '某' }] });
});

// -----------------------------------------------------------------------------
// 5. llmStudyNote：生成编排
// -----------------------------------------------------------------------------

test('runStudyNoteGeneration: 围栏 JSON 多 chunk 流式 → 四要素 payload', async () => {
  const raw = JSON.stringify(GOOD_NOTE_JSON);
  const fenced = '```json\n' + raw + '\n```';
  const lines = [sseLine(openaiDelta(fenced.slice(0, 10))), sseLine(openaiDelta(fenced.slice(10))), 'data: [DONE]\n\n'];
  const { fetchImpl } = recordingStreamFetch(() => completeResponse(lines));
  const note = await runStudyNoteGeneration({ transcript: FIXTURE_TRANSCRIPT }, { config: AI_ON, fetchImpl });
  assert.deepEqual(note, GOOD_NOTE_JSON);
});

test('runStudyNoteGeneration: 请求体断言（endpoint/model/stream/凭据/段文本与时间戳进 prompt）', async () => {
  const { fetchImpl, calls } = recordingStreamFetch(() =>
    completeResponse([sseLine(openaiDelta(JSON.stringify(GOOD_NOTE_JSON))), 'data: [DONE]\n\n']),
  );
  await runStudyNoteGeneration({ transcript: FIXTURE_TRANSCRIPT }, { config: AI_ON, fetchImpl });
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.ok(call !== undefined);
  assert.equal(call.url, 'https://llm.example.com/v1/chat/completions');
  const body = call.body as { messages: Array<{ role: string; content: string }>; stream: boolean };
  assert.equal(body.stream, true);
  const system = body.messages[0];
  const user = body.messages[1];
  assert.ok(system !== undefined && user !== undefined);
  assert.equal(system.role, 'system');
  assert.match(system.content, /bilingual_notes/);
  assert.match(user.content, /语言：en/);
  assert.match(user.content, /\[00:00–00:01\] Hello there/);
  assert.match(user.content, /\[00:01–00:03\] general Kenobi/);
});

test('runStudyNoteGeneration: 全文非 JSON → LlmError upstream', async () => {
  const { fetchImpl } = recordingStreamFetch(() =>
    completeResponse([sseLine(openaiDelta('这是一段散文，不是 JSON')), 'data: [DONE]\n\n']),
  );
  await assert.rejects(
    () => runStudyNoteGeneration({ transcript: FIXTURE_TRANSCRIPT }, { config: AI_ON, fetchImpl }),
    (error: unknown) => {
      assert.ok(error instanceof LlmError);
      assert.equal(error.kind, 'upstream');
      assert.match(error.message, /JSON 契约/);
      return true;
    },
  );
});

// -----------------------------------------------------------------------------
// 6. 路由冒烟（app.listen(0) + fetch）
// -----------------------------------------------------------------------------

function buildAiApp(ai: AiConfig, fetchImpl?: typeof fetch): express.Express {
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
    convert: { engineEnabled: false, storageDir: '' },
    ai,
  } as unknown as AppConfig;
  return createApp({
    config,
    repository: {} as DictionaryRepository,
    convertStore: {} as ConvertStore,
    pipeline: {} as OcrPipeline,
    asr: {} as never,
    aiFetchImpl: fetchImpl,
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

test('路由: AI 未接入 → 503 JSON（写 SSE 头之前的统一错误响应）', async () => {
  const app = buildAiApp({ ...AI_ON, baseUrl: null, apiKey: null, model: null });
  await withServer(app, async (base) => {
    const response = await fetch(`${base}/api/ai/study-notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript: FIXTURE_TRANSCRIPT }),
    });
    assert.equal(response.status, 503);
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);
    const body = (await response.json()) as { error: { code: string; message: string } };
    assert.equal(body.error.code, 'service_unavailable');
    assert.match(body.error.message, /未接入/);
  });
});

test('路由: 坏请求体 / 空字幕 / 段数超上限 → 400', async () => {
  const app = buildAiApp({ ...AI_ON, maxSegments: 2 });
  await withServer(app, async (base) => {
    const bad1 = await fetch(`${base}/api/ai/study-notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(bad1.status, 400);

    const bad2 = await fetch(`${base}/api/ai/study-notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript: { ...FIXTURE_TRANSCRIPT, segments: [] } }),
    });
    assert.equal(bad2.status, 400);

    // 3 段 > maxSegments 2
    const bad3 = await fetch(`${base}/api/ai/study-notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript: FIXTURE_TRANSCRIPT }),
    });
    assert.equal(bad3.status, 400);
    const body = (await bad3.json()) as { error: { message: string } };
    assert.match(body.error.message, /超过单次上限 2/);
  });
});

test('路由: SSE 全链路 delta + done（打桩 fetchImpl）', async () => {
  const { fetchImpl } = recordingStreamFetch(() =>
    completeResponse([
      sseLine(openaiDelta('{"summary":')),
      sseLine(openaiDelta('"ok"}')),
      'data: [DONE]\n\n',
    ]),
  );
  const app = buildAiApp(AI_ON, fetchImpl);
  await withServer(app, async (base) => {
    const response = await fetch(`${base}/api/ai/study-notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript: FIXTURE_TRANSCRIPT }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
    const text = await response.text();
    const events = text
      .split('\n\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
    assert.equal(events.length, 3);
    assert.deepEqual(events[0], { type: 'delta', text: '{"summary":' });
    assert.deepEqual(events[1], { type: 'delta', text: '"ok"}' });
    const doneEvent = events[2];
    assert.ok(doneEvent !== undefined);
    assert.equal(doneEvent['type'], 'done');
    assert.deepEqual(doneEvent['note'], { summary: 'ok', bilingual_notes: [], key_points: [], vocabulary: [] });
  });
});

test('路由: 客户端断开 → 上游 signal abort（防白烧 token）', async () => {
  const stall = stallingResponse([sseLine(openaiDelta('第一个'))]);
  const { fetchImpl, calls } = recordingStreamFetch(() => stall);
  const app = buildAiApp(AI_ON, fetchImpl);
  await withServer(app, async (base) => {
    const clientController = new AbortController();
    const response = await fetch(`${base}/api/ai/study-notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript: FIXTURE_TRANSCRIPT }),
      signal: clientController.signal,
    });
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    await reader.read(); // 收到第一个 delta
    await reader.cancel(); // 客户端断开
    clientController.abort();
    await sleep(200); // 等服务端 'close' 事件与 abort 传播
    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.ok(call !== undefined);
    assert.equal(call.signal?.aborted, true, '客户端断开后上游请求必须被 abort');
  });
});
