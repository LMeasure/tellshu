/**
 * 学习卡（WordCard）渲染单测 · jsdom 真实渲染
 * ------------------------------------------------------------------
 * 覆盖 2026-10-31 的释义规则：
 *   1. **核心中文释义始终可见** —— 不因「中文辅助」开关关闭而消失
 *      （旧行为：整段释义被 chineseAssist 门控，关掉就是空白；
 *       而本词包 definition_en 100% 为空，根本没有英文兜底）
 *   2. **中文辅助只管额外辅助** —— 例句的中文翻译、助记提示（💡）
 *   3. **排版（本次）**：同一词性下的多个释义必须用中文分号「；」连成同一行；
 *      不同词性之间换行；词性标签固定列宽、释义左边缘对齐；不拆成多个 <li>、
 *      不丢失括号/特殊符号、不改原始顺序。仅改 WordCard，不动 parseDefinitionZh / WordDetail。
 * 顺带回归：多词性分列、多义项不丢、词根词缀 / 词源保留、无释义有明确提示。
 *
 * 与 test_word_learning.ts 的分工：
 *   那边测「进度持久化（纯逻辑 + 存储）」，这边测「卡片渲染（DOM）」。
 *
 * 运行：npx tsx scripts/test_word_card.ts
 */

/* fake-indexeddb 必须在 jsdom 的 window 定义之前导入（同 test_spelling_ui.ts 的坑） */
import 'fake-indexeddb/auto'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})

for (const key of [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'HTMLInputElement',
  'Element',
  'Node',
  'getComputedStyle',
  'localStorage',
  'requestAnimationFrame',
  'cancelAnimationFrame',
] as const) {
  Object.defineProperty(globalThis, key, {
    value: (dom.window as unknown as Record<string, unknown>)[key],
    configurable: true,
    writable: true,
  })
}
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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

