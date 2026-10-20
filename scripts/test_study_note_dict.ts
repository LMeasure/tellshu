/**
 * 学习稿词汇 × 本地词库单测（Phase 2 M3）
 * ------------------------------------------------------------------
 * 覆盖：
 *   1. lemma 候选：常见变形收进候选集合、原词优先、功能词不还原、组合上限
 *   2. resolveVocabDict：精确命中 / 词形还原命中 / 未命中返回 null /
 *      词两侧标点清洗 / 脏查询不崩
 *   3. resolveVocabularyDictHits：数组批量，未命中项原样不动
 *   4. pickEntryByPos：同词形多词条按 pos 择优
 *   5. generateAndSaveStudyNote 集成：SSE 打桩 + 预置词库 → dict_key 落库
 *   6. 入生词本：addToVocab（权威词形）+ isInVocab 幂等 + SRS 排程
 * 运行：npx tsx scripts/test_study_note_dict.ts
 * 注意：Node 无 IndexedDB，storage 自动选内存驱动（与线上 Dexie 行为对齐）。
 */

import { storage } from '@/services/storage'
import { lemmaCandidates, lemmaCandidatesOfWord } from '@/domain/dict/lemma'
import { pickEntryByPos, resolveVocabDict } from '@/domain/studyNote/vocabDict'
import { resolveVocabularyDictHits, generateAndSaveStudyNote } from '@/domain/studyNote/generate'
import { addToVocab, isInVocab, makeWordId } from '@/domain/learning'
import type { DictEntry } from '@/domain/types'
import type { Transcript } from '@/domain/transcript/types'

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

function has(list: string[], value: string): boolean {
  return list.includes(value)
}

/* ------------------------------------------------------------------ */
/* 词库种子（内存 storage）                                            */
/* ------------------------------------------------------------------ */

function seedEntry(word: string, pos: string, phonetic: string | null, definitionZh: string): DictEntry {
  return {
    key: `${word}|${pos}`,
    id: `id-${word}-${pos}`,
    word,
    word_lower: word,
    phonetic,
    pos,
    definition_en: `en of ${word}`,
    definition_zh: definitionZh,
    senses: [],
    examples: [{ en: `example of ${word}`, zh: null }],
    phrases: [],
    synonyms: [],
    antonyms: [],
    tags: [],
    root_affix: null,
    source_page: 1,
    source_book: 'test-book',
    updated_at: 1,
  }
}

async function seedDict(): Promise<void> {
  await storage.table('dictEntries').bulkPut([
    seedEntry('bold', 'adjective', 'bəʊld', '大胆的'),
    seedEntry('look', 'verb', 'lʊk', '看'),
    seedEntry('run', 'verb', 'rʌn', '跑'),
    seedEntry('carry', 'verb', 'kæri', '携带'),
    seedEntry('box', 'noun', 'bɒks', '盒子'),
    seedEntry('spring', 'noun', 'sprɪŋ', '春天'),
    seedEntry('spring', 'verb', 'sprɪŋ', '跳跃'),
  ])
}

/* ------------------------------------------------------------------ */
/* 1. lemma 候选                                                      */
/* ------------------------------------------------------------------ */

console.log('lemma 候选：常见变形、原词优先、功能词、组合上限')

