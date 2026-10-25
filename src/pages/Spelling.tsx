import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  AlertTriangle,
  Check,
  ChevronLeft,
  Pause,
  PenLine,
  SkipForward,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardBody } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorState } from '@/components/ui/error-state'
import { Progress } from '@/components/ui/progress'
import { useAppStore } from '@/store/useAppStore'
import { uuid } from '@/lib/uuid'
import {
  DEFAULT_TARGET_CORRECT,
  SpellingSessionError,
  abandon as abandonSessionApi,
  createSession,
  currentWord,
  getActiveSessions,
  getResumableSession,
  getSessionById,
  isSessionStale,
  pause as pauseSessionApi,
  refreshAvailability,
  repairSrsHandoff,
  resume as resumeSessionApi,
  sessionProgress,
  skip as skipWordApi,
  submitAttempt,
  STALE_PAUSE_MS,
  type AttemptResult,
  type SelectionDrop,
  type SpellingSelectionMode,
  type SpellingSession,
} from '@/domain/spellingSession'

/**
 * 单词默写 · 练习页（路由 `/spelling`）
 * ------------------------------------------------------------------
 * 设计原则（任务书 D2/D3/D4）：
 *   **持久化会话是唯一事实源**。本组件不自己维护题目列表、计数或状态机 ——
 *   每一步操作都调 `domain/spellingSession` 的接口，然后用返回的 session 重渲染。
 *   `currentWord(session)` 按 `current_position` 从**持久化队列**里取当前词，
 *   刷新页面后重新读库即可回到同一个词。
 *
 *   前端没有任何判分逻辑：拼写判定、计数、幂等、SRS 交接全在领域层。
 *   本文件只做「取词 → 收输入 → 调接口 → 按返回值渲染」。
 *
 *   多标签页：存储抽象不保证原子互斥，这里只把 `getActiveSessions()` 的结果
 *   如实呈现给用户选择，**不宣称实现了锁**。
 */

const MODE_LABEL: Record<SpellingSelectionMode, string> = {
  random: '随机',
  recent: '最近新增',
  wrong: '易错词',
}

/** 用 sessionStorage 记住「上次在读哪个会话」，仅作为刷新后的查找线索；
 *  状态本身仍以库里文档为准，不拿它做任何判定。 */
const HINT_KEY = 'spelling:lastSessionId'

function isMode(v: string | null): v is SpellingSelectionMode {
  return v === 'random' || v === 'recent' || v === 'wrong'
}

function dropReasonText(reason: SelectionDrop['reason']): string {
  if (reason === 'invalid-word') return '拼写不合法'
  if (reason === 'no-meaning') return '缺中文释义'
  return '重复'
}

