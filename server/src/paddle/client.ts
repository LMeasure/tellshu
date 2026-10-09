// =============================================================================
// PaddleOCR 异步 API 客户端（Node 22 原生 fetch / FormData / Blob）
//
//   POST {JOB_URL}            multipart: file / model / optionalPayload / pageRanges / batchId
//   GET  {JOB_URL}/{jobId}    -> data.state: pending | running | done | failed
//   GET  data.resultUrl.jsonUrl -> JSONL，需立即下载
//
// 安全约定：访问令牌只出现在请求头里，任何错误信息 / 日志都经过脱敏。
// =============================================================================

import {
  PADDLE_DEFAULT_MODEL,
  type JsonObject,
  type PaddleErrorKind,
  type PaddleJobState,
  type PaddleJobStatus,
  type PaddleJobSubmitResult,
  type PaddleResultUrl,
  type PaddleSubmitInput,
  asString,
  isRecord,
} from '../types';

const RETRYABLE_ERROR_CODES = new Set([10010, 12002]);
const QUOTA_ERROR_CODE = 12001;

/** 下载 JSONL 的体积上限，防止异常响应打爆内存。 */
const MAX_JSONL_BYTES = 128 * 1024 * 1024;

export class PaddleOcrError extends Error {
  readonly kind: PaddleErrorKind;
  readonly status: number | null;
  readonly errorCode: number | null;

  constructor(
    message: string,
    options: { kind: PaddleErrorKind; status?: number | null; errorCode?: number | null; cause?: unknown },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'PaddleOcrError';
    this.kind = options.kind;
    this.status = options.status ?? null;
    this.errorCode = options.errorCode ?? null;
  }

  get retryable(): boolean {
    return this.kind === 'retryable' || this.kind === 'server' || this.kind === 'network' || this.kind === 'timeout';
  }
}

function isRetryableKind(kind: PaddleErrorKind): boolean {
  return kind === 'retryable' || kind === 'server' || kind === 'network' || kind === 'timeout';
}

/**
 * 错误分类：
 *   12001            -> quota（配额耗尽，重试无意义）
 *   10010 / 12002    -> retryable
 *   401 / 403        -> auth
 *   429              -> retryable（限流）
 *   5xx              -> server
 *   其它 4xx         -> client
 *   无 HTTP 状态码    -> network
 */
export function classifyPaddleError(status: number | null, errorCode: number | null): PaddleErrorKind {
  if (errorCode === QUOTA_ERROR_CODE) return 'quota';
  if (errorCode !== null && RETRYABLE_ERROR_CODES.has(errorCode)) return 'retryable';
  if (status === null) return 'network';
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'retryable';
  if (status >= 500) return 'server';
  if (status >= 400) return 'client';
  return 'protocol';
}

/** URL 脱敏：去掉查询串与凭据，只保留 scheme + host + 路径前缀，供日志使用。 */
export function redactUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const pathname = parsed.pathname.length > 48 ? `${parsed.pathname.slice(0, 48)}…` : parsed.pathname;
    return `${parsed.protocol}//${parsed.host}${pathname}`;
  } catch {
    return '<invalid-url>';
  }
}

/** 文本脱敏：抹掉 Bearer 令牌与 token/api_key 类查询参数。 */
export function redactText(input: string): string {
  return input
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer ***')
    .replace(/([?&](?:token|access_token|api_key|apikey|key|signature)=)[^&\s]+/gi, '$1***');
}

/** 错误信息脱敏后的可读描述。 */
export function describePaddleError(error: unknown): string {
  if (error instanceof PaddleOcrError) {
    const parts = [`kind=${error.kind}`];
    if (error.status !== null) parts.push(`http=${error.status}`);
    if (error.errorCode !== null) parts.push(`code=${error.errorCode}`);
    parts.push(redactText(error.message));
    return parts.join(' ');
  }
  if (error instanceof Error) return redactText(error.message);
  return 'unknown error';
}

