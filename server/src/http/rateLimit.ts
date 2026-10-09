import type { NextFunction, Request, Response } from 'express';
import { ApiError } from './errors';

interface RateBucket {
  count: number;
  resetAt: number;
}

export interface RateLimitOptions {
  windowMs: number;
  maxRequests: number;
  maxTrackedClients?: number;
}

/**
 * 进程内轻量限流器，适用于单实例部署。
 * 多实例生产环境应替换为 Redis 等共享限流存储，但路由契约无需改变。
 */
export function createIpRateLimiter(options: RateLimitOptions) {
  const buckets = new Map<string, RateBucket>();
  const maxTrackedClients = options.maxTrackedClients ?? 5_000;

  function prune(now: number): void {
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
    while (buckets.size > maxTrackedClients) {
      const oldest = buckets.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      buckets.delete(oldest);
    }
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    if (buckets.size >= maxTrackedClients) prune(now);

    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const current = buckets.get(key);
    const bucket = current === undefined || current.resetAt <= now
      ? { count: 0, resetAt: now + options.windowMs }
      : current;

    bucket.count += 1;
    buckets.set(key, bucket);

    const remaining = Math.max(0, options.maxRequests - bucket.count);
    res.setHeader('X-RateLimit-Limit', String(options.maxRequests));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));

    if (bucket.count > options.maxRequests) {
      const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfterSeconds));
      next(new ApiError(429, 'rate_limited', `请求过于频繁，请在 ${retryAfterSeconds} 秒后重试`));
      return;
    }

    next();
  };
}
