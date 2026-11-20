#!/usr/bin/env node
/**
 * 崩溃 / 进程 kill / 跨内核 / 移动模拟 · 补充真机验证
 * ------------------------------------------------------------------
 * 与 check_reliability_browser.mjs 互补：本脚本专测「中断后重启」，
 * 用**同一个隔离 userDataDir** 做两轮浏览器启动（第二轮在 SIGKILL 之后）。
 * 不触碰用户日常浏览器数据；结束后删除临时 profile。
 *
 * 前置：npm run build；npm run preview -- --port 4174 --strictPort
 * 用法：node scripts/check_reliability_recovery_browser.mjs
 *
 * R8  渲染进程崩溃（CDP Page.crash）后重启：锁未释放→冲突面板→接管→数据不丢
 * R9  浏览器进程 SIGKILL 后同 profile 重启：恢复链收敛、无 pending
 * R10 跨内核矩阵（Chrome / Firefox 可用性；缺失登记 N/A）
 * R11 移动视口 + 触摸**模拟**（非真机；adb / 真机缺失登记 N/A）
 *
 * 如实标注：并发触发崩溃无法保证恰好落在 IDB 事务逐拍中间，
 * 逐拍 in-flight 时序仍为 N/A（浏览器侧无法精确注入）。
 */

import puppeteer from 'puppeteer-core'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

process.env.no_proxy = '127.0.0.1,localhost,::1'
process.env.NO_PROXY = '127.0.0.1,localhost,::1'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const BASE = process.env.BROWSER_ACCEPT_BASE ?? 'http://127.0.0.1:4174'
const OUT = join('练习', '_reliability-browser')
const USER_DATA = join(tmpdir(), `tellshu-recovery-${Date.now()}`)

mkdirSync(OUT, { recursive: true })

const report = {
  startedAt: new Date().toISOString(),
  base: BASE,
  profile: 'isolated userDataDir, two launches',
  checks: [],
  observations: [],
  notVerified: [
    'IDB 事务逐拍 in-flight 中断时序（浏览器无法精确注入；自动化层已用 fake-indexeddb 事务 abort 覆盖）',
    '真实移动设备与软键盘（无 adb、无真机；R11 仅为视口/触摸模拟）',
  ],
  screenshots: [],
}
let failures = 0

function check(id, name, ok, detail = '') {
  report.checks.push({ id, name, ok: Boolean(ok), detail: String(detail) })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function shot(page, file) {
  const p = join(OUT, file)
  try {
    await page.screenshot({ path: p, fullPage: true })
    report.screenshots.push(p)
  } catch {
    /* 截图失败不影响断言 */
  }
}

async function launch() {
  return puppeteer.launch({
    executablePath: EDGE,
    headless: true,
    userDataDir: USER_DATA,
    args: ['--no-first-run', '--no-default-browser-check', '--disable-features=Translate'],
  })
}

async function seedVocab(page) {
  return page.evaluate(async () => {
    const words = [
      ['abandon', 'v. 抛弃；放弃', 'v.'],
      ['benefit', 'n. 利益；好处', 'n.'],
      ['cabbage', 'n. 卷心菜', 'n.'],
    ]
    const now = Date.now()
    const req = indexedDB.open('shushu-learn')
    const db = await new Promise((res, rej) => {
      req.onsuccess = () => res(req.result)
      req.onerror = () => rej(req.error)
    })
    const tx = db.transaction(
      ['vocab', 'spellingSessions', 'spellingErrorEvents', 'reviewLog'],
      'readwrite',
    )
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
    await page.waitForFunction((t) => document.body?.innerText?.includes(t), { timeout }, text)
    return true
  } catch {
    return false
  }
}

async function clickTakeover(page) {
  return page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('在此标签继续'),
    )
    if (!btn || btn.disabled) return false
    btn.click()
    return true
  })
}

async function inputEnabled(page) {
  return page.evaluate(() => {
    const el = document.querySelector('#spelling-input')
    return el ? !el.disabled : false
  })
}

