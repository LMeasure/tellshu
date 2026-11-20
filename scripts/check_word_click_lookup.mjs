#!/usr/bin/env node
/**
 * 聚焦验证：例句中文翻译可见性 + 例句单词点词查词（本轮新增）
 * ------------------------------------------------------------------
 * 前置：npm run preview -- --port 4174 --strictPort
 * 用法：node scripts/check_word_click_lookup.mjs
 *
 * 只做只读 + UI 操作，不改任何被测源码。
 */
import puppeteer from 'puppeteer-core'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const BASE = process.env.BROWSER_ACCEPT_BASE ?? 'http://127.0.0.1:4174'
const OUT = join('练习', '_click-lookup')
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
    const exEn = document.querySelector('[data-testid="example-en"]')
    return {
      word: document.querySelector('[data-testid="word-card-slot"]')?.getAttribute('data-word') ?? null,
      exampleEnCount: document.querySelectorAll('[data-testid="example-en"]').length,
      exampleZhCount: document.querySelectorAll('[data-testid="example-zh"]').length,
      exInnerBtnCount: exEn ? exEn.querySelectorAll('button').length : 0,
      firstWordBtnText: exEn ? (exEn.querySelector('button')?.textContent ?? null) : null,
      url: location.pathname,
      hasDetailBtn: Array.from(document.querySelectorAll('button')).some(
        (b) => b.textContent.trim() === '查看详情',
      ),
    }
  })
}

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true })
  await page.goto(`${BASE}/learn`, { waitUntil: 'networkidle2', timeout: 60000 })
  await page.waitForSelector('[data-testid="word-card-slot"]', { timeout: 30000 }).catch(() => {})
  await sleep(800)

  // 找一个「带例句且例句有中文翻译」的卡片（默认中文辅助为开，翻译应可见）
  let st = await readState(page)
  let tried = 0
  while (!(st.exampleEnCount > 0 && st.exampleZhCount > 0) && tried < 12) {
    const box = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="word-card-slot"]')
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
    })
    await page.mouse.move(box.x, box.y)
    await page.mouse.down()
    for (let i = 1; i <= 12; i++) await page.mouse.move(box.x - (260 * i) / 12, box.y)
    await page.mouse.up()
    await sleep(450)
    st = await readState(page)
    tried++
  }

  check('L0', '找到带例句且有中文翻译的卡片', st.exampleEnCount > 0 && st.exampleZhCount > 0,
    `word=${st.word} exEn=${st.exampleEnCount} exZh=${st.exampleZhCount}`)

  /* 一、例句中文翻译在默认（中文辅助开）下可见 */
  check('L1', '默认中文辅助开启时例句中文翻译可见（消失问题已修复/本就正确）',
    st.exampleZhCount > 0, `exZh=${st.exampleZhCount}`)

  /* 二、例句英文拆成可点单词按钮 + 点词弹窗 + 查看详情跳转 */
  check('L2', '例句英文拆成可点单词按钮（>0）', st.exInnerBtnCount > 0,
    `按钮数=${st.exInnerBtnCount} 首词=${st.firstWordBtnText}`)

  if (st.exampleEnCount > 0 && st.exInnerBtnCount > 0) {
    await page.click('[data-testid="example-en"] button')
    let pop = false
    try {
      await page.waitForFunction(
        () => Array.from(document.querySelectorAll('button')).some((b) => b.textContent.trim() === '查看详情'),
        { timeout: 8000 },
      )
      pop = true
    } catch {
      pop = false
    }
    check('L3', '点击例句单词弹出查词小窗（含「查看详情」）', pop, '')
    const afterClick = await readState(page)
    check('L4', '点词后仍在 /learn（未误触发换卡/跳转）', afterClick.url === '/learn', `url=${afterClick.url}`)

    /* L5: 例句里找一个「词库收录」的词（其弹窗「查看详情」可点），验证跳转。
       不在词库的词（如 She）弹窗会如实显示「未收录」且「查看详情」禁用 —— 这是正确行为，
       所以逐词尝试直到命中一个收录词。 */
    const closePop = () =>
      page.evaluate(() => {
        const ov = document.querySelector('.fixed.inset-0')
        if (ov) ov.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
      })
    const wordBtns = await page.$$('[data-testid="example-en"] button')
    let navOk = false
    let navUrl = '/learn'
    for (let i = 0; i < wordBtns.length && !navOk; i++) {
      await closePop()
      await sleep(150)
      await wordBtns[i].click()
      await sleep(200)
      // 等查词结束（不再显示「正在查词」）
      await page
        .waitForFunction(() => !document.body.innerText.includes('正在查词'), { timeout: 4000 })
        .catch(() => {})
      const enabled = await page.evaluate(() => {
        const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent.trim() === '查看详情')
        return b ? !b.disabled : false
      })
      if (!enabled) continue
      await page.evaluate(() => {
        const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent.trim() === '查看详情')
        if (b) b.click()
      })
      try {
        await page.waitForFunction(() => location.pathname.startsWith('/word/'), { timeout: 8000 })
        navOk = true
      } catch {
        navOk = false
      }
      navUrl = await page.evaluate(() => location.pathname)
    }
    check('L5', '「查看详情」跳转到 /word/:word（词库收录的词）', navOk, `url=${navUrl}`)

    // 返回学习卡，进度应恢复（卡片正常渲染）
    await page.goto(`${BASE}/learn`, { waitUntil: 'networkidle2' })
    await page.waitForSelector('[data-testid="word-card-slot"]', { timeout: 30000 }).catch(() => {})
    await sleep(600)
    const back = await readState(page)
    check('L6', '返回 /learn 学习卡正常恢复（卡片渲染）', Boolean(back.word), `word=${back.word}`)
  }

  console.log('\n' + '─'.repeat(40))
  console.log(`通过 ${report.checks.length - failures} 项，失败 ${failures} 项`)
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2))
  if (failures > 0) process.exit(1)
} finally {
  await browser.close()
}
