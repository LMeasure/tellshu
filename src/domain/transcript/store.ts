/**
 * 字幕 / 学习稿本地持久化（Phase 2 M1）
 * ------------------------------------------------------------------
 * 落点是前端 Dexie（2026-10-18 用户拍板：离线优先红线，transcript 是用户
 * 资产起点，必须跟着用户走；PG 只存账号 + 系统配置，不增 asr 表）。
 * 页面与其它领域代码只调这里的函数；dexie 封装在 services/storage，
 * 本文件是领域编排，不直接 import Dexie。
 *
 * 幂等 / 覆盖口径（评审冻结）：
 *   · transcripts 主键 = ASR job_id，重复 done 覆盖同行（put），不追加；
 *     覆盖保留已有 owner、created_at，以及本次没有重写的其它已有字段；
 *   · studyNotes 按 transcript_id upsert——存在则原地重置（保留 id、
 *     created_at 与已有 owner），不存在才新建，杜绝孤儿记录；重生成会把 source 重置为
 *     ai_generated（用户修改会被覆盖，M2 UI 必须先弹确认）。
 *   · 两条写路径的新行 owner 默认 'guest'。不回填存量，不升 Dexie 版本。
 *     调用方多带的 owner（含空字符串）不参与写入，因此空字符串盖不掉已有非空 owner。
 *
 * 落库失败口径：调用方（transcribeAndSave）自行 try/catch——持久化是增强，
 * 不是转写成功的前提，失败不阻断结果展示。
 */

import { storage } from '@/services/storage'
import { saveReading } from '@/domain/learning'
import type { ReadingDoc } from '@/domain/learning'
import type {
  StudyNoteBilingualNote,
  StudyNoteRecord,
  StudyNoteSource,
  StudyNoteStatus,
  StudyNoteVocabulary,
  Transcript,
  TranscriptRecord,
  TranscriptSegment,
} from './types'

/** transcripts.source：目前只有 ASR 一条来源 */
export const TRANSCRIPT_SOURCE_ASR = 'asr'

