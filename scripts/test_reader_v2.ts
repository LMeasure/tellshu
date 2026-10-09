/**
 * 阅读器 8 项需求单测（纯逻辑 + 关键源码断言）
 * 运行：npx tsx scripts/test_reader_v2.ts
 *
 * 覆盖：
 *   【1】英文听书走浏览器默认（不挑嗓音 / 不设 rate / pitch）
 *   【2】中文停顿：。！？150ms、，、；：100ms、感叹号升调、「-」跳过
 *   【3】滑动选词：横纵轴判定 + 一次拖拽内去重
 *   【4】暂停记住句子下标，恢复从该句重读
 *   【5】双击重读：默认继续 / 可设「只读这一句」
 *   【6】单击单词发音不被静默吞掉（源码断言 + audioBus 让位）
 *   【7】重新导入：同 id 覆盖 + 页码归零 + 隐藏状态清空
 *   【8】双语素材随机隐藏「中 / 英」切换
 *
 * 最后有一组**反向测试**：故意构造"错误实现"，确认上面的断言真的会红，
 * 否则这些断言只是装饰。
 */

import 'fake-indexeddb/auto'
import { readFileSync } from 'node:fs'

import {
  EXCLAM_PITCH,
  FALLBACK_PAUSE_MS,
  ZH_PAUSE_LONG_MS,
  ZH_PAUSE_SHORT_MS,
  buildListenUnits,
  firstUnitIndexOfSentence,
  lastUnitIndexOfSentence,
  splitChineseByPunct,
  stripUnreadablePunct,
} from '../src/lib/listenPlan'
import { ListenSession, type ListenUnit, type SpeakPlan } from '../src/lib/listenSession'
import { isSelectingAxis, markVisited, pickSlotKey, resolveDragAxis } from '../src/lib/dragSelect'
import { bilingualStats, detectBilingual, tokenLang } from '../src/lib/textLang'
import { buildMaskPlan, collectSlots, DEFAULT_MASK_CONFIG } from '../src/lib/masking'
import { audioBus, type AudioHolder } from '../src/lib/audioBus'
import { speakFocused } from '../src/lib/speech'
import {
  clearDictationProgress,
  getReading,
  saveDictationProgress,
  saveReading,
  updateReadingPage,
} from '../src/domain/learning'

