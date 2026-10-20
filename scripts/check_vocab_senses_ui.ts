/**
 * 同词形多义项展开 · UI 验收脚本（M3 遗留回填 2026-10-20）
 * ------------------------------------------------------------------
 * 目的：对 commit 4f90b5e 的 VocabCard 重写做**真实 DOM 渲染**验收
 * （不是类型检查、不是纯逻辑单测的替代声明）。
 *
 * 能力边界（如实声明）：
 *   · 用 jsdom 渲染真实 React 组件树（StudyNotePanel 原样导入），
 *     DOM 结构 / 文本 / 顺序 / 徽标 / 三态均可断言；
 *   · jsdom **无布局引擎**：像素级视觉（重叠、溢出、遮挡、视口
 *     自适应）无法在此断言——相关项记为未覆盖，不以任何措辞冒充；
 *   · 词库夹具照抄 PG shutree.entries 真实行（ABC 双词条 / a /
 *     abate），词条内容非虚构。
 *
 * 运行：npx tsx scripts/check_vocab_senses_ui.ts
 */

/* 1. jsdom 全局必须在任何 React / storage 模块加载前就位 */
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})

for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'getComputedStyle'] as const) {
  Object.defineProperty(globalThis, key, {
    value: (dom.window as unknown as Record<string, unknown>)[key],
    configurable: true,
    writable: true,
  })
}
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { setTimeout as sleep } from 'node:timers/promises'

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1
    console.log(`  ✓ ${name}${detail ? `  ${detail}` : ''}`)
  } else {
    failed += 1
    failures.push(name)
    console.log(`  ✗ ${name}${detail ? `  ${detail}` : ''}`)
  }
}

interface SeedSpec {
  word: string
  pos: string
  phonetic: string | null
  definition_en: string
  definition_zh: string
  examples: Array<{ en: string; zh: string | null }>
}

