/**
 * 数据契约（Type Contract）
 * ------------------------------------------------------------------
 * 这些类型描述「述树」需要的数据形状，**不是数据本身**。
 * 真实内容来自 Linguabase 下载包（见 04-页面清单 附录 A / 06-数据模型）。
 * Phase 0 不注入任何假数据：页面接到空数据即渲染设计好的空状态。
 *
 * 字段命名对齐 Linguabase 下载包；缺失字段由前端静默降级（见 04 附录 A）。
 */

/** 难度等级：1=字母识别级，2=基础词汇级，3=简单句型级（诊断抽题梯度） */
export type DifficultyLevel = 1 | 2 | 3

/** 词本标识（对应 OpenEtymology 五个词本） */
export type BookId = 'CET4' | 'CET6' | 'TEM8' | 'TOEFL' | 'GRE8000'

/** 词本元数据（来自 index.json，首屏仅加载此 ~1KB 索引） */
export interface BookMeta {
  id: BookId
  name: string
  count: number
  difficulty_level: DifficultyLevel
  /** 相对 data/linguabase/ 的路径，如 books/CET4.json */
  file: string
}

/** 词包分片索引（index.json 形状） */
export interface WordBundleIndex {
  total: number
  generated_at: string
  source: string
  attribution: string
  license: string
  books: BookMeta[]
}

/** 内容主题节点（路径节点 / 课程组成单元） */
export interface ContentTopic {
  id: string
  title: string
  description?: string
  difficulty_level: DifficultyLevel
  /** 节点类型：字母 / 音标 / 词汇 / 句型 / 对话 */
  type: 'letter' | 'phoneme' | 'vocab' | 'pattern' | 'dialogue'
}

/** 字母 / 音标卡源数据 */
export interface ContentLetter {
  id: string
  char: string
  ipa?: string
  audio_path?: string
}

/** 单词卡源数据（Linguabase 字段映射见 04 附录 A） */
export interface ContentWord {
  id: string
  word: string
  ipa?: string
  /** 中文释义（缺失则降级显示英文释义） */
  definition_zh?: string
  definition_en?: string
  /** 例句（缺失则隐藏例句折叠区） */
  example_en?: string
  example_zh?: string
  /** 发音音频路径（缺失则用 Web Speech API 实时合成，不伪造） */
  audio_path?: string
  /** 助记提示（可选；仅当可简单拆分帮助记忆时展示） */
  word_hint?: string
  /** 词根 / 构词素，用于掌握层「同根聚合」 */
  root?: string
  /** 词性（如 vt./n./adj.），取自首个释义 */
  pos?: string
  /** 词根词缀拆解（OpenEtymology 真实字段） */
  morphemes?: { form: string; meaning: string; note?: string }[]
  /** 词源段落（OpenEtymology 真实字段） */
  etymology?: string
  /** 全部双语例句 */
  examples?: { en: string; zh: string }[]
  /** 所属词本（CET4/CET6/TEM8/TOEFL/GRE8000），用于课程/路径分组 */
  book?: string
  /** Linguabase 关联词（裁剪到 core 内；缺失则隐藏） */
  related?: string[]
  /** Linguabase 反义词（term:rating，rating 1-7）；缺失则隐藏 */
  antonyms?: { term: string; rating: number }[]
  /** Linguabase 同根/词族词（裁剪到 core 内）；缺失则隐藏 */
  relatives?: string[]
  difficulty_level: DifficultyLevel
  /**
   * 词频排名，越小越常用，与 difficulty_level 共同决定卡片排序。
   * ⚠️ 已用 Linguabase 真实信号修正：核心词 = 真实 core_rank(1..400000)；
   * 非核心词 = 基于 familiarity_score 的合成秩(400001..500000)。
   * 旧值实为词本内字母序下标，已废弃。
   */
  frequency_rank?: number
  /** Linguabase：是否在 40 万核心词内（真实标注） */
  in_core?: boolean
  /** Linguabase：核心词内排名 1..400000；非核心为 null（真实标注） */
  core_rank?: number | null
  /** Linguabase：熟悉度 0..1（可能为 null），越大越常用（真实标注） */
  familiarity_score?: number | null
  /** Linguabase 义项标签（一词多义消歧），如 bank → [finance, riverbank]（真实） */
  senses?: string[]
  /** Linguabase 内容分级 G/PG/PG-13/R/X/NR（真实，可用于少儿过滤） */
  content_rating?: string
  /** Linguabase 适童度 1..5（5=最适合儿童），用于少儿过滤（真实） */
  kid_appropriate?: number
  /** Linguabase 具体度 1..5（5=更具体），用于选词（真实） */
  concreteness?: number
  topic_id: string
}

/* ------------------------------------------------------------------
 * 全量词库层（Linguabase 198 万词）
 * 组织方式：**主题（一级） + 难度（二级）**
 *   themes/ 45 个日常主题（动物/食物/颜色…）
 *   bank/   未归入主题的词，按真实词频分 L1 基础 / L2 进阶 / L3 长尾
 *   defs/   英文释义，按分片懒加载（体积大，绝不随首屏加载）
 * ---------------------------------------------------------------- */

/** 紧凑词条元组：[word, 难度档, 真实 rank] —— 为控制体积刻意用数组而非对象 */
export type LinguaWordTuple = [string, DifficultyLevel, number]

/** 一级分类：日常主题 */
export interface LinguaTheme {
  id: string
  /** Linguabase category 原名（英文） */
  name: string
  /** 中文主题名 */
  name_zh: string
  count: number
  /** 相对 data/linguabase/ 的路径 */
  file: string
  levels: { level: DifficultyLevel; count: number }[]
}

/** 二级分类：通用词库难度档 */
export interface LinguaBankLevel {
  id: string
  level: DifficultyLevel
  label: string
  count: number
  file: string
}

/** 句型卡源数据 */
export interface ContentPattern {
  id: string
  pattern: string
  structure_note?: string
  sample_sentences: string[]
  topic_id: string
}

/** 诊断题源数据（按 difficulty_level 分梯度抽取） */
export interface ContentDiagnostic {
  id: string
  difficulty_level: DifficultyLevel
  question: string
  options: string[]
  answer: string
  topic_id?: string
}

/** 课程 / 词单（发现页卡片流） */
export interface ContentCourse {
  id: string
  title: string
  subtitle?: string
  cover?: string
  tags: string[]
  difficulty_level: DifficultyLevel
  scene?: string
  duration_min?: number
  skill?: string
  topic_ids: string[]
}

/** 知识卡渲染区的一张卡片（学习流程内，Linguabase 驱动，无视频） */
export type KnowledgeCard =
  | { kind: 'letter'; data: ContentLetter }
  | { kind: 'word'; data: ContentWord }
  | { kind: 'pattern'; data: ContentPattern }

/* ------------------------------------------------------------------
 * 领域状态（Phase 0 仅内存态；Phase 1 起落 Dexie）
 * 这里仅声明契约，暂不实现持久化。
 * ------------------------------------------------------------------ */
export type LearnLayer = 'new' | 'practice' | 'apply' | 'mastered'

export interface DailyTaskItem {
  id: string
  topic_id: string
  title: string
  done: boolean
}

export interface DailyPlan {
  id: string
  date: string
  items: DailyTaskItem[]
  completion_pct: number
}

export interface DiagnoseResult {
  id: string
  date: string
  level: DifficultyLevel
  start_topic_id: string
}

export type QuizForm = 'choose-meaning' | 'dictation' | 'spelling'
