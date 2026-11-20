/**
 * 领域实体类型（平台无关）
 * ------------------------------------------------------------------
 * 这里只描述「学习数据长什么样」，不关心它存在哪。
 * 存哪由 `src/services/storage` 决定：Web 上是 IndexedDB，将来原生壳里
 * 可以是 SQLite —— 换存储不该动这个文件，也不该动 `domain/learning.ts`。
 *
 * 状态机（对齐 06-数据模型 §4 / 02-IA §5 / 03 §6）：
 *   new(生词本) ──连续对 5 次(同一题型)──▶ apply(闯关通过)
 *   apply ──────连续对 5 次─────────────▶ mastered(掌握层)
 *   答错 ──────srs_step 归零 + 进错题本──▶ 下次复习回流
 * SRS 间隔：10min / 1h / 1d / 3d / 7d / 14d / 30d（答对步进，答错回退首档）。
 */

import type { BookChapter } from '../lib/epub'
import type { MaskMode, MaskTarget } from '../lib/masking'
import type { DiagnoseLevel } from '../lib/diagnostic'
import type { StudyNoteRecord, TranscriptRecord, TranscriptSegment } from './transcript/types'
import type { SpellingSession } from './spelling'
import type { WordLearningSession } from './wordLearning'

/** 诊断等级沿用 lib/diagnostic 的定义，避免两处各写一份后漂移 */
export type { DiagnoseLevel }

export type LearnLayer = 'new' | 'practice' | 'apply' | 'mastered'
export type QuizForm = 'choose-meaning' | 'dictation' | 'spelling'

export interface VocabEntry {
  /** 唯一键：优先用词库 id，否则 `book:word(小写)` */
  word_id: string
  word: string
  book?: string
  ipa?: string
  definition_zh?: string
  pos?: string
  layer: LearnLayer
  /** 连续答对次数（同一题型累计；答错清零） */
  consecutive_correct: number
  /** SRS 复习步数（决定 next_review 间隔档位） */
  srs_step: number
  /** 上次闯关题型（沿用同一题型，不做轮替，见 05 §5.7） */
  last_quiz_form?: QuizForm
  /** 是否错题本（与闯关层合并出题） */
  in_wrong_pool: boolean
  /** 下次复习时间（epoch ms） */
  next_review: number
  added_at: number
  mastered_at?: number
  /** 同步字段（v8）：owner 多端隔离，updated_at 参与 LWW 合并，deleted_at 软删墓碑 */
  owner?: string
  updated_at?: number
  deleted_at?: number | null
}

export interface ReviewLog {
  id?: number
  word_id: string
  at: number
  correct: boolean
  quiz_form: QuizForm
  /** 同步字段（v8）：uid 为跨端同步标识（不动原 ++id），owner 多端隔离 */
  uid?: string
  owner?: string
  updated_at?: number
  deleted_at?: number | null
}

export type ReadingType = 'article' | 'book' | 'audio' | 'transcript'

/** 书签：页级标记 + 挂靠段落（目录里列出并可跳转） */
export interface ReadingBookmark {
  id: string
  /** 所在页 */
  page: number
  /** 添加书签时的段落（目录预览文本用） */
  para: number
  created_at: number
}

/** 划线样式（需求：底纹 / 直线 / 波浪线） */
export type AnnotationStyle = 'highlight' | 'underline' | 'wavy'

/** 划线颜色（红 / 橙 / 蓝 / 绿 / 黄） */
export type AnnotationColor = 'red' | 'orange' | 'blue' | 'green' | 'yellow'

/** 阅读批注：划线与想法合一（想法可附着在划线区间上） */
export interface ReadingAnnotation {
  id: string
  doc_id: string
  /** 定位：页 / 段 / 段内字符区间 [start, end) */
  page: number
  para: number
  start: number
  end: number
  /** 选中的原文（渲染兜底 + 编辑时回显） */
  text: string
  kind: 'underline' | 'thought'
  /** kind='underline' 时的样式与颜色 */
  style?: AnnotationStyle
  color?: AnnotationColor
  /** kind='thought' 时的想法正文 */
  thought?: string
  /**
   * 批注来源（V3.0 需求五）：留空 = 我的笔记；有值 = 他人笔记（显示为紫色虚线）。
   * 无账号体系时不会有值 —— 不编造，等账号/社区接入后再写入。
   */
  author?: string
  created_at: number
  updated_at: number
}

