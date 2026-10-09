/**
 * 学习领域逻辑（平台无关）
 * ------------------------------------------------------------------
 * 承载「记忆→运用→掌握」分层 SRS 与学习态，**完全离线可用**（见 08 §3.2、09 Phase 1）。
 * 只写业务规则；持久化一律通过 `services/storage` 的 `storage` 单例，
 * 本文件不出现任何 dexie / indexedDB 字样 —— 换存储不该动这里。
 *
 * 状态机（对齐 06-数据模型 §4 / 02-IA §5 / 03 §6）：
 *   new(生词本) ──连续对 5 次(同一题型)──▶ apply(闯关通过)
 *   apply ──────连续对 5 次─────────────▶ mastered(掌握层)
 *   答错 ──────srs_step 归零 + 进错题本──▶ 下次复习回流
 * SRS 间隔：10min / 1h / 1d / 3d / 7d / 14d / 30d（答对步进，答错回退首档）。
 */

import { gradeDiagnosis, type DiagnoseAnswer, type DiagnoseLevel } from '../lib/diagnostic'
import { storage } from '../services/storage'
import { uuid } from '@/lib/uuid'
import { enqueueSync } from '../services/sync'
import type {
  DailyStat,
  DictationProgress,
  DiagnoseRow,
  LearnLayer,
  LayerCounts,
  MonthlyStat,
  QuizForm,
  ReadingAnnotation,
  ReadingBookmark,
  ReadingDoc,
  ReadingType,
  Recitation,
  ReviewLog,
  VocabEntry,
} from './types'

/* 实体类型在此转出，页面既有 import 路径不变 */
export type {
  DailyStat,
  DictationProgress,
  DiagnoseRow,
  LearnLayer,
  LayerCounts,
  MonthlyStat,
  QuizForm,
  ReadingAnnotation,
  ReadingBookmark,
  ReadingDoc,
  ReadingType,
  Recitation,
  ReviewLog,
  VocabEntry,
}
/** 定级逻辑为纯函数（可单测），放在 lib/diagnostic；此处再导出供页面使用。 */
export type { DiagnoseLevel, DiagnoseAnswer }
export { gradeDiagnosis }

/** 表句柄集中在此，避免每处都写 storage.table('x') */
const T = {
  vocab: storage.table('vocab'),
  reviewLog: storage.table('reviewLog'),
  readings: storage.table('readings'),
  readingTime: storage.table('readingTime'),
  diagnose: storage.table('diagnose'),
  recitations: storage.table('recitations'),
  annotations: storage.table('annotations'),
} as const

/** SRS 间隔（毫秒）：10min / 1h / 1d / 3d / 7d / 14d / 30d */
const SRS_INTERVALS = [
  10 * 60_000,
  60 * 60_000,
  24 * 3_600_000,
  3 * 24 * 3_600_000,
  7 * 24 * 3_600_000,
  14 * 24 * 3_600_000,
  30 * 24 * 3_600_000,
]
const PASS_THRESHOLD = 5

function makeWordId(w: { id?: string; word: string; book?: string }): string {
  return w.id || `${w.book ?? 'x'}:${w.word.toLowerCase()}`
}

/** 加入生词本（layer=new，排程 10min 首复习）。已存在则幂等返回。 */
export async function addToVocab(w: {
  id?: string
  word: string
  book?: string
  ipa?: string
  definition_zh?: string
  pos?: string
}): Promise<VocabEntry> {
  const word_id = makeWordId(w)
  const existing = await T.vocab.get(word_id)
  if (existing) return existing
  const now = Date.now()
  const entry: VocabEntry = {
    word_id,
    word: w.word,
    book: w.book,
    ipa: w.ipa,
    definition_zh: w.definition_zh,
    pos: w.pos,
    layer: 'new',
    consecutive_correct: 0,
    srs_step: 0,
    in_wrong_pool: false,
    next_review: now + SRS_INTERVALS[0],
    added_at: now,
    updated_at: now,
    owner: 'guest',
  }
  await T.vocab.put(entry)
  await enqueueSync('vocab', word_id, 'upsert', entry as unknown as Record<string, unknown>)
  return entry
}

/**
 * 批量加入生词本（一轮学完自动入库用）。
 * **绝不覆盖已有条目**：已经在生词本里的词保持原 layer / SRS 进度不动，
 * 否则会把快掌握的词打回生词层 —— 这是「走生词→已掌握逻辑」的前提。
 * 返回新入数与已存在数，供完成弹窗展示真实数字。
 */