/** 从响应体里尽力取出 { errorCode, errorMsg }。 */
function readApiError(body: unknown): { errorCode: number | null; errorMsg: string | null } {
  if (!isRecord(body)) return { errorCode: null, errorMsg: null };
  const candidates: unknown[] = [body, body['data'], body['error'], body['result']];
  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    const rawCode = candidate['errorCode'] ?? candidate['error_code'] ?? candidate['code'];
    const rawMsg = candidate['errorMsg'] ?? candidate['error_msg'] ?? candidate['message'] ?? candidate['msg'];
    const code = typeof rawCode === 'number' ? rawCode : typeof rawCode === 'string' ? Number(rawCode) : NaN;
    return {
      errorCode: Number.isFinite(code) ? code : null,
      errorMsg: asString(rawMsg ?? null),
    };
  }
  return { errorCode: null, errorMsg: null };
}

function readState(value: unknown): PaddleJobState | null {
  const text = asString(value)?.toLowerCase() ?? null;
  if (text === null) return null;
  if (text === 'pending' || text === 'running' || text === 'done' || text === 'failed') return text;
  // 兼容 success / finished 等别名
  if (text === 'success' || text === 'succeeded' || text === 'finished' || text === 'completed') return 'done';
  if (text === 'error' || text === 'cancelled' || text === 'canceled') return 'failed';
  return null;
}

function readResultUrl(value: unknown): PaddleResultUrl | null {
  if (!isRecord(value)) return null;
  const jsonUrl =
    asString(value['jsonUrl']) ??
    asString(value['json_url']) ??
    asString(value['json']) ??
    asString(value['resultUrl']);
  if (jsonUrl === null) return null;
  return {
    jsonUrl,
    imageUrl: asString(value['imageUrl']) ?? asString(value['image_url']) ?? null,
    markdownUrl: asString(value['markdownUrl']) ?? asString(value['markdown_url']) ?? null,
  };
}

function unwrapData(body: unknown): unknown {
  if (!isRecord(body)) return null;
  const data = body['data'];
  if (isRecord(data)) return data;
  const result = body['result'];
  if (isRecord(result)) return result;
  return body;
}

export interface PaddleClientOptions {
  accessToken: string;
  baseUrl?: string;
  timeoutMs?: number;
  model?: string;
  /** 便于测试注入；默认使用全局 fetch */
  fetchImpl?: typeof fetch;
}

export class PaddleOcrClient {
  private readonly accessToken: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly model: string;
  private readonly doFetch: typeof fetch;

  constructor(options: PaddleClientOptions) {
    this.accessToken = options.accessToken;
    this.baseUrl = (options.baseUrl ?? 'https://paddleocr.aistudio-app.com/api/v2/ocr/jobs').replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.model = options.model ?? PADDLE_DEFAULT_MODEL;
    this.doFetch = options.fetchImpl ?? fetch;
  }

  get configured(): boolean {
    return this.accessToken !== '';
  }

