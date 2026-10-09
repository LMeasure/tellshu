// =============================================================================
// 统一错误模型 + Express 错误中间件
// =============================================================================

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { JsonValue } from '../types';
import { toJsonValue } from '../types';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: JsonValue | null;

  constructor(status: number, code: string, message: string, details: JsonValue | null = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static badRequest(message: string, details?: unknown): ApiError {
    return new ApiError(400, 'bad_request', message, details === undefined ? null : toJsonValue(details));
  }

  static unauthorized(message = '缺少或无效的访问凭据'): ApiError {
    return new ApiError(401, 'unauthorized', message);
  }

  static forbidden(message = '当前配置禁止该操作'): ApiError {
    return new ApiError(403, 'forbidden', message);
  }

  static notFound(message = '资源不存在'): ApiError {
    return new ApiError(404, 'not_found', message);
  }

  static payloadTooLarge(message = '上传内容过大'): ApiError {
    return new ApiError(413, 'payload_too_large', message);
  }

  static serviceUnavailable(message = '依赖服务未配置或不可用'): ApiError {
    return new ApiError(503, 'service_unavailable', message);
  }

  static upstream(message: string, details?: unknown): ApiError {
    return new ApiError(502, 'upstream_error', message, details === undefined ? null : toJsonValue(details));
  }

  static internal(message = '服务器内部错误'): ApiError {
    return new ApiError(500, 'internal_error', message);
  }

  toBody(): { error: { code: string; message: string; details?: JsonValue } } {
    const body: { error: { code: string; message: string; details?: JsonValue } } = {
      error: { code: this.code, message: this.message },
    };
    if (this.details !== null) body.error.details = this.details;
    return body;
  }
}

/** 包装异步路由，把 rejected promise 交给错误中间件。 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

function isMulterError(error: unknown): error is { name: string; code: string; message: string; field?: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'MulterError'
  );
}

export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(ApiError.notFound(`接口不存在：${req.method} ${req.path}`));
}

export function errorHandler(error: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(error);
    return;
  }

  if (error instanceof ApiError) {
    res.status(error.status).json(error.toBody());
    return;
  }

  if (isMulterError(error)) {
    const code = error.code;
    if (code === 'LIMIT_FILE_SIZE') {
      res.status(413).json(ApiError.payloadTooLarge('单个文件超过 50MB 上限').toBody());
      return;
    }
    if (code === 'LIMIT_FILE_COUNT' || code === 'LIMIT_UNEXPECTED_FILE') {
      res.status(400).json(ApiError.badRequest('上传文件数量超限或字段名不正确（应为 images）').toBody());
      return;
    }
    res.status(400).json(ApiError.badRequest(`上传失败：${error.message}`).toBody());
    return;
  }

  // 只把错误写到服务端日志，响应体不含内部细节
  process.stderr.write(`[api] 未处理错误: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  res.status(500).json(ApiError.internal().toBody());
}
