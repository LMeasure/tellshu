import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { ContentWord } from '@/data/types'
import { lookupWordVariants } from '@/data/repository'
import { lemmaCandidates, stripWordPunct } from '@/lib/wordSense'
import { tokenize } from '@/lib/masking'
import { cn } from '@/lib/utils'
import { WordPopover } from '@/components/word/WordPopover'

interface ExampleItem {
  en: string
  zh: string
}

/**
 * 学习卡里的例句列表（本轮新增「点词查词」能力，独立组件、不碰其它模块）
 * ------------------------------------------------------------------
 *  - 英文例句始终显示；中文翻译**常驻显示**（不再受「中文辅助」开关控制，全局统一规则）。
 *  - 英文句里每个**单词**可点：弹出小释义窗（复用单词详情同款 WordPopover）；
 *    标点 / 空格不可点（tokenize 已把非单词 token 标成 word:false）。
 *  - 「查看详情」跳到 /word/:word（复用现有详情路由）；返回学习卡时
 *    进度由 Dexie 会话持久化（v11 wordLearningSessions）恢复，不丢位置。
 *  - 不修改 parseDefinitionZh / WordDetail / 词典数据；不碰滑动手势
 *    （点词是 click，滑动需要位移阈值 + 轴向锁定，二者不冲突）。
 */
export function WordCardExampleList({ examples }: { examples: ExampleItem[] }) {
  const navigate = useNavigate()

  const [pop, setPop] = useState<{ raw: string; rect: DOMRect } | null>(null)
  const [popData, setPopData] = useState<{ data: ContentWord | null; matched: string | null } | null>(
    null,
  )
  const [popLoading, setPopLoading] = useState(false)
  /** 快速连点：丢弃过期的旧结果，避免后点的词被先点的旧释义覆盖 */
  const popSeq = useRef(0)

  const openWord = useCallback((raw: string, rect: DOMRect) => {
    const seq = ++popSeq.current
    setPop({ raw, rect })
    setPopData(null)
    setPopLoading(true)
    lookupWordVariants(lemmaCandidates(raw))
      .then((hit) => {
        if (seq !== popSeq.current) return
        setPopData({ data: hit, matched: hit?.word ?? null })
        setPopLoading(false)
      })
      .catch(() => {
        if (seq !== popSeq.current) return
        setPopData({ data: null, matched: null })
        setPopLoading(false)
      })
  }, [])

  const goWord = useCallback(
    (w: string) => {
      const t = w.trim()
      if (!t) return
      navigate(`/word/${encodeURIComponent(t)}`)
    },
    [navigate],
  )

  /** Esc 关弹窗（与 WordDetail 同款交互） */
  useEffect(() => {
    if (!pop) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPop(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pop])

  return (
    <>
      <ul className="mt-2 space-y-2 text-sm">
        {examples.map((ex, i) => (
          <li key={i} className="rounded-md border border-border/50 p-2">
            <p className="text-foreground [overflow-wrap:anywhere]" data-testid="example-en">
              {tokenize(ex.en, 'en').map((tk, j) => {
                if (!tk.word) return <span key={j}>{tk.t}</span>
                const raw = stripWordPunct(tk.t)
                if (!raw) return <span key={j}>{tk.t}</span>
                const active = pop?.raw != null && raw.toLowerCase() === pop.raw.toLowerCase()
                return (
                  <button
                    type="button"
                    key={j}
                    onClick={(e) => {
                      e.stopPropagation()
                      openWord(raw, e.currentTarget.getBoundingClientRect())
                    }}
                    className={cn(
                      'rounded px-0.5 transition-colors',
                      active
                        ? 'bg-primary/15 text-primary'
                        : 'hover:bg-primary/10 hover:text-primary',
                    )}
                  >
                    {tk.t}
                  </button>
                )
              })}
            </p>
            {ex.zh && (
              <p className="mt-0.5 text-xs text-emerald-600 dark:text-emerald-400" data-testid="example-zh">
                {ex.zh}
              </p>
            )}
          </li>
        ))}
      </ul>

      {pop ? (
        <WordPopover
          raw={pop.raw}
          matched={popData?.matched ?? null}
          data={popData?.data ?? null}
          loading={popLoading}
          rect={pop.rect}
          onClose={() => setPop(null)}
          onDetail={goWord}
        />
      ) : null}
    </>
  )
}
