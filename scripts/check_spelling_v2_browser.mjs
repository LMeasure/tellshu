#!/usr/bin/env node
/**
 * 单词默写 V2 · 逐字母状态机 + 结果页统计 · 真实浏览器渲染验收
 * ------------------------------------------------------------------
 * 与自动化层的区别：本脚本用 Edge + puppeteer-core 打开**真实页面**，
 * 通过 DOM 文本 / data-testid / 真实键盘输入断言渲染结果与交互，
 * 并以原生 IndexedDB 读取核对持久化结果。**不以 build 成功代替 UI 验收**。
 *
 * 前置：npm run build；npm run preview -- --port 4174 --strictPort
 * 用法：node scripts/check_spelling_v2_browser.mjs
 *
 * 覆盖：
 *   U1 逐字母输入：正确字母推进进度（DOM 显示）
 *   U2 错误字母即时落 1 条事件 + DOM 反馈 + 进度归零
 *   U3 连续两个错误字母 = 2 条独立事件
 *   U4 错误不增加 total_attempts / 不触发 SRS
 *   U5 达标才完成单词（整词拼对才是一次完整答题提交）
 *   R1 结果页 active / total 两个指标分别渲染
 *   R2 reset 覆盖后 active 下降、total 不变
 *   R3 stale 事件排除提示
 *   R4 ORPHAN / 无法归类异常提示
 *   R5 空数据 → EmptyState
 *   R6 当前账号范围说明
 *   R7 错词本按词合并渲染（错误次数 / 最近时间）
 *
 * N/A（如实登记，不伪造）：
 *   · 真实移动设备与软键盘（本机仅 Edge 桌面；视口模拟不等于真机）
 *   · 跨内核矩阵（仅 Chromium 内核 Edge）
 *   · 错误提示音的「实际发声」——浏览器无音频采集，自动化层已用
 *     SpeechService.playErrorTone() 计数断言触发；此处只核对反馈 UI
 *   · IDB 事务逐拍 in-flight 中断时序
 */

import puppeteer from 'puppeteer-core'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

process.env.no_proxy = '127.0.0.1,localhost,::1'
process.env.NO_PROXY = '127.0.0.1,localhost,::1'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const BASE = process.env.BROWSER_ACCEPT_BASE ?? 'http://127.0.0.1:4174'
const OUT = join('练习', '_v2-browser')
const USER_DATA = join(tmpdir(), `tellshu-v2-${Date.now()}`)
mkdirSync(OUT, { recursive: true })