/** 导入并本地保存的阅读素材（文章/书籍/音频，见 06 §7.1） */
export interface ReadingDoc {
  id: string
  title: string
  type: ReadingType
  /** 文本内容（文章/书籍提取的文本）；音频类型为占位空串 */
  content: string
  word_count: number
  created_at: number
  last_read_at?: number
  scroll_pos?: number
  /** 章节目录（EPUB/TXT 解析所得；无目录则缺省，不虚构） */
  chapters?: BookChapter[]
  /** 上次读到的页码（分页阅读续读用） */
  last_page?: number
  /** 默写进度（隐藏方式 + 每页已输入内容），下次进入可继续 */
  dictation?: DictationProgress
  /** 是否加入首页书架（书籍可用） */
  on_shelf?: boolean
  /** 置顶时间戳（书架排序：置顶在前，组内按最近阅读倒序）；无 = 未置顶 */
  pinned_at?: number
  /** 所属书单名列表（多选「加入书单」写入；空/缺省 = 不属于任何书单） */
  booklists?: string[]
  /**
   * 发现书来源站点快照。有值即判定为「发现书」（正文待接入，不编造）。
   * 行内可选，不建索引、不升 Dexie 版本（先例同 chapters / bookmarks / pinned_at）。
   * 本轮前端固定为 'gutenberg'（/api/discover 不透出 source_site）。
   */
  source_site?: string
  /**
   * 发现书来源唯一标识快照。当前检索响应只有 book_id，
   * 因此 source_id = book_id（PG discovered_books.id 的字符串）。
   */
  source_id?: string
  /** 作者（书架卡片展示；导入书无此字段） */
  author?: string
  /** 书签列表（页级，目录中列出并跳转） */
  bookmarks?: ReadingBookmark[]
  /** 音频文件二进制（type==='audio' 时存在） */
  blob?: Blob
  /** 音频 MIME，如 audio/mpeg */
  media_type?: string
  /** 扩展名，如 mp3 */
  ext?: string
  /**
   * 音视频字幕转写的分段时间戳（type==='transcript' 时存在）。
   * 非索引字段，随对象整体存储，不需 Dexie 升版本。
   */
  segments?: TranscriptSegment[]
}

/** 学习时长按日累计（计入个人中心可视化，见 06 §7.3） */
export interface ReadingTimeRow {
  date: string // YYYY-MM-DD
  /** 阅读/听书秒数 */
  total_seconds: number
  /** 默写秒数（学习时间的「默写」子分支，随记忆模式计时累计） */
  dictation_seconds?: number
  /** 同步字段（v8）：owner 多端隔离 */
  owner?: string
  updated_at?: number
}

/** 默写进度：隐藏方式 + 每页已输入的空位内容 */
export interface DictationProgress {
  mode: MaskMode
  /** 随机隐藏比例 */
  ratio: number
  /** 完全隐藏时是否含标点 */
  hidePunctuation: boolean
  /** 双语素材下只隐藏某一种语言（需求【8】）；老存档没有这个字段 → 按 all 处理 */
  target?: MaskTarget
  /** 自主选择模式下勾选的空位 key */
  manualKeys: string[]
  /** 随机种子（「换一批」后变化） */
  seed: number
  /** 上次停留的页 */
  page: number
  /** 空位 key → 用户输入（key 为 `页:段:词`） */
  values: Record<string, string>
  updated_at: number
}

/** 背诵录音（真实音频文件，存本地，自动归档到「我的-背诵」） */
export interface Recitation {
  id: string
  /** 来源素材（书籍 / 文章），可空（自由背诵） */
  doc_id?: string
  doc_title?: string
  /** 来源页 */
  page?: number
  /** 自动命名：当前日期-背诵时长 */
  title: string
  duration_ms: number
  /** 字节数，列表展示用 */
  size: number
  media_type: string
  created_at: number
  blob: Blob
}

/** 一次诊断的结果（个人中心展示当前等级与历史） */
export interface DiagnoseRow {
  id?: number
  at: number
  /** 答对数 */
  correct: number
  /** 总题数 */
  total: number
  level: DiagnoseLevel
  /** 建议起始词本（CET4/CET6/…），由定级结果推导 */
  start_book: string
}

/* ------------------------------------------------------------------
 * 词典扫描库缓存（功能 B）
 * ------------------------------------------------------------------
 * 真源在后端 PostgreSQL；这里是前端 Dexie 的只读镜像，用于离线检索与展示。
 * 只通过 src/domain/dict.ts 读写，页面禁止直接碰 storage。
 * ------------------------------------------------------------------ */

export interface DictExample {
  en: string
  zh: string | null
}

export interface DictPhrase {
  text: string
  zh: string | null
}

/** 义项：例句挂在自己所属的释义下（扫描词典解析器产出；空数组 = 未分组） */
export interface DictSense {
  definition_en: string | null
  definition_zh: string
  examples: DictExample[]
}

