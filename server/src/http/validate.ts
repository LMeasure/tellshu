// =============================================================================
// 路径参数 / 查询参数校验：把非法输入挡在数据库之前，避免把驱动错误变成 500
// =============================================================================

import { ApiError } from './errors';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** 从 Express 路径参数中读取 UUID，非法一律抛 400。 */
export function readUuidParam(params: Record<string, string>, name: string): string {
  const raw = params[name];
  if (typeof raw !== 'string' || !UUID_RE.test(raw)) {
    throw ApiError.badRequest(`${name} 非法（必须是 UUID）`);
  }
  return raw;
}

/** 读取非负整数查询参数；缺省返回 fallback。 */
export function readIntQuery(
  value: unknown,
  name: string,
  fallback: number,
  max: number,
): number {
  if (value === undefined || value === null || value === '') return fallback;
  const raw = Array.isArray(value) ? value[0] : value;
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!/^\d{1,10}$/.test(text)) {
    throw ApiError.badRequest(`${name} 必须是非负整数`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed > max) {
    throw ApiError.badRequest(`${name} 超出允许范围（0-${max}）`);
  }
  return parsed;
}

/** 读取非空字符串查询参数。 */
export function readTextQuery(value: unknown, name: string, maxLength: number): string {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw ApiError.badRequest(`缺少查询参数 ${name}`);
  }
  return raw.trim().slice(0, maxLength);
}
