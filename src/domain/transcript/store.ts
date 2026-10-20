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
 *   · studyNotes 按 transcript_id upsert——存在则原地重置（保留 id 与
 *     created_at），不存在才新建，杜绝孤儿记录；重生成会把 source 重置为
 *     ai_generated（用户修改会被覆盖，M2 UI 必须先弹确认）。
 *
 * 落库失败口径：调用方（transcribeAndSave）自行 try/catch——持久化是增强，
 * 不是转写成功的前提，失败不阻断结果展示。
 */

import { storage } from '@/services/storage'
import type {
  StudyNoteBilingualNote,
  StudyNoteRecord,
  StudyNoteSource,
  StudyNoteStatus,
  StudyNoteVocabulary,
  Transcript,
  TranscriptRecord,
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
    created_at: nowMs,
    source: TRANSCRIPT_SOURCE_ASR,
  }
}

export async function saveTranscriptRecord(t: Transcript): Promise<TranscriptRecord> {
  const record = toTranscriptRecord(t)
  await storage.table('transcripts').put(record)
  return record
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
 * 按 transcript_id upsert：已存在则原地重置（保留 id / created_at），
 * 否则新建。绝不产生同一 transcript 的第二行。
 */
export async function upsertStudyNote(draft: StudyNoteDraft): Promise<StudyNoteRecord> {
  const table = storage.table('studyNotes')
  const existing = await table.whereIndex('transcript_id', draft.transcript_id)
  const now = Date.now()
  if (existing.length > 0) {
    const prev = existing[0]
    const record = draftToRecord(draft, prev.id, prev.created_at, now)
    await table.put(record)
    return record
  }
  const record = draftToRecord(draft, newId(), now, now)
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
