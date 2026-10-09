import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Mic, Trash2, BookOpen } from 'lucide-react'
import { Card, CardBody } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/empty-state'
import { useMediaAudio } from '@/hooks/useMediaAudio'
import { getRecitations, deleteRecitation, type Recitation } from '@/domain/learning'
// fmtSize 已收敛到 lib/recorder（原先这里和 Profile 各写了一份）
import { fmtDuration, fmtSize } from '@/lib/recorder'

/** 时间戳 → 「M月D日 HH:mm」 */
function fmtTime(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 我的 → 背诵
 * ------------------------------------------------------------------
 * 阅读器里录的每一条背诵都会自动归档到这里，文件名即「当前日期-背诵时长」。
 * 音频以 Blob 存在 IndexedDB，本页面现场生成 ObjectURL 供 <audio> 播放，
 * 组件卸载/删除时释放，不占内存。没有任何录音时显示空状态，不造假数据。
 */
export function Recitations() {
  const navigate = useNavigate()
  const [list, setList] = useState<Recitation[] | null>(null)

  const load = useCallback(() => {
    getRecitations().then(setList)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // 按来源素材分组：同一本书的录音归到一起，方便回听
  const groups = useMemo(() => {
    const m = new Map<string, Recitation[]>()
    for (const r of list ?? []) {
      const key = r.doc_title || '自由背诵'
      const arr = m.get(key)
      if (arr) arr.push(r)
      else m.set(key, [r])
    }
    return [...m.entries()].map(([title, items]) => ({
      title,
      docId: items[0].doc_id,
      items: [...items].sort((a, b) => b.created_at - a.created_at),
    }))
  }, [list])

  const totalMs = (list ?? []).reduce((s, r) => s + r.duration_ms, 0)

  async function remove(id: string) {
    await deleteRecitation(id)
    load()
  }

  return (
    <div className="space-y-4 px-4 py-5">
      <div className="flex items-center gap-2">
        <button
          onClick={() => navigate(-1)}
          className="text-muted-foreground"
          aria-label="返回"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <h1 className="text-lg font-bold">我的背诵</h1>
      </div>

      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Mic className="h-4 w-4 text-primary" />
        <span>共 {list?.length ?? 0} 条</span>
        <span>·</span>
        <span>总时长 {fmtDuration(totalMs)}</span>
      </div>

      {list === null ? (
        <div className="p-3 text-sm text-muted-foreground">加载中…</div>
      ) : list.length === 0 ? (
        <EmptyState
          icon={Mic}
          title="还没有背诵录音"
          description="打开一本书或一篇文章，进入记忆模式点「开始录音」，录完自动存到这里，文件名是「日期-时长」。"
        />
      ) : (
        groups.map((g) => (
          <Card key={g.title}>
            <CardBody className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-1.5">
                  <BookOpen className="h-4 w-4 shrink-0 text-primary" />
                  <span className="truncate text-sm font-semibold">{g.title}</span>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Badge className="bg-secondary text-secondary-foreground">
                    {g.items.length} 条
                  </Badge>
                  {g.docId && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => navigate(`/reader/${g.docId}`)}
                    >
                      去原文
                    </Button>
                  )}
                </div>
              </div>

              <ul className="space-y-2">
                {g.items.map((r) => (
                  <RecitationItem key={r.id} rec={r} onDelete={() => remove(r.id)} />
                ))}
              </ul>
            </CardBody>
          </Card>
        ))
      )}

      <p className="px-1 text-xs text-muted-foreground">
        音频只存在本机浏览器里，不上传；清除浏览器数据会一并删除。
      </p>
    </div>
  )
}

function RecitationItem({ rec, onDelete }: { rec: Recitation; onDelete: () => void }) {
  const [url, setUrl] = useState<string | null>(null)
  const mediaRef = useMediaAudio()
  useEffect(() => {
    const u = URL.createObjectURL(rec.blob)
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [rec.blob])

  return (
    <li className="space-y-1.5 rounded-lg bg-secondary/50 p-2">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{rec.title}</div>
          <div className="text-xs text-muted-foreground">
            {fmtTime(rec.created_at)} · {fmtDuration(rec.duration_ms)} · {fmtSize(rec.size)}
            {typeof rec.page === 'number' && ` · 第 ${rec.page + 1} 页`}
          </div>
        </div>
        <button
          onClick={onDelete}
          className="shrink-0 text-muted-foreground hover:text-destructive"
          aria-label="删除录音"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
      {url && <audio ref={mediaRef} controls src={url} className="w-full" preload="metadata" />}
    </li>
  )
}
