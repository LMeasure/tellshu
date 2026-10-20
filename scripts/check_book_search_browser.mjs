#!/usr/bin/env node
/**
 * 找书 Tab · 真实浏览器视觉与交互验收（M4 收尾 Step 2）
 * ------------------------------------------------------------------
 * 工具链：puppeteer-core（npm --no-save 临时装入 node_modules，不入
 * package.json）+ 系统已装 Microsoft Edge（executablePath 直指，
 * 不下载任何浏览器二进制）。jsdom 无布局引擎，不能冒充真实浏览器
 * 视觉验收——本脚本是真实渲染、真实布局、真实网络栈的验收。
 *
 * 场景口径：
 *   S1~S3  三档视口（320–375 / 390–430 / ≥1280 CSS px）基础布局检查
 *   S4      加载态（延迟 mock 捕获，标注：非真实后端）
 *   S5      真实检索（无 mock，走 vite 代理 → 本机 8000 FastAPI 真检索）
 *   S6      空态（mock 200 + results:[]，标注：非真实后端）
 *   S7      503 运维引导 + 手动重试（mock，标注）
 *   S8      400 参数拒绝 + 不自动重试（mock，标注）
 *   S9      200 非 JSON——SPA history 回退防护（mock 返回 HTML，标注；
 *          这条同时是 vercel.json catch-all rewrite 生产风险的镜像验证）
 *   S10     真实离线（page.setOffline，不 mock：断网时 3 次尝试口径）
 *
 * 产物：截图 + _browser-report.json（落 server/.crawl-cache/_browser-accept/，
 * 该目录在 server/.gitignore 内，不进仓库）。
 *
 * 用法：node scripts/check_book_search_browser.mjs
 */
import puppeteer from 'puppeteer-core'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const BASE = process.env.BROWSER_ACCEPT_BASE ?? 'http://127.0.0.1:4174'
const OUT = process.env.BROWSER_ACCEPT_OUT ?? join('server', '.crawl-cache', '_browser-accept')
const DISCOVER_PATH = '/discover'
const BOOKS_TAB = '找书'

mkdirSync(OUT, { recursive: true })

const report = { startedAt: new Date().toISOString(), base: BASE, edge: EDGE, checks: [], screenshots: [] }
let failures = 0

function check(id, name, ok, detail) {
  report.checks.push({ id, name, ok: Boolean(ok), detail: String(detail ?? '') })
  const line = `${ok ? 'PASS' : 'FAIL'} ${id} ${name}` + (detail ? ` — ${detail}` : '')
  console.log(line)
  if (!ok) failures += 1
}

function shot(page, file) {
  const p = join(OUT, file)
  report.screenshots.push(p)
  return page.screenshot({ path: p, fullPage: true })
}

async function clickBooksTab(page) {
  return page.evaluate((label) => {
    const btn = [...document.querySelectorAll('button')].find(
      (b) => (b.textContent ?? '').trim() === label,
    )
    if (!btn) return false
    btn.click()
    return true
  }, BOOKS_TAB)
}

/** 等面板就绪（输入框带 maxLength=500） */
async function waitPanel(page) {
  await page.waitForSelector('input[maxlength="500"]', { timeout: 8000, visible: true })
}

async function countDiscoverRequests(page) {
  let n = 0
  page.on('request', (r) => {
    if (r.url().includes('/api/discover')) n += 1
  })
  return () => n
}

/**
 * 安装浏览器请求级 mock（不进 vite 代理，标注用）。
 * 注意：puppeteer-core 25.x 已移除 page.route，改用旧拦截栈
 * setRequestInterception + req.respond/abort/continue（实测可用）。
 */
async function mockDiscover(page, { status = 200, contentType = 'application/json', body, delayMs = 0, abort = false }) {
  const handler = (req) => {
    if (!req.url().includes('/api/discover')) return req.continue()
    const act = () => {
      if (abort) return req.abort()
      const payload = typeof body === 'string' ? body : JSON.stringify(body)
      return req.respond({
        status,
        contentType,
        headers: { 'cache-control': 'no-store' },
        body: payload,
      })
    }
    if (delayMs > 0) setTimeout(act, delayMs)
    else act()
  }
  await page.setRequestInterception(true)
  page.on('request', handler)
  page.__mockHandler = handler
}

async function unmockDiscover(page) {
  if (page.__mockHandler) page.off('request', page.__mockHandler)
  page.__mockHandler = null
  await page.setRequestInterception(false).catch(() => {})
}

