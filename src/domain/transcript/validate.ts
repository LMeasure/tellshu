/**
 * 媒体文件预校验（纯函数，提交前第一道关）
 * ------------------------------------------------------------------
 * 与 server/src/http/upload.ts 的白名单保持一致：
 * 前端预校验只为「早失败、少传 100MB」，真正的硬校验在后端。
 */

/** 支持的扩展名（与后端 ALLOWED_MEDIA_EXTENSIONS 一致）。 */
export const MEDIA_EXTENSIONS: readonly string[] = ['.mp3', '.wav', '.m4a', '.mp4', '.mov', '.webm']

/** 单文件上限 100MB（与后端 ASR_MAX_FILE_BYTES 一致）。 */
export const MAX_MEDIA_BYTES = 100 * 1024 * 1024

export type MediaValidation = { ok: true } | { ok: false; reason: string }

/** 取小写扩展名（含点）；没有扩展名时返回空串。 */
export function extensionOf(name: string): string {
  const match = name.toLowerCase().match(/\.[a-z0-9]+$/)
  return match === null ? '' : match[0]
}

/**
 * 校验文件名与体积。
 * 规则与后端对齐：扩展名须在白名单；体积须 >0 且 ≤100MB。
 */
export function validateMediaFile(name: string, sizeBytes: number): MediaValidation {
  const extension = extensionOf(name)
  if (extension === '' || !MEDIA_EXTENSIONS.includes(extension)) {
    return { ok: false, reason: `仅支持 MP3 / WAV / M4A / MP4 / MOV / WebM，当前文件格式不支持` }
  }
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return { ok: false, reason: '文件为空或无法读取大小' }
  }
  if (sizeBytes > MAX_MEDIA_BYTES) {
    return { ok: false, reason: `文件超过 100MB 上限（当前 ${(sizeBytes / (1024 * 1024)).toFixed(1)}MB）` }
  }
  return { ok: true }
}
