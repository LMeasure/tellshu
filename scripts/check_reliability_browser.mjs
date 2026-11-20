#!/usr/bin/env node
/**
 * 跨标签单写者锁 / 升级中断恢复 · 真机双标签回归（Edge + puppeteer-core）
 * ------------------------------------------------------------------
 * 与既有 check_spelling_browser.mjs 的区别：本脚本专测可靠性链，且使用
 * **独立 userDataDir 的隔离浏览器 profile**，不触碰用户日常浏览器数据。
 *
 * 前置：npm run build 已执行；npm run preview -- --port 4174 --strictPort 正在跑
 * 用法：node scripts/check_reliability_browser.mjs
 *
 * 覆盖：
 *   R1 单标签取锁成功，输入框启用（C33 前置：取锁前禁用）
 *   R2 生产写路径错误提交真的落错词事件，且状态为 settled
 *   R3 第二个真实标签页进入同一会话 → 冲突面板，不静默并发
 *   R4 用户显式接管 → epoch+1，新标签输入框启用
 *   R5 旧标签继续写入被拒（fencing token 生效）
 *   R6 刷新恢复链：sessionStorage 复用 tab id，drain 收敛，无 pending
 *   R7 升级中断（versionchange → 升级事务回滚）后重启：数据不丢、无 pending
 *
 * 明确未覆盖（如实标注，不伪造）：
 *   · in-flight 事务在 db.close() 瞬间被中止的逐拍时序（浏览器无法精确注入）
 *   · 升级中途 kill 浏览器进程、Chromium / Firefox 跨内核矩阵
 *   · 真实移动端设备
 */

import puppeteer from 'puppeteer-core'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

process.env.no_proxy = '127.0.0.1,localhost,::1'
process.env.NO_PROXY = '127.0.0.1,localhost,::1'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const BASE = process.env.BROWSER_ACCEPT_BASE ?? 'http://127.0.0.1:4174'
const OUT = join('练习', '_reliability-browser')
const USER_DATA = join(tmpdir(), `tellshu-reliability-${Date.now()}`)

mkdirSync(OUT, { recursive: true })

const report = {
  startedAt: new Date().toISOString(),
  base: BASE,
  profile: 'isolated userDataDir',
  checks: [],
  notVerified: [
    'in-flight 事务在 db.close() 瞬间中止的逐拍时序（浏览器无法精确注入）',
    '升级中途 kill 浏览器进程后重启（需独立设备与进程控制）',
    'Chromium / Firefox 跨内核矩阵',
    '真实移动端设备与软键盘',
  ],
  screenshots: [],
  observations: [],
}
let failures = 0

