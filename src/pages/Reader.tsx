import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  Volume2,
  Star,
  Check,
  Headphones,
  Square,
  BookOpen,
  ArrowLeft,
  Mic,
  Play,
  Pause,
  Trash2,
  Eye,
  EyeOff,
  Lock,
  KeyRound,
  Pencil,
} from 'lucide-react'
import { IconReset, IconBroom } from '@/components/icons/shushu'
import { EmptyState } from '@/components/ui/empty-state'
import { Sheet } from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Dialog } from '@/components/ui/dialog'
import { InlineDictation } from '@/components/learning/InlineDictation'
import { PageFlipContainer, type PageFlipHandle } from '@/components/reader/PageFlipContainer'
import { ReaderControlCenter, type PanelTab } from '@/components/reader/ReaderControlCenter'
import { NoteDetail } from '@/components/reader/NotesSheet'
import { SelectionPopup, FEEDBACK_MAILTO } from '@/components/reader/SelectionPopup'
import { BookmarkRibbon } from '@/components/reader/BookmarkRibbon'
import { captureSelection, clearSelection, type CapturedSelection } from '@/components/reader/selectionCapture'
import { annotationCss, splitByRanges } from '@/lib/annotate'
import { useMediaAudio } from '@/hooks/useMediaAudio'
import { cn } from '@/lib/utils'
import { speakFocused, cancelSpeech, isSpeechSupported, isWeChatBrowser } from '@/lib/speech'
import { audioBus, splitSentences } from '@/lib/audioBus'
import { ListenSession, type ListenUnit } from '@/lib/listenSession'
import {
  buildListenUnits,
  firstUnitIndexOfSentence,
  lastUnitIndexOfSentence,
} from '@/lib/listenPlan'
import { analyzeSentence, type GrammarAnalysis } from '@/lib/grammar'
import { detectBilingual, detectLanguage, type LangKind } from '@/lib/textLang'
import { createRecorderSession, isRecordingSupported, fmtDuration, recitationTitle } from '@/lib/recorder'
import type { RecordingSession } from '@/services/recording'
import { paginate } from '@/lib/paging'
import { packByHeight, paraToPageMap, wholeParaPages, type FitPage } from '@/lib/fitPaging'
import {
  DEFAULT_MASK_CONFIG,
  buildMaskPlan,
  collectSlots,
  dictationStats,
  inlineState,
  slotKey,
  tokenize,
  type MaskConfig,
} from '@/lib/masking'
import { lookupWord } from '@/data/repository'
import {
  addToVocab,
  isInVocab,
  updateReadingPage,
  addReadingTime,
  addDictationTime,
  getReading,
  saveDictationProgress,
  getRecitationsByDoc,
  addRecitation,
  deleteRecitation,
  addBookmark,
  removeBookmark,
  getAnnotationsByDoc,
  addAnnotation,
  updateAnnotation,
  deleteAnnotation,
  type Recitation,
  type ReadingAnnotation,
  type ReadingDoc,
} from '@/domain/learning'
import { useAppStore, type ReaderPrefs } from '@/store/useAppStore'
import type { AnnotationColor, AnnotationStyle } from '@/domain/types'
import type { ContentWord } from '@/data/types'

/**
 * 阅读器 V3.0（2026-10-09 需求梳理）
 * ------------------------------------------------------------------
 * 【综合控制中心】底部弹窗 = 5 项导航（目录 / 笔记 / 进度 / 听书 / 设置）：
 *   单击正文 Toggle 呼出/隐藏；点面板外关闭；面板内部 stopPropagation 防误触。
 *   单击同时强制清除选区；长按才触发划词（时间/位移阈值隔离，见 PageFlipContainer）。
 * 【一页即一屏】按**真实渲染高度**分页（lib/fitPaging），页面层固定高度、不滚动，
 *   只左右滑动；超长段落按行拆成片段跨页，坐标仍以「整段」为准（selectionCapture）。
 * 【翻页方式】平滑（三页连排跟手）/ 覆盖（整页盖上，不透明底 + z-index 分层，修重叠 Bug）/
 *   仿书本 / 上下滚动。
 * 【笔记】虚线（dashed）标识；点虚线文字弹「笔记详情」（可编辑/删除，标注来源）。
 * 【进度】极简 UI：— ◯ —，可输入页码跳转、拖动圆点快速翻页。
 * 【听书】独立 Tab：播放/暂停、语速、刻度定时关闭、本集结束后关闭。
 */
type Mode = 'read' | 'memo'
type Sel = {
  word: string
  info: ContentWord | null
  added: boolean
  grammar: GrammarAnalysis | null
  grammarLoading: boolean
}

const LANG_LABEL: Record<LangKind, string> = {
  zh: '中文',
  en: '英文',
  mixed: '中英混排',
}

function unitLabel(lang: LangKind, n: number): string {
  return `${n} ${lang === 'zh' ? '字' : lang === 'en' ? '词' : '字词'}`
}

const FONT_STACKS: Record<ReaderPrefs['fontFamily'], string> = {
  kai: '"Kaiti SC", KaiTi, STKaiti, "Noto Serif SC", serif',
  sans: 'system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif',
  serif: '"Songti SC", SimSun, "Noto Serif SC", Georgia, serif',
}

const MARGIN_CLASS: Record<ReaderPrefs['margin'], string> = {
  sm: 'px-4',
  md: 'px-6',
  lg: 'px-8',
}

/** 边距档位对应的左右内边距（px），与 MARGIN_CLASS 保持一致（测量分页用） */
const MARGIN_PX: Record<ReaderPrefs['margin'], number> = { sm: 16, md: 24, lg: 32 }

/** 正文上下内边距合计（pt-4 + pb-8 = 16 + 32） */
const PAGE_PAD_Y = 48
/** 分页安全余量：避免亚像素/字体度量误差导致最后一行被裁掉（需求 5：严禁截断） */
/** 一页一屏：上下内边距之外再加一整行的安全余量——末行测高偏差/浏览器底栏都吃在这里 */
const PAGE_SAFETY = 40
/** 底部导航栏高度（h-14 = 56px）：分页预算预留，严防导航栏弹出时遮挡末行文字 */
const NAV_RESERVE = 56
/** 首行缩进宽度（与 tailwind indent-8 = 2rem 一致） */
const INDENT_PX = 32

function IconAction({
  label,
  onClick,
  active = false,
  children,
}: {
  label: string
  onClick: () => void
  active?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        'flex h-9 w-9 items-center justify-center rounded-lg transition-colors touch-target',
        active ? 'bg-accent text-accent-foreground' : 'bg-secondary text-secondary-foreground hover:bg-muted',
      )}
    >
      {children}
    </button>
  )
}