export async function addManyToVocab(
  words: {
    id?: string
    word: string
    book?: string
    ipa?: string
    definition_zh?: string
    pos?: string
  }[],
): Promise<{ added: number; existed: number }> {
  const now = Date.now()
  const seen = new Set<string>()
  const candidates: VocabEntry[] = []
  for (const w of words) {
    const word_id = makeWordId(w)
    if (seen.has(word_id)) continue
    seen.add(word_id)
    candidates.push({
      word_id,
      word: w.word,
      book: w.book,
      ipa: w.ipa,
      definition_zh: w.definition_zh,
      pos: w.pos,
      layer: 'new',
      consecutive_correct: 0,
      srs_step: 0,
      in_wrong_pool: false,
      next_review: now + SRS_INTERVALS[0],
      added_at: now,
      updated_at: now,
      owner: 'guest',
    })
  }
  if (candidates.length === 0) return { added: 0, existed: 0 }
  const existing = await T.vocab.bulkGet(candidates.map((c) => c.word_id))
  const fresh = candidates.filter((_, i) => !existing[i])
  if (fresh.length > 0) {
    await T.vocab.bulkPut(fresh)
    for (const c of fresh) {
      await enqueueSync('vocab', c.word_id, 'upsert', c as unknown as Record<string, unknown>)
    }
  }
  return { added: fresh.length, existed: candidates.length - fresh.length }
}

export async function removeFromVocab(word_id: string): Promise<void> {
  await T.vocab.delete(word_id)
  const now = Date.now()
  await enqueueSync('vocab', word_id, 'delete', {
    word_id,
    owner: 'guest',
    updated_at: now,
    deleted_at: now,
  })
}

export async function isInVocab(word_id: string): Promise<boolean> {
  return (await T.vocab.get(word_id)) !== undefined
}

export async function getVocabByLayer(layer: LearnLayer): Promise<VocabEntry[]> {
  return T.vocab.whereIndex('layer', layer)
}

export async function getWrongPool(): Promise<VocabEntry[]> {
  const all = await T.vocab.toArray()
  return all.filter((v) => v.in_wrong_pool)
}

/**
 * 待复习队列：next_review<=now 且未掌握的词（生词 + 错题合并）。
 * 按 added_at 交错排序，使不同单词错落分布、避免连片疲劳（见 06 §4.2）。
 */
export async function getDueReviews(now = Date.now()): Promise<VocabEntry[]> {
  const all = await T.vocab.toArray()
  return all
    .filter((v) => v.next_review <= now && v.layer !== 'mastered')
    .sort((a, b) => a.added_at - b.added_at)
}

/**
 * 记录一次闯关作答，返回更新后的条目。
 * - 对：consecutive_correct+1、srs_step 步进、next_review 按间隔档推后；满 5 次按层晋级。
 * - 错：consecutive_correct 清零、srs_step 归零、进错题本、10min 后回流。
 */
export async function recordQuiz(
  word_id: string,
  correct: boolean,
  quiz_form: QuizForm,
): Promise<VocabEntry | null> {
  const e = await T.vocab.get(word_id)
  if (!e) return null
  const now = Date.now()
  const uid = uuid()
  const review = { word_id, at: now, correct, quiz_form, uid, owner: 'guest', updated_at: now }
  await T.reviewLog.add(review)
  if (correct) {
    e.consecutive_correct += 1
    e.srs_step = Math.min(e.srs_step + 1, SRS_INTERVALS.length - 1)
    e.next_review = now + SRS_INTERVALS[e.srs_step]
    e.in_wrong_pool = false
    if (e.layer === 'new' && e.consecutive_correct >= PASS_THRESHOLD) {
      e.layer = 'apply'
    } else if (e.layer === 'apply' && e.consecutive_correct >= PASS_THRESHOLD) {
      e.layer = 'mastered'
      e.mastered_at = now
    }
  } else {
    e.consecutive_correct = 0
    e.srs_step = 0
    e.next_review = now + SRS_INTERVALS[0]
    e.in_wrong_pool = true
  }
  e.last_quiz_form = quiz_form
  e.updated_at = now
  e.owner = e.owner ?? 'guest'
  await T.vocab.put(e)
  await enqueueSync('vocab', word_id, 'upsert', e as unknown as Record<string, unknown>)
  await enqueueSync('reviewLog', uid, 'upsert', review as unknown as Record<string, unknown>)
  return e
}

