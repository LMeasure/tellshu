import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Flame, Play, Sparkles, BookMarked, RefreshCw } from 'lucide-react'
import { Card, CardBody } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Bookshelf } from '@/components/home/Bookshelf'
import { repository, type CatalogBook } from '@/data/repository'
import { getLayerCounts, type LayerCounts } from '@/domain/learning'

/**
 * 首页 / 今日学习：学习入口 + 生词本/错题/掌握统计 + 书架。
 * 2026-10-07 改版（需求 2/3/7）：学习路径整体移到复习页；书架换 Bookshelf
 * 组件（导入入口 + 长按多选管理）；页面只保留一套搜索入口（顶部搜索栏）。
 */
export function Home() {
  const navigate = useNavigate()
  const [counts, setCounts] = useState<LayerCounts | null>(null)

  useEffect(() => {
    getLayerCounts()
      .then(setCounts)
      .catch((err) => {
        console.error('[Home] 读取统计失败', err)
        setCounts({ new: 0, apply: 0, mastered: 0, wrong: 0, due: 0, total: 0 })
      })
  }, [])

  const c = counts ?? { new: 0, apply: 0, mastered: 0, wrong: 0, due: 0, total: 0 }

  return (
    <div className="space-y-5 px-4 py-5">
      {/* 今日学习卡 */}
      <Card>
        <CardBody>
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2 text-lg font-semibold">
              <Flame className="h-5 w-5 text-accent" /> 今日学习
            </div>
            <Badge>待复习 {c.due}</Badge>
          </div>
          <Progress value={c.total ? Math.round((c.mastered / c.total) * 100) : 0} className="mb-4" />
          <div className="flex gap-2">
            <Button className="flex-1" onClick={() => navigate('/learn?book=CET4')}>
              <Play className="h-4 w-4" /> 学单词
            </Button>
            <Button variant="secondary" className="flex-1" onClick={() => navigate('/review')}>
              <RefreshCw className="h-4 w-4" /> 去复习
            </Button>
          </div>
        </CardBody>
      </Card>

      {/* 分层统计 */}
      <div className="grid grid-cols-3 gap-2">
        <Mini icon={BookMarked} label="生词本" value={c.new} onClick={() => navigate('/collection/new')} />
        <Mini icon={RefreshCw} label="错题" value={c.wrong} onClick={() => navigate('/collection/wrong')} />
        <Mini icon={Sparkles} label="已掌握" value={c.mastered} onClick={() => navigate('/collection/mastered')} />
      </div>

      {/* 书架（导入入口 + 长按多选管理，见 Bookshelf） */}
      <Bookshelf />
    </div>
  )
}

function Mini({
  icon: Icon,
  label,
  value,
  onClick,
}: {
  icon: typeof BookMarked
  label: string
  value: number
  onClick: () => void
}) {
  return (
    <button onClick={onClick} className="rounded-lg bg-card p-3 text-center shadow-soft">
      <Icon className="mx-auto h-5 w-5 text-accent" />
      <div className="mt-1 text-xl font-bold">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </button>
  )
}
