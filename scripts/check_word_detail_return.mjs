#!/usr/bin/env node
/**
 * 单词学习页 Phase E 补充浏览器实测（填补现有脚本未覆盖的交互）
 * ------------------------------------------------------------------
 * 前置：npm run preview -- --port 4174 --strictPort
 * 用法：node scripts/check_word_detail_return.mjs
 *
 * 覆盖（用户指令中现有脚本未单独验收的项）：
 *   一.4  中文辅助 true / false / 空字段 三态
 *   二.7  点词浮层内部点击不误触发卡片切词
 *   三    详情跳转 + 返回（浏览器返回 & 页面内返回）：
 *        - 返回后当前单词不丢
 *        - 学习进度（已学数）不回退/不重置
 *        - 会话数不重复（=1）
 *        - 滚动位置单独验收（Dexie 恢复进度 ≠ 自动恢复滚动）
 *   四.2  从例句单词区域起手的真实水平滑动仍可切卡
 *   四.6  点浮层/关闭按钮不触发卡片切换
 *
 * ⚠️ 本脚本只读 + 操作 UI，不改任何被测源码。
 */

import puppeteer from 'puppeteer-core'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const BASE = process.env.BROWSER_ACCEPT_BASE ?? 'http://127.0.0.1:4174'
const OUT = join('练习', '_detail-return')
mkdirSync(OUT, { recursive: true })

const report = { startedAt: new Date().toISOString(), base: BASE, checks: [] }
let failures = 0
function check(id, name, ok, detail) {
  report.checks.push({ id, name, ok: Boolean(ok), detail: String(detail ?? '') })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function readState(page) {
  return page.evaluate(() => {
    const slot = document.querySelector('[data-testid="word-card-slot"]')
    const rb = slot ? slot.getBoundingClientRect() : null
    const zh = Array.from(document.querySelectorAll('[data-testid="example-zh"]'))
    const en = Array.from(document.querySelectorAll('[data-testid="example-en"]'))
    const senses = document.querySelector('[data-testid="word-senses"]')
    const popover = document.querySelector('.fixed.z-50')
    return {
      url: location.pathname,
      word: slot?.getAttribute('data-word') ?? null,
      cardVisible: rb ? rb.top < window.innerHeight && rb.bottom > 0 : false,
      scrollY: Math.round(window.scrollY),
      innerH: window.innerHeight,
      exampleZhCount: zh.length,
      exampleZhEmpty: zh.filter((e) => !(e.textContent || '').trim()).length,
      exampleEnCount: en.length,
      senseItems: senses ? senses.querySelectorAll('[data-testid="word-sense-line"]').length : 0,
      bodyText: document.body.innerText.slice(0, 500),
      popoverOpen: Boolean(popover),
      learned: (document.body.innerText.match(/已学\s*(\d+)/) || [])[1] ?? null,
    }
  })
}

/** Dexie 学习会话数（验证不重复创建） */
async function sessionCount(page) {
  return page.evaluate(async () => {
    const req = indexedDB.open('shushu-learn')
    const db = await new Promise((res, rej) => {
      req.onsuccess = () => res(req.result)
      req.onerror = () => rej(req.error)
      req.onupgradeneeded = () => res(req.result)
    })
    if (!db.objectStoreNames.contains('wordLearningSessions')) return 0
    const tx = db.transaction(['wordLearningSessions'], 'readonly')
    const all = await new Promise((res) => {
      const r = tx.objectStore('wordLearningSessions').getAll()
      r.onsuccess = () => res(r.result)
      r.onerror = () => res([])
    })
    return Array.isArray(all) ? all.length : 0
  })
}

async function clearAll(page) {
  await page.evaluate(async () => {
    localStorage.removeItem('shushu-settings')
    const req = indexedDB.open('shushu-learn')
    const db = await new Promise((res) => {
      req.onsuccess = () => res(req.result)
      req.onerror = () => res(req.result)
      req.onupgradeneeded = () => res(req.result)
    })
    const names = Array.from(db.objectStoreNames)
    if (names.includes('wordLearningSessions')) {
      const tx = db.transaction(['wordLearningSessions'], 'readwrite')
      tx.objectStore('wordLearningSessions').clear()
      await new Promise((res) => {
        tx.oncomplete = res
        tx.onerror = res
      })
    }
  })
}

/** 真实触摸滑动（CDP） */
async function touchSwipe(page, client, { x, y, dx, dy = 0, steps = 12 }) {
  const move = async (type, px, py) =>
    client.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ x: px, y: py, radiusX: 8, radiusY: 8, force: 1 }],
    })
  await move('touchStart', x, y)
  for (let i = 1; i <= steps; i++) {
    await move('touchMove', x + (dx * i) / steps, y + (dy * i) / steps)
    await sleep(12)
  }
  await move('touchEnd', x + dx, y + dy)
  await sleep(280)
}

