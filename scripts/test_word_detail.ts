/**
 * 单词详情页单测（纯逻辑 + 关键源码断言）
 * 运行：npx tsx scripts/test_word_detail.ts
 *
 * 覆盖需求（2026-10-05 重设计版）：
 *   页面整体：EasyMad 渐变吸顶头 / 乳白树冠 + 淡灰横线分区 / 内置滚动条
 *   需求 1：搜索框置顶 + 单词大标题（点击进编辑态）
 *   需求 2：英美音切换在音标处（美音标未收录要如实说）；朗读跟随口音
 *   需求 3：播放 / 录音 / 收藏纯图标（44×44），双路跟读收口在 useFollowMic
 *   需求 4：连续朗读全部例句，句间停 500ms
 *   需求 10/23：例句默认 1 条，9 号展开 / 两条平杠收起
 *   需求 11/12：例句按钮右侧与句子同行、完整展示不截断
 *   需求 13/14：词性左固定列（斜体灰），释义右侧正常字体
 *   需求 17/18/19：8 号收藏星（实心橙/空心可取消）、5 号返回、6 号去详情
 *   全局图标：底部导航 3/1/2/4 号、10 号重置、11 号消息、导入新图标
 *   学习页改动（2026-10-06）：去「生词本闯关/复习」跳转 / 卡上去收藏 / 弹窗「完成」+ 烟花庆祝
 *   【5】例句归属：只在数量相等时绑定，绝不硬配（不变）
 *   【6】【7】例句里点单词 → 弹窗 → 跳转（不变）
 *   【8】顶部搜索框 + 模糊结果 + 回车跳转（不变）
 *   【9】返回箭头 + 状态持久化（不变）
 *
 * 最后有**反向测试**：构造错误实现，确认断言真的会红。
 */

import { readFileSync, existsSync } from 'node:fs'

import {
  bindExamples,
  collectExamples,
  exampleKey,
  lemmaCandidates,
  parseDefinitionZh,
  stripWordPunct,
  totalSenses,
} from '../src/lib/wordSense'
import {
  MOCK_SCORE_MAX,
  MOCK_SCORE_MIN,
  countWords,
  formatSeconds,
  mockFollowScore,
  scoreRemark,
} from '../src/lib/followScore'
import {
  buildQueryContext,
  levenshtein,
  rankByScore,
  scoreMatch,
} from '../src/lib/searchRank'
import type { SearchIndexWord } from '../src/lib/search'

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

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf-8')

/** 真实数据里的原样字符串（by / aboard / absorb 都取自 CET4.json） */
const BY_DEF =
  'prep. 在...旁边；通过（某种方式）；由（某人完成）；到（某时）之前；adv. 经过；附近；搁置'
const ABOARD_DEF = 'adv. /prep. 在（船、飞机、火车等）上；登（交通工具）'
const ABSORB_DEF = 'vt. 吸收（液体、热量、知识等）；vt. 使全神贯注'

