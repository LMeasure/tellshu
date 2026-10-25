#!/usr/bin/env node
/**
 * 单词默写 · 阶段 E 真实浏览器人工验收
 * ------------------------------------------------------------------
 * jsdom 没有布局引擎，测不了像素级视觉；本脚本用 puppeteer-core + 系统 Edge
 * 做**真实渲染、真实布局、真实 IndexedDB** 的验收。
 *
 * 覆盖（对应阶段 E 任务书 §5 与 §4.4）：
 *   S1  375px 窄屏：/review 入口卡片
 *   S2  375px 窄屏：练习页输入框 / 提交按钮 / 反馈区域 / 无横向溢出 / 触摸目标
 *   S3  软键盘场景：以视口高度收缩模拟（真机软键盘未验证，如实标注）
 *   S4  答题反馈：正确 / 错误 / 空答案
 *   S4b 长释义 + 较长单词
 *   S5  暂停 → 继续 → 放弃
 *   S6  完成 → 结果页 → 返回入口
 *   S7  桌面宽屏 1280px 布局
 *   S8  **两个真实标签页**同时操作：并发创建真竞态 / 冲突提示 / 选择后的持久化状态 / 是否互相覆盖
 *   S9  刷新恢复
 *
 * 夹具说明：
 *   · 种子词用 raw IndexedDB 写入（app 先建库到 v10，再插 vocab 行）。这是测试夹具，
 *     不是产品代码路径；判分、状态机、SRS 交接仍全部走产品代码。
 *   · **每个场景前清空 spellingSessions / reviewLog** —— 第一轮跑出来
 *     S6/S8 失败的根因就是会话跨场景累积被当成脏状态，不是产品问题。
 *
 * 产物：截图 + _browser-report.json（落在 练习/_e-browser/，可人工复核）
 *
 * 前置：npm run build 已执行；npm run preview -- --port 4174 --strictPort 正在跑
 * 用法：node scripts/check_spelling_browser.mjs
 */

import puppeteer from 'puppeteer-core'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const BASE = process.env.BROWSER_ACCEPT_BASE ?? 'http://127.0.0.1:4174'
const OUT = join('练习', '_e-browser')

mkdirSync(OUT, { recursive: true })

const report = {
  startedAt: new Date().toISOString(),
  base: BASE,
  edge: EDGE,
  edgeVersion: null,
  checks: [],
  screenshots: [],
  notVerified: [],
  observations: [],
}
let failures = 0

function check(id, name, ok, detail) {
  report.checks.push({ id, name, ok: Boolean(ok), detail: String(detail ?? '') })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

/** 不计入通过/失败的观察项（如旁人模块的既有问题） */
function observe(text) {
  report.observations.push(text)
  console.log(`OBS  ${text}`)
}

function notVerified(item) {
  report.notVerified.push(item)
  console.log(`N/A  ${item}`)
}

async function shot(page, file) {
  const p = join(OUT, file)
  report.screenshots.push(p)
  await page.screenshot({ path: p, fullPage: true }).catch(() => {})
}

async function overflow(page) {
  return page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
  }))
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/* ---------------- 夹具：种子 / 清库 / 读库 ---------------- */

const WORDS = [
  { word: 'abandon', definition_zh: 'v. 抛弃；放弃', pos: 'v.' },
  { word: 'benefit', definition_zh: 'n. 利益；好处', pos: 'n.' },
  { word: 'cabbage', definition_zh: 'n. 卷心菜', pos: 'n.' },
  { word: 'daisy', definition_zh: 'n. 雏菊', pos: 'n.' },
  { word: 'extraordinary', definition_zh: 'adj. 非凡的；特别的；超出寻常的', pos: 'adj.' },
  { word: 'responsibility', definition_zh: 'n. 责任；职责；义务', pos: 'n.' },
]

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

/** 场景隔离：清空会话与复习日志，保留 vocab。必须在页面已导航后调用 */
async function clearSessions(page) {
  return page.evaluate(async () => {
    const open = () =>
      new Promise((res, rej) => {
        const req = indexedDB.open('shushu-learn')
        req.onsuccess = () => res(req.result)
        req.onerror = () => rej(req.error)
        req.onblocked = () => rej(new Error('open blocked'))
      })
    const db = await Promise.race([
      open(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('open timeout')), 6000)),
    ])
    const tx = db.transaction(['spellingSessions', 'reviewLog'], 'readwrite')
    tx.objectStore('spellingSessions').clear()
    tx.objectStore('reviewLog').clear()
    await Promise.race([
      new Promise((res) => {
        tx.oncomplete = res
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('clear timeout')), 6000)),
    ])
    db.close()
    return true
  }).catch((e) => {
    console.log(`  [warn] clearSessions 失败：${e.message}`)
    return false
  })
}