/** 词条缓存行；主键 = `${word_key}|${pos_key}` */
export interface DictEntry {
  key: string
  id: string
  word: string
  /** 小写词形，供前缀 / 模糊匹配 */
  word_lower: string
  phonetic: string | null
  pos: string
  definition_en: string
  definition_zh: string
  /** 义项分组；老缓存行可能没有该字段，读取时按 [] 兜底 */
  senses: DictSense[]
  examples: DictExample[]
  phrases: DictPhrase[]
  synonyms: string[]
  antonyms: string[]
  tags: string[]
  root_affix: string | null
  source_page: number | null
  source_book: string
  updated_at: number
}

/** 目录树节点缓存行；主键 = 后端 id */
export interface DictTocNode {
  id: string
  book: string
  title: string
  parent_id: string | null
  page_start: number
  page_end: number | null
  order_index: number
  level: number
  updated_at: number
}

/** 语法 / 变形规则缓存行；主键 = `${type}|${base_lower}` */
export interface DictGrammarRule {
  key: string
  id: string
  type: string
  base_form: string
  base_lower: string
  past_tense: string | null
  past_participle: string | null
  extra: Record<string, string>
  source_book: string
  source_page: number | null
  updated_at: number
}

/** 元数据（增量同步游标等）；主键 = key */
export interface DictMeta {
  key: string
  /** 已同步到的 sync_seq */
  since: number
  updated_at: number
}

/* ------------------------------------------------------------------
 * 账号 / 多端同步（v8 新增，对应 services/storage/web.ts 的 version(8)）
 * ------------------------------------------------------------------ */

/** 阅读器偏好（形状与 store/useAppStore 的 ReaderPrefs 一致；此处独立定义避免 domain→store 反向依赖） */
export interface ReaderPrefs {
  fontSize: number
  lineHeight: number
  margin: 'sm' | 'md' | 'lg'
  fontFamily: 'sans' | 'serif'
  indent: boolean
  pageMode: 'slide' | 'book' | 'scroll' | 'cover'
  theme: 'white' | 'sepia' | 'green' | 'dark'
  brightness: number
}

/** 收藏集合（如「旅行英语」），对应需求里的 collections 表 */
export interface CollectionRow {
  id: string // UUID，PK
  owner: string
  name: string
  word_ids: string[]
  color?: string
  order?: number
  updated_at: number
  deleted_at?: number | null // 软删墓碑，参与 LWW 合并
}

/** 账号级设置（可同步子集；设备态 darkMode / wordDetail UI 仍留本地） */
export interface AccountSettingsRow {
  owner: string // PK
  daily_goal?: number // 每日目标（新字段）
  speed: 'slow' | 'normal'
  accent: 'en-US' | 'en-GB'
  chineseAssist: boolean
  studyBatchSize: number
  speechRate: number
  replayScope: 'continue' | 'single'
  readerPrefs: ReaderPrefs
  updated_at: number
}

/** 账号会话（令牌只存此处，不进 localStorage） */
export interface SessionRow {
  user_id: string // PK
  email: string
  access_token: string
  refresh_token: string
  expires_at: number
  updated_at: number
}

/** Phase 1 可同步实体范围 */
export type SyncableEntity = 'vocab' | 'reviewLog' | 'collections' | 'settings'

/** 同步发件箱（Outbox）：本地变更先入队，异步幂等推送到云端 */
export interface SyncQueueRow {
  id: string // UUID
  entity: SyncableEntity
  entity_id: string
  op: 'upsert' | 'delete'
  payload: Record<string, unknown>
  created_at: number
  attempts: number
  last_error?: string | null
}

/** 同步元数据（last_sync_at / sync_status / current_user_id / pending_merge 等） */
export interface SyncMetaRow {
  key: string // PK
  value: unknown
}

/* ------------------------------------------------------------------
 * 错词事件（单词默写 V2，Dexie v14 新增表；领域写入逻辑不在本文件）
 * ------------------------------------------------------------------ */

/**
 * 错词事件类型。
 * ⚠️ 实施草案：最终取值待架构负责人书面确认（见《Dexie版本协调-实施授权清单.md》Q2 待合并复核、
 * 《Dexie版本协调-G9-D9-结论.md》§九 item 3）。当前按「非成功终态即错误事件」取三类。
 */
export type SpellingErrorEventKind = 'wrong' | 'skip' | 'unavailable'

/**
 * 事件结算状态三态（对应《Dexie版本协调-G9-D9-结论.md》§四「重放依据」：
 * 以 event_id 主键 + 会话高水位 + 事件行 status 三态判定哪些事件未结算）。
 * ⚠️ 同上，实施草案，待合并复核。
 */