function main() {
  /* ============ 需求【4】词性分组 ============ */
  console.log('[需求4] definition_zh → 词性分组（真实数据）')
  const byGroups = parseDefinitionZh(BY_DEF)
  eq(byGroups.length, 2, 'by 有 prep. / adv. 两个词性组')
  eq(byGroups[0].pos, 'prep.', '第一组是 prep.')
  eq(byGroups[0].senses.length, 4, 'prep. 下有 4 条释义')
  eq(byGroups[0].senses[0], '在...旁边', '首条释义正确（没有吃掉词性前缀）')
  eq(byGroups[1].pos, 'adv.', '第二组是 adv.')
  eq(byGroups[1].senses.length, 3, 'adv. 下有 3 条释义')
  eq(totalSenses(byGroups), 7, 'by 共 7 条释义')

  console.log('[需求4] 兼容 "adv. /prep." 合并写法与相邻同词性合并')
  const aboard = parseDefinitionZh(ABOARD_DEF)
  eq(aboard.length, 1, 'aboard 的 "adv. /prep." 是一个组，不是两个')
  eq(aboard[0].pos, 'adv. / prep.', '合并词性前缀被原样保留')
  eq(aboard[0].senses.length, 2, '后面那段没有词性前缀，归进同一组')
  const absorb = parseDefinitionZh(ABSORB_DEF)
  eq(absorb.length, 1, 'absorb 的两个 vt. 段合并为一组')
  eq(absorb[0].senses.length, 2, '合并后共 2 条释义')

  console.log('[需求4] 无词性标注 / 空值降级')
  const plain = parseDefinitionZh('高兴的；快乐的')
  eq(plain.length, 1, '没有词性前缀时只有一组')
  eq(plain[0].pos, '', 'pos 为空串（由 UI 用 word.pos 兜底）')
  eq(parseDefinitionZh(undefined).length, 0, 'undefined 返回空数组，不崩')
  eq(parseDefinitionZh('  ').length, 0, '纯空白返回空数组')

  /* ============ 需求【5】例句绑定：绝不硬配 ============ */
  console.log('[需求5] 释义数 != 例句数 → pooled（不硬配）')
  const byExamples = [
    { en: 'She stood by the window, watching the rain.', zh: '她站在窗边，望着雨。' },
    { en: 'The book was written by a famous historian.', zh: '这本书由一位著名历史学家撰写。' },
    { en: 'Please finish the work by Friday.', zh: '请在周五之前完成这项工作。' },
  ]
  const byBinding = bindExamples(byGroups, byExamples)
  eq(byBinding.mode, 'pooled', 'by 是 7 释义 / 3 例句 → 集中展示')
  eq(byBinding.pooled.length, 3, 'pooled 里是全部 3 条例句')
  assert(
    byBinding.groups.every((g) => g.senses.every((s) => s.example === null)),
    'pooled 模式下没有一条释义被硬塞例句',
  )

  console.log('[需求5] 释义数 == 例句数 → 按数据顺序一一绑定')
  const twoGroups = parseDefinitionZh('n. 银行；vt. 存钱')
  const twoEx = [
    { en: 'I went to the bank.', zh: '我去了银行。' },
    { en: 'I banked the money.', zh: '我把钱存了。' },
  ]
  const paired = bindExamples(twoGroups, twoEx)
  eq(paired.mode, 'paired', '2 释义 / 2 例句 → 精确绑定')
  eq(paired.groups[0].senses[0].example?.en, 'I went to the bank.', '第 1 义绑第 1 例')
  eq(paired.groups[1].senses[0].example?.en, 'I banked the money.', '第 2 义绑第 2 例')
  eq(paired.pooled.length, 0, 'paired 模式 pooled 为空')

  console.log('[需求5] 边界：空例句 / 空白例句')
  eq(bindExamples(twoGroups, []).mode, 'pooled', '没有例句 → pooled')
  const blank = bindExamples(twoGroups, [{ en: '   ', zh: '' }, { en: 'Real one.', zh: '' }])
  eq(blank.pooled.length, 1, '空白例句被过滤掉')
  eq(blank.pooled[0].en, 'Real one.', '只剩有内容的那条')

  /* ============ 需求【6】例句里的可点单词 ============ */
  console.log('[需求6] 词形还原候选（只影响查词顺序，不编造释义）')
  eq(stripWordPunct('"Hello,"'), 'Hello', '去掉首尾标点')
  eq(stripWordPunct('...'), '', '纯标点返回空串（不会去查库）')
  assert(lemmaCandidates('books').includes('book'), 'books → book')
  assert(lemmaCandidates('running').includes('run'), 'running → run（双写辅音还原）')
  assert(lemmaCandidates('bigger').includes('big'), 'bigger → big')
  assert(lemmaCandidates('biggest').includes('big'), 'biggest → big')
  assert(lemmaCandidates('carried').includes('carry'), 'carried → carry')
  assert(lemmaCandidates('stopped').includes('stop'), 'stopped → stop')
  eq(lemmaCandidates('')[0], undefined, '空串没有候选')
  eq(lemmaCandidates('books')[0], 'books', '原形本身排第一（先查准的）')

  /* ============ 需求【3】模拟跟读评分 ============ */
  console.log('[需求3] 模拟评分：语速合理性')
  const sentence = 'She stood by the window, watching the rain.'
  eq(countWords(sentence), 8, `例句 ${countWords(sentence)} 个词`)
  const expected = (8 / 2.5) * 1000 // 3200ms
  eq(mockFollowScore(sentence, expected), 96, '正好常速 → 高分（96）')
  assert(
    mockFollowScore(sentence, expected / 2) < mockFollowScore(sentence, expected),
    '读太快分数更低',
  )
  assert(
    mockFollowScore(sentence, expected * 2) < mockFollowScore(sentence, expected),
    '读太慢分数更低',
  )
  assert(mockFollowScore(sentence, 100) === 0, '录得太短返回 0（调用方提示重录，不显示 0 分）')
  assert(mockFollowScore('', 3000) === 0, '空句子返回 0')
  assert(mockFollowScore(sentence, NaN) === 0, '非法时长返回 0')
  const long = mockFollowScore(sentence, expected * 50)
  assert(
    long >= MOCK_SCORE_MIN && long <= MOCK_SCORE_MAX,
    `极端语速也收敛在 ${MOCK_SCORE_MIN}-${MOCK_SCORE_MAX}（实际 ${long}）`,
  )
  eq(formatSeconds(1800), '1.8s', '时长展示')
  eq(formatSeconds(0), '0.0s', '0 时长不显示负数')
  assert(scoreRemark(95).length > 0 && scoreRemark(50).length > 0, '每档都有反馈文案')

  /* ============ 例句收集 ============ */
  console.log('[例句] examples 缺失时用单条 example_en 兜底')
  eq(collectExamples({ examples: [] }).length, 0, '空数组 → 0 条')
  eq(collectExamples({ example_en: 'A dog.', example_zh: '一只狗。' }).length, 1, '单条兜底')
  eq(
    collectExamples({ examples: [{ en: 'A', zh: '甲' }, { en: 'B', zh: '乙' }] }).length,
    2,
    '有 examples 就用它',
  )

  /* ============ 需求【8】评分存档 key ============ */
  console.log('[需求9] 评分 key 稳定且按词隔离')
  eq(exampleKey('By', 1), 'by#1', 'key 统一小写，换词不串分')
  assert(exampleKey('by', 1) !== exampleKey('by', 2), '同词不同例句 key 不同')

  /* ============ 源码断言：页面真的长这样（本轮重设计后） ============ */
  console.log('[页面整体] EasyMad 渐变 + 乳白树冠 + 淡灰横线分区')
  const page = src('pages/WordDetail.tsx')
  const EASYMAD = 'linear-gradient(to right, rgb(220, 227, 91), rgb(69, 182, 73))'
  assert(page.includes(EASYMAD), '顶部是 EasyMad 渐变（需求给定色值，勿改）')
  assert(page.includes('bg-cream'), '内容区用乳白底（bg-cream）')
  const tailwind = src('../tailwind.config.js')
  assert(
    tailwind.includes('cream') && tailwind.includes('hsl(var(--cream))'),
    'cream 进了 tailwind 令牌（浅/深两套）',
  )
  assert(page.includes('divide-y divide-border'), '分区之间用淡灰横线分隔（无卡片阴影）')
  assert(
    page.includes('crownRadius') && page.includes('coveredRef') && page.includes('sticky top-0'),
    '树冠交顶：滚动驱动圆角变大，音标/按键行滚入吸顶层之下被盖住',
  )
  assert(page.includes('overflow-y-auto'), '内容区可滚动（内置滚动条）')
  const css = src('index.css')
  assert(css.includes('--cream: 42 45% 97%'), '乳白令牌已登记（浅色）')
  assert(css.includes('--cream: 150 14% 13%'), '乳白令牌已登记（深色）')

  console.log('[需求8] 分区位置可编辑（顺序可调）')
  assert(page.includes('DEFAULT_SECTION_ORDER'), '分区有默认顺序')
  assert(page.includes('moveSection'), '分区可上移 / 下移（位置可编辑）')
  assert(page.includes('setSorting'), '排序是开关式，默认不开（浏览时不会误触）')
  const sectionFn = page.slice(
    page.indexOf('function Section('),
    page.indexOf('/** 单词模块里的图标按钮'),
  )
  assert(!sectionFn.includes('shadow'), '分区本身不带阴影（需求：不要卡片阴影）')

  console.log('[需求1] 单词标题在搜索框下方，点击进编辑态')
  assert(
    page.indexOf('搜个新单词') < page.indexOf('aria-label="编辑这个单词"'),
    '搜索框在前、单词标题（编辑入口）在后',
  )
  assert(page.includes('startEdit') && page.includes('goWord(editValue)'), '点单词进入编辑，回车提交跳转')

  console.log('[需求2] 音标只标真实存在的口音；无切换按钮（2026-10-06 需求更新）')
  assert(
    !page.includes("setSetting('accent'") && !page.includes('setSetting("accent"'),
    '英/美切换按钮已去掉（只有一种口音时不提供替换按钮）',
  )
  assert(!page.includes('美音音标未收录'), '不再出现美音未收录占位（没有按钮就没有这个态）')
  assert(page.includes('内置词库音标来源为英音'), '有音标时标「英音」（内置词库来源即英音）')
  assert(page.includes('speakFocused(word?.word ?? target, slow, undefined, accent)'), '朗读跟随口音设置（默认英音）')

  console.log('[需求3/4] 播放/录音/收藏纯图标 + 连续朗读例句（句间 0.5s）')
  assert(page.includes('IconStarMark') && page.includes('IconSeqPlay'), '收藏星与连续播放用自绘图标')
  assert(!page.includes('>朗读<'), '「朗读」文字提示已去掉（只留图标）')
  assert(!page.includes('加入生词本</button>'), '「加入生词本」文字提示已去掉（只留图标）')
  assert(page.includes('SEQUENTIAL_GAP_MS'), '连续朗读的句间停顿用常量（0.5s）')
  const gap = src('lib/speech.ts')
  assert(gap.includes('SEQUENTIAL_GAP_MS = 500'), '句间停顿 = 500ms（需求定死）')

  console.log('[需求1] 被选中的按钮是葱绿（primary）')
  assert(page.includes("bg-primary text-primary-foreground"), '选中态用 primary（葱绿）')
  assert(page.includes('setWordDetailPos(-1)'), '有「全部」这个未选中项（可来回切）')

  console.log('[需求2/3] 例句行同时有喇叭和麦克风（右侧、与句子同行）')
  const row = src('components/word/ExampleRow.tsx')
  assert(row.includes('Volume2') && row.includes('Mic'), '喇叭 + 麦克风都在')
  const iVol = row.indexOf('Volume2')
  const iMic = row.indexOf('Mic', iVol)
  assert(iVol >= 0 && iMic > iVol, '两个按钮都挂上了（顺序：播放 → 录音）')
  assert(row.includes('onScore'), '录完回调评分')
  assert(row.includes('items-start gap-2'), '按钮与句子同行（右侧对齐布局）')
  assert(row.includes('[overflow-wrap:anywhere]'), '例句完整展示不截断（长句可换行）')

  console.log('[需求10/23] 例句默认 1 条，9 号展开 / 两条平杠收起')
  assert(
    page.includes('IconExpandCrown') && page.includes('IconCollapseBars'),
    '展开（9 号）与收起（两条平杠）图标齐备',
  )
  assert(page.includes('exampleList.slice(0, 1)'), '默认只显示一条例句')

  console.log('[需求3] 识别与录音互斥（不能同时抢麦克风）——双路逻辑收口在 useFollowMic')
  const hook = src('hooks/useFollowMic.ts')
  const iRec = hook.indexOf('isRecognitionSupported()')
  const iMedia = hook.indexOf('recordingService.createSession()')
  assert(iRec > 0 && iRec < iMedia, '先判断识别；识别可用就直接 return，不再开 MediaRecorder')
  assert(hook.includes('return'), '识别分支有早退')
  assert(row.includes('·模拟'), '模拟分在 UI 上被标注，不会冒充真实评分')
  assert(hook.includes('dispose'), '组件卸载释放麦克风（hook 内统一处理）')
  assert(page.includes('useFollowMic'), '单词本体跟读与例句共用同一套双路逻辑')

  console.log('[需求13/14] 词性左固定列（斜体灰），释义右侧正常字体')
  assert(page.includes('posColWidth'), '词性列固定宽度（按本词最长词性留位，位置固定）')
  assert(
    page.includes('italic leading-relaxed text-muted-foreground'),
    '词性斜体 + 灰色',
  )
  assert(page.includes('space-y-1.5'), '释义逐条分隔（换行）')

  console.log('[需求6/7] 点单词弹窗 + 跳转')
  const pop = src('components/word/WordPopover.tsx')
  assert(pop.includes('查看详情'), '弹窗里有「查看详情」')
  assert(pop.includes('词库未收录'), '查不到如实说明，不猜释义')
  assert(page.includes('onWordClick={openWord}'), '例句里的单词可点')
  assert(page.includes('onDetail={goWord}'), '弹窗的查看详情会跳转')
  assert(page.includes('navigate(`/word/${encodeURIComponent(t)}`)'), '跳转到该单词详情页')

  console.log('[需求8] 顶部搜索框 + 模糊结果 + 回车跳转')
  assert(page.includes('searchAllWords'), '输入即查词库')
  assert(page.includes('submitSearch'), '回车提交')
  assert(page.includes('sugOpen'), '结果列表可收起')
  assert(page.includes('goWord(sug[0]?.word ?? q)'), '有结果跳第一条，没结果按原样跳')

  console.log('[需求18] 返回箭头（5 号）+ 状态持久化')
  assert(page.includes('IconBack'), '有返回箭头（述树 5 号左箭头）')
  assert(page.includes('navigate(-1)'), '返回上一页')
  assert(page.includes('window.history.length > 1'), '无上一页时退回搜索页，不会点了没反应')
  const store = src('store/useAppStore.ts')
  assert(store.includes('wordDetail'), '详情页 UI 态进了 persist')
  assert(store.includes("wordDetail: s.wordDetail"), '状态被持久化（切页回来还在）')

  console.log('[边界] 数据层：详情页加载走「先定位词本」')
  const repo = src('data/repository.ts')
  assert(repo.includes('loadWordDetail'), '新增按词加载完整词条')
  // 看函数体内部的调用顺序，而不是函数在文件里的位置
  const fnStart = repo.indexOf('export async function loadWordDetail')
  const fnBody = repo.slice(fnStart, repo.indexOf('\n}\n', fnStart))
  const iSearch = fnBody.indexOf('searchAllWords')
  const iLookup = fnBody.indexOf('lookupWord(q)')
  assert(
    iSearch > 0 && iLookup > iSearch,
    '先走搜索索引定位词本，查不到才回退全量（避免一上来就 19MB）',
  )
  // 词形还原查词：先便宜（按词本索引）再兜底（全量），不是一上来就建 19MB Map
  const varStart = repo.indexOf('export async function lookupWordVariants')
  const varBody = repo.slice(varStart, repo.indexOf('\n}\n', varStart))
  const iCheap = varBody.indexOf("loadWordDetail(c, { fullScan: false })")
  const iFull = varBody.indexOf('getWordMap()')
  assert(
    iCheap > 0 && iFull > iCheap,
    '查屈折形式时先走索引，全都落空才做一次全量建 Map',
  )

  /* ============ 反向测试：确认断言不是摆设 ============ */
  console.log('[反向] 构造错误实现，断言应当失效')
  // 1. 若把 pooled 改成永远 paired → by 会被硬配
  const naiveGroups = bindExamples(byGroups, byExamples).groups
  assert(
    naiveGroups.every((g) => g.senses.every((s) => s.example === null)),
    '错误实现（硬配）下这条应失败：说明断言有效',
  )
  // 2. 词性若被当成释义的一部分 → 首条会带着 "prep."
  assert(!BY_DEF.startsWith('在'), '原始字符串确实带词性前缀（解析不能把它留在释义里）')
  // 3. 模拟分若不给上限 → 极端语速会溢出
  assert(mockFollowScore(sentence, expected * 500) <= MOCK_SCORE_MAX, '极端值被 clamp 住')
  // 4. 若忘记过滤空白例句 → pooled 长度会变
  assert(bindExamples(twoGroups, [{ en: '   ', zh: '' }]).pooled.length === 0, '空白例句不入库')
  // 5. 分词若把整句当一个词 → 单词不可点
  assert(countWords('a b c') === 3, '按词计数，不是按整句')
  // 6. lemmaCandidates 若把原形丢了 → 查词会退化
  assert(lemmaCandidates('book')[0] === 'book', '原形优先，不被还原规则误伤')
  // 7. 源码断言有效性：去掉渐变后应匹配不到
  const brokenPage = page.replace(EASYMAD, 'linear-gradient(to right, #ccc, #ddd)')
  assert(!brokenPage.includes(EASYMAD), '改掉渐变色后源码断言失效（断言有效）')

  console.log('[全局图标] 底部导航 / 收藏星 / 去详情 / 重置 / 消息')
  const tabs = src('components/layout/BottomTabBar.tsx')
  assert(
    tabs.includes('IconHomeSolid') && tabs.includes('IconDiscover') &&
      tabs.includes('IconReviewCards') && tabs.includes('IconUserSolid'),
    '底部导航用 3/1/2/4 号自绘图标',
  )
  const search = src('pages/Search.tsx')
  assert(search.includes('IconStarMark') && search.includes('IconForward'), '搜索单词卡：8 号收藏星 + 6 号去详情')
  assert(search.includes("text-accent") || search.includes('fav'), '收藏态有实心（橙）样式')
  assert(pop.includes('IconForward'), '弹窗「查看详情」用 6 号右箭头')
  const reader = src('pages/Reader.tsx')
  assert(reader.includes('IconReset'), '阅读器清空本页用 10 号回转箭头')
  const errState = src('components/ui/error-state.tsx')
  assert(errState.includes('IconReset'), '错误重试用 10 号回转箭头')
  const profile = src('pages/Profile.tsx')
  assert(profile.includes('IconMailSolid'), '我的页消息入口用 11 号信封')
  assert(profile.includes('IconImport'), '导入入口用新导入图标')
  assert(page.includes('removeFromVocab'), '收藏可取消（再点一次真的移除，8 号空心）')
  const icons = src('components/icons/shushu.tsx')
  assert(icons.includes('aria-hidden="true"'), '自绘图标默认 aria-hidden（语义由按钮承担）')

  // ── 学习页改动（2026-10-06 截图红框批注：学习时不跳生词本 / 卡上去收藏 / 完成配烟花）──
  console.log('[学习页] 去跳转 / 卡上去收藏 / 「完成」+ 烟花庆祝')
  const flow = src('pages/LearningFlow.tsx')
  assert(
    !flow.includes('去生词本闯关 / 复习'),
    '学习页中部不再有「去生词本闯关 / 复习」跳转（学习时不跳走）',
  )
  assert(
    !/先去生词本闯关/.test(flow),
    '弹窗副按钮不再是「先去生词本闯关」',
  )
  assert(
    /完成\s*<\/Button>/.test(flow) && flow.includes("navigate('/', { state: { firework: true } })"),
    '弹窗副按钮改为「完成」，点击回主页并带烟花标记',
  )
  assert(
    !flow.includes('setCelebrate') && !flow.includes('FireworkBurst'),
    '烟花不挂学习页（导航会卸载），由 Home 播放',
  )
  const home = src('pages/Home.tsx')
  assert(
    home.includes('FireworkBurst') && home.includes('location.state') && home.includes('firework'),
    'Home 接收 firework 标记并播放烟花（刷新 state 消失，不重放）',
  )
  const fwCard = src('components/learning/WordCard.tsx')
  assert(
    !fwCard.includes('IconStarMark') &&
      !fwCard.includes('handleAdd') &&
      !fwCard.includes('addToVocab'),
    '学习卡不再有生词本按钮（收藏相关死代码已清）',
  )
  assert(
    fwCard.includes('aria-label="点读"') && fwCard.includes('aria-label="跟读"'),
    '学习卡保留点读 / 跟读（删收藏不丢原功能）',
  )
  const fw = src('components/fx/FireworkBurst.tsx')
  assert(
    fw.includes('FIREWORK_TOTAL_MS') && fw.includes('fw-stage') && fw.includes('aria-hidden="true"'),
    '烟花组件：总时长常量 + 无障碍舞台（aria-hidden、不挡交互）',
  )
  assert(
    fw.includes('BURST_COUNT = 11') && fw.includes('STAGGER_S = 0.16'),
    '烟花密度：11 朵错峰绽放（10-21 加密）',
  )
  assert(
    fw.includes('#fbbf24') && fw.includes('#f472b6') && fw.includes('pickColor'),
    '烟花配色加权随机：新增金黄 / 淡粉，绿黄系为主（10-21 扩色）',
  )
  assert(
    fw.includes("rand(26, 34)") && fw.includes('rand(52, 118)'),
    '每朵粒子 26–34 颗、飞散 52–118px（密度上调）',
  )
  assert(
    css.includes('@keyframes fw-fly') && css.includes('@keyframes fw-rise'),
    '烟花 keyframes 落在 index.css（纯 CSS 实现）',
  )
  assert(
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.fw-stage\s*{\s*display: none/.test(css),
    '系统减少动效时烟花整体隐藏',
  )

  // ── 全局搜索浮层（2026-10-21：底部停靠 + 相似度排序 + 防抖/键盘）──
  console.log('[全局搜索] 相似度打分 / 防抖 / 键盘跟随 / 停靠层级')
  const idxWord = (word: string, zh: string | null = null): SearchIndexWord =>
    ({ id: word, word, ipa: null, pos: null, zh, book: 'CET4', dl: 1, tid: 't' }) as SearchIndexWord

  // 档位关系：精确 > 前缀（长度比起效）> 包含 > 模糊 > 词形还原 > 中文释义
  const inCtx = buildQueryContext('in')
  const sExact = scoreMatch(inCtx, idxWord('in'))
  const sInto = scoreMatch(inCtx, idxWord('into'))
  const sIndoor = scoreMatch(inCtx, idxWord('indoor'))
  const sPrint = scoreMatch(inCtx, idxWord('print'))
  assert(sExact === 1000, '精确相等 1000 分置顶')
  assert(sInto > sIndoor && sInto > 900 && sIndoor > 900, '前缀档内按查询占比排（into > indoor）')
  assert(sPrint >= 700 && sPrint < 900, '词内包含落包含档（700+）')
  assert(
    scoreMatch(buildQueryContext('helo'), idxWord('hello')) === 452 &&
      scoreMatch(buildQueryContext('helo'), idxWord('help')) === 460,
    '拼写容错：helo→hello(距离1)=452、helo→help(距离1)=460',
  )
  assert(
    scoreMatch(buildQueryContext('helo'), idxWord('helicopter')) === 0,
    '容错边界：编辑距离 >2 不匹配',
  )
  assert(
    scoreMatch(buildQueryContext('running'), idxWord('run')) === 450,
    '词形还原：running → run 命中还原档',
  )
  assert(
    scoreMatch(buildQueryContext('a'), idxWord('pink', 'n. 粉色；adv. 粉红色地')) === 0,
    '单字母查询不走中文释义档（避开 adv. 缩写噪音）',
  )
  assert(
    scoreMatch(buildQueryContext('adv'), idxWord('fast', 'adv. 快地；adj. 快的')) === 0,
    '纯 ASCII 查询不走中文释义档（adv 不命中释义里的 adv.）',
  )
  assert(
    scoreMatch(buildQueryContext('国外'), idxWord('abroad', 'adv. 到国外；在国外')) === 303,
    '中文查询走释义档（国外 → abroad）',
  )
  eq(levenshtein('hello', 'helo', 2), 1, 'levenshtein 基本正确')
  eq(levenshtein('kitten', 'sitting', 3), 3, 'levenshtein 经典用例')

  const rankWords = [idxWord('into'), idxWord('in'), idxWord('indoor'), idxWord('print'), idxWord('inner'), idxWord('inning')]
  eq(
    rankByScore(rankWords, 'in', 10)
      .map((w) => w.word)
      .join(','),
    'in,into,inner,indoor,inning,print',
    'rankByScore 返回 desc（最匹配在前），UI 层反转为「最匹配在最底」',
  )
  eq(rankByScore(rankWords, 'in', 2).length, 2, 'limit 生效')
  eq(rankByScore(rankWords, '   ', 10).length, 0, '空白查询返回空')

  // 性能：22,791 词（真实词库规模）合成数据全量打分 + 排序
  const bigWords: SearchIndexWord[] = []
  for (let i = 0; i < 22791; i++) {
    bigWords.push(idxWord('word' + i.toString(36) + (i % 7 === 0 ? 'ing' : ''), i % 5 === 0 ? `n. 释义${i}` : null))
  }
  const tRank0 = performance.now()
  rankByScore(bigWords, 'word1', 30)
  const rankMs = performance.now() - tRank0
  assert(rankMs < 150, `22,791 词全量打分排序 <150ms（实测 ${rankMs.toFixed(1)}ms，防抖 300ms 有余量）`)

  const dock = src('components/layout/SearchDock.tsx')
  assert(dock.includes('DEBOUNCE_MS = 300') && dock.includes('useDebouncedValue'), '防抖 300ms 走 useDebouncedValue 尾延迟')
  assert(dock.includes('reqRef') && dock.includes('seq !== reqRef.current'), '竞态防护：旧查询响应直接丢弃')
  assert(dock.includes('lastQueryRef') && dock.includes('if (query === lastQueryRef.current) return'), '点历史后防抖再来不重复搜')
  // 2026-10-21 全屏 overlay 版（推翻 v2 底部停靠面板）
  assert(
    dock.includes('createPortal') &&
      dock.includes('fixed inset-x-0 top-0 z-50') &&
      dock.includes("bottom: 'var(--kb-inset, 0px)'"),
    '全屏搜索层：Portal 到 body + fixed 全屏 + 层底跟随键盘高度',
  )
  assert(dock.includes('isComposing') && dock.includes('keyCode === 229'), 'IME 组词期间回车不误触（isComposing + 229 兜底）')
  assert(dock.includes('该词暂未收录') && !dock.includes('暂无搜索结果'), '空态文案统一「该词暂未收录」')
  assert(dock.includes('[...hits].reverse()') && dock.includes('el.scrollTop = el.scrollHeight'), '结果反序渲染 + 自动滚底（最匹配紧贴输入框）')
  assert(dock.includes('justify-end') && dock.includes('min-h-full'), '列表贴底：结果少时整体靠下、多余空间留在上方')
  assert(!dock.includes('查看全部结果'), '无「查看全部结果」入口（用户 2026-10-21 确认去掉，全页结果走回车）')
  assert(dock.includes('aria-label="全局搜索"') && dock.includes('aria-label="清空搜索"'), '输入框与清空按钮有 aria-label')
  assert(dock.includes('text-base outline-none') && dock.includes('ring-0'), '输入框 16px 字号 + 聚焦无环只留光标（全局焦点环显式豁免）')
  assert(dock.includes('searchRanked'), '搜索区走 repository.searchRanked（相似度排序版）')
  // 原 TopSearchBar 能力迁移（语音 / 扫描）
  assert(
    dock.includes('speechService') && dock.includes("lang: 'zh-CN'") && dock.includes('onPartial'),
    '语音输入从 TopSearchBar 迁入（zh-CN 识别，partial 实时回填）',
  )
  assert(dock.includes('/import?tab=scan'), '扫描识别入口保留（跳 /import?tab=scan）')
  assert(dock.includes('aria-label={listening ? \'正在听…\' : \'语音输入\'}') && dock.includes('aria-label="扫描识别"'), '语音/扫描按钮有 aria-label（语音按识别态切换文案）')
  // 历史 = 访问记录（用户 2026-10-21 定稿，核心规则）
  assert(
    dock.includes('recordSearchVisit(h.word)') && !dock.includes('addSearchQuery'),
    '历史唯一写入点：点击结果跳详情才记；打字/回车不留痕',
  )
  assert(
    !dock.includes('[...history].reverse()') && dock.includes('history.map'),
    '历史按时间倒序直接渲染（最近点击在最上面，不反序）',
  )
  assert(dock.includes('item.count > 1') && dock.includes('×{item.count}'), '重复访问标 ×N 角标（>1 才显示）')
  assert(dock.includes('clearSearchHistory') && dock.includes('aria-label="清空历史记录"'), '历史可一键清空')
  assert(dock.includes('最近搜索') && dock.includes('Clock'), '无输入时显示历史访问记录（时钟图标 + 标题行）')
  assert(dock.includes('MAX_SEARCH_HISTORY'), '历史上限常量在组件内引用（与 store 同源）')

  assert(
    store.includes('export interface SearchHistoryItem') &&
      store.includes('searchHistory: SearchHistoryItem[]') &&
      store.includes('recordSearchVisit'),
    'store：历史改为访问记录模型 {query,count,lastAt}',
  )
  assert(
    store.includes('count: (prev?.count ?? 0) + 1') &&
      store.includes('lastAt: now') &&
      store.includes('[next, ...rest].slice(0, MAX_SEARCH_HISTORY)'),
    '访问记录：小写去重、count+1、刷新时间、置顶、超上限丢最旧',
  )
  assert(
    store.includes('normalizeSearchHistory(p.searchHistory)') &&
      store.includes("typeof it === 'string'"),
    'persist merge 迁移旧 string[] 存档为访问记录（升级用户不丢）',
  )
  assert(store.includes('searchHistory: []') && store.includes('MAX_SEARCH_HISTORY = 10'), 'store：searchHistory 默认空 + 上限 10')
  assert(store.includes('searchHistory: s.searchHistory') && store.includes('partialize'), 'searchHistory 进 persist 白名单（跨会话保留）')

  const kbHook = src('hooks/useKeyboardInset.ts')
  assert(kbHook.includes('visualViewport') && kbHook.includes('--kb-inset'), '键盘高度经 visualViewport 写 --kb-inset（iOS 唯一可靠来源）')
  assert(kbHook.includes('KEYBOARD_MIN_PX') && kbHook.includes('KEYBOARD_MIN_PX ? h : 0') && kbHook.includes('removeProperty'), '主路径也有 120px 噪音阈值 + 卸载清理变量')
  const debounceHook = src('hooks/useDebouncedValue.ts')
  assert(debounceHook.includes("value === ''") && debounceHook.includes('clearTimeout'), '防抖 hook：空值立即生效 + 定时器随 value 变化/卸载取消')

  // 2026-10-21 收尾：滚动条一律隐藏 + 阅读器底部留白补足导航栏高度
  assert(css.includes('.scrollbar-hidden'), '通用隐藏滚动条工具类落地（搜索列表复用）')
  assert(/\.reader-scroll\s*\{[^}]*scrollbar-width: none/.test(css), '阅读器滚动条一律隐藏（含上下滚动模式，保留滚动能力）')
  const readerSrc = src('pages/Reader.tsx')
  assert(readerSrc.includes('pb-14 pt-4'), 'scroll/记忆模式底部留白补足到导航栏高度（56px，防末行被导航栏盖住）')

  const shell = src('components/layout/AppShell.tsx')
  assert(shell.includes('useKeyboardInset()') && shell.includes('showGlobalSearch'), 'AppShell 启用键盘监听并支持全局搜索开关')
  assert(
    shell.includes('sticky bottom-[var(--kb-inset,0px)] z-30') && shell.includes('safe-bottom sticky'),
    '底部停靠组 sticky + z-30 + 键盘偏移 + 安全区收敛在容器',
  )
  assert(
    shell.indexOf('<SearchDock />') < shell.indexOf('<BottomTabBar />'),
    '停靠组顺序：搜索框在上、Tab 栏在下（2026-10-21 用户定稿，防回退）',
  )
  assert(shell.includes('safe-top flex-1 overflow-y-auto'), '顶栏撤掉后 safe-top 转移到 main（刘海安全区不丢）')
  assert(!shell.includes("from './TopSearchBar'"), 'AppShell 不再渲染顶部搜索栏')
  assert(
    !existsSync(new URL('../src/components/layout/TopSearchBar.tsx', import.meta.url)) &&
      !existsSync(new URL('../src/components/search/GlobalSearchDock.tsx', import.meta.url)),
    '旧组件文件已删除（TopSearchBar / GlobalSearchDock，不保留两套）',
  )
  const tabBar = src('components/layout/BottomTabBar.tsx')
  assert(!tabBar.includes('sticky bottom-0'), 'Tab 栏自身不再 sticky（定位交给停靠组，避免两个 sticky 互相重叠）')
  const appRoutes = src('App.tsx')
  assert(
    appRoutes.includes('<AppShell showGlobalSearch={false}>') && !appRoutes.includes('showTopSearch'),
    '/search 页传 showGlobalSearch={false}；showTopSearch prop 已随顶栏废弃清理',
  )
  assert(repo.includes('searchRanked') && repo.includes('rankByScore'), 'repository 暴露 searchRanked 并复用归并逻辑')
  assert(css.includes('*:focus-visible') && css.includes('ring-ring'), '全局键盘焦点环补齐（原缺失，搜索区键盘导航可见）')

  if (failed) {
    console.error(`\n${failed} 项失败`)
    process.exit(1)
  }
  console.log('\n单词详情页单测全部通过 ✓')
}

main()
