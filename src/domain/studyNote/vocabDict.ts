/**
 * 学习稿词汇 × 本地词库命中（Phase 2 M3）
 * ------------------------------------------------------------------
 * 链路：vocabulary[].word -> lemmaCandidates 词形扩充 -> 逐个查本地
 * dictEntries（Dexie 索引 word_lower，精确档）-> 命中返回词条，
 * 未命中返回 null（绝不编造词库内容）。
 *
 * 口径（与拆解 §2.3 冻结一致）：
 *   · 查询路径只有本地 IndexedDB dictEntries（扫描库，22,791 条是另一套
 *     内置词库 words 表，勿混；默认 0 条，扫了才有），不调服务端、不碰
 *     PG——离线场景也必须可用；
 *   · 词形还原走 domain/dict/lemma 规则近似（诚实边界见其文件头）；
 *   · 多条同词形全部返回（词库同词多 pos 是常态，如 abc=noun+abbreviation）；
 *     生成链只落首条 dict_key（契约不变），UI 展示层按
 *     resolveVocabDictEntriesByKey 补查全量并展开；
 *   · 命中即权威：UI 展示词库释义/音标/例句，LLM gloss 降级为语境补充。
 */

import { getDictEntry, getDictEntryByWord } from '@/domain/dict'
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

/* ------------------------------------------------------------------ */
/* 多义项展开（M3 遗留回填 2026-10-20）                                  */
/* ------------------------------------------------------------------ */

/**
 * 从 dict_key 反解析归一化词形。dict_key 形如 `word|pos`
 * （dict.ts entryKeyOf：word 与 pos 各自字典序归一化后拼成），
 * 取第一个 `|` 前的段。pos 本身不含 `|`（真实取值形如
 * verb.transitive / abbreviation）。
 * 解析不出（无 `|`、前段为空）返回 null——调用方走降级分支。
 */
export function parseDictFormFromKey(dictKeyStr: string): string | null {
  const pipe = dictKeyStr.indexOf('|')
  if (pipe <= 0) return null
  const form = dictKeyStr.slice(0, pipe)
  return form === '' ? null : form
}

/**
 * 多词条展示排序：LLM 标注 pos 精确匹配的排最前，其余保持查询原序。
 * 同时按 key 去重（同词形多条查询路径可能带回同一条；Dexie 主键
 * word|pos 已保证表内不重复，这里是纵深防御）。
 * 不编造排序理由：没有匹配就按索引原序（词库同步落库顺序）。
 */
export function orderEntriesForVocab(entries: DictEntry[], pos: string): DictEntry[] {
  const out: DictEntry[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    if (seen.has(entry.key)) continue
    seen.add(entry.key)
    out.push(entry)
  }

  const normalized = dictKey(pos)
  if (normalized === '' || out.length <= 1) return out
  return [...out].sort((a, b) => {
    const aHit = dictKey(a.pos) === normalized ? 0 : 1
    const bHit = dictKey(b.pos) === normalized ? 0 : 1
    return aHit - bHit // 0/1 比较稳定排序：同分保持原序
  })
}

/**
 * 生成链只落首条 dict_key（契约不变）；UI 展示层据此补查该词形下的
 * 全部词条：先取首条拿权威 word_lower，再按词形查全量，最后按 LLM pos
 * 排序。任一步查不到都不抛——返回空数组由调用方走「词库缺失」降级。
 * 首条 key 已被后续 sync 变更/删除时，同词形其余词条仍可展示（如实呈现
 * 现在还能查到的内容）。
 */
export async function resolveVocabDictEntriesByKey(
  dictKeyStr: string,
  pos: string,
): Promise<DictEntry[]> {
  const first = await getDictEntry(dictKeyStr).catch(() => undefined)
  const form = first?.word_lower ?? parseDictFormFromKey(dictKeyStr)
  if (form === undefined || form === null || form === '') return []
  const all = await getDictEntryByWord(form).catch(() => [] as DictEntry[])
  if (all.length === 0) return []
  return orderEntriesForVocab(all, pos)
}