const REAL_HIT = {
  chunk_id: 1,
  book_id: 'pg2554',
  title: 'Crime and Punishment',
  author: 'Fyodor Dostoyevsky',
  chapter_title: 'PART I',
  chunk_index: 0,
  content: 'On an exceptionally hot evening early in July a young man came out of the garret in which he lodged in S. Place and walked slowly, as though in hesitation, towards K. bridge.',
  score: 0.74,
}

function realResponse(n = 3) {
  const results = Array.from({ length: n }, (_, i) => ({ ...REAL_HIT, chunk_index: i, score: 0.74 - i * 0.03 }))
  return {
    results,
    latency: { encode_ms: 19, retrieve_ms: 8, e2e_ms: 27 },
    meta: {
      top_k: 10,
      returned: n,
      ef_search: '800',
      iterative_scan: 'strict_order',
      include_front_matter: false,
      explain_sampled: false,
      sampled_plan_type: null,
    },
  }
}

async function typeAndSubmit(page, query, { enter = true } = {}) {
  const box = await page.$('input[maxlength="500"]')
  await box.click()
  await box.evaluate((el) => {
    el.value = ''
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await page.type('input[maxlength="500"]', query, { delay: 8 })
  if (enter) await page.keyboard.press('Enter')
  else await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim().endsWith('搜索'))
    btn?.click()
  })
}

async function panelText(page) {
  return page.evaluate(() => document.body.innerText)
}

