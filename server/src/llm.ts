// =============================================================================
// OpenAI 兼容 LLM 客户端（Phase 2 M2：学习稿生成）
// -----------------------------------------------------------------------------
// 部署形态：Node 旁路后端持凭据（红线：key 只在 server/.env，不进日志/前端），
// 前端 POST /api/ai/study-notes 带字幕段上来，这里流式调云端 LLM，
// 路由层把增量转成 SSE 回吐。
//
// 与早期 demo 版（顶层直读 process.env、无超时）的差异：
//   · AiConfig 注入，模块加载不碰 env —— 可单测、可多配置；
//   · 双超时：首 token（防上游卡死）+ 总流式（防生成过长），AbortController 实现；
//   · 错误分类 LlmError(kind)，路由层映射 HTTP 语义（503/504/502）；
//   · 端点口径按 config.ts 文档：已含 /chat/completions 原样用，否则自动拼。
//
// 非流式 generate() 本期不做（产品硬要求是流式；无条件流回退，见拆解文档 §2.2
// 「明确不做」）。
// =============================================================================

import type { AiConfig } from './config';

/** 对话消息（OpenAI chat 口径的子集）。 */
export interface LlmMessage {
  role: 'system' | 'user';
  content: string;
}

export type LlmErrorKind =
  | 'unconfigured'
  | 'unavailable'
  | 'timeout_first_token'
  | 'timeout_stream'
  | 'upstream'
  | 'aborted';

/** LLM 调用失败的类型化载体；路由层按 kind 映射 HTTP 状态。 */
export class LlmError extends Error {
  readonly status: number | undefined;

  constructor(
    readonly kind: LlmErrorKind,
    message: string,
    status?: number,
  ) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
  }
}

/** 路由层 HTTP 映射：未接入 503 / 超时 504 / 上游错 502。 */
export const LLM_ERROR_STATUS: Record<LlmErrorKind, number> = {
  unconfigured: 503,
  unavailable: 503,
  timeout_first_token: 504,
  timeout_stream: 504,
  upstream: 502,
  aborted: 499,
};

/** 三项凭据齐备才可用；任一缺失按未接入处理（不猜默认值）。 */
export function isAiConfigured(config: AiConfig): boolean {
  return (
    config.baseUrl !== null && config.baseUrl.trim() !== '' &&
    config.apiKey !== null && config.apiKey.trim() !== '' &&
    config.model !== null && config.model.trim() !== ''
  );
}

/** 已含 /chat/completions 原样用；否则自动拼（见 AiConfig 文档注释）。 */
export function resolveChatEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(trimmed)) return trimmed;
  return `${trimmed}/chat/completions`;
}

export interface StreamLlmOptions {
  config: AiConfig;
  /** 外部中断信号（客户端断开 SSE 时传入）；中断即 abort 上游 */
  signal?: AbortSignal;
  /** 注入用（单测）；默认 globalThis.fetch */
  fetchImpl?: typeof fetch;
}

/**
 * 流式对话完成：逐段回调 delta，返回累计全文。
 * 双超时从发起请求起算：首 token 超时在收到第一个非空 delta 时解除；
 * 总流式超时管到读完为止。任超时/网络错 -> LlmError，不裸抛。
 */
export async function streamLLM(
  messages: LlmMessage[],
  onToken: (token: string, fullText: string) => void,
  options: StreamLlmOptions,
): Promise<string> {
  const { config, signal, fetchImpl } = options;
  const doFetch = fetchImpl ?? globalThis.fetch;

  if (!isAiConfigured(config)) {
    throw new LlmError('unconfigured', 'AI 服务未接入：缺少 AI_BASE_URL / AI_API_KEY / AI_MODEL 配置');
  }

  const controller = new AbortController();
  let firstTokenTimer: ReturnType<typeof setTimeout> | null = null;
  let streamTimer: ReturnType<typeof setTimeout> | null = null;
  let gotFirstToken = false;
  /** 哪个计时器开过枪；abort 后在 catch 里靠它区分超时类型（清计时器不会丢这个标记） */
  let firedTimeout: 'timeout_first_token' | 'timeout_stream' | null = null;

  const clearTimers = (): void => {
    if (firstTokenTimer !== null) clearTimeout(firstTokenTimer);
    if (streamTimer !== null) clearTimeout(streamTimer);
  };

  const onExternalAbort = (): void => controller.abort();
  if (signal !== undefined) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  firstTokenTimer = setTimeout(() => {
    firedTimeout = 'timeout_first_token';
    controller.abort();
  }, config.firstTokenMs);
  streamTimer = setTimeout(() => {
    firedTimeout = 'timeout_stream';
    controller.abort();
  }, config.streamMs);

  let fullText = '';
  try {
    const response = await doFetch(resolveChatEndpoint(config.baseUrl as string), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey as string}`,
      },
      body: JSON.stringify({ model: config.model, messages, stream: true }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new LlmError('upstream', `LLM 上游错误 ${response.status}${detail === '' ? '' : `：${detail.slice(0, 200)}`}`, response.status);
    }
    if (response.body === null) {
      throw new LlmError('upstream', 'LLM 上游返回了空响应体');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === '' || !trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '' || data === '[DONE]') continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue; // 心跳/坏行忽略，不断流
        }
        const token = extractDelta(parsed);
        if (token !== '') {
          if (!gotFirstToken) {
            gotFirstToken = true;
            if (firstTokenTimer !== null) {
              clearTimeout(firstTokenTimer);
              firstTokenTimer = null;
            }
          }
          fullText += token;
          onToken(token, fullText);
        }
      }
    }
    return fullText;
  } catch (error) {
    if (error instanceof LlmError) throw error;
    if (isAbortError(error)) {
      // 外部断开（客户端关 SSE）与内部超时共用 abort，按 firedTimeout 标记区分
      if (firedTimeout !== null) {
        throw new LlmError(
          firedTimeout,
          firedTimeout === 'timeout_first_token'
            ? `首 token 超时（>${config.firstTokenMs}ms）`
            : `总流式超时（>${config.streamMs}ms）`,
        );
      }
      throw new LlmError('aborted', '客户端已断开');
    }
    throw new LlmError('unavailable', `LLM 请求失败：${(error as Error).message}`);
  } finally {
    clearTimers();
    signal?.removeEventListener('abort', onExternalAbort);
  }
}

/** OpenAI 流式 chunk 取 delta.content；非标准形态按空串处理（不编造）。 */
function extractDelta(parsed: unknown): string {
  if (typeof parsed !== 'object' || parsed === null) return '';
  const choices = (parsed as Record<string, unknown>)['choices'];
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const first = choices[0];
  if (typeof first !== 'object' || first === null) return '';
  const delta = (first as Record<string, unknown>)['delta'];
  if (typeof delta !== 'object' || delta === null) return '';
  const content = (delta as Record<string, unknown>)['content'];
  return typeof content === 'string' ? content : '';
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  );
}
