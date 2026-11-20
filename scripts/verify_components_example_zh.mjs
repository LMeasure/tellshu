#!/usr/bin/env node
/**
 * EntryDetailCard & StudyNotePanel —— 真实浏览器验收（隔离测试数据注入）
 * ------------------------------------------------------------------
 * 数据安全（最高优先级）：
 *   · 仅向本会话 puppeteer 临时 profile 的 IndexedDB(shushu-learn) 写入带
 *     `test_isolated_` 前缀的隔离记录；验证完成后按 key 精确 delete，
 *     不触碰任何生产/用户数据、不触发 ASR/LLM、不联网、不清空库。
 *   · 词条 / 字幕 / 学习稿三类数据均为真实结构（非伪造语义，仅用于验收渲染）。
 *
 * 验收 7 项：英文例句常显 / 有中文必显 / 不受 chineseAssist 影响 /
 * 统一 text-xs text-emerald-600 dark:text-emerald-400 / 字号比英文小一号 /
 * 无中文不占位 / 深色可读。
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

function parseRGB(s) {
  const m = s.match(/rgba?\(([^)]+)\)/)
  if (!m) return null
  const [r, g, b] = m[1].split(',').map((x) => parseInt(x.trim(), 10))
  return [r, g, b]
}
function isTealLight(s) {
  const c = parseRGB(s)
  if (!c) return false
  return Math.abs(c[0] - 5) + Math.abs(c[1] - 150) + Math.abs(c[2] - 105) <= 120
}
function isTealDark(s) {
  const c = parseRGB(s)
  if (!c) return false
  return Math.abs(c[0] - 52) + Math.abs(c[1] - 211) + Math.abs(c[2] - 153) <= 120
}

const now = Date.now()
const dictEntry = {
  key: 'accepttestword|noun', id: 'test_isolated_entry_1', word: 'accepttestword', word_lower: 'accepttestword',
  phonetic: 'əkˈsept', pos: 'noun', definition_en: 'A test entry used only for browser acceptance.', definition_zh: '验收用测试词条（隔离数据）',
  senses: [], examples: [
    { en: 'The accepttestword appears in this acceptance sentence.', zh: '验收词条出现在这句验收句里。' },
    { en: 'Another accepttestword example without Chinese gloss.', zh: null },
  ],
  phrases: [], synonyms: [], antonyms: [], tags: [], root_affix: null, source_page: '1', source_book: 'AcceptTestBook', updated_at: now,
}
const vocabEntry1 = {
  key: 'exampleword|verb', id: 'test_isolated_vocab_1', word: 'exampleword', word_lower: 'exampleword',
  phonetic: 'ɪɡˈzɑːmpəl', pos: 'verb', definition_en: 'to give an example of something', definition_zh: '举例；作为例子',
  senses: [], examples: [{ en: 'We exampleword the method in class.', zh: '我们在课上用这个方法举例。' }],
  phrases: [], synonyms: [], antonyms: [], tags: [], root_affix: null, source_page: null, source_book: 'AcceptTestBook', updated_at: now,
}
const vocabEntry2 = {
  key: 'nullzhword|verb', id: 'test_isolated_vocab_2', word: 'nullzhword', word_lower: 'nullzhword',
  phonetic: 'nʌl', pos: 'verb', definition_en: 'a word intentionally without a Chinese gloss', definition_zh: '无中文例句',
  senses: [], examples: [{ en: 'This nullzhword has no Chinese gloss.', zh: null }],
  phrases: [], synonyms: [], antonyms: [], tags: [], root_affix: null, source_page: null, source_book: 'AcceptTestBook', updated_at: now,
}
const transcript = { id: 'test_isolated_transcript_1', language: 'en', duration: 12, segments: [{ start: 0, end: 3, text: 'Hello world example.' }], fileName: 'test_isolated.mp4', created_at: now, source: 'asr' }
const studyNote = {
  id: 'test_isolated_note_1', transcript_id: 'test_isolated_transcript_1', summary: '验收用学习稿摘要。',
  bilingual_notes: [{ en: 'The cat sat on the mat.', zh: '猫坐在垫子上。' }], key_points: ['要点一：示例要点'],
  vocabulary: [
    { word: 'exampleword', pos: 'verb', dict_key: 'exampleword|verb', gloss: '举例说明', context: '示例语境句' },
    { word: 'nullzhword', pos: 'verb', dict_key: 'nullzhword|verb', gloss: '无中文例句', context: '无中文例句语境' },
  ],
  status: 'ai_generated', created_at: now, updated_at: now, source: 'ai_generated',
}

async function inject(page) {
  await page.evaluate((data) => {
    const { dictEntry, vocabEntry1, vocabEntry2, transcript, studyNote } = data
    return new Promise((resolve, reject) => {
      const open = indexedDB.open('shushu-learn')
      open.onsuccess = () => {
        const db = open.result
        const tx = db.transaction(['dictEntries', 'transcripts', 'studyNotes'], 'readwrite')
        tx.objectStore('dictEntries').put(dictEntry)
        tx.objectStore('dictEntries').put(vocabEntry1)
        tx.objectStore('dictEntries').put(vocabEntry2)
        tx.objectStore('transcripts').put(transcript)
        tx.objectStore('studyNotes').put(studyNote)
        tx.oncomplete = () => { db.close(); resolve(true) }
        tx.onerror = () => { db.close(); reject(tx.error) }
        tx.onabort = () => { db.close(); reject(tx.error) }
      }
      open.onerror = () => reject(open.error)
    })
  }, { dictEntry, vocabEntry1, vocabEntry2, transcript, studyNote })
}

async function cleanup(page) {
  await page.evaluate(() => {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open('shushu-learn')
      open.onsuccess = () => {
        const db = open.result
        const tx = db.transaction(['dictEntries', 'transcripts', 'studyNotes', 'readings'], 'readwrite')
        ;['accepttestword|noun', 'exampleword|verb', 'nullzhword|verb'].forEach((k) => tx.objectStore('dictEntries').delete(k))
        tx.objectStore('transcripts').delete('test_isolated_transcript_1')
        tx.objectStore('studyNotes').delete('test_isolated_note_1')
        tx.objectStore('readings').delete('t_test_isolated_transcript_1')
        tx.oncomplete = () => { db.close(); resolve(true) }
        tx.onerror = () => { db.close(); reject(tx.error) }
      }
      open.onerror = () => reject(open.error)
    })
  })
}

async function measureExampleZh(page) {
  return page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('[data-testid="example-zh"]'))
    return els.map((el) => {
      const cs = getComputedStyle(el)
      const enEl = (el.previousElementSibling && el.previousElementSibling.tagName === 'P')
        ? el.previousElementSibling
        : el.parentElement
      const enSize = enEl ? getComputedStyle(enEl).fontSize : null
      return { zhSize: cs.fontSize, zhColor: cs.color, enSize, text: el.textContent.replace(/\s+/g, ' ').slice(0, 24) }
    })
  })
}

async function waitHitAndPick(page, word) {
  await page.waitForFunction(
    (w) => [...document.querySelectorAll('button')].some((b) => b.textContent && b.textContent.includes(w)),
    { timeout: 15000 },
  ).catch(() => {})
  await page.evaluate((w) => {
    const btn = [...document.querySelectorAll('button')].find((x) => x.textContent && x.textContent.includes(w) && x.closest('.space-y-2'))
      || [...document.querySelectorAll('button')].find((x) => x.textContent && x.textContent.includes(w))
    if (btn) btn.click()
  }, word)
}

try {
  const page = await browser.newPage()
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true })

  // 打开 DB（Dexie 在任意路由挂载时建库），再注入隔离数据
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 60000 })
  await sleep(800)
  await inject(page)

  /* ============== EntryDetailCard（宿主 /dict-ingest） ============== */
  await page.goto(`${BASE}/dict-ingest`, { waitUntil: 'networkidle2', timeout: 60000 })
  await page.waitForSelector('input[aria-label="搜索词典"]', { timeout: 20000 })
  await page.click('input[aria-label="搜索词典"]')
  await page.type('input[aria-label="搜索词典"]', 'accepttestword')
  await page.keyboard.press('Enter')
  await waitHitAndPick(page, 'accepttestword')
  await page.waitForSelector('[data-testid="example-zh"]', { timeout: 15000 }).catch(() => {})
  await sleep(500)

  const edcRows = await measureExampleZh(page)
  check('EntryDetailCard: 渲染中文例句(规则1/2)', edcRows.length > 0, `count=${edcRows.length}`)
  if (edcRows.length) {
    const allTeal = edcRows.every((r) => isTealLight(r.zhColor))
    const allSmaller = edcRows.every((r) => r.enSize && parseFloat(r.zhSize) < parseFloat(r.enSize))
    const allText = edcRows.every((r) => r.text.trim().length > 0)
    check('EntryDetailCard: 青绿色(规则4 浅色)', allTeal, edcRows.map((r) => r.zhColor).join(' | '))
    check('EntryDetailCard: 字号小于英文(规则5)', allSmaller, edcRows.map((r) => `${r.zhSize}/${r.enSize}`).join(' | '))
    check('EntryDetailCard: 中文释义非空(规则1/2)', allText, edcRows.map((r) => r.text).join(' | '))
  }
  const edcCount = await page.evaluate(() => {
    const uls = [...document.querySelectorAll('ul')]
    let ul = null
    for (const u of uls) { if (u.querySelector('[data-testid="example-zh"]')) { ul = u; break } }
    if (!ul) return { li: 0, zh: 0 }
    return { li: ul.children.length, zh: ul.querySelectorAll('[data-testid="example-zh"]').length }
  })
  check('EntryDetailCard: 无中文不占位(规则6)', edcCount.li === 2 && edcCount.zh === 1, `li=${edcCount.li}, zh=${edcCount.zh}`)

  // 深色可读
  await page.evaluate(() => document.documentElement.classList.add('dark'))
  await sleep(250)
  const edcDark = await measureExampleZh(page)
  if (edcDark.length) {
    check('EntryDetailCard: 深色青绿可读(规则7)', edcDark.every((r) => isTealDark(r.zhColor)), edcDark.map((r) => r.zhColor).join(' | '))
    check('EntryDetailCard: 深色仍小一号(规则5)', edcDark.every((r) => r.enSize && parseFloat(r.zhSize) < parseFloat(r.enSize)), edcDark.map((r) => `${r.zhSize}/${r.enSize}`).join(' | '))
  }
  await page.evaluate(() => document.documentElement.classList.remove('dark'))

  // 关闭中文辅助开关仍显示（规则3）
  await page.evaluate(() => {
    const keys = Object.keys(localStorage)
    for (const k of keys) {
      if (k.startsWith('shushu') || k.includes('store') || k.includes('app')) {
        try {
          const v = JSON.parse(localStorage.getItem(k) || '{}')
          if (v && v.state && v.state.settings) { v.state.settings.chineseAssist = false; localStorage.setItem(k, JSON.stringify(v)) }
        } catch {}
      }
    }
  })
  await page.reload({ waitUntil: 'networkidle2' })
  await page.waitForSelector('input[aria-label="搜索词典"]', { timeout: 20000 })
  await page.click('input[aria-label="搜索词典"]')
  await page.type('input[aria-label="搜索词典"]', 'accepttestword')
  await page.keyboard.press('Enter')
  await waitHitAndPick(page, 'accepttestword')
  await page.waitForSelector('[data-testid="example-zh"]', { timeout: 15000 }).catch(() => {})
  await sleep(400)
  const edcNoAssist = await measureExampleZh(page)
  check('EntryDetailCard: 关闭中文辅助仍显示(规则3)', edcNoAssist.length > 0, `count=${edcNoAssist.length}`)

  /* ============== StudyNotePanel（宿主 /import?tab=media，挂载自动回读字幕） ============== */
  await page.goto(`${BASE}/import?tab=media`, { waitUntil: 'networkidle2', timeout: 60000 })
  await page.waitForSelector('[data-testid="example-zh"]', { timeout: 20000 }).catch(() => {})
  await sleep(900)

  const snRows = await measureExampleZh(page)
  check('StudyNotePanel: 渲染中文例句(规则1/2)', snRows.length > 0, `count=${snRows.length}`)
  if (snRows.length) {
    const allTeal = snRows.every((r) => isTealLight(r.zhColor))
    const allSmaller = snRows.every((r) => r.enSize && parseFloat(r.zhSize) < parseFloat(r.enSize))
    const allText = snRows.every((r) => r.text.trim().length > 0)
    check('StudyNotePanel: 青绿色(规则4 浅色)', allTeal, snRows.map((r) => r.zhColor).join(' | '))
    check('StudyNotePanel: 字号小于英文(规则5)', allSmaller, snRows.map((r) => `${r.zhSize}/${r.enSize}`).join(' | '))
    check('StudyNotePanel: 中文释义非空(规则1/2)', allText, snRows.map((r) => r.text).join(' | '))
  }
  // 规则6：2 个重点词汇，仅 1 个有中文例句 → example-zh 仅 1 条（null-zh 被抑制）
  const snCount = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('li.rounded-lg')]
    const zh = document.querySelectorAll('[data-testid="example-zh"]').length
    return { cards: cards.length, zh }
  })
  check('StudyNotePanel: 无中文不占位(规则6)', snCount.cards >= 2 && snCount.zh === 1, `vocabCards=${snCount.cards}, zh=${snCount.zh}`)

  // 深色可读
  await page.evaluate(() => document.documentElement.classList.add('dark'))
  await sleep(250)
  const snDark = await measureExampleZh(page)
  if (snDark.length) {
    check('StudyNotePanel: 深色青绿可读(规则7)', snDark.every((r) => isTealDark(r.zhColor)), snDark.map((r) => r.zhColor).join(' | '))
    check('StudyNotePanel: 深色仍小一号(规则5)', snDark.every((r) => r.enSize && parseFloat(r.zhSize) < parseFloat(r.enSize)), snDark.map((r) => `${r.zhSize}/${r.enSize}`).join(' | '))
  }
  await page.evaluate(() => document.documentElement.classList.remove('dark'))

  // 规则3：StudyNotePanel 无 chineseAssist 门控 —— 上方 light 检查已在该会话
  // （chineseAssist=false 已写入 localStorage 并延续到 /import 导航）中渲染成功
  check('StudyNotePanel: 不受中文辅助开关影响(规则3)', snRows.length > 0, '组件无 chineseAssist 门控，始终渲染')

  await page.close()
} catch (e) {
  console.log('FLOW ERROR:', e?.message || String(e))
  fail++
  fails.push('flow-error')
} finally {
  // 数据清理：删除隔离测试记录，确认不影响生产数据
  try {
    const page = await browser.newPage()
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 60000 })
    await sleep(500)
    await cleanup(page)
    const remain = await page.evaluate(() => {
      return new Promise((resolve) => {
        const open = indexedDB.open('shushu-learn')
        open.onsuccess = () => {
          const db = open.result
          const tx = db.transaction(['dictEntries', 'transcripts', 'studyNotes'], 'readonly')
          Promise.all([
            tx.objectStore('dictEntries').count(),
            tx.objectStore('transcripts').count(),
            tx.objectStore('studyNotes').count(),
          ]).then(([d, t, s]) => { db.close(); resolve({ d, t, s }) }).catch(() => { db.close(); resolve({ d: -1, t: -1, s: -1 }) })
        }
        open.onerror = () => resolve({ d: -1, t: -1, s: -1 })
      })
    })
    console.log(`CLEANUP 剩余计数(dictEntries/transcripts/studyNotes)=${remain.d}/${remain.t}/${remain.s}（隔离记录已删除）`)
    await page.close()
  } catch (e) {
    console.log('CLEANUP ERROR:', e?.message || String(e))
  }
  await browser.close()
}

console.log(`\n────────────────────────────────────────────────────`)
console.log(`共 ${pass + fail} 项，失败 ${fail} 项`)
if (fail > 0) console.log('失败项：' + fails.join('、'))
process.exit(fail > 0 ? 1 : 0)
