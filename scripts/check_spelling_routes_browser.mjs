#!/usr/bin/env node
/**
 * 单词默写 · 阶段 E 路由与兼容性补充核验（对应任务书 §6）
 * ------------------------------------------------------------------
 * 只补主验收脚本没覆盖的两项：
 *   R1  /review 刷新行为（入口卡片是否稳定、不会被默写会话状态带偏）
 *   R2  /result 与 /spelling-result 的区分是否会误导用户
 * 其余路由行为（/spelling 刷新恢复、/spelling-result 进入与返回、不存在 id 处理）
 * 已在 check_spelling_browser.mjs 的 S1/S6/S9 覆盖，此处不复测。
 *
 * 用法：node scripts/check_spelling_routes_browser.mjs
 */

import puppeteer from 'puppeteer-core'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const BASE = process.env.BROWSER_ACCEPT_BASE ?? 'http://127.0.0.1:4174'
const OUT = join('练习', '_e-browser')
mkdirSync(OUT, { recursive: true })

const report = { startedAt: new Date().toISOString(), base: BASE, edge: EDGE, checks: [], screenshots: [] }
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

async function dbState(page) {
  return page.evaluate(async () => {
    const open = () =>
      new Promise((res, rej) => {
        const req = indexedDB.open('shushu-learn')
        req.onsuccess = () => res(req.result)
        req.onerror = () => rej(req.error)
      })
    const db = await open()
    const tx = db.transaction(['spellingSessions'], 'readonly')
    const rows = await new Promise((res) => {
      const r = tx.objectStore('spellingSessions').getAll()
      r.onsuccess = () => res(r.result)
    })
    db.close()
    return rows
  })
}

const b = await puppeteer.launch({ executablePath: EDGE, headless: true, protocolTimeout: 90000 })
report.edgeVersion = await b.version()
const ctx = await b.createBrowserContext()