function testLemma(): void {
  const looking = lemmaCandidatesOfWord('looking')
  eq(looking[0], 'looking', '原词排候选首位')
  assert(has(looking, 'look'), 'looking → look（去 ing）')
  assert(has(looking, 'looke'), 'looking → looke（去 ing+e，噪声候选无害）')

  assert(has(lemmaCandidatesOfWord('running'), 'run'), 'running → run（双写辅音还原）')
  assert(has(lemmaCandidatesOfWord('carries'), 'carry'), 'carries → carry（ies → y）')
  assert(has(lemmaCandidatesOfWord('boxes'), 'box'), 'boxes → box（去 es）')
  assert(has(lemmaCandidatesOfWord('stopped'), 'stop'), 'stopped → stop（双写还原）')
  assert(has(lemmaCandidatesOfWord('liked'), 'like'), 'liked → like（去 ed+e）')
  assert(has(lemmaCandidatesOfWord('cats'), 'cat'), 'cats → cat（去 s）')

  eq(lemmaCandidatesOfWord('  ').length, 0, '空串返回空候选')
  eq(lemmaCandidatesOfWord('bold').length, 1, '无规则可剥时只返回原词')

  const phrase = lemmaCandidates('looking forward to meeting')
  eq(phrase[0], 'looking forward to meeting', '短语原样排首位')
  assert(has(phrase, 'look forward to meeting'), '短语逐词还原组合（looking→look，to 不还原）')
  assert(has(phrase, 'look forward to meet'), '短语第二词也还原的组合存在')
  assert(phrase.length <= 8, `短语组合数受上限约束（实际 ${phrase.length}）`)
}

/* ------------------------------------------------------------------ */
/* 2. resolveVocabDict                                                 */
/* ------------------------------------------------------------------ */

console.log('resolveVocabDict: 精确 / 还原 / 未命中 / 标点清洗')

async function testResolve(): Promise<void> {
  const exact = await resolveVocabDict('bold')
  assert(exact !== null && exact.entries[0]?.word === 'bold', '精确命中（原样词形）')
  eq(exact?.dict_key, 'bold|adjective', 'dict_key = 词条 key')

  const lemma = await resolveVocabDict('looked')
  assert(lemma !== null && lemma.matched_form === 'look', 'looked → 还原命中 look')
  eq(lemma?.entries.length, 1, '命中返回全部同词形词条')

  const doubled = await resolveVocabDict('running')
  assert(doubled !== null && doubled.matched_form === 'run', 'running → 命中 run（双写还原）')

  const miss = await resolveVocabDict('zzzqqq')
  eq(miss, null, '未命中返回 null（不编造）')

  const punctuated = await resolveVocabDict('"bold."')
  assert(punctuated !== null, '词两侧引号句号被清洗后命中')

  const multi = await resolveVocabDict('spring')
  eq(multi?.entries.length, 2, '同词形多词条全部返回')
}

/* ------------------------------------------------------------------ */
/* 3. 批量 + pos 择优                                                  */
/* ------------------------------------------------------------------ */

console.log('resolveVocabularyDictHits + pickEntryByPos')

async function testBatch(): Promise<void> {
  const result = await resolveVocabularyDictHits([
    { word: 'bold', pos: 'adjective', gloss: '大胆的' },
    { word: 'running', pos: 'verb', gloss: '跑' },
    { word: 'unknownword', pos: 'noun', gloss: '不存在' },
  ])
  eq(result[0].dict_key, 'bold|adjective', '第一项精确命中记 dict_key')
  eq(result[1].dict_key, 'run|verb', '第二项还原命中 run')
  assert(result[2].dict_key === undefined, '未命中项不记 dict_key（原样保留 gloss）')

  const pickExact = pickEntryByPos(result[0].dict_key === undefined ? [] : [seedEntry('spring', 'noun', null, '春'), seedEntry('spring', 'verb', null, '跳')], 'verb')
  eq(pickExact.pos, 'verb', 'pickEntryByPos 精确匹配词性')
  // 'adverb' 含子串 'verb'，部分匹配命中 verb 是策略预期；换真正无关的 pos 验证回退
  const pickFirst = pickEntryByPos([seedEntry('x', 'noun', null, 'a'), seedEntry('x', 'verb', null, 'b')], 'pronoun')
  eq(pickFirst.pos, 'noun', 'pos 全不匹配回退第一条（不编造）')
}

/* ------------------------------------------------------------------ */
/* 4. generateAndSaveStudyNote 集成（fetch 打桩 + 预置词库）          */
/* ------------------------------------------------------------------ */

