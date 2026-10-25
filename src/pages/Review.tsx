import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  RefreshCw,
  BookMarked,
  AlertTriangle,
  Trophy,
  Route as RouteIcon,
  PenLine,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardBody } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Segmented } from '@/components/ui/segmented'
import { EmptyState } from '@/components/ui/empty-state'
import {
  getDueReviews,
  getLayerCounts,
  nextReviewLabel,
  type VocabEntry,
  type LayerCounts,
} from '@/domain/learning'
import { DEFAULT_TARGET_CORRECT, type SpellingSelectionMode } from '@/domain/spellingSession'
import { repository, type CatalogBook } from '@/data/repository'
import { useAppStore } from '@/store/useAppStore'

/** 单词默写入口的三种选词模式（与领域层 SpellingSelectionMode 一致） */
const SPELLING_MODES: { key: SpellingSelectionMode; label: string }[] = [
  { key: 'random', label: '随机' },
  { key: 'recent', label: '最近新增' },
  { key: 'wrong', label: '易错词' },
]

/**
 * 复习 Tab（见 02-IA §1、04 §2.6、09 Phase 1）：
 * 真实待复习队列（生词 + 错题合并，按 next_review 排序），完全离线（IndexedDB）。
 * 2026-10-07 改版（需求 2）：学习路径从首页整体移到这里 —— 路径的终点就是复习。
 */
export function Review() {
  const navigate = useNavigate()
  const batchSize = useAppStore((s) => s.settings.studyBatchSize)
  const [due, setDue] = useState<VocabEntry[] | null>(null)
  const [counts, setCounts] = useState<LayerCounts | null>(null)
  const [catalog, setCatalog] = useState<CatalogBook[] | null>(null)
  const [spellingMode, setSpellingMode] = useState<SpellingSelectionMode>('recent')

  useEffect(() => {
    getDueReviews()
      .then(setDue)
      .catch((err) => {
        console.error('[Review] 读取复习队列失败', err)
        setDue([])
      })
    getLayerCounts()
      .then(setCounts)
      .catch((err) => {
        console.error('[Review] 读取统计失败', err)
        setCounts({ new: 0, apply: 0, mastered: 0, wrong: 0, due: 0, total: 0 })
      })
    repository
      .getCatalog()
      .then(setCatalog)
      .catch(() => setCatalog([]))
  }, [])

  if (due === null) {
    return <div className="p-6 text-sm text-muted-foreground">加载复习队列…</div>
  }

  const c = counts ?? { new: 0, apply: 0, mastered: 0, wrong: 0, due: 0, total: 0 }

  return (
    <div className="space-y-5 px-4 py-5">
      <div>
        <div className="mb-2 text-lg font-semibold">复习</div>
        <div className="grid grid-cols-3 gap-2">
          <Stat icon={BookMarked} label="生词本" value={c.new} />
          <Stat icon={AlertTriangle} label="错题" value={c.wrong} />
          <Stat icon={Trophy} label="已掌握" value={c.mastered} />
        </div>
      </div>

      <Card>
        <CardBody>
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2 font-semibold">
              <RefreshCw className="h-5 w-5 text-primary" /> 待复习队列
            </div>
            <span className="text-sm text-muted-foreground">{due.length} 个</span>
          </div>
          <p className="mb-3 text-sm text-muted-foreground">
            生词 + 错题合并，按遗忘曲线排程（10 分钟 / 1 小时 / 1 天 / 3 天 / 7 天 / 14 天 / 30 天）。
            本轮将复习 <b className="text-foreground">{Math.min(due.length, batchSize)}</b> 个
            （每轮 {batchSize} 个，可在「设置」调整）。
          </p>
          {due.length === 0 ? (
            <p className="text-sm text-muted-foreground">现在没有到点的词，去学习流加点生词吧。</p>
          ) : (
            <ul className="mb-3 max-h-60 space-y-1 overflow-auto text-sm">
              {due.slice(0, 20).map((v) => (
                <li
                  key={v.word_id}
                  className="flex items-center justify-between rounded bg-secondary/50 px-3 py-1.5"
                >
                  <span className="font-medium">{v.word}</span>
                  <span className="text-xs text-muted-foreground">{nextReviewLabel(v.next_review)}</span>
                </li>
              ))}
            </ul>
          )}
          <Button className="w-full" disabled={due.length === 0} onClick={() => navigate('/challenge')}>
            开始闯关
          </Button>
        </CardBody>
      </Card>

      {/* 单词默写入口（D4：入口放 /review 页内卡片，不新增底部 Tab） */}
      <Card>
        <CardBody>
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2 font-semibold">
              <PenLine className="h-5 w-5 text-primary" /> 单词默写
            </div>
            <Badge>连对 {DEFAULT_TARGET_CORRECT} 次</Badge>
          </div>
          <p className="mb-3 text-sm text-muted-foreground">
            看中文释义写英文。本轮 <b className="text-foreground">{batchSize}</b> 个
            （每轮词数在「设置」里调，学习和闯关共用）；连续拼对 {DEFAULT_TARGET_CORRECT} 次记为掌握，
            计入生词本复习排程。进度存在本机，中途退出可继续。
          </p>
          <div className="mb-3">
            <Segmented
              items={SPELLING_MODES.map((m) => ({ key: m.key, label: m.label }))}
              value={spellingMode}
              onChange={setSpellingMode}
              size="sm"
            />
          </div>
          <Button className="w-full" onClick={() => navigate(`/spelling?mode=${spellingMode}`)}>
            开始默写
          </Button>
        </CardBody>
      </Card>

      {/* 学习路径（从首页迁入；数据来自预计算目录，无编造） */}
      <div>
        <div className="mb-2 flex items-center justify-between px-1">
          <div className="flex items-center gap-2 text-base font-semibold">
            <RouteIcon className="h-5 w-5 text-primary" /> 学习路径
          </div>
          <button className="text-xs text-muted-foreground" onClick={() => navigate('/path')}>
            全部
          </button>
        </div>
        {catalog === null ? (
          <div className="p-4 text-sm text-muted-foreground">加载路径中…</div>
        ) : catalog.length === 0 ? (
          <EmptyState
            icon={RouteIcon}
            title="路径内容待接入"
            description="学习路径由词库目录生成。运行 scripts/build_search_index.py 后即可展示。"
          />
        ) : (
          <div className="space-y-2">
            {catalog.slice(0, 3).map((b) => {
              const first = b.levels[0]
              return (
                <Card
                  key={b.id}
                  className="cursor-pointer"
                  onClick={() =>
                    first
                      ? navigate(`/learn?book=${b.id}&level=${first.level}`)
                      : navigate(`/learn?book=${b.id}`)
                  }
                >
                  <CardBody className="flex items-center justify-between">
                    <div>
                      <span className="font-medium">{b.name}</span>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {first ? `从「${first.label}」起步` : '暂无分档'} · {b.total} 词
                      </div>
                    </div>
                    <Badge>{b.levels.length} 档</Badge>
                  </CardBody>
                </Card>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

function Stat({ icon: Icon, label, value }: { icon: typeof BookMarked; label: string; value: number }) {
  return (
    <div className="rounded-lg bg-card p-3 text-center shadow-soft">
      <Icon className="mx-auto h-5 w-5 text-accent" />
      <div className="mt-1 text-xl font-bold">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  )
}
