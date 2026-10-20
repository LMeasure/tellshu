/**
 * 书籍语义检索面板 · UI 验收脚本（M4 之后接入 2026-10-20）
 * ------------------------------------------------------------------
 * 目的：对 BookSearchPanel（Discover 页「找书」Tab）做**真实 DOM 渲染**
 * 验收——不是类型检查、不是逻辑单测的替代声明。
 *
 * 能力边界（如实声明）：
 *   · 用 jsdom 渲染真实 React 组件树（BookSearchPanel 原样导入），
 *     输入 / 禁用 / 四态（idle·loading·done·empty·error）/ 请求参数 /
 *     顶掉旧请求 / 离线提示均可断言；
 *   · jsdom **无布局引擎**：像素级视觉（重叠、溢出、遮挡、视口
 *     自适应）无法在此断言——相关项记为未覆盖，不以任何措辞冒充；
 *   · 检索响应夹具照抄 M4 验收实测响应（Crime and Punishment 片段），
 *     字段形态与 api/main.py 契约一致，非虚构数据。
 *
 * 运行：npx tsx scripts/check_book_search_ui.ts
 */

/* 1. jsdom 全局必须在任何 React / 领域模块加载前就位 */
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

/** M4 验收实测响应夹具（字段逐字对照 api/main.py 契约） */
function okResponse(results: unknown[]) {
  return {
    results,
    latency: { encode_ms: 19.31, retrieve_ms: 8.61, e2e_ms: 27.86 },
    meta: {
      top_k: 10,
      returned: results.length,
      ef_search: '800',
      iterative_scan: 'strict_order',
      include_front_matter: false,
      explain_sampled: false,
      sampled_plan_type: null,
    },
  }
}

const REAL_CHUNK = {
  chunk_id: 101,
  book_id: '7',
  title: 'Crime and Punishment',
  author: 'Fyodor Dostoyevsky',
  chapter_title: 'PART I',
  chunk_index: 12,
  content:
    'Raskolnikov continued to sit in his corner, plunged in revery. The summer was drawing to a close, and the heat was still intense.',
  similarity: undefined as unknown as number,
  score: 0.587612,
}

type FetchCall = { url: string; method: string; body: { query?: string; top_k?: number }; signal: AbortSignal | null }
let fetchCalls: FetchCall[] = []
let responder: () => Promise<{ ok: boolean; status: number; body: unknown }> = async () => ({
  ok: true,
  status: 200,
  body: {},
})

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  let body: { query?: string; top_k?: number } = {}
  if (typeof init?.body === 'string') {
    try {
      body = JSON.parse(init.body)
    } catch {
      body = {}
    }
  }
  fetchCalls.push({
    url: typeof input === 'string' ? input : String(input),
    method: init?.method ?? 'GET',
    body,
    signal: init?.signal ?? null,
  })
  const r = await responder()
  return {
    ok: r.ok,
    status: r.status,
    text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)),
  } as unknown as Response
}) as typeof fetch

/** React 受控输入：必须走原生 value setter，否则 React 的值追踪器收不到变化 */
function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
}

function click(el: Element): void {
  el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
}

