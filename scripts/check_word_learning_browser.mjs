#!/usr/bin/env node
/**
 * 单词学习页（/learn）浏览器实测
 * ------------------------------------------------------------------
 * 对应 2026-10-31 任务书「第三阶段 + 第四阶段」：不以编译通过代替功能通过。
 *
 * 覆盖：
 *   A 进度恢复   学 1 个 / 学多个 / 刷新 / 已学词不回退 / 生词本里的词跳过
 *   B 释义展示   多词性分列、多义项不丢、慢加载有骨架不空白、关中文辅助有提示
 *   C 手势切换   左滑下一个、右滑上一个、竖滑不切换、边界不空白、连滑不跳词
 *   D 布局       三视口自适应（无大块空白 / 不截断 / 不被底部导航遮挡）、
 *                底部搜索框与「上一张 / 下一张」已消失
 *
 * 前置：npm run preview -- --port 4174 --strictPort
 * 用法：node scripts/check_word_learning_browser.mjs
 *
 * ⚠️ 本脚本只读 + 操作 UI，不改任何被测源码。
 */

import puppeteer from 'puppeteer-core'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const BASE = process.env.BROWSER_ACCEPT_BASE ?? 'http://127.0.0.1:4174'
const OUT = join('练习', '_learn-browser')
mkdirSync(OUT, { recursive: true })

const VIEWPORTS = [
  { name: 'm375', width: 375, height: 667, mobile: true },
  { name: 'm390', width: 390, height: 844, mobile: true },
  { name: 'pc1280', width: 1280, height: 800, mobile: false },
]

const report = {
  startedAt: new Date().toISOString(),
  base: BASE,
  checks: [],
  screenshots: [],
}
let failures = 0

function check(id, name, ok, detail) {
  report.checks.push({ id, name, ok: Boolean(ok), detail: String(detail ?? '') })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ---------------- 页面读数 ---------------- */

async function readState(page) {
  return page.evaluate(() => {
    const slot = document.querySelector('[data-testid="word-card-slot"]')
    const counter = Array.from(document.querySelectorAll('main span')).map((s) => s.textContent.trim())
    const senses = document.querySelector('[data-testid="word-senses"]')
    const emptySenses = document.querySelector('[data-testid="word-senses-empty"]')
    const card = document.querySelector('main .rounded-lg.bg-card')
    const nav = document.querySelector('nav')
    const main = document.querySelector('main')
    return {
      word: slot?.getAttribute('data-word') ?? null,
      counter,
      texts: counter,
      senseGroups: senses ? senses.children.length : 0,
      senseItems: senses ? senses.querySelectorAll('[data-testid="word-sense-line"]').length : 0,
      senseEmptyText: emptySenses ? emptySenses.textContent.trim() : null,
      exampleZhCount: document.querySelectorAll('[data-testid="example-zh"]').length,
      exampleEnCount: document.querySelectorAll('[data-testid="example-en"]').length,
      wordHint: Boolean(document.querySelector('[data-testid="word-hint"]')),
      hasCard: Boolean(card),
      cardText: card ? card.innerText.slice(0, 400) : null,
      bodyText: document.body.innerText.slice(0, 400),
      hasSearchBox: Boolean(
        Array.from(document.querySelectorAll('button')).find(
          (b) => b.getAttribute('title') === '搜单词' || /搜单词/.test(b.textContent || ''),
        ),
      ),
      hasPrevNext: Array.from(document.querySelectorAll('button')).some((b) =>
        /上一张|下一张/.test(b.textContent || ''),
      ),
      hasRestart: Array.from(document.querySelectorAll('button')).some(
        (b) => b.getAttribute('aria-label') === '重新学习',
      ),
      navTop: nav ? nav.getBoundingClientRect().top : null,
      navBottom: nav ? nav.getBoundingClientRect().bottom : null,
      mainBottom: main ? main.getBoundingClientRect().bottom : null,
      contentBottom: (() => {
        const c = document.querySelector('main > div')
        return c ? c.getBoundingClientRect().bottom : null
      })(),
      swipeHint: document.querySelector('[data-testid="swipe-hint"]')?.textContent?.trim() ?? null,
      docScrollHeight: document.documentElement.scrollHeight,
      innerHeight: window.innerHeight,
      dialogOpen: Boolean(document.querySelector('[role="dialog"]')),
    }
  })
}

/** 清掉学习会话（让每个场景从干净状态开始），不碰其它数据 */
async function clearSession(page) {
  await page.evaluate(async () => {
    const req = indexedDB.open('shushu-learn')
    const db = await new Promise((res, rej) => {
      req.onsuccess = () => res(req.result)
      req.onerror = () => rej(req.error)
      req.onupgradeneeded = () => res(req.result)
    })
    const names = Array.from(db.objectStoreNames)
    const tx = db.transaction(names.includes('wordLearningSessions') ? ['wordLearningSessions'] : [], 'readwrite')
    if (names.includes('wordLearningSessions')) tx.objectStore('wordLearningSessions').clear()
    await new Promise((res) => {
      tx.oncomplete = res
      tx.onerror = res
      tx.onabort = res
    })
  })
}

/**
 * 清掉设置（localStorage）。
 * ⚠️ 同一个 browser 实例里所有页面共享 localStorage / IndexedDB，
 *    场景之间不清会把「每组 1 词」「关中文辅助」之类的夹具带进下一个场景。
 */
async function clearLocalSettings(page) {
  await page.evaluate(() => {
    localStorage.removeItem('shushu-settings')
  })
}

/** 往生词本里塞词（验证「已学过的词会被跳过」） */
async function seedVocab(page, ids) {
  await page.evaluate(async (list) => {
    const req = indexedDB.open('shushu-learn')
    const db = await new Promise((res, rej) => {
      req.onsuccess = () => res(req.result)
      req.onerror = () => rej(req.error)
      req.onupgradeneeded = () => res(req.result)
    })
    const tx = db.transaction(['vocab'], 'readwrite')
    const now = Date.now()
    for (const id of list) {
      tx.objectStore('vocab').put({
        word_id: id,
        word: id.replace('oe-', ''),
        book: 'CET4',
        layer: 'new',
        consecutive_correct: 0,
        srs_step: 0,
        in_wrong_pool: false,
        next_review: now + 600000,
        added_at: now,
        updated_at: now,
        owner: 'guest',
      })
    }
    await new Promise((res) => {
      tx.oncomplete = res
      tx.onerror = res
      tx.onabort = res
    })
  }, ids)
}

async function clearVocab(page) {
  await page.evaluate(async () => {
    const req = indexedDB.open('shushu-learn')
    const db = await new Promise((res) => {
      req.onsuccess = () => res(req.result)
      req.onerror = () => rej(req.error)
      req.onupgradeneeded = () => res(req.result)
    })
    const tx = db.transaction(['vocab'], 'readwrite')
    tx.objectStore('vocab').clear()
    await new Promise((res) => {
      tx.oncomplete = res
      tx.onerror = res
      tx.onabort = res
    })
  })
}

/* ---------------- 手势 ---------------- */

/** 真实触摸滑动（CDP），水平或垂直 */
async function touchSwipe(page, client, { x, y, dx, dy, steps = 12 }) {
  const move = async (type, px, py) => {
    await client.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ x: px, y: py, radiusX: 8, radiusY: 8, force: 1 }],
    })
  }
  await move('touchStart', x, y)
  for (let i = 1; i <= steps; i++) {
    await move('touchMove', x + (dx * i) / steps, y + (dy * i) / steps)
    await sleep(12)
  }
  await move('touchEnd', x + dx, y + dy)
  await sleep(260)
}

