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
  submitLetter,
  STALE_PAUSE_MS,
  type AttemptResult,
  type SelectionDrop,
  type SpellingSelectionMode,
  type SpellingSession,
} from '@/domain/spellingSession'
import type { LetterResult } from '@/domain/spellingTyping'
import {
  LOCK_HEARTBEAT_MS,
  SpellingLockError,
  invalidateLocalLocks,
  renewSessionLock,
  subscribeLockLifecycle,
  takeoverSessionLock,
} from '@/domain/spellingLock'
import { drainPendingEvents, runRecoveryChain } from '@/domain/spellingErrorEvents'

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
 *   多标签页：会话写入已接入跨标签单写者锁（domain/spellingLock）。
 *   取锁与 U16 恢复链完成前输入框一律禁用；失锁进入冲突面板，
 *   由用户显式决定是否接管，不静默失败、不假报成功。
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

  /** V2 逐字母：输入框只接一个字符，逐字符判定后清空 */
  const [input, setInput] = useState('')
  /** V1「跳过」的反馈（AttemptResult），与逐字母反馈分开，互不影响 */
  const [feedback, setFeedback] = useState<AttemptResult | null>(null)
  /** V2 逐字母反馈 */
  const [letterFeedback, setLetterFeedback] = useState<LetterResult | null>(null)
  const [busy, setBusy] = useState(false)
  /** 串行队列：快速连打时不丢字母，避免并发写库导致顺序错乱 */
  const letterQueueRef = useRef<string[]>([])
  const drainingRef = useRef(false)
  /** 队列消费期间的最新会话快照（React state 在异步循环里会过期） */
  const latestSessionRef = useRef<SpellingSession | null>(null)
  /** SRS 交接未落地的持续提示（依据真实 outcome，不显示"已同步"） */
  const [srsPending, setSrsPending] = useState<string | null>(null)
  /** C33：取锁/恢复链完成前一律禁用输入，零写入、零判分 */
  const [inputEnabled, setInputEnabled] = useState(false)
  /** 跨标签冲突 / 升级降级：用户可见的只读状态 */
  const [lockConflict, setLockConflict] = useState<string | null>(null)
  /** 冲突面板要操作的会话 id：取自持久化层，不依赖 React session state
   *  （恢复链失败时 session 本来就是 null，否则接管按钮会永远禁用） */
  const [lockSessionId, setLockSessionId] = useState<string | null>(null)
  /** U16：版本变更 / 连接被抢占时挂起恢复链，等 ready 后重跑（避免直接改 UI 状态依赖旧闭包） */
  const recoveryPendingRef = useRef(false)
  const recoveryRunningRef = useRef(false)
  const sidRef = useRef<string | null>(null)

  const inputRef = useRef<HTMLInputElement>(null)

  /* ---------------- 启动：恢复或新建 ---------------- */

  // 每次渲染都把最新会话同步给队列消费者（无副作用、不触发额外渲染）
  latestSessionRef.current = session

  /** 锁类异常 → 冲突面板 + 只读降级；其它异常仍走原 fatal 错误态 */
  const handleLockError = useCallback((e: unknown, fallback: string): void => {
    if (e instanceof SpellingLockError) {
      setInputEnabled(false)
      setLockConflict(e.message)
      setFatal(null)
    } else {
      setFatal(e instanceof Error ? e.message : fallback)
    }
  }, [])

  /**
   * U16 五步恢复链（domain 编排）：关闭旧内存态 → 重新 open + 重读会话与
   * lock_epoch → 重新 acquireLock → drain（带重试）→ 仅当 drain 收敛才解锁输入。
   * 任一步失败或 drain 未收敛即保持只读，绝不沿用旧锁、绝不假报恢复成功。
   */
  const recoverSession = useCallback(async (sid: string): Promise<boolean> => {
    if (recoveryRunningRef.current) return false
    recoveryRunningRef.current = true
    sidRef.current = sid
    setLockSessionId(sid)
    setInputEnabled(false)
    try {
      const chain = await runRecoveryChain(sid)
      if (!chain.converged) {
        setInputEnabled(false)
        setLockConflict('错词事件尚未结算完成，输入暂不可用；请稍后重新检查。')
        return false
      }
      recoveryPendingRef.current = false
      setInputEnabled(true)
      setLockConflict(null)
      return true
    } catch (e) {
      setInputEnabled(false)
      handleLockError(e, '恢复默写会话失败')
      return false
    } finally {
      recoveryRunningRef.current = false
    }
  }, [handleLockError])

  /** 用户显式确认后接管：epoch+1，旧标签后续写入被拒 */
  async function onTakeover() {
    const sid = lockSessionId ?? session?.id
    if (!sid) return
    setBusy(true)
    try {
      await takeoverSessionLock(sid, { confirmed: true })
      const drained = await drainPendingEvents({ sessionId: sid })
      const fresh = await getSessionById(sid)
      if (fresh) setSession(fresh)
      if (drained.converged) {
        setInputEnabled(true)
        setLockConflict(null)
      } else {
        // 接管成功但错词事件未结算完：保持只读，不假报可用
        setInputEnabled(false)
        setLockConflict('接管成功，但错词事件尚未结算完成，输入暂不可用；请重新检查。')
      }
    } catch (e) {
      setInputEnabled(false)
      handleLockError(e, '接管失败')
    } finally {
      setBusy(false)
    }
  }

  /** 有可恢复会话就恢复，否则按 URL 参数新建 */
  const enterSession = useCallback(async () => {
    setConflicts(null)
    setFatal(null)
    const resumable = await getResumableSession()
    if (resumable) {
      // U16 恢复链未完成前不启用输入、不发起任何写入
      if (!(await recoverSession(resumable.id))) {
        setLoading(false)
        return
      }
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
      if (!(await recoverSession(created.session.id))) {
        setLoading(false)
        return
      }
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
        handleLockError(e, '创建默写会话失败')
      }
    }
    setLoading(false)
  }, [mode, batchSize, navigate, recoverSession, handleLockError])

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
      handleLockError(e, '读取默写会话失败')
      setLoading(false)
    }
  }, [enterSession, handleLockError])

  useEffect(() => {
    void bootstrap()
  }, [bootstrap])

  /* ---------------- U16 · 升级中断生命周期 ----------------
   * versionchange / blocked：连接被关闭或升级受阻，内存锁状态一律作废，
   * 立即禁用输入（铁律 1：不假设 db.close() 后原事务仍能继续）。
   * 此处**不主动 reopen / 不自动重跑恢复链**：升级窗口内立即重连会把对方
   * 升级重新 blocked（S5：页面保持只读、零写入）。恢复链的实际触发点是
   * 「进页 / 刷新 / 用户点重新检查」→ bootstrap → recoverSession；
   * ready 订阅只是页面已挂载后底层连接重新就绪时的补充保险。
   * 重新 open ≠ 已持锁（铁律 2），必须由 runRecoveryChain 重新取锁 +
   * drain 收敛后才解锁输入。
   */
  useEffect(() => {
    return subscribeLockLifecycle((event) => {
      if (event.type === 'versionchange' || event.type === 'blocked') {
        invalidateLocalLocks()
        recoveryPendingRef.current = true
        setInputEnabled(false)
        setLockConflict(
          event.type === 'blocked'
            ? '数据升级被其它标签页阻塞，当前为只读状态；请关闭其它标签页。'
            : '数据正在升级，连接已关闭；恢复完成后才能继续输入。',
        )
        return
      }
      if (event.type === 'ready' && recoveryPendingRef.current) {
        const sid = sidRef.current
        if (sid && !recoveryRunningRef.current) void recoverSession(sid)
      }
    })
  }, [recoverSession])

  /* ---------------- 反馈自动清除 ---------------- */

  useEffect(() => {
    if (!feedback) return
    const t = window.setTimeout(() => setFeedback(null), 1600)
    return () => window.clearTimeout(t)
  }, [feedback])

  /* ---------------- 锁续期（心跳 + 前台恢复） ----------------
   * 后台标签 setInterval 受节流，故 lease 用后台放宽值；心跳失败即只读降级。 */
  useEffect(() => {
    if (!session || !inputEnabled) return
    const renew = () => {
      void renewSessionLock(session.id).catch((e) => handleLockError(e, '锁续期失败'))
    }
    const timer = window.setInterval(renew, LOCK_HEARTBEAT_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible') renew()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [session, inputEnabled, handleLockError])

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

  /**
   * V2 逐字母主路径：每个字符单独提交、单独判错、单独落 1 条错误事件。
   * 用串行队列消费快速连打，保证顺序与幂等（每次按键一个 request_id）。
   * 单词达标切换时清空剩余队列，避免把上一个词的残留按键算到新词上。
   */
  const drainLetters = useCallback(async (): Promise<void> => {
    if (drainingRef.current) return
    drainingRef.current = true
    setBusy(true)
    try {
      while (letterQueueRef.current.length > 0) {
        const ch = letterQueueRef.current.shift() as string
        try {
          // word_id 从「当前持久化会话」取，避免队列消费期间闭包里的 word 过期
          const live = currentWord(latestSessionRef.current as SpellingSession)
          if (!live) {
            letterQueueRef.current.length = 0
            break
          }
          const res = await submitLetter({ word_id: live.word_id, char: ch, request_id: uuid() })
          latestSessionRef.current = res.session
          setSession(res.session)
          setLetterFeedback(res.result)
          if (res.result.outcome === 'word_completed' || res.result.outcome === 'session_completed') {
            letterQueueRef.current.length = 0
          }
          if (res.srs === 'failed' || res.srs === 'partial') {
            setSrsPending('有词的复习积分还没写进去，稍后打开默写页会自动重试')
          } else if (res.srs === 'reported' || res.srs === 'dropped') {
            setSrsPending(null)
          }
        } catch (e) {
          handleLockError(e, '输入失败')
          letterQueueRef.current.length = 0
          break
        }
      }
    } finally {
      drainingRef.current = false
      setBusy(false)
      inputRef.current?.focus()
    }
  }, [handleLockError])

  /** 输入框 onChange：只取新输入的字符，逐字符入队；输入值恒为 '' */
  function onLetterInput(value: string): void {
    if (!inputEnabled) return
    for (const ch of value) letterQueueRef.current.push(ch)
    setInput('')
    void drainLetters()
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
      handleLockError(e, '跳过失败')
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
      handleLockError(e, '暂停失败')
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
      setInputEnabled(true)
      setSession(repaired ?? resumed)
      setSrsPending(repair.lost.length > 0 ? '有词的复习积分还没写进去，稍后会自动重试' : null)
    } catch (e) {
      handleLockError(e, '恢复失败')
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
      handleLockError(e, '放弃失败')
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
      handleLockError(e, '处理冲突失败')
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

  if (lockConflict) {
    return (
      <div className="space-y-4 px-4 py-5">
        <Header title="另一标签页正在使用本会话" onBack={() => navigate('/review')} />
        <Card>
          <CardBody className="space-y-3">
            <div className="flex items-start gap-2 text-sm text-muted-foreground" role="alert">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{lockConflict}</span>
            </div>
            <p className="text-xs text-muted-foreground">
              接管后另一标签页的后续写入会被拒绝；它已落盘的错词事件会按锁代次结算，不会重复计数。
              若只是数据正在升级，请关闭其它标签页后重试。
            </p>
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" disabled={busy} onClick={() => void bootstrap()}>
                重新检查
              </Button>
              <Button
                className="flex-1"
                disabled={busy || !lockSessionId}
                onClick={() => void onTakeover()}
              >
                在此标签继续
              </Button>
            </div>
          </CardBody>
        </Card>
      </div>
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
          disabled={busy || !inputEnabled}
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

                {/* V2 逐字母进度：只显示「用户已输对的字母」，不泄露未输入部分 */}
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <span className="font-mono tracking-widest" data-testid="letter-progress">
                    {(word.typed_prefix ?? '') ||
                      Array.from({ length: Math.max(0, word.word.length) })
                        .map(() => '_')
                        .join('')}
                    {(word.typed_prefix ?? '') &&
                      Array.from({ length: Math.max(0, word.word.length - (word.typed_prefix ?? '').length) })
                        .map(() => ' _')
                        .join('')}
                  </span>
                  <span>· {word.word.length} 个字母 · 第 {(word.typed_prefix ?? '').length + 1} 个</span>
                </div>

                <div>
                  <label htmlFor="spelling-input" className="mb-1 block text-sm font-medium">
                    逐字母拼写
                  </label>
                  <input
                    id="spelling-input"
                    ref={inputRef}
                    value={input}
                    onChange={(e) => onLetterInput(e.target.value)}
                    onKeyDown={(e) => {
                      // V2 无「整词提交」：回车不作为答题提交，避免误触把错误字母算成一次完整提交
                      if (e.key === 'Enter') e.preventDefault()
                    }}
                    // 逐字母输入：关掉自动更正/首字母大写/拼写检查，避免浏览器改掉用户输入
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    maxLength={1}
                    inputMode="text"
                    enterKeyHint="done"
                    disabled={!inputEnabled}
                    placeholder={inputEnabled ? '逐字母输入，输错立即从头开始' : '正在取得本会话的写入权…'}
                    className="w-full rounded-lg border border-border bg-card px-3 py-2.5 text-base outline-none focus:border-primary disabled:opacity-50"
                  />
                </div>

                {/* V2 逐字母反馈：错误时明确提示「进度清零 + 连对归零」 */}
                {letterFeedback && (
                  <div
                    className={`text-sm ${
                      letterFeedback.outcome === 'wrong'
                        ? 'text-destructive'
                        : letterFeedback.outcome === 'correct' ||
                            letterFeedback.outcome === 'word_completed' ||
                            letterFeedback.outcome === 'session_completed'
                          ? 'text-primary'
                          : 'text-muted-foreground'
                    }`}
                    role="status"
                    data-testid="letter-feedback"
                    data-outcome={letterFeedback.outcome}
                  >
                    {letterFeedback.outcome === 'wrong' && (
                      <>
                        <X className="mr-1 inline h-4 w-4" />
                        字母不对，已从第一个字母重新开始（连对归零）
                      </>
                    )}
                    {letterFeedback.outcome === 'correct' && (
                      <>
                        <Check className="mr-1 inline h-4 w-4" />
                        正确，继续下一个字母
                      </>
                    )}
                    {(letterFeedback.outcome === 'word_completed' ||
                      letterFeedback.outcome === 'session_completed') && (
                      <>
                        <Check className="mr-1 inline h-4 w-4" />
                        整词达标，切换到下一个词
                      </>
                    )}
                    {letterFeedback.outcome === 'ignored' && '这个字符不参与拼写'}
                  </div>
                )}

                {feedback && !letterFeedback && feedback.result === 'skipped' && (
                  <p className="text-sm text-muted-foreground" role="status">
                    已跳过该词
                  </p>
                )}
              </CardBody>
            </Card>
          </div>

          <div className="mt-4 flex gap-2">
            <Button
              variant="outline"
              className="flex-1"
              disabled={busy || !inputEnabled}
              onClick={() => void onSkip()}
            >
              <SkipForward className="h-4 w-4" /> 跳过
            </Button>
          </div>
          <p className="mt-2 text-center text-xs text-muted-foreground">
            逐字母判定：每个错误字母记 1 条错词事件，不算一次答题提交
          </p>

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
