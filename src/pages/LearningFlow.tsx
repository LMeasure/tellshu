import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useNavigate } from 'react-router-dom'
import { ChevronLeft, Hand, Layers, PartyPopper, RotateCcw, Sparkles } from 'lucide-react'
import { Progress } from '@/components/ui/progress'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorState } from '@/components/ui/error-state'
import { Skeleton } from '@/components/ui/skeleton'
import { Dialog } from '@/components/ui/dialog'
import { WordCard } from '@/components/learning/WordCard'
import { repository, sortWords } from '@/data/repository'
import { bucketByDifficulty } from '@/lib/diagnostic'
import { useAppStore } from '@/store/useAppStore'
import { addManyToVocab, getLayerCounts } from '@/domain/learning'
import { useSwipeSwitch } from '@/hooks/useSwipeSwitch'
import {
  applyMove,
  completedCount,
  groupOf,
  isFinished,
  isLastGroup,
  isLastInGroup,
  loadOrCreateSession,
  markCurrentCompleted,
  remainingCount,
  restart,
  saveSession,
  type WordLearningLevel,
  type WordLearningSession,
} from '@/domain/wordLearning'
import type { ContentWord, DifficultyLevel } from '@/data/types'

/**
 * 完成一轮的鼓励语。按「第几轮」取，同一轮重复打开看到的是同一句，
 * 轮次推进自然换一句 —— 不用随机数，避免刷新就跳字。
 */
const ENCOURAGE = [
  '万事开头难，最难的那一步你已经走完了。',
  '每天一点点，比一次猛学一整天更管用。',
  '这些词已经进了生词本，明天复习一次就稳了。',
  '能坚持走完一轮，词汇量已经在涨了。',
  '别急着赶进度，真正记住的才是你自己的。',
]

interface RoundResult {
  /** 本轮词数 */
  total: number
  /** 本次新进生词本的词数 */
  added: number
  /** 原本就在生词本里的（不重置其进度） */
  existed: number
  /** 生词本现有总词数 */
  vocabTotal: number
}

type Phase = 'loading' | 'ready' | 'empty' | 'error'

/**
 * 学习流程（见 04 §2.4、05 §2.4）：单词卡浏览 → 点读/跟读（卡片内完成），
 * 整轮学完由 finishRound 自动加入生词本（卡片上不提供手动收藏）。
 * 支持：
 *   ?book=CET4        指定词本（默认第一本）
 *   ?level=1          只学该难度档（由学习路径带过来）
 *
 * 2026-10-31 三处改动（用户拍板）：
 *  1. **进度持久化**：队列顺序 / 当前位置 / 已完成集合落在本地库
 *     （domain/wordLearning.ts），退出、刷新、重进都从上次中断处继续；
 *     「重学」是唯一会清进度入口，且必须用户显式确认。
 *  2. **左右滑动**取代「上一张 / 下一张」按钮（真实 Pointer 拖拽，
 *     轴向锁定 + 阈值 + 冷却，长内容上下滚不会误切）。
 *  3. **布局自适应**：去掉 min-h-screen 与卡片外层 flex-1，内容多高页面就多高，
 *     不再强撑一屏、不再在底部留大块空白。
 * 每轮词数取设置里的 studyBatchSize，分组推进；改设置立即生效（位置不动）。
 */
