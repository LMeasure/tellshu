/**
 * DesktopTopBar 渲染单测 · jsdom 真实渲染（多端兼容 阶段1-A4）
 * ------------------------------------------------------------------
 * 覆盖：
 *   1. 顶部栏渲染，高度 56px（h-14）；
 *   2. 搜索确实以 <SearchDock variant="topbar" /> 使用（data-variant="topbar"）；
 *   3. 品牌入口指向真实路由 /（首页）；
 *   4. 右侧仅含真实可用功能（设置 → /settings），无无效按钮 / 虚构功能 / 死链接；
 *   5. 窄桌面下结构不溢出（受控 flex + min-w-0，几何宽度在 A5 接入后于 1024/1366 真机复验）。
 *
 * 运行：npx tsx scripts/test_desktop_topbar.ts
 */

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
  const { DesktopTopBar } = await import('../src/components/layout/DesktopTopBar')
  const { MemoryRouter } = await import('react-router-dom')
  const act = React.act

  const container = document.getElementById('root') as HTMLElement
  let root: { render: (el: React.ReactElement) => void; unmount: () => void } | null = null

  await act(async () => {
    root = createRoot(container)
    root.render(
      React.createElement(MemoryRouter, null, React.createElement(DesktopTopBar)),
    )
  })

  const text = () => container.textContent ?? ''
  const q = (sel: string) => container.querySelector(sel)
  const qa = (sel: string) => container.querySelectorAll(sel)

  console.log('\n▶ 1. 渲染与高度')
  check('顶部栏 <header> 渲染', !!q('header'))
  check('高度为 56px（含 h-14 类）', /(^|\s)h-14(\s|$)/.test(q('header')?.className ?? ''),
    q('header')?.className ?? '')
  check('宽度占满（w-full）', /(^|\s)w-full(\s|$)/.test(q('header')?.className ?? ''))

  console.log('\n▶ 2. 搜索使用 topbar 模式')
  check('内嵌 SearchDock 为 topbar 模式（data-variant="topbar"）', !!q('[data-variant="topbar"]'))
  check('搜索入口按钮存在（aria-label="打开全局搜索"）', !!q('[aria-label="打开全局搜索"]'))

  console.log('\n▶ 3. 品牌入口指向真实路由')
  const brand = q('a[aria-label="述树首页"]') as HTMLAnchorElement | null
  check('品牌入口为链接且 href="/"', !!brand && brand.getAttribute('href') === '/',
    brand?.getAttribute('href') ?? 'null')
  check('品牌含真实品牌资产（Leaf 图标 + 述树 文字）', /述树/.test(text()))

  console.log('\n▶ 4. 右侧仅真实可用功能，无无效按钮')
  const anchors = qa('a')
  // 唯一锚点应为品牌首页（设置用 button 跳转，非死链锚点）
  check('锚点仅品牌首页一个（无死链 / # / 空 href）', anchors.length === 1 &&
    anchors[0].getAttribute('href') === '/', `anchors=${anchors.length}`)
  const settingsBtn = q('button[aria-label="设置"]') as HTMLButtonElement | null
  check('设置按钮存在且为真实功能（aria-label / title 完整）',
    !!settingsBtn && settingsBtn.getAttribute('title') === '设置')
  // 不得出现「敬请期待 / 即将上线 / TODO」之类的占位文本或 button[disabled] 占位
  check('无占位 / 虚构功能文本', !/敬请期待|即将上线|coming soon|TODO|未接入|敬请/i.test(text()))
  check('右侧无 disabled 占位按钮', qa('button[disabled]').length === 0)

  console.log('\n▶ 5. 布局不溢出（受控 flex）')
  check('顶部栏为 flex 布局', /(^|\s)flex(\s|$)/.test(q('header')?.className ?? ''))
  check('搜索区可收缩（含 min-w-0）', /min-w-0/.test(container.innerHTML))
  check('品牌与设置区 shrink-0（不被挤压）',
    /shrink-0/.test(container.innerHTML))

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