function MemoTimer({
  running,
  seconds,
  onToggle,
}: {
  running: boolean
  seconds: number
  onToggle: () => void
}) {
  return (
    <button
      onClick={onToggle}
      aria-label={running ? '暂停计时' : '开始计时'}
      className={cn(
        'flex h-9 items-center gap-2 rounded-lg px-3 text-sm font-medium transition-colors touch-target',
        running ? 'bg-accent text-accent-foreground' : 'bg-primary text-primary-foreground',
      )}
    >
      {running ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
      <span className="font-mono text-base tabular-nums">{fmtDuration(seconds * 1000)}</span>
    </button>
  )
}

export function Reader() {
  const { id } = useParams()
  const navigate = useNavigate()
  const rootRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLDivElement>(null)
  const flipRef = useRef<PageFlipHandle>(null)

  const speechRate = useAppStore((s) => s.settings.speechRate)
  const speechTimerMin = useAppStore((s) => s.settings.speechTimerMin)
  const speechStopAtEnd = useAppStore((s) => s.settings.speechStopAtEnd)
  const replayScope = useAppStore((s) => s.settings.replayScope)
  const setSetting = useAppStore((s) => s.setSetting)
  const prefs = useAppStore((s) => s.settings.readerPrefs)
  const setPrefs = useCallback(
    (patch: Partial<ReaderPrefs>) => {
      setSetting('readerPrefs', { ...prefs, ...patch })
    },
    [prefs, setSetting],
  )

  const [doc, setDoc] = useState<ReadingDoc | null | undefined>(undefined)
  const [listening, setListening] = useState(false)
  const [paused, setPaused] = useState(false)
  const [resumeIdx, setResumeIdx] = useState<number | null>(null)
  const resumeRef = useRef<number | null>(null)
  const setResume = useCallback((i: number | null) => {
    resumeRef.current = i
    setResumeIdx(i)
  }, [])

  const sessionRef = useRef<ListenSession | null>(null)
  const listenRef = useRef(false)
  const rateRef = useRef(speechRate)
  rateRef.current = speechRate
  const scopeRef = useRef(replayScope)
  scopeRef.current = replayScope
  const timerMinRef = useRef(speechTimerMin)
  timerMinRef.current = speechTimerMin
  const stopAtEndRef = useRef(speechStopAtEnd)
  stopAtEndRef.current = speechStopAtEnd
  const pendingAdvanceRef = useRef(false)
  const pauseRemainRef = useRef<number | null>(null)
  const wechatWarnedRef = useRef(false)

  const [page, setPage] = useState(0)
  const [mode, setMode] = useState<Mode>('read')
  /** 综合控制中心：null = 关闭 */
  const [panelTab, setPanelTab] = useState<PanelTab | null>(null)
  const [navOpen, setNavOpen] = useState(false)
  const [remainingSec, setRemainingSec] = useState<number | null>(null)
  /** 点击正文虚线笔记标识弹出的详情卡 */
  const [noteDetail, setNoteDetail] = useState<ReadingAnnotation | null>(null)

  const [sel, setSel] = useState<Sel | null>(null)

  /* ---------------- 划词与批注 ---------------- */
  const [popup, setPopup] = useState<CapturedSelection | null>(null)
  const holdPopupRef = useRef(false)
  const thoughtTargetRef = useRef<CapturedSelection | null>(null)
  const [annotations, setAnnotations] = useState<ReadingAnnotation[] | null>(null)
  const [thoughtOpen, setThoughtOpen] = useState(false)
  const [thoughtText, setThoughtText] = useState('')
  const [toast, setToast] = useState('')
  const lastStyleRef = useRef<AnnotationStyle>('highlight')
  const lastColorRef = useRef<AnnotationColor>('yellow')
  /** 本次划词已创建过批注的 span key → annotation id，避免连续换色/线型时重复新建 */
  const annotatedKeysRef = useRef<Map<string, string>>(new Map())
  const pullStartRef = useRef<{ y: number; inTop: boolean } | null>(null)
  const [ribbonAnim, setRibbonAnim] = useState(false)

  /* ---------------- 默写状态 ---------------- */
  const [maskConfig, setMaskConfig] = useState<MaskConfig>(DEFAULT_MASK_CONFIG)
  const [manualKeys, setManualKeys] = useState<string[]>([])
  const [seed, setSeed] = useState(1)
  const [selecting, setSelecting] = useState(false)
  const [showCompare, setShowCompare] = useState(false)
  const [values, setValues] = useState<Record<string, string>>({})
  const [memoRunning, setMemoRunning] = useState(false)
  const [memoSeconds, setMemoSeconds] = useState(0)
  /** 睁眼：临时显示被隐藏的单词；闭眼（默认）正常默写 */
  const [revealHidden, setRevealHidden] = useState(false)
  const progressLoadedRef = useRef(false)

  /* ---------------- 录音状态 ---------------- */
  const recorderRef = useRef<RecordingSession | null>(null)
  const [recording, setRecording] = useState(false)
  const [recSeconds, setRecSeconds] = useState(0)
  const [recs, setRecs] = useState<Recitation[]>([])
  const [recError, setRecError] = useState('')

  /* ---------------- 分页（按真实高度） ---------------- */
  const paragraphs = useMemo(
    () =>
      (doc?.content ?? '')
        .split(/\n+/)
        .map((s) => s.trim())
        .filter(Boolean),
    [doc?.content],
  )

  const [avail, setAvail] = useState({ w: 0, h: 0 })
  const [fitPages, setFitPages] = useState<FitPage[] | null>(null)
  /** 字体加载完成后再重测一次分页：避免系统字体未就绪导致测量偏低、整页溢出被裁（需求 5） */
  const [fontsReady, setFontsReady] = useState(false)
  useEffect(() => {
    let alive = true
    if (typeof document !== 'undefined' && 'fonts' in document) {
      document.fonts.ready.then(() => {
        if (alive) setFontsReady(true)
      })
    } else {
      setFontsReady(true)
    }
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    if (!id) return
    getReading(id).then(setDoc)
  }, [id])

  const loadAnnotations = useCallback(() => {
    if (!id) return
    getAnnotationsByDoc(id).then(setAnnotations).catch(() => setAnnotations([]))
  }, [id])

  useEffect(() => {
    loadAnnotations()
  }, [loadAnnotations])

  function showToast(msg: string) {
    setToast(msg)
    window.setTimeout(() => setToast(''), 2000)
  }

  const docLang: LangKind = useMemo(() => detectLanguage(doc?.content ?? ''), [doc?.content])

  // 观察内容区尺寸（标题栏恒定存在，尺寸稳定）
  useLayoutEffect(() => {
    const el = stageRef.current
    if (!el) return
    const read = () => setAvail({ w: el.clientWidth, h: el.clientHeight })
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // 按真实高度分页：测量探针与正文同字号/行距/字体/宽度（字体就绪后重测一次）
  useLayoutEffect(() => {
    const probe = measureRef.current
    const stage = stageRef.current
    if (!probe || !stage || avail.w <= 0 || avail.h <= 0 || paragraphs.length === 0) {
      setFitPages(null)
      return
    }
    const padX = MARGIN_PX[prefs.margin]
    const contentW = Math.max(80, avail.w - padX * 2)
    // 一页一屏：总可用高度扣除上下内边距 + 安全余量 + 底部导航栏高度
    // （导航栏为 fixed 浮层，弹出时会盖住底部，故分页末行必须预留其高度，严禁被遮挡/截断）
    const pageH = Math.max(60, avail.h - PAGE_PAD_Y - PAGE_SAFETY - NAV_RESERVE)
    probe.style.width = `${contentW}px`
    probe.style.fontSize = `${prefs.fontSize}px`
    probe.style.lineHeight = String(prefs.lineHeight)
    probe.style.fontFamily = FONT_STACKS[prefs.fontFamily]
    const heightOf = (para: number, start: number, end: number) => {
      probe.style.textIndent = prefs.indent && start === 0 ? `${INDENT_PX}px` : '0'
      // 必须测量**真实渲染出来的字符串**：正文按分句渲染、句间以一个空格拼接
      const raw = (paragraphs[para] ?? '').slice(start, end)
      probe.textContent = `${splitSentences(raw, { crossLanguage: true }).join(' ')} `
      return probe.offsetHeight
    }
    const pages = packByHeight(paragraphs, heightOf, pageH)
    probe.textContent = ''
    setFitPages(pages)
  }, [
    paragraphs,
    prefs.fontSize,
    prefs.lineHeight,
    prefs.margin,
    prefs.fontFamily,
    prefs.indent,
    avail.w,
    avail.h,
    fontsReady,
  ])

  // 测量未就绪时的兜底：字符预算分页（整段不拆）
  const fallbackPages = useMemo<FitPage[]>(
    () => wholeParaPages(paragraphs, paginate(paragraphs)),
    [paragraphs],
  )
  const pages = fitPages && fitPages.length > 0 ? fitPages : fallbackPages
  const pageCount = pages.length

  /** 段落下标 → 页下标 */
  const paraPage = useMemo(() => paraToPageMap(pages, paragraphs.length), [pages, paragraphs.length])

  /** 当前页的段落下标（有序去重） */
  const pageParas = useMemo(() => {
    const pg = pages[page]
    if (!pg) return [] as number[]
    const seen = new Set<number>()
    const out: number[] = []
    for (const f of pg.frags) {
      if (!seen.has(f.para)) {
        seen.add(f.para)
        out.push(f.para)
      }
    }
    return out
  }, [pages, page])

  const pageParagraphs = useMemo(() => pageParas.map((p) => paragraphs[p] ?? ''), [pageParas, paragraphs])
  const basePara = pageParas[0] ?? 0
  const lastPara = pageParas[pageParas.length - 1] ?? 0

  /** 阅读位置锚定：重新分页后停在原来的段落，不跳页 */
  const anchorRef = useRef<number | undefined>(undefined)
  const anchorInitRef = useRef(false)
  // ① 重新分页后：用「上一次提交记录的首段」锚回原位置（声明在②之前，先读到旧锚）
  useEffect(() => {
    if (!anchorInitRef.current) {
      anchorInitRef.current = true
      return
    }
    const a = anchorRef.current
    if (a === undefined) return
    setPage(paraPage[a] ?? 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages])
  // ② 记录当前页首段（供①锚定用）
  useEffect(() => {
    anchorRef.current = pageParas[0]
  }, [pageParas])

  const restoredForRef = useRef<string | null>(null)
  useEffect(() => {
    if (!doc || paragraphs.length === 0) return
    if (restoredForRef.current === doc.id) return
    restoredForRef.current = doc.id
    setPage(Math.min(Math.max(doc.last_page ?? 0, 0), Math.max(0, pages.length - 1)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc?.id, paragraphs.length, pages.length])

  useEffect(() => {
    if (!doc) return
    updateReadingPage(doc.id, page)
  }, [doc?.id, page])

  useEffect(() => {
    if (!doc) return
    const tick = window.setInterval(() => {
      if (!listenRef.current && document.visibilityState === 'visible' && mode === 'read') {
        addReadingTime(15)
      }
    }, 15_000)
    return () => window.clearInterval(tick)
  }, [doc, mode])

  // 默写时长：学习时间的「默写」子分支。计时器运行中（点锁自动开始/输入框聚焦自动续走）
  // 且处于记忆模式时按 15s 心跳入账，与阅读时长同表分列、互不混算。
  useEffect(() => {
    if (!doc) return
    const tick = window.setInterval(() => {
      if (memoRunning && document.visibilityState === 'visible' && mode !== 'read') {
        addDictationTime(15)
      }
    }, 15_000)
    return () => window.clearInterval(tick)
  }, [doc, memoRunning, mode])

  /* ---------------- 恢复 / 保存默写进度 ---------------- */
  useEffect(() => {
    if (!doc || progressLoadedRef.current) return
    progressLoadedRef.current = true
    const p = doc.dictation
    if (!p) return
    setMaskConfig({
      mode: p.mode ?? DEFAULT_MASK_CONFIG.mode,
      ratio: p.ratio ?? DEFAULT_MASK_CONFIG.ratio,
      hidePunctuation: p.hidePunctuation ?? false,
      target: p.target ?? 'all',
    })
    setManualKeys(p.manualKeys ?? [])
    setSeed(p.seed ?? 1)
    setValues(p.values ?? {})
    if (p.page !== undefined) setPage(Math.max(0, p.page))
  }, [doc])

  useEffect(() => {
    if (!doc || !progressLoadedRef.current) return
    const t = window.setTimeout(() => {
      saveDictationProgress(doc.id, {
        mode: maskConfig.mode,
        ratio: maskConfig.ratio,
        hidePunctuation: maskConfig.hidePunctuation,
        target: maskConfig.target ?? 'all',
        manualKeys,
        seed,
        page,
        values,
      })
    }, 500)
    return () => window.clearTimeout(t)
  }, [doc, maskConfig, manualKeys, seed, page, values])

  /* ---------------- 计时器 ---------------- */
  useEffect(() => {
    if (!memoRunning) return
    const t = window.setInterval(() => setMemoSeconds((s) => s + 1), 1000)
    return () => window.clearInterval(t)
  }, [memoRunning])

  useEffect(() => {
    if (!recording) return
    const t = window.setInterval(() => setRecSeconds((s) => s + 1), 1000)
    return () => window.clearInterval(t)
  }, [recording])

  useEffect(() => () => recorderRef.current?.dispose(), [])

  useEffect(
    () => () => {
      const s = sessionRef.current
      if (s) {
        audioBus.release(s.holder)
        s.stop()
        sessionRef.current = null
      }
    },
    [],
  )

  /* ---------------- 分句 / 划线 / 听书计划 ---------------- */
  const pageSentences = useMemo(
    () => pageParagraphs.map((p) => splitSentences(p, { crossLanguage: true })),
    [pageParagraphs],
  )

  const pageAnns = useMemo(() => {
    if (annotations === null) return [] as ReadingAnnotation[]
    return annotations.filter((a) => a.para >= basePara && a.para <= lastPara)
  }, [annotations, basePara, lastPara])

  const isBilingual = useMemo(() => detectBilingual(paragraphs), [paragraphs])

  const hidden = useMemo(
    () => buildMaskPlan(pageParagraphs, maskConfig, manualKeys, seed, docLang),
    [pageParagraphs, maskConfig, manualKeys, seed, docLang],
  )
  const slots = useMemo(
    () => collectSlots(pageParagraphs, hidden, docLang),
    [pageParagraphs, hidden, docLang],
  )

  const prefix = `${page}:`
  const localValues = useMemo(() => {
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(values)) {
      if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v
    }
    return out
  }, [values, prefix])

  const stats = useMemo(
    () => dictationStats(slots.map((s) => ({ target: s.target, value: localValues[s.key] ?? '' }))),
    [slots, localValues],
  )

  const handleSlotChange = useCallback(
    (localKey: string, v: string) => {
      setValues((prev) => ({ ...prev, [`${prefix}${localKey}`]: v }))
      setShowCompare(false)
    },
    [prefix],
  )

  const handleToggleSlot = useCallback((localKey: string) => {
    setManualKeys((prev) =>
      prev.includes(localKey) ? prev.filter((k) => k !== localKey) : [...prev, localKey],
    )
  }, [])

  /* ---------------- 阅读模式：双击查词 ---------------- */
  async function onWord(t: string, context: string) {
    void speakFocused(t, false)
    const info = await lookupWord(t)
    let added = false
    if (mode === 'read') {
      await addToVocab({
        id: info?.id,
        word: t,
        book: info?.book,
        ipa: info?.ipa,
        definition_zh: info?.definition_zh,
        pos: info?.pos,
      })
      added = true
    } else {
      added = info ? await isInVocab(info.id || `${info.book ?? 'x'}:${t.toLowerCase()}`) : false
    }
    setSel({ word: t, info, added, grammar: null, grammarLoading: true })
    analyzeSentence(context)
      .then((g) => setSel((s) => (s && s.word === t ? { ...s, grammar: g, grammarLoading: false } : s)))
      .catch(() => setSel((s) => (s && s.word === t ? { ...s, grammarLoading: false } : s)))
  }

  async function handleAdd() {
    if (!sel) return
    const info = sel.info
    await addToVocab({
      id: info?.id,
      word: sel.word,
      book: info?.book,
      ipa: info?.ipa,
      definition_zh: info?.definition_zh,
      pos: info?.pos,
    })
    setSel({ ...sel, added: true })
  }

  /* ---------------- 听书 ---------------- */
  const listenUnits = useMemo<ListenUnit[]>(
    () => buildListenUnits(pageSentences, { rate: speechRate }),
    [pageSentences, speechRate],
  )

  useEffect(() => {
    if (!pendingAdvanceRef.current) return
    if (listenUnits.length === 0) return
    pendingAdvanceRef.current = false
    startFrom(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listenUnits])

  const timerRunning = remainingSec !== null
  useEffect(() => {
    if (!timerRunning) return
    const t = window.setInterval(() => {
      setRemainingSec((s) => (s === null ? null : Math.max(0, s - 1)))
    }, 1000)
    return () => window.clearInterval(t)
  }, [timerRunning])

  useEffect(() => {
    if (remainingSec === 0) {
      stopListen()
      showToast('听书已按定时关闭')
      setRemainingSec(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remainingSec])

  const [activeKey, setActiveKey] = useState('')
  const listenStartRef = useRef(0)

  const unitKey = useCallback(
    (i: number) => {
      const u = listenUnits[i]
      return u ? `${u.para}:${u.sent ?? 0}` : ''
    },
    [listenUnits],
  )

  function makeSession(): ListenSession {
    const session = new ListenSession({
      rate: () => rateRef.current,
      onIndex: (i) => setActiveKey(i < 0 ? '' : unitKey(i)),
      onEnd: () => {
        audioBus.release(session.holder)
        sessionRef.current = null
        listenRef.current = false
        accountListenTime()
        setActiveKey('')
        setResume(null)
        // 「本集结束后关闭」未开启且还有下一页 → 自动续读下一章
        if (!stopAtEndRef.current && pageRef.current < pageCountRef.current - 1) {
          pendingAdvanceRef.current = true
          setPaused(false)
          setListening(true)
          setPage((p) => p + 1)
          return
        }
        if (stopAtEndRef.current) showToast('已读完本集，听书停止')
        setListening(false)
        setPaused(false)
        setRemainingSec(null)
      },
    })
    return session
  }

  const pageRef = useRef(0)
  pageRef.current = page
  const pageCountRef = useRef(0)
  pageCountRef.current = pages.length

  function accountListenTime() {
    if (!listenStartRef.current) return
    const sec = Math.round((Date.now() - listenStartRef.current) / 1000)
    listenStartRef.current = 0
    if (sec > 0) addReadingTime(sec)
  }

  function stopListen() {
    const s = sessionRef.current
    if (s) {
      audioBus.release(s.holder)
      s.stop()
      sessionRef.current = null
    }
    listenRef.current = false
    pendingAdvanceRef.current = false
    pauseRemainRef.current = null
    accountListenTime()
    setListening(false)
    setPaused(false)
    setResume(null)
    setActiveKey('')
    setRemainingSec(null)
  }

  function pauseListen() {
    const s = sessionRef.current
    if (!s) return
    setResume(s.index)
    s.pause()
    listenRef.current = false
    accountListenTime()
    pauseRemainRef.current = remainingSec
    setRemainingSec(null)
    setListening(true)
    setPaused(true)
  }

  function resumeListen() {
    const s = sessionRef.current
    if (!s) {
      startFrom(resumeRef.current ?? 0)
      return
    }
    listenRef.current = true
    listenStartRef.current = Date.now()
    setPaused(false)
    if (pauseRemainRef.current !== null) {
      setRemainingSec(pauseRemainRef.current)
      pauseRemainRef.current = null
    }
    s.resume()
  }

  function toggleListen() {
    if (!listening) {
      if (isWeChatBrowser() && !wechatWarnedRef.current) {
        wechatWarnedRef.current = true
        showToast('微信内听书可能无声，请点右上角「···」→ 在浏览器打开')
      }
      startFrom(resumeRef.current ?? 0)
      return
    }
    if (paused) {
      resumeListen()
      return
    }
    pauseListen()
  }

  function startFrom(i: number, stopAt: number | null = null) {
    if (!isSpeechSupported() || listenUnits.length === 0) return
    let session = sessionRef.current
    const fresh = !session
    if (!session) {
      session = makeSession()
      sessionRef.current = session
    }
    listenRef.current = true
    listenStartRef.current = Date.now()
    setListening(true)
    setPaused(false)
    if (fresh && timerMinRef.current > 0) setRemainingSec(timerMinRef.current * 60)
    audioBus.claim(session.holder)
    session.start(listenUnits, i, stopAt)
  }

  function replaySentence(fragIdx: number, si: number) {
    const idx = firstUnitIndexOfSentence(listenUnits, fragIdx, si)
    if (idx < 0) return
    const stopAt = scopeRef.current === 'single' ? lastUnitIndexOfSentence(listenUnits, fragIdx, si) : null
    cancelSpeech()
    setSel(null)
    const selection = typeof window === 'undefined' ? null : window.getSelection()
    if (selection && !selection.isCollapsed) selection.removeAllRanges()
    startFrom(idx, stopAt)
  }

  function handleEdit() {
    if (!doc) return
    stopListen()
    navigate('/import', { state: { editId: doc.id, title: doc.title, content: doc.content } })
  }

  /* ---------------- 翻页 / 面板 ---------------- */
  function gotoPage(p: number) {
    stopListen()
    setPage(Math.min(Math.max(p, 0), Math.max(0, pages.length - 1)))
    setShowCompare(false)
    setPopup(null)
    clearSelection()
    if (prefs.pageMode === 'scroll') flipRef.current?.scrollToPage(Math.min(Math.max(p, 0), Math.max(0, pages.length - 1)))
  }

  function handlePageCommit(p: number) {
    setPage(p)
  }

  /**
   * 单击正文：强制清除选区 + Toggle 导航栏（V3.3 细化）。
   * 只切换导航栏显隐，默认不弹出任何面板（阅读/记忆等需点对应图标才出现）。
   */
  function togglePanel() {
    // 存在活跃选区（刚划完词）时，单击不响应、不清选区，交还划词菜单处理
    const sel = window.getSelection()
    if (sel && !sel.isCollapsed) return
    clearSelection()
    setPopup(null)
    setNavOpen((v) => !v)
    setPanelTab(null)
  }

  function closePanel() {
    setPanelTab(null)
  }

  /** 全局弹窗关闭：清空导航栏 + 设置面板 + 划线菜单，恢复纯阅读（点空白处 / 遮罩触发） */
  function closeAllOverlays() {
    setNavOpen(false)
    setPanelTab(null)
    setPopup(null)
    clearSelection()
  }

  useEffect(() => {
    if (mode !== 'read') return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'ArrowLeft' && page > 0) gotoPage(page - 1)
      if (e.key === 'ArrowRight' && page < pages.length - 1) gotoPage(page + 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, page, pages.length, prefs.pageMode])

  /* ---------------- 划词选区监听 ---------------- */
  useEffect(() => {
    if (mode !== 'read') return
    let timer = 0
    // 手指/鼠标按着期间不弹菜单：长按选完、抬起后再弹（pointer + touch 双通道判定）
    let pressing = false
    function check() {
      const root = rootRef.current
      if (!root) return
      const captured = captureSelection(root)
      if (captured) setPopup(captured)
      else if (!holdPopupRef.current) setPopup(null)
    }
    function onChange() {
      if (pressing) return // 还按着屏幕：先不弹
      window.clearTimeout(timer)
      timer = window.setTimeout(check, 150)
    }
    function press() {
      pressing = true
    }
    function release() {
      if (!pressing) return
      pressing = false
      // 抬起后稍等一拍再查选区（长按产生的选区此时已就绪）
      window.clearTimeout(timer)
      timer = window.setTimeout(check, 60)
    }
    window.addEventListener('pointerdown', press, true)
    window.addEventListener('pointerup', release, true)
    window.addEventListener('touchstart', press, true)
    window.addEventListener('touchend', release, true)
    document.addEventListener('selectionchange', onChange)
    return () => {
      window.removeEventListener('pointerdown', press, true)
      window.removeEventListener('pointerup', release, true)
      window.removeEventListener('touchstart', press, true)
      window.removeEventListener('touchend', release, true)
      document.removeEventListener('selectionchange', onChange)
      window.clearTimeout(timer)
    }
  }, [mode])

  async function handleCopySelection() {
    if (!popup) return
    holdPopupRef.current = false
    try {
      await navigator.clipboard.writeText(popup.text)
      showToast('已复制')
    } catch {
      showToast('复制失败：当前环境不支持剪贴板')
    }
  }

  function handleListenSelection() {
    if (!popup) return
    holdPopupRef.current = false
    const lang = detectLanguage(popup.text)
    const tag = lang === 'zh' ? 'zh-CN' : lang === 'en' ? 'en-US' : undefined
    clearSelection()
    setPopup(null)
    void speakFocused(popup.text, false, undefined, tag)
  }

  async function handleAnnotate(style: AnnotationStyle, color: AnnotationColor) {
    const s = popup
    if (!s || !doc) return
    holdPopupRef.current = true // 菜单保持打开：选颜色/线型实时生效，允许继续修改，点外部才关
    lastStyleRef.current = style
    lastColorRef.current = color
    for (const span of s.spans) {
      const paraText = paragraphs[span.para] ?? ''
      const key = `${span.para}:${span.start}:${span.end}`
      const existingId = annotatedKeysRef.current.get(key)
      if (existingId) {
        await updateAnnotation(existingId, { style, color })
      } else {
        const created = await addAnnotation({
          doc_id: doc.id,
          page: paraPage[span.para] ?? 0,
          para: span.para,
          start: span.start,
          end: span.end,
          text: paraText.slice(span.start, span.end),
          kind: 'underline',
          style,
          color,
        })
        annotatedKeysRef.current.set(key, created.id)
      }
    }
    loadAnnotations()
    showToast('已划线')
  }

  function openThought() {
    if (!popup) return
    thoughtTargetRef.current = popup
    holdPopupRef.current = true
    setThoughtText('')
    setThoughtOpen(true)
  }

  function closeThought() {
    setThoughtOpen(false)
    holdPopupRef.current = false
    thoughtTargetRef.current = null
    clearSelection()
    setPopup(null)
  }

  async function saveThought() {
    const target = thoughtTargetRef.current
    if (!target || !doc) return
    const text = thoughtText.trim()
    if (!text) return
    const first = target.spans[0]
    await addAnnotation({
      doc_id: doc.id,
      page: paraPage[first.para] ?? 0,
      para: first.para,
      start: first.start,
      end: first.end,
      text: target.text,
      kind: 'thought',
      thought: text,
    })
    closeThought()
    setThoughtText('')
    loadAnnotations()
    showToast('想法已保存，可在「笔记」里查看')
  }

  function handleFeedback() {
    holdPopupRef.current = false
    window.location.href = FEEDBACK_MAILTO
    showToast('正在打开邮件；若无反应可复制邮箱 2878747585@qq.com')
  }

  /* ---------------- 书签 ---------------- */
  const pageBookmark = useMemo(
    () => (doc?.bookmarks ?? []).find((b) => b.page === page),
    [doc?.bookmarks, page],
  )

  async function toggleBookmark() {
    if (!doc) return
    if (pageBookmark) {
      await removeBookmark(doc.id, pageBookmark.id)
      showToast('已移除书签')
    } else {
      await addBookmark(doc.id, page, basePara)
      setRibbonAnim(true)
      window.setTimeout(() => setRibbonAnim(false), 600)
      showToast('已加书签，目录里可跳转')
    }
    setDoc({ ...doc })
  }

  function stageTouchStart(e: React.TouchEvent) {
    const t = e.touches[0]
    const top = rootRef.current?.getBoundingClientRect().top ?? 0
    pullStartRef.current = { y: t.clientY, inTop: t.clientY - top < 64 }
  }
  function stageTouchEnd(e: React.TouchEvent) {
    const start = pullStartRef.current
    pullStartRef.current = null
    if (!start?.inTop || mode !== 'read') return
    const dy = e.changedTouches[0].clientY - start.y
    if (dy > 70) void toggleBookmark()
  }

  /* ---------------- 默写控制 ---------------- */
  function resetPage() {
    setValues((prev) => {
      const next: Record<string, string> = {}
      for (const [k, v] of Object.entries(prev)) {
        if (!k.startsWith(prefix)) next[k] = v
      }
      return next
    })
    setMemoSeconds(0)
    setMemoRunning(false)
    setShowCompare(false)
  }

  /* ---------------- 录音 ---------------- */
  const loadRecs = useCallback(() => {
    if (!id) return
    getRecitationsByDoc(id).then(setRecs)
  }, [id])

  useEffect(() => {
    loadRecs()
  }, [loadRecs])

  async function startRec() {
    setRecError('')
    try {
      if (!recorderRef.current) recorderRef.current = createRecorderSession()
      await recorderRef.current.start()
      setRecSeconds(0)
      setRecording(true)
    } catch (e: any) {
      setRecError(e?.message ?? '无法开始录音')
    }
  }

  async function stopRec() {
    const rec = recorderRef.current
    if (!rec) return
    setRecording(false)
    try {
      const { blob, durationMs, mediaType } = await rec.stop()
      if (!doc) return
      await addRecitation({
        blob,
        duration_ms: durationMs,
        media_type: mediaType,
        title: recitationTitle(durationMs),
        doc_id: doc.id,
        doc_title: doc.title,
        page,
      })
      loadRecs()
    } catch (e: any) {
      if (e?.message !== 'cancelled') setRecError(e?.message ?? '录音保存失败')
    }
  }

  async function removeRec(rid: string) {
    await deleteRecitation(rid)
    loadRecs()
  }

  /* ============================ 正文渲染 ============================ */

  /**
   * 渲染一个片段（fragment）：段内 [start, end) 的文本。
   * 坐标：段内偏移以**整段**为准（ann 用整段偏移；片段渲染时平移 -start），
   * `data-para-start` 记下片段起点，selectionCapture 据此还原整段坐标。
   */
  function renderFragment(frag: { para: number; start: number; end: number }, anns: ReadingAnnotation[]) {
    const full = paragraphs[frag.para] ?? ''
    const text = full.slice(frag.start, frag.end)
    const sents = splitSentences(text, { crossLanguage: true })
    const base = frag.start
    const pi = pageParas.indexOf(frag.para)
    const paraAnns = anns.filter((a) => a.para === frag.para)

    // 句子在片段坐标系中的起始偏移（每句后跟一个空格）
    const sentOffsets: number[] = []
    let acc = 0
    for (const s of sents) {
      sentOffsets.push(acc)
      acc += s.length + 1
    }

    return (
      <p
        key={`${frag.para}:${frag.start}`}
        data-para={frag.para}
        data-para-start={frag.start}
        className={cn(
          'whitespace-pre-wrap break-words',
          prefs.indent && frag.start === 0 && 'indent-8',
        )}
      >
        {sents.map((s, si) => {
          const active = activeKey === `${pi}:${si}`
          return (
            <span
              key={`${frag.para}:${frag.start}:${si}`}
              onClick={(e) => {
                if (active && listening) {
                  e.stopPropagation()
                  toggleListen()
                }
              }}
              onDoubleClick={() => isSpeechSupported() && replaySentence(pi, si)}
              title="双击整句从这句开始朗读"
              className={cn('rounded transition-colors', active ? 'bg-accent/25' : 'hover:bg-secondary/60')}
            >
              {renderTokens(s, s, sentOffsets[si], base, paraAnns, active)}
              {' '}
            </span>
          )
        })}
      </p>
    )
  }

  /** 渲染一句的 token 流，并把划线区间叠到 token 上（区间为整段坐标，渲染时平移 base） */
  function renderTokens(
    display: string,
    context: string,
    sentOffset: number,
    base: number,
    paraAnns: ReadingAnnotation[],
    activeSentence: boolean,
  ) {
    let tokAcc = 0
    return tokenize(display, docLang).map((tk, j) => {
      const tokStart = sentOffset + tokAcc
      tokAcc += tk.t.length
      const ranges = paraAnns
        .map((a) => ({ start: a.start - base - tokStart, end: a.end - base - tokStart, ann: a }))
        .filter((r) => r.end > 0 && r.start < tk.t.length)

      const content =
        ranges.length === 0
          ? tk.t
          : splitByRanges(tk.t, ranges).map((seg, k) => {
              if (seg.anns.length === 0) return <span key={k}>{seg.text}</span>
              const top = seg.anns[seg.anns.length - 1]
              // 笔记（想法）：点虚线文字 → 弹笔记详情（不再弹设置面板）
              const onNote = top.kind === 'thought'
                ? (e: React.MouseEvent) => {
                    e.stopPropagation()
                    setNoteDetail(top)
                  }
                : undefined
              return (
                <span key={k} style={annotationCss(top)} onClick={onNote}>
                  {seg.text}
                </span>
              )
            })

      if (!tk.word) return <span key={j}>{content}</span>

      return (
        <span
          key={j}
          onClick={(e) => {
            if (activeSentence && listening) return
            e.stopPropagation()
            togglePanel()
          }}
          onDoubleClick={(e) => {
            e.stopPropagation()
            void onWord(tk.t, context)
          }}
          className="cursor-pointer rounded transition-colors hover:bg-primary/15 active:bg-primary/25"
          title="双击查看释义并听发音"
        >
          {content}
        </span>
      )
    })
  }

  /** 分页模式：渲染第 i 页（按实测碎片） */
  function renderPageContent(i: number) {
    const pg = pages[i]
    if (!pg) return null
    return (
      <article
        className={cn('reader-page space-y-4 pb-8 pt-4', MARGIN_CLASS[prefs.margin])}
        style={{
          fontSize: prefs.fontSize,
          lineHeight: prefs.lineHeight,
          fontFamily: FONT_STACKS[prefs.fontFamily],
        }}
      >
        {pg.frags.map((f) => renderFragment(f, pageAnns))}
      </article>
    )
  }

  /** 滚动模式：渲染整篇（整段不拆；页码按滚动位置反算） */
  function renderScrollContent() {
    const all = annotations ?? []
    return (
      <article
        className={cn('reader-scroll space-y-4 pb-14 pt-4', MARGIN_CLASS[prefs.margin])}
        style={{
          fontSize: prefs.fontSize,
          lineHeight: prefs.lineHeight,
          fontFamily: FONT_STACKS[prefs.fontFamily],
        }}
      >
        {paragraphs.map((_, idx) =>
          renderFragment({ para: idx, start: 0, end: paragraphs[idx].length }, all),
        )}
      </article>
    )
  }

  if (doc === undefined) return <div className="p-6 text-sm text-muted-foreground">加载中…</div>
  if (doc === null) {
    return <EmptyState icon={BookOpen} title="素材不存在" description="该导入素材可能已被删除。" />
  }

  const chapters = doc.chapters ?? []
  const brightness = prefs.brightness < 0.99 ? { filter: `brightness(${prefs.brightness})` } : undefined
  const chapterItems = chapters.map((c) => ({ title: c.title, page: paraPage[c.para] ?? 0 }))

  return (
    <div
      ref={rootRef}
      className={cn('reader-surface flex h-[100dvh] flex-col', `reader-theme-${prefs.theme}`)}
      onTouchStart={stageTouchStart}
      onTouchEnd={stageTouchEnd}
      data-testid="reader-root"
    >
      {pageBookmark && <BookmarkRibbon animate={ribbonAnim} />}

      {/* 顶栏（常驻）：返回 / 标题 / 编辑 / 听书快捷 / 停止 / 倒计时 */}
      <header className="safe-top shrink-0 border-b border-border/60 bg-card/60 px-3 py-2 backdrop-blur">
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => navigate(-1)}
            aria-label="返回"
            title="返回"
            className="text-muted-foreground touch-target"
          >
            <ArrowLeft className="h-6 w-6" />
          </button>
          <div className="min-w-0 flex-1">
            <div className="truncate font-semibold">{doc.title}</div>
            <div className="text-xs reader-muted">
              {LANG_LABEL[docLang]} · {unitLabel(docLang, doc.word_count)} ·{' '}
              {doc.type === 'audio'
                ? (doc.media_type ?? '').startsWith('video/')
                  ? '视频'
                  : '音频'
                : doc.type === 'book'
                  ? '书籍'
                  : doc.type === 'transcript'
                    ? '字幕'
                    : '文章'}
              {chapters.length > 0 ? ` · ${chapters.length} 章` : ''} · 第 {page + 1}/{pages.length} 页
            </div>
          </div>
          {/* 仅「文章」可编辑：导入的书籍（TXT/EPUB）不支持编辑原文 */}
          {doc.type === 'article' && (
            <IconAction label="编辑原文" onClick={handleEdit}>
              <Pencil className="h-4 w-4" />
            </IconAction>
          )}
          {isSpeechSupported() && (
            <IconAction
              label={
                listening
                  ? paused
                    ? '继续听书'
                    : '暂停听书'
                  : resumeIdx !== null
                    ? '从上次停下的句子续听'
                    : '从头听书'
              }
              active={listening && !paused}
              onClick={toggleListen}
            >
              {listening && !paused ? <Pause className="h-4 w-4" /> : <Headphones className="h-4 w-4" />}
            </IconAction>
          )}
          {listening && remainingSec !== null && (
            <span className="shrink-0 rounded-full bg-primary/10 px-2 py-1 text-xs font-semibold tabular-nums text-primary">
              {fmtDuration(remainingSec * 1000)}
            </span>
          )}
          {listening && (
            <IconAction label="停止听书" onClick={stopListen}>
              <Square className="h-4 w-4" />
            </IconAction>
          )}
        </div>
      </header>

      {/* 内容区（固定高度：视口高 - 顶栏；测量探针也挂在这里） */}
      <div
        ref={stageRef}
        className="relative flex min-h-0 flex-1 flex-col"
        style={brightness}
        onContextMenu={(e) => {
          // 划词：屏蔽系统原生「复制 / 搜索」菜单，只允许自定义划词弹窗
          const t = e.target as HTMLElement
          if (t.closest('input,textarea,[contenteditable="true"]')) return
          e.preventDefault()
        }}
      >
        <div ref={measureRef} className="measure-probe" aria-hidden />

        {mode === 'read' ? (
          <PageFlipContainer
            pageMode={prefs.pageMode}
            page={page}
            pageCount={pages.length}
            gesturesDisabled={false}
            onPage={handlePageCommit}
            onTapCenter={togglePanel}
            renderPage={renderPageContent}
            renderScroll={renderScrollContent}
            handleRef={flipRef}
          />
        ) : (
          <div
            className="reader-nobar min-h-0 flex-1 overflow-y-auto px-4 pb-14 pt-4"
            onClick={(e) => {
              const t = e.target as HTMLElement
              if (t.closest('input,textarea,button,select,a,label,[data-no-chrome]')) return
              togglePanel()
            }}
          >
            <div className="space-y-4">
              {/* 记忆栏（顺序：计时 → 循环 → 显隐 → 选择 → 清空） */}
              <div className="flex items-center gap-2">
                <MemoTimer
                  running={memoRunning}
                  seconds={memoSeconds}
                  onToggle={() => setMemoRunning((r) => !r)}
                />
                <IconAction label="清空本页" onClick={resetPage}>
                  <IconReset className="h-4 w-4" />
                </IconAction>
                <IconAction
                  label={revealHidden ? '闭眼：隐藏答案' : '睁眼：显示答案'}
                  active={revealHidden}
                  onClick={() => setRevealHidden((v) => !v)}
                >
                  {revealHidden ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </IconAction>
                {maskConfig.mode === 'manual' && (
                  <>
                    <IconAction
                      label={selecting ? '完成选择' : '开始选择'}
                      active={selecting}
                      onClick={() =>
                        setSelecting((s) => {
                          const next = !s
                          // 点锁（完成选择）→ 自动开始计时
                          if (!next) setMemoRunning(true)
                          return next
                        })
                      }
                    >
                      {selecting ? <Lock className="h-4 w-4" /> : <KeyRound className="h-4 w-4" />}
                    </IconAction>
                    {manualKeys.length > 0 && (
                      <IconAction label="清空选择" onClick={() => setManualKeys([])}>
                        <IconBroom className="h-4 w-4" />
                      </IconAction>
                    )}
                  </>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2 text-xs">
                <Badge>
                  已填 {stats.filled}/{stats.total}
                </Badge>
                <Badge className="bg-emerald-500/15 text-emerald-700">正确 {stats.correct}</Badge>
                {stats.wrong > 0 && (
                  <Badge className="bg-rose-500/15 text-rose-700">错误 {stats.wrong}</Badge>
                )}
                <Badge>{stats.accuracy}% 正确率</Badge>
              </div>

              <div className="rounded-xl bg-secondary/40 p-3">
                {selecting && maskConfig.mode === 'manual' && (
                  <p className="mb-3 rounded-lg bg-primary/10 px-3 py-2 text-xs text-primary">
                    选择阶段：点按或横向滑动选词（再滑一次即取消），完成后点「完成选择」开始默写。
                  </p>
                )}
                <InlineDictation
                  paragraphs={pageParagraphs}
                  hidden={hidden}
                  values={localValues}
                  lang={docLang}
                  onChange={handleSlotChange}
                  selectable={maskConfig.mode === 'manual'}
                  selecting={selecting && maskConfig.mode === 'manual'}
                  onToggleSlot={handleToggleSlot}
                  reveal={revealHidden}
                  onInputFocus={() => {
                    // 手动暂停后光标进入输入框 → 自动继续计时
                    setMemoRunning(true)
                  }}
                />
              </div>

              <Button variant="primary" className="w-full" onClick={() => setShowCompare((v) => !v)}>
                <Eye className="h-4 w-4" /> {showCompare ? '收起对照' : '核验本页'}
              </Button>

              {showCompare && (
                <div className="space-y-2 rounded-xl border border-border p-3">
                  <article className="space-y-3 text-[16px] leading-7">
                    {pageParagraphs.map((p, pi) => (
                      <p key={pi} className="whitespace-pre-wrap break-words">
                        {tokenize(p, docLang).map((tk, ti) => {
                          const k = slotKey(pi, ti)
                          if (!hidden.has(k)) return <span key={k}>{tk.t}</span>
                          const st = inlineState(tk.t, localValues[k] ?? '')
                          return (
                            <span
                              key={k}
                              className={cn(
                                'rounded px-0.5',
                                st === 'ok' && 'text-emerald-600',
                                st === 'wrong' && 'memo-wrong',
                                st === 'typing' && 'text-primary',
                                st === 'empty' && 'text-muted-foreground/60 underline decoration-dotted',
                              )}
                            >
                              {tk.t}
                            </span>
                          )
                        })}
                      </p>
                    ))}
                  </article>
                  <p className="text-xs reader-muted">
                    绿色=写对 · 红色=写错 · 蓝色=写到一半 · 虚线下划线=未填
                  </p>
                </div>
              )}

              <div className="rounded-xl border border-border p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-sm font-semibold">录音背诵</span>
                  {recording && (
                    <span className="font-mono text-xs text-rose-600">
                      ● 录制中 {fmtDuration(recSeconds * 1000)}
                    </span>
                  )}
                </div>
                <div className="flex gap-2">
                  {!recording ? (
                    <Button
                      variant="primary"
                      size="sm"
                      className="flex-1"
                      disabled={!isRecordingSupported()}
                      onClick={startRec}
                    >
                      <Mic className="h-4 w-4" /> {recs.length ? '继续录制' : '开始录音'}
                    </Button>
                  ) : (
                    <Button variant="accent" size="sm" className="flex-1" onClick={stopRec}>
                      <Square className="h-4 w-4" /> 结束并保存
                    </Button>
                  )}
                  {recording && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        recorderRef.current?.cancel()
                        setRecording(false)
                      }}
                    >
                      取消
                    </Button>
                  )}
                </div>
                {!isRecordingSupported() && (
                  <p className="mt-2 text-xs reader-muted">
                    当前浏览器不支持录音（可换 Chrome / Edge 试试）。
                  </p>
                )}
                {recError && <p className="mt-2 text-xs text-rose-600">{recError}</p>}

                {recs.length > 0 && (
                  <ul className="mt-3 space-y-2">
                    {recs.map((r) => (
                      <RecitationRow key={r.id} rec={r} onDelete={() => removeRec(r.id)} />
                    ))}
                  </ul>
                )}
                {recs.length === 0 && !recording && (
                  <p className="mt-2 text-xs reader-muted">
                    录下的音频保存在本机，并自动归档到「我的 → 背诵」，可回放、可删除、可继续录制。
                  </p>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 全局遮罩：点击空白处清空所有弹窗（导航栏 / 设置面板 / 划线菜单），恢复纯阅读 */}
      {(panelTab !== null || popup !== null) && (
        <div
          className="fixed inset-0 z-40 bg-black/30"
          onClick={closeAllOverlays}
          aria-hidden
        />
      )}

      {/* 综合控制中心：目录 / 笔记 / 进度 / 听书 / 设置 */}
      <ReaderControlCenter
        open={navOpen}
        tab={panelTab}
        onTabChange={(t) => setPanelTab(t)}
        onClose={closeAllOverlays}
        toc={{
          page,
          chapters: chapterItems,
          bookmarks: doc.bookmarks ?? [],
          pageBookmark,
          paraPreview: (p) => paragraphs[p]?.slice(0, 24) ?? `第 ${page + 1} 页`,
          onToggleBookmark: () => void toggleBookmark(),
          onJumpPage: (p) => gotoPage(p),
          onRemoveBookmark: (id) => void removeBookmark(doc.id, id).then(() => setDoc({ ...doc })),
        }}
        notes={{
          annotations,
          onJump: (a) => {
            gotoPage(a.page)
            closePanel()
          },
          onDelete: (aid) => void deleteAnnotation(aid).then(loadAnnotations),
          onUpdateThought: (aid, thought) => void updateAnnotation(aid, { thought }).then(loadAnnotations),
        }}
        progress={{ page, pageCount: pages.length, onGoto: (p) => gotoPage(p) }}
        listen={{
          speechSupported: isSpeechSupported(),
          listening,
          paused,
          onToggle: toggleListen,
          onStop: stopListen,
          speechRate,
          onSpeechRateChange: (r) => setSetting('speechRate', r),
          timerMin: speechTimerMin,
          onTimerChange: (m) => setSetting('speechTimerMin', m),
          stopAtEnd: speechStopAtEnd,
          onStopAtEndChange: (v) => setSetting('speechStopAtEnd', v),
          remainingSec,
        }}
        settings={{
          mode,
          onModeChange: (m) => {
            setMode(m)
            setSelecting(m === 'memo' && maskConfig.mode === 'manual')
            setMemoSeconds(0)
            setMemoRunning(false)
            setShowCompare(false)
          },
          prefs,
          onChange: setPrefs,
          memo: {
            config: maskConfig,
            onChange: (patch) => {
              setMaskConfig((c) => ({ ...c, ...patch }))
              if (patch.mode) setSelecting(patch.mode === 'manual')
              setShowCompare(false)
            },
            bilingual: isBilingual,
            onReshuffle: () => setSeed((s) => s + 1),
          },
        }}
      />

      {/* 笔记详情（点正文虚线标识弹出）：可编辑 / 删除 */}
      <NoteDetail
        ann={noteDetail}
        onClose={() => setNoteDetail(null)}
        onSave={(aid, thought) => {
          void updateAnnotation(aid, { thought }).then(() => {
            loadAnnotations()
            setNoteDetail(null)
            showToast('笔记已更新')
          })
        }}
        onDelete={(aid) => {
          void deleteAnnotation(aid).then(() => {
            loadAnnotations()
            setNoteDetail(null)
            showToast('笔记已删除')
          })
        }}
      />

      {/* 选区自绘高亮：只染色文字本体、不含行距 */}
      {popup &&
        mode === 'read' &&
        popup.rects.map((r, i) => (
          <div
            key={i}
            className="reader-sel-hl"
            style={{
              top: r.top + r.height * 0.14,
              left: r.left,
              width: r.width,
              height: r.height * 0.72,
            }}
            aria-hidden
          />
        ))}

      {popup && mode === 'read' && (
        <SelectionPopup
          rect={popup.rect}
          defaultStyle={lastStyleRef.current}
          defaultColor={lastColorRef.current}
          onListen={handleListenSelection}
          onCopy={handleCopySelection}
          onAnnotate={(s, c) => void handleAnnotate(s, c)}
          onThought={openThought}
          onFeedback={handleFeedback}
          onInteract={() => {
            holdPopupRef.current = true
          }}
        />
      )}

      <Dialog
        open={thoughtOpen}
        onClose={closeThought}
        title="写想法"
        footer={
          <>
            <Button variant="outline" className="flex-1" onClick={closeThought}>
              取消
            </Button>
            <Button className="flex-1" disabled={!thoughtText.trim()} onClick={() => void saveThought()}>
              保存
            </Button>
          </>
        }
      >
        <p className="mb-2 line-clamp-2 border-l-2 border-primary/50 pl-2 text-xs text-muted-foreground">
          {thoughtTargetRef.current?.text}
        </p>
        <textarea
          value={thoughtText}
          onChange={(e) => setThoughtText(e.target.value)}
          rows={4}
          aria-label="想法内容"
          autoFocus
          className="w-full rounded-lg bg-muted p-3 text-sm outline-none"
          placeholder="记下此刻的理解或疑问…（保存在本机，可在「笔记」里编辑）"
        />
      </Dialog>

      <Sheet open={!!sel} onClose={() => setSel(null)} title={sel?.word}>
        {sel && <WordSheet sel={sel} onAdd={handleAdd} />}
      </Sheet>

      {toast && (
        <div className="pointer-events-none fixed inset-x-0 bottom-24 z-[60] flex justify-center px-6">
          <div className="rounded-full bg-foreground/90 px-4 py-2 text-center text-xs text-background shadow-soft">
            {toast}
          </div>
        </div>
      )}
    </div>
  )
}

/* ============================ 录音条目 ============================ */
export function RecitationRow({ rec, onDelete }: { rec: Recitation; onDelete: () => void }) {
  const [url, setUrl] = useState<string | null>(null)
  const mediaRef = useMediaAudio()
  useEffect(() => {
    const u = URL.createObjectURL(rec.blob)
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [rec.blob])

  return (
    <li className="space-y-1.5 rounded-lg bg-secondary/50 p-2">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs font-medium">{rec.title}</span>
        <button
          onClick={onDelete}
          className="shrink-0 text-muted-foreground hover:text-destructive"
          aria-label="删除录音"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      {url && <audio ref={mediaRef} controls src={url} className="w-full" />}
    </li>
  )
}

/* ============================ 单词弹层 ============================ */
function WordSheet({ sel, onAdd }: { sel: Sel; onAdd: () => void }) {
  const g = sel.grammar
  return (
    <div className="space-y-4">
      {sel.info ? (
        <div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-bold">{sel.info.word}</span>
            {sel.info.pos && <span className="text-xs text-muted-foreground">{sel.info.pos}</span>}
          </div>
          {sel.info.ipa && <div className="mt-1 text-sm text-muted-foreground">/{sel.info.ipa}/</div>}
          {sel.info.definition_zh && (
            <p className="mt-2 text-base leading-relaxed">{sel.info.definition_zh}</p>
          )}
        </div>
      ) : (
        <div>
          <div className="text-2xl font-bold">{sel.word}</div>
          <p className="mt-1 text-sm text-muted-foreground">
            该词未收录进词库，仍可直接加入生词本反复学习。
          </p>
        </div>
      )}

      <div className="rounded-lg bg-secondary/50 p-3 text-sm">
        <div className="mb-2 flex items-center gap-1 font-semibold text-muted-foreground">
          <BookOpen className="h-4 w-4" /> 语法分析
        </div>
        {sel.grammarLoading ? (
          <div className="text-muted-foreground">分析中…</div>
        ) : g ? (
          <div className="space-y-1">
            <div>
              句型结构：<b>{g.sentenceType}</b>
            </div>
            <div>
              时态：<b>{g.tense}</b>
            </div>
            {(() => {
              const term = g.terms.find((t) => t.text.toLowerCase() === sel.word.toLowerCase())
              if (!term) return null
              return (
                <div>
                  该词角色：<b>{term.posZh}</b>
                  {term.role ? <span className="text-accent"> · {term.role}</span> : null}
                </div>
              )
            })()}
            {g.engine === 'fallback' && (
              <div className="text-xs text-muted-foreground">（基础分析；联网/加载词法引擎后更精确）</div>
            )}
          </div>
        ) : (
          <div className="text-muted-foreground">暂不可用</div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Button variant={sel.added ? 'secondary' : 'primary'} onClick={onAdd} disabled={sel.added}>
          {sel.added ? <Check className="h-4 w-4" /> : <Star className="h-4 w-4" />}
          {sel.added ? '已加入' : '加入生词本'}
        </Button>
        <Button
          variant="outline"
          onClick={() => void speakFocused(sel.word, false)}
          disabled={!isSpeechSupported()}
        >
          <Volume2 className="h-4 w-4" /> 发音
        </Button>
      </div>
    </div>
  )
}
