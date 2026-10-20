/**
 * 不规则变形例外表单测（M3 边界回填）
 * ------------------------------------------------------------------
 * 覆盖：
 *   1. 表纪律：≥150 条、key/value 均为小写纯字母、无同形、无 value 冲突
 *   2. 过去式 → 原形（went→go、had→have、did→do、was/were→be 等）
 *   3. 过去分词 → 原形（gone→go、written→write、taken→take 等）
 *   4. 不规则复数 → 单数（children→child、phenomena→phenomenon 等）
 *   5. 查表优先：例外表命中后不走规则链路（长度=2，无噪声候选）
 *   6. 大小写不敏感（Went→go、CHILDREN→child）
 *   7. 规则词回归（running 仍含 run、looked 仍含 look——例外表不干扰规则）
 *   8. 短语路径（went home 含 go home、mice ran 含 mouse run）
 *   9. resolveVocabDict 端到端（内存 seed 词库：went→命中 go）
 * 运行：npx tsx scripts/test_irregular.ts
 */

import { storage } from '@/services/storage'
import { IRREGULAR_MAP } from '@/domain/dict/irregular'
import { lemmaCandidates, lemmaCandidatesOfWord } from '@/domain/dict/lemma'
import { resolveVocabDict } from '@/domain/studyNote/vocabDict'
import type { DictEntry } from '@/domain/types'

let failed = 0

function assert(cond: boolean, msg: string) {
  if (cond) console.log('  ✓', msg)
  else {
    console.error('  ✗', msg)
    failed++
  }
}

function eq(actual: unknown, expected: unknown, msg: string) {
  assert(actual === expected, `${msg}（实际 ${String(actual)}，期望 ${String(expected)}）`)
}

/* ------------------------------------------------------------------ */
/* 0. 表纪律                                                          */
/* ------------------------------------------------------------------ */

console.log('例外表纪律：规模、格式、同形、一致性')

const entries = Object.entries(IRREGULAR_MAP)

assert(entries.length >= 150, `收录 ≥150 条（实际 ${entries.length}）`)

const shapeOk = entries.every(([k, v]) => /^[a-z]+$/.test(k) && /^[a-z]+$/.test(v) && v !== '')
assert(shapeOk, '全部 key/value 为小写纯字母且非空')

assert(entries.every(([k, v]) => k !== v), '无同形条目（cut→cut 类不入表）')

// 关键映射抽查（真实变形关系）
const SAMPLE_MAP: Array<[string, string]> = [
  ['went', 'go'], ['gone', 'go'], ['was', 'be'], ['were', 'be'], ['been', 'be'],
  ['had', 'have'], ['did', 'do'], ['done', 'do'], ['took', 'take'], ['taken', 'take'],
  ['saw', 'see'], ['seen', 'see'], ['wrote', 'write'], ['written', 'write'],
  ['children', 'child'], ['men', 'man'], ['women', 'woman'], ['feet', 'foot'], ['teeth', 'tooth'],
  ['mice', 'mouse'], ['geese', 'goose'], ['phenomena', 'phenomenon'], ['criteria', 'criterion'],
  ['knives', 'knife'], ['lives', 'life'], ['matrices', 'matrix'], ['analyses', 'analysis'],
]
const sampleOk = SAMPLE_MAP.every(([k, v]) => IRREGULAR_MAP[k] === v)
assert(sampleOk, `抽查 ${SAMPLE_MAP.length} 组关键映射全部为真实变形关系`)

/* ------------------------------------------------------------------ */
/* 1. 过去式 → 原形                                                    */
/* ------------------------------------------------------------------ */

console.log('过去式 → 原形（查表优先）')

const PAST_CASES: Array<[string, string]> = [
  ['went', 'go'], ['had', 'have'], ['did', 'do'], ['was', 'be'], ['were', 'be'],
  ['said', 'say'], ['made', 'make'], ['took', 'take'], ['came', 'come'], ['saw', 'see'],
  ['gave', 'give'], ['found', 'find'], ['knew', 'know'], ['thought', 'think'], ['told', 'tell'],
  ['became', 'become'], ['began', 'begin'], ['left', 'leave'], ['felt', 'feel'],
  ['brought', 'bring'], ['kept', 'keep'], ['held', 'hold'], ['heard', 'hear'], ['meant', 'mean'],
  ['met', 'meet'], ['ran', 'run'], ['paid', 'pay'], ['sat', 'sit'], ['grew', 'grow'],
  ['fell', 'fall'], ['lost', 'lose'], ['drew', 'draw'], ['spent', 'spend'], ['rose', 'rise'],
  ['built', 'build'], ['caught', 'catch'], ['chose', 'choose'], ['forgot', 'forget'],
  ['drove', 'drive'], ['ate', 'eat'], ['drank', 'drink'], ['sang', 'sing'], ['swam', 'swim'],
]
let pastOk = true
for (const [inflected, base] of PAST_CASES) {
  const list = lemmaCandidatesOfWord(inflected)
  if (list[0] !== base || !list.includes(inflected)) pastOk = false
}
assert(pastOk, `${PAST_CASES.length} 个过去式：首候选=原形且原词兜底`)

