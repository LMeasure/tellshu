/**
 * 同词形多义项展开单测（M3 遗留回填 2026-10-20）
 * ------------------------------------------------------------------
 * 背景：生成链只落首条 dict_key（契约不变），UI 展示层用
 * resolveVocabDictEntriesByKey 补查该词形全部词条并展开。
 * 本测试覆盖：
 *   1. parseDictFormFromKey：dict_key 反解析归一化词形（边界）
 *   2. orderEntriesForVocab：LLM pos 精确匹配优先、同 key 去重、
 *      同 pos 不误删、排序稳定
 *   3. resolveVocabDictEntriesByKey 集成：走真实 storage 查询链路
 *      · 单义项（a|article 真实词条）
 *      · 多 pos 全展示 + pos 排序（ABC noun/abbreviation 真实双词条，
 *        大写词形同时验证大小写归一）
 *      · 规则还原（abating→abate 真实词条）
 *      · 不规则还原（gone→go；seed 夹具，与 test_irregular 同源）
 *      · 首条被删的部分缺失（如实呈现现存词条）
 *      · 全缺失返回 []（UI 走降级）
 *      · 无匹配兜底
 *   4. 契约回归：resolveVocabularyDictHits 仍只记首条 dict_key；
 *      generateAndSaveStudyNote 落库形态不变
 *   5. 短语路径不退化
 *
 * 夹具来源：a / ABC×2 / abandon / abate 五条为 PG shutree.entries
 * 当前真实行（12 条开发种子之一），definition/examples 原文照抄；
 * go / child / spring / spring-samepos 为构造夹具（已在注释标注），
 * 用于覆盖真实库当前无法表达的情形。
 *
 * 运行：npx tsx scripts/test_vocab_senses.ts
 * 注意：Node 无 IndexedDB，storage 自动选内存驱动。
 */

import { storage } from '@/services/storage'
import { parseDictFormFromKey, orderEntriesForVocab, resolveVocabDictEntriesByKey } from '@/domain/studyNote/vocabDict'
import { resolveVocabDict } from '@/domain/studyNote/vocabDict'
import { resolveVocabularyDictHits, generateAndSaveStudyNote } from '@/domain/studyNote/generate'
import type { DictEntry, DictExample, DictSense } from '@/domain/types'
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

/* ------------------------------------------------------------------ */
/* 夹具构造                                                            */
/* ------------------------------------------------------------------ */

interface SeedSpec {
  word: string
  pos: string
  phonetic: string | null
  definition_en: string
  definition_zh: string
  examples: DictExample[]
  senses?: DictSense[]
}