  private async request(url: string, init: RequestInit & { withAuth: boolean }): Promise<Response> {
    const headers = new Headers(init.headers ?? {});
    if (init.withAuth) headers.set('Authorization', `Bearer ${this.accessToken}`);
    try {
      return await this.doFetch(url, {
        ...init,
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        throw new PaddleOcrError(`请求 ${redactUrl(url)} 超时`, {
          kind: 'timeout',
          cause: error,
        });
      }
      const message = error instanceof Error ? redactText(error.message) : String(error);
      throw new PaddleOcrError(`请求 ${redactUrl(url)} 失败：${message}`, {
        kind: 'network',
        cause: error,
      });
    }
  }

  private async readBody(response: Response): Promise<{ text: string; json: unknown }> {
    const text = await response.text();
    let json: unknown = null;
    if (text !== '') {
      try {
        json = JSON.parse(text) as unknown;
      } catch {
        json = null;
      }
    }
    return { text, json };
  }

  private async assertOk(response: Response, action: string): Promise<{ text: string; json: unknown }> {
    const body = await this.readBody(response);
    if (response.ok) return body;
    const { errorCode, errorMsg } = readApiError(body.json);
    const kind = classifyPaddleError(response.status, errorCode);
    const message = errorMsg ?? (body.text === '' ? response.statusText : body.text.slice(0, 200));
    throw new PaddleOcrError(`${action}失败：${redactText(message)}`, {
      kind,
      status: response.status,
      errorCode,
    });
  }

  /** 提交一个 OCR 任务。 */
  async submitJob(input: PaddleSubmitInput): Promise<PaddleJobSubmitResult> {
    const form = new FormData();
    const blob = new Blob([new Uint8Array(input.buffer)], { type: input.mimeType });
    form.append('file', blob, input.fileName);
    form.append('model', input.model ?? this.model);
    if (input.optionalPayload !== undefined) {
      form.append('optionalPayload', JSON.stringify(input.optionalPayload satisfies JsonObject));
    }
    if (input.pageRanges !== undefined && input.pageRanges !== '') {
      form.append('pageRanges', input.pageRanges);
    }
    if (input.batchId !== undefined && input.batchId !== '') {
      form.append('batchId', input.batchId);
    }

    const response = await this.request(this.baseUrl, {
      method: 'POST',
      body: form,
      withAuth: true,
    });
    const body = await this.assertOk(response, '提交 OCR 任务');
    const data = unwrapData(body.json);
    const jobId =
      asString(isRecord(data) ? data['jobId'] : undefined) ??
      asString(isRecord(data) ? data['job_id'] : undefined) ??
      asString(isRecord(data) ? data['id'] : undefined);

    if (jobId === null) {
      throw new PaddleOcrError('提交 OCR 任务返回中缺少 jobId', { kind: 'protocol' });
    }

    return {
      jobId,
      batchId: input.batchId ?? null,
      rawState: asString(isRecord(data) ? data['state'] : undefined),
    };
  }

  /** 查询任务状态。 */
  async getJobStatus(jobId: string): Promise<PaddleJobStatus> {
    const url = `${this.baseUrl}/${encodeURIComponent(jobId)}`;
    const response = await this.request(url, { method: 'GET', withAuth: true });
    const body = await this.assertOk(response, '查询 OCR 任务');
    const data = unwrapData(body.json);
    const state = readState(isRecord(data) ? data['state'] : undefined);
    if (state === null) {
      throw new PaddleOcrError('查询 OCR 任务返回中缺少合法 state', { kind: 'protocol' });
    }
    const resultUrl = readResultUrl(isRecord(data) ? data['resultUrl'] ?? data['result_url'] : undefined);
    if (state === 'done' && resultUrl === null) {
      throw new PaddleOcrError('OCR 任务已完成但未返回 resultUrl.jsonUrl', { kind: 'protocol' });
    }
    const { errorCode, errorMsg } = readApiError(body.json);
    return {
      jobId,
      state,
      resultUrl,
      errorCode: state === 'failed' ? errorCode : null,
      errorMsg: state === 'failed' ? errorMsg : null,
    };
  }

  /** 下载结果 JSONL 文本。仅对同源地址附带令牌（外部预签名地址不带）。 */
  async downloadJsonl(jsonUrl: string): Promise<string> {
    const sameOrigin = jsonUrl.startsWith(this.baseUrl);
    const response = await this.request(jsonUrl, { method: 'GET', withAuth: sameOrigin });
    if (!response.ok) {
      const kind = classifyPaddleError(response.status, null);
      throw new PaddleOcrError(`下载 OCR 结果失败：HTTP ${response.status}`, { kind, status: response.status });
    }
    const declared = Number(response.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > MAX_JSONL_BYTES) {
      throw new PaddleOcrError('OCR 结果体积超过上限，拒绝下载', { kind: 'protocol' });
    }
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_JSONL_BYTES) {
      throw new PaddleOcrError('OCR 结果体积超过上限，已拒绝', { kind: 'protocol' });
    }
    return text;
  }
}

export { isRetryableKind };
