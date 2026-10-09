import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ChevronLeft, Volume2 } from 'lucide-react'
import { EmptyState } from '@/components/ui/empty-state'
import { getVocabByLayer, getWrongPool, type VocabEntry, type LearnLayer } from '@/domain/learning'
import { speakFocused } from '@/lib/speech'

const TITLES: Record<string, string> = {
  new: '生词本',
  wrong: '错题本',
  apply: '闯关中',
  mastered: '已掌握',
}

/** 集合详情（见 04 §2.8）：列出某层真实词汇，可点读 */
export function CollectionDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [entries, setEntries] = useState<VocabEntry[] | null>(null)

  useEffect(() => {
    if (!id) return
    const load = async () => {
      try {
        const list = id === 'wrong' ? await getWrongPool() : await getVocabByLayer(id as LearnLayer)
        setEntries(list)
      } catch (err) {
        console.error('[CollectionDetail] 读取集合失败', err)
        setEntries([])
      }
    }
    load()
  }, [id])

  const title = TITLES[id ?? ''] ?? '集合'

  if (entries === null) return <div className="p-6 text-sm text-muted-foreground">加载…</div>

  return (
    <div className="px-4 py-4">
      <div className="mb-3 flex items-center gap-2">
        <button onClick={() => navigate(-1)} className="text-muted-foreground">
          <ChevronLeft className="h-6 w-6" />
        </button>
        <div className="text-lg font-semibold">
          {title}（{entries.length}）
        </div>
      </div>
      {entries.length === 0 ? (
        <EmptyState
          icon={Volume2}
          title="空空如也"
          description="去学习流点「生词本」加入单词，或去复习闯关让生词晋级到掌握层。"
        />
      ) : (
        <ul className="space-y-2">
          {entries.map((e) => (
            <li
              key={e.word_id}
              className="flex items-center justify-between rounded-lg bg-card p-3 shadow-soft"
            >
              <div>
                <div className="font-medium">
                  {e.word}
                  {e.pos ? <span className="ml-1 text-xs text-muted-foreground">{e.pos}</span> : null}
                </div>
                {e.ipa && <div className="text-xs text-muted-foreground">/{e.ipa}/</div>}
                {e.definition_zh && (
                  <div className="text-sm text-muted-foreground">{e.definition_zh}</div>
                )}
              </div>
              <button
                onClick={() => void speakFocused(e.word, false)}
                className="flex h-9 w-9 items-center justify-center rounded-full bg-secondary text-primary"
                aria-label="点读"
              >
                <Volume2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
