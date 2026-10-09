import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  BookOpen,
  ChevronRight,
  Clock,
  Flame,
  Mic,
  Settings as SettingsIcon,
  Star,
  Library,
  Check,
  Award,
  ScanLine,
} from 'lucide-react'
import { IconMailSolid, IconImport } from '@/components/icons/shushu'
import { Card, CardBody } from '@/components/ui/card'
import { Tabs } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/empty-state'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { AccountSection } from '@/components/account/AccountSection'
import {
  getReadings,
  setOnShelf,
  getLayerCounts,
  getDailyStats,
  getMonthlyStats,
  getStreakDays,
  getTotalReadingSeconds,
  getLatestDiagnose,
  getRecitations,
  getTotalRecitationMs,
  type LayerCounts,
  type DailyStat,
  type MonthlyStat,
  type DiagnoseRow,
  type ReadingDoc,
} from '@/domain/learning'
import { fmtDuration as fmtMs } from '@/lib/recorder'

type RangeKey = 'week' | 'month' | 'year' | 'total'

const RANGES = [
  { key: 'week', label: '周' },
  { key: 'month', label: '月' },
  { key: 'year', label: '年' },
  { key: 'total', label: '总' },
]

const LEVEL_NAME: Record<number, string> = { 1: '起步级', 2: '基础级', 3: '进阶级' }

/** 秒 → 「X 小时 Y 分钟」 */
function fmtDuration(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (h > 0) return `${h} 小时 ${m} 分钟`
  return `${m} 分钟`
}

/**
 * 个人中心：可视化进度全部来自本地真实行为日志（复习 / 掌握 / 阅读 / 诊断），
 * 无数据时显示 0 与空引导，**不填充任何演示数字**（见 04 §2.6、06 §7.3）。
 */
