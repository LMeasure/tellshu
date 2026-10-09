/**
 * 词条详情卡：音标 / 词性 / 英中释义 / 例句 / 同反义 / 短语 / 词根词缀 / 标签
 * ------------------------------------------------------------------
 * 字段为空就整块不渲染（不显示占位文案、不编造内容）。
 */

import { BookOpen, Quote, Tag } from 'lucide-react'

import { Card, CardBody, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import type { DictEntry } from '@/domain/types'

export function EntryDetailCard({ entry }: { entry: DictEntry }) {
  return (
    <Card>
      <CardBody className="space-y-4">
        <div>
          <div className="flex items-baseline gap-2">
            <CardTitle className="text-xl">{entry.word}</CardTitle>
            {entry.pos !== '' && <span className="text-xs text-muted-foreground">{entry.pos}</span>}
          </div>
          {entry.phonetic !== null && entry.phonetic !== '' && (
            <p className="mt-0.5 text-sm text-muted-foreground">/{entry.phonetic}/</p>
          )}
          {(entry.source_book !== '' || entry.source_page !== null) && (
            <p className="mt-0.5 text-xs text-muted-foreground">
              来源：
              {entry.source_book !== '' ? entry.source_book : '未知书目'}
              {entry.source_page !== null ? ` 第 ${entry.source_page} 页` : ''}
            </p>
          )}
        </div>

        {entry.definition_zh !== '' && (
          <section>
            <h4 className="mb-1 text-xs font-semibold text-muted-foreground">中文释义</h4>
            <p className="text-sm leading-relaxed text-foreground">{entry.definition_zh}</p>
          </section>
        )}

        {entry.definition_en !== '' && (
          <section>
            <h4 className="mb-1 text-xs font-semibold text-muted-foreground">英文释义</h4>
            <p className="text-sm leading-relaxed text-foreground">{entry.definition_en}</p>
          </section>
        )}

        {entry.examples.length > 0 && (
          <section>
            <h4 className="mb-1 flex items-center gap-1 text-xs font-semibold text-muted-foreground">
              <Quote className="h-3.5 w-3.5" /> 例句
            </h4>
            <ul className="space-y-2">
              {entry.examples.map((ex, i) => (
                <li key={`${ex.en}-${i}`} className="text-sm">
                  <p className="text-foreground">{ex.en}</p>
                  {ex.zh !== null && ex.zh !== '' && (
                    <p className="text-xs text-muted-foreground">{ex.zh}</p>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        {entry.phrases.length > 0 && (
          <section>
            <h4 className="mb-1 text-xs font-semibold text-muted-foreground">常用短语</h4>
            <ul className="space-y-1">
              {entry.phrases.map((p, i) => (
                <li key={`${p.text}-${i}`} className="text-sm text-foreground">
                  {p.text}
                  {p.zh !== null && p.zh !== '' && (
                    <span className="text-xs text-muted-foreground"> — {p.zh}</span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        {(entry.synonyms.length > 0 || entry.antonyms.length > 0) && (
          <section className="flex flex-wrap gap-4">
            {entry.synonyms.length > 0 && (
              <div>
                <h4 className="mb-1 text-xs font-semibold text-muted-foreground">同义词</h4>
                <p className="text-sm text-foreground">{entry.synonyms.join(' · ')}</p>
              </div>
            )}
            {entry.antonyms.length > 0 && (
              <div>
                <h4 className="mb-1 text-xs font-semibold text-muted-foreground">反义词</h4>
                <p className="text-sm text-foreground">{entry.antonyms.join(' · ')}</p>
              </div>
            )}
          </section>
        )}

        {entry.root_affix !== null && entry.root_affix !== '' && (
          <section>
            <h4 className="mb-1 flex items-center gap-1 text-xs font-semibold text-muted-foreground">
              <BookOpen className="h-3.5 w-3.5" /> 词根词缀
            </h4>
            <p className="text-sm text-foreground">{entry.root_affix}</p>
          </section>
        )}

        {entry.tags.length > 0 && (
          <section>
            <h4 className="mb-1 flex items-center gap-1 text-xs font-semibold text-muted-foreground">
              <Tag className="h-3.5 w-3.5" /> 标签
            </h4>
            <div className="flex flex-wrap gap-1.5">
              {entry.tags.map((tag) => (
                <Badge key={tag}>{tag}</Badge>
              ))}
            </div>
          </section>
        )}
      </CardBody>
    </Card>
  )
}