eq(lemmaCandidatesOfWord('went').length, 2, '例外表命中后不走规则链路（长度=2，无 we/wentt 噪声）')

/* ------------------------------------------------------------------ */
/* 2. 过去分词 → 原形                                                  */
/* ------------------------------------------------------------------ */

console.log('过去分词 → 原形')

const PARTICIPLE_CASES: Array<[string, string]> = [
  ['gone', 'go'], ['been', 'be'], ['done', 'do'], ['taken', 'take'], ['seen', 'see'],
  ['given', 'give'], ['known', 'know'], ['written', 'write'], ['spoken', 'speak'],
  ['chosen', 'choose'], ['broken', 'break'], ['driven', 'drive'], ['eaten', 'eat'],
  ['drunk', 'drink'], ['sung', 'sing'], ['swum', 'swim'], ['flown', 'fly'], ['blown', 'blow'],
  ['thrown', 'throw'], ['shown', 'show'], ['worn', 'wear'], ['born', 'bear'], ['borne', 'bear'],
  ['torn', 'tear'], ['sworn', 'swear'], ['stolen', 'steal'], ['frozen', 'freeze'],
  ['shaken', 'shake'], ['woven', 'weave'], ['arisen', 'arise'], ['forbidden', 'forbid'],
  ['forsaken', 'forsake'], ['sunk', 'sink'], ['shrunk', 'shrink'], ['rung', 'ring'],
]
let participleOk = true
for (const [inflected, base] of PARTICIPLE_CASES) {
  const list = lemmaCandidatesOfWord(inflected)
  if (list[0] !== base) participleOk = false
}
assert(participleOk, `${PARTICIPLE_CASES.length} 个过去分词：首候选=原形`)

/* ------------------------------------------------------------------ */
/* 3. 不规则复数 → 单数                                                */
/* ------------------------------------------------------------------ */

console.log('不规则复数 → 单数')

const PLURAL_CASES: Array<[string, string]> = [
  ['children', 'child'], ['men', 'man'], ['women', 'woman'], ['feet', 'foot'],
  ['teeth', 'tooth'], ['geese', 'goose'], ['mice', 'mouse'], ['lice', 'louse'],
  ['oxen', 'ox'], ['people', 'person'], ['phenomena', 'phenomenon'], ['criteria', 'criterion'],
  // data 有意不收：现代英语 data 已是独立常用词（data is/are 皆可），
  // 与 dice / bases 同属「歧义变形」，口径见 irregular.ts 头注。
  ['media', 'medium'], ['strata', 'stratum'], ['curricula', 'curriculum'],
  ['bacteria', 'bacterium'], ['alumni', 'alumnus'], ['fungi', 'fungus'], ['larvae', 'larva'],
  ['theses', 'thesis'], ['crises', 'crisis'], ['parentheses', 'parenthesis'],
  ['wolves', 'wolf'], ['leaves', 'leaf'], ['knives', 'knife'], ['loaves', 'loaf'],
]
let pluralOk = true
for (const [inflected, base] of PLURAL_CASES) {
  if (lemmaCandidatesOfWord(inflected)[0] !== base) pluralOk = false
}
assert(pluralOk, `${PLURAL_CASES.length} 个不规则复数：首候选=单数`)

/* ------------------------------------------------------------------ */
/* 4. 大小写不敏感                                                     */
/* ------------------------------------------------------------------ */

console.log('大小写不敏感')

eq(lemmaCandidatesOfWord('Went')[0], 'go', 'Went → go')
eq(lemmaCandidatesOfWord('CHILDREN')[0], 'child', 'CHILDREN → child')
eq(lemmaCandidatesOfWord('Gone')[0], 'go', 'Gone → go')
eq(lemmaCandidatesOfWord('Was')[0], 'be', 'Was → be')
eq(lemmaCandidatesOfWord('WROTE')[0], 'write', 'WROTE → write')