export function Spelling() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const modeParam = params.get('mode')
  const mode: SpellingSelectionMode = isMode(modeParam) ? modeParam : 'recent'
  const batchSize = useAppStore((s) => s.settings.studyBatchSize)

  const [session, setSession] = useState<SpellingSession | null>(null)
  const [loading, setLoading] = useState(true)
  const [fatal, setFatal] = useState<string | null>(null)
  /** 多份进行中会话（另一标签页可能正在操作）—— 交给用户选，不自动裁决 */
  const [conflicts, setConflicts] = useState<SpellingSession[] | null>(null)
  const [pickedConflict, setPickedConflict] = useState<string | null>(null)
  const [dropped, setDropped] = useState<SelectionDrop[]>([])
  const [available, setAvailable] = useState<number | null>(null)

  const [input, setInput] = useState('')
  const [feedback, setFeedback] = useState<AttemptResult | null>(null)
  const [busy, setBusy] = useState(false)
  /** SRS 交接未落地的持续提示（依据真实 outcome，不显示"已同步"） */
  const [srsPending, setSrsPending] = useState<string | null>(null)

  const inputRef = useRef<HTMLInputElement>(null)

  /* ---------------- 启动：恢复或新建 ---------------- */

  /** 有可恢复会话就恢复，否则按 URL 参数新建 */
  const enterSession = useCallback(async () => {
    setConflicts(null)
    setFatal(null)
    const resumable = await getResumableSession()
    if (resumable) {
      // 恢复两步：① 核对词条是否已从生词本删除（removeFromVocab 是硬删除）
      //          ② 补做上次没落成的 SRS 交接（阶段 C 的恢复入口）
      const { session: checked } = await refreshAvailability()
      const repair = await repairSrsHandoff()
      const repaired = repair.sessions.find((s) => s.id === checked.id)
      const merged = repaired ?? checked
      setSession(merged)
      if (repair.lost.length > 0) {
        setSrsPending('有词的复习积分还没写进去，稍后打开默写页会自动重试')
      } else {
        setSrsPending(null)
      }
      window.sessionStorage.setItem(HINT_KEY, merged.id)
      setLoading(false)
      return
    }

    // 没有可恢复会话：若刚刚才结束过一次，刷新应回到结果页而不是新开一轮
    const hint = window.sessionStorage.getItem(HINT_KEY)
    if (hint) {
      const last = await getSessionById(hint)
      if (last && last.status === 'SESSION_COMPLETED') {
        navigate(`/spelling-result?id=${encodeURIComponent(last.id)}`, { replace: true })
        return
      }
    }

    try {
      const created = await createSession({ mode, count: batchSize })
      setSession(created.session)
      setDropped(created.dropped)
      setAvailable(created.available)
      window.sessionStorage.setItem(HINT_KEY, created.session.id)
    } catch (e) {
      if (e instanceof SpellingSessionError && e.code === 'SESSION_CONFLICT') {
        // 空池：不是错误，是没有可练的词 —— 走空态
        setSession(null)
        setFatal('EMPTY_POOL')
      } else {
        setFatal(e instanceof Error ? e.message : '创建默写会话失败')
      }
    }
    setLoading(false)
  }, [mode, batchSize, navigate])

  const bootstrap = useCallback(async () => {
    setLoading(true)
    try {
      const active = await getActiveSessions()
      if (active.length > 1) {
        setConflicts(active)
        setPickedConflict(active[0].id)
        setLoading(false)
        return
      }
      await enterSession()
    } catch (e) {
      setFatal(e instanceof Error ? e.message : '读取默写会话失败')
      setLoading(false)
    }
  }, [enterSession])

  useEffect(() => {
    void bootstrap()
  }, [bootstrap])

  /* ---------------- 反馈自动清除 ---------------- */

  useEffect(() => {
    if (!feedback) return
    const t = window.setTimeout(() => setFeedback(null), 1600)
    return () => window.clearTimeout(t)
  }, [feedback])

  /* ---------------- 会话自然结束 → 结果页 ---------------- */

  useEffect(() => {
    if (session && session.status === 'SESSION_COMPLETED') {
      const t = window.setTimeout(
        () => navigate(`/spelling-result?id=${encodeURIComponent(session.id)}`, { replace: true }),
        900,
      )
      return () => window.clearTimeout(t)
    }
  }, [session, navigate])

  /* ---------------- 操作 ---------------- */

  const word = session ? currentWord(session) : null

  async function onSubmit() {
    if (!session || !word || busy) return
    const value = input
    setBusy(true)
    try {
      // request_id 每次提交现生成一个；busy 闸门挡住连点产生第二个 id。
      // 领域层还会按 request_id 幂等回放，双保险。
      const res = await submitAttempt({ word_id: word.word_id, input: value, request_id: uuid() })
      setSession(res.session)
      setFeedback(res.result)
      setInput('')
      if (res.srs === 'failed' || res.srs === 'partial') {
        setSrsPending('有词的复习积分还没写进去，稍后打开默写页会自动重试')
      } else if (res.srs === 'reported' || res.srs === 'dropped') {
        setSrsPending(null)
      }
    } catch (e) {
      setFatal(e instanceof Error ? e.message : '提交失败')
    } finally {
      setBusy(false)
      inputRef.current?.focus()
    }
  }

  async function onSkip() {
    if (!session || !word || busy) return
    setBusy(true)
    try {
      const res = await skipWordApi({ word_id: word.word_id, request_id: uuid() })
      setSession(res.session)
      setFeedback(res.result)
      setInput('')
    } catch (e) {
      setFatal(e instanceof Error ? e.message : '跳过失败')
    } finally {
      setBusy(false)
      inputRef.current?.focus()
    }
  }

  async function onPause() {
    if (busy) return
    setBusy(true)
    try {
      setSession(await pauseSessionApi())
    } catch (e) {
      setFatal(e instanceof Error ? e.message : '暂停失败')
    } finally {
      setBusy(false)
    }
  }

  async function onResume() {
    setBusy(true)
    try {
      // ① 先核对词条是否已从生词本删除（可能变成 UNAVAILABLE）；
      // ② 再真正把 PAUSED 改回 IN_PROGRESS；
      // ③ 最后补做上次没落成的 SRS 交接。
      // 三步全部走持久化层，前端不自己改状态、也不跳过第二步。
      const { session: checked } = await refreshAvailability()
      const resumed = await resumeSessionApi()
      const repair = await repairSrsHandoff()
      const repaired = repair.sessions.find((s) => s.id === resumed.id)
      setSession(repaired ?? resumed)
      setSrsPending(repair.lost.length > 0 ? '有词的复习积分还没写进去，稍后会自动重试' : null)
    } catch (e) {
      setFatal(e instanceof Error ? e.message : '恢复失败')
    } finally {
      setBusy(false)
    }
  }

  async function onAbandon() {
    setBusy(true)
    try {
      await abandonSessionApi()
      window.sessionStorage.removeItem(HINT_KEY)
      navigate('/review')
    } catch (e) {
      setFatal(e instanceof Error ? e.message : '放弃失败')
    } finally {
      setBusy(false)
    }
  }

  /**
   * 冲突裁决：保留选中的一个，放弃其余。
   * `abandon()` 每次放弃「当前最新的可恢复会话」，所以循环放弃直到选中那个变成最新即可
   * —— 不需要给领域层加按 id 放弃的接口。
   */
  async function onResolveConflict() {
    if (!conflicts || !pickedConflict) return
    setBusy(true)
    try {
      for (let guard = 0; guard < conflicts.length + 1; guard += 1) {
        const latest = await getResumableSession()
        if (!latest || latest.id === pickedConflict) break
        await abandonSessionApi()
      }
      await enterSession()
    } catch (e) {
      setFatal(e instanceof Error ? e.message : '处理冲突失败')
    } finally {
      setBusy(false)
    }
  }

  /* ---------------- 渲染 ---------------- */

  if (loading) {
    return <div className="p-6 text-sm text-muted-foreground">正在读取默写会话…</div>
  }

  if (fatal === 'EMPTY_POOL') {
    return (
      <EmptyState
        icon={PenLine}
        title="生词本里还没有可默写的词"
        description="先去学习或搜索页把词加入生词本；带中文释义且拼写干净的词才能参与默写。"
        action={
          <Button variant="outline" onClick={() => navigate('/review')}>
            返回复习
          </Button>
        }
      />
    )
  }

  if (fatal) {
    return <ErrorState message={fatal} onRetry={() => void bootstrap()} />
  }

  if (conflicts) {
    return (
      <div className="space-y-4 px-4 py-5">
        <Header title="检测到多个进行中的默写" onBack={() => navigate('/review')} />
        <Card>
          <CardBody className="space-y-3">
            <div className="flex items-start gap-2 text-sm text-muted-foreground">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
              <p>
                库里同时有 {conflicts.length} 份进行中的会话，可能是另一个标签页刚开的。
                本地存储<b className="text-foreground">不保证</b>多标签页互斥，所以不会自动替你选 ——
                挑一个继续，其余的会放弃。
              </p>
            </div>
            <ul className="space-y-2">
              {conflicts.map((s) => {
                const p = sessionProgress(s)
                const active = s.id === pickedConflict
                return (
                  <li key={s.id}>
                    <button
                      onClick={() => setPickedConflict(s.id)}
                      aria-pressed={active}
                      className={`w-full rounded-lg border px-3 py-2 text-left text-sm touch-target ${
                        active ? 'border-primary bg-secondary/60' : 'border-border bg-card'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-medium">
                          {MODE_LABEL[s.selection_mode]} · {p.total} 词
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {new Date(s.started_at).toLocaleString('zh-CN', { hour12: false })}
                        </span>
                      </div>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        已完成 {p.completed} · 跳过 {p.skipped} · 待练{' '}
                        {p.total - p.completed - p.skipped - p.unavailable}
                      </div>
                    </button>
                  </li>
                )
              })}
            </ul>
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" disabled={busy} onClick={() => void onResolveConflict()}>
                保留选中的，放弃其余
              </Button>
              <Button
                variant="ghost"
                className="flex-1"
                disabled={busy}
                onClick={() => {
                  void (async () => {
                    for (let i = 0; i < conflicts.length; i += 1) await abandonSessionApi()
                    window.sessionStorage.removeItem(HINT_KEY)
                    await enterSession()
                  })()
                }}
              >
                全部放弃，重开一轮
              </Button>
            </div>
          </CardBody>
        </Card>
      </div>
    )
  }

  if (!session) {
    return <ErrorState message="没有可用的默写会话" onRetry={() => void bootstrap()} />
  }

  /* ---- 暂停中 ---- */
  if (session.status === 'PAUSED') {
    const stale = isSessionStale(session)
    return (
      <div className="space-y-4 px-4 py-5">
        <Header title="默写已暂停" onBack={() => navigate('/review')} />
        <Card>
          <CardBody className="space-y-3">
            <p className="text-sm text-muted-foreground">
              进度已存在本机，随时可以继续。
              {stale &&
                `这份会话已暂停超过 ${Math.round(STALE_PAUSE_MS / 86_400_000)} 天，也可以直接放弃。`}
            </p>
            <div className="flex gap-2">
              <Button className="flex-1" disabled={busy} onClick={() => void onResume()}>
                继续默写
              </Button>
              <Button variant="outline" className="flex-1" disabled={busy} onClick={() => void onAbandon()}>
                放弃本轮
              </Button>
            </div>
          </CardBody>
        </Card>
      </div>
    )
  }

  /* ---- 刚结束 ---- */
  if (session.status === 'SESSION_COMPLETED') {
    return <div className="p-6 text-sm text-muted-foreground">本轮默写完成，正在打开结果…</div>
  }

  /* ---- 练习中 ---- */
  const p = sessionProgress(session)
  const doneCount = p.completed + p.skipped + p.unavailable
  const shortOfWords = available !== null && available < batchSize

  return (
    <div className="flex min-h-screen flex-col px-4 py-4">
      <div className="mb-4 flex items-center gap-3">
        <button
          onClick={() => navigate('/review')}
          className="text-muted-foreground touch-target"
          aria-label="返回复习页"
          title="返回复习页"
        >
          <ChevronLeft className="h-6 w-6" />
        </button>
        <Progress value={p.total === 0 ? 0 : (doneCount / p.total) * 100} className="flex-1" />
        <span className="text-xs text-muted-foreground">
          {doneCount}/{p.total}
        </span>
        <button
          onClick={() => void onPause()}
          disabled={busy}
          className="text-muted-foreground touch-target disabled:opacity-50"
          aria-label="暂停本轮默写"
          title="暂停本轮默写"
        >
          <Pause className="h-5 w-5" />
        </button>
      </div>

      {/* 选词说明：数量不足 / 有词被排除时如实说明，不静默 */}
      {shortOfWords || dropped.length > 0 ? (
        <p className="mb-3 rounded-lg bg-secondary/50 px-3 py-2 text-xs text-muted-foreground">
          {shortOfWords
            ? `生词本可用词不足，本轮实际 ${session.total_words} 个（设置里每轮 ${batchSize} 个）。`
            : ''}
          {dropped.length > 0
            ? ` ${dropped.length} 个词未参与：${dropped
                .slice(0, 3)
                .map((d) => d.word)
                .join('、')}${dropped.length > 3 ? ' 等' : ''}（${dropReasonText(dropped[0].reason)}）。`
            : ''}
        </p>
      ) : null}

      {word ? (
        <>
          <div className="flex-1">
            <Card>
              <CardBody className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">
                    第 {doneCount + 1} 个 · {MODE_LABEL[session.selection_mode]}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    连对 {word.consecutive_correct}/{word.target_correct}
                  </span>
                </div>

                {word.pos && <div className="text-sm italic text-muted-foreground">{word.pos}</div>}
                <div className="text-lg font-medium leading-relaxed">
                  {word.definition_zh || '（这个词没有中文释义）'}
                </div>

                {/* 提示：只给长度与首字母，不泄露答案，也不给音标 */}
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <span className="font-mono tracking-widest">
                    {word.word[0]}
                    {Array.from({ length: Math.max(0, word.word.length - 1) })
                      .map(() => ' _')
                      .join('')}
                  </span>
                  <span>· {word.word.length} 个字母</span>
                </div>

                <div>
                  <label htmlFor="spelling-input" className="mb-1 block text-sm font-medium">
                    拼写
                  </label>
                  <input
                    id="spelling-input"
                    ref={inputRef}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        void onSubmit()
                      }
                    }}
                    // 默写是「看释义写英文」：关掉自动更正/首字母大写，避免浏览器改掉用户输入
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    enterKeyHint="send"
                    disabled={busy}
                    placeholder="输入英文后回车"
                    className="w-full rounded-lg border border-border bg-card px-3 py-2.5 text-base outline-none focus:border-primary disabled:opacity-50"
                  />
                </div>

                {feedback && (
                  <div
                    className={`text-sm ${
                      feedback.result === 'correct'
                        ? 'text-primary'
                        : feedback.result === 'wrong'
                          ? 'text-destructive'
                          : 'text-muted-foreground'
                    }`}
                    role="status"
                  >
                    {feedback.result === 'correct' && (
                      <>
                        <Check className="mr-1 inline h-4 w-4" />
                        {feedback.word_status === 'COMPLETED'
                          ? `拼对，第 ${word.target_correct} 次连对达成！`
                          : '拼对！'}
                      </>
                    )}
                    {feedback.result === 'wrong' && (
                      <>
                        <X className="mr-1 inline h-4 w-4" />
                        不对，再试试
                      </>
                    )}
                    {feedback.result === 'invalid' && '空白不算一次提交，直接输入就行'}
                    {feedback.result === 'terminal' && '这个词已经结束了'}
                  </div>
                )}
              </CardBody>
            </Card>
          </div>

          <div className="mt-4 flex gap-2">
            <Button variant="outline" className="flex-1" disabled={busy} onClick={() => void onSkip()}>
              <SkipForward className="h-4 w-4" /> 跳过
            </Button>
            <Button
              className="flex-1"
              disabled={busy || input.trim().length === 0}
              onClick={() => void onSubmit()}
            >
              提交
            </Button>
          </div>

          {srsPending && (
            <p className="mt-3 rounded-lg bg-accent/10 px-3 py-2 text-xs text-muted-foreground" role="status">
              {srsPending}
            </p>
          )}

          <p className="mt-2 text-center text-xs text-muted-foreground">
            连对 {DEFAULT_TARGET_CORRECT} 次记为掌握，并计入生词本复习排程
          </p>
        </>
      ) : (
        <EmptyState
          icon={PenLine}
          title="队列里没有可出的词了"
          description="剩下的词都已结束，打开结果页看看这一轮的账。"
          action={
            <Button variant="outline" onClick={() => navigate(`/spelling-result?id=${session.id}`)}>
              看结果
            </Button>
          }
        />
      )}
    </div>
  )
}

function Header({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="flex items-center gap-2">
      <button onClick={onBack} className="text-muted-foreground touch-target" aria-label="返回" title="返回">
        <ChevronLeft className="h-6 w-6" />
      </button>
      <div className="text-lg font-semibold">{title}</div>
    </div>
  )
}
