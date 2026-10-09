import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  Search,
  Loader2,
  Volume2,
  Mic,
  Square,
  BookOpen,
  Dna,
  Network,
  ScanLine,
  X,
  ChevronUp,
  ChevronDown,
} from 'lucide-react'
import type { ContentWord } from '@/data/types'
import { repository, loadWordDetail, lookupWordVariants, type SearchHit } from '@/data/repository'
import { lookupDictEntries } from '@/domain/dict'
import type { DictEntry } from '@/domain/types'
import {
  parseDefinitionZh,
  bindExamples,
  collectExamples,
  lemmaCandidates,
  exampleKey,
  type WordExample,
} from '@/lib/wordSense'
import { speakFocused, cancelSpeech, isSpeechSupported, SEQUENTIAL_GAP_MS } from '@/lib/speech'
import { useAppStore } from '@/store/useAppStore'
import { addToVocab, removeFromVocab, isInVocab } from '@/domain/learning'
import { EmptyState } from '@/components/ui/empty-state'
import { ExampleRow } from '@/components/word/ExampleRow'
import { WordPopover } from '@/components/word/WordPopover'
import { DictSenseSection } from '@/components/dict/DictSenseSection'
import { useFollowMic } from '@/hooks/useFollowMic'
import {
  IconBack,
  IconForward,
  IconStarMark,
  IconSeqPlay,
  IconExpandCrown,
  IconCollapseBars,
} from '@/components/icons/shushu'
import { cn } from '@/lib/utils'

/**
 * 单词详情页（/word/:word）——本轮按 26 条需求重做
 * ------------------------------------------------------------------
 * 视觉（需求 1 / 2 / 5 / 6 / 7 / 8 / 9）：
 *   1. 顶部搜索框，下方紧接着单词大标题（同一模块内）；
 *   2. 英美音切换放在音标处；
 *   5. 单词模块背景 = EasyMad 渐变（黄 → 绿），色值写死不进主题；
 *   6. 树冠交顶：向下滑动时下方乳白模块的「树冠圆角」变大，
 *      盖住音标 / 播放 / 录音 / 收藏按键，只留单词；点单词进编辑态；
 *   7. 下方乳白底 + 树冠圆角；
 *   8. 分区之间用淡灰横线，无卡片阴影，分区顺序可编辑；
 *   9. 页面自带滚动条（main 滚动）。
 * 交互（需求 3 / 4 / 10 / 11 / 12 / 13 / 14）：
 *   3. 播放 / 录音 / 收藏 / 连续播放全部只留图标（44×44）；
 *   4. 连续播放：逐句朗读所有例句，句间停 SEQUENTIAL_GAP_MS(500ms)；
 *   10. 例句默认 1 条，右侧 9 号展开 / 两条平杠收起；
 *   11. 例句的播放 / 录音在右侧、与句子同行（见 ExampleRow）；
 *   12. 例句完整展示不截断（见 ExampleRow）；
 *   13/14. 词性左（固定宽度列、斜体灰），释义右（正常字体）。
 * 数据红线：音标只有英音来源（见前提卡），切到美音如实显示「未收录」，不编造。
 */

/** 需求 5：EasyMad 渐变，原样照搬，不用主题色改写 */
const EASY_MAD_GRADIENT = 'linear-gradient(to right, rgb(220, 227, 91), rgb(69, 182, 73))'

/**
 * 渐变是亮色底（黄 → 绿），文字必须用深墨绿：
 * hsl(162 45% 14%) 对 rgb(69,182,73) 对比度 ≈ 6.4:1，对 rgb(220,227,91) 更高；
 * 沿用白色会掉到 2:1 以下（不可读）。
 */
const INK_TEXT = 'text-[hsl(162_45%_14%)]'
const INK_SOFT = 'text-[hsl(162_30%_32%)]'

/** 词性固定列：按本词最长词性留位（实测最长 20 字符，这里上限 12ch ≈ 78px，超出换行但列宽不动） */
const POS_COL_MIN_CH = 3
const POS_COL_MAX_CH = 12

/** 分区 key：顺序存本地 state，可上下调（需求 8「可编辑位置」） */
type SectionKey = 'sense' | 'example' | 'morpheme' | 'etymology' | 'network' | 'dictscan'
const DEFAULT_SECTION_ORDER: SectionKey[] = [
  'sense',
  'example',
  'morpheme',
  'etymology',
  'network',
  'dictscan',
]

