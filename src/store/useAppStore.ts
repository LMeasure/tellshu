import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/**
 * 轻量应用状态（Phase 0 内存 + 设置持久化）
 * 落地边界（见 08 技术选型 §3.2）：
 *   - zustand persist 管：settings（深色模式 / 语速 / 口音 / 中文辅助）、UI 态。
 *   - 大数据实体（vocab / daily_plan / 等）Phase 1 落 Dexie，不在此处。
 */

export interface SettingsState {
  darkMode: boolean
  /** 音频语速：slow | normal */
  speed: 'slow' | 'normal'
  /** 发音口音：en-US | en-GB（预留） */
  accent: 'en-US' | 'en-GB'
  /** 中文辅助开关：关闭则不显示中文释义 */
  chineseAssist: boolean
  /**
   * 每轮学习 / 复习的单词数。改动后写入 persist，长期生效。
   * 学习流按此分批出卡，复习闯关按此限制本轮题量。
   */
  studyBatchSize: number
  /** 听书倍速（1 = 常速）；改动即存，长期生效。英文听书走浏览器默认，不受它影响 */
  speechRate: number
  /**
   * 需求【5】双击句子重读时，读完这一句之后怎么办：
   *   continue —— 继续往下读（默认）
   *   single   —— 只读这一句，读完就停
   */
  replayScope: 'continue' | 'single'
  /**
   * 听书定时关闭分钟数（V2.0 阅读器设置·听书面板）：0 = 关，其余为倒计时分钟。
   * 每次开始听书按这个值起算；到点自动停止听书。持久化（下次进来自动沿用）。
   */
  speechTimerMin: number
  /** 听书「本集结束后关闭」：勾选后读完当前章（素材）即停止，与定时关闭互不冲突 */
  speechStopAtEnd: boolean
  /**
   * 阅读器排版与翻页偏好（2026-10-07 需求 4）：设置面板改的是这套，
   * 持久化后跨会话生效。theme / brightness 只影响阅读器，不碰全局深色模式。
   */
  readerPrefs: ReaderPrefs
}

/** 阅读器偏好（需求 4 设置面板的全部可调项） */
export interface ReaderPrefs {
  /** 正文字号 px（14–26） */
  fontSize: number
  /** 行距倍数（1.5–2.6） */
  lineHeight: number
  /** 页面左右边距档位 */
  margin: 'sm' | 'md' | 'lg'
  /** 字体：楷体 / 黑体（系统无衬线）/ 宋体（衬线） */
  fontFamily: 'kai' | 'sans' | 'serif'
  /** 段落首行缩进两字 */
  indent: boolean
  /** 翻页方式：滑动平滑 / 仿书本 / 上下滚动 / 覆盖翻页 */
  pageMode: 'slide' | 'book' | 'scroll' | 'cover'
  /** 阅读主题：纯白 / 羊皮 / 护眼 / 夜间（颜色背景面板） */
  theme: 'white' | 'sepia' | 'green' | 'dark'
  /** 亮度 0.4–1（1 = 不变暗） */
  brightness: number
}

export const DEFAULT_READER_PREFS: ReaderPrefs = {
  fontSize: 17,
  lineHeight: 2,
  margin: 'md',
  fontFamily: 'sans',
  indent: false,
  pageMode: 'slide',
  theme: 'white',
  brightness: 1,
}

/** 字号范围与步长（设置面板滑杆用） */
export const READER_FONT_SIZE = { min: 14, max: 26, step: 1 }
/** 行距范围与步长 */
export const READER_LINE_HEIGHT = { min: 1.5, max: 2.6, step: 0.1 }
/** 亮度范围 */
export const READER_BRIGHTNESS = { min: 0.4, max: 1, step: 0.05 }

/** 每轮词数可选项（设置页展示；取值即存、无需确认） */
export const BATCH_SIZE_OPTIONS = [5, 10, 20, 30, 50]
export const DEFAULT_BATCH_SIZE = 10

/** 听书倍速可选项 */
export const SPEECH_RATE_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2]
export const DEFAULT_SPEECH_RATE = 1

/** 双击句子重读后的行为（需求【5】） */
export const REPLAY_SCOPE_OPTIONS: { v: SettingsState['replayScope']; label: string }[] = [
  { v: 'continue', label: '继续往下读' },
  { v: 'single', label: '只读这一句' },
]
export const DEFAULT_REPLAY_SCOPE: SettingsState['replayScope'] = 'continue'

/**
 * 听书定时关闭可选项（分钟；0 = 关）。刻度为大档位，
 * 与设计图一致：关 / 30 / 60 / 90 标注，15 / 45 为小刻度。
 */
export const SPEECH_TIMER_OPTIONS = [0, 15, 30, 45, 60, 90] as const
/** 带文字标注的刻度（其余为无字小刻度） */
export const SPEECH_TIMER_LABELS = new Set([0, 30, 60, 90])
export const DEFAULT_SPEECH_TIMER_MIN = 0
export const DEFAULT_SPEECH_STOP_AT_END = false