export function Profile() {
  const navigate = useNavigate()
  const [range, setRange] = useState<RangeKey>('week')
  const [books, setBooks] = useState<ReadingDoc[] | null>(null)
  const [counts, setCounts] = useState<LayerCounts | null>(null)
  const [days, setDays] = useState<DailyStat[]>([])
  const [months, setMonths] = useState<MonthlyStat[]>([])
  const [streak, setStreak] = useState(0)
  const [readingSec, setReadingSec] = useState(0)
  const [diagnose, setDiagnose] = useState<DiagnoseRow | null>(null)
  /** 背诵录音（阅读器里录的自动归档到这里） */
  const [recCount, setRecCount] = useState<number | null>(null)
  const [recMs, setRecMs] = useState(0)
  /** 消息中心（需求：我的页放消息入口，用 11 号信封） */
  const [msgOpen, setMsgOpen] = useState(false)

  const loadBooks = useCallback(
    () => getReadings().then((all) => setBooks(all.filter((r) => r.type === 'book'))),
    [],
  )

  // 通用统计（分层 / 连续天数 / 诊断等级）
  useEffect(() => {
    loadBooks()
    getLayerCounts().then(setCounts)
    getStreakDays().then(setStreak)
    getLatestDiagnose().then(setDiagnose)
    getRecitations().then((r) => setRecCount(r.length))
    getTotalRecitationMs().then(setRecMs)
  }, [loadBooks])

  // 区间统计：周/月按日，年按月，总为累计
  useEffect(() => {
    let alive = true
    if (range === 'week' || range === 'month') {
      const n = range === 'week' ? 7 : 30
      getDailyStats(n).then((d) => {
        if (!alive) return
        setDays(d)
        setReadingSec(d.reduce((s, x) => s + x.readingSeconds, 0))
      })
    } else if (range === 'year') {
      getMonthlyStats(12).then((m) => {
        if (alive) setMonths(m)
      })
      getTotalReadingSeconds().then((s) => alive && setReadingSec(s))
    } else {
      getTotalReadingSeconds().then((s) => alive && setReadingSec(s))
    }
    return () => {
      alive = false
    }
  }, [range])

  async function toggleShelf(b: ReadingDoc) {
    await setOnShelf(b.id, !b.on_shelf)
    loadBooks()
  }

  const isMonthly = range === 'year'
  const bars: { value: number; label: string }[] = isMonthly
    ? months.map((m) => ({ value: m.mastered, label: m.month.slice(5) + '月' }))
    : range === 'total'
      ? []
      : days.map((d) => ({ value: d.mastered, label: d.date.slice(5) }))
  const maxBar = Math.max(1, ...bars.map((b) => b.value))
  const rangeMastered = bars.reduce((s, b) => s + b.value, 0)
  const rangeReviews = isMonthly
    ? months.reduce((s, m) => s + m.reviews, 0)
    : days.reduce((s, d) => s + d.reviews, 0)
  const totalMastered = counts?.mastered ?? 0

  return (
    <div className="space-y-5 px-4 py-5">
      {/* 账号区块（Phase D）：登录态 / userId / 退出登录 */}
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <AccountSection
            subtitle={
              diagnose
                ? `${LEVEL_NAME[diagnose.level] ?? '学习中'} · 建议 ${diagnose.start_book}`
                : '零基础 · 学习中'
            }
          />
        </div>
        <button onClick={() => navigate('/settings')} className="shrink-0 text-muted-foreground">
          <SettingsIcon className="h-6 w-6" />
        </button>
      </div>

      {/* 连续天数 + 分层统计 */}
      <div className="grid grid-cols-2 gap-3">
        <Card>
          <CardBody className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Flame className="h-5 w-5 text-accent" />
              <span className="text-sm">连续学习</span>
            </div>
            <span className="text-lg font-bold">{streak} 天</span>
          </CardBody>
        </Card>
        <Card>
          <CardBody className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Award className="h-5 w-5 text-primary" />
              <span className="text-sm">已掌握</span>
            </div>
            <span className="text-lg font-bold">{totalMastered}</span>
          </CardBody>
        </Card>
      </div>

      {/* 生词本分层 */}
      <Card>
        <CardBody className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold">生词本分层</span>
            {counts && <span className="text-xs text-muted-foreground">共 {counts.total} 词</span>}
          </div>
          {counts === null ? (
            <div className="text-sm text-muted-foreground">加载中…</div>
          ) : counts.total === 0 ? (
            <EmptyState
              icon={BookOpen}
              title="生词本还是空的"
              description="在「学习」里点生词，或导入文章后长按选词，就会自动加入生词本。"
              className="py-6"
            />
          ) : (
            <div className="flex flex-wrap gap-1.5">
              <Badge className="bg-secondary text-secondary-foreground">生词 {counts.new}</Badge>
              <Badge className="bg-primary/10 text-primary">运用 {counts.apply}</Badge>
              <Badge className="bg-accent/15 text-accent">掌握 {counts.mastered}</Badge>
              {counts.wrong > 0 && (
                <Badge className="bg-destructive/10 text-destructive">错题 {counts.wrong}</Badge>
              )}
              {counts.due > 0 && (
                <Badge className="bg-secondary text-secondary-foreground">
                  待复习 {counts.due}
                </Badge>
              )}
            </div>
          )}
        </CardBody>
      </Card>

      {/* 可视化进度（微信读书式） */}
      <Card>
        <CardBody>
          <div className="mb-3 flex items-center gap-2 text-base font-semibold">
            <BookOpen className="h-5 w-5 text-primary" /> 学习进度
          </div>
          <Tabs items={RANGES} active={range} onChange={(k) => setRange(k as RangeKey)} className="mb-4" />

          {range === 'total' ? (
            <div className="grid grid-cols-2 gap-3 py-2">
              <div>
                <div className="text-xs text-muted-foreground">累计掌握单词</div>
                <div className="text-2xl font-bold">{totalMastered}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">累计复习次数</div>
                <div className="text-2xl font-bold">{rangeReviews}</div>
              </div>
            </div>
          ) : (
            <div className="mb-4">
              <div className="mb-1 flex items-center justify-between text-sm text-muted-foreground">
                <span>每日掌握单词量（生词本 → 掌握层）</span>
                <span>{rangeMastered} 词</span>
              </div>
              <div className="flex h-28 items-end gap-1">
                {bars.length === 0 ? (
                  <div className="w-full text-xs text-muted-foreground">暂无数据</div>
                ) : (
                  bars.map((b, i) => (
                    <div
                      key={i}
                      className="flex-1 rounded-t bg-primary/70"
                      style={{ height: `${Math.max(3, (b.value / maxBar) * 100)}%` }}
                      title={`${b.label} 掌握 ${b.value} 词`}
                    />
                  ))
                )}
              </div>
              {bars.length > 0 && (
                <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
                  <span>{bars[0].label}</span>
                  <span>{bars[bars.length - 1].label}</span>
                </div>
              )}
            </div>
          )}

          <div>
            <div className="mb-1 flex items-center gap-1 text-sm text-muted-foreground">
              <Clock className="h-4 w-4" /> {range === 'total' ? '累计' : isMonthly ? '累计' : '区间'}阅读时长（含听书）
            </div>
            <div className="text-2xl font-bold">{fmtDuration(readingSec)}</div>
          </div>
        </CardBody>
      </Card>

      {/* 书籍（导入的 TXT/EPUB，可加入书架） */}
      <div>
        <div className="mb-2 flex items-center gap-2 px-1 text-base font-semibold">
          <Library className="h-5 w-5 text-primary" /> 我的书籍
        </div>
        {books === null ? (
          <div className="p-3 text-sm text-muted-foreground">加载中…</div>
        ) : books.length === 0 ? (
          <EmptyState
            icon={Library}
            title="还没有书籍"
            description="去「导入素材 → 书籍」上传 TXT / EPUB，导入后在这里加入书架。"
          />
        ) : (
          <div className="space-y-2">
            {books.map((b) => (
              <Card key={b.id} className="cursor-pointer" onClick={() => navigate(`/reader/${b.id}`)}>
                <CardBody className="flex items-center gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-secondary text-primary">
                    <BookOpen className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{b.title}</div>
                    <div className="text-xs text-muted-foreground">{b.word_count} 词</div>
                  </div>
                  <Button
                    variant={b.on_shelf ? 'secondary' : 'outline'}
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation()
                      toggleShelf(b)
                    }}
                  >
                    {b.on_shelf ? <Check className="h-4 w-4" /> : <Library className="h-4 w-4" />}
                    {b.on_shelf ? '已在书架' : '加入书架'}
                  </Button>
                </CardBody>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* 背诵录音：阅读器里录的自动归档，文件名=日期-时长 */}
      <div>
        <div className="mb-2 flex items-center gap-2 px-1 text-base font-semibold">
          <Mic className="h-5 w-5 text-primary" /> 我的背诵
        </div>
        <Card className="cursor-pointer" onClick={() => navigate('/recitations')}>
          <CardBody className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-secondary text-primary">
                <Mic className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <div className="font-medium">背诵录音</div>
                <div className="text-xs text-muted-foreground">
                  {recCount === null
                    ? '加载中…'
                    : recCount === 0
                      ? '还没有录音，去记忆模式录一段'
                      : `${recCount} 条 · 总时长 ${fmtMs(recMs)}`}
                </div>
              </div>
            </div>
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          </CardBody>
        </Card>
      </div>

      {/* 其他入口 */}
      <div className="grid grid-cols-2 gap-3">
        <Card className="cursor-pointer" onClick={() => navigate('/collections')}>
          <CardBody className="flex items-center gap-2">
            <Star className="h-5 w-5 text-accent" /> 收藏与集合
          </CardBody>
        </Card>
        <Card className="cursor-pointer" onClick={() => navigate('/import')}>
          <CardBody className="flex items-center gap-2">
            <IconImport className="h-5 w-5 text-primary" /> 导入素材
          </CardBody>
        </Card>
        <Card
          className="cursor-pointer"
          onClick={() => setMsgOpen(true)}
          aria-label="打开消息中心"
        >
          <CardBody className="flex items-center gap-2">
            <IconMailSolid className="h-5 w-5 text-primary" /> 消息
          </CardBody>
        </Card>
        <Card
          className="cursor-pointer"
          onClick={() => navigate('/dict-ingest')}
          aria-label="进入词典扫描库"
          title="词典扫描库（需管理员口令）"
        >
          <CardBody className="flex items-center gap-2">
            <ScanLine className="h-5 w-5 text-primary" /> 词典扫描库
          </CardBody>
        </Card>
      </div>

      {/* 消息中心（11 号信封入口）：当前没有消息产生源，如实显示空态，不造内容 */}
      <Dialog
        open={msgOpen}
        onClose={() => setMsgOpen(false)}
        title="消息"
        footer={
          <Button className="w-full" onClick={() => setMsgOpen(false)}>
            知道了
          </Button>
        }
      >
        <EmptyState
          icon={IconMailSolid}
          title="暂无消息"
          description="以后学习提醒会出现在这里。"
          className="py-2"
        />
      </Dialog>

      <p className="px-1 text-xs text-muted-foreground">
        进度数据来自本机学习记录，实时更新；清除浏览器数据会一并清空。
      </p>
    </div>
  )
}