/* ---------------- 小组件 ---------------- */

/** 分区：无阴影、无边框卡片，靠外层 divide-y 的淡灰横线分隔（需求 8） */
function Section({
  title,
  icon,
  right,
  children,
}: {
  title: string
  icon?: React.ReactNode
  right?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="px-4 py-4">
      <div className="mb-2 flex items-center gap-1.5">
        {icon}
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </h2>
        {right ? <div className="ml-auto flex items-center gap-1">{right}</div> : null}
      </div>
      {children}
    </section>
  )
}

/** 单词模块里的图标按钮：只有图标（需求 3），44×44 触摸目标 */
function IconAction({
  label,
  onClick,
  className,
  children,
}: {
  label: string
  onClick: () => void
  className?: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white/75',
        INK_TEXT,
        className,
      )}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  )
}

/** 小分数标签（单词级跟读） */
function ScoreChip({ score, real }: { score: number; real: boolean }) {
  return (
    <span
      className={cn(
        'shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold',
        score >= 80
          ? 'bg-white/80 text-[hsl(152_56%_32%)]'
          : score >= 60
            ? 'bg-white/80 text-[hsl(38_92%_35%)]'
            : 'bg-white/80 text-[hsl(0_62%_45%)]',
      )}
    >
      {score} 分{!real ? '·模拟' : ''}
    </span>
  )
}

/* ---------------- 页面 ---------------- */

