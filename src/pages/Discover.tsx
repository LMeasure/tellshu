import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Compass, Layers, NotebookPen } from 'lucide-react'
import { Card, CardBody } from '@/components/ui/card'
import { Tabs } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/empty-state'
import { OfflineNotice } from '@/components/OfflineNotice'
import { useOnline } from '@/lib/offline'
import { repository } from '@/data/repository'
import type { ContentCourse, LinguaBankLevel, LinguaTheme } from '@/data/types'

const FILTERS = [
  { key: 'all', label: '推荐' },
  { key: 'scene', label: '场景' },
  { key: 'difficulty', label: '难度' },
  { key: 'skill', label: '技能' },
  { key: 'duration', label: '时长' },
]

/** 发现页：课程卡片流 + 全量词库（主题 / 难度双层）+ 笔记流（Phase 2） */
export function Discover() {
  const navigate = useNavigate()
  const [tab, setTab] = useState('courses')
  const [courses, setCourses] = useState<ContentCourse[] | null>(null)
  const [themes, setThemes] = useState<LinguaTheme[] | null>(null)
  // 断网时索引取不到会是空列表，需要说明「未缓存」而不是让用户以为数据丢了
  const offline = !useOnline()
  const [bank, setBank] = useState<LinguaBankLevel[] | null>(null)

  useEffect(() => {
    if (tab === 'courses') repository.getCourses().then(setCourses)
    if (tab === 'bank') {
      repository.getLinguaThemes().then(setThemes)
      repository.getLinguaBank().then(setBank)
    }
  }, [tab])

  return (
    <div className="px-4 py-4">
      <Tabs
        items={[
          { key: 'courses', label: '课程' },
          { key: 'bank', label: '词库' },
          { key: 'notes', label: '笔记' },
        ]}
        active={tab}
        onChange={setTab}
        className="mb-4"
      />

      {tab === 'courses' ? (
        <>
          <div className="mb-3 flex gap-2 overflow-x-auto no-scrollbar">
            {FILTERS.map((f) => (
              <Badge key={f.key} className="shrink-0 bg-primary/10 text-primary">
                {f.label}
              </Badge>
            ))}
          </div>
          {courses === null ? (
            <div className="p-4 text-sm text-muted-foreground">加载中…</div>
          ) : courses.length === 0 ? (
            <EmptyState
              icon={Compass}
              title="课程待接入"
              description="发现页卡片流来自 Linguabase 课程 / 词单。提供数据包后，这里展示双列卡片网格与筛选。"
            />
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {courses.map((c) => (
                <Card
                  key={c.id}
                  className="cursor-pointer overflow-hidden"
                  onClick={() => navigate(`/course/${c.id}`)}
                >
                  <div className="h-24 bg-secondary" />
                  <CardBody>
                    <div className="line-clamp-2 text-sm font-semibold">{c.title}</div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {c.tags.slice(0, 2).map((t) => (
                        <Badge key={t}>{t}</Badge>
                      ))}
                    </div>
                  </CardBody>
                </Card>
              ))}
            </div>
          )}
        </>
      ) : tab === 'bank' ? (
        <>
          {/* 二级：难度档（L1/L2 直接进；L3 百万级先选首字母） */}
          <div className="mb-4">
            <div className="mb-2 text-sm font-semibold">按难度</div>
            {bank === null ? (
              <div className="text-sm text-muted-foreground">加载中…</div>
            ) : (
              <div className="grid grid-cols-3 gap-2">
                {bank.map((b) => (
                  <Card
                    key={b.id}
                    className="cursor-pointer"
                    onClick={() => navigate(`/bank/level/${b.id}`)}
                  >
                    <CardBody>
                      <div className="text-xs text-muted-foreground">{b.id}</div>
                      <div className="text-sm font-semibold">{b.label}</div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {b.count.toLocaleString()} 词
                      </div>
                    </CardBody>
                  </Card>
                ))}
              </div>
            )}
          </div>

          {/* 一级：45 个日常主题 */}
          <div>
            <div className="mb-2 text-sm font-semibold">按主题</div>
            {themes === null ? (
              <div className="text-sm text-muted-foreground">加载中…</div>
            ) : themes.length === 0 ? (
              <>
                {offline && (
                  <OfflineNotice>
                    主题索引还没缓存过。联网打开一次发现页，之后断网也能看到主题列表。
                  </OfflineNotice>
                )}
                <EmptyState
                  icon={Layers}
                  title={offline ? '离线 · 主题索引未缓存' : '主题词库待接入'}
                  description={
                    offline
                      ? '主题索引很小，联网打开一次就会缓存，之后断网可用。'
                      : '主题数据由 Linguabase categories 生成。缺失时留空，不编造。'
                  }
                />
              </>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                {themes.map((t) => (
                  <Card
                    key={t.id}
                    className="cursor-pointer"
                    onClick={() => navigate(`/bank/theme/${t.id}`)}
                  >
                    <CardBody>
                      <div className="text-sm font-semibold">{t.name_zh}</div>
                      <div className="text-[11px] text-muted-foreground">{t.name}</div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {t.count.toLocaleString()} 词
                      </div>
                    </CardBody>
                  </Card>
                ))}
              </div>
            )}
          </div>
        </>
      ) : (
        <EmptyState
          icon={NotebookPen}
          title="笔记流即将上线"
          description="点赞 / 评论（中英翻译）/ 关注 / 私信等轻量社交在 Phase 2（Supabase）接入。Phase 0 暂不包含。"
        />
      )}
    </div>
  )
}
