/**
 * 词典扫描词条 · 义项分组展示（2026-10-06 新增）
 * ------------------------------------------------------------------
 * 需求：释义在上排并列（chips），点选哪个释义，就展示该释义的例句；
 * 例句有多少显示多少（不截断、不设上限）。
 *
 * 数据来自扫描词典库（dictEntries.senses，由后端 entry parser 按真实
 * 义项数字分组产出）。解析器没产出分组的老数据回退为「整条释义 + 扁平例句」，
 * 不编造分组。
 *
 * 视觉沿用单词详情页规范：无阴影、淡灰横线分隔、选中态葱绿（bg-primary）。
 */

import { useEffect, useState } from 'react'
import { Quote } from 'lucide-react'

import { ExampleRow } from '@/components/word/ExampleRow'
import { useAppStore } from '@/store/useAppStore'
import type { DictEntry, DictExample } from '@/domain/types'
import { cn } from '@/lib/utils'

/** 义项 chip 上释义的最长显示宽度（超长省略号，完整释义在下方选中区展示） */
const CHIP_MAX_CLASS = 'max-w-[10rem]'

function senseLabel(senseIndex: number, text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean === '') return `义项${senseIndex + 1}`
  return clean
}

/** 一个词条（word + pos 唯一）的义项展示块 */
function DictEntryBlock({
  entry,
  onWordClick,
  activeWord,
}: {
  entry: DictEntry
  onWordClick: (token: string, rect: DOMRect) => void
  activeWord?: string | null
}) {
  const setExampleScore = useAppStore((s) => s.setExampleScore)
  const scores = useAppStore((s) => s.wordDetail.scores)
  const scoreReal = useAppStore((s) => s.wordDetail.scoreReal)

  const senses = entry.senses ?? []
  const [selected, setSelected] = useState(0)

  // 换词条（同页换词）回到第一个义项
  useEffect(() => {
    setSelected(0)
  }, [entry.key])

  const safeIndex = selected >= 0 && selected < senses.length ? selected : 0
  const current = senses.length > 0 ? senses[safeIndex] : undefined

  /** 没挂到任何义项下的例句（如「例：」标记行抽出的）——如实标注展示，不硬塞进义项 */
  const senseExampleKeys = new Set<string>()
  for (const sense of senses) {
    for (const ex of sense.examples) senseExampleKeys.add(ex.en.trim())
  }
  const unassigned: DictExample[] = entry.examples.filter(
    (ex) => !senseExampleKeys.has(ex.en.trim()),
  )

  const scoreKeyOf = (senseIndex: number, exampleIndex: number): string =>
    `dict:${entry.key}:${senseIndex}:${exampleIndex}`

  return (
    <div className="py-4 first:pt-0 last:pb-0">
      {/* 词条头：词 + 词性 + 音标 + 来源 */}
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-lg font-bold text-foreground">{entry.word}</span>
        {entry.pos !== '' && (
          <span className="text-xs italic text-muted-foreground">{entry.pos}</span>
        )}
        {entry.phonetic !== null && entry.phonetic !== '' && (
          <span className="text-sm text-muted-foreground">/{entry.phonetic}/</span>
        )}
        <span className="ml-auto text-[11px] text-muted-foreground">
          {entry.source_book !== '' ? entry.source_book : '词典扫描'}
          {entry.source_page !== null ? ` · 第 ${entry.source_page} 页` : ''}
        </span>
      </div>

      {/* 释义 chips：上排并列；只有 >1 个义项才需要选 */}
      {senses.length > 1 ? (
        <div className="mt-2.5 -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
          {senses.map((sense, i) => {
            const active = i === safeIndex
            const label = senseLabel(i, sense.definition_zh || sense.definition_en || '')
            return (
              <button
                key={`${entry.key}-sense-${i}`}
                type="button"
                onClick={() => setSelected(i)}
                className={cn(
                  'shrink-0 rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
                  CHIP_MAX_CLASS,
                  'truncate',
                  active
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-secondary text-secondary-foreground',
                )}
                aria-label={`选择第 ${i + 1} 个释义：${label}`}
                aria-pressed={active}
                title={label}
              >
                {label}
              </button>
            )
          })}
        </div>
      ) : null}

      {/* 选中义项的释义 + 例句 */}
      {senses.length > 0 && current !== undefined ? (
        <div className="mt-3">
          {current.definition_en !== null && (
            <p className="text-sm leading-relaxed text-foreground/90">{current.definition_en}</p>
          )}
          {current.definition_zh !== '' && (
            <p className="text-[15px] leading-relaxed text-foreground">{current.definition_zh}</p>
          )}

          {current.examples.length > 0 ? (
            <div className="mt-2">
              <h5 className="mb-1 flex items-center gap-1 text-xs font-semibold text-muted-foreground">
                <Quote className="h-3.5 w-3.5" />
                例句（{current.examples.length}）
              </h5>
              <div className="divide-y divide-border">
                {current.examples.map((ex, i) => {
                  const key = scoreKeyOf(safeIndex, i)
                  const score = scores[key]
                  return (
                    <ExampleRow
                      key={`${entry.key}-${safeIndex}-${i}`}
                      en={ex.en}
                      zh={ex.zh ?? undefined}
                      index={i}
                      score={score === undefined ? null : score}
                      realScore={scoreReal[key] === true}
                      onScore={(v, real) => setExampleScore(key, v, real)}
                      onWordClick={onWordClick}
                      activeWord={activeWord}
                    />
                  )
                })}
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        /* 回退：老数据没有义项分组 → 整条释义 + 扁平例句（不编造分组） */
        <>
          {entry.definition_en !== '' && (
            <p className="mt-2 text-sm leading-relaxed text-foreground/90">{entry.definition_en}</p>
          )}
          {entry.definition_zh !== '' && (
            <p className="mt-0.5 text-[15px] leading-relaxed text-foreground">
              {entry.definition_zh}
            </p>
          )}
          {entry.examples.length > 0 ? (
            <div className="mt-2 divide-y divide-border">
              {entry.examples.map((ex, i) => {
                const key = `dict:${entry.key}:-1:${i}`
                const score = scores[key]
                return (
                  <ExampleRow
                    key={`${entry.key}-flat-${i}`}
                    en={ex.en}
                    zh={ex.zh ?? undefined}
                    index={i}
                    score={score === undefined ? null : score}
                    realScore={scoreReal[key] === true}
                    onScore={(v, real) => setExampleScore(key, v, real)}
                    onWordClick={onWordClick}
                    activeWord={activeWord}
                  />
                )
              })}
            </div>
          ) : null}
        </>
      )}

      {/* 未归属任何义项的例句：如实标注，单独列出 */}
      {unassigned.length > 0 ? (
        <div className="mt-3">
          <h5 className="mb-1 text-xs text-muted-foreground">其他例句（未标注所属释义）</h5>
          <div className="divide-y divide-border">
            {unassigned.map((ex, i) => {
              const key = `dict:${entry.key}:other:${i}`
              const score = scores[key]
              return (
                <ExampleRow
                  key={`${entry.key}-other-${i}`}
                  en={ex.en}
                  zh={ex.zh ?? undefined}
                  index={i}
                  score={score === undefined ? null : score}
                  realScore={scoreReal[key] === true}
                  onScore={(v, real) => setExampleScore(key, v, real)}
                  onWordClick={onWordClick}
                  activeWord={activeWord}
                />
              )
            })}
          </div>
        </div>
      ) : null}
    </div>
  )
}

/** 单词详情页里的「词典扫描」分区：本地扫描库中该词的全部词条（word+pos） */
export function DictSenseSection({
  entries,
  onWordClick,
  activeWord,
}: {
  entries: DictEntry[]
  onWordClick: (token: string, rect: DOMRect) => void
  activeWord?: string | null
}) {
  if (entries.length === 0) return null
  return (
    <div className="divide-y divide-border">
      {entries.map((entry) => (
        <DictEntryBlock
          key={entry.key}
          entry={entry}
          onWordClick={onWordClick}
          activeWord={activeWord}
        />
      ))}
    </div>
  )
}