/** 生成记录 id（uuid）。crypto.randomUUID 在现代浏览器与 Node 19+ 可用，降级到时间戳+随机串。 */
function newId(): string {
  const c = globalThis.crypto as Crypto | undefined
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  return `sn-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

/* ------------------------------------------------------------------ */
/* transcripts                                                         */
/* ------------------------------------------------------------------ */

/** 会话内 Transcript -> 落库记录（幂等：同 job_id 覆盖）。 */
export function toTranscriptRecord(t: Transcript, nowMs: number = Date.now()): TranscriptRecord {
  return {
    id: t.id,
    language: t.language,
    duration: t.duration,
    segments: t.segments,
    fileName: t.fileName,
    created_at: nowMs,
    source: TRANSCRIPT_SOURCE_ASR,
  }
}

/**
 * 覆盖写的 owner。与 saveReading 同一口径：`prev?.owner ?? 'guest'`。
 * 只看已落库的 prev，不读本次入参上的 owner——空字符串因此不能盖掉已有非空值，
 * 新行（没有 prev）得到 'guest'。
 */
function ownerForOverwrite(prevOwner: string | undefined): string {
  return prevOwner ?? 'guest'
}

export async function saveTranscriptRecord(t: Transcript): Promise<TranscriptRecord> {
  const table = storage.table('transcripts')
  const prev = await table.get(t.id)
  const fresh = toTranscriptRecord(t)
  const record: TranscriptRecord = {
    ...(prev ?? {}),
    ...fresh,
    created_at: prev?.created_at ?? fresh.created_at,
    owner: ownerForOverwrite(prev?.owner),
  }
  // toTranscriptRecord 总会带上 fileName 键；未提供时值是 undefined，展开会把已有文件名抹掉。
  if (t.fileName === undefined) {
    if (prev?.fileName !== undefined) record.fileName = prev.fileName
    else delete record.fileName
  }
  await table.put(record)
  return record
}

/* ------------------------------------------------------------------ */
/* 转写 -> 阅读器资料（复用 learning.saveReading 领域入口，不绕过领域层）  */
/* ------------------------------------------------------------------ */

/** 全段拼成纯文本（供阅读器文本视图；时间戳单独存 segments）。 */
function transcriptToText(segments: readonly TranscriptSegment[]): string {
  return segments
    .map((s) => s.text.trim())
    .filter((t) => t !== '')
    .join('\n')
}

/**
 * 把一次转写结果登记为阅读器可读取的资料。
 * 幂等键：reading id = `t_${transcript.id}`（与 ASR job_id 对齐）；
 * 重复登记覆盖同行（saveReading 保留 created_at / 进度 / 书架状态），
 * 不产生第二份资料，也不要求用户重新导入。
 *
 * ⚠️ 不传 last_page：saveReading 的口径是 `input.last_page ?? prev?.last_page ?? 0`，
 * 显式传 0 会把已有阅读进度清零（0 ?? prev = 0）；缺省才走「保留原进度」分支。
 */
export async function ensureTranscriptReading(
  transcript: Transcript,
  fileName: string,
): Promise<ReadingDoc> {
  return saveReading({
    id: `t_${transcript.id}`,
    title: fileName || '字幕素材',
    type: 'transcript',
    content: transcriptToText(transcript.segments),
    segments: transcript.segments,
  })
}

/**
 * 历史补齐：遍历已落库转写，对尚无对应 reading 的创建（幂等键 t_<id>）。
 * 已存在则跳过——绝不覆盖用户可能在阅读器里的进度/书架改动，绝不重生成字幕。
 * 返回 {created, skipped} 供诊断。
 */
export async function backfillTranscriptReadings(): Promise<{ created: number; skipped: number }> {
  const records = await listTranscriptRecords()
  let created = 0
  let skipped = 0
  for (const rec of records) {
    const id = `t_${rec.id}`
    const existing = await storage.table('readings').get(id)
    if (existing !== undefined) {
      skipped += 1
      continue
    }
    await saveReading({
      id,
      title: rec.fileName || '字幕素材',
      type: 'transcript',
      content: transcriptToText(rec.segments),
      segments: rec.segments,
    })
    created += 1
  }
  return { created, skipped }
}

/** 最近一条转写（按 created_at 倒序）；无则返回 undefined。供 UI 挂载回读。 */
export async function getLatestTranscriptRecord(): Promise<TranscriptRecord | undefined> {
  const all = await listTranscriptRecords()
  if (all.length === 0) return undefined
  return all.sort((a, b) => b.created_at - a.created_at)[0]
}

/**
 * 启动期一次性补齐历史转写→阅读器关联（幂等、便宜）。
 * 失败不影响启动（仅告警），与 initStorage 的兜底口径一致。
 */
export async function reconcileTranscriptReadings(): Promise<void> {
  try {
    const { created, skipped } = await backfillTranscriptReadings()
    if (created > 0) {
      console.info(`[transcript] 补齐历史转写资料 ${created} 条（已存在 ${skipped} 条）`)
    }
  } catch (e) {
    console.warn('[transcript] 历史转写补齐失败（不影响使用）：', e)
  }
}

export async function getTranscriptRecord(id: string): Promise<TranscriptRecord | undefined> {
  return storage.table('transcripts').get(id)
}

/** 全部字幕（无序；调用方按 created_at 排序）。 */
export async function listTranscriptRecords(): Promise<TranscriptRecord[]> {
  return storage.table('transcripts').toArray()
}

/* ------------------------------------------------------------------ */
/* studyNotes（M1 建表 + CRUD；流式读写编排在 M2）                      */
/* ------------------------------------------------------------------ */

/** upsert 输入：不含 id / 时间戳 / 落库状态，由本模块补全。 */
export interface StudyNoteDraft {
  transcript_id: string
  summary: string
  /** 逐句结构化双语解释（M2 契约；M1 占位期曾是整段 string，已升级） */
  bilingual_notes: StudyNoteBilingualNote[]
  key_points: string[]
  vocabulary: StudyNoteVocabulary[]
  status?: StudyNoteStatus
  source?: StudyNoteSource
}

function draftToRecord(draft: StudyNoteDraft, id: string, createdAt: number, nowMs: number): StudyNoteRecord {
  return {
    id,
    transcript_id: draft.transcript_id,
    summary: draft.summary,
    bilingual_notes: draft.bilingual_notes,
    key_points: draft.key_points,
    vocabulary: draft.vocabulary,
    status: draft.status ?? 'generating',
    created_at: createdAt,
    updated_at: nowMs,
    source: draft.source ?? 'ai_generated',
  }
}

/**
 * 按 transcript_id upsert：已存在则原地重置（保留 id / created_at / 已有 owner
 * 以及本次草稿没重写的其它已有字段），否则新建。绝不产生同一 transcript 的第二行。
 * 新行 owner 为 'guest'。不读取草稿上多带的 owner。
 */
export async function upsertStudyNote(draft: StudyNoteDraft): Promise<StudyNoteRecord> {
  const table = storage.table('studyNotes')
  const existing = await table.whereIndex('transcript_id', draft.transcript_id)
  const now = Date.now()
  if (existing.length > 0) {
    const prev = existing[0]
    const fresh = draftToRecord(draft, prev.id, prev.created_at, now)
    const record: StudyNoteRecord = {
      ...prev,
      ...fresh,
      owner: ownerForOverwrite(prev.owner),
    }
    await table.put(record)
    return record
  }
  const record: StudyNoteRecord = {
    ...draftToRecord(draft, newId(), now, now),
    owner: 'guest',
  }
  await table.put(record)
  return record
}

export async function getStudyNoteByTranscriptId(transcriptId: string): Promise<StudyNoteRecord | undefined> {
  const rows = await storage.table('studyNotes').whereIndex('transcript_id', transcriptId)
  return rows[0]
}

/** 局部更新（用户编辑用：内容字段 + status/source），updated_at 自动刷新。 */
export async function patchStudyNote(
  id: string,
  patch: Partial<Pick<StudyNoteRecord, 'summary' | 'bilingual_notes' | 'key_points' | 'vocabulary' | 'status' | 'source'>>,
): Promise<StudyNoteRecord | undefined> {
  const table = storage.table('studyNotes')
  const prev = await table.get(id)
  if (prev === undefined) return undefined
  const record: StudyNoteRecord = { ...prev, ...patch, updated_at: Date.now() }
  await table.put(record)
  return record
}

export async function deleteStudyNote(id: string): Promise<void> {
  await storage.table('studyNotes').delete(id)
}