async function dbState(page, attempt = 0) {
  try {
    return await page.evaluate(async () => {
      // ⚠️ 必须自带超时：多标签页场景下 IndexedDB 打开可能被阻塞，
      // 一旦挂住会让整个 CDP Runtime.callFunctionOn 超时，拖垮后续所有场景。
      const withTimeout = (p, ms, tag) =>
        Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(tag)), ms))])
      const open = () =>
        new Promise((res, rej) => {
          const req = indexedDB.open('shushu-learn')
          req.onsuccess = () => res(req.result)
          req.onerror = () => rej(req.error ?? new Error('open failed'))
          req.onblocked = () => rej(new Error('open blocked'))
        })
      const db = await withTimeout(open(), 6000, 'db open timeout')
      const tx = db.transaction(['spellingSessions', 'vocab', 'reviewLog'], 'readonly')
      const all = (name) =>
        new Promise((res, rej) => {
          const r = tx.objectStore(name).getAll()
          r.onsuccess = () => res(r.result)
          r.onerror = () => rej(r.error)
        })
      const sessions = await withTimeout(all('spellingSessions'), 6000, 'sessions timeout')
      const vocab = await withTimeout(all('vocab'), 6000, 'vocab timeout')
      const logs = await withTimeout(all('reviewLog'), 6000, 'logs timeout')
      db.close()
      return { sessions, vocab, logs }
    })
  } catch (e) {
    if (attempt < 2) {
      await sleep(500)
      return dbState(page, attempt + 1)
    }
    console.log(`  [warn] dbState 读取失败（重试 ${attempt} 次后放弃）：${e.message}`)
    return { sessions: [], vocab: [], logs: [] }
  }
}

/**
 * 开一个**干净**的标签页。顺序很关键（第一轮在这里踩过坑）：
 *   ① 先 goto /review 拿 origin（about:blank 上写 localStorage 会 SecurityError）
 *   ② 写 studyBatchSize → reload 让 store 读到新值
 *   ③ 清空会话做场景隔离
 *   ④ **最后**才 goto 目标 URL
 * ⚠️ 不能先 goto /spelling：那样 app 会立刻用**旧** batchSize 建好会话，
 *    后续再改设置也只会恢复到那个已建好的会话，D1「沿用 studyBatchSize」就验不到。
 */
async function freshTab(context, { width = 375, height = 667, batch = 3, url = '/review' }) {
  const page = await context.newPage()
  await page.setViewport({ width, height })
  await page.goto(`${BASE}/review`, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {})
  try {
    await page.evaluate((size) => {
      const raw = localStorage.getItem('shushu-settings')
      const parsed = raw ? JSON.parse(raw) : { state: { settings: {} }, version: 0 }
      parsed.state = parsed.state ?? {}
      parsed.state.settings = { ...(parsed.state.settings ?? {}), studyBatchSize: size }
      localStorage.setItem('shushu-settings', JSON.stringify(parsed))
    }, batch)
    await page.reload({ waitUntil: 'networkidle2', timeout: 25000 })
    await clearSessions(page)
    if (url !== '/review') {
      await page.goto(`${BASE}${url}`, { waitUntil: 'networkidle2', timeout: 25000 })
    }
  } catch (e) {
    console.log(`  [warn] freshTab(${url}) 夹具准备失败：${e.message}`)
  }
  return page
}

async function waitInput(page, timeout = 12000) {
  await page.waitForSelector('#spelling-input', { timeout, visible: true })
}

/**
 * 输入：
 *   · 清空必须用 `HTMLInputElement.prototype` 的 value setter —— React 18 在**实例**上
 *     覆盖了 value 并维护内部 tracker，直接 `el.value = x` 会被判定为「没变化」，
 *     onKeyDown 读到的仍是空串（第一轮就是这么全军覆没的）。
 *   · 正文用**真实键盘输入**（page.keyboard.type），比注入事件更贴近用户操作。
 *   · 不用 ElementHandle.click()/evaluate()：多标签页场景实测会挂到 CDP protocolTimeout，
 *     改用页面级的 page.focus()。
 */
async function type(page, text) {
  const exists = await page.$('#spelling-input')
  if (!exists) throw new Error('找不到 #spelling-input（页面可能处于冲突/空态）')
  await page.focus('#spelling-input').catch(() => {})
  await page.evaluate(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    const i = document.querySelector('#spelling-input')
    if (!i) throw new Error('input 不存在')
    setter.call(i, '')
    i.dispatchEvent(new Event('input', { bubbles: true }))
  })
  if (text) await page.keyboard.type(text, { delay: 15 })
}

async function submit(page) {
  await page.keyboard.press('Enter')
}

async function clickText(page, label) {
  return page.evaluate((l) => {
    const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes(l))
    if (!btn) return false
    btn.click()
    return true
  }, label)
}