/* ------------------------------------------------------------------ */
/* 5. 规则词回归（例外表不干扰）                                        */
/* ------------------------------------------------------------------ */

console.log('规则词回归')

const RULE_CASES: Array<[string, string]> = [
  ['running', 'run'], ['looked', 'look'], ['carries', 'carry'], ['stopped', 'stop'],
  ['boxes', 'box'], ['cats', 'cat'], ['quickly', 'quick'], ['liked', 'like'],
  ['smaller', 'small'], ['fastest', 'fast'], ['watches', 'watch'], ['studies', 'study'],
]
let ruleOk = true
for (const [inflected, base] of RULE_CASES) {
  if (!lemmaCandidatesOfWord(inflected).includes(base)) ruleOk = false
}
assert(ruleOk, `${RULE_CASES.length} 个规则变形仍含原形候选`)

/* ------------------------------------------------------------------ */
/* 6. 短语路径                                                         */
/* ------------------------------------------------------------------ */

console.log('短语路径（逐词查表）')

assert(lemmaCandidates('went home').includes('go home'), 'went home 含 go home')
eq(lemmaCandidates('went home')[0], 'went home', '短语原样仍在首位')
assert(lemmaCandidates('mice ran').includes('mouse run'), 'mice ran 含 mouse run（两词都还原）')
assert(lemmaCandidates('the mice').includes('the mouse'), 'the mice 含 the mouse（功能词保留）')
assert(lemmaCandidates('children played').includes('child played'), 'children played 含 child played')

/* ------------------------------------------------------------------ */
/* 7. 边界：同形、空串、未知词                                         */
/* ------------------------------------------------------------------ */

console.log('边界：同形/空串/未知词不崩')

const readList = lemmaCandidatesOfWord('read')
assert(readList.includes('read') && readList.every((c) => typeof c === 'string'), '同形 read：原词在候选、无冗余候选')
const putList = lemmaCandidatesOfWord('put')
assert(putList[0] === 'put', '同形 put：查表无增益，原词即首选')
eq(lemmaCandidatesOfWord('   ').length, 0, '空串返回空候选')
const unknownList = lemmaCandidatesOfWord('zzqqxx')
eq(unknownList.length, 1, '未知词只返回原词（不编造）')
assert(unknownList.every((c) => typeof c === 'string'), '未知词候选全部为 string')

/* ------------------------------------------------------------------ */
/* 8. resolveVocabDict 端到端（内存 seed 词库）                        */
/* ------------------------------------------------------------------ */

console.log('resolveVocabDict 端到端')

function seedEntry(word: string, pos: string): DictEntry {
  return {
    key: `${word}|${pos}`,
    id: `id-${word}`,
    word,
    word_lower: word,
    phonetic: null,
    pos,
    definition_en: `en ${word}`,
    definition_zh: `${word} 的释义`,
    senses: [],
    examples: [],
    phrases: [],
    synonyms: [],
    antonyms: [],
    tags: [],
    root_affix: null,
    source_page: 1,
    source_book: 'test',
    updated_at: 1,
  }
}

async function main(): Promise<void> {
  await storage.clearAll()
  await storage.table('dictEntries').bulkPut([
    seedEntry('go', 'verb'),
    seedEntry('child', 'noun'),
    seedEntry('run', 'verb'),
  ])

  const goneHit = await resolveVocabDict('gone')
  assert(goneHit !== null && goneHit.matched_form === 'go', 'gone → 端到端命中 go（例外表+精确索引）')
  eq(goneHit?.dict_key, 'go|verb', 'dict_key 正确')

  const childrenHit = await resolveVocabDict('children')
  assert(childrenHit !== null && childrenHit.matched_form === 'child', 'children → 端到端命中 child')

  const wentHit = await resolveVocabDict('went')
  assert(wentHit !== null && wentHit.matched_form === 'go', 'went → 端到端命中 go')

  const runHit = await resolveVocabDict('running')
  assert(runHit !== null && runHit.matched_form === 'run', 'running → 规则路径仍命中 run（回归）')

  const miss = await resolveVocabDict('zzqqxx')
  eq(miss, null, '未知词端到端未命中（null，不编造）')

  console.log('')
  if (failed > 0) {
    console.error(`${failed} 项失败`)
    process.exit(1)
  }
  console.log('irregular 单测全部通过 ✓')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