async function browser() {
  const args = process.argv.slice(2)
  const only = args.length > 0 ? args : null
  const run = (id) => only === null || only.includes(id)

  const b = await puppeteer.launch({ executablePath: EDGE, headless: true })
  try {
    /* ---------- S1~S3 三档视口基础布局 ---------- */
    const viewports = [
      { w: 375, h: 667, tag: 'vp375', label: '320–375 CSS px 档' },
      { w: 430, h: 932, tag: 'vp430', label: '390–430 CSS px 档' },
      { w: 1280, h: 800, tag: 'vp1280', label: '≥1280 CSS px 档' },
    ]
    for (const vp of viewports) {
      if (!run(vp.tag) && !run('layout')) continue
      const page = await b.newPage()
      await page.setViewport({ width: vp.w, height: vp.h })
      await page.goto(BASE + DISCOVER_PATH, { waitUntil: 'domcontentloaded' })
      await page.waitForFunction(
        (label) => [...document.querySelectorAll('button')].some((x) => (x.textContent ?? '').trim() === label),
        { timeout: 8000 },
        BOOKS_TAB,
      )
      const tabOk = await clickBooksTab(page)
      check(`${vp.tag}.tab`, `${vp.label}：「找书」Tab 可切换，面板出现`, tabOk, tabOk ? '' : '未找到「找书」按钮')
      await waitPanel(page)

      const layout = await page.evaluate(() => {
        const doc = document.documentElement
        const input = document.querySelector('input[maxlength="500"]')
        const btn = [...document.querySelectorAll('button')].find((x) => (x.textContent ?? '').trim().endsWith('搜索'))
        const r = (el) => {
          const bb = el.getBoundingClientRect()
          return { x: bb.x, y: bb.y, w: bb.width, h: bb.height, right: bb.right, bottom: bb.bottom }
        }
        const ib = input ? r(input) : null
        const bb = btn ? r(btn) : null
        return {
          scrollW: doc.scrollWidth,
          innerW: window.innerWidth,
          inputVisible: Boolean(input && ib.w > 0 && ib.h > 0),
          inputMaxLen: input ? input.getAttribute('maxlength') : null,
          placeholder: input ? input.placeholder : null,
          btnDisabled: btn ? btn.disabled : null,
          btnBox: bb,
          inputBox: ib,
          btnTouchH: bb ? bb.h : 0,
          overlap: ib && bb ? !(ib.right <= bb.x + 0.5 || bb.right <= ib.x + 0.5) : null,
        }
      })
      check(
        `${vp.tag}.noscroll`,
        `${vp.label}：页面无横向滚动`,
        layout.scrollW <= layout.innerW + 1,
        `scrollWidth=${layout.scrollW} innerWidth=${layout.innerW}`,
      )
      check(
        `${vp.tag}.input`,
        `${vp.label}：输入框可见、maxLength=500、placeholder 正确`,
        layout.inputVisible && layout.inputMaxLen === '500' && /描述/.test(layout.placeholder ?? ''),
        `maxlength=${layout.inputMaxLen} placeholder="${layout.placeholder ?? ''}"`,
      )
      check(
        `${vp.tag}.btn-disabled`,
        `${vp.label}：空 query 时搜索按钮禁用（本地拦截不发请求）`,
        layout.btnDisabled === true,
        `disabled=${layout.btnDisabled}`,
      )
      check(
        `${vp.tag}.btn-touch`,
        `${vp.label}：搜索按钮触控高度 ≥ 32px`,
        layout.btnTouchH >= 32,
        `h=${layout.btnTouchH}`,
      )
      check(
        `${vp.tag}.no-overlap`,
        `${vp.label}：输入框与按钮不重叠`,
        layout.overlap === false,
        layout.inputBox && layout.btnBox ? `input.right=${layout.inputBox.right.toFixed(1)} btn.x=${layout.btnBox.x.toFixed(1)}` : '元素缺失',
      )
      const text = await panelText(page)
      check(
        `${vp.tag}.idle`,
        `${vp.label}：idle 空态引导文案`,
        /描述情节，找一本想读的书/.test(text),
        text.includes('描述情节') ? '' : '未见 idle 引导',
      )
      await shot(page, `${vp.tag}-discover-books.png`)
      await page.close()
    }

    /* ---------- S4 加载态（延迟 mock 捕获，非真实后端） ---------- */
    if (run('loading')) {
      const page = await b.newPage()
      await page.setViewport({ width: 390, height: 844 })
      await page.goto(BASE + DISCOVER_PATH, { waitUntil: 'domcontentloaded' })
      await waitForTab(page)
      await clickBooksTab(page)
      await waitPanel(page)
      await mockDiscover(page, { status: 200, body: realResponse(), delayMs: 1200 })
      await typeAndSubmit(page, '沙漠岛屿上的沉船求生', { enter: true })
      await page.waitForFunction(() => /正在检索/.test(document.body.innerText), { timeout: 3000 }).catch(() => {})
      const loading = await page.evaluate(() => {
        const text = document.body.innerText
        const btn = [...document.querySelectorAll('button')].find((x) => (x.textContent ?? '').trim().endsWith('搜索'))
        const spinner = document.querySelector('.animate-spin')
        return { text: /正在检索30 本公版英文原著/.test(text), btnDisabled: btn ? btn.disabled : null, spinner: Boolean(spinner) }
      })
      check('loading.text', '加载态：显示「正在检索30 本公版英文原著…」', loading.text, '')
      check('loading.btn', '加载态：搜索按钮禁用防重复提交', loading.btnDisabled === true, `disabled=${loading.btnDisabled}`)
      check('loading.spinner', '加载态：spinner 存在', loading.spinner, '')
      await shot(page, 'loading-spinner.png')
      await page.waitForFunction(() => /命中 \d+ 个片段/.test(document.body.innerText), { timeout: 6000 }).catch(() => {})
      await unmockDiscover(page)
      await page.close()
    }

    /* ---------- S5 真实检索（真实后端，无 mock） ---------- */
    if (run('real')) {
      const page = await b.newPage()
      await page.setViewport({ width: 430, height: 932 })
      const reqCount = await countDiscoverRequests(page)
      const responses = []
      page.on('response', async (res) => {
        if (res.url().includes('/api/discover')) {
          try {
            responses.push({ status: res.status(), url: res.url() })
          } catch { /* 忽略 */ }
        }
      })
      await page.goto(BASE + DISCOVER_PATH, { waitUntil: 'domcontentloaded' })
      await waitForTab(page)
      await clickBooksTab(page)
      await waitPanel(page)
      const t0 = Date.now()
      await typeAndSubmit(page, 'crime and punishment', { enter: true }) // Enter 提交（真实路径）
      await page.waitForFunction(() => /命中 \d+ 个片段/.test(document.body.innerText), { timeout: 20000 })
      const elapsed = Date.now() - t0
      const done = await page.evaluate(() => {
        const text = document.body.innerText
        const cards = [...document.querySelectorAll('.shadow-soft')]
        const first = cards[0]
        return {
          summary: /命中 (\d+) 个片段/.exec(text)?.[1] ?? null,
          cards: cards.length,
          firstTitle: first ? (first.querySelector('.font-semibold')?.textContent ?? '') : '',
          firstAuthor: first ? first.innerText.split('\n').slice(1, 2).join(' ') : '',
          hasBadge: first ? /相似度 \d+\.\d{2}/.test(first.innerText) : false,
          hasContent: first ? (first.querySelector('p')?.textContent ?? '').length > 30 : false,
          e2e: /本次检索 (\d+) ms/.exec(text)?.[1] ?? null,
          books: cards.map((c) => c.querySelector('.font-semibold')?.textContent ?? ''),
        }
      })
      check('real.request', '真实检索：Enter 提交且只发 1 次 /api/discover 请求', reqCount() === 1, `requests=${reqCount()}`)
      check('real.cards', '真实检索：命中片段数与卡片数一致（≥1）', done.summary !== null && done.cards >= 1 && String(done.cards) === done.summary, `summary=${done.summary} cards=${done.cards}`)
      check('real.card-fields', '真实检索：卡片含书名/作者行/相似度徽标/内容摘录', done.firstTitle.length > 0 && done.firstAuthor.length > 0 && done.hasBadge && done.hasContent, `title="${done.firstTitle}" author="${done.firstAuthor.trim()}" badge=${done.hasBadge} content=${done.hasContent}`)
      check('real.e2e', '真实检索：头部显示「本次检索 N ms」', done.e2e !== null, `e2e=${done.e2e} wall=${elapsed}ms`)
      console.log(`     INFO 真实检索命中书目：${done.books.join(' / ')}；页面 e2e=${done.e2e}ms，端到端 wall=${elapsed}ms`)
      await shot(page, 'real-search-result.png')
      await page.close()
    }

    /* ---------- S6 空态（mock 200 + results:[]） ---------- */
    if (run('empty')) {
      const page = await b.newPage()
      await page.setViewport({ width: 390, height: 844 })
      await page.goto(BASE + DISCOVER_PATH, { waitUntil: 'domcontentloaded' })
      await waitForTab(page)
      await clickBooksTab(page)
      await waitPanel(page)
      await mockDiscover(page, { status: 200, body: { results: [], latency: { encode_ms: 1, retrieve_ms: 1, e2e_ms: 3 }, meta: { top_k: 10, returned: 0, ef_search: '800', iterative_scan: 'strict_order', include_front_matter: false, explain_sampled: false, sampled_plan_type: null } } })
      await typeAndSubmit(page, 'zzz 不存在的荒岛魔法', { enter: true })
      await page.waitForFunction(() => /没有找到相关的书/.test(document.body.innerText), { timeout: 8000 })
      check('empty.state', '空态：「没有找到相关的书」+ 换说法建议', true, 'mock 200 + results:[]（非真实后端）')
      await shot(page, 'empty-state.png')
      await page.close()
    }

    /* ---------- S7 503 引导 + 手动重试（mock） ---------- */
    if (run('s503')) {
      const page = await b.newPage()
      await page.setViewport({ width: 390, height: 844 })
      const reqCount = await countDiscoverRequests(page)
      await page.goto(BASE + DISCOVER_PATH, { waitUntil: 'domcontentloaded' })
      await waitForTab(page)
      await clickBooksTab(page)
      await waitPanel(page)
      await mockDiscover(page, { status: 503, body: { error: { code: 'service_unavailable', message: '检索服务未启动' } } })
      await typeAndSubmit(page, 'crime and punishment', { enter: true })
      await page.waitForFunction(() => /检索服务未启动/.test(document.body.innerText), { timeout: 8000 })
      check('s503.guide', '503：显示「检索服务未启动」运维引导', true, 'mock 503（非真实后端）')
      check('s503.no-auto-retry', '503：不自动重试（只发 1 次请求）', reqCount() === 1, `requests=${reqCount()}`)
      // 重试按钮
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button')].find((x) => (x.textContent ?? '').includes('重试'))
        btn?.click()
      })
      await page.waitForFunction(() => reqCount() >= 2, { timeout: 5000 }).catch(() => {})
      check('s503.manual-retry', '503：手动「重试」按钮可再次发起请求', reqCount() >= 2, `requests=${reqCount()}`)
      await shot(page, 'error-503.png')
      await page.close()
    }

    /* ---------- S8 400 参数拒绝（mock，不自动重试） ---------- */
    if (run('s400')) {
      const page = await b.newPage()
      await page.setViewport({ width: 390, height: 844 })
      const reqCount = await countDiscoverRequests(page)
      await page.goto(BASE + DISCOVER_PATH, { waitUntil: 'domcontentloaded' })
      await waitForTab(page)
      await clickBooksTab(page)
      await waitPanel(page)
      await mockDiscover(page, { status: 400, body: { error: { code: 'not_implemented', message: 'book/chapter_filter 未实现' } } })
      await typeAndSubmit(page, 'crime and punishment', { enter: true })
      await page.waitForFunction(() => /检索请求被拒绝/.test(document.body.innerText), { timeout: 8000 })
      const text = await panelText(page)
      check('s400.message', '400：服务端 message 透传（「检索请求被拒绝：book/chapter_filter 未实现」）', text.includes('检索请求被拒绝：book/chapter_filter 未实现'), 'mock 400（非真实后端）')
      const retryBtn = await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button')].find((x) => (x.textContent ?? '').includes('重试'))
        return Boolean(btn)
      })
      check('s400.no-retry-btn', '400：不显示重试按钮（4xx 是明确结论）', retryBtn === false, `retryButton=${retryBtn}`)
      check('s400.no-auto-retry', '400：不自动重试（只发 1 次请求）', reqCount() === 1, `requests=${reqCount()}`)
      await shot(page, 'error-400.png')
      await page.close()
    }

    /* ---------- S9 200 非 JSON：SPA 回退防护（mock HTML） ---------- */
    if (run('s200html')) {
      const page = await b.newPage()
      await page.setViewport({ width: 390, height: 844 })
      await page.goto(BASE + DISCOVER_PATH, { waitUntil: 'domcontentloaded' })
      await waitForTab(page)
      await clickBooksTab(page)
      await waitPanel(page)
      await mockDiscover(page, { status: 200, contentType: 'text/html', body: '<!doctype html><html><body>SPA fallback</body></html>' })
      await typeAndSubmit(page, 'crime and punishment', { enter: true })
      await page.waitForFunction(() => /响应不是 JSON/.test(document.body.innerText), { timeout: 8000 })
      check('s200html.guard', '200 非 JSON：SPA history 回退被识别为错误（不把 HTML 当结果渲染）', true, 'mock 200+HTML（非真实后端；同时镜像 vercel.json catch-all 风险）')
      await shot(page, 'error-200-html.png')
      await page.close()
    }

    /* ---------- S10 网络失败（请求级 abort 模拟；page.setOffline 在 v25 已移除） ---------- */
    if (run('offline')) {
      const page = await b.newPage()
      await page.setViewport({ width: 390, height: 844 })
      await page.goto(BASE + DISCOVER_PATH, { waitUntil: 'domcontentloaded' })
      await waitForTab(page)
      await clickBooksTab(page)
      await waitPanel(page)
      const reqCount = await countDiscoverRequests(page)
      // 说明：puppeteer-core 25.x 移除了 page.setOffline，context 也无 offline API。
      // 用 req.abort() 对 /api/discover 制造网络层失败——浏览器侧 fetch 收到的是
      // 与真实断网相同的「网络错误」拒绝（TypeError），域层分类、3 次尝试、
      // 退避与文案路径完全一致。报告中如实标注：请求级 abort，非整机断网。
      await mockDiscover(page, { abort: true })
      await typeAndSubmit(page, 'crime and punishment', { enter: true })
      await page.waitForFunction(() => /检索服务暂时不可用（已自动重试 3 次）/.test(document.body.innerText), { timeout: 15000 })
      check('offline.notice', '网络失败：显示「已自动重试 3 次」结论 + 重试按钮', true, '请求级 abort 模拟（非整机断网，非 mock 响应体）')
      check('offline.retry-3', '网络失败：共发起 3 次尝试（含重试）', reqCount() === 3, `requests=${reqCount()}`)
      await shot(page, 'error-network-failure.png')
      await page.close()
    }
  } finally {
    await b.close()
  }

  report.failures = failures
  report.finishedAt = new Date().toISOString()
  writeFileSync(join(OUT, '_browser-report.json'), JSON.stringify(report, null, 2))
  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} — 报告 ${join(OUT, '_browser-report.json')}`)
  process.exit(failures === 0 ? 0 : 1)
}

async function waitForTab(page) {
  await page.waitForFunction(
    (label) => [...document.querySelectorAll('button')].some((x) => (x.textContent ?? '').trim() === label),
    { timeout: 8000 },
    BOOKS_TAB,
  )
}

browser().catch((e) => {
  console.error('验收脚本异常：', e)
  process.exit(2)
})
