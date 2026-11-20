#!/usr/bin/env node
/**
 * 全局统一中文例句释义 —— 视觉规范浏览器实测
 * ------------------------------------------------------------------
 * 验收：「有中文释义的例句必须显示中文释义（青绿色 + 比英文小一号）」
 *   - example-zh 元素存在（不丢、不被开关门控）
 *   - 计算色 ≈ emerald-600 (5,150,105) 或 emerald-400 (52,211,153)
 *   - example-zh 字号 < 同条 example-en 字号（小一号）
 * 只读 + 操作 UI，不改源码。
 */
import puppeteer from 'puppeteer-core'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const BASE = process.env.BROWSER_ACCEPT_BASE ?? 'http://127.0.0.1:4174'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})

let pass = 0
let fail = 0
const fails = []

function check(name, ok, info) {
  if (ok) {
    pass++
    console.log(`PASS ${name} — ${info}`)
  } else {
    fail++
    fails.push(name)
    console.log(`FAIL ${name} — ${info}`)
  }
}

// 青绿色判定：emerald-600 (5,150,105) 或 emerald-400 (52,211,153)，容差 40
function isTeal(rgb) {
  const m = rgb.match(/rgba?\(([^)]+)\)/)
  if (!m) return false
  const [r, g, b] = m[1].split(',').map((x) => parseInt(x.trim(), 10))
  const d1 = Math.abs(r - 5) + Math.abs(g - 150) + Math.abs(b - 105)
  const d2 = Math.abs(r - 52) + Math.abs(g - 211) + Math.abs(b - 153)
  return d1 <= 120 || d2 <= 120
}

async function inspect(page, selector) {
  return page.evaluate((sel) => {
    const els = Array.from(document.querySelectorAll(sel))
    return els.map((el) => {
      const cs = getComputedStyle(el)
      const en = el.previousElementSibling
      const enSize = en ? getComputedStyle(en).fontSize : null
      return {
        zhSize: cs.fontSize,
        zhColor: cs.color,
        enSize,
        text: el.textContent.slice(0, 20),
      }
    })
  }, selector)
}

try {
  /* ---- /learn 默认（chineseAssist=true） ---- */
  {
    const page = await browser.newPage()
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true })
    await page.goto(`${BASE}/learn`, { waitUntil: 'networkidle2', timeout: 60000 })
    await page.waitForSelector('[data-testid="example-zh"]', { timeout: 30000 }).catch(() => {})
    await sleep(800)
    const rows = await inspect(page, '[data-testid="example-zh"]')
    check('learn: 有中文例句渲染（不被开关门控）', rows.length > 0, `count=${rows.length}`)
    if (rows.length) {
      const allTeal = rows.every((r) => isTeal(r.zhColor))
      const allSmaller = rows.every((r) => r.enSize && parseFloat(r.zhSize) < parseFloat(r.enSize))
      check('learn: 中文例句为青绿色', allTeal, rows.map((r) => r.zhColor).join(' | '))
      check('learn: 中文例句字号比英文小一号', allSmaller, rows.map((r) => `${r.zhSize}/${r.enSize}`).join(' | '))
    }
    await page.close()
  }

  /* ---- /word/:word（ExampleRow，词典详情） ---- */
  {
    const page = await browser.newPage()
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true })
    await page.goto(`${BASE}/word/by`, { waitUntil: 'networkidle2', timeout: 60000 })
    await sleep(1200)
    const rows = await inspect(page, '[data-testid="example-zh"]')
    check('word: 词典详情有中文例句渲染', rows.length > 0, `count=${rows.length}`)
    if (rows.length) {
      const allTeal = rows.every((r) => isTeal(r.zhColor))
      const allSmaller = rows.every((r) => r.enSize && parseFloat(r.zhSize) < parseFloat(r.enSize))
      check('word: 中文例句为青绿色', allTeal, rows.map((r) => r.zhColor).join(' | '))
      check('word: 中文例句字号比英文小一号', allSmaller, rows.map((r) => `${r.zhSize}/${r.enSize}`).join(' | '))
    }
    await page.close()
  }

  /* ---- /learn 关闭中文辅助（chineseAssist=false）仍显示 + 仍为青绿色 ---- */
  {
    const page = await browser.newPage()
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true })
    await page.goto(`${BASE}/learn`, { waitUntil: 'networkidle2', timeout: 60000 })
    await sleep(600)
    // 直接写持久化存储把 chineseAssist 置 false 后刷新
    await page.evaluate(() => {
      const keys = Object.keys(localStorage)
      for (const k of keys) {
        if (k.startsWith('shushu') || k.includes('store') || k.includes('app')) {
          try {
            const v = JSON.parse(localStorage.getItem(k) || '{}')
            if (v && v.state && v.state.settings) {
              v.state.settings.chineseAssist = false
              localStorage.setItem(k, JSON.stringify(v))
            }
          } catch {}
        }
      }
    })
    await page.reload({ waitUntil: 'networkidle2' })
    await page.waitForSelector('[data-testid="example-zh"]', { timeout: 30000 }).catch(() => {})
    await sleep(800)
    const rows = await inspect(page, '[data-testid="example-zh"]')
    check('learn(chineseAssist=false): 中文例句仍渲染', rows.length > 0, `count=${rows.length}`)
    if (rows.length) {
      const allTeal = rows.every((r) => isTeal(r.zhColor))
      check('learn(chineseAssist=false): 仍为青绿色', allTeal, rows.map((r) => r.zhColor).join(' | '))
    }
    await page.close()
  }
} finally {
  await browser.close()
}

console.log(`\n────────────────────────────────────────────────────`)
console.log(`共 ${pass + fail} 项，失败 ${fail} 项`)
if (fail > 0) console.log('失败项：' + fails.join('、'))
process.exit(fail > 0 ? 1 : 0)