function check(id, name, ok, detail = '') {
  report.checks.push({ id, name, ok: Boolean(ok), detail: String(detail) })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function shot(page, file) {
  const path = join(OUT, file)
  try {
    await page.screenshot({ path, fullPage: true })
    report.screenshots.push(path)
  } catch {
    /* 截图失败不影响断言 */
  }
}

/** 种子：先让 App 建库到 v14，再写 6 个真实词条（测试夹具，不是产品代码路径） */
async function seedVocab(page) {
  return page.evaluate(async () => {
    const words = [
      ['abandon', 'v. 抛弃；放弃', 'v.'],
      ['benefit', 'n. 利益；好处', 'n.'],
      ['cabbage', 'n. 卷心菜', 'n.'],
      ['daisy', 'n. 雏菊', 'n.'],
    ]
    const now = Date.now()
    const req = indexedDB.open('shushu-learn')
    const db = await new Promise((res, rej) => {
      req.onsuccess = () => res(req.result)
      req.onerror = () => rej(req.error)
    })
    const tx = db.transaction(['vocab', 'spellingSessions', 'spellingErrorEvents', 'reviewLog'], 'readwrite')
    tx.objectStore('vocab').clear()
    tx.objectStore('spellingSessions').clear()
    tx.objectStore('spellingErrorEvents').clear()
    tx.objectStore('reviewLog').clear()
    for (const [i, [word, definition_zh, pos]] of words.entries()) {
      tx.objectStore('vocab').put({
        word_id: `seed:${word}`,
        word,
        book: 'CET4',
        definition_zh,
        pos,
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
  })
}

/** 只读取样：事件行 + 会话锁字段 */
async function dbState(page) {
  return page.evaluate(async () => {
    const req = indexedDB.open('shushu-learn')
    const db = await new Promise((res, rej) => {
      req.onsuccess = () => res(req.result)
      req.onerror = () => rej(req.error)
      req.onblocked = () => rej(new Error('open blocked'))
    })
    const tx = db.transaction(['spellingErrorEvents', 'spellingSessions'], 'readonly')
    const read = (store) =>
      new Promise((res, rej) => {
        const r = tx.objectStore(store).getAll()
        r.onsuccess = () => res(r.result)
        r.onerror = () => rej(r.error)
      })
    const events = await read('spellingErrorEvents')
    const sessions = await read('spellingSessions')
    db.close()
    return { events, sessions }
  })
}

async function waitForText(page, text, timeout = 12000) {
  try {
    await page.waitForFunction(
      (t) => document.body?.innerText?.includes(t),
      { timeout },
      text,
    )
    return true
  } catch {
    return false
  }
}

async function inputEnabled(page) {
  return page.evaluate(() => {
    const el = document.querySelector('#spelling-input')
    return el ? !el.disabled : false
  })
}

async function run() {
  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: true,
    userDataDir: USER_DATA,
    args: ['--no-first-run', '--no-default-browser-check', '--disable-features=Translate'],
  })

  try {
    const pageA = await browser.newPage()
    await pageA.setViewport({ width: 390, height: 844 })
    await pageA.goto(`${BASE}/spelling`, { waitUntil: 'networkidle2', timeout: 30000 })
    await seedVocab(pageA)
    await pageA.reload({ waitUntil: 'networkidle2', timeout: 30000 })
    await pageA.waitForSelector('#spelling-input', { timeout: 15000 }).catch(() => {})

    /* ---- R1 单标签取锁 ---- */
    const r1 = await inputEnabled(pageA)
    check('R1', '单标签取锁成功后输入框启用', r1, `inputEnabled=${r1}`)
    await shot(pageA, 'r1-single-tab.png')

    /* ---- R2 生产写路径真的落事件 ----
     * V2 逐字母状态机：输入框每接一个字符即时判定，5 个错误字母 = 5 条独立事件
     * （产品规则 1/2：任意真实错误字母立即记录、每个错误字母计一次）。
     * 旧断言「整词提交 1 条」属 V1 语义，已随交互升级适配，产品行为未回退。
     * 回车在 V2 中不再触发整词提交，故不再发送 Enter。
     */
    await pageA.type('#spelling-input', 'zzzzz')
    await sleep(1200)
    const s2 = await dbState(pageA)
    const wrongEvents = s2.events.filter((e) => e.kind === 'wrong')
    check(
      'R2',
      '5 个错误字母落 5 条独立错词事件且全部已结算',
      wrongEvents.length === 5 &&
        wrongEvents.every((e) => e.status === 'settled') &&
        new Set(wrongEvents.map((e) => e.event_id)).size === 5,
      `events=${s2.events.length} wrong=${wrongEvents.length} settled=${wrongEvents.filter((e) => e.status === 'settled').length}`,
    )
    const session2 = s2.sessions[0]
    check(
      'R2b',
      '会话文档写入结算凭证与锁代次',
      Boolean(session2?.applied_error_event_ids?.[wrongEvents[0]?.event_id]) &&
        typeof session2?.lock_epoch === 'number',
      `epoch=${session2?.lock_epoch} credentials=${Object.keys(session2?.applied_error_event_ids ?? {}).length}`,
    )

    /* ---- R3 第二真实标签页 ---- */
    const pageB = await browser.newPage()
    await pageB.setViewport({ width: 390, height: 844 })
    await pageB.goto(`${BASE}/spelling`, { waitUntil: 'networkidle2', timeout: 30000 })
    const diagA = await pageA.evaluate(() => sessionStorage.getItem('shushu.spelling.tab_id'))
    const diagB = await pageB.evaluate(() => sessionStorage.getItem('shushu.spelling.tab_id'))
    const assetsB = await pageB.evaluate(() => ({
      scripts: [...document.querySelectorAll('script[src]')].map((s) => s.src),
      sw: Boolean(navigator.serviceWorker?.controller),
    }))
    // 证据：两个真实标签拥有独立 tab id、加载同一份构建产物
    report.observations.push(`tabA=${diagA} tabB=${diagB} same=${diagA === diagB}`)
    report.observations.push(`bundle=${JSON.stringify(assetsB.scripts)} sw=${assetsB.sw}`)
    console.log(`  [evidence] 独立标签身份=${diagA !== diagB}，bundle=${assetsB.scripts[0]?.split('/').pop()}`)
    const r3 = await waitForText(pageB, '另一标签页正在使用本会话')
    check('R3', '第二标签页进入同一会话显示冲突面板（未静默并发）', r3)
    await shot(pageB, 'r3-conflict.png')

    /* ---- R4 显式接管 ---- */
    const takeoverClicked = await pageB.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find((b) =>
        b.textContent?.includes('在此标签继续'),
      )
      if (!btn || btn.disabled) return false
      btn.click()
      return true
    })
    await sleep(900)
    const r4 = takeoverClicked && (await inputEnabled(pageB))
    check('R4', '用户显式接管后新标签可输入', r4, `clicked=${takeoverClicked}`)
    const s4 = await dbState(pageB)
    check(
      'R4b',
      '接管使 fencing token 原子 +1',
      s4.sessions[0]?.lock_epoch === 1,
      `epoch=${s4.sessions[0]?.lock_epoch}`,
    )
    await shot(pageB, 'r4-takeover.png')

    /* ---- R5 旧标签写入被拒 ---- */
    await pageA.bringToFront()
    await pageA.focus('#spelling-input').catch(() => {})
    await pageA.type('#spelling-input', 'yyyyy').catch(() => {})
    await pageA.keyboard.press('Enter').catch(() => {})
    await sleep(800)
    const r5 = await waitForText(pageA, '另一标签页正在使用本会话', 6000)
    check('R5', '旧标签继续写入被拒并进入只读冲突面板', r5)
    await shot(pageA, 'r5-stale-rejected.png')

    /* ---- R6 刷新恢复链 ---- */
    await pageB.bringToFront()
    await pageB.reload({ waitUntil: 'networkidle2', timeout: 30000 })
    await sleep(700)
    const r6 = await inputEnabled(pageB)
    const s6 = await dbState(pageB)
    const pending6 = s6.events.filter((e) => e.status === 'pending').length
    check(
      'R6',
      '刷新后恢复链完成、输入启用且无遗留 pending',
      r6 && pending6 === 0,
      `inputEnabled=${r6} pending=${pending6} sessions=${s6.sessions.length}`,
    )

    /* ---- R7 升级中断（versionchange → 升级事务回滚）后重启 ---- */
    const upgrade = await pageB.evaluate(async () => {
      const req = indexedDB.open('shushu-learn', 150)
      req.onupgradeneeded = (e) => {
        // 让升级事务回滚：其余连接已收到 versionchange，原生版本保持 140
        try {
          e.target.transaction.abort()
        } catch {
          /* 已结束 */
        }
      }
      return new Promise((res) => {
        req.onblocked = () => res('blocked')
        req.onerror = () => res(`error:${req.error?.name ?? 'unknown'}`)
        req.onsuccess = () => {
          req.result.close()
          res('unexpected-success')
        }
        setTimeout(() => res('timeout'), 6000)
      })
    })
    check(
      'R7a',
      '触发 versionchange 且升级事务回滚（未产生新版本）',
      upgrade.startsWith('error:'),
      `result=${upgrade}`,
    )

    await pageB.reload({ waitUntil: 'networkidle2', timeout: 30000 })
    await sleep(900)
    const r7b = await inputEnabled(pageB)
    const s7 = await dbState(pageB)
    const pending7 = s7.events.filter((e) => e.status === 'pending').length
    check(
      'R7b',
      '升级中断后重启：事件与会话不丢、无 pending、输入恢复',
      r7b && s7.events.length >= 1 && pending7 === 0 && s7.sessions.length === 1,
      `inputEnabled=${r7b} events=${s7.events.length} pending=${pending7} sessions=${s7.sessions.length}`,
    )
    await shot(pageB, 'r7-after-upgrade-interrupt.png')
  } finally {
    await browser.close()
    try {
      rmSync(USER_DATA, { recursive: true, force: true })
    } catch {
      /* 临时 profile 清理失败不影响结论 */
    }
  }

  report.finishedAt = new Date().toISOString()
  report.failures = failures
  report.passed = report.checks.filter((c) => c.ok).length
  writeFileSync(join(OUT, '_reliability-browser-report.json'), JSON.stringify(report, null, 2))
  console.log(`\n${'─'.repeat(60)}`)
  console.log(`真机回归：${report.passed} 通过 / ${failures} 失败（${report.checks.length} 项）`)
  report.notVerified.forEach((n) => console.log(`N/A  ${n}`))
  if (failures > 0) process.exit(1)
}

void run().catch((err) => {
  console.error('真机回归执行异常', err)
  process.exit(1)
})