const report = {
  startedAt: new Date().toISOString(),
  base: BASE,
  checks: [],
  notVerified: [
    '真实移动设备与软键盘（仅桌面 Edge 视口模拟）',
    '跨内核矩阵（仅 Chromium 内核 Edge，无独立 Chrome / Firefox）',
    '错误提示音的实际发声（无音频采集；自动化层以 playErrorTone 调用计数断言）',
    'IDB 事务逐拍 in-flight 中断时序（浏览器无法精确注入）',
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
  const path = join(OUT, file)
  try {
    await page.screenshot({ path, fullPage: true })
    report.screenshots.push(path)
  } catch {
    /* 截图失败不影响断言 */
  }
}

/** 让 App 建库到 v14，再写入测试词条（夹具，非产品代码路径） */
async function seedVocab(page) {
  return page.evaluate(async () => {
    const words = [
      ['abandon', 'v. 抛弃；放弃', 'v.'],
      ['benefit', 'n. 利益；好处', 'n.'],
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

/** 读取事件表 / 会话表（原生 IDB 只读） */
async function dbState(page) {
  return page.evaluate(async () => {
    const req = indexedDB.open('shushu-learn')
    const db = await new Promise((res, rej) => {
      req.onsuccess = () => res(req.result)
      req.onerror = () => rej(req.error)
    })
    const tx = db.transaction(['spellingErrorEvents', 'spellingSessions', 'reviewLog'], 'readonly')
    const read = (store) =>
      new Promise((res, rej) => {
        const r = tx.objectStore(store).getAll()
        r.onsuccess = () => res(r.result)
        r.onerror = () => rej(r.error)
      })
    const events = await read('spellingErrorEvents')
    const sessions = await read('spellingSessions')
    const reviewLog = await read('reviewLog')
    db.close()
    return { events, sessions, reviewLog }
  })
}

/** 为结果页渲染断言注入会话 + 事件行（夹具） */
async function seedResultData(page, variant) {
  return page.evaluate(async (v) => {
    const now = Date.now()
    const SID = 'v2-result'
    const req = indexedDB.open('shushu-learn')
    const db = await new Promise((res, rej) => {
      req.onsuccess = () => res(req.result)
      req.onerror = () => rej(req.error)
    })
    const tx = db.transaction(['spellingSessions', 'spellingErrorEvents'], 'readwrite')
    tx.objectStore('spellingErrorEvents').clear()
    const sess = {
      id: SID,
      type: 'spelling',
      owner: 'guest',
      status: 'SESSION_COMPLETED',
      selection_mode: 'recent',
      target_correct: 3,
      total_words: 2,
      current_position: -1,
      started_at: now - 60000,
      updated_at: now,
      ended_at: now,
      queue: [
        {
          word_id: 'CET4:abandon', word: 'abandon', definition_zh: 'v. 抛弃',
          position: 0, status: 'COMPLETED', consecutive_correct: 3, target_correct: 3,
          total_attempts: 3, correct_attempts: 3, wrong_attempts: 0, srs_reported: true,
        },
        {
          word_id: 'CET4:benefit', word: 'benefit', definition_zh: 'n. 利益',
          position: 1, status: 'COMPLETED', consecutive_correct: 3, target_correct: 3,
          total_attempts: 3, correct_attempts: 3, wrong_attempts: 0, srs_reported: true,
        },
      ],
      processed_requests: {},
      active_tab_id: 'tab-fixture',
      lock_epoch: 0,
      lock_held_at: now,
      applied_error_event_ids: { e1: true, e2: true },
    }
    tx.objectStore('spellingSessions').put(sess)

    const base = {
      owner: 'guest', session_id: SID, word_id: 'CET4:abandon', kind: 'wrong',
      status: 'settled', tab_id: 'tab-fixture', lock_epoch: 0,
      word_snapshot: 'abandon', error_source: 'letter',
    }
    if (v === 'full') {
      const e1 = { ...base, event_id: 'e1', occurred_at: now - 4000, letter_index: 0, typed_char: 'z', expected_char: 'a' }
      const e2 = { ...base, event_id: 'e2', occurred_at: now - 3000, letter_index: 1, typed_char: 'x', expected_char: 'b' }
      // 旧代次：无凭证、lock_epoch 落后 → PENDING_STALE（不计入 active）
      const e3 = { ...base, event_id: 'e3', occurred_at: now - 2000, lock_epoch: 9, letter_index: 2, typed_char: 'q', expected_char: 'a' }
      // 缺代次字段 → UNCLASSIFIABLE（异常提示）
      const e4 = { ...base, event_id: 'e4', occurred_at: now - 1000, letter_index: 3, typed_char: 'p', expected_char: 'b' }
      delete e4.lock_epoch
      // reset 覆盖 e2（内容寻址快照）
      const reset = {
        ...base, event_id: 'R1', kind: 'wrong', status: 'settled',
        occurred_at: now - 500, covered_event_ids: ['e2'],
      }
      for (const row of [e1, e2, e3, e4, reset]) tx.objectStore('spellingErrorEvents').put(row)
    }
    await new Promise((res, rej) => {
      tx.oncomplete = res
      tx.onerror = () => rej(tx.error)
    })
    db.close()
    return SID
  }, variant)
}

async function textOf(page, testId) {
  return page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`)
    return el ? el.textContent?.trim() ?? null : null
  }, testId)
}
async function waitForTestId(page, testId, timeout = 12000) {
  try {
    await page.waitForSelector(`[data-testid="${testId}"]`, { timeout })
    return true
  } catch {
    return false
  }
}
async function typeLetter(page, ch) {
  await page.focus('#spelling-input')
  await page.keyboard.type(ch)
  await sleep(420) // 等待 atomicBatch 写入 + React 重渲染
}

async function run() {
  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: 'new',
    userDataDir: USER_DATA,
    args: ['--no-first-run', '--no-default-browser-check', '--disable-features=Translate'],
  })
  let page
  try {
    page = await browser.newPage()
    await page.setViewport({ width: 390, height: 844 })
    page.on('pageerror', (e) => console.log('  [pageerror]', e.message))

    /* ================= 一、逐字母交互 ================= */
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle2' })
    await sleep(800)
    const seeded = await seedVocab(page)
    check('U0', '种子词条写入（App 已建库到 v14）', seeded === 2, `words=${seeded}`)

    await page.goto(`${BASE}/spelling`, { waitUntil: 'networkidle2' })
    await page.waitForSelector('#spelling-input:not([disabled])', { timeout: 20000 })
    check('U1a', '取锁/恢复链完成后逐字母输入框启用', true, 'inputEnabled=true')

    const before = await dbState(page)
    const s0 = before.sessions[0]
    const cur = s0?.queue?.find((w) => w.position === s0.current_position)
    const answer = cur?.word ?? ''
    check('U1b', '会话已创建且能定位当前词', Boolean(answer), `answer=${answer}`)

    const first = answer[0] ?? 'a'
    await typeLetter(page, first)
    const afterCorrect = await dbState(page)
    const s1 = afterCorrect.sessions[0]
    const w1 = s1?.queue?.find((w) => w.position === s1.current_position)
    check('U1c', '正确字母推进输入进度（持久化）', (w1?.typed_prefix ?? '') === first,
      `typed_prefix=${w1?.typed_prefix ?? ''}`)
    check('U1d', '正确字母不产生错词事件', afterCorrect.events.length === 0,
      `events=${afterCorrect.events.length}`)
    check('U1e', '正确字母不构成完整答题提交', (w1?.total_attempts ?? -1) === 0,
      `total_attempts=${w1?.total_attempts}`)
    const progressText = await textOf(page, 'letter-progress')
    check('U1f', '页面渲染逐字母进度（DOM 文本）', (progressText ?? '').includes(first),
      `progress=${progressText}`)
    const feedbackCorrect = await page.evaluate(() =>
      document.querySelector('[data-testid="letter-feedback"]')?.getAttribute('data-outcome'))
    check('U1g', '页面渲染「正确」反馈（DOM 属性）', feedbackCorrect === 'correct',
      `outcome=${feedbackCorrect}`)

    // 错误字母：选一个与期望字母不同的合法字母
    const expected2 = answer[1] ?? 'b'
    const wrongChar = expected2.toLowerCase() === 'z' ? 'q' : 'z'
    await typeLetter(page, wrongChar)
    const afterWrong = await dbState(page)
    check('U2a', '错误字母即时落 1 条错词事件', afterWrong.events.length === 1,
      `events=${afterWrong.events.length}`)
    const e0 = afterWrong.events[0]
    check('U2b', '事件为逐字母来源且记录字母位置',
      e0?.error_source === 'letter' && typeof e0?.letter_index === 'number',
      `source=${e0?.error_source} index=${e0?.letter_index}`)
    const s2 = afterWrong.sessions[0]
    const w2 = s2?.queue?.find((w) => w.position === s2.current_position)
    check('U2c', '错误后输入进度清零（持久化）', (w2?.typed_prefix ?? 'x') === '',
      `typed_prefix=${JSON.stringify(w2?.typed_prefix)}`)
    check('U2d', '错误后连续正确次数归零', (w2?.consecutive_correct ?? -1) === 0,
      `consecutive_correct=${w2?.consecutive_correct}`)
    check('U2e', '错误不增加 total_attempts', (w2?.total_attempts ?? -1) === 0,
      `total_attempts=${w2?.total_attempts}`)
    check('U2f', '错误不触发 SRS（reviewLog 无新增）', afterWrong.reviewLog.length === 0,
      `reviewLog=${afterWrong.reviewLog.length}`)
    const feedbackWrong = await page.evaluate(() =>
      document.querySelector('[data-testid="letter-feedback"]')?.getAttribute('data-outcome'))
    check('U2g', '页面渲染「错误 + 从头开始」反馈（DOM）', feedbackWrong === 'wrong',
      `outcome=${feedbackWrong}`)
    const feedbackText = await textOf(page, 'letter-feedback')
    check('U2h', '错误反馈文案含「从第一个字母重新开始」',
      (feedbackText ?? '').includes('从第一个字母重新开始'), `text=${feedbackText}`)
    await shot(page, 'u2-wrong-letter.png')

    // 第二个错误字母 → 第 2 条独立事件
    await typeLetter(page, wrongChar === 'z' ? 'q' : 'z')
    const afterTwo = await dbState(page)
    check('U3a', '同一单词连续两个错误字母 = 2 条独立事件', afterTwo.events.length === 2,
      `events=${afterTwo.events.length}`)
    check('U3b', '两个事件 event_id 不同',
      new Set(afterTwo.events.map((e) => e.event_id)).size === 2,
      `ids=${afterTwo.events.map((e) => e.event_id).join(',')}`)

    // 完整拼对整词才算一次完整答题提交
    for (const ch of answer) await typeLetter(page, ch)
    const afterFull = await dbState(page)
    const s3 = afterFull.sessions[0]
    const anyAttempt = (s3?.queue ?? []).some((w) => (w.total_attempts ?? 0) >= 1)
    check('U4', '拼完整个单词才计一次完整答题提交', anyAttempt,
      `total_attempts=${(s3?.queue ?? []).map((w) => w.total_attempts).join(',')}`)
    check('U5', '全程逐字母输入后错词事件数不回退', afterFull.events.length === 2,
      `events=${afterFull.events.length}`)
    await shot(page, 'u4-after-full-word.png')

    /* ================= 二、结果页渲染断言 ================= */
    const sid = await seedResultData(page, 'full')
    await page.goto(`${BASE}/spelling-result?id=${sid}`, { waitUntil: 'networkidle2' })
    await waitForTestId(page, 'error-stats-section')
    await sleep(600)

    const active = await textOf(page, 'stat-active-value')
    const total = await textOf(page, 'stat-total-value')
    // e1 SETTLED_ZEROED(1) / e2 COVERED / e3 PENDING_STALE / e4 UNCLASSIFIABLE → active=1, total=4
    check('R1a', '结果页渲染「当前活动错词事件数」= 1', (active ?? '').trim() === '1',
      `active="${active}"`)
    check('R1b', '结果页渲染「历史错误事件行数」= 4', (total ?? '').trim() === '4',
      `total="${total}"`)
    const labels = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="stat-active"],[data-testid="stat-total"]')]
        .map((el) => el.textContent))
    check('R1c', '两个指标分别标注、名称不同',
      labels.length === 2 && labels[0] !== labels[1], `labels=${JSON.stringify(labels)}`)

    const excluded = await textOf(page, 'stats-excluded')
    check('R3', 'stale / 已移除记录的排除提示已渲染',
      Boolean(excluded && excluded.includes('已排除')), `text=${excluded}`)
    const orphan = await textOf(page, 'stats-orphan')
    check('R4', 'ORPHAN / 无法归类异常提示已渲染',
      Boolean(orphan && orphan.includes('无法归类')), `text=${orphan}`)
    const scope = await textOf(page, 'owner-scope')
    check('R6a', '当前账号范围说明已渲染',
      Boolean(scope && scope.includes('当前账号')), `text=${scope}`)
    const bookScope = await textOf(page, 'wrong-book-owner')
    check('R6b', '错词本区块也标注当前账号范围',
      Boolean(bookScope && bookScope.includes('当前账号')), `text=${bookScope}`)

    const rows = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="wrong-book-row"]')]
        .map((el) => el.textContent?.trim()))
    check('R7a', '错词本按词合并渲染 1 条记录', rows.length === 1, `rows=${rows.length}`)
    check('R7b', '错词本渲染活动/历史条数',
      Boolean(rows[0] && rows[0].includes('活动错词 1 条') && rows[0].includes('历史 4 条')),
      `text=${rows[0]}`)
    const wordText = await textOf(page, 'wrong-book-word')
    check('R7c', '错词本词条文本来自事件快照', wordText === 'abandon', `word=${wordText}`)
    await shot(page, 'r1-result-stats.png')

    // R2：reset 覆盖单独验证（覆盖全部 4 条 → active=0，total 不变）
    await page.evaluate(async () => {
      const req = indexedDB.open('shushu-learn')
      const db = await new Promise((res) => { req.onsuccess = () => res(req.result) })
      const tx = db.transaction(['spellingErrorEvents'], 'readwrite')
      const store = tx.objectStore('spellingErrorEvents')
      const all = await new Promise((res) => {
        const r = store.getAll(); r.onsuccess = () => res(r.result)
      })
      for (const row of all) {
        if (row.event_id === 'R1') {
          store.put({ ...row, covered_event_ids: ['e1', 'e2', 'e3', 'e4'] })
        }
      }
      await new Promise((res) => { tx.oncomplete = res })
      db.close()
    })
    await page.reload({ waitUntil: 'networkidle2' })
    await waitForTestId(page, 'stat-active')
    await sleep(500)
    const active2 = await textOf(page, 'stat-active-value')
    const total2 = await textOf(page, 'stat-total-value')
    check('R2a', 'reset 覆盖后 active = 0', (active2 ?? '').trim() === '0', `active="${active2}"`)
    check('R2b', 'reset 覆盖后 total 仍为 4（历史不物理删除）', (total2 ?? '').trim() === '4',
      `total="${total2}"`)

    // R5：空数据 → EmptyState
    await seedResultData(page, 'empty')
    await page.reload({ waitUntil: 'networkidle2' })
    await sleep(700)
    const emptyText = await page.evaluate(() => document.body?.innerText ?? '')
    check('R5a', '空数据渲染 EmptyState「本轮没有错词事件」',
      emptyText.includes('本轮没有错词事件'), `found=${emptyText.includes('本轮没有错词事件')}`)
    check('R5b', '空数据不显示统计数字卡片',
      !(await waitForTestId(page, 'stat-active', 1200)), 'stat-active 不存在')
    await shot(page, 'r5-empty-state.png')
  } finally {
    writeFileSync(join(OUT, '_v2-browser-report.json'), JSON.stringify(report, null, 2))
    await browser.close()
  }

  const total = report.checks.length
  console.log(`\n${'─'.repeat(64)}`)
  console.log(`V2 浏览器渲染验收：${total - failures} 通过 / ${failures} 失败（${total} 项）`)
  report.notVerified.forEach((n) => console.log(`N/A  ${n}`))
  if (failures > 0) process.exit(1)
}

void run().catch((err) => {
  console.error('❌ 浏览器验收执行异常', err)
  process.exit(1)
})
