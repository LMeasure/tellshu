// =============================================================================
// 管理员鉴权：Authorization: Bearer <ADMIN_API_KEY>
// 使用 sha256 摘要后 timingSafeEqual 比较，规避长度泄露与时序差异。
// =============================================================================

import { createHash, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { ApiError } from './errors';

export function requireAdminApiKey(adminApiKey: string): RequestHandler {
  const expected = createHash('sha256').update(adminApiKey, 'utf8').digest();

  return (req, _res, next) => {
    const header = req.header('authorization') ?? '';
    const match = /^Bearer[ \t]+(\S+)$/i.exec(header.trim());
    const provided = match?.[1];

    if (provided === undefined || provided === '') {
      next(ApiError.unauthorized('缺少 Bearer 管理员密钥'));
      return;
    }

    const actual = createHash('sha256').update(provided, 'utf8').digest();
    if (!timingSafeEqual(actual, expected)) {
      next(ApiError.unauthorized('管理员密钥无效'));
      return;
    }

    next();
  };
}