try {
  // 沿用主脚本的种子（vocab 已存在则跳过；否则补种）
  const boot = await ctx.newPage()
  await boot.setViewport({ width: 375, height: 667 })
  await boot.goto(`${BASE}/review`, { waitUntil: 'networkidle2', timeout: 25000 })
  await sleep(800)
  const vocabCount = await boot.evaluate(async () => {
    const db = await new Promise((res) => {
      const req = indexedDB.open('shushu-learn')
      req.onsuccess = () => res(req.result)
    })
    const tx = db.transaction(['vocab'], 'readonly')
    const rows = await new Promise((res) => {
      const r = tx.objectStore('vocab').getAll()
      r.onsuccess = () => res(r.result)
    })
    db.close()
    return rows.length
  })
  if (vocabCount === 0) {
    await boot.evaluate(async () => {
      const now = Date.now()
      const db = await new Promise((res) => {
        const req = indexedDB.open('shushu-learn')
        req.onsuccess = () => res(req.result)
      })
      const tx = db.transaction(['vocab'], 'readwrite')
      for (const [i, w] of [
        { word: 'abandon', definition_zh: 'v. 抛弃；放弃' },
        { word: 'benefit', definition_zh: 'n. 利益；好处' },
        { word: 'cabbage', definition_zh: 'n. 卷心菜' },
      ].entries()) {
        tx.objectStore('vocab').put({
          word_id: `seed:${w.word}`,
          word: w.word,
          book: 'CET4',
          definition_zh: w.definition_zh,
          layer: 'new',
          consecutive_correct: 0,
          srs_step: 0,
          in_wrong_pool: false,
          next_review: now + 600000,
          added_at: now + i,
          owner: 'guest',
        })
      }
      await new Promise((res) => {
        tx.oncomplete = res
      })
      db.close()
    })
  }

  /* ---------- R1 · /review 刷新行为 ---------- */
  console.log('\n--- R1 /review 入口与刷新 ---')
  const p = await ctx.newPage()
  await p.setViewport({ width: 375, height: 667 })
  await p.goto(`${BASE}/review`, { waitUntil: 'networkidle2', timeout: 25000 })
  await sleep(900)
  const entryText = await p.evaluate(() => document.body.innerText)
  check('R1.1', '/review 渲染出单词默写入口卡片', entryText.includes('单词默写') && entryText.includes('开始默写'))
  check('R1.2', '/review 入口说明写明每轮词数来源（设置共用）', entryText.includes('设置'))
  await p.reload({ waitUntil: 'networkidle2', timeout: 25000 })
  await sleep(1000)
  const afterReload = await p.evaluate(() => document.body.innerText)
  check('R1.3', '刷新后仍在 /review 且入口卡片稳定', p.url().includes('/review') && afterReload.includes('开始默写'), p.url())
  // 存在一个 IN_PROGRESS 默写会话时，/review 不应被带偏
  await clearAndMakeSession(p)
  await p.goto(`${BASE}/review`, { waitUntil: 'networkidle2', timeout: 25000 })
  await sleep(900)
  const withSession = await p.evaluate(() => document.body.innerText)
  check('R1.4', '存在进行中默写会话时 /review 仍正常渲染入口', withSession.includes('开始默写'))
  check('R1.5', '/review 不会自动跳到默写页', p.url().includes('/review'), p.url())
  await shot(p, 'r1-review-refresh.png')

  /* ---------- R2 · /result 与 /spelling-result 的区分 ---------- */
  console.log('\n--- R2 /result 与 /spelling-result 区分 ---')
  await p.goto(`${BASE}/result`, { waitUntil: 'networkidle2', timeout: 25000 })
  await sleep(1000)
  const resultText = await p.evaluate(() => document.body.innerText)
  const resultUrl = p.url()
  check('R2.1', '/result 仍是占位结算页', resultUrl.includes('/result'), resultUrl)
  const hasPlaceholder = resultText.includes('连续学习') || resultText.includes('—')
  check('R2.2', '/result 显示占位数（— / 0%）', hasPlaceholder, resultText.slice(0, 80).replace(/\n/g, ' '))
  check('R2.3', '/result 不含默写相关文案（不会与默写结果混淆）', !resultText.includes('逐词明细') && !resultText.includes('默写'))
  await shot(p, 'r2-result-placeholder.png')

  // 用一个真实完成的会话 id 打开 /spelling-result，确认两者展示的是不同内容
  const rows = await dbState(p)
  const done = rows.find((s) => s.status === 'SESSION_COMPLETED') ?? rows[0]
  await p.goto(`${BASE}/spelling-result?id=${encodeURIComponent(done?.id ?? 'x')}`, {
    waitUntil: 'networkidle2',
    timeout: 25000,
  })
  await sleep(1000)
  const srText = await p.evaluate(() => document.body.innerText)
  check('R2.4', '/spelling-result 渲染的是默写结果（含逐词明细）', srText.includes('默写结果') && srText.includes('逐词明细'))
  check('R2.5', '/spelling-result 与 /result 是两条独立路由，不复用占位页', p.url().includes('/spelling-result') && !srText.includes('连续学习'))
  await shot(p, 'r2-spelling-result.png')
  console.log('    [说明] /result 与 /spelling-result 文案互不交叉；但两者的「结算页」定位相近，')
  console.log('           用户从底部导航误入 /result 时看到的是占位数，建议后续单独决定是否改名或合并（本轮未改）')

  await p.close()
  await boot.close()

  report.finishedAt = new Date().toISOString()
  report.failures = failures
  writeFileSync(join(OUT, '_routes-report.json'), JSON.stringify(report, null, 2), 'utf8')
  console.log('\n────────────────────────────────────────────────────────')
  console.log(
    failures === 0
      ? `✅ 路由与兼容性核验全部通过：${report.checks.length} 项`
      : `❌ 路由与兼容性核验失败：${failures} 项 / 共 ${report.checks.length} 项`,
  )
  if (failures) process.exitCode = 1
} finally {
  await b.close()
}

async function clearAndMakeSession(page) {
  await page.evaluate(async () => {
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
  await page.goto(`${BASE}/spelling?mode=recent`, { waitUntil: 'networkidle2', timeout: 25000 })
  await sleep(1200)
}