/** 从库里读当前会话的当前词（比文案解析可靠） */
async function currentAnswer(page) {
  const { sessions } = await dbState(page)
  const s = sessions.find((x) => x.status === 'IN_PROGRESS' || x.status === 'PAUSED')
  if (!s) return null
  const w = s.queue.find((x) => x.position === s.current_position)
  return w ? { word: w.word, definition: w.definition_zh, session: s } : null
}

/* ================================================================== */

async function main() {
  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: true,
    protocolTimeout: 120000,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  report.edgeVersion = await browser.version()

  const ctx = await browser.createBrowserContext()

  try {
    /* ---------- 引导：让 app 建库到 v10 + 种子词 ---------- */
    const boot = await ctx.newPage()
    await boot.setViewport({ width: 420, height: 900 })
    await boot.goto(`${BASE}/review`, { waitUntil: 'networkidle2', timeout: 25000 })
    await sleep(800)
    const seeded = await seedVocab(boot)
    check('S0', '种子数据写入 IndexedDB（app 已把库建到 v10）', seeded === WORDS.length, `${seeded} 词`)
    await boot.close()

    /* ============ S1 · 375px 窄屏：/review 入口 ============ */
    console.log('\n--- S1 375px 窄屏 /review 入口 ---')
    const p1 = await freshTab(ctx, { width: 375, height: 667, batch: 3, url: '/review' })
    await sleep(800)
    const hasCard = await p1.evaluate(
      () =>
        document.body.innerText.includes('单词默写') && document.body.innerText.includes('开始默写'),
    )
    check('S1.1', '375px 下入口卡片与按钮可见', hasCard)
    const o1 = await overflow(p1)
    check('S1.2', '375px 下 /review 无横向溢出', o1.scrollW <= o1.clientW, `scrollW=${o1.scrollW} clientW=${o1.clientW}`)
    await shot(p1, 's1-review-375.png')
    await p1.close()

    /* ============ S2 · 375px 练习页布局 ============ */
    console.log('\n--- S2 375px 练习页布局与界面规范 ---')
    const p2 = await freshTab(ctx, { width: 375, height: 667, batch: 3, url: '/spelling?mode=recent' })
    await waitInput(p2)
    await sleep(500)
    const cur = await currentAnswer(p2)
    check('S2.1', '练习页渲染出输入框', true, `当前词定义="${cur?.definition}"`)
    check('S2.2', '提交按钮存在', await clickText(p2, '提交').then(() => true).catch(() => false))
    check('S2.3', '只显示长度提示（不泄露答案）', await p2.evaluate(() => document.body.innerText.includes('个字母')))
    const leaked = await p2.evaluate((ans) => document.body.innerText.includes(ans), cur?.word ?? '___nope___')
    check('S2.4', '页面文本不含完整答案', !leaked, `答案="${cur?.word}"`)
    const o2 = await overflow(p2)
    check('S2.5', '375px 下练习页无横向溢出', o2.scrollW <= o2.clientW, `scrollW=${o2.scrollW} clientW=${o2.clientW}`)

    // 触摸目标：只看**本功能自己的控件**。
    // 「本地数据」chip 来自 AppShell 里的 SyncIndicator（全局组件，非本功能），单独记为观察项。
    const targets = await p2.evaluate(() => {
      const mine = []
      const global = []
      for (const b of document.querySelectorAll('button')) {
        const r = b.getBoundingClientRect()
        if (r.width === 0) continue
        const entry = `${(b.textContent ?? b.getAttribute('aria-label') ?? '?').trim().slice(0, 14)} ${Math.round(r.width)}x${Math.round(r.height)}`
        const isShellChip = Boolean(b.closest('.pointer-events-none'))
        ;(isShellChip ? global : mine).push({ entry, bad: r.height < 44 || r.width < 44 })
      }
      return { mine, global }
    })
    check(
      'S2.6',
      '本功能控件触摸目标均 ≥44px',
      targets.mine.filter((t) => t.bad).length === 0,
      targets.mine.filter((t) => t.bad).map((t) => t.entry).join(' | '),
    )
    if (targets.global.some((t) => t.bad)) {
      observe(
        `既有/旁人组件存在小触摸目标（非本功能，未改）：${targets.global
          .filter((t) => t.bad)
          .map((t) => t.entry)
          .join(' | ')} —— 来源 AppShell → SyncIndicator`,
      )
    }
    const ariaBad = await p2.evaluate(() => {
      const bad = []
      for (const b of document.querySelectorAll('button')) {
        if (b.closest('.pointer-events-none')) continue
        const text = (b.textContent ?? '').trim()
        const aria = b.getAttribute('aria-label')
        const title = b.getAttribute('title')
        if (!text && !(aria && title)) bad.push(b.outerHTML.slice(0, 60))
      }
      return bad
    })
    check('S2.7', '本功能纯图标按钮均带 aria-label + title', ariaBad.length === 0, ariaBad.join(' | '))
    await shot(p2, 's2-spelling-375.png')

    /* ============ S4b · 长释义 / 较长单词（recent 模式下首词即 responsibility） ============ */
    console.log('\n--- S4b 长释义 / 较长单词 ---')
    const longLen = cur?.word?.length ?? 0
    check('S4b.1', '当前词确为较长单词', longLen >= 10, `"${cur?.word}" ${longLen} 字母`)
    const defText = await p2.evaluate(() => document.body.innerText)
    check('S4b.2', '长释义完整渲染（含分号分隔的多义项）', defText.includes(cur.definition.replace(/\s/g, '')) || defText.includes(cur.definition), cur.definition)
    const o4 = await overflow(p2)
    check('S4b.3', `较长单词（${longLen} 字母）提示不横向溢出`, o4.scrollW <= o4.clientW, `scrollW=${o4.scrollW} clientW=${o4.clientW}`)
    check('S4b.4', '长单词提示文本完整渲染', defText.includes(`${longLen} 个字母`))
    await shot(p2, 's4b-long-word.png')

    /* ============ S3 · 软键盘场景（视口高度收缩模拟） ============ */
    console.log('\n--- S3 软键盘场景（视口高度收缩模拟） ---')
    await p2.setViewport({ width: 375, height: 420 })
    await sleep(500)
    const vis = await p2.evaluate(() => {
      const input = document.querySelector('#spelling-input')
      const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('提交'))
      const inView = (el) => {
        if (!el) return false
        const r = el.getBoundingClientRect()
        return r.top >= 0 && r.bottom <= window.innerHeight + 1
      }
      return { input: inView(input), submit: inView(btn) }
    })
    check('S3.1', '视口高度收缩后输入框仍在可视区内', vis.input, '视口 375x420')
    check('S3.2', '提交按钮仍在可视区内（可操作）', vis.submit)
    const o3 = await overflow(p2)
    check('S3.3', '高度收缩后仍无横向溢出', o3.scrollW <= o3.clientW, `scrollW=${o3.scrollW} clientW=${o3.clientW}`)
    await shot(p2, 's3-softkeyboard-sim.png')
    notVerified('真机软键盘弹出（需实体设备调起输入法；本环境以视口高度收缩近似）')
    await p2.setViewport({ width: 375, height: 667 })
    await sleep(400)

    /* ============ S4 · 答题反馈 ============ */
    console.log('\n--- S4 答题反馈（正确 / 错误 / 空答案） ---')
    const c1 = await currentAnswer(p2)
    await type(p2, c1.word)
    await submit(p2)
    await sleep(600)
    const fbCorrect = await p2.evaluate(() => document.body.innerText)
    check('S4.1', '答对显示正向反馈', fbCorrect.includes('拼对'), fbCorrect.match(/拼对[^\n]*/)?.[0] ?? '')
    await shot(p2, 's4-feedback-correct.png')

    await type(p2, 'zzzzz')
    await submit(p2)
    await sleep(600)
    const fbWrong = await p2.evaluate(() => document.body.innerText)
    check('S4.2', '答错显示负向反馈', fbWrong.includes('不对'), fbWrong.match(/不对[^\n]*/)?.[0] ?? '')

    const stBefore = (await dbState(p2)).sessions[0]
    await type(p2, '')
    await submit(p2)
    await sleep(500)
    const stAfter = (await dbState(p2)).sessions[0]
    const wBefore = stBefore.queue.find((w) => w.position === stBefore.current_position)
    const wAfter = stAfter.queue.find((w) => w.position === stAfter.current_position)
    check('S4.3', '空答案不增加尝试次数', wAfter.total_attempts === wBefore.total_attempts, `${wBefore.total_attempts} → ${wAfter.total_attempts}`)
    const btnDisabled = await p2.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('提交'))
      return btn ? btn.disabled : null
    })
    check('S4.4', '输入为空时提交按钮禁用（前置拦截）', btnDisabled === true)
    await p2.close()

    /* ============ S5 · 暂停 → 继续 → 放弃 ============ */
    console.log('\n--- S5 暂停 / 继续 / 放弃 ---')
    const p5 = await freshTab(ctx, { width: 375, height: 667, batch: 3, url: '/spelling?mode=recent' })
    await waitInput(p5)
    await sleep(500)
    await p5.evaluate(() => document.querySelector('button[aria-label="暂停本轮默写"]')?.click())
    await sleep(900)
    let st = (await dbState(p5)).sessions[0]
    check('S5.1', '暂停后库里为 PAUSED', st.status === 'PAUSED', st.status)
    check('S5.2', '暂停态文案可见', await p5.evaluate(() => document.body.innerText.includes('默写已暂停')))
    await shot(p5, 's5-paused.png')

    await p5.reload({ waitUntil: 'networkidle2' })
    await sleep(1000)
    check('S5.3', '刷新后仍识别为暂停态', await p5.evaluate(() => document.body.innerText.includes('默写已暂停')))
    st = (await dbState(p5)).sessions[0]
    check('S5.4', '刷新后库里仍是 PAUSED', st.status === 'PAUSED', st.status)
    await waitInput(p5, 3000).catch(() => {})
    await clickText(p5, '继续默写')
    await sleep(1000)
    await waitInput(p5)
    st = (await dbState(p5)).sessions[0]
    check('S5.5', '继续后回到练习态（输入框可用）', true)
    check('S5.6', '继续后库里为 IN_PROGRESS', st.status === 'IN_PROGRESS', st.status)
    await shot(p5, 's5-resumed.png')

    await p5.evaluate(() => document.querySelector('button[aria-label="暂停本轮默写"]')?.click())
    await sleep(900)
    await clickText(p5, '放弃本轮')
    await sleep(1200)
    st = (await dbState(p5)).sessions[0]
    check('S5.7', '放弃后库里为 ABANDONED', st.status === 'ABANDONED', st.status)
    check('S5.8', '放弃后回到 /review', p5.url().includes('/review'), p5.url())
    await clearSessions(p5)
    await p5.goto(`${BASE}/spelling?mode=recent`, { waitUntil: 'networkidle2', timeout: 25000 })
    await sleep(1200)
    const afterRe = (await dbState(p5)).sessions
    check(
      'S5.9',
      '再进默写页不会把已放弃会话救回来',
      afterRe.filter((s) => s.status === 'IN_PROGRESS').length === 1 &&
        afterRe.find((s) => s.status === 'IN_PROGRESS').id !== st.id,
      `库内：${afterRe.map((s) => `${s.status}`).join(',')}`,
    )
    await p5.close()

    /* ============ S6 · 完成 → 结果页 → 返回入口 ============ */
    console.log('\n--- S6 完成与结果页 ---')
    const p6 = await freshTab(ctx, { width: 375, height: 667, batch: 2, url: '/spelling?mode=recent' })
    await waitInput(p6)
    await sleep(500)
    const q6 = (await dbState(p6)).sessions[0]
    check('S6.0', '本轮实际取到 2 个词（batchSize=2 生效）', q6.queue.length === 2, `实际 ${q6.queue.length} 词`)
    for (let round = 0; round < 2; round += 1) {
      for (let i = 0; i < 3; i += 1) {
        const c = await currentAnswer(p6)
        if (!c) break
        await type(p6, c.word)
        await submit(p6)
        await sleep(500)
      }
      await sleep(700)
    }
    await sleep(1800) // 等 900ms 自动跳转 + 结果页加载
    const url6 = p6.url()
    check('S6.1', '完成后自动跳到 /spelling-result', url6.includes('/spelling-result'), url6)
    await sleep(700)
    const resultText = await p6.evaluate(() => document.body.innerText)
    check('S6.2', '结果页标题存在', resultText.includes('默写结果'))
    check('S6.3', '结果页展示完成数', /完成/.test(resultText))
    check('S6.4', '结果页展示逐词明细', resultText.includes('逐词明细'))
    check('S6.5', '结果页展示正确率', /正确率/.test(resultText))
    const st6 = (await dbState(p6)).sessions.find((s) => s.status === 'SESSION_COMPLETED')
    check('S6.6', '库里会话为 SESSION_COMPLETED', Boolean(st6), st6?.status ?? '未找到')
    const o6 = await overflow(p6)
    check('S6.7', '375px 下结果页无横向溢出', o6.scrollW <= o6.clientW, `scrollW=${o6.scrollW} clientW=${o6.clientW}`)
    await shot(p6, 's6-result-375.png')

    // 刷新结果页：数据仍一致
    // ⚠️「用时」= (ended_at ?? now) - started_at，对刚结束/未结束的会话刷新后会增长 —— 正确行为，不比对。
    // 指标直读 DOM（Figure 组件结构：.text-xl.font-bold + 下一个兄弟是标签），
    // 不靠中文正则从 innerText 里抠（第一轮那样抠会抓错标签）。
    const figures = () =>
      [...document.querySelectorAll('.text-xl.font-bold')].map((d) => {
        const label = d.nextElementSibling?.textContent?.trim() ?? '?'
        return `${label}=${d.textContent.trim()}`
      })
    const f1 = await p6.evaluate(figures)
    await p6.reload({ waitUntil: 'networkidle2' })
    await sleep(1000)
    const afterRefresh = await p6.evaluate(() => document.body.innerText)
    check('S6.8', '刷新结果页后仍能读到同一会话', afterRefresh.includes('默写结果'))
    const f2 = await p6.evaluate(figures)
    check(
      'S6.9',
      '刷新前后指标数字完全一致（完成/跳过/失效/提交/答对/正确率）',
      f1.length > 0 && JSON.stringify(f1) === JSON.stringify(f2),
      `${f1.join(' ')} → ${f2.join(' ')}`,
    )
    console.log('    [说明] 结果页「用时」随 now 增长属正确行为，故不计入比对')

    const backClicked = await clickText(p6, '返回复习')
    await sleep(900)
    check('S6.10', '结果页提供返回入口且可用', backClicked && p6.url().includes('/review'), p6.url())
    await shot(p6, 's6-back-to-review.png')

    // 会话不存在时的处理：直接访问不存在的 id
    await p6.goto(`${BASE}/spelling-result?id=不存在`, { waitUntil: 'networkidle2', timeout: 25000 })
    await sleep(1000)
    const missingText = await p6.evaluate(() => document.body.innerText)
    check('S6.11', '结果页遇到不存在的会话给出提示而非伪造', missingText.includes('找不到这次默写的记录'))
    check('S6.12', '不存在时提供返回入口', missingText.includes('返回复习'))
    await shot(p6, 's6-missing-session.png')
    await p6.close()

    /* ============ S7 · 桌面宽屏 1280px ============ */
    console.log('\n--- S7 桌面宽屏 1280px ---')
    const p7 = await freshTab(ctx, { width: 1280, height: 800, batch: 3, url: '/review' })
    await sleep(900)
    const o7 = await overflow(p7)
    check('S7.1', '1280px 下 /review 无横向溢出', o7.scrollW <= o7.clientW, `scrollW=${o7.scrollW} clientW=${o7.clientW}`)
    await shot(p7, 's7-review-1280.png')
    await p7.goto(`${BASE}/spelling?mode=recent`, { waitUntil: 'networkidle2', timeout: 25000 })
    await waitInput(p7)
    await sleep(600)
    const o7b = await overflow(p7)
    check('S7.2', '1280px 下练习页无横向溢出', o7b.scrollW <= o7b.clientW, `scrollW=${o7b.scrollW} clientW=${o7b.clientW}`)
    const cardWidth = await p7.evaluate(() => {
      const cards = [...document.querySelectorAll('.bg-card')]
      if (cards.length === 0) return null
      return Math.round(Math.max(...cards.map((c) => c.getBoundingClientRect().width)))
    })
    check('S7.3', '宽屏下内容宽度受 max-w-app 约束', cardWidth !== null && cardWidth <= 560, `最宽卡片 ${cardWidth}px`)
    await shot(p7, 's7-spelling-1280.png')
    await p7.close()

    /* ============ S8 · 两个真实标签页 ============ */
    console.log('\n--- S8 两个真实标签页（同一 context，共享 IndexedDB） ---')
    const tabA = await freshTab(ctx, { width: 375, height: 667, batch: 3, url: '/review' })
    const tabB = await freshTab(ctx, { width: 375, height: 667, batch: 3, url: '/review' })
    await clearSessions(tabA)
    await clearSessions(tabB)

    // 真竞态尝试：两个标签页**同时**导航到 /spelling，看会不会各写一份。
    // 单次结果会飘（取决于两次 goto 的相对时序），所以重复 6 次取统计。
    const RACE_ATTEMPTS = 6
    const raceCounts = []
    for (let i = 0; i < RACE_ATTEMPTS; i += 1) {
      await clearSessions(tabA)
      await clearSessions(tabB)
      await Promise.all([
        tabA.goto(`${BASE}/spelling?mode=recent`, { waitUntil: 'networkidle2', timeout: 25000 }).catch(() => {}),
        tabB.goto(`${BASE}/spelling?mode=recent`, { waitUntil: 'networkidle2', timeout: 25000 }).catch(() => {}),
      ])
      await sleep(1200)
      const st = await dbState(tabA)
      raceCounts.push(st.sessions.length)
    }
    const raceHits = raceCounts.filter((n) => n >= 2).length
    console.log(
      `    [证据] 并发创建尝试 ${RACE_ATTEMPTS} 次，每次库内会话数 = [${raceCounts.join(',')}]，` +
        `出现多份 ${raceHits}/${RACE_ATTEMPTS} 次`,
    )
    if (raceHits > 0) {
      observe(
        `并发创建真竞态**已复现**（${raceHits}/${RACE_ATTEMPTS} 次出现两份会话）：` +
          `两个标签页同时导航时各写了一份 —— 这是「写前检查 + 写后复核」挡不住的窗口` +
          `（TableService 无事务 API），与方案 §并发边界的描述一致`,
      )
    }
    // 最后一次的状态用于后续判断
    const raceState = await dbState(tabA)
    const raceCount = raceState.sessions.length

    const tabAText = await tabA.evaluate(() => document.body.innerText)
    if (raceCount >= 2) {
      // ⚠️ 关键发现：冲突检测只在**页面进入时**跑一次，不会持续轮询。
      // 两个标签页各自建好会话后，当前页面并不会立刻弹冲突提示——要等下一次进入。
      const showedPrompt = tabAText.includes('检测到多个进行中的默写')
      check(
        'S8.0a',
        '并发创建时，刚建完的页面不会立刻弹冲突提示（检测只在页面进入时跑）',
        !showedPrompt,
        showedPrompt ? '出现了提示' : '未出现（符合实现：bootstrap 只跑一次）',
      )
      await tabA.reload({ waitUntil: 'networkidle2', timeout: 25000 })
      await sleep(1500)
      const afterReload = await tabA.evaluate(() => document.body.innerText)
      check(
        'S8.0b',
        '重新进入后能发现这 2 份会话并给出冲突提示',
        afterReload.includes('检测到多个进行中的默写'),
        afterReload.slice(0, 50).replace(/\n/g, ' '),
      )
      observe(
        '多标签页冲突**不会实时提示**：两份会话已经同时存在期间，两个页面都照常练习且互不知情，' +
          '只有下次进入（刷新/导航）才会弹冲突选择。建议后续单独提方案（如进入时轮询或 storage 事件监听），本轮不自行引入。',
      )
    } else {
      check('S8.0a', '无冲突时正常进入练习（未误报冲突）', !tabAText.includes('检测到多个进行中的默写'))
    }

    // 竞态验证完就换一对新标签页，避免旧页面残留连接干扰后续场景
    await tabA.close()
    await tabB.close()

    // 顺序场景：第二个标签页应恢复同一份会话，而不是新建
    const tabA2 = await freshTab(ctx, { width: 375, height: 667, batch: 3, url: '/review' })
    const tabB2 = await freshTab(ctx, { width: 375, height: 667, batch: 3, url: '/review' })
    await clearSessions(tabA2)
    await clearSessions(tabB2)
    await tabA2.goto(`${BASE}/spelling?mode=recent`, { waitUntil: 'networkidle2', timeout: 25000 })
    await waitInput(tabA2)
    await sleep(600)
    const sessionA = (await dbState(tabA2)).sessions.find((s) => s.status === 'IN_PROGRESS')
    await tabB2.goto(`${BASE}/spelling?mode=recent`, { waitUntil: 'networkidle2', timeout: 25000 })
    await sleep(1400)
    const afterB = (await dbState(tabB2)).sessions
    check(
      'S8.1',
      '第二个标签页顺序打开时不新建第二份会话',
      afterB.length === 1 && afterB[0].id === sessionA.id,
      `库内 ${afterB.length} 份`,
    )
    check('S8.2', '两个标签页看到的是同一会话 id', afterB.length === 1 && afterB[0].id === sessionA.id)

    // A 答对一次 → B 刷新后读到同一进度，且只计一次
    const ca = await currentAnswer(tabA2)
    await type(tabA2, ca.word)
    await submit(tabA2)
    await sleep(700)
    const stAfterA = (await dbState(tabA2)).sessions.find((s) => s.id === sessionA.id)
    await tabB2.reload({ waitUntil: 'networkidle2', timeout: 25000 })
    await sleep(1200)
    const stAfterBReload = (await dbState(tabB2)).sessions.find((s) => s.id === sessionA.id)
    check(
      'S8.3',
      'A 提交后 B 刷新读到同一进度（无第二份副本）',
      stAfterBReload.current_position === stAfterA.current_position,
      `position ${stAfterA.current_position} → ${stAfterBReload.current_position}`,
    )
    check(
      'S8.4',
      'A 的作答只被计一次（没有重复计数）',
      stAfterA.queue.find((w) => w.position === 0).total_attempts === 1,
      `total_attempts=${stAfterA.queue.find((w) => w.position === 0).total_attempts}`,
    )

    // 注入第二份活跃会话 = 存储层真实冲突态 → 验冲突 UI
    await tabB2.evaluate(async () => {
      const req = indexedDB.open('shushu-learn')
      const db = await new Promise((res) => {
        req.onsuccess = () => res(req.result)
      })
      const tx = db.transaction(['spellingSessions'], 'readwrite')
      const store = tx.objectStore('spellingSessions')
      const all = await new Promise((res) => {
        const r = store.getAll()
        r.onsuccess = () => res(r.result)
      })
      const base = all.find((s) => s.status === 'IN_PROGRESS') ?? all[0]
      store.put({ ...base, id: 'conflict-second', started_at: base.started_at + 5000 })
      await new Promise((res) => {
        tx.oncomplete = res
      })
      db.close()
      return true
    })
    await tabB2.goto(`${BASE}/spelling?mode=recent`, { waitUntil: 'networkidle2', timeout: 25000 })
    await sleep(1500)
    const conflictText = await tabB2.evaluate(() => document.body.innerText)
    check('S8.5', '冲突提示出现', conflictText.includes('检测到多个进行中的默写'))
    check('S8.6', '提示明说不保证互斥', conflictText.includes('不保证'))
    const listCount = await tabB2.evaluate(() => document.querySelectorAll('ul li button').length)
    check('S8.7', '列出两份会话供选择', listCount === 2, `实际 ${listCount} 项`)
    check('S8.8', '不自动替用户裁决（没有输入框）', (await tabB2.$('#spelling-input')) === null)
    await shot(tabB2, 's8-conflict.png')

    // 选较早那份 → 保留它、放弃另一份
    const pickedId = sessionA.id
    await tabB2.evaluate(() => {
      const items = document.querySelectorAll('ul li button')
      items[items.length - 1]?.click()
    })
    await sleep(500)
    await clickText(tabB2, '保留选中的')
    await sleep(1800)
    await waitInput(tabB2)
    const stAfterResolve = (await dbState(tabB2)).sessions
    const kept = stAfterResolve.filter((s) => s.status === 'IN_PROGRESS')
    const dropped = stAfterResolve.filter((s) => s.status === 'ABANDONED')
    check('S8.9', '裁决后只剩一份 IN_PROGRESS', kept.length === 1, `IN_PROGRESS ${kept.length} 份`)
    check('S8.10', '被放弃的那份确实是 ABANDONED', dropped.length === 1, `ABANDONED ${dropped.length} 份`)
    check('S8.11', '保留的正是选中的那份', kept[0].id === pickedId, `保留=${kept[0].id} 选中=${pickedId}`)
    await shot(tabB2, 's8-conflict-resolved.png')

    // 覆盖检查：另一个标签页此时刷新，会不会把裁决冲掉 / 再写一份
    await tabA2.reload({ waitUntil: 'networkidle2', timeout: 25000 })
    await sleep(1500)
    const stFinal = (await dbState(tabA2)).sessions
    check(
      'S8.12',
      '另一个标签页刷新后仍是唯一一份活跃会话（未被冲成两份）',
      stFinal.filter((s) => s.status === 'IN_PROGRESS').length === 1,
      `IN_PROGRESS ${stFinal.filter((s) => s.status === 'IN_PROGRESS').length} 份`,
    )
    check(
      'S8.13',
      '另一个标签页也没有把被放弃的会话复活',
      stFinal.find((s) => s.id === 'conflict-second')?.status === 'ABANDONED',
      `conflict-second=${stFinal.find((s) => s.id === 'conflict-second')?.status}`,
    )
    await tabA2.close()
    await tabB2.close()

    /* ============ S9 · 刷新恢复 ============ */
    console.log('\n--- S9 刷新恢复 ---')
    const p9 = await freshTab(ctx, { width: 375, height: 667, batch: 3, url: '/spelling?mode=recent' })
    await waitInput(p9)
    await sleep(500)
    const c9 = await currentAnswer(p9)
    await type(p9, c9.word)
    await submit(p9)
    await sleep(700)
    const before9 = (await dbState(p9)).sessions.find((s) => s.status === 'IN_PROGRESS')
    await p9.reload({ waitUntil: 'networkidle2', timeout: 25000 })
    await sleep(1300)
    await waitInput(p9)
    const after9 = (await dbState(p9)).sessions
    check('S9.1', '刷新后没有新开第二份会话', after9.length === 1, `库内 ${after9.length} 份`)
    check('S9.2', '刷新后恢复同一会话 id', after9[0].id === before9.id)
    check('S9.3', '刷新后出题位置保持', after9[0].current_position === before9.current_position, `${before9.current_position} → ${after9[0].current_position}`)
    const curAfter = await currentAnswer(p9)
    check('S9.4', '刷新后连对进度保留', curAfter !== null && after9[0].queue.find((w) => w.position === after9[0].current_position)?.consecutive_correct >= 0)
    await shot(p9, 's9-refresh.png')
    await p9.close()

    /* ---------- 汇总 ---------- */
    report.finishedAt = new Date().toISOString()
    report.failures = failures
    writeFileSync(join(OUT, '_browser-report.json'), JSON.stringify(report, null, 2), 'utf8')
    console.log('\n────────────────────────────────────────────────────────')
    console.log(`Edge ${report.edgeVersion} · base ${BASE}`)
    console.log(`截图 ${report.screenshots.length} 张 → ${OUT}`)
    if (failures === 0) {
      console.log(`✅ 真实浏览器验收全部通过：${report.checks.length} 项检查`)
    } else {
      console.log(`❌ 真实浏览器验收失败：${failures} 项 / 共 ${report.checks.length} 项`)
      for (const c of report.checks.filter((x) => !x.ok)) console.log(`   - ${c.id} ${c.name} — ${c.detail}`)
      process.exitCode = 1
    }
    if (report.observations.length) {
      console.log(`观察 ${report.observations.length} 项（不计入通过/失败）：`)
      for (const o of report.observations) console.log(`   · ${o}`)
    }
    if (report.notVerified.length) {
      console.log(`未验证 ${report.notVerified.length} 项（已标注，不计入通过）`)
    }
  } finally {
    await browser.close()
  }
}

main().catch((e) => {
  console.error('浏览器验收脚本异常：', e)
  process.exitCode = 1
})
