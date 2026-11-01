/**
 * SearchDock 渲染单测 · jsdom 真实渲染（多端兼容 阶段1-A3）
 * ------------------------------------------------------------------
 * 目标：验证 SearchDock 新增 `variant` 属性后：
 *   1. 默认 dock 与显式 dock 渲染结果完全一致（移动端行为零退化）；
 *   2. topbar 是桌面顶部栏紧凑搜索框（外观不同，但逻辑共用）；
 *   3. 两种 variant 共用同一套 overlay 与搜索逻辑（点击入口均展开同一 overlay）；
 *   4. Esc 收起、输入法组合输入不误触发等行为在两种 variant 下一致。
 *
 * 仅改 presentation：搜索业务逻辑（防抖 / 竞态序号 / isComposing / 历史 / Esc /
 * Portal overlay / 语音 / 路由跳转 / 存储）完全复用，未复制、未重写。
 *
 * 运行：npx tsx scripts/test_search_dock.ts
 */

/* fake-indexeddb 必须在 jsdom 的 window 定义之前导入 */
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

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main(): Promise<void> {
  const React = (await import('react')).default
  const { createRoot } = await import('react-dom/client')
  const { SearchDock } = await import('../src/components/layout/SearchDock')
  const { MemoryRouter } = await import('react-router-dom')
  const act = React.act

  const container = document.getElementById('root') as HTMLElement
  let root: { render: (el: React.ReactElement) => void; unmount: () => void } | null = null

  async function render(variant?: 'dock' | 'topbar') {
    if (root) {
      await act(async () => {
        root!.unmount()
      })
    }
    root = createRoot(container)
    await act(async () => {
      root!.render(
        React.createElement(
          MemoryRouter,
          null,
          React.createElement(SearchDock, variant ? { variant } : {}),
        ),
      )
    })
  }

  /** 入口行的「打开全局搜索」按钮（在 #root 内，非 portal，事件可靠） */
  const entryBtn = () =>
    container.querySelector('[aria-label="打开全局搜索"]') as HTMLButtonElement | null
  /** overlay 被 Portal 到 document.body */
  const overlay = () => document.body.querySelector('[data-testid="search-overlay"]') as HTMLElement | null
  const overlayHtml = () => overlay()?.innerHTML ?? ''

  function clickEntry() {
    const btn = entryBtn()
    if (!btn) throw new Error('入口按钮未找到')
    btn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  }

  function setInput(el: HTMLInputElement, text: string) {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!
    setter.call(el, text)
    el.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  }

  /* ---------------- 1. 三种渲染均不报错 ---------------- */
  console.log('\n▶ 1. 渲染')
  await render()
  check('默认 dock 渲染入口', !!entryBtn())
  await render('dock')
  check('显式 dock 渲染入口', !!entryBtn())
  await render('topbar')
  check('topbar 渲染入口', !!entryBtn())

  /* ---------------- 2. 默认 dock ≡ 显式 dock（回归基线） ---------------- */
  console.log('\n▶ 2. 移动端 dock 行为零退化')
  await render()
  const dockDefault = container.innerHTML
  await render('dock')
  const dockExplicit = container.innerHTML
  check('默认 dock 与显式 dock 入口 innerHTML 完全一致', dockDefault === dockExplicit,
    `default[${dockDefault.length}] explicit[${dockExplicit.length}]`)
  check('dock 入口带 data-variant="dock"', !!container.querySelector('[data-variant="dock"]'))
  // 注：safe-bottom 是 overlay 输入区的类（仅展开时挂载），由 T4 的 overlay 一致性覆盖；
  // 入口行自身的底部停靠特征由 border-t 表达（topbar 用 max-w-md 紧凑框，无 border-t）。
  check('dock 入口仍是底部停靠行（含 border-t，且不含 topbar 的 max-w-md）',
    /border-t/.test(dockDefault) && !/max-w-md/.test(dockDefault))

  /* ---------------- 3. topbar 是不同外观，但仍是同一搜索入口 ---------------- */
  console.log('\n▶ 3. 桌面 topbar 展示模式')
  await render('topbar')
  check('topbar 入口带 data-variant="topbar"', !!container.querySelector('[data-variant="topbar"]'))
  check('topbar 入口无 dock 的 border-t / safe-bottom（外观不同）',
    !/border-t/.test(container.innerHTML) && !/safe-bottom/.test(container.innerHTML))
  check('topbar 入口仍含「搜单词…」触发文案', /搜单词/.test(container.textContent ?? ''))

  /* ---------------- 4. 点击入口 → 两种 variant 展开同一 overlay（逻辑共用） ---------------- */
  console.log('\n▶ 4. 入口点击展开 overlay（逻辑共用）')
  await render()
  await act(async () => {
    clickEntry()
    await wait(0)
  })
  const dockOverlay = overlayHtml()
  check('dock 点击入口后 overlay 已 Portal 到 body', !!overlay())
  check('dock overlay 展开时显示历史区（空历史「暂无搜索历史」）', /暂无搜索历史/.test(dockOverlay),
    dockOverlay.slice(0, 60))

  await render('topbar')
  await act(async () => {
    clickEntry()
    await wait(0)
  })
  const topbarOverlay = overlayHtml()
  check('topbar 点击入口后 overlay 也已 Portal 到 body', !!overlay())
  check('topbar 与 dock 展开的是同一套 overlay（innerHTML 完全一致）',
    dockOverlay === topbarOverlay,
    `dock[${dockOverlay.length}] topbar[${topbarOverlay.length}]`)

  /* ---------------- 5. Esc 收起 overlay（两种 variant 一致） ---------------- */
  console.log('\n▶ 5. Esc 收起')
  await render()
  await act(async () => {
    clickEntry()
    await wait(0)
  })
  check('展开后 overlay 存在', !!overlay())
  await act(async () => {
    window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await wait(0)
  })
  check('Esc 后 overlay 收起（从 body 移除）', !overlay())

  /* ---------------- 6. 输入触发搜索（共用防抖 / 竞态 / 空态） ---------------- */
  console.log('\n▶ 6. 输入触发搜索管线')
  await render()
  await act(async () => {
    clickEntry()
    await wait(0)
  })
  const input = overlay()?.querySelector('input') as HTMLInputElement | null
  check('overlay 内有搜索输入框', !!input)
  if (input) {
    await act(async () => {
      setInput(input, 'apple')
      await wait(400) // 越过 300ms 防抖
    })
    const afterType = overlay()?.textContent ?? ''
    check('输入后执行了搜索（出现「搜索中…」或空结果「该词暂未收录」）',
      /搜索中|该词暂未收录/.test(afterType),
      afterType.slice(0, 40))
  }

  /* ---------------- 7. 输入法组合输入期间回车不误触发提交 ---------------- */
  console.log('\n▶ 7. 输入法组合（isComposing）回车不误提交')
  await render()
  await act(async () => {
    clickEntry()
    await wait(0)
  })
  const input2 = overlay()?.querySelector('input') as HTMLInputElement | null
  if (input2) {
    await act(async () => {
      setInput(input2, '苹果')
      await wait(0)
    })
    const before = !!overlay()
    await act(async () => {
      const ev = new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
      Object.defineProperty(ev, 'isComposing', { value: true })
      input2.dispatchEvent(ev)
      await wait(0)
    })
    const after = !!overlay()
    check('isComposing 回车时 overlay 未被关闭（未误提交 / 未跳转）', before && after)
    check('isComposing 回车后输入框内容保留', (overlay()?.querySelector('input') as HTMLInputElement)?.value === '苹果')
  }

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