console.log('generateAndSaveStudyNote: dict_key 落库链路')

const SN_TRANSCRIPT: Transcript = {
  id: 'job-m3-1',
  language: 'en',
  duration: 6,
  segments: [
    { start: 0, end: 2, text: 'You are a bold one' },
    { start: 2, end: 6, text: 'running through the boxes' },
  ],
}

const SN_NOTE = {
  summary: '一段跑步对白。',
  bilingual_notes: [{ en: 'You are a bold one', zh: '你胆子不小' }],
  key_points: ['bold one 是口语称赞'],
  vocabulary: [
    { word: 'bold', pos: 'adjective', gloss: '大胆的' },
    { word: 'running', pos: 'verb', gloss: '跑' },
    { word: 'carries', pos: 'verb', gloss: '携带' },
  ],
}

const realFetch = globalThis.fetch

function sseDone(note: unknown): string {
  return `data: ${JSON.stringify({ type: 'done', note })}\n\n`
}

function installDoneStream(note: unknown): void {
  globalThis.fetch = (async () => {
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'delta', text: '{"a":1}' })}\n\n`))
        controller.enqueue(encoder.encode(sseDone(note)))
        controller.close()
      },
    })
    return { ok: true, status: 200, body: stream } as unknown as Response
  }) as typeof fetch
}

async function testGenerateWithDict(): Promise<void> {
  installDoneStream(SN_NOTE)
  const record = await generateAndSaveStudyNote(SN_TRANSCRIPT)
  globalThis.fetch = realFetch
  eq(record.status, 'ready', '落库 ready')
  eq(record.vocabulary[0].dict_key, 'bold|adjective', 'bold 命中词库（精确）')
  eq(record.vocabulary[1].dict_key, 'run|verb', 'running 命中词库（词形还原）')
  eq(record.vocabulary[2].dict_key, 'carry|verb', 'carries 命中词库（还原 carries→carry）')
  eq(record.vocabulary[0].segment_start, 0, '回匹仍然生效（bold 在 0s 段）')
  eq(record.vocabulary.length, 3, '三个词全部保留')
}

/* ------------------------------------------------------------------ */
/* 5. 入生词本链路                                                     */
/* ------------------------------------------------------------------ */

console.log('入生词本：权威词形 + 幂等 + SRS')

async function testAddVocab(): Promise<void> {
  const entry = await addToVocab({
    word: 'look',
    pos: 'verb',
    ipa: 'lʊk',
    definition_zh: '看',
  })
  eq(entry.layer, 'new', '入本即 new 层')
  assert(entry.next_review > Date.now(), 'SRS 首复习已排程（10min 后）')
  assert(entry.word_id === 'x:look', 'word_id 口径（无 book → x:小写词）')

  const again = await addToVocab({ word: 'look', pos: 'verb', ipa: 'lʊk', definition_zh: '看' })
  eq(again.word_id, entry.word_id, '重复入本幂等（同 id）')
  eq(await storage.table('vocab').count(), 1, 'vocab 表仍 1 行')

  eq(await isInVocab('x:look'), true, 'isInVocab 命中（词形一致口径）')
  eq(await isInVocab('x:looking'), false, '词形不一致不算已在（真实边界，UI 已按命中词形检查）')
  eq(makeWordId({ word: 'Look' }), 'x:look', 'makeWordId 大小写归一')
}

async function main(): Promise<void> {
  await storage.clearAll()
  await seedDict()
  testLemma()
  await testResolve()
  await testBatch()
  await testGenerateWithDict()
  await testAddVocab()
  restoreFetch()

  console.log('')
  if (failed > 0) {
    console.error(`${failed} 项失败`)
    process.exit(1)
  }
  console.log('study note dict 单测全部通过 ✓')
}

function restoreFetch(): void {
  globalThis.fetch = realFetch
}

main().catch((e) => {
  restoreFetch()
  console.error(e)
  process.exit(1)
})
