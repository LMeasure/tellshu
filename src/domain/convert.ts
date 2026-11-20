/**
 * 格式转换·纯逻辑层（不碰 DOM / 平台 API，可单测）
 * 仅负责：格式识别、目标格式候选、合法组合校验。
 * 不发起任何网络请求（网络在 services/convert/client.ts）。
 */

export type ConvertFormat = 'pdf' | 'docx' | 'png' | 'jpg' | 'xlsx'

/** 扩展名 -> 格式（小写、带点） */
const EXT_TO_FORMAT: Record<string, ConvertFormat> = {
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.png': 'png',
  '.jpg': 'jpg',
  '.jpeg': 'jpg',
  '.xlsx': 'xlsx',
}

/** MIME -> 格式（不依赖 MIME 时回退扩展名） */
const MIME_TO_FORMAT: Record<string, ConvertFormat> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
}

/** V1 允许的转换组合（来自格式转换.md §2 V1 范围）。jpg↔png 视为同一「位图」互换。 */
export const ALLOWED_CONVERSIONS: ReadonlyArray<readonly [ConvertFormat, ConvertFormat]> = [
  ['pdf', 'docx'],
  ['docx', 'pdf'],
  ['pdf', 'png'],
  ['png', 'pdf'],
  ['jpg', 'pdf'],
  ['xlsx', 'pdf'],
]

/** 前端 accept 属性与提示文案使用的扩展名白名单 */
export const ACCEPT_ATTR = '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.jpg,.jpeg,.png'

export const FORMAT_LABEL: Record<ConvertFormat, string> = {
  pdf: 'PDF',
  docx: 'Word (DOCX)',
  png: 'PNG 图片',
  jpg: 'JPG 图片',
  xlsx: 'Excel (XLSX)',
}

/** 给定源格式，列出可选目标格式 */
export function targetCandidates(source: ConvertFormat): ConvertFormat[] {
  return ALLOWED_CONVERSIONS.filter(([s]) => s === source).map(([, t]) => t)
}

/** 是否为 V1 支持的源格式 */
export function isSupportedSource(format: ConvertFormat): boolean {
  return ALLOWED_CONVERSIONS.some(([s]) => s === format)
}

/** 校验 (源, 目标) 是否为合法转换组合（同格式不算） */
export function isAllowedConversion(source: ConvertFormat, target: ConvertFormat): boolean {
  if (source === target) return false
  return ALLOWED_CONVERSIONS.some(([s, t]) => s === source && t === target)
}

/** 从文件名识别格式；无法识别返回 null（不臆造） */
export function detectFormatFromName(fileName: string): ConvertFormat | null {
  const lower = fileName.toLowerCase()
  const ext = lower.includes('.') ? `.${lower.split('.').pop() ?? ''}` : ''
  const hit = EXT_TO_FORMAT[ext]
  return hit ?? null
}

/** 从 MIME 识别格式；无法识别返回 null */
export function detectFormatFromMime(mimeType: string): ConvertFormat | null {
  const key = mimeType.toLowerCase().split(';')[0].trim()
  return MIME_TO_FORMAT[key] ?? null
}

/** 综合识别：优先扩展名（更可靠），MIME 作回退；都失败返回 null */
export function detectFormat(fileName: string, mimeType: string): ConvertFormat | null {
  return detectFormatFromName(fileName) ?? detectFormatFromMime(mimeType)
}
