/**
 * 音视频转字幕 · 领域类型
 * ------------------------------------------------------------------
 * 与 server/src/types.ts 的 ASR 响应字段一一对应（联调用）。
 * Phase 1 口径：Transcript 是会话内结果；Phase 2 M1 起落库用 TranscriptRecord。
 */

/** 一个字幕段（秒，允许小数）。 */
export interface TranscriptSegment {
  start: number
  end: number
  text: string
}

/** 归一化后的转录结果。 */
export interface Transcript {
  /** 服务端 jobId */
  id: string
  /** ISO 语言码；服务端未定时为 'und'（不臆造） */
  language: string
  /** 秒；服务端未定时由段落最大 end 推导 */
  duration: number
  segments: TranscriptSegment[]
}

export type AsrJobStatus = 'queued' | 'running' | 'done' | 'failed'

export interface AsrJobError {
  code: string
  message: string
}

/** POST /api/asr/jobs 的 202 响应。 */
export interface AsrSubmitResponse {
  jobId: string
  status: AsrJobStatus
  error: AsrJobError | null
}

/** GET /api/asr/jobs/:jobId 的 200 响应。 */
export interface AsrJobResponse {
  jobId: string
  status: AsrJobStatus
  /** done 时的转录结果；未完成 / 失败为 null */
  transcript: Transcript | null
  error: AsrJobError | null
}

/**
 * transcripts 表记录（Phase 2 M1，2026-10-18 用户拍板）
 * ------------------------------------------------------------------
 * transcript 是用户资产起点（学习稿 / 词库 / 卡片都从它派生），
 * 落前端 Dexie 永久留存；id 与 ASR job_id 对齐，重复 done 幂等覆盖。
 */
export interface TranscriptRecord {
  /** = ASR job_id */
  id: string
  language: string
  duration: number
  segments: TranscriptSegment[]
  /** epoch ms */
  created_at: number
  /** 'asr'；后续学习稿可能另有来源 */
  source: string
}

/** studyNotes 表 · vocabulary 契约（与 LLM 输出一致，评审冻结 2026-10-18）。 */
export interface StudyNoteVocabulary {
  /** 原形/lemma */
  word: string
  /** 词性——dictEntries 同词形多条记录靠它精确命中 */
  pos: string
  /** AI 生成的双语解释 */
  gloss: string
  /** 原文语境（optional）：回匹字幕 segment 命中时填原句，未命中不硬造 */
  context?: string
  /** 语境所在字幕段起点（秒）：词汇点击跳转播放用；未命中为 undefined */
  segment_start?: number
}

/** studyNotes 表 · 双语解释契约（M2：四要素拆开、逐句结构化可编辑）。 */
export interface StudyNoteBilingualNote {
  /** 字幕中出现过的英文原句 */
  en: string
  /** 该句的中文翻译或语言点解释 */
  zh: string
}

export type StudyNoteStatus = 'generating' | 'ready' | 'modified'

export type StudyNoteSource = 'ai_generated' | 'user_modified'

/**
 * studyNotes 表记录（Phase 2 M1 建表；流式读写编排在 M2）。
 * 写入规则（评审冻结）：按 transcript_id upsert 不追加；
 * 重生成覆盖 user_modified 前 UI 必须确认。
 */
export interface StudyNoteRecord {
  /** uuid，服务层生成（调用方不管理 id） */
  id: string
  transcript_id: string
  summary: string
  /** 双语解释（述树差异化主力，与 summary 拆开独立可编辑；M2 起为逐句结构化数组） */
  bilingual_notes: StudyNoteBilingualNote[]
  key_points: string[]
  vocabulary: StudyNoteVocabulary[]
  status: StudyNoteStatus
  created_at: number
  updated_at: number
  source: StudyNoteSource
}