/**
 * 单词详情页的 UI 态（需求 9）。
 * 放在 persist 里而不是组件内 useState，是为了「切到别的页再回来」时状态还在
 * （React Router 没有 keep-alive，组件卸载即丢）。
 * scores 按 `word#index` 存，换词不串分。
 */
export interface WordDetailUi {
  /** 当前查看的词（小写），用于判断恢复的状态属不属于这次的词 */
  word: string
  /** 选中的词性分组下标（0 起；-1 = 未选/全部） */
  posIndex: number
  /** 顶部搜索框内容 */
  query: string
  /** 各例句的跟读评分：key = `${word}#${index}` */
  scores: Record<string, number>
  /** 同 key：true = 真实识别分，false = 模拟分（UI 必须标注，不能混为一谈） */
  scoreReal: Record<string, boolean>
}

export const DEFAULT_WORD_DETAIL_UI: WordDetailUi = {
  word: '',
  posIndex: -1,
  query: '',
  scores: {},
  scoreReal: {},
}

/** 评分记录上限，防止长期累积无界增长 */
const MAX_SCORE_ENTRIES = 200

interface AppState {
  settings: SettingsState
  isGuest: boolean
  wordDetail: WordDetailUi
  toggleDarkMode: () => void
  setSetting: <K extends keyof SettingsState>(key: K, value: SettingsState[K]) => void
  setGuest: (v: boolean) => void
  /** 切换当前查看的词：词变了就重置视图态，评分保留（切回来还要看） */
  enterWordDetail: (word: string) => void
  setWordDetailPos: (index: number) => void
  setWordDetailQuery: (q: string) => void
  setExampleScore: (key: string, score: number, real: boolean) => void
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      settings: {
        darkMode: false,
        speed: 'normal',
        accent: 'en-US',
        chineseAssist: true,
        studyBatchSize: DEFAULT_BATCH_SIZE,
        speechRate: DEFAULT_SPEECH_RATE,
        replayScope: DEFAULT_REPLAY_SCOPE,
        speechTimerMin: DEFAULT_SPEECH_TIMER_MIN,
        speechStopAtEnd: DEFAULT_SPEECH_STOP_AT_END,
        readerPrefs: { ...DEFAULT_READER_PREFS },
      },
      isGuest: false,
      wordDetail: { ...DEFAULT_WORD_DETAIL_UI },
      toggleDarkMode: () =>
        set((s) => ({ settings: { ...s.settings, darkMode: !s.settings.darkMode } })),
      setSetting: (key, value) =>
        set((s) => ({ settings: { ...s.settings, [key]: value } })),
      setGuest: (v) => set({ isGuest: v }),
      enterWordDetail: (word) =>
        set((s) => {
          const w = word.trim().toLowerCase()
          if (s.wordDetail.word === w) return s
          // 换词：视图态归零，评分留下（切回来还要看上一次的成绩）
          return {
            wordDetail: {
              word: w,
              posIndex: -1,
              query: '',
              scores: s.wordDetail.scores,
              scoreReal: s.wordDetail.scoreReal,
            },
          }
        }),
      setWordDetailPos: (index) =>
        set((s) => ({ wordDetail: { ...s.wordDetail, posIndex: index } })),
      setWordDetailQuery: (q) => set((s) => ({ wordDetail: { ...s.wordDetail, query: q } })),
      setExampleScore: (key, score, real) =>
        set((s) => {
          const next = { ...s.wordDetail.scores, [key]: score }
          const nextReal = { ...s.wordDetail.scoreReal, [key]: real }
          // 超限就丢掉最早写入的若干条（对象键顺序即插入顺序）
          const keys = Object.keys(next)
          if (keys.length > MAX_SCORE_ENTRIES) {
            for (const k of keys.slice(0, keys.length - MAX_SCORE_ENTRIES)) {
              delete next[k]
              delete nextReal[k]
            }
          }
          return { wordDetail: { ...s.wordDetail, scores: next, scoreReal: nextReal } }
        }),
    }),
    {
      name: 'shushu-settings',
      partialize: (s) => ({
        settings: s.settings,
        isGuest: s.isGuest,
        wordDetail: s.wordDetail,
      }),
      // 深合并 settings：老存档缺新字段（如 studyBatchSize）时自动补默认值，
      // 否则升级用户会读到 undefined。
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<AppState>
        return {
          ...current,
          ...p,
          settings: {
            ...current.settings,
            ...(p.settings ?? {}),
            // readerPrefs 深合并：老存档缺新字段（如 pageMode）补默认值
            readerPrefs: {
              ...current.settings.readerPrefs,
              ...(p.settings?.readerPrefs ?? {}),
            },
          },
          wordDetail: { ...current.wordDetail, ...(p.wordDetail ?? {}) },
        }
      },
    },
  ),
)