export async function getLayerCounts(): Promise<LayerCounts> {
  const all = await T.vocab.toArray()
  const now = Date.now()
  return {
    new: all.filter((v) => v.layer === 'new').length,
    apply: all.filter((v) => v.layer === 'apply').length,
    mastered: all.filter((v) => v.layer === 'mastered').length,
    wrong: all.filter((v) => v.in_wrong_pool).length,
    due: all.filter((v) => v.next_review <= now && v.layer !== 'mastered').length,
    total: all.length,
  }
}

/** human-readable 下次复习描述（10min/1h/1d…） */
export function nextReviewLabel(next_review: number, now = Date.now()): string {
  const diff = next_review - now
  if (diff <= 0) return '现在可复习'
  const min = Math.round(diff / 60_000)
  if (min < 60) return `${min} 分钟后`
  const hr = Math.round(diff / 3_600_000)
  if (hr < 24) return `${hr} 小时后`
  const day = Math.round(diff / 86_400_000)
  return `${day} 天后`
}

/* ------------------------------------------------------------------
 * 导入与阅读（见 06 §7）：素材本地保存，完全离线；长按选词 → addToVocab
 * ------------------------------------------------------------------ */

function todayStr(now = Date.now()): string {
  const d = new Date(now)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 素材体量。纯中文素材没有空格分词意义上的「词」，
 * 只数英文字母会让中文文章永远显示 0 —— 因此中文按**字**计入同一个口径：
 * 英文单词数 + 汉字数，展示时再按语言决定叫「词」还是「字」（见 Reader.unitLabel）。
 */
function countWords(text: string): number {
  const en = text.match(/[A-Za-z]+(?:['’\-][A-Za-z]+)*/g)?.length ?? 0
  const zh = text.match(/[\u4e00-\u9fa5]/g)?.length ?? 0
  return en + zh
}

/** 保存一篇导入素材；返回带 id 的记录。已存在同 id 则覆盖更新。 */
export async function saveReading(input: {
  title: string
  type: ReadingType
  content: string
  id?: string
  blob?: Blob
  media_type?: string
  ext?: string
  on_shelf?: boolean
  /** 章节目录（书籍解析所得） */
  chapters?: ReadingDoc['chapters']
  /** 初始页码（续读/覆盖保存时用） */
  last_page?: number
}): Promise<ReadingDoc> {
  const now = Date.now()
  const id = input.id ?? `r_${now}_${Math.random().toString(36).slice(2, 8)}`
  // 覆盖保存时保留原有的阅读进度 / 书架状态，避免重导入把进度清掉
  const prev = input.id ? await T.readings.get(id) : undefined
  const doc: ReadingDoc = {
    id,
    title: input.title.trim() || '未命名素材',
    type: input.type,
    content: input.content ?? '',
    word_count: countWords(input.content ?? ''),
    created_at: prev?.created_at ?? now,
    on_shelf: input.on_shelf ?? prev?.on_shelf,
    blob: input.blob,
    media_type: input.media_type,
    ext: input.ext,
    chapters: input.chapters ?? prev?.chapters,
    last_page: input.last_page ?? prev?.last_page ?? 0,
    last_read_at: prev?.last_read_at,
    pinned_at: prev?.pinned_at,
    booklists: prev?.booklists,
    bookmarks: prev?.bookmarks,
  }
  await T.readings.put(doc)
  return doc
}

export async function getReadings(): Promise<ReadingDoc[]> {
  const all = await T.readings.toArray()
  return all.sort((a, b) => b.created_at - a.created_at)
}

/** 书架排序键：最近阅读优先，没读过按加入时间 */
function shelfRecency(r: ReadingDoc): number {
  return r.last_read_at ?? r.created_at
}

/**
 * 书架排序（需求 3）：置顶的书整体在前（置顶属于同一类），
 * 组内都按「最近观看在前」倒序。
 */
function sortShelf(books: ReadingDoc[]): ReadingDoc[] {
  const byRecency = (a: ReadingDoc, b: ReadingDoc) => shelfRecency(b) - shelfRecency(a)
  const pinned = books.filter((b) => b.pinned_at !== undefined).sort(byRecency)
  const rest = books.filter((b) => b.pinned_at === undefined).sort(byRecency)
  return [...pinned, ...rest]
}

/** 书架上的书（on_shelf 且 type='book'），置顶在前 + 最近阅读倒序。 */
export async function getShelfBooks(): Promise<ReadingDoc[]> {
  const all = await T.readings.toArray()
  return sortShelf(all.filter((r) => r.type === 'book' && r.on_shelf))
}

/** 加入 / 移出书架 */
export async function setOnShelf(id: string, on_shelf: boolean): Promise<void> {
  const doc = await T.readings.get(id)
  if (!doc) return
  await T.readings.put({ ...doc, on_shelf })
}

/** 置顶 / 取消置顶（书架多选操作）；返回置顶后的新状态。 */
export async function toggleShelfPin(id: string, pinned: boolean): Promise<boolean> {
  const doc = await T.readings.get(id)
  if (!doc) return false
  const pinned_at = pinned ? Date.now() : undefined
  await T.readings.put({ ...doc, pinned_at })
  return pinned
}

/** 设置一本书所属的书单（全量覆盖，空数组 = 移出所有书单）。 */
export async function setDocBooklists(id: string, lists: string[]): Promise<void> {
  const doc = await T.readings.get(id)
  if (!doc) return
  const cleaned = [...new Set(lists.map((s) => s.trim()).filter(Boolean))]
  await T.readings.put({ ...doc, booklists: cleaned.length > 0 ? cleaned : undefined })
}

/** 全部书单名（从书架书收集，去重；按名字排序）。 */
export async function getAllBooklists(): Promise<string[]> {
  const all = await T.readings.toArray()
  const names = new Set<string>()
  for (const r of all) for (const l of r.booklists ?? []) names.add(l)
  return [...names].sort((a, b) => a.localeCompare(b, 'zh'))
}

/* ------------------------------------------------------------------
 * 书签（需求 6：顶部下拉添加，柳条展示，目录中跳转）
 * ------------------------------------------------------------------ */

/** 添加书签（同页已有书签则不重复加）；返回该书签或已存在的那个。 */
export async function addBookmark(
  docId: string,
  page: number,
  para: number,
): Promise<ReadingBookmark> {
  const doc = await T.readings.get(docId)
  if (!doc) throw new Error(`素材不存在：${docId}`)
  const existing = (doc.bookmarks ?? []).find((b) => b.page === page)
  if (existing) return existing
  const bm: ReadingBookmark = {
    id: `bm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    page,
    para,
    created_at: Date.now(),
  }
  await T.readings.put({ ...doc, bookmarks: [...(doc.bookmarks ?? []), bm] })
  return bm
}

/** 移除书签（再次下拉同一个已书签页 = 移除）。 */
export async function removeBookmark(docId: string, bookmarkId: string): Promise<void> {
  const doc = await T.readings.get(docId)
  if (!doc) return
  await T.readings.put({
    ...doc,
    bookmarks: (doc.bookmarks ?? []).filter((b) => b.id !== bookmarkId),
  })
}

/* ------------------------------------------------------------------
 * 阅读批注（需求 5：划线 + 想法，存 annotations 表）
 * ------------------------------------------------------------------ */

export async function getAnnotationsByDoc(docId: string): Promise<ReadingAnnotation[]> {
  const rows = await T.annotations.whereIndex('doc_id', docId)
  return rows.sort((a, b) => a.created_at - b.created_at)
}

/** 新增批注（划线或想法）。想法可携带它附着的划线信息。 */
export async function addAnnotation(input: {
  doc_id: string
  page: number
  para: number
  start: number
  end: number
  text: string
  kind: ReadingAnnotation['kind']
  style?: ReadingAnnotation['style']
  color?: ReadingAnnotation['color']
  thought?: string
}): Promise<ReadingAnnotation> {
  const now = Date.now()
  const row: ReadingAnnotation = {
    id: `an_${now}_${Math.random().toString(36).slice(2, 8)}`,
    ...input,
    created_at: now,
    updated_at: now,
  }
  await T.annotations.put(row)
  return row
}

/** 编辑批注（目前只有想法可改文字；划线可改样式/颜色）。 */
export async function updateAnnotation(
  id: string,
  patch: Partial<Pick<ReadingAnnotation, 'style' | 'color' | 'thought'>>,
): Promise<void> {
  const row = await T.annotations.get(id)
  if (!row) return
  await T.annotations.put({ ...row, ...patch, updated_at: Date.now() })
}

export async function deleteAnnotation(id: string): Promise<void> {
  await T.annotations.delete(id)
}

export async function getReading(id: string): Promise<ReadingDoc | undefined> {
  return T.readings.get(id)
}

export async function deleteReading(id: string): Promise<void> {
  await T.readings.delete(id)
  // 级联清理该素材的划线 / 想法（书签存在 doc 上，随 doc 一起消失）
  const anns = await T.annotations.whereIndex('doc_id', id)
  for (const a of anns) await T.annotations.delete(a.id)
}

/** 更新阅读进度（最后阅读时间 + 滚动位置） */
export async function updateReadingProgress(id: string, scroll_pos: number): Promise<void> {
  const doc = await T.readings.get(id)
  if (!doc) return
  await T.readings.put({ ...doc, last_read_at: Date.now(), scroll_pos })
}

/** 更新分页阅读进度（页码）：下次打开从该页继续 */
export async function updateReadingPage(id: string, page: number): Promise<void> {
  const doc = await T.readings.get(id)
  if (!doc) return
  await T.readings.put({ ...doc, last_read_at: Date.now(), last_page: page })
}

/** 累计当日阅读/听书时长（秒），用于个人中心可视化（06 §7.3） */
export async function addReadingTime(seconds: number): Promise<void> {
  if (seconds <= 0) return
  const date = todayStr()
  const row = await T.readingTime.get(date)
  if (row) {
    await T.readingTime.put({ date, total_seconds: row.total_seconds + seconds })
  } else {
    await T.readingTime.put({ date, total_seconds: seconds })
  }
}

export async function getTotalReadingSeconds(): Promise<number> {
  const all = await T.readingTime.toArray()
  return all.reduce((s, r) => s + r.total_seconds, 0)
}

/* ------------------------------------------------------------------
 * 诊断定级（见 01-PRD §5）
 * ------------------------------------------------------------------ */

/** 保存一次诊断结果；返回带 id 的行。 */
export async function saveDiagnoseResult(input: {
  correct: number
  total: number
  level: DiagnoseLevel
  start_book: string
}): Promise<DiagnoseRow> {
  const row: DiagnoseRow = { at: Date.now(), ...input }
  const id = await T.diagnose.add(row)
  return { ...row, id }
}

/** 最近一次诊断结果（用于个人中心展示当前等级）；无则 null。 */
export async function getLatestDiagnose(): Promise<DiagnoseRow | null> {
  const all = await T.diagnose.toArray()
  if (all.length === 0) return null
  return all.sort((a, b) => b.at - a.at)[0]
}

/* ------------------------------------------------------------------
 * 进度可视化（个人中心，见 04 §2.6 / 06 §7.3）
 * ------------------------------------------------------------------ */

function dateStr(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 近 N 日学习统计（含今日），缺失日补 0，保证图表等长。
 * 全部来自本地真实行为日志，无数据时为全 0（不编造）。
 */
export async function getDailyStats(days = 7): Promise<DailyStat[]> {
  const [logs, vocab, times] = await Promise.all([
    T.reviewLog.toArray(),
    T.vocab.toArray(),
    T.readingTime.toArray(),
  ])
  const out: DailyStat[] = []
  const today = new Date()
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i)
    const date = dateStr(d)
    out.push({
      date,
      reviews: logs.filter((l) => dateStr(new Date(l.at)) === date).length,
      mastered: vocab.filter((v) => v.mastered_at && dateStr(new Date(v.mastered_at)) === date)
        .length,
      readingSeconds: times.find((t) => t.date === date)?.total_seconds ?? 0,
    })
  }
  return out
}

/**
 * 近 N 个月统计（含本月），缺失月补 0。
 * 单次遍历分组（O(n)），避免年度视图按天遍历 365 次造成卡顿。
 */
export async function getMonthlyStats(months = 12): Promise<MonthlyStat[]> {
  const [logs, vocab] = await Promise.all([T.reviewLog.toArray(), T.vocab.toArray()])
  const buckets = new Map<string, MonthlyStat>()
  const now = new Date()
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const p = (n: number) => String(n).padStart(2, '0')
    buckets.set(`${d.getFullYear()}-${p(d.getMonth() + 1)}`, {
      month: `${d.getFullYear()}-${p(d.getMonth() + 1)}`,
      mastered: 0,
      reviews: 0,
    })
  }
  const monthKey = (t: number) => {
    const d = new Date(t)
    const p = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}`
  }
  for (const l of logs) {
    const b = buckets.get(monthKey(l.at))
    if (b) b.reviews += 1
  }
  for (const v of vocab) {
    if (!v.mastered_at) continue
    const b = buckets.get(monthKey(v.mastered_at))
    if (b) b.mastered += 1
  }
  return [...buckets.values()]
}

/**
 * 连续学习天数：有复习 / 加词 / 掌握 / 阅读任一种行为即算当日活跃。
 * 今日尚未活跃时不中断连续，从昨日回溯（常见的「当天还有机会」语义）。
 */
export async function getStreakDays(): Promise<number> {
  const [logs, vocab, times] = await Promise.all([
    T.reviewLog.toArray(),
    T.vocab.toArray(),
    T.readingTime.toArray(),
  ])
  const active = new Set<string>()
  for (const l of logs) active.add(dateStr(new Date(l.at)))
  for (const v of vocab) {
    active.add(dateStr(new Date(v.added_at)))
    if (v.mastered_at) active.add(dateStr(new Date(v.mastered_at)))
  }
  for (const t of times) if (t.total_seconds > 0) active.add(t.date)

  const cursor = new Date()
  if (!active.has(dateStr(cursor))) cursor.setDate(cursor.getDate() - 1)
  let streak = 0
  while (active.has(dateStr(cursor))) {
    streak += 1
    cursor.setDate(cursor.getDate() - 1)
  }
  return streak
}

/* ------------------------------------------------------------------
 * 默写进度（隐藏方式 + 已输入内容），退出后可继续
 * ------------------------------------------------------------------ */

/** 保存某素材的默写进度（就地覆盖写入） */
export async function saveDictationProgress(
  id: string,
  progress: Omit<DictationProgress, 'updated_at'>,
): Promise<void> {
  const doc = await T.readings.get(id)
  if (!doc) return
  await T.readings.put({ ...doc, dictation: { ...progress, updated_at: Date.now() } })
}

/** 清除默写进度（重新开始背诵时用） */
export async function clearDictationProgress(id: string): Promise<void> {
  const doc = await T.readings.get(id)
  if (!doc) return
  delete doc.dictation
  await T.readings.put(doc)
}

/* ------------------------------------------------------------------
 * 背诵录音（真实音频，自动归档到「我的-背诵」）
 * ------------------------------------------------------------------ */

/** 保存一条背诵录音；返回带 id 的记录。 */
export async function addRecitation(input: {
  blob: Blob
  duration_ms: number
  media_type: string
  title: string
  doc_id?: string
  doc_title?: string
  page?: number
}): Promise<Recitation> {
  const now = Date.now()
  const row: Recitation = {
    id: `rec_${now}_${Math.random().toString(36).slice(2, 8)}`,
    doc_id: input.doc_id,
    doc_title: input.doc_title,
    page: input.page,
    title: input.title,
    duration_ms: input.duration_ms,
    size: input.blob.size,
    media_type: input.media_type,
    created_at: now,
    blob: input.blob,
  }
  await T.recitations.put(row)
  return row
}

/** 全部背诵录音，按时间倒序。 */
export async function getRecitations(): Promise<Recitation[]> {
  const all = await T.recitations.toArray()
  return all.sort((a, b) => b.created_at - a.created_at)
}

/** 某素材（书 / 文章）的背诵录音，按时间倒序（阅读页内展示用）。 */
export async function getRecitationsByDoc(docId: string): Promise<Recitation[]> {
  const all = await T.recitations.whereIndex('doc_id', docId)
  return all.sort((a, b) => b.created_at - a.created_at)
}

export async function deleteRecitation(id: string): Promise<void> {
  await T.recitations.delete(id)
}

/** 累计背诵时长（毫秒），用于个人中心统计。 */
export async function getTotalRecitationMs(): Promise<number> {
  const all = await T.recitations.toArray()
  return all.reduce((s, r) => s + r.duration_ms, 0)
}

/* ------------------------------------------------------------------
 * 启动初始化
 * ------------------------------------------------------------------ */

/**
 * 打开底层存储（幂等）。main.tsx 在挂载前 await 一次，
 * 让首次写库的升级动作发生在渲染之前，避免首屏闪一下空状态。
 * 失败不阻断启动：打印告警，后续写入自行报错。
 */
export async function initStorage(): Promise<void> {
  try {
    await storage.open()
  } catch (err) {
    console.error('[storage] 打开本地数据库失败，学习数据可能无法保存', err)
  }
}