/** 取例句里第一个单词按钮的中心坐标 */
async function firstWordBtnCenter(page) {
  return page.evaluate(() => {
    const btn = document.querySelector('[data-testid="example-en"] button')
    if (!btn) return null
    const r = btn.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  })
}

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})

try {
  /* =============== 一.4 中文辅助三态 =============== */
  {
    const page = await browser.newPage()
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true })
    await page.goto(`${BASE}/learn`, { waitUntil: 'networkidle2', timeout: 60000 })
    await page.waitForSelector('[data-testid="word-card-slot"]', { timeout: 30000 })
    await sleep(700)
    await clearAll(page)
    await page.reload({ waitUntil: 'networkidle2' })
    await page.waitForSelector('[data-testid="word-card-slot"]', { timeout: 30000 })
    await sleep(700)

    // 三态 1：默认（未持久化，chineseAssist 默认 true）
    let s = await readState(page)
    check('G1-true', 'chineseAssist=true（默认）：英文例句显示', s.exampleEnCount > 0, `en=${s.exampleEnCount}`)
    check('G1-true-zh', 'chineseAssist=true（默认）：中文翻译显示', s.exampleZhCount > 0, `zh=${s.exampleZhCount}`)
    check('G1-true-def', 'chineseAssist=true：核心中文释义仍显示', s.senseItems > 0, `senseLines=${s.senseItems}`)

    // 三态 2：持久化 false
    await page.evaluate(() => {
      localStorage.setItem('shushu-settings', JSON.stringify({ state: { settings: { chineseAssist: false } }, version: 0 }))
    })
    await page.reload({ waitUntil: 'networkidle2' })
    await page.waitForSelector('[data-testid="word-card-slot"]', { timeout: 30000 })
    await sleep(700)
    s = await readState(page)
    check('G1-false-zh', 'chineseAssist=false：中文翻译仍显示（全局常驻）', s.exampleZhCount > 0, `zh=${s.exampleZhCount}`)
    check('G1-false-en', 'chineseAssist=false：英文例句仍显示', s.exampleEnCount > 0, `en=${s.exampleEnCount}`)
    check('G1-false-def', 'chineseAssist=false：核心中文释义仍显示（不因开关消失）', s.senseItems > 0, `senseLines=${s.senseItems}`)

    // 三态 3：空字段不显示空白内容（渲染守卫 ex.zh &&）
    check('G1-empty', '所有 example-zh 元素均非空（无空白内容）', s.exampleZhEmpty === 0, `empty=${s.exampleZhEmpty}`)
    await page.close()
  }

  /* =============== 二.7 / 四.6 浮层内部点击 & 关闭不切卡 =============== */
  {
    const page = await browser.newPage()
    const client = await page.createCDPSession()
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true })
    await page.goto(`${BASE}/learn`, { waitUntil: 'networkidle2', timeout: 60000 })
    await page.waitForSelector('[data-testid="word-card-slot"]', { timeout: 30000 })
    await sleep(700)
    await clearAll(page)
    await page.reload({ waitUntil: 'networkidle2' })
    await page.waitForSelector('[data-testid="word-card-slot"]', { timeout: 30000 })
    await sleep(700)

    const before = (await readState(page)).word
    // 打开浮层
    const c = await firstWordBtnCenter(page)
    await page.mouse.click(c.x, c.y)
    await sleep(400)
    let st = await readState(page)
    check('G2-pop', '点击例句单词弹出查词浮层', st.popoverOpen, `popover=${st.popoverOpen}`)
    check('G2-noswitch', '点词本身不切换卡片（仍在 /learn 同词）', st.url === '/learn' && st.word === before, `word=${st.word}`)

    // 点浮层内部（词条标题 span，非按钮）不切卡
    const inside = await page.evaluate(() => {
      const pop = document.querySelector('.fixed.z-50')
      const span = pop?.querySelector('span')
      if (!span) return null
      const r = span.getBoundingClientRect()
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
    })
    if (inside) {
      await page.mouse.click(inside.x, inside.y)
      await sleep(300)
      st = await readState(page)
      check('G2-inside', '点浮层内部（非按钮）不误触发切卡', st.word === before, `word=${st.word} url=${st.url}`)
    } else {
      check('G2-inside', '点浮层内部（非按钮）不误触发切卡', false, '未定位到浮层内部元素')
    }

    // 点关闭按钮（× / 浮层外遮罩）关闭浮层且不切卡
    await page.evaluate(() => {
      const ov = document.querySelector('.fixed.inset-0')
      if (ov) ov.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    })
    await sleep(300)
    st = await readState(page)
    check('G2-close', '点遮罩关闭浮层且不切卡', !st.popoverOpen && st.word === before, `popover=${st.popoverOpen} word=${st.word}`)
    await page.close()
  }

  /* =============== 四.2 从例句单词区域起手的水平滑动仍可切卡 =============== */
  {
    const page = await browser.newPage()
    const client = await page.createCDPSession()
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true })
    await page.goto(`${BASE}/learn`, { waitUntil: 'networkidle2', timeout: 60000 })
    await page.waitForSelector('[data-testid="word-card-slot"]', { timeout: 30000 })
    await sleep(700)
    await clearAll(page)
    await page.reload({ waitUntil: 'networkidle2' })
    await page.waitForSelector('[data-testid="word-card-slot"]', { timeout: 30000 })
    await sleep(700)

    const start = (await readState(page)).word
    const c = await firstWordBtnCenter(page)
    await touchSwipe(page, client, { x: c.x, y: c.y, dx: -160, dy: 0 })
    const after = await readState(page)
    check('G3-wordarea-swipe', `从例句单词区域左滑仍可切卡（${start} → ${after.word}）`, after.word && after.word !== start, `${start} → ${after.word}`)
    await page.close()
  }

  /* =============== 三 详情跳转 + 返回（浏览器返回 & 页面内返回） =============== */
  // 先制造进度：学 2 个词（左滑两次），当前词 = ax，已学 2
  async function learnTwoAndOpenDetail(page, client) {
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true })
    await page.goto(`${BASE}/learn`, { waitUntil: 'networkidle2', timeout: 60000 })
    await page.waitForSelector('[data-testid="word-card-slot"]', { timeout: 30000 })
    await sleep(700)
    await clearAll(page)
    await page.reload({ waitUntil: 'networkidle2' })
    await page.waitForSelector('[data-testid="word-card-slot"]', { timeout: 30000 })
    await sleep(700)
    const box = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="word-card-slot"]')
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + 60) }
    })
    await touchSwipe(page, client, { x: box.x, y: box.y, dx: -160, dy: 0 })
    await touchSwipe(page, client, { x: box.x, y: box.y, dx: -160, dy: 0 })
    const mid = await readState(page)
    // 打开浮层 → 查看详情
    const c = await firstWordBtnCenter(page)
    await page.mouse.click(c.x, c.y)
    await sleep(400)
    // 点「查看详情」
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent.trim() === '查看详情')
      if (b && !b.disabled) b.click()
    })
    await page.waitForFunction(() => location.pathname.startsWith('/word/'), { timeout: 8000 }).catch(() => {})
    await sleep(500)
    return mid
  }

  async function verifyReturn(page, mid, label) {
    const back = await readState(page)
    const cnt = await sessionCount(page)
    const wordOk = back.word === mid.word
    const progOk = back.learned === mid.learned
    const sessOk = cnt === 1
    const scrollOk = back.scrollY >= 0 && back.cardVisible
    check(`G4-${label}-word`, `返回后当前单词不丢（=${mid.word}）`, wordOk, `word=${back.word}`)
    check(`G4-${label}-prog`, `返回后学习进度不回退（已学 ${mid.learned}）`, progOk, `已学=${back.learned}`)
    check(`G4-${label}-sess`, '返回后学习会话不重复（=1）', sessOk, `会话数=${cnt}`)
    check(`G4-${label}-scroll`, `返回后滚动位置合理（scrollY=${back.scrollY}, 卡片可见=${back.cardVisible}）`, scrollOk, `scrollY=${back.scrollY} visible=${back.cardVisible}`)
    return { wordOk, progOk, sessOk, scrollOk }
  }

  // 浏览器返回
  {
    const page = await browser.newPage()
    const client = await page.createCDPSession()
    const mid = await learnTwoAndOpenDetail(page, client)
    check('G4-browser-nav', '「查看详情」跳转到 /word/:word', (await readState(page)).url.startsWith('/word/'), `url=${(await readState(page)).url}`)
    await page.goBack({ waitUntil: 'networkidle2' })
    await page.waitForSelector('[data-testid="word-card-slot"]', { timeout: 30000 })
    await sleep(700)
    await verifyReturn(page, mid, 'browser')
    await page.close()
  }

  // 页面内返回（WordDetail 的「返回上一页」按钮）
  {
    const page = await browser.newPage()
    const client = await page.createCDPSession()
    const mid = await learnTwoAndOpenDetail(page, client)
    check('G4-inpage-nav', '「查看详情」跳转到 /word/:word', (await readState(page)).url.startsWith('/word/'), `url=${(await readState(page)).url}`)
    await page.evaluate(() => {
      const b = document.querySelector('[aria-label="返回上一页"]')
      if (b) b.click()
    })
    await page.waitForSelector('[data-testid="word-card-slot"]', { timeout: 30000 })
    await sleep(700)
    await verifyReturn(page, mid, 'inpage')
    await page.close()
  }

  console.log('\n' + '─'.repeat(52))
  console.log(`共 ${report.checks.length} 项，失败 ${failures} 项`)
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2), 'utf-8')
} catch (err) {
  failures += 1
  console.error(`\n💥 脚本运行中断：${err?.stack ?? String(err)}`)
} finally {
  await browser.close()
  process.exit(failures > 0 ? 1 : 0)
}
