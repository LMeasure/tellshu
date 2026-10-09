/**
 * 功能单测（不依赖 IndexedDB / 浏览器）：验证记忆模式比对、EPUB 文本提取、语法分析。
 * 运行：npx tsx scripts/test_features.ts
 */
import { compareDictation, normalizeWords } from '../src/lib/dictation'
import { htmlToText, parseTxtBook } from '../src/lib/epub'
import { analyzeSentence } from '../src/lib/grammar'
import { paginate, pageOfParagraph, clampPage } from '../src/lib/paging'
import { rankSearchMatches, mergeSearchHits, type SearchIndexWord } from '../src/lib/search'
import {
  buildDiagnostics,
  bucketByDifficulty,
  gradeDiagnosis,
  type DiagnoseAnswer,
} from '../src/lib/diagnostic'
import {
  buildMaskPlan,
  collectSlots,
  dictationStats,
  inlineState,
  makeRng,
  slotKey,
  tokenize,
  DEFAULT_MASK_CONFIG,
  RATIO_OPTIONS,
} from '../src/lib/masking'
import { fmtDuration, recitationTitle } from '../src/lib/recorder'
import { AudioArbiter, splitSentences, type AudioHolder } from '../src/lib/audioBus'
import { ListenSession } from '../src/lib/listenSession'
import type { ContentWord } from '../src/data/types'

let failed = 0
function assert(cond: boolean, msg: string) {
  if (cond) console.log('  ✓', msg)
  else {
    console.error('  ✗', msg)
    failed++
  }
}

