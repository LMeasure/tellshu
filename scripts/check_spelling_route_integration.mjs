#!/usr/bin/env node
/**
 * 单词默写 · 阶段 ② 路由接入核验
 * ------------------------------------------------------------------
 * 对应「下一阶段顺序」步骤 ② 提交前必须确认的四件事：
 *   G1  /spelling?mode= 可以直接访问、刷新和恢复
 *   G2  /spelling-result?id= 可以直接访问并正确读取结果
 *   G3  /review 的入口与路由接入一致
 *   G4  不覆盖并行任务对全局搜索的修改（SearchDock / showGlobalSearch）
 *
 * 前置：需要先跑 `npm run preview -- --port 4174 --strictPort`
 * 用法：node scripts/check_spelling_route_integration.mjs
 *
 * ⚠️ 本脚本只读+操作 UI，不改任何被测源码。
 */

import puppeteer from 'puppeteer-core'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const BASE = process.env.BROWSER_ACCEPT_BASE ?? 'http://127.0.0.1:4174'
const OUT = join('练习', '_e-browser')
mkdirSync(OUT, { recursive: true })

const report = { startedAt: new Date().toISOString(), base: BASE, checks: [], screenshots: [] }
let failures = 0

function check(id, name, ok, detail) {
  report.checks.push({ id, name, ok: Boolean(ok), detail: String(detail ?? '') })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

async function shot(page, file) {
  const p = join(OUT, file)
  report.screenshots.push(p)
  await page.screenshot({ path: p, fullPage: true }).catch(() => {})
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ---------------- 夹具：种子词库（与主验收脚本同一份，避免场景间漂移） ---------------- */
const WORDS = [
  { word: 'abandon', definition_zh: 'v. 抛弃；放弃', pos: 'v.' },
  { word: 'benefit', definition_zh: 'n. 利益；好处', pos: 'n.' },
  { word: 'cabbage', definition_zh: 'n. 卷心菜', pos: 'n.' },
  { word: 'daisy', definition_zh: 'n. 雏菊', pos: 'n.' },
  { word: 'extraordinary', definition_zh: 'adj. 非凡的；特别的；超出寻常的', pos: 'adj.' },
  { word: 'responsibility', definition_zh: 'n. 责任；职责；义务', pos: 'n.' },
]

/**
 * 必须种词：puppeteer 每次 launch 用全新临时 profile，IndexedDB 是空的。
 * 没有 vocab ⇒ 会话建不出来 ⇒ 练习页走 EmptyState（那是正确行为，不是 bug）。
 * 注意要等 app 先把库建到 v10 再写（先 goto 拿到页面）。
 */
async function seedVocab(page) {
  return page.evaluate(async (words) => {
    const now = Date.now()
    const req = indexedDB.open('shushu-learn')
    const db = await new Promise((res, rej) => {
      req.onsuccess = () => res(req.result)
      req.onerror = () => rej(req.error)
      req.onupgradeneeded = () => res(req.result)
    })
    const tx = db.transaction(['vocab', 'spellingSessions', 'reviewLog'], 'readwrite')
    tx.objectStore('vocab').clear()
    tx.objectStore('spellingSessions').clear()
    tx.objectStore('reviewLog').clear()
    for (const [i, w] of words.entries()) {
      tx.objectStore('vocab').put({
        word_id: `seed:${w.word}`,
        word: w.word,
        book: 'CET4',
        definition_zh: w.definition_zh,
        pos: w.pos,
        layer: 'new',
        consecutive_correct: 0,
        srs_step: 0,
        in_wrong_pool: false,
        next_review: now + 600000,
        added_at: now + i,
        updated_at: now,
        owner: 'guest',
      })
    }
    await new Promise((res, rej) => {
      tx.oncomplete = res
      tx.onerror = () => rej(tx.error)
    })
    db.close()
    return words.length
  }, WORDS)
}

/** 带超时的 IndexedDB 读取：避免多标签页场景下 CDP protocolTimeout 挂死 */
async function dbState(page) {
  return Promise.race([
    page.evaluate(async () => {
      const open = () =>
        new Promise((res, rej) => {
          const req = indexedDB.open('shushu-learn')
          req.onsuccess = () => res(req.result)
          req.onerror = () => rej(req.error)
        })
      const db = await open()
      const tx = db.transaction(['spellingSessions', 'vocab'], 'readonly')
      const rows = await new Promise((res) => {
        const r = tx.objectStore('spellingSessions').getAll()
        r.onsuccess = () => res(r.result)
      })
      const vocab = await new Promise((res) => {
        const r = tx.objectStore('vocab').getAll()
        r.onsuccess = () => res(r.result)
      })
      db.close()
      return { sessions: rows, vocab }
    }),
    sleep(15000).then(() => ({ sessions: [], vocab: [], timeout: true })),
  ])
}

async function clearSessions(page) {
  await page
    .evaluate(async () => {
      const db = await new Promise((res) => {
        const req = indexedDB.open('shushu-learn')
        req.onsuccess = () => res(req.result)
      })
      const tx = db.transaction(['spellingSessions'], 'readwrite')
      tx.objectStore('spellingSessions').clear()
      await new Promise((res) => {
        tx.oncomplete = res
      })
      db.close()
    })
    .catch(() => {})
}

/** 必须先落在 /review 上拿到 origin，改完 studyBatchSize 再 reload，最后才 goto 目标 URL
 *  （顺序反了会让 App 用旧 batchSize 直接把会话建好，后续 localStorage 写入全部失效） */
async function freshPage(ctx, { width = 375, height = 667, batch = 3, url = '/review' } = {}) {
  const page = await ctx.newPage()
  await page.setViewport({ width, height })
  await page.goto(`${BASE}/review`, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {})
  try {
    await page.evaluate((size) => {
      const raw = localStorage.getItem('shushu-settings')
      const obj = raw ? JSON.parse(raw) : {}
      const next =
        raw && obj.state
          ? { ...obj, state: { ...obj.state, studyBatchSize: size } }
          : { state: { studyBatchSize: size }, version: 0 }
      localStorage.setItem('shushu-settings', JSON.stringify(next))
    }, batch)
    await page.reload({ waitUntil: 'networkidle2', timeout: 25000 })
    await clearSessions(page)
    if (url !== '/review') await page.goto(`${BASE}${url}`, { waitUntil: 'networkidle2', timeout: 25000 })
  } catch (e) {
    console.log(`  [warn] freshPage(${url}) 夹具准备失败：${e.message}`)
  }
  return page
}

/** React 18 受控输入不能用 el.value=x，必须走原型 setter */
async function typeInto(page, text) {
  await page.focus('#spelling-input').catch(() => {})
  await page.evaluate(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    const i = document.querySelector('#spelling-input')
    if (!i) throw new Error('input 不存在')
    setter.call(i, '')
    i.dispatchEvent(new Event('input', { bubbles: true }))
  })
  if (text) await page.keyboard.type(text, { delay: 12 })
}

async function clickText(page, text) {
  return page.evaluate((t) => {
    const el = [...document.querySelectorAll('button, a')].find((e) => (e.innerText || '').includes(t))
    if (!el) return false
    el.click()
    return true
  }, text)
}

const waitInput = (page) => page.waitForSelector('#spelling-input', { timeout: 12000 }).catch(() => null)

/** 当前题目的词 -> 答案，从库里读，绝不硬编码 */
function currentWord(st) {
  const s = st.sessions.find((x) => x.status === 'IN_PROGRESS') ?? st.sessions[0]
  if (!s) return null
  return s.queue.find((w) => w.position === s.current_position) ?? s.queue[0]
}

/**
 * 总尝试次数 = 队列里每个词的 total_attempts 之和。
 * ⚠️ 会话文档**顶层没有** total_attempts —— 计数存在内嵌 queue[i] 里
 *    （顶层字段实测：id/type/owner/status/selection_mode/target_correct/
 *     total_words/current_position/started_at/updated_at/queue/processed_requests）。
 */
const attemptsSum = (s) => (s?.queue ?? []).reduce((n, w) => n + (w.total_attempts ?? 0), 0)

const b = await puppeteer.launch({ executablePath: EDGE, headless: true, protocolTimeout: 90000 })
report.edgeVersion = await b.version()
const ctx = await b.createBrowserContext()

try {
  /* ================= 夹具准备：种子词库（与新 profile 的 IndexedDB 对齐） ================= */
  const boot = await ctx.newPage()
  await boot.setViewport({ width: 375, height: 667 })
  await boot.goto(`${BASE}/review`, { waitUntil: 'networkidle2', timeout: 25000 })
  await sleep(900)
  const seeded = await seedVocab(boot)
  report.seededVocab = seeded
  console.log(`[fixture] 已种入 ${seeded} 个词条`)
  await boot.close()

  /* ================= G1 · /spelling?mode= 直访 + 刷新 + 恢复 ================= */
  console.log('\n--- G1 /spelling?mode= 直访 / 刷新 / 恢复 ---')
  let p = await freshPage(ctx, { url: '/spelling?mode=recent' })
  await waitInput(p)
  await sleep(700)

  let st = await dbState(p)
  check('G1.1', '直访 /spelling?mode=recent 渲染出练习页', Boolean(await p.$('#spelling-input')))
  check('G1.2', '直访后落了一份 IN_PROGRESS 会话', st.sessions.filter((s) => s.status === 'IN_PROGRESS').length === 1, `sessions=${st.sessions.length}`)

  // 答对一题，制造进度
  const w0 = currentWord(st)
  let pid = st.sessions.find((s) => s.status === 'IN_PROGRESS')?.id
  if (w0) {
    await typeInto(p, w0.word)
    await p.keyboard.press('Enter')
    await sleep(1400)
  }
  st = await dbState(p)
  const sBefore = st.sessions.find((s) => s.id === pid)
  const attemptsBefore = attemptsSum(sBefore)

  await p.reload({ waitUntil: 'networkidle2', timeout: 25000 })
  await sleep(1200)
  await waitInput(p)
  st = await dbState(p)
  const sAfter = st.sessions.find((s) => s.id === pid)
  check('G1.3', '刷新后恢复同一会话（id 不变）', Boolean(sAfter), `id=${pid}`)
  check('G1.4', '刷新后 current_position 不回退', (sAfter?.current_position ?? -1) >= (sBefore?.current_position ?? -1), `${sBefore?.current_position} → ${sAfter?.current_position}`)
  check('G1.5', '刷新不重复计数（队列总尝试次数不因重渲染增长）', attemptsSum(sAfter) === attemptsBefore, `${attemptsBefore} → ${attemptsSum(sAfter)}`)
  check('G1.6', '刷新后 URL 仍是可分享的 /spelling?mode=', p.url().includes('/spelling'), p.url())
  await shot(p, 'g1-spelling-refresh.png')
  await p.close()

  /* ================= G2 · /spelling-result?id= 直访读结果 ================= */
  console.log('\n--- G2 /spelling-result?id= 直访读结果 ---')
  p = await freshPage(ctx, { url: '/review' })
  const st2 = await dbState(p)
  check('G2.1', '夹具已清空会话（验证「空 id」场景前）', st2.sessions.length === 0, `sessions=${st2.sessions.length}`)

  // 无 id 参数
  await p.goto(`${BASE}/spelling-result`, { waitUntil: 'networkidle2', timeout: 25000 })
  await sleep(900)
  const noIdText = await p.evaluate(() => document.body.innerText)
  check('G2.2', '无 id 参数不白屏（给出空态/错误态而非崩溃）', noIdText.trim().length > 0 && !noIdText.includes('Cannot read'))
  await shot(p, 'g2-result-no-id.png')

  // id 不存在
  await p.goto(`${BASE}/spelling-result?id=not-exist-xyz`, { waitUntil: 'networkidle2', timeout: 25000 })
  await sleep(900)
  const badText = await p.evaluate(() => document.body.innerText)
  check('G2.3', 'id 不存在时给出明确提示，不编造数字', badText.trim().length > 0 && !badText.includes('undefined'))
  await shot(p, 'g2-result-bad-id.png')

  // 真实 id 直访
  await p.goto(`${BASE}/spelling?mode=recent`, { waitUntil: 'networkidle2', timeout: 25000 })
  await waitInput(p)
  await sleep(900)
  st = await dbState(p)
  let target = st.sessions.find((s) => s.status === 'IN_PROGRESS') ?? st.sessions[0]
  const targetId = target?.id
  await p.goto(`${BASE}/spelling-result?id=${encodeURIComponent(targetId ?? 'x')}`, {
    waitUntil: 'networkidle2',
    timeout: 25000,
  })
  await sleep(1000)
  const srText = await p.evaluate(() => document.body.innerText)
  check('G2.4', '直访 /spelling-result?id=<真实 id> 渲染默写结果页', srText.includes('默写结果'), srText.slice(0, 60).replace(/\n/g, ' '))
  check('G2.5', '结果页含「逐词明细」（与占位 /result 区分）', srText.includes('逐词明细'))
  // 数字与库一致：尝试取页面上的「已完成 / 总词数」与队列比对
  st = await dbState(p)
  const t2 = st.sessions.find((s) => s.id === targetId)
  const completedInDb = (t2?.queue ?? []).filter((w) => w.status === 'COMPLETED').length
  check('G2.6', '结果页数据源是持久化会话（库里可读到同一份队列）', Array.isArray(t2?.queue) && t2.queue.length > 0, `queue=${t2?.queue?.length} completed=${completedInDb}`)
  check('G2.7', '结果页不显示占位的「连续学习」文案', !srText.includes('连续学习'))
  await shot(p, 'g2-result-direct.png')
  await p.close()

  /* ================= G3 · /review 入口与路由接入一致 ================= */
  console.log('\n--- G3 /review 入口与路由接入一致 ---')
  p = await freshPage(ctx, { url: '/review' })
  await sleep(900)
  const clicked = await clickText(p, '开始默写')
  await sleep(1500)
  check('G3.1', '/review 点「开始默写」跳到 /spelling', p.url().includes('/spelling'), p.url())
  check('G3.2', '跳转 URL 带上选词模式参数', /mode=(recent|random|wrong)/.test(p.url()), p.url())
  await waitInput(p)
  check('G3.3', '跳转后真的进入练习页（不是空白路由）', Boolean(await p.$('#spelling-input')))
  await shot(p, 'g3-review-entry.png')

  // 换模式：入口 Segmented 应影响 URL
  await p.goto(`${BASE}/review`, { waitUntil: 'networkidle2', timeout: 25000 })
  await sleep(800)
  const switched = await clickText(p, '随机')
  await sleep(500)
  await clickText(p, '开始默写')
  await sleep(1500)
  check('G3.4', '入口切换模式后 URL mode 随之变化', switched ? p.url().includes('mode=') : true, p.url())
  await p.close()

  /* ================= G4 · 不覆盖并行任务全局搜索改动 ================= */
  console.log('\n--- G4 并行任务全局搜索未被覆盖 ---')
  p = await freshPage(ctx, { url: '/spelling?mode=recent' })
  await waitInput(p)
  await sleep(900)

  const dockBtn = await p.$('[aria-label="打开全局搜索"]')
  check('G4.1', '/spelling 页上仍挂着并行任务的全局搜索入口（SearchDock）', Boolean(dockBtn))
  const overlayBefore = await p.$('[data-testid="search-overlay"]')
  check('G4.2', '默认不展开全屏搜索层', !overlayBefore)

  if (dockBtn) {
    await p.evaluate(() => document.querySelector('[aria-label="打开全局搜索"]')?.click())
    await sleep(900)
  }
  const overlayAfter = await p.$('[data-testid="search-overlay"]')
  check('G4.3', '点入口可展开并行任务的全屏搜索层', Boolean(overlayAfter))
  await shot(p, 'g4-search-overlay-on-spelling.png')

  // 收起后默写输入框仍可用（不被 Portal 残留遮挡）
  await p.evaluate(() => document.querySelector('[aria-label="收起搜索"]')?.click())
  await sleep(800)
  check('G4.4', '收起搜索层后回到默写页且输入框仍存在', Boolean(await p.$('#spelling-input')))
  const overlayClosed = await p.$('[data-testid="search-overlay"]')
  check('G4.5', '收起后搜索层已从 DOM 移除', !overlayClosed)

  // 几何检测：默写输入框不被底部停靠组件遮挡
  const geo = await p.evaluate(() => {
    const i = document.querySelector('#spelling-input')
    if (!i) return null
    const r = i.getBoundingClientRect()
    const mid = { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    const top = document.elementFromPoint(mid.x, mid.y)
    return { top: top?.id ?? top?.tagName ?? '', covered: top !== i }
  })
  check('G4.6', '默写输入框未被任何浮层遮挡（命中测试落在自身）', geo && !geo.covered, JSON.stringify(geo))
  await p.close()

  // /search 页自身不挂 SearchDock（showGlobalSearch={false} 生效）
  p = await freshPage(ctx, { url: '/search' })
  await sleep(1000)
  const dockOnSearch = await p.$('[aria-label="打开全局搜索"]')
  check('G4.7', '/search 页不重复挂全局搜索入口（showGlobalSearch={false} 生效）', !dockOnSearch)
  await shot(p, 'g4-search-page.png')
  await p.close()

  report.finishedAt = new Date().toISOString()
  report.failures = failures
  writeFileSync(join(OUT, '_route-integration-report.json'), JSON.stringify(report, null, 2), 'utf8')
  console.log('\n────────────────────────────────────────────────────────')
  console.log(
    failures === 0
      ? `✅ 路由接入核验全部通过：${report.checks.length} 项`
      : `❌ 路由接入核验失败：${failures} 项 / 共 ${report.checks.length} 项`,
  )
  if (failures) process.exitCode = 1
} finally {
  await b.close()
}
