/**
 * 学习稿词汇 × 本地词库命中（Phase 2 M3）
 * ------------------------------------------------------------------
 * 链路：vocabulary[].word -> lemmaCandidates 词形扩充 -> 逐个查本地
 * dictEntries（Dexie 索引 word_lower，精确档）-> 命中返回词条，
 * 未命中返回 null（绝不编造词库内容）。
 *
 * 口径（与拆解 §2.3 冻结一致）：
 *   · 查询路径只有本地 IndexedDB dictEntries（22,791 条，词典同步链落入），
 *     不调服务端、不碰 PG——离线场景也必须可用；
 *   · 词形还原走 domain/dict/lemma 规则近似（诚实边界见其文件头）；
 *   · 多条同词形返回全部（词库同词多 pos 是常态），由 UI 按 pos 择优展示；
 *   · 命中即权威：UI 展示词库释义/音标/例句，LLM gloss 降级为语境补充。
 */

import { getDictEntryByWord } from '@/domain/dict'
import { lemmaCandidates } from '@/domain/dict/lemma'
import { dictKey } from '@/domain/dict'
import type { DictEntry } from '@/domain/types'

export interface VocabDictHit {
  /** 命中的词库词条（同词形可能多条） */
  entries: DictEntry[]
  /** 实际命中的查询词形（与 vocabulary.word 可能不同：looking -> look） */
  matched_form: string
  /** 首条词条 key（word|pos），供落库与 UI 直查 */
  dict_key: string
}

/** 词两侧常见标点清洗（LLM 输出词形常带句读）；不清内部，避免误伤连字符短语。 */
function cleanWord(word: string): string {
  return word.trim().replace(/^[\s"'`([{<]+/, '').replace(/[\s"'`)\]}>.,!?;:]+$/, '')
}

/** 按 pos 粗匹配挑一条最优词条（完全匹配 > 词性首段一致 > 第一条）；不编造排序理由。 */
export function pickEntryByPos(entries: DictEntry[], pos: string): DictEntry {
  if (entries.length <= 1 || pos === '') return entries[0]
  const normalized = dictKey(pos)
  const exact = entries.find((e) => dictKey(e.pos) === normalized)
  if (exact !== undefined) return exact
  const partial = entries.find(
    (e) => normalized.includes(dictKey(e.pos)) || dictKey(e.pos).includes(normalized),
  )
  return partial ?? entries[0]
}

/**
 * 查词库：原词及其还原候选依次查精确索引，第一个有结果的候选即命中。
 * 全部落空返回 null（未命中，调用方走「AI 生成」分支）。
 */
export async function resolveVocabDict(word: string): Promise<VocabDictHit | null> {
  const cleaned = cleanWord(word)
  if (cleaned === '') return null

  const seen = new Set<string>()
  for (const candidate of lemmaCandidates(cleaned)) {
    const key = dictKey(candidate)
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    const entries = await getDictEntryByWord(candidate).catch(() => [] as DictEntry[])
    if (entries.length > 0) {
      return { entries, matched_form: entries[0].word, dict_key: entries[0].key }
    }
  }
  return null
}
