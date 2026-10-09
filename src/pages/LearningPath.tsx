import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Route as RouteIcon, BookOpen, ArrowRight, Loader2 } from 'lucide-react'
import { Card, CardBody } from '@/components/ui/card'
import { Tabs } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/empty-state'
import { repository, type CatalogBook } from '@/data/repository'
import type { DifficultyLevel } from '@/data/types'

const LEVEL_TABS = [
  { key: 'all', label: '全部' },
  { key: '1', label: '基础短词' },
  { key: '2', label: '常用词' },
  { key: '3', label: '进阶长词' },
]

const LEVEL_HINT: Record<number, string> = {
  1: '短单词、构词简单，零基础从这里起步',
  2: '日常与考试常用词，词汇量的主体',
  3: '长词与派生词，构词较复杂，进阶阶段',
}

/**
 * 学习路径（见 04 §2.3）：按「词本 × 难度档」组织，节点数量来自预计算的 catalog.json。
 * 分档依据是词库里真实存在的词长与构词素（morphemes），不是任何人为编造的难度分。
 * 点任一节点进入该档单词的学习流。
 */
export function LearningPath() {
  const navigate = useNavigate()
  const [books, setBooks] = useState<CatalogBook[] | null>(null)
  const [tab, setTab] = useState('all')

  useEffect(() => {
    repository.getCatalog().then(setBooks)
  }, [])

  const totals = useMemo(() => {
    const sum = (lv: DifficultyLevel) =>
      (books ?? []).reduce((s, b) => s + (b.levels.find((x) => x.level === lv)?.count ?? 0), 0)
    return { total: (books ?? []).reduce((s, b) => s + b.total, 0), l1: sum(1), l2: sum(2), l3: sum(3) }
  }, [books])

  /** 当前筛选档位下，每个词本要展示的节点 */
  const shown = useMemo(() => {
    if (!books) return []
    return books
      .map((b) => ({
        book: b,
        levels: tab === 'all' ? b.levels : b.levels.filter((l) => String(l.level) === tab),
      }))
      .filter((x) => x.levels.length > 0)
  }, [books, tab])

  if (books === null) {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> 加载学习路径…
      </div>
    )
  }

  if (books.length === 0) {
    return (
      <EmptyState
        icon={RouteIcon}
        title="路径数据待接入"
        description="学习路径由词库目录（catalog.json）生成。请运行 scripts/build_search_index.py 后重试。"
      />
    )
  }

  return (
    <div className="px-4 py-4">
      <div className="mb-1 flex items-center gap-2 text-lg font-semibold">
        <RouteIcon className="h-5 w-5 text-primary" /> 学习路径
      </div>
      <p className="mb-3 text-sm text-muted-foreground">
        共 {totals.total.toLocaleString('zh-CN')} 词 · 按词本与难度分档组织，任选一个节点开始学。
      </p>

      <Tabs items={LEVEL_TABS} active={tab} onChange={setTab} className="mb-4" />

      <div className="space-y-5">
        {shown.map(({ book, levels }) => (
          <div key={book.id}>
            <div className="mb-2 flex items-center gap-2 px-1">
              <BookOpen className="h-4 w-4 text-primary" />
              <span className="text-sm font-semibold">{book.name}</span>
              <span className="text-xs text-muted-foreground">{book.total} 词</span>
            </div>
            <div className="space-y-2">
              {levels.map((l) => (
                <Card
                  key={l.level}
                  className="cursor-pointer"
                  onClick={() => navigate(`/learn?book=${book.id}&level=${l.level}`)}
                >
                  <CardBody className="flex items-center justify-between">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{l.label}</span>
                        <Badge>难度 {l.level}</Badge>
                      </div>
                      <div className="mt-0.5 text-xs text-muted-foreground">{LEVEL_HINT[l.level]}</div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="text-sm text-muted-foreground">{l.count} 词</span>
                      <ArrowRight className="h-4 w-4 text-muted-foreground" />
                    </div>
                  </CardBody>
                </Card>
              ))}
            </div>
          </div>
        ))}
      </div>

      <p className="mt-5 px-1 text-xs text-muted-foreground">
        分档依据词库里真实存在的词长与构词素，不使用任何人为难度评分。
      </p>
    </div>
  )
}
