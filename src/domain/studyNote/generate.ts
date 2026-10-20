/**
 * 学习稿生成编排（Phase 2 M2）
 * ------------------------------------------------------------------
 * 链路：llmClient SSE 流式 -> done.note（unknown）-> 前端契约校验 ->
 * vocabulary 语境回匹（字幕 segment -> context/segment_start）->
 * upsertStudyNote（status=ready）。
 *
 * 三处口径（与 server 端对齐）：
 *   1. 契约校验逐字段守卫，坏项静默丢弃、绝不编造补齐；
 *      四要素全空判败（服务端已校验一遍，这里是纵深防御）；
 *   2. vocabulary 回匹：word 在字幕里找不到匹配段时不硬造
 *      context/segment_start（查无此据就留空，点击跳转不可用）；
 *   3. 落库走 store.upsertStudyNote：同 transcript_id 原地重置，
 *      重生成即覆盖（source 重置 ai_generated，UI 侧先弹确认，
 *      见 StudyNotePanel）。
 *
 * 流式落库策略偏差说明：拆解文档 §2.2 曾冻结「生成期间节流更新
 * studyNotes」——单 JSON 契约下 partial 文本不可解析，节流写入只能
 * 存半截原文、没有展示价值，故改为「完成即写一次」，生成中进度只
 * 走内存态（delta 累加）。交付记录中如实记载该修正。
 */

import { generateStudyNoteStream, StudyNoteRequestError } from '@/data/llmClient'
import {
  upsertStudyNote,
  type StudyNoteDraft,
} from '@/domain/transcript/store'
import type {
  StudyNoteBilingualNote,
  StudyNoteRecord,
  StudyNoteVocabulary,
  Transcript,
  TranscriptSegment,
} from '@/domain/transcript/types'

/** LLM 学习稿四要素（done.note 的契约形态；vocabulary 未含回匹字段）。 */
export interface StudyNotePayload {
  summary: string
  bilingual_notes: StudyNoteBilingualNote[]
  key_points: string[]
  vocabulary: StudyNoteVocabulary[]
}

export { StudyNoteRequestError }

/* ------------------------------------------------------------------ */
/* 契约校验（与 server/src/llmStudyNote.ts validateStudyNotePayload 同口径） */
/* ------------------------------------------------------------------ */

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** 四要素校验：坏项丢弃、缺 pos 回退空串、重复词去重、全空判 null。 */
export function validateStudyNotePayload(value: unknown): StudyNotePayload | null {
  if (!isRecord(value)) return null

  const summary = asString(value['summary']) ?? ''

  const bilingualNotes: StudyNoteBilingualNote[] = []
  for (const item of asArray(value['bilingual_notes'])) {
    if (!isRecord(item)) continue
    const en = asString(item['en'])
    const zh = asString(item['zh'])
    if (en === null || zh === null) continue
    bilingualNotes.push({ en, zh })
  }

  const keyPoints: string[] = []
  for (const item of asArray(value['key_points'])) {
    const point = asString(item)
    if (point !== null) keyPoints.push(point)
  }

  const vocabulary: StudyNoteVocabulary[] = []
  const seenWords = new Set<string>()
  for (const item of asArray(value['vocabulary'])) {
    if (!isRecord(item)) continue
    const word = asString(item['word'])
    const gloss = asString(item['gloss'])
    if (word === null || gloss === null) continue
    if (seenWords.has(word.toLowerCase())) continue
    seenWords.add(word.toLowerCase())
    vocabulary.push({ word, pos: asString(item['pos']) ?? '', gloss })
  }

  if (summary === '' && bilingualNotes.length === 0 && keyPoints.length === 0 && vocabulary.length === 0) {
    return null
  }
  return { summary, bilingual_notes: bilingualNotes, key_points: keyPoints, vocabulary }
}

/* ------------------------------------------------------------------ */
/* 语境回匹（vocabulary -> 字幕 segment）                              */
/* ------------------------------------------------------------------ */

/**
 * 词汇回匹：word 在 segment.text 里命中的第一段记 context=原句 +
 * segment_start=段起点；未命中原样返回（不硬造）。
 * 已带 segment_start 的（后续可能来自用户补录）不动。
 */
export function matchVocabularyContext(
  vocabulary: StudyNoteVocabulary[],
  segments: TranscriptSegment[],
): StudyNoteVocabulary[] {
  return vocabulary.map((item) => {
    if (item.segment_start !== undefined) return item
    const needle = item.word.toLowerCase()
    const hit = segments.find((seg) => seg.text.toLowerCase().includes(needle))
    if (hit === undefined) return item
    return { ...item, context: hit.text, segment_start: hit.start }
  })
}

/* ------------------------------------------------------------------ */
/* 生成编排                                                            */
/* ------------------------------------------------------------------ */

export interface GenerateStudyNoteOptions {
  /** 每个增量 token 的回调，参数是已累加全文（进度展示用） */
  onDelta?: (fullText: string) => void
  signal?: AbortSignal
}

/**
 * 端到端生成并落库。失败分类：
 *   · StudyNoteRequestError（SSE error / 网络 / 未接入 503）原样透传；
 *   · 契约校验失败 -> StudyNoteRequestError('invalid_payload')。
 */
export async function generateAndSaveStudyNote(
  transcript: Transcript,
  options: GenerateStudyNoteOptions = {},
): Promise<StudyNoteRecord> {
  const note = await generateStudyNoteStream(transcript, {
    onDelta: options.onDelta,
    signal: options.signal,
  })
  const payload = validateStudyNotePayload(note)
  if (payload === null) {
    throw new StudyNoteRequestError('invalid_payload', 'AI 返回的学习稿结构不完整，请重试')
  }
  const draft: Omit<StudyNoteDraft, 'status' | 'source'> = {
    transcript_id: transcript.id,
    summary: payload.summary,
    bilingual_notes: payload.bilingual_notes,
    key_points: payload.key_points,
    vocabulary: matchVocabularyContext(payload.vocabulary, transcript.segments),
  }
  return upsertStudyNote({ ...draft, status: 'ready' })
}