async function main(): Promise<void> {
  const React = (await import('react')).default
  const { createRoot } = await import('react-dom/client')
  const { WordCard } = await import('../src/components/learning/WordCard')
  const { MemoryRouter } = await import('react-router-dom')
  const { useAppStore } = await import('../src/store/useAppStore')
  const act = React.act

  const container = document.getElementById('root') as HTMLElement
  let root: { render: (el: React.ReactElement) => void; unmount: () => void } | null = null

  /** 真实词条（取自 data/linguabase/v1/books/CET4.json，字段照抄未加工） */
  const BY = {
    id: 'oe-by',
    word: 'by',
    ipa: 'baɪ',
    definition_zh:
      'prep. 在...旁边；通过（某种方式）；由（某人完成）；到（某时）之前；adv. 经过；附近；搁置',
    definition_en: null,
    pos: 'prep.',
    word_hint: 'by 旁边 → 经由旁边 → 通过',
    morphemes: [{ form: 'by', meaning: '旁边；附近', note: null }],
    etymology: '源自古英语 bi / be-（在…附近）。',
    examples: [{ en: 'She stood by the window.', zh: '她站在窗边。' }],
    difficulty_level: 2,
    topic_id: 'CET4',
    book: 'CET4',
  } as never

  async function render(word: unknown) {
    if (root) {
      await act(async () => {
        root!.unmount()
      })
    }
    root = createRoot(container)
    await act(async () => {
      root!.render(
        React.createElement(MemoryRouter, null, React.createElement(WordCard, { word })),
      )
    })
  }

  /** 开关要包在 act 里改，否则 store 更新会触发 React 的 act 警告 */
  async function setAssist(on: boolean) {
    await act(async () => {
      useAppStore.getState().setSetting('chineseAssist', on)
    })
  }

  const q = (sel: string) => container.querySelectorAll(sel)
  /** 每个词性组一条释义行（同词性多义项用 ； 连在同一行，不再拆成多个 <li>） */
  const senseLines = () => Array.from(q('[data-testid="word-sense-line"]')).map((n) => n.textContent ?? '')
  /** 旧结构的逐条 <li> 不应再出现 */
  const senseLis = () => q('[data-testid="word-senses"] li').length
  const senseGroups = () => q('[data-testid="word-senses"] > div').length
  const text = () => container.textContent ?? ''

  /* ---------------- 1. 中文辅助「开」 ---------------- */
  console.log('\n▶ 1. 中文辅助开启')
  await setAssist(true)
  await render(BY)
  const linesOn = senseLines()
  check('释义渲染出来（2 个词性组各一行）', senseGroups() === 2 && linesOn.length === 2,
    `分组 ${senseGroups()} 行 ${linesOn.length}`)
  check('🔴 同词性多义项在同一行、用中文分号连接（不拆 li）',
    linesOn[0] === '在...旁边；通过（某种方式）；由（某人完成）；到（某时）之前' &&
    linesOn[1] === '经过；附近；搁置' && senseLis() === 0,
    `行0=${linesOn[0]} 行1=${linesOn[1]} li=${senseLis()}`)
  check('保留括号与特殊符号（如「通过（某种方式）」）',
    /通过（某种方式）/.test(linesOn[0]) && /在\.\.\.旁边/.test(linesOn[0]), '')
  check('首义项与末义项都在、未丢失', /在\.\.\.旁边/.test(text()) && /搁置/.test(text()), '')
  check('例句中文翻译可见', q('[data-testid="example-zh"]').length === 1, '')
  check('助记提示可见', q('[data-testid="word-hint"]').length === 1, '')
  check('词根词缀保留', /词根词缀/.test(text()), '')
  check('词源保留', /古英语/.test(text()), '')

  /* ---------------- 2. 中文辅助「关」：核心释义必须还在 ---------------- */
  console.log('\n▶ 2. 中文辅助关闭（核心释义仍可见）')
  await setAssist(false)
  await render(BY)
  const linesOff = senseLines()
  check('🔴 核心中文释义**仍然显示**（不因开关消失）', linesOff.length === 2 && senseLis() === 0,
    `行 ${linesOff.length} li=${senseLis()}`)
  check('同词性解析仍连在同一行、用 ； 连接',
    linesOff[0] === '在...旁边；通过（某种方式）；由（某人完成）；到（某时）之前' &&
    linesOff[1] === '经过；附近；搁置', `行0=${linesOff[0]}`)
  check('词性分组仍在', senseGroups() === 2, `分组 ${senseGroups()}`)
  check('不再出现「已按设置隐藏中文释义」这类空提示', q('[data-testid="word-senses-empty"]').length === 0, '')
  check('例句中文翻译常驻显示（不受开关控制）', q('[data-testid="example-zh"]').length === 1, '')
  check('例句英文仍在', /She stood by the window\./.test(text()), '')
  check('例句标题始终为「双语例句」', /双语例句（1）/.test(text()), '')
  check('助记提示收起（辅助项）', q('[data-testid="word-hint"]').length === 0, '')
  check('词根词缀 / 词源不受开关影响', /词根词缀/.test(text()) && /古英语/.test(text()), '')

  /* ---------------- 3. 无释义数据：明确提示，不空白 ---------------- */
  console.log('\n▶ 3. 无释义数据')
  const NO_DEF = { ...BY, definition_zh: '', definition_en: null, word_hint: null } as never
  await render(NO_DEF)
  check('显示明确提示而不是空白', q('[data-testid="word-senses-empty"]').length === 1,
    container.querySelector('[data-testid="word-senses-empty"]')?.textContent ?? '')
  check('提示文案为「该词暂未收录释义。」',
    /该词暂未收录释义/.test(text()), '')

  console.log('\n▶ 4. 开关恢复后回到双语')
  await setAssist(true)
  await render(BY)
  check('例句中文翻译回来了', q('[data-testid="example-zh"]').length === 1, '')
  check('核心释义依旧按词性分 2 行、用 ； 连接', senseLines().length === 2 &&
    senseLines()[0] === '在...旁边；通过（某种方式）；由（某人完成）；到（某时）之前', '')

  /* ---------------- 5. 例句单词可点查词（本轮新增） ---------------- */
  console.log('\n▶ 5. 例句单词可点查词')
  await setAssist(true)
  await render(BY)
  const exEn = q('[data-testid="example-en"]')[0]
  const wordBtns = exEn.querySelectorAll('button')
  check('例句英文拆成可点单词按钮（5 词 + 标点非按钮）', wordBtns.length === 5,
    `按钮数=${wordBtns.length}`)
  check('标点 / 空格不可点（句点 "." 不是按钮）',
    !Array.from(wordBtns).some((b) => b.textContent === '.'), '')
  // 点 "by" 弹查词小窗
  const byBtn = Array.from(wordBtns).find((b) => b.textContent === 'by') as HTMLButtonElement
  await act(async () => {
    byBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 0))
  })
  check('点击单词弹出查词小窗（含「查看详情」入口）', /查看详情/.test(text()), '')
  // 点外部遮罩关闭
  await act(async () => {
    const overlay = container.querySelector('.fixed.inset-0')
    if (overlay) overlay.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true }))
  })
  check('点外部遮罩关闭弹窗', !/查看详情/.test(text()), '')

  if (root) {
    await act(async () => {
      root!.unmount()
    })
  }

  console.log(`\n${'─'.repeat(52)}`)
  console.log(`通过 ${passed} 项，失败 ${failed} 项`)
  if (failed > 0) {
    console.error('\n失败清单：')
    for (const f of failures) console.error(`  · ${f}`)
    process.exit(1)
  }
}

void main()