function fromSpec(spec: SeedSpec): DictEntry {
  return {
    key: `${spec.word.toLowerCase()}|${spec.pos.toLowerCase()}`,
    id: `id-${spec.word.toLowerCase()}-${spec.pos}`,
    word: spec.word,
    word_lower: spec.word.toLowerCase(),
    phonetic: spec.phonetic,
    pos: spec.pos,
    definition_en: spec.definition_en,
    definition_zh: spec.definition_zh,
    senses: spec.senses ?? [],
    examples: spec.examples,
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

/* —— 真实 PG 行（entries 表现状 12 条种子中照抄） —— */

const REAL_A: SeedSpec = {
  word: 'a',
  pos: 'article',
  phonetic: ',er',
  definition_en: 'one( ) ( )',
  definition_zh:
    '不定冠词，非特指 一 个、支、只、张、架、台、本等 ： 某一群体中的一员 ： 不定冠词，非特指 每个 任何一个： 一辆 自行车有两个轮子。 用于人名之前 某一',
  examples: [
    { en: 'She has an apple and a pear.', zh: '她有一个苹果和一个梨。' },
    { en: 'He is a teacher.', zh: '他是老师。' },
    { en: 'A Mr.Smith came to see you.', zh: '一位姓史密斯的先生来看你。' },
  ],
}

/** 真实 PG entries 表 word='ABC' 两行：同词形不同 pos 的真实多义项案例 */
const REAL_ABC_NOUN: SeedSpec = {
  word: 'ABC',
  pos: 'noun',
  phonetic: 'ier bi: si:',
  definition_en:
    'the alphabet(as taught to children) ( ) the basic facts about sth.which have to be learned first ; classes in the ABC of cooking',
  definition_zh: '教给儿童的 字母（表） 基础知识 人门： 烹饪入门课',
  examples: [],
}

const REAL_ABC_ABBR: SeedSpec = {
  word: 'ABC',
  pos: 'abbreviation',
  phonetic: 'ier bi: si:',
  definition_en: 'American Broadcasting Company an American-born Chinese',
  definition_zh: '美国广播公司 出生在美国的华人',
  examples: [],
}

const REAL_ABANDON: SeedSpec = {
  word: 'abandon',
  pos: 'verb.transitive',
  phonetic: "'baendan",
  definition_en: 'to give up; to leave sb./sth. ; [ abandon oneself to sth.',
  definition_zh: '放弃 抛弃； 常用短语 沉溺于',
  examples: [
    { en: 'The sailors abandoned the ship when it was sinking.', zh: '船员们离开了正在下沉的船。' },
    { en: "Don't abandon yourself to despair.", zh: '不要陷人绝望。' },
  ],
}

const REAL_ABATE: SeedSpec = {
  word: 'abate',
  pos: 'verb',
  phonetic: "ə'bert",
  definition_en:
    '(of floods, storms,sounds,pain,etc.)to become less strong; to decrease',
  definition_zh: '（洪水、暴风雨、声音、病痛等）减少，减轻，减退 废除，撤销： 撤销诉讼',
  examples: [{ en: 'The storm abated at last.', zh: '暴风雨终于减弱了。' }],
}

/* —— 构造夹具（真实库当前无法表达或暂无对应行，明确标注） —— */

/** 不规则还原集成：gone→go。与 test_irregular.ts 同源夹具 */
const SEED_GO: SeedSpec = { word: 'go', pos: 'verb', phonetic: 'gəʊ', definition_en: 'to move', definition_zh: '去', examples: [{ en: 'Let it go.', zh: null }] }
const SEED_CHILD: SeedSpec = { word: 'child', pos: 'noun', phonetic: 'tʃaɪld', definition_en: 'a young human', definition_zh: '孩子', examples: [{ en: 'The child plays.', zh: '孩子在玩。' }] }

/** 排序单测：同 word 多 pos（spring），项目既有夹具风格（test_study_note_dict.ts 同款） */
const SEED_SPRING_NOUN: SeedSpec = { word: 'spring', pos: 'noun', phonetic: 'sprɪŋ', definition_en: 'the season', definition_zh: '春天', examples: [] }
const SEED_SPRING_VERB: SeedSpec = { word: 'spring', pos: 'verb', phonetic: 'sprɪŋ', definition_en: 'to jump', definition_zh: '跳跃', examples: [] }

/** 「同 pos 不同 key」构造件：真实主键 word|pos 下同词形同 pos 不可达，仅验去重按 key 不按 pos */
const SEED_SAMEPOS_1: SeedSpec = { word: 'lead', pos: 'noun', phonetic: 'li:d', definition_en: 'a metal', definition_zh: '铅', examples: [] }
const SEED_SAMEPOS_2: SeedSpec = { word: 'load', pos: 'noun', phonetic: 'ləʊd', definition_en: 'a burden', definition_zh: '负荷', examples: [] }

const REAL_SEEDS: SeedSpec[] = [REAL_A, REAL_ABC_NOUN, REAL_ABC_ABBR, REAL_ABANDON, REAL_ABATE]

async function seedReal(): Promise<void> {
  await storage.table('dictEntries').bulkPut(REAL_SEEDS.map(fromSpec))
}

/* ------------------------------------------------------------------ */
/* 1. parseDictFormFromKey                                              */
/* ------------------------------------------------------------------ */

console.log('parseDictFormFromKey：dict_key 反解析词形')

function testParse(): void {
  eq(parseDictFormFromKey('abc|noun'), 'abc', '正常 key：取 | 前段')
  eq(parseDictFormFromKey('a|article'), 'a', '单字母词形（真实词条 a|article）')
  eq(parseDictFormFromKey('abc|'), 'abc', 'pos 段空：词形段仍有效')
  eq(parseDictFormFromKey('noPipeHere'), null, '无 |：返回 null')
  eq(parseDictFormFromKey('|noun'), null, '词形段空：返回 null')
  eq(parseDictFormFromKey(''), null, '空串：null')
  eq(parseDictFormFromKey('abc|noun|extra'), 'abc', '多 |：只取第一段前（pos 不含 |，防御性）')
}

/* ------------------------------------------------------------------ */
/* 2. orderEntriesForVocab                                              */
/* ------------------------------------------------------------------ */

console.log('orderEntriesForVocab：去重 / pos 优先 / 稳定排序')

function testOrder(): void {
  const abcNoun = fromSpec(REAL_ABC_NOUN)
  const abcAbbr = fromSpec(REAL_ABC_ABBR)

  const withNoun = orderEntriesForVocab([abcAbbr, abcNoun], 'noun')
  eq(withNoun[0].pos, 'noun', 'LLM pos 命中的排最前（noun）')

  const withAbbr = orderEntriesForVocab([abcNoun, abcAbbr], 'abbreviation')
  eq(withAbbr[0].pos, 'abbreviation', 'LLM pos 命中的排最前（abbreviation）')

  const noMatch = orderEntriesForVocab([abcAbbr, abcNoun], 'verb')
  eq(noMatch[0].pos, 'abbreviation', 'pos 不匹配：保持输入原序（第一条兜底）')
  eq(noMatch.length, 2, 'pos 不匹配：不丢条目')

  const emptyPos = orderEntriesForVocab([abcAbbr, abcNoun], '')
  eq(emptyPos[0].pos, 'abbreviation', 'LLM pos 为空：保持原序')

  const deduped = orderEntriesForVocab([abcNoun, abcNoun, abcAbbr], 'noun')
  eq(deduped.length, 2, '同 key 重复记录只保留一次')
  eq(deduped[0].pos, 'noun', '去重后 pos 命中仍优先')

  // 同 pos 不同 key：真实主键（word|pos）下「同词形同 pos」不可达（本就去重）；
  // 这里验证去重按 key 而非按 pos——不同词条的相同 pos 不会被误合并
  const samePos = orderEntriesForVocab([fromSpec(SEED_SAMEPOS_1), fromSpec(SEED_SAMEPOS_2)], 'noun')
  eq(samePos.length, 2, '同 pos 不同 key 的记录不因 pos 相同被误删（去重按 key 不按 pos）')

  // 排序稳定：两个 noun 命中 + 一个 verb，两个 noun 相对顺序不变
  const springNoun = fromSpec(SEED_SPRING_NOUN)
  const springVerb = fromSpec(SEED_SPRING_VERB)
  const stable = orderEntriesForVocab([springVerb, springNoun], 'verb')
  eq(stable[0].pos, 'verb', '命中项前置')
  eq(stable[1].pos, 'noun', '未命中项殿后且原序保持')

  eq(orderEntriesForVocab([], 'noun').length, 0, '空数组安全')
}

/* ------------------------------------------------------------------ */
/* 3. resolveVocabDictEntriesByKey 集成（真实 storage 链路）            */
/* ------------------------------------------------------------------ */

console.log('resolveVocabDictEntriesByKey：集成查询链路')

async function testIntegration(): Promise<void> {
  // 3.1 单义项（真实 a|article）
  const aRows = await resolveVocabDictEntriesByKey('a|article', 'article')
  eq(aRows.length, 1, '单义项只返回一条')
  eq(aRows[0]?.word, 'a', '词形为真实小写 a')
  eq(aRows[0]?.examples.length, 3, '例句字段完整保留（3 条真实例句）')
  assert(
    aRows[0]?.definition_zh.includes('不定冠词') === true,
    'definition_zh 原文照登（不加工不编造）',
  )

  // 3.2 多 pos 全展示（真实 ABC 双词条；大写词形归一）
  const abcAll = await resolveVocabDictEntriesByKey('abc|noun', 'noun')
  eq(abcAll.length, 2, '同词形两个 pos 全部返回（真实 ABC 案例）')
  eq(abcAll[0]?.pos, 'noun', 'LLM pos=noun：noun 排最前')
  eq(abcAll[1]?.pos, 'abbreviation', '其余 pos 依次展示')
  eq(abcAll[0]?.word, 'ABC', '展示词库原始词形（大写 ABC，不是 dict_key 里的小写）')

  const abcAbbrFirst = await resolveVocabDictEntriesByKey('abc|noun', 'abbreviation')
  eq(abcAbbrFirst[0]?.pos, 'abbreviation', 'LLM pos=abbreviation：排序随之改变')

  const abcNoPos = await resolveVocabDictEntriesByKey('abc|noun', '')
  eq(abcNoPos.length, 2, 'LLM pos 为空：两条都还在')

  // 3.3 空 examples 字段如实呈现（ABC 两条 examples=[]）
  assert(
    abcAll.every((e) => e.examples.length === 0),
    'ABC 两条 examples 为空：不编造句例',
  )

  // 3.4 部分缺失：首条 key 被删、同词形仍有别的 pos
  await storage.table('dictEntries').delete('abc|noun')
  const partial = await resolveVocabDictEntriesByKey('abc|noun', 'noun')
  eq(partial.length, 1, '首条 noun 已删：只剩 abbreviation 一条')
  eq(partial[0]?.pos, 'abbreviation', '部分缺失如实呈现现存词条（不被整体判缺失）')
  await storage.table('dictEntries').put(fromSpec(REAL_ABC_NOUN))

  // 3.5 全缺失
  await storage.table('dictEntries').clear()
  const gone = await resolveVocabDictEntriesByKey('abc|noun', 'noun')
  eq(gone.length, 0, '词库清空：返回 []（UI 走缺失降级，不抛错）')

  // 3.6 无匹配兜底
  const never = await resolveVocabDictEntriesByKey('zzz|noun', 'noun')
  eq(never.length, 0, '从未收录：返回 []')
}

/* ------------------------------------------------------------------ */
/* 4. 词形还原 × 多义项（规则 + 不规则）                                 */
/* ------------------------------------------------------------------ */

console.log('词形还原后补查全部词条：规则 + 不规则')

async function testLemmaIntegration(): Promise<void> {
  // testIntegration 末尾 clear 过，先恢复真实词条
  await seedReal()

  // 规则：abating -> abate（真实 abate|verb 词条）
  const hit = await resolveVocabDict('abating')
  assert(hit !== null && hit.matched_form === 'abate', 'abating 还原命中 abate（真实词条）')
  eq(hit?.dict_key, 'abate|verb', 'dict_key 口径不变（word|pos）')
  const abateRows = await resolveVocabDictEntriesByKey(hit?.dict_key ?? '', 'verb')
  eq(abateRows.length, 1, '还原后按 key 补查到该词形全部词条')
  eq(abateRows[0]?.examples.length, 1, '例句随词条返回')

  // 不规则：gone -> go（构造夹具，与 test_irregular 同源）
  await storage.table('dictEntries').bulkPut([fromSpec(SEED_GO), fromSpec(SEED_CHILD)])
  const goneHit = await resolveVocabDict('gone')
  eq(goneHit?.dict_key, 'go|verb', 'gone → go（例外表还原后 dict_key 正确）')
  const goRows = await resolveVocabDictEntriesByKey(goneHit?.dict_key ?? '', 'verb')
  eq(goRows.length, 1, '不规则还原后补查命中')
  eq(goRows[0]?.word, 'go', '返回词典原始词形 go')

  // 不规则复数：children -> child
  const childHit = await resolveVocabDict('children')
  eq(childHit?.dict_key, 'child|noun', 'children → child 还原命中')
  const childRows = await resolveVocabDictEntriesByKey(childHit?.dict_key ?? '', 'noun')
  eq(childRows.length, 1, '不规则复数还原后补查命中')

  // 短语路径不退化：整短语查不到走未命中（不编造）
  const phrase = await resolveVocabDict('ABC of cooking')
  eq(phrase, null, '短语整查未命中：null（不硬凑）')

  // 无匹配兜底
  const miss = await resolveVocabDict('zzzqqq')
  eq(miss, null, '未知词：null')
}

/* ------------------------------------------------------------------ */
/* 5. 契约回归：生成链仍只落首条 dict_key                                 */
/* ------------------------------------------------------------------ */

console.log('契约回归：dict_key 语义与落库形态不变')

const REG_TRANSCRIPT: Transcript = {
  id: 'job-vs-1',
  language: 'en',
  duration: 4,
  segments: [
    { start: 0, end: 2, text: 'They abandon ship' },
    { start: 2, end: 4, text: 'ABC basics' },
  ],
}

const REG_NOTE = {
  summary: '回归用学习稿。',
  bilingual_notes: [{ en: 'They abandon ship', zh: '他们弃船' }],
  key_points: ['术语回归'],
  vocabulary: [
    { word: 'abandon', pos: 'verb.transitive', gloss: '放弃' },
    { word: 'ABC', pos: 'noun', gloss: '基础知识' },
  ],
}

const realFetch = globalThis.fetch

function installDoneStream(note: unknown): void {
  globalThis.fetch = (async () => {
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'delta', text: '{"a":1}' })}\n\n`))
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'done', note })}\n\n`))
        controller.close()
      },
    })
    return { ok: true, status: 200, body: stream } as unknown as Response
  }) as typeof fetch
}

