/**
 * 中英文兼容单测（纯逻辑，不依赖浏览器 / IndexedDB）
 * 运行：npx tsx scripts/test_bilingual.ts
 *
 * 覆盖：
 *   第一部分 语言判断（纯中文 / 纯英文 / 中英混合，按字符占比）
 *   第二部分 英文路径：英文分词行为不变 + 朗读文本清洗
 *   第三部分 中文路径：Intl.Segmenter 分词 + 逐字降级 + 掩码 + 字符匹配
 *   第四部分 共用听书：标点分句 / 语言边界切分 / 嗓音挑选 / 句间 200ms 停顿
 */
import {
  countChars,
  detectLanguage,
  dominantLang,
  langTag,
  scriptClassOf,
  splitLangSpans,
} from '../src/lib/textLang'
import {
  cleanForSpeech,
  expandAbbreviations,
  flattenRootSymbols,
  stripBraces,
  zhPunctToEn,
} from '../src/lib/speechText'
import {
  collectSlots,
  buildMaskPlan,
  dictationStats,
  inlineState,
  slotKey,
  tokenize,
  tokenizeChineseByChar,
  DEFAULT_MASK_CONFIG,
} from '../src/lib/masking'
import { splitSentences } from '../src/lib/audioBus'
import { pickVoice, rankVoices, type VoiceLike } from '../src/lib/voicePicker'
import { ListenSession, DEFAULT_PAUSE_MS } from '../src/lib/listenSession'

let failed = 0
function assert(cond: boolean, msg: string) {
  if (cond) console.log('  ✓', msg)
  else {
    console.error('  ✗', msg)
    failed += 1
  }
}
function eq(actual: unknown, expected: unknown, msg: string) {
  assert(actual === expected, `${msg}（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`)
}