export type SpellingErrorEventStatus = 'pending' | 'settled' | 'aborted' | 'settled_skipped'

/**
 * 一次拼写错误/未完成的持久化事件（主键 event_id，幂等回放依据）。
 *
 * ⚠️ 以下 tab_id / lock_epoch / settled_at / settle_reason 均为**行内字段**：
 * Dexie `stores()` 只声明索引，新增行内字段不改 schema、不触发版本号升级。
 * 结算状态的权威依据是会话文档里的 `applied_error_event_ids` 凭证，
 * `status` 只是非权威展示态（T-C），落后或超前都不影响幂等。
 */
export interface SpellingErrorEvent {
  /** 主键；写入方保证唯一，drain 重放以 event_id 去重 */
  event_id: string
  /** 归属用户；默认 'guest'（v13 约定） */
  owner: string
  /** 关联词条 */
  word_id: string
  /** 关联默写会话 id */
  session_id: string
  /** 事件类型（草案） */
  kind: SpellingErrorEventKind
  /** 发生时间（epoch ms） */
  occurred_at: number
  /** 结算状态（草案）；'settled_skipped' = 旧代次 stale 事件，写凭证但不归零 */
  status: SpellingErrorEventStatus
  /** 写入时的持锁标签（C09/T29 fencing 追溯用） */
  tab_id?: string
  /** 写入时冻结的锁代次；与会话当前 lock_epoch 不符即判 stale */
  lock_epoch?: number
  /** 结算完成时间（展示用） */
  settled_at?: number
  /** 结算原因码（如 'stale_epoch'），不记录隐私数据 */
  settle_reason?: string
}

/* ------------------------------------------------------------------
 * 存储表映射：storage.table('vocab') 的类型由此决定，写错表名/类型会编译报错
 * ------------------------------------------------------------------ */

export interface StorageSchema {
  vocab: VocabEntry
  reviewLog: ReviewLog
  readings: ReadingDoc
  readingTime: ReadingTimeRow
  diagnose: DiagnoseRow
  recitations: Recitation
  // ↓ v6 新增：词典扫描库缓存
  dictEntries: DictEntry
  dictToc: DictTocNode
  dictGrammar: DictGrammarRule
  dictMeta: DictMeta
  // ↓ v7 新增：阅读批注（划线 + 想法）
  annotations: ReadingAnnotation
  // ↓ v8 新增：账号 / 多端同步
  collections: CollectionRow
  settings: AccountSettingsRow
  session: SessionRow
  sync_queue: SyncQueueRow
  sync_meta: SyncMetaRow
  // ↓ v9 新增：ASR 字幕持久化 + AI 学习稿（Phase 2 M1）
  transcripts: TranscriptRecord
  studyNotes: StudyNoteRecord
  // ↓ v10 新增：单词默写会话（单文档，queue 内嵌；方案 V3.2 §5.1）
  spellingSessions: SpellingSession
  // ↓ v11 新增：单词学习进度（单文档，完整队列 + 位置 + 已完成；2026-10-31 修复进度重置）
  wordLearningSessions: WordLearningSession
  // ↓ v14 新增：单词默写 V2 错词事件（主键 event_id，纯新增表；kind/status 为实施草案待复核）
  spellingErrorEvents: SpellingErrorEvent
}

export type TableName = keyof StorageSchema

/** 各表主键类型（自增表为 number） */
export interface PrimaryKeyMap {
  vocab: string
  reviewLog: number
  readings: string
  readingTime: string
  diagnose: number
  recitations: string
  dictEntries: string
  dictToc: string
  dictGrammar: string
  dictMeta: string
  annotations: string
  collections: string
  settings: string
  session: string
  sync_queue: string
  sync_meta: string
  transcripts: string
  studyNotes: string
  spellingSessions: string
  wordLearningSessions: string
  spellingErrorEvents: string
}

export type PrimaryKey<K extends TableName> = PrimaryKeyMap[K]

/* ------------------------------------------------------------------
 * 派生统计结构（个人中心 / 复习页展示用）
 * ------------------------------------------------------------------ */

export interface LayerCounts {
  new: number
  apply: number
  mastered: number
  wrong: number
  due: number
  total: number
}

export interface DailyStat {
  date: string // YYYY-MM-DD
  /** 当日复习作答次数 */
  reviews: number
  /** 当日新掌握的词数 */
  mastered: number
  /** 当日阅读/听书秒数 */
  readingSeconds: number
  /** 当日默写秒数（学习时间的「默写」子分支）；老存档无此字段 → 0 */
  dictationSeconds?: number
}

export interface MonthlyStat {
  month: string // YYYY-MM
  mastered: number
  reviews: number
}