async function testContractRegression(): Promise<void> {
  await storage.clearAll()
  await seedReal()

  const hits = await resolveVocabularyDictHits(REG_NOTE.vocabulary)
  eq(hits[0]?.dict_key, 'abandon|verb.transitive', '生成链命中仍记首条 dict_key（契约不变）')
  eq(hits[1]?.dict_key, 'abc|noun', '多义项也记首条（abc 两条取查询首位）')

  installDoneStream(REG_NOTE)
  const record = await generateAndSaveStudyNote(REG_TRANSCRIPT)
  globalThis.fetch = realFetch
  eq(record.status, 'ready', '落库 ready（生成链路不退化）')
  eq(record.vocabulary.length, 2, '词汇数不变')
  eq(record.vocabulary[1]?.dict_key, 'abc|noun', '落库 dict_key 仍是单值字符串（无 dict_keys 新字段）')
  assert(
    !('dict_keys' in (record.vocabulary[0] ?? {})),
    'StudyNoteVocabulary 未新增 dict_keys 字段（契约冻结）',
  )

  // UI 补查基于落库后的 dict_key：完整链路闭环
  const rows = await resolveVocabDictEntriesByKey(record.vocabulary[1]?.dict_key ?? '', 'noun')
  eq(rows.length, 2, '落库 key → UI 补查 → 两条义项全现（闭环）')
  eq(rows[0]?.pos, 'noun', '闭环里 LLM pos 优先仍生效')
}

/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  await storage.clearAll()
  testParse()
  testOrder()
  await seedReal()
  await testIntegration()
  await testLemmaIntegration()
  await testContractRegression()
  restoreFetch()

  console.log('')
  if (failed > 0) {
    console.error(`${failed} 项失败`)
    process.exit(1)
  }
  console.log('vocab senses 单测全部通过 ✓')
}

function restoreFetch(): void {
  globalThis.fetch = realFetch
}

main().catch((e) => {
  restoreFetch()
  console.error(e)
  process.exit(1)
})