export function WordDetail() {
  const navigate = useNavigate()
  const params = useParams()
  const target = (params.word ?? '').trim()

  const ui = useAppStore((s) => s.wordDetail)
  const enterWordDetail = useAppStore((s) => s.enterWordDetail)
  const setWordDetailPos = useAppStore((s) => s.setWordDetailPos)
  const setWordDetailQuery = useAppStore((s) => s.setWordDetailQuery)
  const setExampleScore = useAppStore((s) => s.setExampleScore)
  const accent = useAppStore((s) => s.settings.accent)
  const slow = useAppStore((s) => s.settings.speed === 'slow')

  const [word, setWord] = useState<ContentWord | undefined | null>(undefined)
  const [inVocab, setInVocab] = useState(false)
  /** 词典扫描库（用户扫描入库的第二套数据）里该词的词条；空数组 = 没扫到 */
  const [dictEntries, setDictEntries] = useState<DictEntry[]>([])

  /* ---- 词条加载 ---- */
  useEffect(() => {
    let alive = true
    setWord(undefined)
    setDictEntries([])
    setPop(null) // 换词时关掉上一个词的弹窗（路由参数变了但组件没卸载）
    if (!target) {
      setWord(null)
      return
    }
    enterWordDetail(target)
    loadWordDetail(target)
      .then((w) => alive && setWord(w))
      .catch(() => alive && setWord(null))
    // 词典扫描库与内置词库相互独立：内置查不到时扫描库可能有（不编造、不冒充）。
    // 2026-10-06 起本地没同步过会回退服务端取词条（lookupDictEntries 内部处理）。
    lookupDictEntries(target)
      .then((rows) => alive && setDictEntries(rows))
      .catch(() => alive && setDictEntries([]))
    return () => {
      alive = false
    }
  }, [target, enterWordDetail])

  useEffect(() => {
    let alive = true
    if (!word) return
    isInVocab(word.id).then((v) => alive && setInVocab(v))
    return () => {
      alive = false
    }
  }, [word])

  /* ---- 释义分组 + 例句绑定（纯函数，见 lib/wordSense.ts） ---- */
  const binding = useMemo(() => {
    if (!word) return null
    const groups = parseDefinitionZh(word.definition_zh ?? word.definition_en)
    const examples = collectExamples(word)
    return { ...bindExamples(groups, examples), examples }
  }, [word])

  /** 例句对象 → 原数组下标（评分存档要稳定下标） */
  const idxOfExample = useMemo(() => {
    const m = new Map<WordExample, number>()
    binding?.examples.forEach((e, i) => m.set(e, i))
    return m
  }, [binding])

  const groups = binding?.groups ?? []
  const posIndex = ui.posIndex >= 0 && ui.posIndex < groups.length ? ui.posIndex : -1
  const showGroups = posIndex === -1 ? groups : groups.slice(posIndex, posIndex + 1)

  /** 需求 13：词性列按本词最长词性留位，位置固定 */
  const posColWidth = useMemo(() => {
    const maxLen = groups.reduce((m, g) => Math.max(m, (g.pos || '释义').length), 0)
    const ch = Math.min(Math.max(maxLen, POS_COL_MIN_CH), POS_COL_MAX_CH)
    return `${ch}ch`
  }, [groups])

  /* ---- 例句（需求 10：默认 1 条，右侧展开 / 收起） ---- */
  const [examplesOpen, setExamplesOpen] = useState(false)
  const exampleList = useMemo(() => {
    if (!binding) return [] as WordExample[]
    if (binding.mode === 'paired') {
      return showGroups.flatMap((g) =>
        g.senses.map((s) => s.example).filter((e): e is WordExample => e !== null),
      )
    }
    return [...binding.pooled]
  }, [binding, showGroups])

  useEffect(() => {
    // 换词 / 切词性后回到默认「只显示一句」
    setExamplesOpen(false)
  }, [target, posIndex])

  const shownExamples = examplesOpen ? exampleList : exampleList.slice(0, 1)

  function scoreOf(index: number): { score: number; real: boolean } | null {
    const s = ui.scores[exampleKey(target, index)]
    if (s === undefined) return null
    return { score: s, real: ui.scoreReal[exampleKey(target, index)] === true }
  }

  /* ---- 顶部搜索（需求 1） ---- */
  const [sug, setSug] = useState<SearchHit[]>([])
  const [sugOpen, setSugOpen] = useState(false)
  useEffect(() => {
    const q = ui.query.trim()
    if (!q) {
      setSug([])
      return
    }
    let alive = true
    const timer = setTimeout(() => {
      repository
        .searchAllWords(q, 8)
        .then((r) => alive && setSug(r))
        .catch(() => alive && setSug([]))
    }, 150)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [ui.query])

  function goWord(w: string) {
    const t = w.trim()
    if (!t) return
    setEditing(false)
    setSugOpen(false)
    setWordDetailQuery('')
    navigate(`/word/${encodeURIComponent(t)}`)
  }

  function submitSearch() {
    const q = ui.query.trim()
    if (!q) return
    goWord(sug[0]?.word ?? q) // 有结果跳第一条，没有就按原样跳（详情页会显示「未收录」）
  }

  /* ---- 单词大标题的编辑态（需求 6：点单词进编辑） ---- */
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState('')
  const editRef = useRef<HTMLInputElement | null>(null)

  function startEdit() {
    setEditValue(word?.word ?? target)
    setEditing(true)
  }

  useEffect(() => {
    if (editing) {
      editRef.current?.focus()
      editRef.current?.select()
    }
  }, [editing])

  /* ---- 例句里点单词 ---- */
  const [pop, setPop] = useState<{ raw: string; rect: DOMRect } | null>(null)
  const [popData, setPopData] = useState<{ data: ContentWord | null; matched: string | null } | null>(
    null,
  )
  const [popLoading, setPopLoading] = useState(false)
  const popSeq = useRef(0)

  function openWord(raw: string, rect: DOMRect) {
    const seq = ++popSeq.current
    setPop({ raw, rect })
    setPopData(null)
    setPopLoading(true)
    lookupWordVariants(lemmaCandidates(raw))
      .then((hit) => {
        if (seq !== popSeq.current) return // 快速连点：丢弃旧结果
        setPopData({ data: hit, matched: hit?.word ?? null })
        setPopLoading(false)
      })
      .catch(() => {
        if (seq !== popSeq.current) return
        setPopData({ data: null, matched: null })
        setPopLoading(false)
      })
  }

  useEffect(() => {
    if (!pop) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPop(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pop])

  /* ---- 树冠交顶（需求 6）：滚动进度 0→1，树冠圆角变大并盖住音标 / 按键行 ---- */
  const [crown, setCrown] = useState(0)
  const coveredRef = useRef<HTMLDivElement | null>(null)
  const popRef = useRef(pop)
  popRef.current = pop

  const handleScroll = useCallback((e: React.UIEvent<HTMLElement>) => {
    const covered = coveredRef.current?.offsetHeight ?? 0
    const p =
      covered > 0 ? Math.min(1, Math.max(0, e.currentTarget.scrollTop / covered)) : 0
    setCrown((prev) => (Math.abs(prev - p) < 0.01 ? prev : p))
    if (popRef.current) setPop(null) // 滚动时收起释义弹窗（坐标会失效）
  }, [])
  /** 树冠圆角随滚动变大：28px → 44px */
  const crownRadius = 28 + Math.round(16 * crown)

  /* ---- 连续朗读全部例句（需求 4） ---- */
  const [seqPlaying, setSeqPlaying] = useState(false)
  const seqRef = useRef(0)
  const seqBusy = useRef(false)

  useEffect(() => {
    return () => {
      seqRef.current++ // 卸载即中止，避免念到一半还在调度
      seqBusy.current = false
    }
  }, [])

  async function playSequentially() {
    // 正在连播 → 再点一次就是停止
    if (seqBusy.current) {
      seqRef.current++
      seqBusy.current = false
      cancelSpeech()
      setSeqPlaying(false)
      return
    }
    const list = exampleList.map((e) => e.en).filter((s) => s && s.trim())
    if (list.length === 0) return
    const seq = ++seqRef.current
    seqBusy.current = true
    setSeqPlaying(true)
    for (const en of list) {
      if (seq !== seqRef.current) return
      await speakFocused(en, slow, undefined, accent)
      if (seq !== seqRef.current) return
      await new Promise((r) => setTimeout(r, SEQUENTIAL_GAP_MS))
    }
    if (seq === seqRef.current) {
      seqBusy.current = false
      setSeqPlaying(false)
    }
  }

  /* ---- 单词级跟读（需求 3 里的「录音」） ---- */
  const wordScoreKey = `${target.toLowerCase()}#word`
  const wordScore =
    ui.scores[wordScoreKey] === undefined
      ? null
      : { score: ui.scores[wordScoreKey], real: ui.scoreReal[wordScoreKey] === true }
  const wordMic = useFollowMic((score, real) => setExampleScore(wordScoreKey, score, real))

  /* ---- 分区顺序（需求 8「可编辑位置」） ---- */
  const [order, setOrder] = useState<SectionKey[]>(DEFAULT_SECTION_ORDER)
  const [sorting, setSorting] = useState(false)

  /**
   * index 是**渲染出来的**下标，不是 order 的下标。
   * 有些分区（词根词缀 / 词源）这个词可能没有数据就不渲染，
   * 直接按 order 下标换会「点了没反应」，所以先在可见分区里定位再换。
   */
  function moveSection(index: number, dir: -1 | 1) {
    const visible = order.filter((k) => defs.some((d) => d.key === k))
    const j = index + dir
    if (index < 0 || index >= visible.length || j < 0 || j >= visible.length) return
    const a = visible[index]
    const b = visible[j]
    setOrder((prev) => {
      const next = [...prev]
      const ia = next.indexOf(a)
      const ib = next.indexOf(b)
      if (ia < 0 || ib < 0) return prev
      ;[next[ia], next[ib]] = [next[ib], next[ia]]
      return next
    })
  }

  function handleBack() {
    // 直接打开 /word/xxx 时没有上一页，退回搜索页而不是点了没反应
    if (window.history.length > 1) navigate(-1)
    else navigate('/search')
  }

  /* ---- 派生：音标（需求 2） ----
   * 数据真相（2026-10-06 起）：内置词库只有单一 ipa 字段，来源是英音（见前提卡）；
   * 美音音标没有数据来源 —— 只标「英音」，不做英/美切换按钮（没有的数据不提供入口）。
   * 内置查不到但扫描库有该词时，顶部显示扫描词条的音标（原书未标口音，不猜）。 */
  const ipaText = word?.ipa
    ? `/${word.ipa}/`
    : word
      ? '音标未收录'
      : (dictEntries[0]?.phonetic ?? '')

  /* ---- 加载 / 空态 ---- */
  if (!target) {
    return (
      <div className="app-frame flex min-h-screen flex-col">
        <EmptyState icon={Search} title="缺少单词" description="请从搜索页或例句里点进一个单词。" />
      </div>
    )
  }

  /* ---- 分区内容 ---- */
  type SectionDef = { key: SectionKey; title: string; icon?: React.ReactNode; right?: React.ReactNode; body: React.ReactNode }
  const defs: SectionDef[] = []

  if (word) {
    defs.push({
      key: 'sense',
      title: '释义',
      body: (
        <>
          {groups.length > 1 ? (
            <div className="mb-3 flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => setWordDetailPos(-1)}
                className={cn(
                  'rounded-full px-3 py-1 text-xs font-medium transition-colors',
                  posIndex === -1
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-secondary text-secondary-foreground',
                )}
              >
                全部
              </button>
              {groups.map((g, i) => (
                <button
                  key={`${g.pos}-${i}`}
                  type="button"
                  onClick={() => setWordDetailPos(i)}
                  className={cn(
                    'rounded-full px-3 py-1 text-xs font-medium italic transition-colors',
                    posIndex === i
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-secondary text-secondary-foreground',
                  )}
                >
                  {g.pos || '释义'}
                </button>
              ))}
            </div>
          ) : null}

          <div className="space-y-3">
            {showGroups.map((g, gi) => (
              <div key={`${g.pos}-${gi}`} className="flex items-start gap-3">
                {/* 需求 13/14：词性固定列 + 斜体灰；释义右侧正常字体 */}
                <div
                  className="shrink-0 text-[13px] italic leading-relaxed text-muted-foreground"
                  style={{ width: posColWidth }}
                >
                  {g.pos || '释义'}
                </div>
                <ul className="min-w-0 flex-1 space-y-1.5">
                  {g.senses.map((s, si) => (
                    <li key={si} className="text-[15px] leading-relaxed text-foreground">
                      {s.sense}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          {groups.length === 0 ? (
            <p className="text-sm text-muted-foreground">这个词条还没有释义数据。</p>
          ) : null}
        </>
      ),
    })

    if (exampleList.length > 0) {
      defs.push({
        key: 'example',
        title: `例句（${exampleList.length}）`,
        // 需求 10：展开 / 收起图标放右边
        right:
          exampleList.length > 1 ? (
            <button
              type="button"
              onClick={() => setExamplesOpen((o) => !o)}
              className="flex h-11 w-11 items-center justify-center rounded-full bg-secondary text-primary"
              aria-label={examplesOpen ? '收起例句' : `展开全部 ${exampleList.length} 条例句`}
              title={examplesOpen ? '收起例句' : `展开全部 ${exampleList.length} 条例句`}
            >
              {examplesOpen ? (
                <IconCollapseBars className="h-5 w-5" />
              ) : (
                <IconExpandCrown className="h-5 w-5" />
              )}
            </button>
          ) : null,
        body: (
          <>
            <div className="divide-y divide-border">
              {shownExamples.map((ex) => {
                const i = idxOfExample.get(ex) ?? 0
                const sc = scoreOf(i)
                return (
                  <ExampleRow
                    key={i}
                    en={ex.en}
                    zh={ex.zh}
                    index={i}
                    score={sc?.score ?? null}
                    realScore={sc?.real ?? false}
                    onScore={(v, real) => setExampleScore(exampleKey(target, i), v, real)}
                    onWordClick={openWord}
                    activeWord={pop?.raw ?? null}
                  />
                )
              })}
            </div>
            {binding?.mode === 'pooled' ? (
              <p className="mt-2 text-[11px] text-muted-foreground">
                例句未标注对应释义，集中展示
              </p>
            ) : null}
          </>
        ),
      })
    }

    if (word.morphemes?.length) {
      defs.push({
        key: 'morpheme',
        title: '词根词缀',
        icon: <Dna className="h-3.5 w-3.5" />,
        body: (
          <ul className="space-y-1 text-sm">
            {word.morphemes.map((m, i) => (
              <li key={i}>
                <span className="rounded bg-secondary px-1.5 py-0.5 font-medium text-secondary-foreground">
                  {m.form}
                </span>
                <span className="ml-1.5 text-foreground">{m.meaning}</span>
                {m.note ? (
                  <span className="ml-1 text-[11px] text-muted-foreground">（{m.note}）</span>
                ) : null}
              </li>
            ))}
          </ul>
        ),
      })
    }

    if (word.etymology) {
      defs.push({
        key: 'etymology',
        title: '词源',
        icon: <BookOpen className="h-3.5 w-3.5" />,
        body: <p className="text-sm leading-relaxed text-foreground">{word.etymology}</p>,
      })
    }

    if (word.related?.length || word.antonyms?.length || word.relatives?.length) {
      defs.push({
        key: 'network',
        title: '知识网络',
        icon: <Network className="h-3.5 w-3.5" />,
        body: (
          <div className="space-y-2 text-sm">
            {word.related?.length ? (
              <div>
                <span className="text-muted-foreground">关联词：</span>
                {word.related.map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => goWord(r)}
                    className="mr-1.5 rounded bg-secondary px-1.5 py-0.5 text-secondary-foreground"
                  >
                    {r}
                  </button>
                ))}
              </div>
            ) : null}
            {word.relatives?.length ? (
              <div>
                <span className="text-muted-foreground">同根词：</span>
                {word.relatives.map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => goWord(r)}
                    className="mr-1.5 rounded bg-secondary px-1.5 py-0.5 text-secondary-foreground"
                  >
                    {r}
                  </button>
                ))}
              </div>
            ) : null}
            {word.antonyms?.length ? (
              <div>
                <span className="text-muted-foreground">反义词：</span>
                {word.antonyms.map((a) => (
                  <button
                    key={a.term}
                    type="button"
                    onClick={() => goWord(a.term)}
                    className="mr-1.5 rounded bg-secondary px-1.5 py-0.5 text-secondary-foreground"
                  >
                    {a.term}
                    <span className="ml-0.5 text-[10px] text-muted-foreground">{a.rating}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ),
      })
    }
  }

  // 词典扫描分区：内置词库有没有都展示（内置查不到时它就是唯一的释义来源）
  if (dictEntries.length > 0) {
    defs.push({
      key: 'dictscan',
      title: `词典扫描（${dictEntries.length}）`,
      icon: <ScanLine className="h-3.5 w-3.5" />,
      body: (
        <DictSenseSection
          entries={dictEntries}
          onWordClick={openWord}
          activeWord={pop?.raw ?? null}
        />
      ),
    })
  }

  const ordered = order
    .map((k) => defs.find((d) => d.key === k))
    .filter((d): d is SectionDef => Boolean(d))

  return (
    <main className="app-frame flex h-full flex-col overflow-y-auto" onScroll={handleScroll}>
      {/* ===== 单词模块（需求 5：EasyMad 渐变）===== */}

      {/* 吸顶层：返回 + 搜索框 + 单词大标题（滚动到最上面时仍可见，需求 6） */}
      <div
        className="sticky top-0 z-30 shrink-0"
        style={{ background: EASY_MAD_GRADIENT }}
      >
        <div className="safe-top px-3 pb-2 pt-2">
          {/* 第一行：返回（5 号）+ 搜索框（需求 1 / 18） */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleBack}
              className={cn(
                'flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white/75',
                INK_TEXT,
              )}
              aria-label="返回上一页"
              title="返回上一页"
            >
              <IconBack className="h-5 w-5" />
            </button>
            <div className="relative min-w-0 flex-1">
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  submitSearch()
                }}
                className="flex items-center gap-2 rounded-xl bg-white/95 px-3 py-2"
              >
                <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
                <input
                  value={ui.query}
                  onChange={(e) => {
                    setWordDetailQuery(e.target.value)
                    setSugOpen(true)
                  }}
                  onFocus={() => setSugOpen(true)}
                  placeholder="搜个新单词…"
                  className="w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
                />
                {ui.query ? (
                  <button
                    type="button"
                    onClick={() => {
                      setWordDetailQuery('')
                      setSugOpen(false)
                    }}
                    className="shrink-0 text-muted-foreground"
                    aria-label="清空搜索"
                    title="清空"
                  >
                    <X className="h-4 w-4" />
                  </button>
                ) : null}
              </form>

              {/* 模糊结果：挂在搜索框下方 */}
              {sugOpen && ui.query.trim() !== '' ? (
                <div className="absolute left-0 right-0 top-full z-40 mt-1 max-h-72 overflow-y-auto rounded-xl border border-border bg-card shadow-soft">
                  {sug.length === 0 ? (
                    <p className="px-3 py-2.5 text-xs text-muted-foreground">
                      没有匹配的单词，回车可直接查看「{ui.query.trim()}」
                    </p>
                  ) : (
                    <ul>
                      {sug.map((h) => (
                        <li key={h.id}>
                          <button
                            type="button"
                            onClick={() => goWord(h.word)}
                            className="flex w-full items-baseline gap-2 px-3 py-2.5 text-left hover:bg-secondary/60"
                          >
                            <span className="text-sm font-medium text-foreground">{h.word}</span>
                            {h.ipa ? (
                              <span className="text-[11px] text-muted-foreground">/{h.ipa}/</span>
                            ) : null}
                            {h.pos ? (
                              <span className="text-[11px] text-muted-foreground">{h.pos}</span>
                            ) : null}
                            <span className="ml-auto max-w-[45%] truncate text-[11px] text-muted-foreground">
                              {h.zh}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : null}
            </div>
          </div>

          {/* 第二行：单词大标题（需求 1）；点击进编辑态（需求 6） */}
          <div className="mt-1 flex min-w-0 items-center gap-2">
            {editing ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  goWord(editValue)
                }}
                className="flex min-w-0 flex-1 items-center gap-1.5"
              >
                <input
                  ref={editRef}
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  placeholder="输入单词"
                  className="min-w-0 flex-1 rounded-lg bg-white/95 px-2 py-1 text-2xl font-bold text-foreground outline-none"
                  aria-label="编辑单词"
                  title="改完回车查询"
                />
                <button
                  type="submit"
                  className={cn(
                    'flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white/75',
                    INK_TEXT,
                  )}
                  aria-label="查询这个单词"
                  title="查询这个单词"
                >
                  <IconForward className="h-5 w-5" />
                </button>
                <button
                  type="button"
                  onClick={() => setEditing(false)}
                  className={cn(
                    'flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white/60',
                    INK_TEXT,
                  )}
                  aria-label="取消编辑"
                  title="取消"
                >
                  <X className="h-4 w-4" />
                </button>
              </form>
            ) : (
              <button
                type="button"
                onClick={startEdit}
                className={cn('flex min-w-0 items-baseline gap-2 rounded-lg px-1 py-1 text-left', INK_TEXT)}
                aria-label="编辑这个单词"
                title="点击编辑 / 换个词"
              >
                <span className="truncate text-[28px] font-bold leading-tight">
                  {word?.word ?? target}
                </span>
                {word?.book ? (
                  <span className="shrink-0 rounded-full bg-black/10 px-2 py-0.5 text-[11px]">
                    {word.book}
                  </span>
                ) : null}
              </button>
            )}
            {wordScore ? (
              <ScoreChip score={wordScore.score} real={wordScore.real} />
            ) : null}
          </div>
        </div>
      </div>

      {/* 可交顶区：音标 + 英美切换 + 图标按钮（滚动时被下方树冠盖住，需求 6） */}
      <div
        ref={coveredRef}
        className="relative z-10 shrink-0 px-3 pb-4"
        style={{ background: EASY_MAD_GRADIENT }}
      >
        {/* 音标：只标真实存在的口音（内置词库来源为英音）；没有切换按钮（需求 2） */}
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className={cn('text-[15px]', word?.ipa ? INK_TEXT : INK_SOFT)}>
            {word === undefined ? '正在读取词条…' : ipaText}
          </span>
          {word?.ipa && (
            <span
              className="shrink-0 rounded-full bg-white/70 px-2 py-0.5 text-[11px] font-medium text-foreground/70"
              title="内置词库音标来源为英音"
            >
              英音
            </span>
          )}
        </div>

        {/* 图标按钮组：只有图标（需求 3）+ 连续播放（需求 4） */}
        <div className="mt-2 flex items-center gap-2">
          <IconAction
            label="朗读这个单词"
            onClick={() => void speakFocused(word?.word ?? target, slow, undefined, accent)}
          >
            <Volume2 className="h-[18px] w-[18px]" />
          </IconAction>

          <IconAction
            label={
              wordMic.phase === 'recording'
                ? '停止录音并评分'
                : wordMic.phase === 'recognizing'
                  ? '正在识别'
                  : '跟读这个单词并评分'
            }
            onClick={() => void wordMic.toggle(word?.word ?? target)}
            className={cn(
              wordMic.phase === 'recording'
                ? 'bg-destructive text-white'
                : wordMic.phase === 'recognizing'
                  ? 'bg-primary text-white'
                  : '',
            )}
          >
            {wordMic.phase === 'recognizing' ? (
              <Loader2 className="h-[18px] w-[18px] animate-spin" />
            ) : wordMic.phase === 'recording' ? (
              <Square className="h-4 w-4" />
            ) : (
              <Mic className="h-[18px] w-[18px]" />
            )}
          </IconAction>

          <IconAction
            label={seqPlaying ? '停止连续播放' : '连续朗读全部例句'}
            onClick={() => void playSequentially()}
            className={cn(seqPlaying ? 'bg-primary text-white' : '')}
          >
            {seqPlaying ? (
              <Loader2 className="h-[18px] w-[18px] animate-spin" />
            ) : (
              <IconSeqPlay className="h-[18px] w-[18px]" />
            )}
          </IconAction>

          <IconAction
            label={inVocab ? '已收藏，点击取消' : '加入生词本'}
            onClick={() => {
              if (!word) return
              // 需求 17：实心橙=已收藏，空心=未收藏；再点一次真的从生词本里移除
              if (inVocab) {
                void removeFromVocab(word.id).then(() => setInVocab(false))
                return
              }
              void addToVocab({
                id: word.id,
                word: word.word,
                book: word.book,
                ipa: word.ipa,
                definition_zh: word.definition_zh,
                pos: word.pos,
              }).then(() => setInVocab(true))
            }}
            className={cn(inVocab ? 'text-accent' : '')}
          >
            <IconStarMark filled={inVocab} className="h-[18px] w-[18px]" />
          </IconAction>

          {wordMic.msg ? <span className={cn('text-[11px]', INK_SOFT)}>{wordMic.msg}</span> : null}
        </div>
      </div>

      {/* ===== 详情模块：乳白 + 树冠圆角（需求 6 / 7 / 8） ===== */}
      <div
        className="relative z-20 flex-1 bg-cream pb-10"
        style={{
          borderTopLeftRadius: crownRadius,
          borderTopRightRadius: crownRadius,
        }}
      >
        {/* 分区顺序可编辑（需求 8） */}
        <div className="flex items-center justify-between px-4 pb-1 pt-3">
          <span className="text-[11px] text-muted-foreground">
            {sorting ? '用上下箭头调整分区顺序' : `共 ${ordered.length} 个分区`}
          </span>
          <button
            type="button"
            onClick={() => setSorting((s) => !s)}
            className="flex h-8 items-center gap-1 rounded-full bg-secondary px-3 text-xs text-secondary-foreground"
            aria-label={sorting ? '完成排序' : '调整分区顺序'}
            title={sorting ? '完成排序' : '调整分区顺序'}
          >
            {sorting ? '完成' : '排序'}
          </button>
        </div>

        <div className="divide-y divide-border">
          {word === undefined ? (
            <div className="flex items-center gap-1.5 px-4 py-6 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> 正在读取词条…
            </div>
          ) : word === null ? (
            /* 内置词库没有这个词：扫描库里扫到过就展示扫描数据，不再报「没有」 */
            ordered.filter((d) => d.key === 'dictscan').length > 0 ? (
              ordered
                .filter((d) => d.key === 'dictscan')
                .map((d) => (
                  <Section key={d.key} title={d.title} icon={d.icon}>
                    {d.body}
                  </Section>
                ))
            ) : (
              <div className="px-4 py-6">
                <EmptyState
                  icon={Search}
                  title="该词暂未收录"
                  description="内置词库与词典扫描库都没有这个词。可能是拼写不同，或还没收录；新扫描的词典页确认入库后即可查看。"
                />
              </div>
            )
          ) : (
            ordered.map((d, i) => (
              <Section
                key={d.key}
                title={d.title}
                icon={d.icon}
                right={
                  sorting ? (
                    <>
                      <button
                        type="button"
                        onClick={() => moveSection(i, -1)}
                        disabled={i === 0}
                        className="flex h-11 w-11 items-center justify-center rounded-full bg-secondary text-secondary-foreground disabled:opacity-30"
                        aria-label={`把「${d.title}」上移`}
                        title="上移"
                      >
                        <ChevronUp className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => moveSection(i, 1)}
                        disabled={i === ordered.length - 1}
                        className="flex h-11 w-11 items-center justify-center rounded-full bg-secondary text-secondary-foreground disabled:opacity-30"
                        aria-label={`把「${d.title}」下移`}
                        title="下移"
                      >
                        <ChevronDown className="h-4 w-4" />
                      </button>
                    </>
                  ) : (
                    d.right
                  )
                }
              >
                {d.body}
              </Section>
            ))
          )}
        </div>
      </div>

      {/* 例句里点单词的小弹窗 */}
      {pop ? (
        <WordPopover
          raw={pop.raw}
          matched={popData?.matched ?? null}
          data={popData?.data ?? null}
          loading={popLoading}
          rect={pop.rect}
          onClose={() => setPop(null)}
          onDetail={goWord}
        />
      ) : null}
    </main>
  )
}