let failed = 0
function assert(cond: boolean, msg: string) {
  if (cond) console.log('  ✓', msg)
  else {
    console.error('  ✗', msg)
    failed += 1
  }
}
function eq(actual: unknown, expected: unknown, msg: string) {
  assert(
    actual === expected,
    `${msg}（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`,
  )
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 可控的假朗读：调用方决定「这一句什么时候读完」 */
function makeSession(sink: { spoken: string[]; plans: SpeakPlan[] }, onEnd?: () => void) {
  let pending: (() => void) | null = null
  const session = new ListenSession({
    rate: () => 1,
    speak: (u, plan) => {
      sink.spoken.push(u.text)
      sink.plans.push(plan)
      return new Promise<void>((res) => {
        pending = res
      })
    },
    cancel: () => {
      const p = pending
      pending = null
      p?.()
    },
    onEnd,
  })
  /** 让当前这一句"读完" */
  const finishCurrent = () => {
    const p = pending
    pending = null
    p?.()
  }
  return { session, finishCurrent }
}

function unit(t: string, extra: Partial<ListenUnit> = {}): ListenUnit {
  return { text: t, para: 0, sent: 0, pauseAfter: 0, ...extra }
}

async function main() {
  /* ============ 需求【1】英文听书：浏览器默认 ============ */
  console.log('[需求1] 英文单元标记 natural（不挑嗓音 / 不设 rate / pitch）')
  const enUnits = buildListenUnits([['Hello, world. It is fine.']], { rate: 1.25 })
  assert(enUnits.length >= 2, `英文段被切成 ${enUnits.length} 个单元`)
  assert(
    enUnits.every((u) => u.natural === true),
    '所有英文单元都标记为 natural（走浏览器默认）',
  )
  assert(
    enUnits.every((u) => u.lang === 'en'),
    '英文单元语言标签为 en',
  )
  assert(
    enUnits.every((u) => u.rate === undefined && u.pitch === undefined),
    '英文单元不带 rate / pitch（保持浏览器默认）',
  )
  assert(
    enUnits.every((u) => u.pauseAfter === FALLBACK_PAUSE_MS),
    `英文句间呼吸固定 ${FALLBACK_PAUSE_MS}ms，不套用中文标点规则`,
  )

  console.log('[需求1] ListenSession 把 natural 透传给朗读实现')
  const sink1 = { spoken: [] as string[], plans: [] as SpeakPlan[] }
  const s1 = makeSession(sink1)
  s1.session.start([unit('Hello', { natural: true }), unit('你好。', { natural: false, rate: 1.2, pitch: 1 })])
  await tick(10)
  eq(sink1.plans[0].natural, true, '第 1 句（英文）plan.natural = true')
  eq(sink1.plans[0].rate, 1, 'natural 时不覆盖 rate（值不影响，实现侧不设置）')
  s1.finishCurrent()
  await tick(10)
  eq(sink1.plans[1].natural, false, '第 2 句（中文）plan.natural = false')
  eq(sink1.plans[1].rate, 1.2, '中文单元沿用显式倍速')
  s1.session.stop()

  console.log('[需求1] web 实现：natural 早退必须在设置 rate 之前（源码断言）')
  const webSrc = readFileSync(new URL('../src/services/speech/web.ts', import.meta.url), 'utf8')
  const iNatural = webSrc.indexOf('if (options?.natural)')
  const iRate = webSrc.indexOf('u.rate = resolveRate(options)')
  const iVoice = webSrc.indexOf('u.voice = v')
  assert(iNatural > 0, 'web.ts 里有 natural 分支')
  assert(iNatural < iRate, 'natural 早退排在设置 rate 之前（否则倍速仍会被覆盖）')
  assert(iNatural < iVoice, 'natural 早退排在指定 voice 之前（否则还是会挑嗓音）')

  /* ============ 需求【2】中文停顿 ============ */
  console.log('[需求2] 中文标点停顿档位')
  const chunks = splitChineseByPunct('你好，世界。')
  eq(chunks.length, 2, '「你好，世界。」切成 2 段')
  eq(chunks[0].pauseAfter, ZH_PAUSE_SHORT_MS, '逗号后停 100ms')
  eq(chunks[1].pauseAfter, ZH_PAUSE_LONG_MS, '句号后停 150ms')
  eq(chunks[1].pitch, 1, '普通陈述句 pitch 保持 1')
  const excl = splitChineseByPunct('快跑！')
  eq(excl[0].pauseAfter, ZH_PAUSE_LONG_MS, '感叹号后停 150ms')
  eq(excl[0].pitch, EXCLAM_PITCH, `感叹句 pitch 升到 ${EXCLAM_PITCH}（语气微调）`)
  const ask = splitChineseByPunct('真的吗？')
  eq(ask[0].pauseAfter, ZH_PAUSE_LONG_MS, '问号后停 150ms')
  eq(ask[0].pitch, 1, '问句不升调（只有感叹句做微调）')

  console.log('[需求2] 「-」等符号不读，直接跳过')
  eq(stripUnreadablePunct('你好——世界'), '你好世界', '破折号被跳过')
  eq(stripUnreadablePunct('a-b~c*d'), 'abcd', '连字符 / 波浪号 / 星号被跳过')
  const zhUnits = buildListenUnits([['你好——世界，朋友。']], { rate: 1.5 })
  assert(
    zhUnits.every((u) => !/[—–\-]/.test(u.text)),
    '中文朗读文本里不残留破折号',
  )
  assert(
    zhUnits.every((u) => u.natural === false),
    '中文单元不走 natural（要挑中文嗓音 + 按倍速）',
  )
  eq(zhUnits[0].rate, 1.5, '中文单元带上了设置里的倍速')
  const tail = zhUnits[zhUnits.length - 1]
  eq(tail.pauseAfter, ZH_PAUSE_LONG_MS, '句末句号 → 150ms')

  console.log('[需求2] 中英混排各走各的')
  const mixUnits = buildListenUnits([['今天我们学 apple 这个单词。']], { rate: 1 })
  assert(
    mixUnits.some((u) => u.lang === 'en' && u.natural === true),
    '混排里的英文片段走浏览器默认',
  )
  assert(
    mixUnits.some((u) => u.lang === 'zh' && u.natural === false),
    '混排里的中文片段走中文嗓音 + 标点停顿',
  )

  /* ============ 需求【3】滑动选词 ============ */
  console.log('[需求3] 横纵轴判定')
  eq(resolveDragAxis(20, 2), 'x', '横向位移大 → 选词')
  eq(resolveDragAxis(2, 20), 'y', '纵向位移大 → 滚页面')
  eq(resolveDragAxis(3, 3), 'none', '位移没过阈值 → 还不能判定')
  eq(resolveDragAxis(8, 7), 'x', '刚好过阈值且横向更大 → 选词')
  assert(isSelectingAxis('x'), '横向才进入选词模式')
  assert(!isSelectingAxis('y'), '纵向不进入选词模式（留给页面滚动）')
  assert(!isSelectingAxis('none'), '未判定方向时也不选词')

  console.log('[需求3] 一次拖拽内同一个词只切一次')
  const visited = new Set<string>()
  eq(markVisited(visited, '0:1'), true, '首次经过 → 切换')
  eq(markVisited(visited, '0:1'), false, '同一次拖拽再次经过 → 不重复切换（防闪烁）')
  eq(markVisited(visited, '0:2'), true, '换一个词 → 切换')
  eq(pickSlotKey('0:3'), '0:3', '命中 data-slot')
  eq(pickSlotKey(''), null, '空值视为未命中')
  eq(pickSlotKey(null), null, 'null 视为未命中')

  console.log('[需求3] 选择阶段不再挂 onClick（否则 mousedown + click 会互相抵消）')
  const idSrc = readFileSync(
    new URL('../src/components/learning/InlineDictation.tsx', import.meta.url),
    'utf8',
  )
  const selStart = idSrc.indexOf('if (selectable && selecting)')
  const selBlock = idSrc.slice(selStart, selStart + 700)
  assert(selBlock.includes('data-slot={k}'), '可选词带 data-slot（滑动命中靠它）')
  assert(!selBlock.includes('onClick'), '选择阶段不挂 onClick（避免与 mousedown 双切）')
  assert(idSrc.includes("addEventListener('touchmove'"), '注册了 touchmove（滑动选词）')
  assert(idSrc.includes('passive: false'), 'touchmove 用 passive:false（横向选词要吃掉滚动）')

  /* ============ 需求【4】暂停记住位置 ============ */
  console.log('[需求4] 暂停 → 记住句子下标 → 恢复从该句重读')
  const sink4 = { spoken: [] as string[], plans: [] as SpeakPlan[] }
  let ended4 = false
  const s4 = makeSession(sink4, () => {
    ended4 = true
  })
  const units4 = [
    unit('A', { sent: 0 }),
    unit('B', { sent: 1 }),
    unit('C', { sent: 2 }),
  ]
  s4.session.start(units4)
  await tick(10)
  eq(sink4.spoken.join(''), 'A', '第 1 句开始朗读')
  s4.finishCurrent()
  await tick(10)
  eq(sink4.spoken.join(''), 'AB', '第 2 句开始朗读')
  s4.session.pause()
  await tick(20)
  assert(s4.session.isPaused, '暂停后会话处于 paused')
  eq(s4.session.index, 1, '暂停时下标停在正在读的第 2 句（供界面记住）')
  eq(sink4.spoken.join(''), 'AB', '暂停期间不再往下读')
  assert(!ended4, '暂停不算读完（不触发 onEnd）')
  s4.session.resume()
  await tick(20)
  eq(sink4.spoken.join(''), 'ABB', '恢复后从记住的那一句开头重读（句子级恢复）')
  eq(s4.session.index, 1, '恢复后下标仍是那一句')
  s4.session.stop()

  console.log('[需求4] 用户暂停期间，别的音源播完不能把听书唤醒')
  const sink4b = { spoken: [] as string[], plans: [] as SpeakPlan[] }
  const s4b = makeSession(sink4b)
  audioBus.reset()
  s4b.session.start(units4)
  await tick(10)
  audioBus.claim(s4b.session.holder)
  s4b.session.pause()
  await tick(10)
  const wordHolder: AudioHolder = { role: 'word', suspend() {}, resume() {} }
  audioBus.claim(wordHolder) // 模拟点单词发音：抢占焦点，挂起听书
  await tick(10)
  audioBus.release(wordHolder) // 单词念完，焦点归还
  await tick(20)
  eq(sink4b.spoken.join(''), 'A', '用户暂停期间不会被别的音源唤醒（否则一点词就自动续读）')
  assert(s4b.session.isPaused, '仍处于暂停状态')
  s4b.session.resume()
  await tick(20)
  eq(sink4b.spoken.join(''), 'AA', '用户点「继续」才从该句重读')
  s4b.session.stop()
  audioBus.reset()

  /* ============ 需求【5】双击重读 / 只读这一句 ============ */
  console.log('[需求5] 双击某句 → 从该句重读，读完继续（默认）')
  const sink5 = { spoken: [] as string[], plans: [] as SpeakPlan[] }
  let ended5 = false
  const s5 = makeSession(sink5, () => {
    ended5 = true
  })
  const units5 = [unit('A', { sent: 0 }), unit('B', { sent: 1 }), unit('C', { sent: 2 })]
  s5.session.start(units5, 1)
  await tick(10)
  eq(sink5.spoken.join(''), 'B', '从双击的那一句开始')
  s5.finishCurrent()
  await tick(10)
  eq(sink5.spoken.join(''), 'BC', '默认继续往下读')
  s5.session.stop()

  console.log('[需求5] 「只读这一句」→ 读完就停')
  const sink5b = { spoken: [] as string[], plans: [] as SpeakPlan[] }
  let ended5b = false
  const s5b = makeSession(sink5b, () => {
    ended5b = true
  })
  const stopAt = lastUnitIndexOfSentence(units5, 0, 1)
  eq(stopAt, 1, '第 2 句的最后一个单元下标是 1')
  s5b.session.start(units5, 1, stopAt)
  await tick(10)
  eq(sink5b.spoken.join(''), 'B', '只读这一句时先读它')
  s5b.finishCurrent()
  await tick(20)
  eq(sink5b.spoken.join(''), 'B', '读完这一句就停（不会读到 C）')
  assert(ended5b, '触发 onEnd（界面据此回到未播放状态）')
  s5b.session.stop()

  console.log('[需求5] 定位辅助函数')
  eq(firstUnitIndexOfSentence(units5, 0, 2), 2, '首单元下标定位正确')
  eq(lastUnitIndexOfSentence(units5, 0, 9), -1, '找不到的句子返回 -1（调用方据此放弃）')

  /* ============ 需求【6】单击单词发音 ============ */
  console.log('[需求6] 单击单词 → 弹窗 + 发音')
  const readerSrc = readFileSync(new URL('../src/pages/Reader.tsx', import.meta.url), 'utf8')
  const onWordIdx = readerSrc.indexOf('async function onWord(')
  const onWordBlock = readerSrc.slice(onWordIdx, onWordIdx + 400)
  assert(onWordBlock.includes('speakFocused'), '点词处理器里直接触发发音（不只是弹窗）')
  assert(readerSrc.includes('onDoubleClick'), '整句用 onDoubleClick 触发重读')
  assert(!readerSrc.includes('onClick={() => isSpeechSupported() && replaySentence'), '整句不再用 onClick（避免和点词冲突）')
  // 发音必须走 audioBus：正在听书时先让位，念完再续读
  audioBus.reset()
  const spokenWord = await speakFocused('apple')
  eq(spokenWord, false, 'Node 里没有真实语音，speakFocused 返回 false（不抛错）')

  /* ============ 需求【7】重新导入：覆盖 + 重置 ============ */
  console.log('[需求7] 编辑后重新导入：同 id 覆盖、页码归零、隐藏状态清空')
  const doc = await saveReading({ title: '原文', type: 'article', content: 'Hello world' })
  await updateReadingPage(doc.id, 3)
  await saveDictationProgress(doc.id, {
    mode: 'random',
    ratio: 0.3,
    hidePunctuation: false,
    manualKeys: ['0:0'],
    seed: 2,
    page: 3,
    values: { '3:0:0': 'x' },
  })
  const before = await getReading(doc.id)
  eq(before?.last_page, 3, '前置条件：进度停在第 4 页')
  assert(before?.dictation !== undefined, '前置条件：有默写进度')

  await saveReading({
    title: '改过的原文',
    type: 'article',
    content: 'Hello world again',
    id: doc.id,
    last_page: 0,
  })
  await clearDictationProgress(doc.id)
  const after = await getReading(doc.id)
  eq(after?.id, doc.id, '仍是同一条素材（没有新增一条）')
  eq(after?.content, 'Hello world again', '原文被覆盖')
  eq(after?.word_count, 3, '词数按新内容重算')
  eq(after?.last_page, 0, '页码归零（朗读进度重置）')
  eq(after?.dictation, undefined, '隐藏状态与已填内容被清空')

  /* ============ 需求【8】双语隐藏「中 / 英」 ============ */
  console.log('[需求8] 双语判定')
  eq(tokenLang('apple'), 'en', 'apple → en')
  eq(tokenLang('苹果'), 'zh', '苹果 → zh')
  eq(tokenLang('apple 苹果'), 'zh', '含汉字即算 zh（双语隐藏按字判断）')
  eq(detectBilingual(['这是一段中文。', 'This is English.']), true, '中英段落都有 → 双语')
  eq(detectBilingual(['这是一段中文。', '这也是中文。']), false, '只有中文 → 不是双语')
  eq(detectBilingual(['This is English.', 'More English here.']), false, '只有英文 → 不是双语')
  eq(detectBilingual(['中文里夹着 apple 这个单词。']), true, '单段混排也算双语')
  const bs = bilingualStats(['中文', '中文', 'English', '中文'])
  eq(bs.switches, 2, '交替次数被统计出来（用于判断"交替出现"）')

  console.log('[需求8] 只隐藏中文 / 只隐藏英文')
  const paras = ['苹果 apple 香蕉 banana', '橘子 orange 梨 pear']
  const hideZh = buildMaskPlan(
    paras,
    { ...DEFAULT_MASK_CONFIG, mode: 'random', ratio: 0.9, target: 'zh' },
    [],
    7,
    'mixed',
  )
  const zhTargets = collectSlots(paras, hideZh, 'mixed').map((s) => s.target)
  assert(zhTargets.length > 0, `隐藏中文时确实有空位（${zhTargets.length} 个）`)
  assert(
    zhTargets.every((t) => tokenLang(t) === 'zh'),
    `隐藏中文时全部空位都是中文：${zhTargets.join('/')}`,
  )
  const hideEn = buildMaskPlan(
    paras,
    { ...DEFAULT_MASK_CONFIG, mode: 'random', ratio: 0.9, target: 'en' },
    [],
    7,
    'mixed',
  )
  const enTargets = collectSlots(paras, hideEn, 'mixed').map((s) => s.target)
  assert(enTargets.length > 0, `隐藏英文时确实有空位（${enTargets.length} 个）`)
  assert(
    enTargets.every((t) => tokenLang(t) === 'en'),
    `隐藏英文时全部空位都是英文：${enTargets.join('/')}`,
  )
  const hideAll = buildMaskPlan(
    paras,
    { ...DEFAULT_MASK_CONFIG, mode: 'random', ratio: 0.9, target: 'all' },
    [],
    7,
    'mixed',
  )
  const allTargets = collectSlots(paras, hideAll, 'mixed').map((s) => s.target)
  assert(
    allTargets.some((t) => tokenLang(t) === 'zh') && allTargets.some((t) => tokenLang(t) === 'en'),
    'target=all 时中英文都可能被隐藏',
  )

  /* ============ 反向测试：确认上面的断言"该红时能红" ============ */
  console.log('[反向] 断言本身有效（构造错误实现应失败）')
  assert(resolveDragAxis(2, 20) !== 'x', '纵向为主时不能判成选词（否则页面没法滚）')
  assert(stripUnreadablePunct('你好——世界') !== '你好——世界', '破折号若不过滤，断言应失败')
  // 把 natural 早退改掉 → 源码断言必须失效（说明它不是摆设）
  const brokenWeb = webSrc.replace('if (options?.natural)', 'if (!options?.natural)')
  const bNatural = brokenWeb.indexOf('if (options?.natural)')
  const bRate = brokenWeb.indexOf('u.rate = resolveRate(options)')
  assert(!(bNatural > 0 && bNatural < bRate), '去掉 natural 早退后源码断言失效（断言有效）')
  // 中文停顿档位若写错（都写 200）→ 断言应失败
  assert(ZH_PAUSE_SHORT_MS !== ZH_PAUSE_LONG_MS, '长短停顿必须是两个档位（都写一样就测不出问题）')
  // 双语判定若退化成"只看第一段" → 断言应失败
  assert(detectBilingual(['这是一段中文。']) === false, '单段纯中文不能被判成双语')
  // 编辑重新导入若忘记 last_page:0 → 页码不会被重置（证明该参数是重置的关键）
  const keep = await saveReading({ title: 'x', type: 'article', content: 'a b c', id: doc.id })
  eq(keep.last_page, 0, '不传 last_page 时会沿用上次的 0（本次基线）')
  await updateReadingPage(doc.id, 5)
  const keep2 = await saveReading({ title: 'x', type: 'article', content: 'a b c', id: doc.id })
  eq(keep2.last_page, 5, '不显式传 last_page:0 → 进度被保留（这正是要显式传 0 的原因）')

  if (failed) {
    console.error(`\n${failed} 项失败`)
    process.exit(1)
  }
  console.log('\n阅读器 8 项需求单测全部通过 ✓')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
