// =============================================================================
// ASR 供应商错误分类（纯函数 + 错误类型）
// -----------------------------------------------------------------------------
// 指令第七节：不吞错误，统一格式。
//   供应商确定性错误 -> AsrProviderError(kind) -> service 映射 ApiError
//   （401 认证 / 400 文件 / 413 超限 / 504 超时 / 503 不可用）；
//   未知异常保留 Phase 1 防御行为（202 + failed 记录，轮询可见原因）。
//
// 重试策略（用户工程约束）：
//   · 网络类错误最多重试 2 次，退避 1s / 3s；
//   · 业务错误（400 / 413）一律不重试；
//   · submit 超时不重试（任务可能已被受理，重试 = 重复任务）——
//     本地 sidecar 形态进一步收敛：sidecar 是自有进程，单次 HTTP 超时即故障
//     （10s AbortSignal.timeout），不重试；重试会让同一 job 在 sidecar 重复入队。
// =============================================================================

export type AsrProviderErrorKind = 'auth' | 'bad_file' | 'too_large' | 'timeout' | 'unavailable' | 'unknown';

/** kind -> HTTP 状态码（指令第七节五类；unknown 按 503 兜底并带原始错误码）。 */
export const PROVIDER_ERROR_STATUS: Record<AsrProviderErrorKind, number> = {
  auth: 401,
  bad_file: 400,
  too_large: 413,
  timeout: 504,
  unavailable: 503,
  unknown: 503,
};

export interface AsrProviderErrorOptions {
  /** 是否可重试；默认仅 unavailable / timeout 可重试 */
  retryable?: boolean;
  /** 供应商原始数字错误码（排障用） */
  vendorCode?: number;
}

export class AsrProviderError extends Error {
  readonly kind: AsrProviderErrorKind;
  readonly retryable: boolean;
  readonly vendorCode: number | null;

  constructor(kind: AsrProviderErrorKind, message: string, options: AsrProviderErrorOptions = {}) {
    super(message);
    this.name = 'AsrProviderError';
    this.kind = kind;
    this.retryable = options.retryable ?? (kind === 'unavailable' || kind === 'timeout');
    this.vendorCode = options.vendorCode ?? null;
  }
}

/**
 * 腾讯云 v3 数字错误码 -> kind。
 * 依据官方 SDK FAQ（4001 参数非法 / 4002 鉴权失败 / 4006 并发超限 /
 * 4008 超时 / 5000 服务端错误）+ 录音文件识别创建任务侧 100xx 码
 * （10000 转码失败 / 10001 识别失败 / 10002 时长太短 / 10003 太长 /
 * 10004 无效语音 / 10005 其他失败 / 10006 音轨不匹配 / 10007 下载失败）。
 */
export function classifyVendorCode(code: number): { kind: AsrProviderErrorKind; retryable: boolean } {
  switch (code) {
    case 4002:
      return { kind: 'auth', retryable: false };
    case 4001:
    case 10000:
    case 10002:
    case 10003:
    case 10004:
    case 10006:
      return { kind: 'bad_file', retryable: false };
    case 4006:
    case 5000:
    case 10001:
    case 10005:
    case 10007:
      return { kind: 'unavailable', retryable: true };
    case 4008:
      return { kind: 'timeout', retryable: true };
    default:
      return { kind: 'unknown', retryable: false };
  }
}

// -----------------------------------------------------------------------------
// 脱敏：SecretKey / UserSig / Authorization 绝不进日志与 debug 落盘
// （用户工程约束；防御性实现——适配器本身也从不记录 auth 材料）
// -----------------------------------------------------------------------------

const SECRET_KEY_PATTERN = /(usersig|secret_?key|authorization|api_?key|access_?token|password)/i;
const REDACTED = '[REDACTED]';

/** 深拷贝并脱敏：命中敏感字段名的键，值替换为 [REDACTED]。 */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item));
  }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : redactSecrets(item);
    }
    return out;
  }
  return value;
}