async function main() {
  console.log('[dictation] 默写比对（标红逻辑）')
  const r1 = compareDictation('The cat sat on the mat', 'the cat sit on the mat')
  assert(r1.totalWords === 6, `原文词数=6（实际 ${r1.totalWords}）`)
  assert(r1.correctCount === 5, `正确词数=5（实际 ${r1.correctCount}）`)
  assert(r1.tokens.filter((t) => t.isWord && !t.correct).length === 1, '恰好 1 个词标红')
  assert(r1.accuracy === Math.round((5 / 6) * 100), `命中率=${r1.accuracy}%`)
  const r2 = compareDictation('Hello world', 'hello world')
  assert(r2.accuracy === 100, `完全一致命中率=100（实际 ${r2.accuracy}）`)
  assert(normalizeWords('He is a BOY!').join(',') === 'he,is,a,boy', '归一化小写去标点')

  console.log('[epub.htmlToText] 去标签提取')
  const html = '<html><body><p>Hello <b>world</b>.</p><p>Second line.</p><script>bad()</script></body></html>'
  const txt = htmlToText(html)
  assert(txt.includes('Hello') && txt.includes('world') && txt.includes('Second line'), '提取正文文本')
  assert(!txt.includes('bad'), '移除 script')
  assert(txt.includes('\n'), '保留段落换行')

  console.log('[grammar] 语法分析（compromise）')
  const g1 = await analyzeSentence('She has eaten the cake.')
  assert(g1.terms.length > 0, `逐词分析=${g1.terms.length} 词`)
  assert(g1.tense === '完成时', `时态=完成时（实际 ${g1.tense}）`)
  assert(g1.sentenceType === '陈述句', `句型=${g1.sentenceType}`)
  console.log('   词性示例:', g1.terms.map((t) => `${t.text}/${t.posZh}`).join(' '))

  const g2 = await analyzeSentence('Did he go to school?')
  assert(g2.sentenceType === '疑问句', `疑问句识别（实际 ${g2.sentenceType}）`)

  console.log('[diagnostic] 诊断抽题（真实词条形状 → 梯度出题）')
  // fixture 模拟真实词库的形状：短词/单词素（基础）→ 长词/多语素（派生难词）。
  // 刻意不设置 frequency_rank —— 该字段在 OpenEtymology 包里实为字母序下标，不可用作词频。
  const mk = (i: number, word: string, morphCount: number): ContentWord => ({
    id: `w${i}`,
    word,
    definition_zh: `释义${i}`,
    difficulty_level: 2,
    topic_id: 't1',
    morphemes: Array.from({ length: morphCount }, (_, k) => ({ form: `m${k}`, meaning: `义${k}` })),
  })
  const fixture: ContentWord[] = [
    ...Array.from({ length: 30 }, (_, i) => mk(i, `w${i}`, 1)), // 短词 + 单词素
    ...Array.from({ length: 30 }, (_, i) => mk(100 + i, `word${i}`, 2)), // 中长词 + 双语素
    ...Array.from({ length: 30 }, (_, i) => mk(200 + i, `longword${i}`, 3)), // 长词 + 多语素
  ]
  const buckets = bucketByDifficulty(fixture)
  assert(buckets[1].length === 30, `L1 档=短词/单词素 30 个（实际 ${buckets[1].length}）`)
  assert(buckets[2].length === 30, `L2 档=中长词 30 个（实际 ${buckets[2].length}）`)
  assert(buckets[3].length === 30, `L3 档=长词/多语素 30 个（实际 ${buckets[3].length}）`)

  const qs = buildDiagnostics(fixture, () => 0.5)
  assert(qs.length === 5, `生成 5 题（实际 ${qs.length}）`)
  assert(
    qs.filter((q) => q.difficulty_level === 1).length === 2 &&
      qs.filter((q) => q.difficulty_level === 2).length === 2 &&
      qs.filter((q) => q.difficulty_level === 3).length === 1,
    '梯度为 L1×2 / L2×2 / L3×1',
  )
  assert(
    qs.every((q) => q.options.length === 4 && new Set(q.options).size === 4),
    '每题 4 个互不相同的选项',
  )
  assert(
    qs.every((q) => q.options.includes(q.answer)),
    '正确答案都在选项里',
  )
  assert(buildDiagnostics(fixture.slice(0, 5), () => 0.5).length === 0, '词量不足时不硬凑题目')
  // 梯度必须落在对应档位：L1 题干是短词，L3 题干是长词
  const wordOf = (q: { question: string }) => q.question.match(/「(.+?)」/)?.[1] ?? ''
  assert(
    qs.filter((q) => q.difficulty_level === 1).every((q) => wordOf(q).length <= 5),
    'L1 题干取自短词档',
  )
  assert(
    qs.filter((q) => q.difficulty_level === 3).every((q) => wordOf(q).length >= 8),
    'L3 题干取自长词档',
  )

  console.log('[diagnostic] 诊断定级')
  const all: DiagnoseAnswer[] = [
    { level: 1, correct: true },
    { level: 1, correct: true },
    { level: 2, correct: true },
    { level: 2, correct: true },
    { level: 3, correct: true },
  ]
  assert(gradeDiagnosis(all).level === 3, `全对 → 进阶级（实际 ${gradeDiagnosis(all).level}）`)
  assert(gradeDiagnosis(all).start_book === 'CET6', '全对 → 建议 CET6')
  const mid: DiagnoseAnswer[] = all.map((a) => (a.level === 3 ? { ...a, correct: false } : a))
  assert(gradeDiagnosis(mid).level === 2, `L3 失手 → 基础级（实际 ${gradeDiagnosis(mid).level}）`)
  const low: DiagnoseAnswer[] = all.map((a) => (a.level === 1 ? { ...a, correct: false } : a))
  assert(gradeDiagnosis(low).level === 1, `基础题失手 → 起步级（实际 ${gradeDiagnosis(low).level}）`)
  assert(gradeDiagnosis(low).start_book === 'CET4', '低分级 → 建议 CET4')

  console.log('[search] 全词库搜索（排序 + 多词本归并）')
  const mkW = (word: string, book: string, zh = '释义'): SearchIndexWord => ({
    id: `${book}:${word}`,
    word,
    ipa: null,
    pos: null,
    zh,
    book,
    dl: 2,
    tid: '',
  })
  const pool: SearchIndexWord[] = [
    mkW('continue', 'CET4'),
    mkW('continent', 'CET4'),
    mkW('continent', 'TOEFL'),
    mkW('continent', 'GRE8000'),
    mkW('contingency', 'TEM8'),
    mkW('discontinue', 'TOEFL'), // 含 "conti" 但不在词首
    mkW('about', 'CET4', '关于；大约'),
  ]
  const rankOrder = rankSearchMatches(pool, 'conti', 10).map((w) => w.word)
  assert(rankOrder[0] === 'continue', `前缀命中排最前（实际 ${rankOrder[0]}）`)
  assert(
    rankOrder.indexOf('discontinue') > rankOrder.indexOf('contingency'),
    '词内包含排在词首前缀之后',
  )
  const zhHits = rankSearchMatches(pool, '大约', 10)
  assert(zhHits.length === 1 && zhHits[0].word === 'about', '支持按中文释义搜索')

  const nameOf = new Map([
    ['CET4', 'CET-4 四级'],
    ['TOEFL', 'TOEFL 托福'],
    ['GRE8000', 'GRE 8000词'],
    ['TEM8', 'TEM-8 专八'],
  ])
  const merged = mergeSearchHits(rankSearchMatches(pool, 'contin', 10), nameOf, 10)
  const cont = merged.find((h) => h.word === 'continent')
  assert(!!cont, 'continent 命中')
  assert(merged.filter((h) => h.word === 'continent').length === 1, '同一单词只出现一条（已归并）')
  assert(cont!.bookNames.length === 3, `归并 3 个词本（实际 ${cont!.bookNames.length}）`)
  assert(cont!.bookName === 'CET-4 四级', '主词本取首个命中')
  assert(mergeSearchHits(pool, nameOf, 2).length === 2, 'limit 生效')
  assert(rankSearchMatches(pool, '   ', 10).length === 0, '空查询返回空')

  console.log('[paging] 分页与目录跳转')
  assert(paginate([]).length === 0, '空输入 → 0 页')
  const short = ['a'.repeat(100), 'b'.repeat(100)]
  assert(paginate(short, 900).length === 1, '总长未超预算 → 合为 1 页')

  const many = Array.from({ length: 10 }, (_, i) => `p${i}-`.repeat(50)) // 每段 150 字
  const pgs = paginate(many, 400)
  assert(pgs.length > 1, `超预算 → 多页（实际 ${pgs.length} 页）`)
  assert(
    pgs.flatMap((p) => p.paragraphs).join('|') === many.join('|'),
    '分页不丢段落、不重复',
  )
  assert(
    pgs.every((p, i) => p.to === (pgs[i + 1]?.from ?? many.length)),
    '页区间连续无缝',
  )
  assert(
    paginate(['x'.repeat(1000)], 400).length === 1,
    '单段超长时独占一页（不切句）',
  )
  assert(pageOfParagraph(pgs, pgs[1].from) === 1, '段落下标 → 正确页号')
  assert(pageOfParagraph(pgs, 99999) === pgs.length - 1, '段落下标越界 → 末页')
  assert(clampPage(pgs, -5) === 0 && clampPage(pgs, 9999) === pgs.length - 1, '页码越界收敛')
  assert(clampPage(pgs, undefined) === 0, '无存档页码 → 第 1 页')

  console.log('[epub] TXT 章节识别')
  const txtBookRaw = [
    'Chapter 1 The Beginning',
    'It was a bright cold day in April.',
    'Chapter 2 The Middle',
    'The clocks were striking thirteen.',
    'Chapter 3 The End',
    'All was well in the end.',
  ].join('\n')
  const book = parseTxtBook(txtBookRaw)
  assert(book.chapters.length === 3, `识别 3 章（实际 ${book.chapters.length}）`)
  assert(book.chapters[0].title.includes('Chapter 1'), '章节标题取自原文')
  assert(book.chapters[1].para === 2, `第 2 章起始段落下标=2（实际 ${book.chapters[1].para}）`)
  assert(book.content.split(/\n+/).length === 6, '正文段落完整保留')
  assert(parseTxtBook('just a plain paragraph\nand another one').chapters.length === 0, '无章节标记 → 不虚构目录')

  console.log('[masking] 分词')
  const tks = tokenize('Hello, world!  It\'s fine.')
  assert(tks.some((t) => t.t === 'Hello' && t.word), '英文词识别为 word')
  assert(tks.some((t) => t.t === ',' && !t.word), '标点单独成 token 且非 word')
  assert(tks.some((t) => t.t === "It's" && t.word), '带撇号的缩写保留为一个词')
  assert(
    tks.map((t) => t.t).join('') === "Hello, world!  It's fine.",
    '切词后拼回原文无损',
  )

  console.log('[masking] 随机隐藏比例')
  const paras = [
    'It was a bright cold day in April, and the clocks were striking thirteen.',
    'Winston Smith, his chin nuzzled into his breast, hurried on.',
    'The hallway smelt of boiled cabbage and old rag mats.',
  ]
  const longPara = [Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ')]
  const counts = RATIO_OPTIONS.map(
    (r) => buildMaskPlan(longPara, { mode: 'random', ratio: r, hidePunctuation: false }, [], 1).size,
  )
  assert(
    counts.every((c, i) => i === 0 || c > counts[i - 1]),
    `比例越大空位越多（${counts.join(' < ')}）`,
  )
  const hitRate = counts[2] / 400
  assert(
    hitRate > 0.36 && hitRate < 0.54,
    `45% 实际命中 ${(hitRate * 100).toFixed(1)}%（允许抽样误差）`,
  )
  const nine = buildMaskPlan(longPara, { mode: 'random', ratio: 0.9, hidePunctuation: false }, [], 1)
  assert([...nine].every((k) => k.startsWith('0:')), '空位 key 形如 段下标:token下标')
  assert(
    nine.size > 320 && nine.size < 400,
    `90% 隐藏落在 320~400 之间（实际 ${nine.size}）`,
  )

  console.log('[masking] 随机可复现 + 换一批')
  const cfgA = { mode: 'random' as const, ratio: 0.45, hidePunctuation: false }
  const s1 = buildMaskPlan(paras, cfgA, [], 7)
  const s1b = buildMaskPlan(paras, cfgA, [], 7)
  const s2 = buildMaskPlan(paras, cfgA, [], 8)
  assert(
    s1.size === s1b.size && [...s1].every((k) => s1b.has(k)),
    '同 seed 结果完全一致（输入时空位不跳动）',
  )
  assert(
    s1.size !== s2.size || [...s1].some((k) => !s2.has(k)),
    '换一批（seed+1）得到不同空位',
  )
  assert(
    paras.every((_, pi) => [...s1].some((k) => k.startsWith(`${pi}:`))),
    '每段至少一个空位（防止整段不用写）',
  )
  assert(makeRng(42)() === makeRng(42)(), '确定性伪随机同种子同值')

  console.log('[masking] 完全隐藏')
  const fullNoPunc = buildMaskPlan(paras, { mode: 'full', ratio: 0, hidePunctuation: false })
  const fullPunc = buildMaskPlan(paras, { mode: 'full', ratio: 0, hidePunctuation: true })
  const allTokens = paras.flatMap((p, pi) => tokenize(p).map((t, ti) => ({ ...t, key: slotKey(pi, ti) })))
  const wordCount = allTokens.filter((t) => t.word).length
  const puncCount = allTokens.filter((t) => !t.word && t.t.trim() !== '').length
  assert(fullNoPunc.size === wordCount, `不含标点：只隐藏 ${wordCount} 个词`)
  assert(
    fullPunc.size === wordCount + puncCount,
    `含标点：词 + 标点共 ${wordCount + puncCount} 个`,
  )
  assert(
    allTokens.filter((t) => !t.word && t.t.trim() === '').every((t) => !fullPunc.has(t.key)),
    '空格永不作为默写空位',
  )

  console.log('[masking] 自主选择')
  const picked = [slotKey(0, 0), slotKey(1, 2)]
  const manual = buildMaskPlan(paras, { mode: 'manual', ratio: 0, hidePunctuation: false }, picked)
  assert(manual.size === 2, `只隐藏用户勾选的 2 处（实际 ${manual.size}）`)
  assert(manual.has(slotKey(0, 0)) && manual.has(slotKey(1, 2)), '勾选位置精确命中')
  assert(!manual.has(slotKey(0, 1)), '未勾选位置保持可见')
  assert(
    buildMaskPlan(paras, { mode: 'manual', ratio: 0, hidePunctuation: false }, []).size === 0,
    '未选任何词 → 不隐藏（可纯阅读）',
  )
  assert(DEFAULT_MASK_CONFIG.mode === 'random', '默认随机隐藏')
  assert(DEFAULT_MASK_CONFIG.ratio === 0.3, '默认比例 30%')

  console.log('[masking] 输入实时校验')
  assert(inlineState('apple', '') === 'empty', '未输入 → empty')
  assert(inlineState('apple', 'ap') === 'typing', '前缀正确 → typing（不标红）')
  assert(inlineState('apple', 'APP') === 'typing', '大小写不敏感')
  assert(inlineState('apple', 'Apple') === 'ok', '完全匹配 → ok')
  assert(inlineState('apple', 'apq') === 'wrong', '打错字母 → wrong（实时标红）')
  assert(inlineState('apple', 'apples') === 'wrong', '多打字母 → wrong')
  assert(inlineState('a', 'a') === 'ok', '单词只有一个字母时边界正确')

  console.log('[masking] 统计')
  const st = dictationStats([
    { target: 'apple', value: 'apple' },
    { target: 'banana', value: 'ban' },
    { target: 'cherry', value: 'cherri' },
    { target: 'date', value: '' },
  ])
  assert(st.total === 4, `空位总数 4（实际 ${st.total}）`)
  assert(st.filled === 3, `已填 3（实际 ${st.filled}）`)
  assert(st.correct === 1 && st.wrong === 1, `正确 1 / 错误 1（实际 ${st.correct}/${st.wrong}）`)
  assert(st.accuracy === 33, `正确率 33%（实际 ${st.accuracy}）`)
  assert(dictationStats([]).accuracy === 0, '无空位时正确率 0（不除零）')
  assert(
    dictationStats([{ target: 'x', value: '' }]).filled === 0,
    '未填写不计入已填',
  )

  console.log('[masking] 空位答案表')
  const slots = collectSlots(paras, fullNoPunc)
  assert(slots.length === wordCount, `答案表长度 = 隐藏词数（${slots.length}）`)
  assert(slots[0].target === 'It', `首个空位答案是 It（实际 ${slots[0].target}）`)
  assert(slots.every((s) => s.key.includes(':')), '答案表携带可定位 key')

  console.log('[e2e] 默写流水线：书籍 / 粘贴文本走同一条链路')
  const articleRaw =
    'Learning a language is mostly a matter of showing up.\n' +
    'You read a little, you listen a little, and you write a little, every single day.\n' +
    'Progress is slow, then sudden — like a kettle that finally whistles.'
  const paraList = articleRaw.split(/\n+/).filter(Boolean)
  const pages = paginate(paraList, 900)
  assert(pages.length === 1, `短文落在一页（实际 ${pages.length}）`)
  const pageParas = paraList.slice(pages[0].from, pages[0].to)
  const plan = buildMaskPlan(pageParas, DEFAULT_MASK_CONFIG, [], 3)
  const slots2 = collectSlots(pageParas, plan)
  assert(slots2.length > 0, `生成 ${slots2.length} 个空位`)
  assert(
    slots2.every((s) => {
      const [pi, ti] = s.key.split(':').map(Number)
      return tokenize(pageParas[pi])[ti]?.t === s.target
    }),
    '每个空位都能回指原文位置（就地渲染不串行）',
  )
  // 模拟用户逐字输入：前 2 空位写对，第 3 个写错
  const typed = slots2.map((s, i) => ({
    target: s.target,
    value: i === 2 ? s.target + 'x' : s.target,
  }))
  const st2 = dictationStats(typed)
  assert(st2.wrong === 1 && st2.correct === slots2.length - 1, '逐字校验：错 1 处、其余正确')
  assert(st2.accuracy < 100, `正确率 ${st2.accuracy}%（未满分即为标红生效）`)
  // 进度存档 → 还原：key 以 页:段:token 三级定位，跨页不串
  const saved = slots2.map((s, i) => [`0:${s.key}`, typed[i].value] as const)
  assert(
    new Set(saved.map(([k]) => k)).size === saved.length,
    '存档 key 唯一（页:段:token，翻页不互相覆盖）',
  )
  assert(
    saved.every(([k]) => /^0:\d+:\d+$/.test(k)),
    '存档 key 形如 页:段:token',
  )

  console.log('[audioBus] 分句')
  assert(splitSentences('Hello there. How are you?').length === 2, '两句按句末标点切开')
  assert(
    splitSentences('Mr. Smith went home. He was tired.')[0].startsWith('Mr. Smith'),
    '缩写点（Mr.）不切断句子',
  )
  assert(splitSentences('   ').length === 0, '纯空白 → 无句子')
  assert(splitSentences('No terminator here').length === 1, '无句末标点 → 整段算一句')
  assert(splitSentences('One. Two. Three.').length === 3, '连续短句切 3 段')
  assert(splitSentences('J. R. R. Tolkien wrote it.').length === 1, '人名缩写点不切断句子')
  assert(splitSentences('等一下。好的！').length === 2, '中文句末标点同样生效')

  console.log('[audioBus] 抢占仲裁：听书 ↔ 单词')
  const auLog: string[] = []
  const mkH = (role: AudioHolder['role']): AudioHolder => ({
    role,
    suspend: () => auLog.push(`${role}:suspend`),
    resume: () => auLog.push(`${role}:resume`),
  })
  const bus = new AudioArbiter()
  const bookH = mkH('book')
  const wordH = mkH('word')

  assert(bus.currentRole === null, '初始无人占用')
  bus.claim(bookH)
  assert(bus.currentRole === 'book', '听书开始 → 焦点在 book')

  bus.claim(wordH)
  assert(auLog.join('/') === 'book:suspend', `点单词 → 听书挂起（${auLog.join('/')}）`)
  assert(bus.currentRole === 'word', '焦点切到 word')
  assert(bus.suspendedRoles.join(',') === 'book', 'book 进挂起栈')

  const auResumed = bus.release(wordH)
  assert(auResumed === 'book', `单词念完 → 恢复 book（实际 ${auResumed}）`)
  assert(auLog.includes('book:resume'), '听书被恢复')
  assert(bus.currentRole === 'book' && bus.suspendedRoles.length === 0, '栈已清空')

  console.log('[audioBus] 三层嵌套：听书 → 音频 → 单词')
  const auLog2: string[] = []
  const mkH2 = (role: AudioHolder['role']): AudioHolder => ({
    role,
    suspend: () => auLog2.push(`${role}:suspend`),
    resume: () => auLog2.push(`${role}:resume`),
  })
  const bus2 = new AudioArbiter()
  const auB2 = mkH2('book')
  const auM2 = mkH2('media')
  const auW2 = mkH2('word')
  bus2.claim(auB2)
  bus2.claim(auM2)
  bus2.claim(auW2)
  assert(bus2.suspendedRoles.join(',') === 'book,media', '两个旧音源都在栈里')
  assert(bus2.release(auW2) === 'media', '单词播完 → 先恢复音频（最近挂起的）')
  assert(bus2.release(auM2) === 'book', '音频播完 → 再恢复听书')
  assert(
    auLog2.join('/') === 'book:suspend/media:suspend/media:resume/book:resume',
    `时序正确：${auLog2.join(' → ')}`,
  )

  console.log('[audioBus] 边界')
  const bus3 = new AudioArbiter()
  const auX = mkH('book')
  bus3.claim(auX)
  bus3.claim(auX)
  assert(bus3.suspendedRoles.length === 0, '重复 claim 同一持有者不会把自己挂起')
  bus3.release(auX)
  assert(bus3.currentRole === null, 'release 后无人占用')
  bus3.claim(auX)
  bus3.claim(mkH('word'))
  bus3.reset()
  assert(
    bus3.currentRole === null && bus3.suspendedRoles.length === 0,
    'reset 清空全部（兜底防静音）',
  )

  console.log('[listenSession] 抢占后从当前句重读')
  const auTick = () => new Promise((r) => setTimeout(r, 0))
  let auPending: (() => void) | null = null
  const auSpoken: string[] = []
  let auEnded = false
  const auIdxLog: number[] = []
  const auSess = new ListenSession({
    rate: () => 1,
    // 本用例只验证抢占/恢复时序，句间停顿由 test_bilingual 单独测
    pauseMs: 0,
    onIndex: (i) => auIdxLog.push(i),
    onEnd: () => {
      auEnded = true
    },
    speak: (u) => {
      auSpoken.push(u.text)
      return new Promise<void>((res) => {
        auPending = res
      })
    },
    cancel: () => {
      const p = auPending
      auPending = null
      p?.()
    },
  })
  /** 模拟「这一句自然读完」 */
  const auFinish = () => {
    const p = auPending
    auPending = null
    p?.()
  }
  const auUnits = [
    { text: 'A', para: 0 },
    { text: 'B', para: 0 },
    { text: 'C', para: 1 },
  ]
  auSess.start(auUnits)
  await auTick()
  assert(auSpoken.join('') === 'A', `从第 1 句开始（实际 ${auSpoken.join(',')}）`)

  auFinish()
  await auTick()
  assert(auSpoken.join('') === 'AB', `自然读完推进到下一句（实际 ${auSpoken.join(',')}）`)

  // 正在读 B 时被单词发音抢占
  auSess.suspend()
  await auTick()
  assert(auSpoken.join('') === 'AB', '抢占期间不新增朗读')
  assert(auSess.index === 1, `下标仍停在被打断的第 2 句（实际 ${auSess.index}）`)

  auSess.resume()
  await auTick()
  assert(auSpoken.join('') === 'ABB', `恢复后从当前句开头重读（实际 ${auSpoken.join(',')}）`)

  auFinish()
  await auTick()
  auFinish()
  await auTick()
  assert(auSpoken.join('') === 'ABBC', `读完全部（实际 ${auSpoken.join(',')}）`)
  assert(auEnded, '读完触发 onEnd（页面据此复位听书按钮）')
  assert(auIdxLog.includes(0) && auIdxLog.includes(2), '逐句回调下标用于句子高亮')

  console.log('[listenSession] 点击某句 → 从该句开始重读')
  let auPending2: (() => void) | null = null
  const auSpoken2: string[] = []
  const auIdxLog2: number[] = []
  const auSess2 = new ListenSession({
    rate: () => 1,
    pauseMs: 0,
    onIndex: (i) => auIdxLog2.push(i),
    speak: (u) => {
      auSpoken2.push(u.text)
      return new Promise<void>((res) => {
        auPending2 = res
      })
    },
    cancel: () => {
      const p = auPending2
      auPending2 = null
      p?.()
    },
  })
  const auUnits2 = [
    { text: 'A', para: 0, sent: 0 },
    { text: 'B', para: 0, sent: 1 },
    { text: 'C', para: 0, sent: 2 },
  ]
  auSess2.start(auUnits2)
  await auTick()
  assert(auSpoken2.join('') === 'A', `正常从第 1 句开始（实际 ${auSpoken2.join(',')}）`)
  auSess2.seek(2)
  await auTick()
  assert(auSess2.index === 2, `下标跳到第 3 句（实际 ${auSess2.index}）`)
  assert(auSpoken2.join('') === 'AC', `从第 3 句重读（实际 ${auSpoken2.join(',')}）`)
  assert(auIdxLog2[auIdxLog2.length - 1] === 2, `高亮回调最终落在第 3 句（实际 ${auIdxLog2.join(',')}）`)
  auSess2.stop()

  console.log('[recorder] 录音命名')
  assert(fmtDuration(0) === '00:00', '0 → 00:00')
  assert(fmtDuration(83000) === '01:23', '83 秒 → 01:23')
  assert(fmtDuration(599000) === '09:59', '599 秒 → 09:59')
  assert(fmtDuration(-100) === '00:00', '负数收敛为 00:00')
  const title = recitationTitle(83000, new Date(2026, 9, 2, 10, 30).getTime())
  assert(title === '2026-10-02-01:23', `标题=日期-时长（实际 ${title}）`)
  assert(
    /^\d{4}-\d{2}-\d{2}-\d{2}:\d{2}$/.test(recitationTitle(60000)),
    '自动命名格式符合 年-月-日-时长',
  )

  if (failed) {
    console.error(`\n${failed} 项失败`)
    process.exit(1)
  }
  console.log('\n功能单测全部通过 ✓')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
