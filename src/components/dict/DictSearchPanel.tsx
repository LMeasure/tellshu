/**
 * 词典检索面板（本地 Dexie 三档检索 + 搜索建议 + 词条详情）
 * ------------------------------------------------------------------
 * 数据来源只有两个：本地缓存（离线可用）与后端（同步后才有）。
 * 查不到就显示 EmptyState，**绝不**用示例数据兜底。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, Search, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardBody } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorState } from '@/components/ui/error-state'
import { useDictStore } from '@/store/useDictStore'
import type { DictEntry } from '@/domain/types'

export function DictSearchPanel({ onPickEntry }: { onPickEntry?: (entry: DictEntry) => void }) {
  const query = useDictStore((s) => s.query)
  const hits = useDictStore((s) => s.hits)
  const suggestions = useDictStore((s) => s.suggestions)
  const searching = useDictStore((s) => s.searching)
  const error = useDictStore((s) => s.error)
  const setQuery = useDictStore((s) => s.setQuery)
  const runSearch = useDictStore((s) => s.runSearch)
  const runSuggest = useDictStore((s) => s.runSuggest)
  const clearSearch = useDictStore((s) => s.clearSearch)

  const [touched, setTouched] = useState(false)
  const timer = useRef<number | null>(null)

  // 输入即出建议（防抖 200ms），回车才做完整检索
  useEffect(() => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      void runSuggest(query)
    }, 200)
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    }
  }, [query, runSuggest])

  const showSuggest = useMemo(
    () => query.trim() !== '' && suggestions.length > 0 && hits.length === 0,
    [query, suggestions.length, hits.length],
  )

  if (error !== null) return <ErrorState message={error} onRetry={() => void runSearch(query)} />

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setTouched(true)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void runSearch(query)
            }}
            placeholder="搜单词 / 短语 / 语法点"
            aria-label="搜索词典"
            className="h-11 w-full rounded-xl border border-border bg-card pl-9 pr-9 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-primary"
          />
          {query !== '' && (
            <button
              type="button"
              onClick={() => {
                clearSearch()
                setTouched(false)
              }}
              aria-label="清空搜索"
              title="清空搜索"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <Button size="sm" onClick={() => void runSearch(query)} disabled={query.trim() === ''}>
          搜索
        </Button>
      </div>

      {showSuggest && (
        <Card>
          <CardBody className="divide-y divide-border p-0">
            {suggestions.map((word) => (
              <button
                key={word}
                type="button"
                onClick={() => void runSearch(word)}
                className="flex w-full items-center justify-between px-4 py-3 text-left text-sm text-foreground hover:bg-secondary"
              >
                <span>{word}</span>
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              </button>
            ))}
          </CardBody>
        </Card>
      )}

      {searching && <p className="px-1 text-sm text-muted-foreground">检索中…</p>}

      {!searching && touched && query.trim() !== '' && hits.length === 0 && !showSuggest && (
        <EmptyState
          icon={Search}
          title="本地没有这条"
          description="词典库需要先从服务端同步。去「扫描入库」页同步一次，或确认该词是否已被扫描收录。"
        />
      )}

      {hits.length > 0 && (
        <div className="space-y-2">
          {hits.map((hit) => (
            <button
              key={hit.entry.key}
              type="button"
              onClick={() => onPickEntry?.(hit.entry)}
              className="w-full rounded-2xl border border-border bg-card p-4 text-left transition-colors hover:bg-secondary"
            >
              <div className="flex items-baseline gap-2">
                <span className="text-base font-semibold text-foreground">{hit.entry.word}</span>
                {hit.entry.pos !== '' && (
                  <span className="text-xs text-muted-foreground">{hit.entry.pos}</span>
                )}
                {hit.entry.phonetic !== null && hit.entry.phonetic !== '' && (
                  <span className="text-xs text-muted-foreground">/{hit.entry.phonetic}/</span>
                )}
                <span className="ml-auto rounded-full bg-secondary px-2 py-0.5 text-[10px] text-muted-foreground">
                  {hit.match === 'exact' ? '精确' : hit.match === 'prefix' ? '前缀' : '全文'}
                </span>
              </div>
              {hit.entry.definition_zh !== '' && (
                <p className="mt-1 text-sm text-foreground">{hit.entry.definition_zh}</p>
              )}
              {hit.entry.definition_en !== '' && (
                <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                  {hit.entry.definition_en}
                </p>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