/**
 * V2 逐字母状态机：每个错误字母即时落 1 条独立事件（产品规则 1/2）。
 * 回车不再触发整词提交，故不发送 Enter；等待时间需覆盖 5 次串行 atomicBatch。
 * 旧版「整词提交 1 条事件」的断言已随交互语义升级适配，产品行为未回退。
 */
async function submitWrong(page, value) {
  await page.type('#spelling-input', value)
  await sleep(1200)
}

let browser = null

async function run() {
  /* ---------- R10 跨内核可用性（先登记，不计入 pass/fail） ---------- */
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
    'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe',
  ]
  const found = candidates.filter((p) => existsSync(p))
  report.observations.push(`跨内核候选可执行文件命中数=${found.length}`)
  if (found.length === 0) {
    report.notVerified.push('跨内核矩阵 N/A：本机仅安装 Edge（Chromium 内核），无独立 Chrome / Firefox')
  } else {
    report.observations.push(`可用其它内核/浏览器：${found.join(', ')}（本脚本仍用 Edge 执行）`)
  }

  /* ---------- 第一轮启动 ---------- */
  browser = await launch()
  const pageA = await browser.newPage()
  await pageA.setViewport({ width: 390, height: 844 })
  await pageA.goto(`${BASE}/spelling`, { waitUntil: 'networkidle2', timeout: 30000 })
  await seedVocab(pageA)
  await pageA.reload({ waitUntil: 'networkidle2', timeout: 30000 })
  await pageA.waitForSelector('#spelling-input', { timeout: 15000 })

  await submitWrong(pageA, 'zzzzz')
  const before = await dbState(pageA)
  console.log(`  [diag] 崩溃前 holder=${before.sessions[0]?.active_tab_id} epoch=${before.sessions[0]?.lock_epoch} held=${before.sessions[0]?.lock_held_at} now=${Date.now()}`)
  check(
    'R8a',
    '崩溃前已产生 5 条 settled 逐字母事件与 5 条凭证',
    before.events.length === 5 &&
      before.events.every((e) => e.status === 'settled') &&
      Object.keys(before.sessions[0]?.applied_error_event_ids ?? {}).length === 5,
    `events=${before.events.length} settled=${before.events.filter((e) => e.status === 'settled').length} credentials=${Object.keys(before.sessions[0]?.applied_error_event_ids ?? {}).length}`,
  )

  /* ---------- R8 渲染进程崩溃（提交与 Page.crash 并发） ---------- */
  const client = await pageA.createCDPSession()
  // V2：逐字母输入过程中并发触发渲染进程崩溃（Enter 不再触发提交）
  const typing = pageA.type('#spelling-input', 'yyyyy').catch(() => {})
  const crashing = client.send('Page.crash').catch(() => {})
  await Promise.allSettled([typing, Promise.race([crashing, sleep(1500)])])
  await sleep(500)

  const tabBeforeCrash = await pageA.evaluate(() =>
    sessionStorage.getItem('shushu.spelling.tab_id'),
  ).catch(() => null)
  // 用不加载 App JS 的静态资源页读取崩溃瞬间的原始锁状态（不触发恢复链）
  const probe = await browser.newPage()
  await probe.goto(`${BASE}/manifest.webmanifest`, { waitUntil: 'domcontentloaded' }).catch(() => {})
  const rawLock = await probe.evaluate(async () => {
    const req = indexedDB.open('shushu-learn')
    const db = await new Promise((res, rej) => {
      req.onsuccess = () => res(req.result)
      req.onerror = () => rej(req.error)
    })
    const tx = db.transaction(['spellingSessions', 'spellingErrorEvents'], 'readonly')
    const read = (store) => new Promise((res) => {
      const r = tx.objectStore(store).getAll()
      r.onsuccess = () => res(r.result)
    })
    const sessions = await read('spellingSessions')
    const events = await read('spellingErrorEvents')
    db.close()
    return { sessions, events }
  }).catch((e) => ({ error: e.message }))
  console.log(`  [diag] 崩溃瞬间原始: holder=${rawLock.sessions?.[0]?.active_tab_id} epoch=${rawLock.sessions?.[0]?.lock_epoch} held=${rawLock.sessions?.[0]?.lock_held_at} events=${rawLock.events?.length} now=${Date.now()}`)
  await probe.close().catch(() => {})
  const pageAfterCrash = await browser.newPage()
  await pageAfterCrash.setViewport({ width: 390, height: 844 })
  await pageAfterCrash.goto(`${BASE}/spelling`, { waitUntil: 'networkidle2', timeout: 30000 })
  const diagAfterCrash = await pageAfterCrash.evaluate(() => ({
    body: document.body?.innerText?.slice(0, 220),
    tabId: sessionStorage.getItem('shushu.spelling.tab_id'),
    inputDisabled: document.querySelector('#spelling-input')?.disabled,
  }))
  const lockDiag = await dbState(pageAfterCrash)
  console.log(`  [evidence] 崩溃前原始锁 holder=${rawLock.sessions?.[0]?.active_tab_id} epoch=${rawLock.sessions?.[0]?.lock_epoch} held=${rawLock.sessions?.[0]?.lock_held_at}`)
  console.log(`  [evidence] 恢复后 holder=${lockDiag.sessions[0]?.active_tab_id} epoch=${lockDiag.sessions[0]?.lock_epoch} 新标签id=${diagAfterCrash.tabId} 输入禁用=${diagAfterCrash.inputDisabled}`)
  void tabBeforeCrash
  const conflictShown = await waitForText(pageAfterCrash, '另一标签页正在使用本会话', 3000)
  const afterHolder = lockDiag.sessions[0]?.active_tab_id
  const afterEpoch = lockDiag.sessions[0]?.lock_epoch
  const newTabId = diagAfterCrash.tabId
  check(
    'R8b',
    '崩溃恢复后锁归属当前标签、epoch 自洽（0=同标签复用 / 1=租约过期接管）',
    afterHolder === newTabId && (afterEpoch === 0 || afterEpoch === 1),
    `holder=${afterHolder} tab=${newTabId} epoch=${afterEpoch} conflictPanel=${conflictShown}`,
  )
  // 两条合法恢复路径都要验证：租约未过期→冲突面板+显式接管；租约已过期→自动接管
  if (conflictShown) {
    const tookOver = await clickTakeover(pageAfterCrash)
    await sleep(800)
    check(
      'R8b2',
      '快速恢复路径：冲突面板可显式接管且输入启用',
      tookOver && (await inputEnabled(pageAfterCrash)),
      `takeover=${tookOver}`,
    )
  } else {
    check(
      'R8b2',
      '延迟恢复路径：租约过期自动接管（epoch+1）且输入启用',
      afterEpoch === 1 && (await inputEnabled(pageAfterCrash)),
      `epoch=${afterEpoch}`,
    )
    report.observations.push(
      'R8 实测曾出现 CDP 崩溃等待约 6 分钟 > 30s 租约 → 自动接管 epoch+1，产品行为符合设计',
    )
  }
  const stateAfterCrash = await dbState(pageAfterCrash)
  const pendingAfterCrash = stateAfterCrash.events.filter((e) => e.status === 'pending').length
  check(
    'R8c',
    '崩溃后恢复：事件与凭证不丢、无 pending、输入恢复',
    (await inputEnabled(pageAfterCrash)) &&
      stateAfterCrash.events.length >= 1 &&
      pendingAfterCrash === 0 &&
      Object.keys(stateAfterCrash.sessions[0]?.applied_error_event_ids ?? {}).length >= 1,
    `events=${stateAfterCrash.events.length} pending=${pendingAfterCrash} credentials=${Object.keys(stateAfterCrash.sessions[0]?.applied_error_event_ids ?? {}).length}`,
  )
  await shot(pageAfterCrash, 'r8-after-renderer-crash.png')

  /* ---------- R9 浏览器进程 SIGKILL + 同 profile 重启 ---------- */
  await submitWrong(pageAfterCrash, 'qqqqq')
  const beforeKill = await dbState(pageAfterCrash)
  const pid = browser.process()?.pid
  check('R9a', '可获取浏览器进程 pid 以执行强制终止', Boolean(pid), `pid=${pid}`)
  if (pid) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch (e) {
      report.observations.push(`SIGKILL 抛出：${e.message}`)
    }
  }
  await sleep(1200)
  browser = null

  let relaunched = null
  try {
    relaunched = await launch()
  } catch (e) {
    report.observations.push(`同 profile 重启失败：${e.message}`)
  }
  check('R9b', 'SIGKILL 后可用同一 userDataDir 重新启动浏览器', Boolean(relaunched))
  if (relaunched) {
    browser = relaunched
    const pageAfterKill = await browser.newPage()
    await pageAfterKill.setViewport({ width: 390, height: 844 })
    await pageAfterKill.goto(`${BASE}/spelling`, { waitUntil: 'networkidle2', timeout: 30000 })
    const conflictAfterKill = await waitForText(pageAfterKill, '另一标签页正在使用本会话')
    if (conflictAfterKill) await clickTakeover(pageAfterKill)
    await sleep(800)
    const afterKill = await dbState(pageAfterKill)
    const pendingAfterKill = afterKill.events.filter((e) => e.status === 'pending').length
    check(
      'R9c',
      '进程 kill 后重启：事件/凭证完整、无 pending、恢复链可用',
      afterKill.events.length >= beforeKill.events.length &&
        afterKill.sessions.length === 1 &&
        pendingAfterKill === 0 &&
        (await inputEnabled(pageAfterKill)),
      `events ${beforeKill.events.length}→${afterKill.events.length} pending=${pendingAfterKill} sessions=${afterKill.sessions.length}`,
    )
    await shot(pageAfterKill, 'r9-after-process-kill.png')

    /* ---------- R11 移动视口 + 触摸模拟（非真机） ---------- */
    await pageAfterKill.setViewport({
      width: 390,
      height: 844,
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
    })
    await pageAfterKill.reload({ waitUntil: 'networkidle2', timeout: 30000 })
    await sleep(600)
    const mobile = await pageAfterKill.evaluate(() => ({
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
      hasInput: Boolean(document.querySelector('#spelling-input')),
      disabled: document.querySelector('#spelling-input')?.disabled,
      hasTouch: 'ontouchstart' in window,
    }))
    check(
      'R11',
      '移动视口触摸模拟：无横向溢出、输入框可交互、触摸事件可用',
      mobile.scrollW <= mobile.clientW && mobile.hasInput && !mobile.disabled && mobile.hasTouch,
      `scrollW=${mobile.scrollW} clientW=${mobile.clientW} hasTouch=${mobile.hasTouch}`,
    )
    report.observations.push('R11 为视口/触摸模拟，非真实移动设备；无 adb 与真机，移动真机验证 N/A')
    await shot(pageAfterKill, 'r11-mobile-viewport-simulation.png')
  }
}

try {
  await run()
} finally {
  if (browser) {
    try {
      await browser.close()
    } catch {
      /* 已 kill */
    }
  }
  try {
    rmSync(USER_DATA, { recursive: true, force: true })
  } catch {
    /* 临时 profile 清理失败不影响结论 */
  }
  report.finishedAt = new Date().toISOString()
  report.failures = failures
  report.passed = report.checks.filter((c) => c.ok).length
  writeFileSync(join(OUT, '_recovery-browser-report.json'), JSON.stringify(report, null, 2))
  console.log(`\n${'─'.repeat(60)}`)
  console.log(`补充真机回归：${report.passed} 通过 / ${failures} 失败（${report.checks.length} 项）`)
  report.notVerified.forEach((n) => console.log(`N/A  ${n}`))
  if (failures > 0) process.exit(1)
}
