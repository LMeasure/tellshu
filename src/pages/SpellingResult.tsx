import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Check, ChevronLeft, PenLine, SkipForward, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardBody } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorState } from '@/components/ui/error-state'
import {
  aggregateSession,
  getSessionById,
  sessionProgress,
  type SpellingSession,
  type SpellingWordState,
} from '@/domain/spellingSession'

/**
 * 单词默写 · 结果页（路由 `/spelling-result?id=<sessionId>`）
 * ------------------------------------------------------------------
 * 独立路由，**不复用也不改造**既有 `/result`（那是占位结算页）。
 * 全部数字由 `aggregateSession()` 从持久化会话**实时聚合**得出，
 * 本组件不自己累加任何计数；刷新后按 id 重读库，结果不变。
 * 会话不存在 / 读不到时给返回入口，不伪造结果。
 */

const STATUS_LABEL: Record<SpellingWordState['status'], string> = {
  PENDING: '未开始',
  IN_PROGRESS: '进行中',
  COMPLETED: '已完成',
  SKIPPED: '已跳过',
  UNAVAILABLE: '已失效',
}

export function SpellingResult() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const id = params.get('id')

  const [session, setSession] = useState<SpellingSession | null>(null)
  const [loading, setLoading] = useState(true)
  const [missing, setMissing] = useState(false)

  const load = useCallback(async () => {
    if (!id) {
      setMissing(true)
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const row = await getSessionById(id)
      if (!row) {
        setMissing(true)
      } else {
        setSession(row)
        setMissing(false)
      }
    } catch {
      setMissing(true)
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  if (loading) {
    return <div className="p-6 text-sm text-muted-foreground">正在读取这一轮的记录…</div>
  }

  if (missing || !session) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title="找不到这次默写的记录"
        description="这条会话可能已被放弃，或者本机数据被清理过。默写记录只存在本机，不会跨设备同步。"
        action={
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => navigate('/review')}>
              返回复习
            </Button>
            <Button onClick={() => navigate('/spelling')}>开一轮新的</Button>
          </div>
        }
      />
    )
  }

  const stats = aggregateSession(session)
  const p = sessionProgress(session)
  const finished = stats.completed + stats.skipped + stats.unavailable

  return (
    <div className="space-y-5 px-4 py-5">
      <div className="flex items-center gap-2">
        <button
          onClick={() => navigate('/review')}
          className="text-muted-foreground touch-target"
          aria-label="返回复习页"
          title="返回复习页"
        >
          <ChevronLeft className="h-6 w-6" />
        </button>
        <div>
          <div className="text-lg font-semibold">默写结果</div>
          <div className="text-xs text-muted-foreground">
            {new Date(session.started_at).toLocaleString('zh-CN', { hour12: false })} 开始 ·{' '}
            {stats.total_words} 词
          </div>
        </div>
      </div>

      {/* 核心数字：全部来自 aggregateSession 实时聚合，前端不再自己累加 */}
      <div className="grid grid-cols-3 gap-2">
        <Figure label="完成" value={stats.completed} tone="primary" />
        <Figure label="跳过" value={stats.skipped} />
        <Figure label="失效" value={stats.unavailable} />
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Figure label="提交次数" value={stats.total_attempts} />
        <Figure label="答对" value={stats.correct_attempts} />
        <Figure
          label="正确率"
          value={stats.accuracy === null ? '—' : `${stats.accuracy}%`}
        />
      </div>

      <Card>
        <CardBody className="space-y-2 text-sm">
          <Row label="完成率" value={stats.completion_rate === null ? '—' : `${stats.completion_rate}%`} />
          <Row label="剩余未终态" value={stats.remaining} />
          <Row label="用时" value={formatDuration(stats.duration_ms)} />
          <Row label="连续正确目标" value={`${session.target_correct} 次`} />
        </CardBody>
      </Card>

      {/* 逐词明细：直接渲染持久化队列，不另做一套统计 */}
      <div>
        <div className="mb-2 px-1 text-base font-semibold">逐词明细</div>
        <div className="divide-y divide-border rounded-lg border border-border/60 bg-card">
          {session.queue.map((w) => (
            <div key={w.word_id} className="flex items-center gap-3 px-3 py-2.5">
              <span className="w-6 shrink-0 text-center text-xs text-muted-foreground">
                {w.position + 1}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{w.definition_zh || '（无释义）'}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {w.total_attempts} 次提交 · 对 {w.correct_attempts} · 错 {w.wrong_attempts}
                  {w.unavailable_reason ? ' · 词条已删除' : ''}
                </div>
              </div>
              <WordBadge status={w.status} />
            </div>
          ))}
        </div>
      </div>

      <div className="flex gap-2">
        <Button variant="outline" className="flex-1" onClick={() => navigate('/review')}>
          返回复习
        </Button>
        <Button className="flex-1" onClick={() => navigate('/spelling')}>
          再来一轮
        </Button>
      </div>

      <p className="text-center text-xs text-muted-foreground">
        本轮进度 {finished}/{stats.total_words} 已终态。默写记录只存本机。
      </p>
    </div>
  )
}

function Figure({
  label,
  value,
  tone,
}: {
  label: string
  value: number | string
  tone?: 'primary'
}) {
  return (
    // 与本页「逐词明细」同一套表面处理（border + bg-card），不另加阴影：
    // 视觉规范以 WordDetail 为样板，卡片不带投影
    <div className="rounded-lg border border-border/60 bg-card p-3 text-center">
      <div className={`text-xl font-bold ${tone === 'primary' ? 'text-primary' : ''}`}>{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  )
}

function WordBadge({ status }: { status: SpellingWordState['status'] }) {
  const map: Record<SpellingWordState['status'], { cls: string; icon?: typeof Check }> = {
    PENDING: { cls: 'bg-secondary text-muted-foreground' },
    IN_PROGRESS: { cls: 'bg-secondary text-foreground' },
    COMPLETED: { cls: 'bg-primary/15 text-primary', icon: Check },
    SKIPPED: { cls: 'bg-secondary text-muted-foreground', icon: SkipForward },
    UNAVAILABLE: { cls: 'bg-destructive/10 text-destructive', icon: AlertTriangle },
  }
  const cfg = map[status]
  const Icon = cfg.icon
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs ${cfg.cls}`}
    >
      {Icon && <Icon className="h-3 w-3" />}
      {STATUS_LABEL[status]}
    </span>
  )
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))} 秒`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return `${m} 分 ${s} 秒`
}