async function main() {
  /* ================= 第一部分：语言判断 ================= */
  console.log('[textLang] 字符占比统计')
  const s1 = countChars('Hello world')
  eq(s1.zh, 0, '纯英文：中文字符数 0')
  eq(s1.en, 10, '纯英文：英文字母数 10（Hello+world）')
  const s2 = countChars('今天我们开始学习英语')
  eq(s2.zh, 10, '纯中文：中文字符数 10')
  eq(s2.en, 0, '纯中文：英文字母数 0')
  const s3 = countChars('')
  eq(s3.meaningful, 0, '空串：有效字符 0（不能除零）')

  console.log('[textLang] 语言类型判定（>80% 才算纯某一种）')
  eq(detectLanguage('We hold these truths to be self-evident.'), 'en', '纯英文 → en')
  eq(detectLanguage('今天我们开始一起 学习英语吧。'), 'zh', '纯中文 → zh')
  eq(detectLanguage('12345 !!! ...'), 'en', '无任何中英文字母 → 沿用英文路径（不回归）')
  eq(detectLanguage('这是一个 apple。'), 'mixed', '中英混排 → mixed')
  // 80% 边界：10 个字 + 2 个字母 → 中文占比 10/12 ≈ 0.833 > 0.8
  eq(detectLanguage('春天夏天秋天冬天早上中午晚上ab'), 'zh', '中文占比 ≈83% 仍判 zh（阈值 >80%）')
  const edge = countChars('春天夏天秋天冬天早上中午abc')
  assert(edge.zhRatio <= 0.8, `中文占比 ${edge.zhRatio.toFixed(3)} ≤ 0.8 → 该样例应为 mixed`)
  eq(detectLanguage('春天夏天秋天冬天早上中午abc'), 'mixed', '中文占比 80% 整 → mixed（严格大于才算纯）')

  console.log('[textLang] 占优语言与标签')
  eq(dominantLang('apple'), 'en', 'apple → en')
  eq(dominantLang('苹果 apple'), 'en', 'apple 的字母数比汉字多 → en（混排按占优方）')
  eq(dominantLang('学习英语的方法其实很简单 ok'), 'zh', '汉字远多于字母 → zh')
  eq(dominantLang('apple and extra words here 苹果'), 'en', '英文字符更多 → en')
  eq(dominantLang('，。！'), 'en', '无字母时兜底 en')
  eq(langTag('zh'), 'zh-CN', '中文 → zh-CN')
  eq(langTag('en'), 'en-US', '英文 → en-US')

  console.log('[textLang] 语言片段切分')
  eq(scriptClassOf('中'), 'zh', '汉字 → zh')
  eq(scriptClassOf('。'), 'zh', '中文句号属于中文片段（避免中英来回抖动）')
  eq(scriptClassOf('a'), 'latin', '字母 → latin')
  const spans = splitLangSpans('今天我们学习 apple 这个单词')
  assert(spans.length === 3, `切成 3 段（实际 ${spans.length}）`)
  eq(spans[0].lang, 'zh', '第 1 段是中文')
  eq(spans[1].lang, 'latin', '第 2 段是英文')
  eq(spans[2].lang, 'zh', '第 3 段回到中文')
  eq(spans[1].text, ' apple ', '中英之间的空白吸附到相邻的英文片段')
  assert(
    spans.map((s) => s.text).join('') === '今天我们学习 apple 这个单词',
    '所有片段拼回 == 原文（不吞字符、不重复）',
  )

  /* ================= 第二部分：英文路径 ================= */
  console.log('[masking] 英文分词行为必须与改造前一致')
  const enTokens = tokenize("Hello, world!  It's fine.")
  assert(enTokens.filter((t) => t.word).length === 4, `英文 word token 数为 4（实际 ${enTokens.filter((t) => t.word).length}）`)
  eq(enTokens[0].t, 'Hello', '第一个词 token 是 Hello')
  assert(!enTokens[1].word, ', 不是词')
  eq(enTokens.find((t) => t.word && t.t.includes("'"))?.t, "It's", "带撇号的复合词保持完整")
  const autoTokens = tokenize("Hello, world!  It's fine.", 'auto')
  eq(
    JSON.stringify(autoTokens),
    JSON.stringify(enTokens),
    'auto 模式对纯英文的结果与显式 en 完全相同（零回归）',
  )
  eq(JSON.stringify(tokenize('', 'auto')), '[]', '空串 → 空数组')

  console.log('[speechText] 花括号与元信息')
  eq(stripBraces('predict {词根：dict} means say.'), 'predict  means say.', '去掉 {...} 及其内容')
  eq(stripBraces('{a{b}c}'), '', '嵌套花括号也被清掉')
  eq(stripBraces('un{结 c'), 'un结 c', '没闭合的左花括号只删符号、保留内容')
  eq(stripBraces('plain text'), 'plain text', '无花括号原样返回')

  console.log('[speechText] 缩写展开')
  eq(expandAbbreviations('Fruits, e.g. apples.'), 'Fruits, for example apples.', 'e.g. → for example')
  eq(expandAbbreviations('It is cold, i.e. frozen.'), 'It is cold, that is frozen.', 'i.e. → that is')
  eq(expandAbbreviations('apples, oranges, etc.'), 'apples, oranges, and so on.', 'etc. → and so on（句末点保留）')
  eq(expandAbbreviations('Mr. Smith vs. Dr. Jones'), 'Mister Smith versus Doctor Jones', '称谓一并展开')
  eq(expandAbbreviations('no abbreviation here'), 'no abbreviation here', '普通文本不变')

  console.log('[speechText] 词根拆解符号')
  eq(flattenRootSymbols('un- + pre- + dict + -able'), 'un, pre, dict, able', '词根记号 → 逗号清单')
  eq(flattenRootSymbols('predict'), 'predict', '不含加号时原样返回')
  eq(flattenRootSymbols('well-known'), 'well-known', '普通连字符单词不会被拆开（关键：不加号不处理）')
  eq(flattenRootSymbols('mother-in-law'), 'mother-in-law', '多段连字符同样不动')

  console.log('[speechText] 中文标点 → 英文标点')
  eq(zhPunctToEn('你好，世界。'), '你好, 世界. ', '逗号句号换成英文并留空格')
  eq(zhPunctToEn('「引号」'), ' "引号" ', '中文引号转英文引号')
  eq(zhPunctToEn('Wait…'), 'Wait...', '省略号转三个点')

  console.log('[speechText] 完整清洗')
  eq(
    cleanForSpeech('This is a test，e.g. apples {注释} and more。', 'en'),
    'This is a test, for example apples and more.',
    '英文句：花括号 + 缩写 + 中文标点全部处理',
  )
  eq(
    cleanForSpeech('今天天气很好，我们去散步吧。', 'zh'),
    '今天天气很好，我们去散步吧。',
    '中文句：**保留**中文标点（不用英文标点念中文）',
  )
  eq(
    cleanForSpeech('un- + pre- + dict + -able', 'en'),
    'un, pre, dict, able',
    '词根记号整句清洗',
  )
  eq(cleanForSpeech('  spaced   out  ', 'en'), 'spaced out', '多余空白被压缩')

  /* ================= 第三部分：中文路径 ================= */
  console.log('[masking] 中文分词')
  const zhTokens = tokenize('今天我们学习中文分词。', 'zh')
  const zhWords = zhTokens.filter((t) => t.word)
  assert(zhWords.length >= 4, `中文切出至少 4 个词级单位（实际 ${zhWords.length}：${zhWords.map((t) => t.t).join('/')}）`)
  assert(!zhTokens.some((t) => t.word && /[，。、；：？！]/.test(t.t)), '中文标点不会被当成词')
  assert(zhTokens.some((t) => !t.word && t.t === '。'), '句号成为独立的非词 token')
  const joined = zhTokens.map((t) => t.t).join('')
  eq(joined, '今天我们学习中文分词。', '所有 token 拼回 == 原文（不含隐形丢字）')

  console.log('[masking] 逐字降级（模拟没有 Intl.Segmenter 的环境）')
  const fallback = tokenizeChineseByChar('学习由於')
  eq(fallback.filter((t) => t.word).length, 4, '逐字降级时每个汉字都是一个可隐藏单位')
  const fbJoined = fallback.map((t) => t.t).join('')
  eq(fbJoined, '学习由於', '逐字降级同样不丢字符')
  const fbPunct = tokenizeChineseByChar('你好，世界。')
  assert(fbPunct.filter((t) => t.word).length === 4, '逐字降级把「你好世界」切成 4 个单字')
  assert(!fbPunct.some((t) => t.word && /[，。]/.test(t.t)), '逐字降级里标点不是可隐藏单位')
  const fbConsecutive = tokenizeChineseByChar('啊……算了')
  eq(fbConsecutive.filter((t) => !t.word).length, 1, '连续标点归成一个非词 token（不拆成一串空位）')

  console.log('[masking] 中英混排分词')
  const mixTokens = tokenize('今天我们学习 apple 这个单词', 'mixed')
  const mixWords = mixTokens.filter((t) => t.word).map((t) => t.t)
  assert(mixWords.includes('apple'), `英文单词被独立切出（实际 ${mixWords.join('/')}）`)
  assert(mixWords.some((w) => /[一-龥]/.test(w)), '中文词组也正常切出')
  assert(!mixWords.some((w) => /^[一-龥]+ [a-z]+$/i.test(w)), '不会出现「中文+英文」粘在一起的 token')
  const mixJoined = mixTokens.map((t) => t.t).join('')
  eq(mixJoined, '今天我们学习 apple 这个单词', '混排 token 拼回 == 原文')

  console.log('[masking] 中文掩码计划')
  const zhParas = ['今天我们学习中文分词。', '第二步测试成功。']
  const zhFull = buildMaskPlan(zhParas, { mode: 'full', ratio: 0.3, hidePunctuation: false }, [], 1, 'zh')
  zhParas.forEach((p, pi) => {
    tokenize(p, 'zh').forEach((tk, ti) => {
      if (!tk.word) {
        assert(!zhFull.has(slotKey(pi, ti)), `标点「${tk.t}」在「不含标点」模式下不隐藏`)
      }
    })
  })
  const zhFullWithPunc = buildMaskPlan(zhParas, { mode: 'full', ratio: 0.3, hidePunctuation: true }, [], 1, 'zh')
  const punctCount = zhParas.flatMap((p, pi) =>
    tokenize(p, 'zh').map((tk, ti) => ({ tk, key: slotKey(pi, ti) })),
  ).filter((x) => !x.tk.word && x.tk.t.trim() !== '').length
  assert(punctCount > 0, `样例里确实存在中文标点（${punctCount} 个）`)
  assert(
    punctCount > 0 &&
      zhParas.some((p, pi) =>
        tokenize(p, 'zh').some((tk, ti) => !tk.word && tk.t.trim() !== '' && zhFullWithPunc.has(slotKey(pi, ti))),
      ),
    '「含标点」模式下中文句号也被纳入默写',
  )
  const zhRandom = buildMaskPlan(zhParas, { ...DEFAULT_MASK_CONFIG, mode: 'random', ratio: 0.9 }, [], 7, 'zh')
  const zhRandom2 = buildMaskPlan(zhParas, { ...DEFAULT_MASK_CONFIG, mode: 'random', ratio: 0.9 }, [], 7, 'zh')
  eq(JSON.stringify([...zhRandom].sort()), JSON.stringify([...zhRandom2].sort()), '同 seed 结果可复现（输入时空位不跳动）')

  console.log('[masking] 中文字符匹配核验')
  const zhWords2 = collectSlots(zhParas, zhFull, 'zh')
  assert(zhWords2.length > 0, `完全隐藏能收集到 ${zhWords2.length} 个空位`)
  const sample = zhWords2[0]
  eq(inlineState(sample.target, ''), 'empty', '未输入 → empty')
  const prefix = sample.target.slice(0, 1)
  eq(inlineState(sample.target, prefix), sample.target.length === 1 ? 'ok' : 'typing', '输入首字 → 在正确的路上')
  eq(inlineState(sample.target, sample.target), 'ok', '完整一致 → ok')
  eq(inlineState(sample.target, sample.target + '多'), 'wrong', '多打 → wrong')
  eq(inlineState('学习', '学刁'), 'wrong', '写错字立刻标红（字符匹配）')
  const stats = dictationStats([
    { target: '学习', value: '学习' },
    { target: '中文', value: '中' },
    { target: '分词', value: '分司' },
    { target: '测试', value: '' },
  ])
  eq(stats.total, 4, '统计含未填空位：总数 4')
  eq(stats.filled, 3, '已填 3')
  eq(stats.correct, 1, '正确 1')
  eq(stats.wrong, 1, '错误 1')
  eq(stats.accuracy, 33, '正确率按已填算 1/3')

  /* ================= 第四部分：听书 ================= */
  console.log('[audioBus] 分句：英文')
  eq(splitSentences('Hello there. How are you?').length, 2, '英文 . ? 切成 2 句')
  eq(splitSentences('One. Two. Three.').length, 3, '连续短句切 3 段')
  eq(splitSentences('Mr. Smith went home. He was tired.').length, 2, '缩写点不切断句子')

  console.log('[audioBus] 分句：中文')
  eq(splitSentences('等一下。好的！').length, 2, '中文句末标点生效')
  eq(splitSentences('春天来了，花开了。').length, 1, '逗号不切句（只有。！？；才切）')
  eq(splitSentences('第一段。第二段。第三段。').length, 3, '连续中文短句切 3 段')

  console.log('[audioBus] 分句：中英混排按语言边界再切')
  const mixed = splitSentences('今天我们学习 apple 这个单词。', { crossLanguage: true })
  assert(mixed.length === 3, `混排一句切成 3 句（实际 ${mixed.length}：${mixed.join(' | ')}）`)
  assert(mixed[1] === 'apple', `中间那一小块是纯英文（实际「${mixed[1]}」）`)
  assert(dominantLang(mixed[0]) === 'zh', '第 1 句判为中文 → 用中文嗓')
  assert(dominantLang(mixed[1]) === 'en', '第 2 句判为英文 → 用英文嗓')
  eq(
    splitSentences('今天我们学习 apple 这个单词。').length,
    1,
    '不开 crossLanguage 时行为与改造前一致（1 句）',
  )

  console.log('[voicePicker] 嗓音挑选')
  const voices: VoiceLike[] = [
    { name: 'Windows David - English (United States)', lang: 'en-US', localService: true },
    { name: 'Google US English', lang: 'en-US', localService: false },
    { name: 'Google 普通话（中国大陆）', lang: 'zh-CN', localService: false },
    { name: 'Microsoft Huihui - Chinese (Simplified)', lang: 'zh-CN', localService: true },
    { name: 'Google UK English Male', lang: 'en-GB', localService: false },
  ]
  eq(pickVoice(voices, 'en', true)?.name, 'Google US English', '联网时英文优先云端 en-US 嗓')
  eq(pickVoice(voices, 'en', false)?.name, 'Windows David - English (United States)', '断网时英文退回本地嗓（否则念不出来）')
  eq(pickVoice(voices, 'zh', true)?.name, 'Google 普通话（中国大陆）', '联网时中文优先云端中文嗓')
  eq(pickVoice(voices, 'zh', false)?.name, 'Microsoft Huihui - Chinese (Simplified)', '断网时中文退回系统本地嗓')
  // 云端嗓不存在时的降级
  const onlyLocalEn: VoiceLike[] = [{ name: 'Local EN', lang: 'en-GB', localService: true }]
  eq(pickVoice(onlyLocalEn, 'en', true)?.name, 'Local EN', '只有本地嗓时联网也照用（不能返回空让系统默认接手）')
  eq(pickVoice([{ name: 'JP', lang: 'ja-JP', localService: true }], 'zh', true), undefined, '完全没有目标语言嗓音 → undefined')
  const ranked = rankVoices(voices, 'en', true)
  assert(
    ranked.length === 3 && ranked.every((v) => v.lang.startsWith('en')),
    `英文排序只保留英文嗓（实际 ${ranked.map((v) => v.lang).join(',')}）`,
  )
  assert(ranked[0].lang.startsWith('en-US'), '语言内部先挑 en-US 再挑 en-GB')

  console.log('[listenSession] 句间 200ms 停顿')
  eq(DEFAULT_PAUSE_MS, 200, '需求规定的停顿是 200ms')
  const spokenAt: number[] = []
  let pendingPause: (() => void) | null = null
  let t0 = 0
  const pauseSess = new ListenSession({
    rate: () => 1,
    onIndex: () => {},
    speak: (u) => {
      spokenAt.push(Date.now() - t0)
      return new Promise<void>((res) => {
        pendingPause = res
      })
    },
    cancel: () => {
      const p = pendingPause
      pendingPause = null
      p?.()
    },
  })
  const finishPause = () => {
    const p = pendingPause
    pendingPause = null
    p?.()
  }
  const units = [
    { text: 'A', para: 0, sent: 0, lang: 'en' as const },
    { text: 'B', para: 0, sent: 1, lang: 'en' as const },
  ]
  t0 = Date.now()
  pauseSess.start(units)
  await new Promise((r) => setTimeout(r, 20))
  eq(spokenAt.length, 1, '第 1 句立即开始朗读')
  finishPause()
  await new Promise((r) => setTimeout(r, 20))
  eq(spokenAt.length, 1, '停顿未满 200ms 时不抢读下一句')
  await new Promise((r) => setTimeout(r, 220))
  eq(spokenAt.length, 2, '停顿结束后才开始第 2 句')
  assert(spokenAt[1] >= 200, `第 2 句起点 ${spokenAt[1]}ms ≥ 200ms（确实停了）`)
  pauseSess.stop()

  console.log('[listenSession] 停顿期间被抢占不被吞')
  const spoken2: string[] = []
  let pending2: (() => void) | null = null
  const pauseSess2 = new ListenSession({
    rate: () => 1,
    speak: (u) => {
      spoken2.push(u.text)
      return new Promise<void>((res) => {
        pending2 = res
      })
    },
    cancel: () => {
      const p = pending2
      pending2 = null
      p?.()
    },
  })
  pauseSess2.start(units)
  await new Promise((r) => setTimeout(r, 20))
  const p2 = pending2
  pending2 = null
  p2?.()
  // 此刻正处在 A 与 B 之间的停顿里
  // 让 loop 真正走进 A 与 B 之间的停顿，而不是在 A 的 await 里被抢
  await new Promise((r) => setTimeout(r, 10))
  pauseSess2.suspend()
  await new Promise((r) => setTimeout(r, 300))
  eq(spoken2.join(''), 'A', '抢占期间停顿结束后也不继续往下读')
  pauseSess2.resume()
  await new Promise((r) => setTimeout(r, 250))
  eq(spoken2.join(''), 'AB', '恢复后才读下一句')
  pauseSess2.stop()

  console.log('[listenSession] 点击某句 → 从该句重读')
  const spoken3: string[] = []
  let pending3: (() => void) | null = null
  const sess3 = new ListenSession({
    rate: () => 1,
    speak: (u) => {
      spoken3.push(u.text)
      return new Promise<void>((res) => {
        pending3 = res
      })
    },
    cancel: () => {
      const p = pending3
      pending3 = null
      p?.()
    },
  })
  const units3 = ['A', 'B', 'C'].map((t, i) => ({ text: t, para: 0, sent: i, lang: 'en' as const }))
  sess3.start(units3)
  await new Promise((r) => setTimeout(r, 20))
  sess3.seek(2)
  await new Promise((r) => setTimeout(r, 20))
  eq(sess3.index, 2, '下标立刻跳到第 3 句')
  eq(spoken3.join(''), 'AC', '被打断的旧句不再续读，直接从第 3 句开始')
  sess3.stop()

  if (failed) {
    console.error(`\n${failed} 项失败`)
    process.exit(1)
  }
  console.log('\n中英文兼容单测全部通过 ✓')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
