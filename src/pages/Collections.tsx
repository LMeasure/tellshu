import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { BookMarked, AlertTriangle, Trophy } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { getLayerCounts, type LayerCounts } from '@/domain/learning'

/** 收藏与集合（见 04 §2.8、05 §2.8）：生词本 / 错题本 / 掌握层真实列表入口 */
export function Collections() {
  const navigate = useNavigate()
  const [counts, setCounts] = useState<LayerCounts | null>(null)
  useEffect(() => {
    getLayerCounts()
      .then(setCounts)
      .catch((err) => {
        console.error('[Collections] 读取统计失败', err)
        setCounts({ new: 0, apply: 0, mastered: 0, wrong: 0, due: 0, total: 0 })
      })
  }, [])
  const c = counts ?? { new: 0, apply: 0, mastered: 0, wrong: 0, due: 0, total: 0 }

  const items = [
    { id: 'new', label: '生词本', icon: BookMarked, count: c.new },
    { id: 'wrong', label: '错题本', icon: AlertTriangle, count: c.wrong },
    { id: 'mastered', label: '已掌握', icon: Trophy, count: c.mastered },
  ]

  return (
    <div className="px-4 py-4">
      <div className="mb-3 text-lg font-semibold">收藏与集合</div>
      <div className="space-y-2">
        {items.map((it) => (
          <Card key={it.id} onClick={() => navigate(`/collection/${it.id}`)} className="cursor-pointer">
            <div className="flex items-center justify-between p-4">
              <div className="flex items-center gap-2">
                <it.icon className="h-5 w-5 text-accent" />
                <span className="font-medium">{it.label}</span>
              </div>
              <span className="text-sm text-muted-foreground">{it.count} 词</span>
            </div>
          </Card>
        ))}
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        生词本 / 错题 / 掌握层数据完全离线保存在本机（IndexedDB），关闭网络也能学。
      </p>
    </div>
  )
}
