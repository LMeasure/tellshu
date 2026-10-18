// =============================================================================
// 供应商转录响应归一化（纯函数，单测主战场）
// -----------------------------------------------------------------------------
// 覆盖两种典型响应形态：
//   A) { language, duration, segments: [{ start, end, text }] }             —— 秒
//   B) { results: [{ sentences: [{ start_time, end_time, text }] }] }       —— 毫秒
//
// 规则（不编造、不补全）：
//   · 三段字段（起/止/文）齐全且合法才成段；缺字段、end<=start、文本为空
//     的一律丢弃并计数（由调用方记日志）；
//   · language / duration 缺失时不臆造：language 记 'und'（ISO 未定），
//     duration 由段落最大 end 推导（对真实返回值的计算，非补全）。
// =============================================================================

import { asNumber, asString, asUnknownArray, isRecord, readString, type AsrTranscript, type AsrTranscriptSegment } from '../types';

export interface NormalizeResult {
  transcript: AsrTranscript;
  /** 因缺字段 / 不合法被丢弃的段数（调用方记日志） */
  dropped: number;
}

/** 秒 -> 段。start/end 接受数字与数字字符串；负数与非有限值视为缺字段。 */
function toFiniteSeconds(value: unknown): number | null {
  const n = asNumber(value);
  if (n === null || !Number.isFinite(n) || n < 0) return null;
  return n;
}

function pushSegment(out: AsrTranscriptSegment[], rawStart: unknown, rawEnd: unknown, rawText: unknown): boolean {
  const start = toFiniteSeconds(rawStart);
  const end = toFiniteSeconds(rawEnd);
  const text = asString(rawText);
  if (start === null || end === null || text === null) return false;
  if (end <= start) return false;
  out.push({ start, end, text: text.trim() });
  return true;
}

/** 形态 A：segments[]（秒）。 */
function fromSegmentsShape(raw: Record<string, unknown>, out: AsrTranscriptSegment[]): number {
  let dropped = 0;
  for (const item of asUnknownArray(raw['segments'])) {
    if (!isRecord(item)) {
      dropped += 1;
      continue;
    }
    const ok = pushSegment(out, item['start'], item['end'], item['text']);
    if (!ok) dropped += 1;
  }
  return dropped;
}

/** 形态 B：results[].sentences[]（毫秒）。 */
function fromSentencesShape(raw: Record<string, unknown>, out: AsrTranscriptSegment[]): number {
  let dropped = 0;
  for (const group of asUnknownArray(raw['results'])) {
    if (!isRecord(group)) {
      dropped += 1;
      continue;
    }
    for (const item of asUnknownArray(group['sentences'])) {
      if (!isRecord(item)) {
        dropped += 1;
        continue;
      }
      const startMs = toFiniteSeconds(item['start_time']);
      const endMs = toFiniteSeconds(item['end_time']);
      if (startMs === null || endMs === null) {
        dropped += 1;
        continue;
      }
      const ok = pushSegment(out, startMs / 1000, endMs / 1000, item['text']);
      if (!ok) dropped += 1;
    }
  }
  return dropped;
}

/**
 * 供应商原始响应 -> 归一化 Transcript。
 * 两种形态都试（A 优先），谁产出合法段用谁；都不产出则 segments 为空。
 */
export function normalizeProviderTranscript(raw: unknown): NormalizeResult {
  const out: AsrTranscriptSegment[] = [];
  let dropped = 0;
  let language: string | null = null;
  let durationRaw: number | null = null;

  if (isRecord(raw)) {
    language = readString(raw, 'language');
    durationRaw = toFiniteSeconds(raw['duration']);
    dropped += fromSegmentsShape(raw, out);
    if (out.length === 0) {
      dropped += fromSentencesShape(raw, out);
    }
  }

  const maxEnd = out.reduce((acc, seg) => Math.max(acc, seg.end), 0);
  return {
    transcript: {
      language: language ?? 'und',
      duration: durationRaw ?? maxEnd,
      segments: out,
    },
    dropped,
  };
}
