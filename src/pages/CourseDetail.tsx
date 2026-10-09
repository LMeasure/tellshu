import { useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Bookmark, Play } from 'lucide-react'
import { Card, CardBody } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/empty-state'

/** 课程详情：大图/预览 + 标签 + 简介 + 收藏 + 开始学习（见 04 §2.2、05 §2.2） */
export function CourseDetail() {
  const navigate = useNavigate()
  const { id } = useParams()

  return (
    <div className="pb-4">
      <button onClick={() => navigate(-1)} className="sticky top-0 z-10 p-3 text-foreground">
        <ArrowLeft className="h-6 w-6" />
      </button>

      <EmptyState
        icon={Play}
        title="课程详情待接入"
        description="课程由 Linguabase 课程 / 词单数据驱动。提供数据包后，这里展示大图预览、标签、简介、收藏与开始学习。"
      />

      <div className="px-4">
        <Card>
          <CardBody className="flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold">课程 ID：{id ?? '—'}</div>
              <div className="mt-1 flex gap-1">
                <Badge>待接入</Badge>
              </div>
            </div>
            <Button variant="outline" size="icon" disabled>
              <Bookmark className="h-5 w-5" />
            </Button>
          </CardBody>
        </Card>
      </div>
    </div>
  )
}