function fromSpec(spec: SeedSpec): Record<string, unknown> {
  return {
    key: `${spec.word.toLowerCase()}|${spec.pos.toLowerCase()}`,
    id: `id-${spec.word.toLowerCase()}-${spec.pos}`,
    word: spec.word,
    word_lower: spec.word.toLowerCase(),
    phonetic: spec.phonetic,
    pos: spec.pos,
    definition_en: spec.definition_en,
    definition_zh: spec.definition_zh,
    senses: [],
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

/** PG shutree.entries 真实行（2026-10-20 实测照抄） */
const REAL_SEEDS: SeedSpec[] = [
  {
    word: 'ABC',
    pos: 'noun',
    phonetic: 'ier bi: si:',
    definition_en: 'the alphabet(as taught to children)',
    definition_zh: '教给儿童的 字母（表） 基础知识 人门： 烹饪入门课',
    examples: [],
  },
  {
    word: 'ABC',
    pos: 'abbreviation',
    phonetic: 'ier bi: si:',
    definition_en: 'American Broadcasting Company an American-born Chinese',
    definition_zh: '美国广播公司 出生在美国的华人',
    examples: [],
  },
  {
    word: 'abate',
    pos: 'verb',
    phonetic: "ə'bert",
    definition_en: '(of floods, storms,sounds,pain,etc.)to become less strong; to decrease',
    definition_zh: '（洪水、暴风雨、声音、病痛等）减少，减轻，减退 废除，撤销： 撤销诉讼',
    examples: [{ en: 'The storm abated at last.', zh: '暴风雨终于减弱了。' }],
  },
  {
    word: 'a',
    pos: 'article',
    phonetic: ',er',
    definition_en: 'one( ) ( )',
    definition_zh: '不定冠词，非特指 一 个、支、只、张、架、台、本等 ： 某一群体中的一员',
    examples: [
      { en: 'She has an apple and a pear.', zh: '她有一个苹果和一个梨。' },
      { en: 'He is a teacher.', zh: '他是老师。' },
    ],
  },
]

const TRANSCRIPT = {
  id: 'job-ui-1',
  language: 'en' as const,
  duration: 6,
  segments: [
    { start: 0, end: 3, text: 'The ABC of cooking' },
    { start: 3, end: 6, text: 'the storm abated' },
  ],
}

function vocabCardTexts(container: HTMLElement): { word: string; body: string }[] {
  return Array.from(container.querySelectorAll('li'))
    .filter((li) => li.className.includes('rounded-lg')) // 词汇卡容器特征（bilingual/key_points 的 li 无此 class）
    .map((li) => {
      const head = li.querySelector('span, button')?.textContent ?? ''
      return { word: head, body: li.textContent ?? '' }
    })
}

async function main(): Promise<void> {
  /* 2. 依赖按序加载（fake-indexeddb 先于 storage，jsdom 先于 React） */
  await import('fake-indexeddb/auto')
  const { storage } = await import('../src/services/storage')
  const React = (await import('react')).default
  const { createRoot } = await import('react-dom/client')
  const { StudyNotePanel } = await import('../src/components/transcript/StudyNotePanel')
  const { upsertStudyNote } = await import('../src/domain/transcript/store')
  const act = React.act

  /* 3. 种子词库 + 学习稿（studyNotes 记录含 dict_key，模拟真实落库态） */
  await storage.clearAll()
  await storage.table('dictEntries').bulkPut(REAL_SEEDS.map(fromSpec))
  await upsertStudyNote({
    transcript_id: TRANSCRIPT.id,
    summary: 'UI 验收用学习稿。',
    bilingual_notes: [{ en: 'The ABC of cooking', zh: '烹饪入门' }],
    key_points: ['多义项展示'],
    vocabulary: [
      { word: 'ABC', pos: 'noun', gloss: '（AI）入门知识', dict_key: 'abc|noun' },
      { word: 'abating', pos: 'verb', gloss: '（AI）减弱中', dict_key: 'abate|verb' },
      { word: 'a', pos: 'article', gloss: '（AI）一个', dict_key: 'a|article' },
      { word: 'unknownword', pos: 'noun', gloss: '（AI）不存在的词' },
      // 全缺失场景：词形段 zzqq 在词库不存在（区别于「部分缺失」——
      // dict_key 词形段能解析出真实词形时，按设计如实呈现现存词条）
      { word: 'goneword', pos: 'noun', gloss: '（AI）词库缺失场景', dict_key: 'zzqq|noun' },
    ],
    status: 'ready',
    source: 'ai_generated',
  } as Parameters<typeof upsertStudyNote>[0])

  const container = document.getElementById('root') as HTMLElement
  const root = createRoot(container)
  const seekCalls: number[] = []

  await act(async () => {
    root.render(
      React.createElement(StudyNotePanel, {
        transcript: TRANSCRIPT,
        onSeek: (s: number) => seekCalls.push(s),
      }),
    )
  })
  await act(async () => {
    await sleep(60) // 等 VocabCard 的异步补查 + isInVocab
  })

  /* 4. 场景断言 */
  console.log('场景 1 · 多义项词汇卡（真实 ABC 双词条）')
  const cards = vocabCardTexts(container)
  const abcCard = cards.find((c) => c.word.includes('ABC'))
  check('ABC 卡片渲染', abcCard !== undefined)
  if (abcCard) {
    check('noun 义项释义在 DOM', abcCard.body.includes('教给儿童的'), '「教给儿童的 字母（表）…」')
    check('abbreviation 义项释义在 DOM', abcCard.body.includes('美国广播公司'), '「美国广播公司 出生在美国的华人」')
    const nounIdx = abcCard.body.indexOf('教给儿童的')
    const abbrIdx = abcCard.body.indexOf('美国广播公司')
    check('LLM pos=noun 匹配项排最前', nounIdx < abbrIdx, `noun@${nounIdx} < abbr@${abbrIdx}`)
    check('展示词库原始词形（大写 ABC）', abcCard.word.trim() === 'ABC', `word=${abcCard.word.trim()}`)
    check('pos 标签并列可辨（noun/abbreviation）', abcCard.body.includes('noun') && abcCard.body.includes('abbreviation'))
    check('AI 语境补充与词典释义分区标注', abcCard.body.includes('AI 语境补充'))
    check('音标字段保留', abcCard.body.includes('ier bi: si:'))
    check('「词库」徽标（命中）', abcCard.body.includes('词库'))
  }

  console.log('场景 2 · 单义项词汇卡（真实 abate 词条，行为不回归）')
  const abateCard = cards.find((c) => c.word.includes('abating'))
  check('abating 卡片渲染', abateCard !== undefined)
  if (abateCard) {
    check('还原命中 abate 释义', abateCard.body.includes('减少，减轻，减退'))
    check('例句保留', abateCard.body.includes('The storm abated at last.'))
    check('音标保留', abateCard.body.includes("ə'bert"))
  }

  console.log('场景 3 · 无匹配兜底（AI 生成）')
  const unknownCard = cards.find((c) => c.word.includes('unknownword'))
  check('未命中词卡渲染', unknownCard !== undefined)
  if (unknownCard) {
    check('AI gloss 直接展示', unknownCard.body.includes('（AI）不存在的词'))
    check('徽标为 AI 生成', unknownCard.body.includes('AI 生成'))
    check('不显示词典分区（无 AI 语境补充段）', !unknownCard.body.includes('AI 语境补充'))
  }

  console.log('场景 4 · 词库缺失降级（dict_key 指向已删词条）')
  const missingCard = cards.find((c) => c.word.includes('goneword'))
  check('缺失词卡渲染', missingCard !== undefined)
  if (missingCard) {
    check('明示词库缺失', missingCard.body.includes('本地词库查不到该词条'))
    check('不永久骨架屏（有正文文本）', missingCard.body.includes('（AI）词库缺失场景'))
    check('缺失时徽标回落 AI 生成', missingCard.body.includes('AI 生成'))
    check('AI gloss 保留', missingCard.body.includes('（AI）词库缺失场景'))
  }

  console.log('场景 5 · 长释义完整渲染（不截断）')
  const aCard = cards.find((c) => c.word.includes('a') && c.body.includes('不定冠词'))
  if (aCard) {
    check(
      '长definition_zh 全文入 DOM',
      aCard.body.includes('架、台、本等 ： 某一群体中的一员'),
      '长文本尾部在场',
    )
  } else {
    check('a 卡片渲染', false)
  }

  console.log('场景 6 · 词汇总数与卡片一一对应')
  check('5 个词汇卡全部渲染', cards.length === 5, `实际 ${cards.length}`)

  /* 5. 结构层面（非像素）：容器 class 与源码一致，无内联样式兜底 */
  console.log('场景 7 · 容器结构（jsdom 无布局引擎，像素级视觉未覆盖）')
  const firstLi = Array.from(container.querySelectorAll('li')).find((li) =>
    li.className.includes('rounded-lg'),
  )
  check('卡片容器 class 与源码一致', (firstLi?.className ?? '').includes('rounded-lg'), firstLi?.className ?? '')

  await act(async () => {
    root.unmount()
  })

  console.log('')
  if (failed > 0) {
    console.error(`${failed} 项失败：${failures.join(' / ')}`)
    process.exit(1)
  }
  console.log(`UI 验收通过（${passed} 项）✓`)
  console.log('未覆盖声明：jsdom 无布局引擎——重叠/溢出/遮挡/移动端视口自适应未经渲染验证；')
  console.log('词库内容为 PG 真实行照抄，非生产运行数据（生产量取决于用户同步）。')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