export function LearningFlow() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const bookParam = params.get('book')
  const levelParam = params.get('level')

  const batchSize = useAppStore((s) => s.settings.studyBatchSize)

  const [phase, setPhase] = useState<Phase>('loading')
  const [errorMessage, setErrorMessage] = useState('')
  /** 已排序的完整词表（队列的内容来源，只按 book/level 变化重载） */
  const [allWords, setAllWords] = useState<ContentWord[]>([])
  /** 持久化会话（null = 还没读到；进度一律以它为准，不另存内存副本） */
  const [session, setSession] = useState<WordLearningSession | null>(null)
  /** 一轮学完的结算弹窗（null = 不弹） */
  const [roundResult, setRoundResult] = useState<RoundResult | null>(null)
  const [saving, setSaving] = useState(false)
  /** 重学确认：null = 不弹 */
  const [restartAsk, setRestartAsk] = useState<'group' | 'all' | null>(null)
  /** 切换动画：key 变化触发重挂载，dir 决定进场方向 */
  const [anim, setAnim] = useState<{ key: number; dir: 1 | -1 | null }>({ key: 0, dir: null })
  /** 边界轻提示（第一张右滑 / 最后一张左滑）：2s 后自动淡出 */
  const [edgeHint, setEdgeHint] = useState<string | null>(null)
  /** 手势提示是否已展示过（写进会话，只提示一次） */
  const [reloadKey, setReloadKey] = useState(0)

  /** sessionRef 与 session 同步：手势连发时用它取最新值，避免闭包读到旧状态 */
  const sessionRef = useRef<WordLearningSession | null>(null)
  useEffect(() => {
    sessionRef.current = session
  }, [session])

  const edgeTimer = useRef<number | null>(null)
  function flashEdge(text: string) {
    setEdgeHint(text)
    if (edgeTimer.current) window.clearTimeout(edgeTimer.current)
    edgeTimer.current = window.setTimeout(() => setEdgeHint(null), 1600)
  }
  useEffect(
    () => () => {
      if (edgeTimer.current) window.clearTimeout(edgeTimer.current)
    },
    [],
  )

  /* ---------------- 载入：词表 + 持久化会话 ---------------- */
  useEffect(() => {
    let active = true
    setPhase('loading')
    setSession(null)
    setAllWords([])
    void (async () => {
      try {
        const bs = await repository.getBookIndex()
        if (!active) return
        const id = bookParam && bs.some((b) => b.id === bookParam) ? bookParam : (bs[0]?.id ?? 'CET4')
        const raw = await repository.getWords(id)
        if (!active) return
        let pool = raw
        const lv = Number(levelParam)
        if (lv === 1 || lv === 2 || lv === 3) {
          // 按真实特征分档（词长 + 语素），与诊断/路径口径一致
          const picked = bucketByDifficulty(raw)[lv as DifficultyLevel]
          const ids = new Set(picked.map((w) => w.id))
          pool = raw.filter((w) => ids.has(w.id))
        }
        const sorted = sortWords(pool)
        if (!active) return
        if (sorted.length === 0) {
          setAllWords([])
          setPhase('empty')
          return
        }
        const level: WordLearningLevel = lv === 1 || lv === 2 || lv === 3 ? (lv as 1 | 2 | 3) : null
        const res = await loadOrCreateSession({
          book: id,
          level,
          words: sorted,
          batchSize,
        })
        if (!active) return
        setAllWords(sorted)
        setSession(res.session)
        setPhase('ready')
      } catch (err) {
        if (!active) return
        setErrorMessage(err instanceof Error ? err.message : String(err))
        setPhase('error')
      }
    })()
    return () => {
      active = false
    }
  }, [bookParam, levelParam, reloadKey])

  /* 每批词数改了：只改分组口径，当前位置一个字都不动 */
  useEffect(() => {
    const prev = sessionRef.current
    if (!prev) return
    const size = Math.max(1, Math.trunc(batchSize) || 1)
    if (size === prev.batch_size) return
    const next = { ...prev, batch_size: size }
    sessionRef.current = next
    setSession(next)
    void saveSession(next)
  }, [batchSize, session])

  /* ---------------- 进度推进 ---------------- */

  /** 唯一写入口：内存态与库同时更新（库写失败不阻断使用，内存态仍连贯） */
  const commit = useCallback((next: WordLearningSession) => {
    sessionRef.current = next
    setSession(next)
    void saveSession(next).catch((err) => {
      console.error('[learning] 学习进度保存失败', err)
    })
  }, [])

  const move = useCallback(
    (dir: 1 | -1) => {
      const prev = sessionRef.current
      if (!prev) return
      const next = applyMove(prev, dir)
      if (next === prev) {
        flashEdge(dir === 1 ? '已经是最后一个词了' : '已经是第一个词了')
        return
      }
      setAnim((a) => ({ key: a.key + 1, dir }))
      // 第一次成功切换 = 用户已经知道怎么滑了，提示就此收起（写进会话，只提示一次）
      commit(next.gesture_hinted ? next : { ...next, gesture_hinted: true })
    },
    [commit],
  )

  /**
   * 手势 / 键盘触发的「下一个 / 上一个」。
   * 组内最后一张再往左滑 = 结算本轮（等价原来的「完成本轮」按钮），
   * 不会越界推进、也不会出现空白卡片。
   */
  function handleSwitch(dir: 1 | -1) {
    const prev = sessionRef.current
    if (phase !== 'ready' || !prev) return
    if (dir === 1 && isLastInGroup(prev)) {
      void finishRound()
      return
    }
    move(dir)
  }

  const swipeRef = useSwipeSwitch({
    onSwitch: handleSwitch,
    enabled: phase === 'ready' && roundResult === null && restartAsk === null,
  })

  /* PC 浏览器：方向键等价于左右滑 */
  useEffect(() => {
    if (phase !== 'ready') return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && /^(input|textarea|select)$/i.test(t.tagName)) return
      if (e.key === 'ArrowRight') handleSwitch(1)
      else if (e.key === 'ArrowLeft') handleSwitch(-1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, session])

  /* ---------------- 派生数据 ---------------- */

  /**
   * 内容按 id 回查词包：**下标只用于定位队列位置，取词一律按 id**。
   * 这样即使个别 id 在词包里已查不到（被自动剔除），也不会出现
   * 「下标错位 → 拿错词 / 拿不到词 → 空白卡片」。
   */
  const byId = useMemo(() => {
    const m = new Map<string, ContentWord>()
    for (const w of allWords) if (w.id && !m.has(w.id)) m.set(w.id, w)
    return m
  }, [allWords])

  const group = useMemo(() => (session ? groupOf(session) : null), [session])
  const groupIds = useMemo(
    () => (session && group ? session.queue.slice(group.start, group.end) : []),
    [session, group],
  )
  const groupWords = useMemo(
    () => groupIds.map((id) => byId.get(id)).filter((w): w is ContentWord => Boolean(w)),
    [groupIds, byId],
  )
  const currentId = session ? (session.queue[session.position] ?? null) : null
  const current = currentId ? (byId.get(currentId) ?? null) : null
  /** 组内下标（0-based）；极端情况下该词被剔除则退化为 0，绝不越界 */
  const rawIndexInGroup = currentId ? groupIds.indexOf(currentId) : 0
  const indexInGroup = rawIndexInGroup >= 0 ? rawIndexInGroup : 0

  const isLast = session ? isLastInGroup(session) : false
  const lastGroup = session ? isLastGroup(session) : false
  const done = session ? isFinished(session) : false
  const learned = session ? completedCount(session) : 0
  const remaining = session ? remainingCount(session) : 0

  /**
   * 结束一轮：把本轮的词**自动加入生词本**（layer=new，10min 后首次复习），
   * 之后就交给「生词 → 运用 → 掌握」的 SRS 闯关逻辑推进。
   * 已经在生词本里的不会被重置（addManyToVocab 保证）。
   */
  async function finishRound() {
    const prev = sessionRef.current
    if (!prev || saving) return
    setSaving(true)
    try {
      const res = await addManyToVocab(
        groupWords.map((w) => ({
          id: w.id,
          word: w.word,
          book: w.book,
          ipa: w.ipa,
          definition_zh: w.definition_zh,
          pos: w.pos,
        })),
      )
      const counts = await getLayerCounts()
      // 结算 = 当前这个词也学完了（幂等：已在 completed 里不会重复记）
      commit(markCurrentCompleted(prev))
      setRoundResult({
        total: groupWords.length,
        added: res.added,
        existed: res.existed,
        vocabTotal: counts.total,
      })
    } finally {
      setSaving(false)
    }
  }

  /** 结算弹窗里「继续下一组」：跨组前进一步（并补记当前词完成） */
  function nextGroup() {
    const prev = sessionRef.current
    setRoundResult(null)
    if (!prev) return
    const next = applyMove(markCurrentCompleted(prev), 1)
    if (next === prev) return
    setAnim((a) => ({ key: a.key + 1, dir: 1 }))
    commit(next)
  }

  /** 重学（唯一清进度的路径，需用户在上一步弹窗里明确选择范围） */
  function doRestart(scope: 'group' | 'all') {
    const prev = sessionRef.current
    setRestartAsk(null)
    if (!prev) return
    const next = restart({ ...prev, gesture_hinted: true }, scope)
    setAnim((a) => ({ key: a.key + 1, dir: -1 }))
    commit(next)
    flashEdge(scope === 'all' ? '已从整本第一词重新开始' : '已从本组第一词重新开始')
  }

  /* ---------------- 渲染 ---------------- */

  if (phase === 'loading') {
    return (
      <div className="px-4 py-4">
        <Skeleton className="mb-3 h-2 w-full" />
        <Skeleton className="mb-4 h-3 w-40" />
        <div className="rounded-lg bg-card p-5 shadow-soft">
          <Skeleton className="mb-3 h-8 w-32" />
          <Skeleton className="mb-2 h-4 w-24" />
          <Skeleton className="mb-4 h-5 w-full" />
          <Skeleton className="mb-2 h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </div>
        <p className="mt-3 text-xs text-muted-foreground">正在读取学习进度…</p>
      </div>
    )
  }

  if (phase === 'error') {
    return (
      <ErrorState
        message={errorMessage || '学习内容加载失败'}
        onRetry={() => setReloadKey((k) => k + 1)}
      />
    )
  }

  if (phase === 'empty' || !session || !group) {
    return (
      <EmptyState
        icon={Sparkles}
        title="学习内容待接入"
        description="知识卡由 OpenEtymology 词包驱动，前端按字段自动渲染。"
      />
    )
  }

  const groupSize = Math.max(1, group.end - group.start)
  const hinted = session.gesture_hinted === true

  return (
    <div className="px-4 py-4">
      {/* 顶部：返回 / 组内进度 / 计数 / 重学 */}
      <div className="mb-2 flex items-center gap-2">
        <button
          onClick={() => navigate(-1)}
          className="shrink-0 text-muted-foreground"
          aria-label="返回"
          title="返回"
        >
          <ChevronLeft className="h-6 w-6" />
        </button>
        <Progress
          value={((indexInGroup + 1) / groupSize) * 100}
          className="mx-1 flex-1"
        />
        <span className="shrink-0 text-xs text-muted-foreground">
          {indexInGroup + 1}/{groupSize}
        </span>
        <button
          onClick={() => setRestartAsk('group')}
          className="shrink-0 text-muted-foreground"
          aria-label="重新学习"
          title="重新学习"
        >
          <RotateCcw className="h-5 w-5" />
        </button>
      </div>

      <div className="mb-3 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <Layers className="h-3.5 w-3.5" />
          第 {group.index + 1} / {group.total} 组
        </span>
        <span>·</span>
        <span>已学 {learned}</span>
        <span>·</span>
        <span>剩余 {remaining}</span>
      </div>

      {/* 手势区：touch-pan-y —— 横滑切词，竖滑照常看长内容 */}
      <div ref={swipeRef} className="touch-pan-y">
        <div
          key={anim.key}
          className={
            anim.dir === 1 ? 'wl-in-right' : anim.dir === -1 ? 'wl-in-left' : undefined
          }
          data-testid="word-card-slot"
          data-word={current?.word ?? ''}
        >
          {current ? (
            <WordCard word={current} />
          ) : (
            <EmptyState
              icon={Sparkles}
              title="这个词已不在当前词包里"
              description="学习队列已自动去掉失效的词，继续滑动即可到下一个词。"
            />
          )}
        </div>
      </div>

      {/* 手势提示 + 边界提示（自然占位，不遮内容） */}
      <div className="mt-3 min-h-[20px] text-center text-xs text-muted-foreground">
        {edgeHint ? (
          <span data-testid="swipe-hint">{edgeHint}</span>
        ) : !hinted ? (
          <span data-testid="swipe-hint" className="flex items-center justify-center gap-1">
            <Hand className="h-3.5 w-3.5" /> 左滑下一个单词 · 右滑上一个单词
          </span>
        ) : null}
      </div>

      {/* 组内最后一张：保留一个明确的结算入口（不是「下一张」，是「本轮学完」） */}
      {isLast && !done && (
        <Button className="mt-2 w-full" disabled={saving} onClick={() => void finishRound()}>
          {lastGroup ? '学完了' : '完成本轮'}
        </Button>
      )}

      {done && (
        <div className="mt-3 rounded-lg bg-secondary/60 px-3 py-3 text-sm text-secondary-foreground">
          <p className="font-medium">这一本已经学完了（共 {session.queue.length} 词）。</p>
          <p className="mt-1 text-xs">想再过一遍就点右上角「重新学习」，或去生词本闯关巩固。</p>
          <Button
            variant="primary"
            size="sm"
            className="mt-2 w-full"
            onClick={() => navigate('/review')}
          >
            <Sparkles className="h-4 w-4" /> 去生词本闯关
          </Button>
        </div>
      )}

      {/* 一轮学完：鼓励 + 真实结算（不编造数字） */}
      <Dialog
        open={roundResult !== null}
        onClose={() => setRoundResult(null)}
        title={
          <span className="flex items-center justify-center gap-1.5">
            <PartyPopper className="h-5 w-5 text-accent" /> 这一轮学完了
          </span>
        }
        footer={
          <>
            {lastGroup ? (
              <Button variant="primary" className="w-full" onClick={() => navigate('/review')}>
                <Sparkles className="h-4 w-4" /> 去生词本闯关
              </Button>
            ) : (
              <Button variant="primary" className="w-full" onClick={nextGroup}>
                继续下一组
              </Button>
            )}
            {lastGroup ? (
              <Button variant="outline" className="w-full" onClick={() => setRoundResult(null)}>
                留在这里
              </Button>
            ) : (
              /* 「完成」= 回主页：烟花挂 Home 播放（放学习页会被导航卸载，见 Home.tsx） */
              <Button
                variant="outline"
                className="w-full"
                onClick={() => {
                  setRoundResult(null)
                  navigate('/', { state: { firework: true } })
                }}
              >
                完成
              </Button>
            )}
          </>
        }
      >
        {roundResult && (
          <div className="space-y-2">
            <p className="text-base font-medium text-foreground">
              {ENCOURAGE[group.index % ENCOURAGE.length]}
            </p>
            <p>
              本轮 {roundResult.total} 词已加入生词本
              {roundResult.existed > 0 && `（其中 ${roundResult.existed} 个之前就在）`}
            </p>
            <p className="text-xs">
              生词本现有 {roundResult.vocabTotal} 词 · 接下来按
              <b className="text-foreground">生词 → 运用 → 掌握</b> 的节奏复习
            </p>
          </div>
        )}
      </Dialog>

      {/* 重学确认：清进度必须走这一步，绝不把「普通进入页面」当成重新开始 */}
      <Dialog
        open={restartAsk !== null}
        onClose={() => setRestartAsk(null)}
        title="重新学习"
        footer={
          <>
            <Button variant="outline" className="w-full" onClick={() => doRestart('group')}>
              只重学本组（{groupSize} 词）
            </Button>
            <Button variant="outline" className="w-full" onClick={() => doRestart('all')}>
              从整本第一词重学
            </Button>
            <Button variant="primary" className="w-full" onClick={() => setRestartAsk(null)}>
              取消
            </Button>
          </>
        }
      >
        <p className="text-sm leading-relaxed">
          重学会清掉对应范围内「已学完」的标记，进度回到起点；已进生词本的词不受影响
          （它们的复习节奏由生词本自己管，不会回退）。
        </p>
      </Dialog>
    </div>
  )
}