async function main(): Promise<void> {
  /* 2. 依赖按序加载（jsdom 先于 React） */
  const React = (await import('react')).default
  const { createRoot } = await import('react-dom/client')
  const { BookSearchPanel } = await import('../src/components/discover/BookSearchPanel')
  const act = React.act

  const container = document.getElementById('root') as HTMLElement
  const root = createRoot(container)

  function inputOf(): HTMLInputElement {
    return container.querySelector('input') as HTMLInputElement
  }
  function buttonOf(): HTMLButtonElement {
    return Array.from(container.querySelectorAll('button')).find((b) =>
      (b.textContent ?? '').includes('搜索'),
    ) as HTMLButtonElement
  }
  function bodyText(): string {
    return container.textContent ?? ''
  }

  /* ---- 场景 1：idle 态 ---- */
  console.log('场景 1 · idle 初始态（未搜索）')
  await act(async () => {
    root.render(React.createElement(BookSearchPanel))
  })
  check('idle 引导文案', bodyText().includes('描述情节，找一本想读的书'))
  check('输入框 placeholder（中文示例）', inputOf().placeholder.includes('为爱复仇的贵族青年'))
  check('输入框 maxLength=500（服务端口径）', inputOf().maxLength === 500, `实际 ${inputOf().maxLength}`)
  check('空 query 搜索按钮禁用', buttonOf().disabled === true)
  check('未发起请求', fetchCalls.length === 0, `实际 ${fetchCalls.length}`)

  /* ---- 场景 2：输入 → 提交 → 请求参数 ---- */
  console.log('场景 2 · 输入与提交（请求参数）')
  responder = async () => ({ ok: true, status: 200, body: okResponse([REAL_CHUNK]) })
  await act(async () => {
    setInputValue(inputOf(), '为爱复仇的贵族青年')
  })
  check('输入后按钮启用', buttonOf().disabled === false)
  await act(async () => {
    click(buttonOf())
  })
  check(
    'POST /api/discover（同源相对路径）',
    fetchCalls[0]?.url === '/api/discover' && fetchCalls[0]?.method === 'POST',
    `${fetchCalls[0]?.method} ${fetchCalls[0]?.url}`,
  )
  check(
    '请求体 query + top_k=10',
    fetchCalls[0]?.body.query === '为爱复仇的贵族青年' && fetchCalls[0]?.body.top_k === 10,
    JSON.stringify(fetchCalls[0]?.body),
  )

  /* ---- 场景 3：done 态 · 结果卡（M4 实测夹具）---- */
  console.log('场景 3 · done 态（结果卡字段）')
  await act(async () => {
    await sleep(50)
  })
  const text3 = bodyText()
  check('书名渲染', text3.includes('Crime and Punishment'))
  check('作者渲染', text3.includes('Fyodor Dostoyevsky'))
  check('章节名渲染（chapter_title 非空）', text3.includes('PART I'))
  check('正文片段渲染', text3.includes('Raskolnikov continued to sit'))
  check('相似度徽标（不伪造成百分比）', text3.includes('相似度 0.59'))
  check('命中计数', text3.includes('命中 1 个片段'))
  check('e2e 耗时展示', text3.includes('28 ms'))
  check('正文卡存在（rounded-lg 容器）', container.querySelector('.rounded-lg') !== null)
  check(
    '正文 line-clamp-3 截断样式',
    container.querySelector('p.line-clamp-3') !== null,
  )

  /* ---- 场景 4：loading 态 + 顶掉旧请求 ---- */
  console.log('场景 4 · loading 态与新请求顶掉旧请求')
  let releaseFirst: (() => void) | null = null
  responder = () =>
    new Promise<{ ok: boolean; status: number; body: unknown }>((resolve) => {
      releaseFirst = () => resolve({ ok: true, status: 200, body: okResponse([REAL_CHUNK]) })
    })
  await act(async () => {
    setInputValue(inputOf(), '沙漠岛屿上的沉船求生')
  })
  await act(async () => {
    click(buttonOf())
  })
  const beforeSecond = fetchCalls.length
  check('loading 文案', bodyText().includes('正在检索') && bodyText().includes('30 本公版英文原著'))
  check('loading 时按钮禁用（防重复提交）', buttonOf().disabled === true)
  const firstSignal = fetchCalls[fetchCalls.length - 1].signal
  // 加载期间按钮禁用（防重复提交），用户换词重搜的真实路径是按回车
  // （输入框不禁用）——这同时验证「新请求顶掉旧请求」。
  await act(async () => {
    setInputValue(inputOf(), '两大家族的世仇爱情')
  })
  await act(async () => {
    inputOf().dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    )
  })
  check('第二次请求已发出（回车路径）', fetchCalls.length === beforeSecond + 1, `fetch ${fetchCalls.length} 次`)
  check('旧请求被 abort（真正取消在途请求）', firstSignal?.aborted === true)
  releaseFirst?.()

  /* ---- 场景 5：empty 态 ---- */
  console.log('场景 5 · empty 态（results=[]）')
  responder = async () => ({ ok: true, status: 200, body: okResponse([]) })
  await act(async () => {
    setInputValue(inputOf(), '一个不存在的抽象主题')
  })
  await act(async () => {
    click(buttonOf())
  })
  await act(async () => {
    await sleep(50)
  })
  check('空态文案', bodyText().includes('没有找到相关的书'))
  check('空态引导（换说法）', bodyText().includes('换个说法试试'))

  /* ---- 场景 6：error 态 · 503 不自动重试 + 手动重试 ---- */
  console.log('场景 6 · error 态 · 503 检索服务未启动')
  responder = async () => ({
    ok: false,
    status: 503,
    body: { error: { code: 'service_unavailable', message: '编码服务不可用' } },
  })
  const before503 = fetchCalls.length
  await act(async () => {
    setInputValue(inputOf(), 'revenge')
  })
  await act(async () => {
    click(buttonOf())
  })
  await act(async () => {
    await sleep(80)
  })
  check('503 引导文案', bodyText().includes('检索服务未启动'))
  check('503 不自动重试（只发 1 次）', fetchCalls.length === before503 + 1, `实际 ${fetchCalls.length - before503}`)
  const retryBtn = Array.from(container.querySelectorAll('button')).find((b) =>
    (b.textContent ?? '').includes('重试'),
  )
  check('手动重试按钮在场', retryBtn !== undefined)

  /* ---- 场景 7：error 态 · 400 不重试 ---- */
  console.log('场景 7 · error 态 · 400 不重试')
  responder = async () => ({
    ok: false,
    status: 400,
    body: { error: { code: 'bad_request', message: 'query 过长：501 字符，上限 500' } },
  })
  const before400 = fetchCalls.length
  await act(async () => {
    setInputValue(inputOf(), 'x')
  })
  await act(async () => {
    click(buttonOf())
  })
  await act(async () => {
    await sleep(80)
  })
  check('400 文案透传服务端 message', bodyText().includes('query 过长'))
  check('400 不重试（只发 1 次）', fetchCalls.length === before400 + 1)
  check(
    '400 无重试按钮（明确结论）',
    Array.from(container.querySelectorAll('button')).every((b) => !(b.textContent ?? '').includes('重试')),
  )

  /* ---- 场景 8：离线提示（onLine 只决定文案，不拦截请求）---- */
  console.log('场景 8 · 离线提示')
  await act(async () => {
    root.unmount()
  })
  Object.defineProperty(dom.window.navigator, 'onLine', { value: false, configurable: true })
  const root2 = createRoot(container)
  await act(async () => {
    root2.render(React.createElement(BookSearchPanel))
  })
  check('离线提示条出现', bodyText().includes('当前离线'))
  check('离线未拦截 idle 引导（照常渲染）', bodyText().includes('描述情节，找一本想读的书'))
  await act(async () => {
    root2.unmount()
  })
  Object.defineProperty(dom.window.navigator, 'onLine', { value: true, configurable: true })

  globalThis.fetch = realFetch

  console.log('')
  if (failed > 0) {
    console.error(`${failed} 项失败：${failures.join(' / ')}`)
    process.exit(1)
  }
  console.log(`UI 验收通过（${passed} 项）✓`)
  console.log('未覆盖声明：jsdom 无布局引擎——重叠/溢出/遮挡/移动端视口自适应未经渲染验证；')
  console.log('响应夹具为 M4 验收实测响应照抄，非生产运行数据。')
}

void main()