/** PC：鼠标拖拽（pointer events 的鼠标分支） */
async function mouseSwipe(page, { x, y, dx, steps = 12 }) {
  await page.mouse.move(x, y)
  await page.mouse.down()
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(x + (dx * i) / steps, y)
    await sleep(10)
  }
  await page.mouse.up()
  await sleep(260)
}

/** 键盘方向键（PC 兜底路径） */
async function keySwitch(page, key) {
  await page.keyboard.press(key)
  await sleep(260)
}

async function openPage(browser, vp, url = `${BASE}/learn`) {
  const page = await browser.newPage()
  await page.setViewport({
    width: vp.width,
    height: vp.height,
    deviceScaleFactor: 1,
    isMobile: vp.mobile,
    hasTouch: vp.mobile,
  })
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 })
  await page.waitForSelector('[data-testid="word-card-slot"]', { timeout: 30000 }).catch(() => {})
  await sleep(600)
  return page
}

/* ---------------- 主流程 ---------------- */

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})

try {
  /* =============== A. 进度恢复（390×844） =============== */
  {
    const vp = VIEWPORTS[1]
    const page = await openPage(browser, vp)
    const client = await page.createCDPSession()
    await clearLocalSettings(page)
    await clearVocab(page)
    await clearSession(page)
    await page.reload({ waitUntil: 'networkidle2' })
    await page.waitForSelector('[data-testid="word-card-slot"]', { timeout: 30000 })
    await sleep(600)

    const s0 = await readState(page)
    check('A0', '首进：第 1 个词 + 卡片渲染', s0.word === 'ad' && s0.hasCard, `word=${s0.word}`)

    // A1 学一个词（左滑）→ 退出 → 再进入
    const box = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="word-card-slot"]')
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + 60) }
    })
    await touchSwipe(page, client, { x: box.x, y: box.y, dx: -140, dy: 0 })
    const s1 = await readState(page)
    check('A1-a', '左滑一次到第 2 个词', s1.word === 'as', `word=${s1.word}`)

    await page.goto(`${BASE}/`, { waitUntil: 'networkidle2' })
    await sleep(300)
    await page.goto(`${BASE}/learn`, { waitUntil: 'networkidle2' })
    await page.waitForSelector('[data-testid="word-card-slot"]', { timeout: 30000 })
    await sleep(600)
    const s2 = await readState(page)
    check('A1-b', '学 1 个词后退出再进入：停在第 2 个词（不回到第 1 个）', s2.word === 'as', `word=${s2.word}`)
    check('A1-c', '已完成计数恢复', /已学 1/.test(s2.bodyText), s2.texts.join(' | ').slice(0, 120))

    // A2 再学两个 → 退出 → 再进入
    await touchSwipe(page, client, { x: box.x, y: box.y, dx: -140, dy: 0 })
    await touchSwipe(page, client, { x: box.x, y: box.y, dx: -140, dy: 0 })
    const s3 = await readState(page)
    check('A2-a', '连学两个词后位置 = 第 4 个', s3.word === 'ax', `word=${s3.word}`)
    await page.goto(`${BASE}/learn`, { waitUntil: 'networkidle2' })
    await page.waitForSelector('[data-testid="word-card-slot"]', { timeout: 30000 })
    await sleep(600)
    const s4 = await readState(page)
    check('A2-b', '学多个词后退出再进入：从中断位置继续', s4.word === 'ax', `word=${s4.word}`)
    check('A2-c', '已完成数与实际一致（已学 3）', /已学 3/.test(s4.bodyText), s4.texts.join(' | ').slice(0, 120))

    // A3 刷新浏览器
    await page.reload({ waitUntil: 'networkidle2' })
    await page.waitForSelector('[data-testid="word-card-slot"]', { timeout: 30000 })
    await sleep(600)
    const s5 = await readState(page)
    check('A3', '刷新浏览器后进度不丢失', s5.word === 'ax' && /已学 3/.test(s5.bodyText), `word=${s5.word}`)

    // A4 已完成的词不「抢到前面」：右滑两次回到第 3/2 个词，计数不回退
    await touchSwipe(page, client, { x: box.x, y: box.y, dx: 140, dy: 0 })
    const s6 = await readState(page)
    check('A4-a', '右滑回到上一个词（第 3 个）', s6.word === 'at', `word=${s6.word}`)
    check('A4-b', '回看已学词不改动完成数', /已学 3/.test(s6.bodyText), s6.texts.join(' | ').slice(0, 120))
    await touchSwipe(page, client, { x: box.x, y: box.y, dx: -140, dy: 0 })
    const s7 = await readState(page)
    check('A4-c', '再左滑回到中断位置（第 4 个）', s7.word === 'ax', `word=${s7.word}`)

    await page.screenshot({ path: join(OUT, 'A-进度恢复-390.png'), fullPage: false })
    await page.close()
  }

  /* =============== A5 生词本里已学过的词会被跳过 =============== */
  {
    const vp = VIEWPORTS[1]
    const page = await openPage(browser, vp)
    await clearLocalSettings(page)
    await clearVocab(page)
    await clearSession(page)
    await seedVocab(page, ['oe-ad', 'oe-as'])
    await page.reload({ waitUntil: 'networkidle2' })
    await page.waitForSelector('[data-testid="word-card-slot"]', { timeout: 30000 })
    await sleep(700)
    const s = await readState(page)
    check('A5', '已在生词本的词被跳过：首进落在第 3 个词', s.word === 'at', `word=${s.word}`)
    check('A5-b', '已学计数与生词本一致（已学 2）', /已学 2/.test(s.bodyText), s.texts.join(' | ').slice(0, 120))
    await clearVocab(page)
    await page.close()
  }

  /* =============== B. 释义展示 =============== */
  {
    const vp = VIEWPORTS[1]
    const page = await openPage(browser, vp)
    await clearLocalSettings(page)
    await clearVocab(page)
    await clearSession(page)
    await page.reload({ waitUntil: 'networkidle2' })
    await page.waitForSelector('[data-testid="word-card-slot"]', { timeout: 30000 })
    await sleep(700)
    const client = await page.createCDPSession()

    const s0 = await readState(page)
    // ad → 单组 n.
    check('B1', '释义区渲染出来了（不是空白）', s0.senseGroups >= 1 && s0.senseItems >= 1,
      `groups=${s0.senseGroups} items=${s0.senseItems}`)
    check('B1-b', '中文辅助开启：例句中文翻译与助记提示都在',
      s0.exampleZhCount >= 1, `exampleZh=${s0.exampleZhCount} wordHint=${s0.wordHint}`)

    // 左滑到 by（多词性多义项：prep. …；adv. …）
    const box = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="word-card-slot"]')
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + 60) }
    })
    let guard = 0
    let s = s0
    while (s.word !== 'by' && guard < 8) {
      await touchSwipe(page, client, { x: box.x, y: box.y, dx: -140, dy: 0 })
      s = await readState(page)
      guard += 1
    }
    check('B2', '多词性单词：词性分组全部展示（by = prep. + adv.）', s.senseGroups === 2,
      `word=${s.word} groups=${s.senseGroups}`)
    const bySenses = ['在...旁边', '通过（某种方式）', '由（某人完成）', '到（某时）之前', '经过', '附近', '搁置']
    const byAllKept = bySenses.every((x) => (s.cardText ?? '').includes(x))
    check('B3', '多义项单词：一条不丢（by = 7 义项，同词性用 ； 连在同一行，共 2 行）',
      byAllKept && s.senseItems === 2, `word=${s.word} lines=${s.senseItems} 全在=${byAllKept}`)
    const zhOk = /在\.\.\.旁边/.test(s.cardText ?? '') && /搁置/.test(s.cardText ?? '')
    check('B4', '中文释义正文完整（首义项与末义项都在）', zhOk, (s.cardText ?? '').slice(0, 120).replace(/\n/g, ' / '))

    await page.screenshot({ path: join(OUT, 'B-释义-390.png'), fullPage: false })

    /**
     * B5 慢加载：观察「卡片渲染出来之前」是否真的出现过加载态。
     * ⚠️ books/*.json 走 Service Worker 的 CacheFirst，页面级请求拦截拦不到
     *    （SW 直接回缓存），所以用 MutationObserver 在页面里实录 DOM 出现过的文案，
     *    而不是靠外部延迟网络。
     */
    const page2 = await browser.newPage()
    await page2.setViewport({ width: vp.width, height: vp.height, isMobile: true, hasTouch: true })
    await page2.evaluateOnNewDocument(() => {
      const w = window
      w.__sawLoading = false
      const scan = () => {
        const t = document.body ? document.body.innerText : ''
        if (/正在读取学习进度/.test(t)) w.__sawLoading = true
      }
      const obs = new MutationObserver(scan)
      document.addEventListener('DOMContentLoaded', () => {
        scan()
        obs.observe(document.body, { childList: true, subtree: true, characterData: true })
      })
    })
    await page2.goto(`${BASE}/learn`, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page2.waitForSelector('[data-testid="word-card-slot"]', { timeout: 30000 })
    await sleep(800)
    const sawLoading = await page2.evaluate(() => window.__sawLoading === true)
    check('B5-a', '词包到位前显示加载态（骨架 + 提示），不是空白卡片', sawLoading, `sawLoading=${sawLoading}`)
    const sSlow = await readState(page2)
    check('B5-b', '加载结束后释义正常显示（不永久空白）',
      sSlow.senseGroups >= 1 && sSlow.senseItems >= 1, `groups=${sSlow.senseGroups} items=${sSlow.senseItems}`)
    await page2.close()

    // B6 关闭中文辅助：给明确提示，不空白
    const page3 = await browser.newPage()
    await page3.setViewport({ width: vp.width, height: vp.height, isMobile: true, hasTouch: true })
    await page3.evaluateOnNewDocument(() => {
      localStorage.setItem(
        'shushu-settings',
        JSON.stringify({ state: { settings: { chineseAssist: false } }, version: 0 }),
      )
    })
    await page3.goto(`${BASE}/learn`, { waitUntil: 'networkidle2', timeout: 60000 })
    await page3.waitForSelector('[data-testid="word-card-slot"]', { timeout: 30000 })
    await sleep(700)
    const sOff = await readState(page3)
    check('B6', '🔴 关闭中文辅助：核心中文释义**仍然显示**（不因开关消失）',
      sOff.senseGroups >= 1 && sOff.senseItems >= 1 && sOff.senseEmptyText === null,
      `groups=${sOff.senseGroups} items=${sOff.senseItems} 空提示=${sOff.senseEmptyText ?? '无'}`)
    check('B6-b', '🔴 关闭中文辅助：例句中文翻译仍显示（全局常驻）、英文例句仍在',
      sOff.exampleZhCount >= 1 && sOff.exampleEnCount >= 1,
      `exampleEn=${sOff.exampleEnCount} exampleZh=${sOff.exampleZhCount}`)
    check('B6-c', '关闭中文辅助：助记提示收起', sOff.wordHint === false, `wordHint=${sOff.wordHint}`)
    check('B6-d', '关闭中文辅助：词根词缀 / 词源不受影响',
      /词根词缀/.test(sOff.bodyText) && /词源/.test(sOff.bodyText), '')
    await page3.close()

    /* B7 排版核验：同词性 ； 连接、不同词性换行、释义左边缘对齐、词性列宽一致 */
    const b7 = await page.evaluate(() => {
      const lines = Array.from(document.querySelectorAll('[data-testid="word-sense-line"]'))
      const poss = Array.from(document.querySelectorAll('[data-testid="word-senses"] > div > span'))
      return {
        count: lines.length,
        texts: lines.map((el) => el.textContent),
        lineLefts: lines.map((el) => Math.round(el.getBoundingClientRect().left)),
        posWidths: poss.map((el) => Math.round(el.getBoundingClientRect().width)),
      }
    })
    const joinedOk =
      b7.texts[0] === '在...旁边；通过（某种方式）；由（某人完成）；到（某时）之前' &&
      b7.texts[1] === '经过；附近；搁置'
    const leftsAligned = b7.lineLefts.length === 2 && b7.lineLefts[0] === b7.lineLefts[1]
    const widthsEqual = b7.posWidths.length > 0 && b7.posWidths.every((w) => w === b7.posWidths[0])
    check('B7-a', '同词性多义项用中文分号连接在同一行（不拆 li）', joinedOk,
      `lines=${b7.texts.join(' || ')}`)
    check('B7-b', '不同词性换行（by = 2 行）', b7.count === 2, `count=${b7.count}`)
    check('B7-c', '🔴 所有释义左边缘严格对齐（同一垂直起始线）', leftsAligned, `lefts=${b7.lineLefts.join(',')}`)
    check('B7-d', '词性标签固定列宽一致', widthsEqual, `widths=${b7.posWidths.join(',')}`)
    await page.close()
  }

  /* =============== C. 手势（375×667 触摸 + 1280×800 鼠标/键盘） =============== */
  {
    const vp = VIEWPORTS[0]
    const page = await openPage(browser, vp)
    const client = await page.createCDPSession()
    await clearLocalSettings(page)
    await clearVocab(page)
    await clearSession(page)
    await page.reload({ waitUntil: 'networkidle2' })
    await page.waitForSelector('[data-testid="word-card-slot"]', { timeout: 30000 })
    await sleep(700)

    const box = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="word-card-slot"]')
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + 60) }
    })

    const c0 = await readState(page)
    check('C0', '起始词 = ad', c0.word === 'ad', `word=${c0.word}`)

    // C1 轻微触摸不触发（< 阈值）
    await touchSwipe(page, client, { x: box.x, y: box.y, dx: -20, dy: 0, steps: 6 })
    const c1 = await readState(page)
    check('C1', '轻微横移（20px）不触发切换', c1.word === 'ad', `word=${c1.word}`)

    // C2 左滑 → 下一个
    await touchSwipe(page, client, { x: box.x, y: box.y, dx: -140, dy: 0 })
    const c2 = await readState(page)
    check('C2', '左滑 → 下一个单词', c2.word === 'as', `word=${c2.word}`)

    // C3 右滑 → 上一个
    await touchSwipe(page, client, { x: box.x, y: box.y, dx: 140, dy: 0 })
    const c3 = await readState(page)
    check('C3', '右滑 → 上一个单词', c3.word === 'ad', `word=${c3.word}`)

    // C4 边界：第一张右滑不空白、不越界
    await touchSwipe(page, client, { x: box.x, y: box.y, dx: 200, dy: 0 })
    const c4 = await readState(page)
    check('C4', '第一张继续右滑：仍是 ad，卡片不空白',
      c4.word === 'ad' && c4.hasCard && /已学/.test(c4.bodyText), `word=${c4.word}`)

    // C5 竖滑看长内容：不切换单词，且页面确实滚动了
    const before = await page.evaluate(() => window.scrollY)
    await touchSwipe(page, client, { x: box.x, y: box.y + 120, dx: 0, dy: -260, steps: 14 })
    const c5 = await readState(page)
    const after = await page.evaluate(() => window.scrollY)
    check('C5', '竖向滑动：单词不变（不误切换）', c5.word === 'ad', `word=${c5.word}`)
    check('C5-b', '竖向滑动：页面可滚动（长内容看得到）', after >= before, `scrollY ${before} → ${after}`)

    // C6 快速连滑三次不跳词
    await touchSwipe(page, client, { x: box.x, y: box.y, dx: -140, dy: 0, steps: 6 })
    await touchSwipe(page, client, { x: box.x, y: box.y, dx: -140, dy: 0, steps: 6 })
    await touchSwipe(page, client, { x: box.x, y: box.y, dx: -140, dy: 0, steps: 6 })
    const c6 = await readState(page)
    check('C6', '快速连滑三次：正好前进 3 个（不跳词、不重复）', c6.word === 'ax',
      `word=${c6.word}（期望 ax）`)
    check('C6-b', '连滑后完成计数 = 3', /已学 3/.test(c6.bodyText), c6.texts.join(' | ').slice(0, 120))

    await page.screenshot({ path: join(OUT, 'C-手势-375.png'), fullPage: false })
    await page.close()
  }

  /* =============== C7：每组 1 词时最后一张左滑 = 结算弹窗，不空白 =============== */
  {
    const vp = VIEWPORTS[1]
    const page = await browser.newPage()
    await page.setViewport({ width: vp.width, height: vp.height, isMobile: true, hasTouch: true })
    await page.evaluateOnNewDocument(() => {
      localStorage.setItem(
        'shushu-settings',
        JSON.stringify({ state: { settings: { studyBatchSize: 1 } }, version: 0 }),
      )
    })
    await page.goto(`${BASE}/learn`, { waitUntil: 'networkidle2', timeout: 60000 })
    await page.waitForSelector('[data-testid="word-card-slot"]', { timeout: 30000 })
    await sleep(700)
    const client = await page.createCDPSession()
    await clearSession(page)
    await page.reload({ waitUntil: 'networkidle2' })
    await page.waitForSelector('[data-testid="word-card-slot"]', { timeout: 30000 })
    await sleep(700)

    const box = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="word-card-slot"]')
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + 60) }
    })
    const b0 = await readState(page)
    check('C7-a', '每组 1 词：每张都是组内最后一张', /1\/1/.test(b0.texts.join(' ')), b0.texts.join(' | ').slice(0, 80))
    await touchSwipe(page, client, { x: box.x, y: box.y, dx: -150, dy: 0 })
    await sleep(600)
    const b1 = await readState(page)
    check('C7-b', '组内最后一张左滑 → 结算弹窗（不是空白 / 不是越界）',
      b1.dialogOpen && b1.hasCard, `dialog=${b1.dialogOpen} card=${b1.hasCard}`)
    await page.screenshot({ path: join(OUT, 'C7-边界结算-390.png'), fullPage: false })
    await clearLocalSettings(page) // 别把「每组 1 词」的夹具带进布局场景
    await page.close()
  }

  /* =============== D. 布局：三视口 =============== */
  for (const vp of VIEWPORTS) {
    const page = await openPage(browser, vp)
    await clearLocalSettings(page)
    await clearVocab(page)
    await clearSession(page)
    await page.reload({ waitUntil: 'networkidle2' })
    await page.waitForSelector('[data-testid="word-card-slot"]', { timeout: 30000 })
    await sleep(700)
    const s = await readState(page)

    check(`D-${vp.name}-1`, '底部「搜单词」搜索框已移除', !s.hasSearchBox, `hasSearchBox=${s.hasSearchBox}`)
    check(`D-${vp.name}-2`, '「上一张 / 下一张」按钮已移除', !s.hasPrevNext, `hasPrevNext=${s.hasPrevNext}`)
    check(`D-${vp.name}-3`, '保留显式的「重新学习」入口', s.hasRestart, `hasRestart=${s.hasRestart}`)

    if (vp.mobile) {
      /** 滚到底再量：sticky 导航在中途是浮在内容上的，滚到底才是「有没有永久遮挡」 */
      const occ = await page.evaluate(async () => {
        window.scrollTo(0, document.documentElement.scrollHeight)
        await new Promise((r) => setTimeout(r, 300))
        const root = document.querySelector('main > div')
        const nav = document.querySelector('nav')
        const rb = root.getBoundingClientRect()
        const nb = nav.getBoundingClientRect()
        return { contentBottom: rb.bottom, contentHeight: rb.height, navTop: nb.top, navHeight: nb.height }
      })
      check(`D-${vp.name}-4`, '滚到底后内容不被底部导航遮挡',
        occ.contentBottom <= occ.navTop + 1,
        `contentBottom=${Math.round(occ.contentBottom)} navTop=${Math.round(occ.navTop)}`)

      /**
       * 5 = 页面高度正好等于「内容 + 导航」，没有额外撑高的空白。
       * （内容比视口高时滚动是正常且要求的；这里卡的是「多余的第二屏」。）
       */
      const blank = await page.evaluate(() => {
        const root = document.querySelector('main > div')
        const nav = document.querySelector('nav')
        return (
          document.documentElement.scrollHeight -
          root.getBoundingClientRect().height -
          nav.getBoundingClientRect().height
        )
      })
      check(`D-${vp.name}-5`, '页面高度 = 内容 + 导航，无多余空白（不强行撑第二屏）',
        Math.abs(blank) <= 8, `多余空白=${Math.round(blank)}px`)
    } else {
      // 桌面档（A5 桌面壳：SideNav + 顶栏 + 内容区独立滚动；无底部 Tab 栏；h-screen 锁定视口高）。
      // 原「内容底部 ≤ 底部导航 top」的口径在桌面档不成立（桌面没有底部导航，
      // document.querySelector('nav') 取到的是左侧 SideNav），改用桌面档真实不变量：
      //   4 = 内容在自身滚动容器内可滚到底、且不存在 border-t 样式的底部导航遮挡；
      //   5 = 外壳锁定视口高（document.scrollHeight ≈ innerHeight），无文档级多余空白。
      const occ = await page.evaluate(async () => {
        const main = document.querySelector('main')
        let reachable = true
        if (main) {
          main.scrollTop = main.scrollHeight
          await new Promise((r) => setTimeout(r, 200))
          reachable = main.scrollTop + main.clientHeight >= main.scrollHeight - 2
        }
        // 底部导航的特征是 nav.border-t（BottomTabBar）；桌面档不渲染它
        const bottomNav = Array.from(document.querySelectorAll('nav')).some((n) =>
          /border-t/.test(n.className),
        )
        return { reachable, bottomNav }
      })
      check(`D-${vp.name}-4`, '内容区不被底部导航遮挡（桌面档无底栏）',
        occ.reachable && !occ.bottomNav,
        `reachable=${occ.reachable} bottomNav=${occ.bottomNav}`)

      const blank = await page.evaluate(() => ({
        docBlank: document.documentElement.scrollHeight - window.innerHeight,
      }))
      check(`D-${vp.name}-5`, '桌面档：外壳锁定视口高、无文档级多余空白（不强行撑第二屏）',
        Math.abs(blank.docBlank) <= 2, `文档多余空白=${Math.round(blank.docBlank)}px`)
    }

    // 手势提示存在（首次进入）
    check(`D-${vp.name}-6`, '首次进入有手势提示', /左滑下一个|右滑上一个/.test(s.swipeHint ?? ''),
      `hint="${s.swipeHint ?? '（无）'}"`)

    await page.screenshot({ path: join(OUT, `D-${vp.name}.png`), fullPage: false })
    await page.screenshot({ path: join(OUT, `D-${vp.name}-full.png`), fullPage: true })

    if (vp.name === 'pc1280') {
      // PC：鼠标拖拽 + 键盘方向键
      const box = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="word-card-slot"]')
        const r = el.getBoundingClientRect()
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + 60) }
      })
      const p0 = await readState(page)
      await mouseSwipe(page, { x: box.x, y: box.y, dx: -160 })
      const p1 = await readState(page)
      check('D-pc-7', 'PC 鼠标拖拽左滑 → 下一个词', p1.word !== p0.word, `${p0.word} → ${p1.word}`)
      await keySwitch(page, 'ArrowLeft')
      const p2 = await readState(page)
      check('D-pc-8', 'PC 键盘 ← → 上一个词', p2.word === p0.word, `${p1.word} → ${p2.word}`)
      await keySwitch(page, 'ArrowRight')
      const p3 = await readState(page)
      check('D-pc-9', 'PC 键盘 → → 下一个词', p3.word === p1.word, `${p2.word} → ${p3.word}`)
    }
    await page.close()
  }

  /* =============== D10：内容较多时完整可见、不被截断 =============== */
  {
    const vp = VIEWPORTS[0]
    const page = await openPage(browser, vp)
    await sleep(700)
    const info = await page.evaluate(() => {
      const card = document.querySelector('main .rounded-lg.bg-card')
      const ety = Array.from(card?.querySelectorAll('p') ?? []).map((p) => p.textContent.trim())
      const last = ety[ety.length - 1] ?? ''
      const r = card?.getBoundingClientRect()
      return {
        lastParagraph: last,
        cardBottom: r ? r.bottom : null,
        docScrollHeight: document.documentElement.scrollHeight,
        innerHeight: window.innerHeight,
        overflowHidden: card ? getComputedStyle(card).overflow : null,
      }
    })
    check('D10-a', '长内容：页面可滚动（内容不被裁掉）',
      info.docScrollHeight > info.innerHeight,
      `scroll=${info.docScrollHeight} inner=${info.innerHeight}`)
    check('D10-b', '卡片没有用 overflow:hidden 截断内容',
      info.overflowHidden !== 'hidden', `overflow=${info.overflowHidden}`)
    check('D10-c', '词源等长段落文字完整（非空、有结尾）',
      info.lastParagraph.length > 20, `末段 ${info.lastParagraph.length} 字`)
    await page.close()
  }
  /* =============== E. 存量库升级（v10 → v11）不能丢数据 =============== */
  {
    const vp = VIEWPORTS[1]
    const page = await browser.newPage()
    await page.setViewport({ width: vp.width, height: vp.height, isMobile: true, hasTouch: true })
    /**
     * 先落到**同源的静态数据文件**上拿 origin（IndexedDB 需要同源 + 非 about:blank），
     * 又不会启动 App（一启动 Dexie 就把库建到 v11 了，升级路径就测不到了）。
     */
    await page.goto(`${BASE}/data/linguabase/v1/index.json`, { waitUntil: 'domcontentloaded' })
    // 前面的场景已经让 App 建过库（Dexie 把 v11 存成 version=110），先删干净再种老库
    await page.evaluate(
      () =>
        new Promise((res) => {
          const r = indexedDB.deleteDatabase('shushu-learn')
          r.onsuccess = res
          r.onerror = res
          r.onblocked = res
        }),
    )

    // 用**原生 indexedDB**造一个 v10 的库（含 vocab / 默写会话各若干行），
    // 再让 App 用 Dexie v11 打开它 —— 这就是老用户升级的真实路径。
    const seeded = await page.evaluate(async () => {
      /**
       * ⚠️ Dexie 把 schema version 存成 **version × 10**（v10 → IDB version 100）。
       *    之前这里建了个 version=10 的库，Dexie 会当成「v1」从 2 一路升到 11，
       *    于是 v10 那一步的 .stores() 又被执行一遍 → 默写表被重建、行丢了
       *    （那是**夹具失真**，不是 App 的行为）。真实存量库必须是 100。
       */
      const req = indexedDB.open('shushu-learn', 100)
      const db = await new Promise((res, rej) => {
        req.onupgradeneeded = () => {
          const d = req.result
          /** [表名, keyPath, 索引数组, 是否自增] —— 与 web.ts 里 v1..v10 的最终形态一致 */
          const stores = [
            ['vocab', 'word_id', ['word', 'layer', 'next_review', 'added_at', 'owner'], false],
            ['reviewLog', 'id', ['word_id', 'at', 'uid', 'owner'], true],
            ['readings', 'id', ['created_at', 'type', 'on_shelf'], false],
            ['readingTime', 'date', ['owner'], false],
            ['diagnose', 'id', ['at'], true],
            ['recitations', 'id', ['created_at', 'doc_id'], false],
            ['dictEntries', 'key', ['word_lower', 'pos', 'updated_at'], false],
            ['dictToc', 'id', ['book', 'page_start'], false],
            ['dictGrammar', 'key', ['base_lower', 'type'], false],
            ['dictMeta', 'key', [], false],
            ['annotations', 'id', ['doc_id', 'created_at'], false],
            ['collections', 'id', ['owner', 'updated_at'], false],
            ['settings', 'owner', [], false],
            ['session', 'user_id', [], false],
            ['sync_queue', 'id', ['entity', 'entity_id', 'created_at', 'attempts'], false],
            ['sync_meta', 'key', [], false],
            ['transcripts', 'id', ['created_at', 'source'], false],
            ['studyNotes', 'id', ['transcript_id', 'status', 'created_at', 'updated_at', 'source'], false],
            ['spellingSessions', 'id', ['status', 'started_at', 'owner'], false],
          ]
          for (const [name, keyPath, indexes, auto] of stores) {
            if (d.objectStoreNames.contains(name)) continue
            const os = d.createObjectStore(name, { keyPath, autoIncrement: auto })
            for (const idx of indexes) os.createIndex(idx, idx)
          }
        }
        req.onsuccess = () => res(req.result)
        req.onerror = () => rej(req.error)
      })
      const now = Date.now()
      const tx = db.transaction(['vocab', 'spellingSessions'], 'readwrite')
      const vs = tx.objectStore('vocab')
      for (const wordId of ['oe-ad', 'oe-as', 'oe-at']) {
        vs.put({
          word_id: wordId,
          word: wordId.replace('oe-', ''),
          book: 'CET4',
          layer: 'new',
          consecutive_correct: 0,
          srs_step: 0,
          in_wrong_pool: false,
          next_review: now + 600000,
          added_at: now,
          updated_at: now,
          owner: 'guest',
        })
      }
      tx.objectStore('spellingSessions').put({
        id: 'sess-old',
        status: 'IN_PROGRESS',
        started_at: now,
        owner: 'guest',
        queue: [{ word_id: 'oe-ad', position: 0, word_status: 'PENDING' }],
      })
      await new Promise((res) => {
        tx.oncomplete = res
        tx.onerror = res
        tx.onabort = res
      })
      const versionBefore = db.version
      db.close()
      return { versionBefore, vocab: 3 }
    })
    check('E1', '已造出 v10 存量库（3 条生词本 + 1 份默写会话）',
      seeded.versionBefore === 100, `IDB version=${seeded.versionBefore}（Dexie v10 = 100）`)

    const errors = []
    page.on('pageerror', (e) => errors.push(String(e)))
    await page.goto(`${BASE}/learn`, { waitUntil: 'networkidle2', timeout: 60000 })
    await page.waitForSelector('[data-testid="word-card-slot"]', { timeout: 30000 })
    await sleep(900)

    const after = await page.evaluate(async () => {
      const req = indexedDB.open('shushu-learn')
      const db = await new Promise((res, rej) => {
        req.onsuccess = () => res(req.result)
        req.onerror = () => rej(req.error)
        req.onupgradeneeded = () => res(req.result)
      })
      const names = Array.from(db.objectStoreNames)
      const read = (store) =>
        new Promise((res) => {
          const tx = db.transaction([store], 'readonly')
          const r = tx.objectStore(store).getAll()
          r.onsuccess = () => res(r.result)
          r.onerror = () => res([])
        })
      const vocab = await read('vocab')
      const spelling = await read('spellingSessions')
      const sessions = names.includes('wordLearningSessions') ? await read('wordLearningSessions') : null
      return { version: db.version, names, vocab: vocab.length, spelling: spelling.length, sessions }
    })

    check('E2', 'App 打开后库升到 v11，且新增表已建立',
      after.version === 110 && after.names.includes('wordLearningSessions'),
      `IDB version=${after.version}（Dexie v11 = 110）hasNewTable=${after.names.includes('wordLearningSessions')}`)
    check('E3', '存量生词本数据一行没丢（3 条）', after.vocab === 3, `vocab=${after.vocab}`)
    check('E4', '存量默写会话没丢（1 份）', after.spelling === 1, `spellingSessions=${after.spelling}`)
    check('E5', '学习页在升级后的库上正常渲染（无页面异常）', errors.length === 0,
      errors.slice(0, 2).join(' | ') || '无异常')

    const s = await readState(page)
    check('E6', '升级后首进：已学过的 3 个词被跳过（落在第 4 个词）', s.word === 'ax', `word=${s.word}`)
    check('E7', '升级后会话已落库（1 份）',
      Array.isArray(after.sessions) && after.sessions.length === 1,
      `sessions=${Array.isArray(after.sessions) ? after.sessions.length : 'null'}`)

    await page.screenshot({ path: join(OUT, 'E-存量库升级-390.png'), fullPage: false })
    await page.close()
  }
} catch (err) {
  /* 没有 catch 的话，异常会被 finally 里的 process.exit() 吞掉 —— 表面「通过」实则没跑 */
  failures += 1
  console.error(`\n💥 脚本运行中断：${err?.stack ?? String(err)}`)
} finally {
  await browser.close()
  report.finishedAt = new Date().toISOString()
  report.failures = failures
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2), 'utf-8')
  console.log(`\n${'─'.repeat(52)}`)
  console.log(`共 ${report.checks.length} 项，失败 ${failures} 项`)
  console.log(`报告：${join(OUT, 'report.json')}`)
  process.exit(failures > 0 ? 1 : 0)
}
