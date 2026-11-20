/**
 * 字幕导出格式转换（纯函数，单测主战场）
 * ------------------------------------------------------------------
 * 时间码口径：毫秒 = Math.round(seconds * 1000)，跨小时自然进位；
 * 负数与非有限值按 0 处理（防御，不抛错——导出不该被脏数据炸掉）。
 */

import type { TranscriptSegment } from './types'

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0')
}

/** 秒 -> "HH:MM:SS,mmm"（sep=',' 用于 SRT）或 "HH:MM:SS.mmm"（sep='.' 用于 VTT）。 */
export function formatTimecode(seconds: number, sep: ',' | '.'): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0
  const ms = Math.round(safe * 1000)
  const hours = Math.floor(ms / 3_600_000)
  const minutes = Math.floor((ms % 3_600_000) / 60_000)
  const secs = Math.floor((ms % 60_000) / 1000)
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(secs, 2)}${sep}${pad(ms % 1000, 3)}`
}

/** 每段一行（空文本段跳过）。 */
export function toTxt(segments: readonly TranscriptSegment[]): string {
  return segments
    .map((seg) => seg.text.trim())
    .filter((text) => text !== '')
    .join('\n')
}

/** SRT：序号 / "起 --> 止" / 文本 / 空行。 */
export function toSrt(segments: readonly TranscriptSegment[]): string {
  const blocks = segments
    .map((seg, index) => {
      const text = seg.text.trim()
      if (text === '') return null
      return `${index + 1}\n${formatTimecode(seg.start, ',')} --> ${formatTimecode(seg.end, ',')}\n${text}`
    })
    .filter((block): block is string => block !== null)
  return blocks.length === 0 ? '' : `${blocks.join('\n\n')}\n`
}

/** WebVTT："WEBVTT" 头 + "." 分隔时间码。 */
export function toVtt(segments: readonly TranscriptSegment[]): string {
  const blocks = segments
    .map((seg) => {
      const text = seg.text.trim()
      if (text === '') return null
      return `${formatTimecode(seg.start, '.')} --> ${formatTimecode(seg.end, '.')}\n${text}`
    })
    .filter((block): block is string => block !== null)
  return blocks.length === 0 ? 'WEBVTT\n' : `WEBVTT\n\n${blocks.join('\n\n')}\n`
}

/** CSV 字段转义（RFC 4180）：含逗号 / 引号 / 换行时用双引号包裹，内部引号翻倍。 */
function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

/**
 * CSV：机器可解析的结构化数据，列 `index,start_time,end_time,text`。
 * start_time / end_time 用秒（3 位小数），不伪造时间；非有限值输出空串
 * （无时间比假时间诚实）；空文本段跳过（与 toTxt 口径一致）。
 * 首行 UTF-8 BOM（\ufeff）保证 Excel 正确识别中文；行尾 CRLF 兼容常见表格软件。
 */
export function toCsv(segments: readonly TranscriptSegment[]): string {
  const rows = ['index,start_time,end_time,text']
  segments.forEach((seg, index) => {
    const text = seg.text.trim()
    if (text === '') return
    const start = Number.isFinite(seg.start) ? seg.start.toFixed(3) : ''
    const end = Number.isFinite(seg.end) ? seg.end.toFixed(3) : ''
    rows.push(`${index + 1},${start},${end},${csvField(text)}`)
  })
  return '\ufeff' + rows.join('\r\n')
}

/**
 * JSON：完整结构化数据（含每段起止时间与顺序），机器可读；
 * 字段与 transcripts 表记录同构（id/language/duration/segments），
 * 调用方不传的字段缺省，绝不编造。
 */
export function toJson(transcript: {
  id?: string
  language: string
  duration: number
  fileName?: string
  segments: readonly TranscriptSegment[]
}): string {
  const payload: Record<string, unknown> = {
    language: transcript.language,
    duration: transcript.duration,
    segments: transcript.segments.map((seg) => ({
      start: seg.start,
      end: seg.end,
      text: seg.text,
    })),
  }
  if (transcript.id !== undefined) payload.id = transcript.id
  if (transcript.fileName !== undefined) payload.fileName = transcript.fileName
  return JSON.stringify(payload, null, 2)
}
