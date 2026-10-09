import type { AnnotationColor, AnnotationStyle, ReadingAnnotation } from '@/domain/types'

/**
 * 划线标注（2026-10-07 需求 5）纯逻辑：
 *  - 颜色表与样式映射（红/橙/蓝/绿/黄 × 底纹/直线/波浪线）
 *  - 区间切分：把「段落文本 + 若干划线区间」切成带标注的片段流，
 *    渲染层直接按片段输出（可单测，不碰 DOM）。
 *
 * 坐标系：一律用「段落文本」的字符偏移（渲染与选区捕获同系，自洽即可）。
 */

/** 划线五色的真实色值（装饰色，与主题令牌无关） */
export const ANNOTATION_COLOR_HEX: Record<AnnotationColor, string> = {
  red: '#e5484d',
  orange: '#f59e0b',
  blue: '#3b82f6',
  green: '#45b649',
  yellow: '#eab308',
}

export const ANNOTATION_COLOR_OPTIONS: AnnotationColor[] = ['red', 'orange', 'blue', 'green', 'yellow']

/**
 * 笔记（想法）虚线下划线的颜色（V3.0 需求五）：
 * 「我的笔记」= 主色绿；「他人笔记」= 紫（靠 author 字段区分，无账号体系时一律为绿）。
 * 只在笔记详情卡片里标注来源，绝不编造他人数据。
 */
export const NOTE_SELF_HEX = '#45b649'
export const NOTE_OTHER_HEX = '#8b6df0'

/** 笔记的颜色：带 author（他人笔记）用紫色，否则主色绿 */
export function noteColorHex(a: ReadingAnnotation): string {
  return a.author ? NOTE_OTHER_HEX : NOTE_SELF_HEX
}

export const ANNOTATION_STYLE_OPTIONS: { key: AnnotationStyle; label: string }[] = [
  { key: 'highlight', label: '底纹' },
  { key: 'underline', label: '直线' },
  { key: 'wavy', label: '波浪线' },
]

/**
 * 稀疏波浪线的下划背景（需求：波浪密度调疏，参考设计图）。
 * 浏览器自带 text-decoration:wavy 波纹过密；改用一张周期更宽（16px）的
 * SVG 波浪平铺在文字下沿，得到舒展的波纹。
 */
function wavyUnderline(hex: string): string {
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='16' height='5' viewBox='0 0 16 5'>` +
    `<path d='M0 3.6 Q4 0.6 8 3.6 T16 3.6' fill='none' stroke='${hex}' ` +
    `stroke-width='1.3' stroke-linecap='round'/></svg>`
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
}

/** 划线在正文里的内联样式（底纹=背景色；直线=下边框；波浪线=稀疏波浪下划） */
export function annotationCss(a: ReadingAnnotation): React.CSSProperties {
  // 笔记（想法）：虚线/虚拟下划线（V3.0 需求五「笔记标识改为虚线」）
  if (a.kind === 'thought') {
    const hex = noteColorHex(a)
    return {
      textDecorationLine: 'underline',
      textDecorationStyle: 'dashed',
      textDecorationColor: hex,
      textDecorationThickness: '1.5px',
      textUnderlineOffset: '3px',
      cursor: 'pointer',
    }
  }
  const hex = ANNOTATION_COLOR_HEX[a.color ?? 'yellow']
  if (a.style === 'underline') {
    return { borderBottom: `2px solid ${hex}` }
  }
  if (a.style === 'wavy') {
    return {
      backgroundImage: wavyUnderline(hex),
      backgroundRepeat: 'repeat-x',
      backgroundPosition: '0 100%',
      backgroundSize: '16px 5px',
      paddingBottom: 2,
    }
  }
  // 底纹（默认）：35% 透明度铺底；行内盒只覆盖文字本体，不含行距
  return { backgroundColor: `${hex}59`, borderRadius: 2, boxDecorationBreak: 'clone' }
}

/** 带标注的文本片段 */
export interface AnnotatedSegment {
  text: string
  /** 覆盖该片段的划线（多个重叠时全带，渲染逐层叠） */
  anns: ReadingAnnotation[]
}

/**
 * 把 [start,end) 区间列表叠到文本上，切成连续片段流。
 * 区间允许无序/重叠/越界（自动夹紧）；无有效区间时返回单片段全文。
 */
export function splitByRanges(
  text: string,
  ranges: { start: number; end: number; ann: ReadingAnnotation }[],
): AnnotatedSegment[] {
  const clean = ranges
    .map((r) => ({ ...r, start: Math.max(0, Math.min(r.start, text.length)), end: Math.max(0, Math.min(r.end, text.length)) }))
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start || a.end - b.end)
  if (clean.length === 0) return [{ text, anns: [] }]

  /** 断点集合：0、len、每个区间端点 —— 去重升序 */
  const points = new Set<number>([0, text.length])
  for (const r of clean) {
    points.add(r.start)
    points.add(r.end)
  }
  const sorted = [...points].sort((a, b) => a - b)

  const out: AnnotatedSegment[] = []
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const s = sorted[i]
    const e = sorted[i + 1]
    if (s === e) continue
    const anns = clean.filter((r) => r.start <= s && e <= r.end).map((r) => r.ann)
    out.push({ text: text.slice(s, e), anns })
  }
  return out
}
