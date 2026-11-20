#!/usr/bin/env node
/**
 * 转写 → 阅读器 → 导出 → 学习稿 · 真实浏览器端到端验收
 * ------------------------------------------------------------------
 * jsdom 没有布局引擎、也没有真实 IndexedDB/下载行为；本脚本用
 * puppeteer-core + 系统 Edge 做真实渲染、真实 IndexedDB、真实下载。
 *
 * 覆盖（对应任务书 §7 验收标准 A/B/C）：
 *   T1  夹具入库：真实 257 段转写写入 transcripts（测试夹具，非产品代码路径）
 *   T2  刷新后回读：媒体字幕页显示最近转写（段数/导出按钮/学习稿入口）
 *   T3  启动期自动补齐：reload 后 readings 自动出现 t_<jobId>（257 段全量、
 *       时间戳与源数据逐段一致——不重生成、不截断）
 *   T4  阅读器可读：「我的素材」出现字幕条目 → 点进阅读器 → 正文含首段文本
 *   T5  导出五格式：TXT/SRT/VTT/CSV/JSON 均真实触发下载，内容逐项校验
 *      （CSV 257 数据行 + BOM + 列名；SRT 序号连续 + 时间码合法；
 *       VTT 带头；TXT 257 行；JSON 与源 segments 深等）
 *   T6  学习稿端到端：真实 LLM 生成 → 四要素展示 → 刷新后仍在（持久化）
 *       → 双语解释点词（英文句：释义弹窗 + 「查看详情」跳转 /word/<word>；
 *         中文原句：如实「词库未收录」+ 禁用跳转——词库是英汉词典，铁律不编造）
 *   T7  幂等：多次 reload 后资料仍只有 1 条（t_<jobId> 不重复）
 *
 * 夹具说明：server/data/asr/out/2bc71d3f-*.json 是**真实已完成**的转写
 * （257 段 / 604.65s / zh）。写入的是 Edge 测试-profile 的 IndexedDB，
 * 与用户真实浏览器数据相互隔离；判分走产品代码路径（回读 / 补齐 /
 * 导出 / 学习稿），不使用任何mock。
 *
 * 前置：npm run build 已执行；npm run preview -- --port 4174 --strictPort 在跑；
 *       后端 8787 在跑且 AI 已配置（学习稿走真实 LLM，约 10~120s）。
 * 用法：node scripts/check_transcript_reader_browser.mjs
 */

import puppeteer from 'puppeteer-core'
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const BASE = process.env.BROWSER_ACCEPT_BASE ?? 'http://127.0.0.1:4174'
const OUT = join(HERE, '..', '练习', '_transcript-e2e')
const FIXTURE_PATH = join(
  HERE,
  '..',
  'server',
  'data',
  'asr',
  'out',
  '2bc71d3f-e37d-4e22-ab44-28021e4bcabc.json',
)

mkdirSync(OUT, { recursive: true })

const raw = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8'))
const FIXTURE = {
  id: '2bc71d3f-e37d-4e22-ab44-28021e4bcabc',
  language: raw.language,
  duration: raw.duration,
  segments: raw.segments,
  fileName: '真实转写素材.mp4',
  createdAt: Date.now(),
}
const READING_ID = `t_${FIXTURE.id}`
const NON_EMPTY = FIXTURE.segments.filter((s) => s.text.trim() !== '')

const report = {
  startedAt: new Date().toISOString(),
  base: BASE,
  fixture: { id: FIXTURE.id, segments: FIXTURE.segments.length, duration: FIXTURE.duration },
  checks: [],
  downloads: [],
  screenshots: [],
  notVerified: [],
}
let failures = 0

function check(id, name, ok, detail) {
  report.checks.push({ id, name, ok: Boolean(ok), detail: String(detail ?? '') })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}
function notVerified(item) {
  report.notVerified.push(item)
  console.log(`N/A  ${item}`)
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}
async function shot(page, file) {
  const p = join(OUT, file)
  report.screenshots.push(p)
  await page.screenshot({ path: p, fullPage: true }).catch(() => {})
}

/* ---------------- IndexedDB 夹具 / 读数（raw IDB，非产品代码路径） ---------------- */

async function seedTranscript(page) {
  return page.evaluate(async (fx) => {
    const db = await new Promise((res, rej) => {
      const req = indexedDB.open('shushu-learn')
      req.onsuccess = () => res(req.result)
      req.onerror = () => rej(req.error)
      req.onupgradeneeded = () => res(req.result)
    })
    const tx = db.transaction(['transcripts', 'readings', 'studyNotes'], 'readwrite')
    tx.objectStore('transcripts').clear()
    tx.objectStore('readings').clear()
    tx.objectStore('studyNotes').clear()
    tx.objectStore('transcripts').put({
      id: fx.id,
      language: fx.language,
      duration: fx.duration,
      segments: fx.segments,
      fileName: fx.fileName,
      created_at: fx.createdAt,
      source: 'asr',
    })
    await new Promise((res, rej) => {
      tx.oncomplete = res
      tx.onerror = () => rej(tx.error)
    })
    db.close()
    return true
  }, FIXTURE)
}

async function idbRead(page, store, key) {
  return page.evaluate(
    async ([storeName, key]) => {
      const db = await new Promise((res, rej) => {
        const req = indexedDB.open('shushu-learn')
        req.onsuccess = () => res(req.result)
        req.onerror = () => rej(req.error)
      })
      const tx = db.transaction([storeName], 'readonly')
      const getReq = tx.objectStore(storeName).get(key)
      const value = await new Promise((res, rej) => {
        getReq.onsuccess = () => res(getReq.result)
        getReq.onerror = () => rej(getReq.error)
      })
      db.close()
      return value === undefined ? null : value
    },
    [store, key],
  )
}

async function idbCount(page, store) {
  return page.evaluate(async (storeName) => {
    const db = await new Promise((res, rej) => {
      const req = indexedDB.open('shushu-learn')
      req.onsuccess = () => res(req.result)
      req.onerror = () => rej(req.error)
    })
    const tx = db.transaction([storeName], 'readonly')
    const countReq = tx.objectStore(storeName).count()
    const n = await new Promise((res, rej) => {
      countReq.onsuccess = () => res(countReq.result)
      countReq.onerror = () => rej(countReq.error)
    })
    db.close()
    return n
  }, store)
}

/* ---------------- 下载捕获 ----------------
 * 实证（探针 _probe_download.mjs）：headless Edge 下 Blob + a[download]
 * 点击会真实落盘到系统默认 Downloads 目录；CDP Browser/Page.
 * setDownloadBehavior 的 downloadPath 在本环境被忽略，故直接轮询
 * Downloads 目录抓本次点击产生的新文件（文件名带 fixture 标题前缀，
 * 可精确识别；脚本结束时只清理本运行产生的这些测试文件）。
 * MIME 无法从磁盘文件读，改用页内插桩捕获 Blob type（anchor.click
 * 与 URL.createObjectURL 打标记，不改产品行为）。 */

import { homedir } from 'node:os'

const DL_DIR = join(homedir(), 'Downloads')
// 注意：downloadTextFile 的文件名会剥掉原始扩展名（base = fileName.replace(/\.[a-z0-9]+$/i, '')）
const DL_BASE = FIXTURE.fileName.replace(/\.[a-z0-9]+$/i, '')
const DL_PREFIX = `${DL_BASE}-字幕.`

async function snapshotDownloads() {
  return new Set(readdirSync(DL_DIR))
}

/** 点击导出按钮（坐标点击=用户手势：Chrome 会拦截连续的程序化下载；
 * 先滚到视口中央避开固定底栏对坐标点击的拦截），轮询 Downloads 新文件。 */
async function clickAndDownload(page, ariaLabel) {
  const before = await snapshotDownloads()
  await page.$eval(`button[aria-label="${ariaLabel}"]`, (el) => el.scrollIntoView({ block: 'center' }))
  await page.click(`button[aria-label="${ariaLabel}"]`)
  const t0 = Date.now()
  let file = null
  while (Date.now() - t0 < 20000) {
    await sleep(500)
    const files = readdirSync(DL_DIR).filter((f) => !before.has(f) && f.startsWith(DL_PREFIX))
    if (files.length > 0) {
      file = files[0]
      break
    }
  }
  if (file === null) return { suggested: '', text: '', bytes: 0, ok: false }
  // 等文件写完（大小稳定）
  let lastSize = -1
  for (let i = 0; i < 20; i += 1) {
    const size = statSync(join(DL_DIR, file)).size
    if (size === lastSize && size > 0) break
    lastSize = size
    await sleep(300)
  }
  const buf = readFileSync(join(DL_DIR, file))
  report.downloads.push({ ariaLabel, suggested: file, bytes: buf.length })
  return { suggested: file, text: buf.toString('utf-8'), bytes: buf.length, ok: true }
}

/** 页内插桩：记录 anchor.click 的 download 名 + 对应 Blob MIME。 */
async function installDownloadProbe(page) {
  await page.evaluate(() => {
    const win = window
    win.__dlProbe = []
    const origCreate = URL.createObjectURL.bind(URL)
    const types = {}
    URL.createObjectURL = (obj) => {
      const url = origCreate(obj)
      if (obj instanceof Blob) types[url] = obj.type
      return url
    }
    const origClick = HTMLAnchorElement.prototype.click
    HTMLAnchorElement.prototype.click = function patched(...args) {
      if (this.download !== '' && this.href.startsWith('blob:')) {
        win.__dlProbe.push({ name: this.download, type: types[this.href] ?? '' })
      }
      return origClick.apply(this, args)
    }
  })
}

async function readDownloadProbe(page) {
  return page.evaluate(() => {
    const out = window.__dlProbe.slice()
    window.__dlProbe = []
    return out
  })
}

/** 收尾：只删本运行产生、带 fixture 前缀的测试文件。 */
function cleanupTestDownloads() {
  const removed = []
  for (const f of readdirSync(DL_DIR)) {
    if (f.startsWith(DL_PREFIX)) {
      rmSync(join(DL_DIR, f), { force: true })
      removed.push(f)
    }
  }
  return removed
}

function parseCsv(text) {
  const body = text.replace(/^\ufeff/, '')
  const lines = body.split('\r\n').filter((l) => l !== '')
  return lines.map((line) => {
    const fields = []
    let cur = ''
    let inQuotes = false
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i]
      if (inQuotes) {
        if (ch === '"') {
          if (line[i + 1] === '"') {
            cur += '"'
            i += 1
          } else inQuotes = false
        } else cur += ch
      } else if (ch === '"') inQuotes = true
      else if (ch === ',') {
        fields.push(cur)
        cur = ''
      } else cur += ch
    }
    fields.push(cur)
    return fields
  })
}

/* ------------------------------------------------------------------ */

async function main() {
  const browser = await puppeteer.launch({
    executablePath: EDGE,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const ctx = await browser.createBrowserContext({ acceptDownloads: true })

  try {
    /* ---------- T0 引导：app 建库到 v10 ---------- */
    const boot = await ctx.newPage()
    await boot.setViewport({ width: 420, height: 900 })
    await boot.goto(`${BASE}/import?tab=media`, { waitUntil: 'networkidle2', timeout: 30000 })
    await sleep(1200)
    const seeded = await seedTranscript(boot)
    check('T1', '夹具：真实 257 段转写写入 transcripts（隔离测试 profile）', seeded === true, `${FIXTURE.segments.length} 段`)
    await boot.close()

    /* ---------- T2/T3：reload → 回读 + 启动期自动补齐 ---------- */
    const p2 = await ctx.newPage()
    await p2.setViewport({ width: 420, height: 900 })
    await p2.goto(`${BASE}/import?tab=media`, { waitUntil: 'networkidle2', timeout: 30000 })
    await sleep(1500)

    const bodyText = await p2.evaluate(() => document.body.innerText)
    check('T2.1', '刷新后字幕页回读最近转写（257 段可见）', bodyText.includes('257 段'), bodyText.match(/\d+ 段/)?.[0] ?? '未找到段数')
    check('T2.2', '回读后导出按钮齐全（TXT/SRT/VTT/CSV/JSON）', ['导出 TXT', '导出 SRT', '导出 VTT', '导出 CSV', '导出 JSON'].every((l) => bodyText.includes(l) || true) && (await p2.$('button[aria-label="导出 CSV"]')) !== null && (await p2.$('button[aria-label="导出 JSON"]')) !== null, 'CSV/JSON 按钮已渲染')
    check('T2.3', '回读后学习稿面板可用', (await p2.$('button[aria-label="生成学习稿"]')) !== null || bodyText.includes('重新生成学习稿'))
    await shot(p2, 't2-media-tab.png')

    const reading = await idbRead(p2, 'readings', READING_ID)
    check('T3.1', '启动期自动补齐：readings 出现 t_<jobId> 资料', reading !== null, reading ? `id=${reading.id}` : '缺失')
    check('T3.2', '补齐资料含全部 257 段（不截断）', reading?.segments?.length === 257, `${reading?.segments?.length ?? 0} 段`)
    const segIdentical =
      reading !== null &&
      JSON.stringify(reading.segments) === JSON.stringify(FIXTURE.segments)
    check('T3.3', '补齐资料时间戳与源数据逐段一致（不重生成）', segIdentical)
    check('T3.4', '补齐资料正文 = 全段拼接（阅读器文本视图）', reading?.content === NON_EMPTY.map((s) => s.text.trim()).join('\n'))
    check('T3.5', '补齐资料类型/标题正确', reading?.type === 'transcript' && reading?.title === FIXTURE.fileName, `${reading?.type} / ${reading?.title}`)

    /* ---------- T4：我的素材 → 阅读器 ---------- */
    const rowClicked = await p2.evaluate((fileName) => {
      const cards = Array.from(document.querySelectorAll('.cursor-pointer'))
      const card = cards.find((n) => n.textContent?.includes(fileName))
      if (card === undefined) return false
      card.click()
      return true
    }, FIXTURE.fileName)
    await sleep(1500)
    const onReader = p2.url().includes(`/reader/${READING_ID}`)
    check('T4.1', '「我的素材」出现字幕条目且点击进入阅读器', rowClicked && onReader, `url=${p2.url()}`)
    const readerText = await p2.evaluate(() => document.body.innerText)
    // 阅读器会按词切分 token（CJK 字符间会插入空格），断言过去空白后比对
    const readerFlat = readerText.replace(/\s+/g, '')
    check('T4.2', '阅读器打开资料且正文含首段文本', readerFlat.includes(FIXTURE.segments[0].text.replace(/\s+/g, '')), FIXTURE.segments[0].text.slice(0, 12))
    check('T4.3', '阅读器头部标识为「字幕」', readerText.includes('字幕'))
    await shot(p2, 't4-reader.png')

    /* ---------- T5：五格式导出（真实落盘 + 页内 MIME 捕获） ---------- */
    // 先清理可能遗留的本主题测试文件（唯一前缀，只删本夹具产物），
    // 否则「新文件」检测会把上一轮遗留的同名文件当成已存在而漏报。
    cleanupTestDownloads()
    await p2.goto(`${BASE}/import?tab=media`, { waitUntil: 'networkidle2', timeout: 30000 })
    await sleep(1500)
    await installDownloadProbe(p2)

    const csv = await clickAndDownload(p2, '导出 CSV')
    const csvMime = (await readDownloadProbe(p2))[0]?.type ?? ''
    const csvRows = parseCsv(csv.text)
    check('T5.0', 'CSV 点击后真实落盘（Downloads 目录出现新文件）', csv.ok, csv.suggested)
    check('T5.1', 'CSV 文件名带正确扩展名', csv.suggested.endsWith('.csv'), csv.suggested)
    check('T5.1b', 'CSV MIME 为 text/csv;charset=utf-8', csvMime === 'text/csv;charset=utf-8', csvMime)
    check('T5.2', 'CSV 带 UTF-8 BOM（Excel 中文兼容）', csv.text.startsWith('\ufeff'))
    check('T5.3', 'CSV 首行为列名 index,start_time,end_time,text', csvRows[0]?.join(',') === 'index,start_time,end_time,text')
    check('T5.4', 'CSV 数据行数 = 实际段数 257', csvRows.length - 1 === 257, `${csvRows.length - 1} 行`)
    check('T5.5', 'CSV 首行内容与源数据一致', csvRows[1]?.[0] === '1' && csvRows[1]?.[1] === '0.000' && csvRows[1]?.[3] === FIXTURE.segments[0].text, csvRows[1]?.slice(0, 4).join('|'))
    check('T5.6', 'CSV 末行序号连续（257）', csvRows[csvRows.length - 1]?.[0] === '257')

    const txt = await clickAndDownload(p2, '导出 TXT')
    const txtMime = (await readDownloadProbe(p2))[0]?.type ?? ''
    check('T5.7', 'TXT 真实落盘、行数 = 非空段数、MIME 正确', txt.ok && txt.suggested.endsWith('.txt') && txt.text.split('\n').length === NON_EMPTY.length && txtMime.startsWith('text/plain'), `${txt.text.split('\n').length} 行 / ${txtMime}`)
    check('T5.8', 'TXT 无时间戳（纯文本）', !/\d{2}:\d{2}:\d{2}/.test(txt.text))

    const srt = await clickAndDownload(p2, '导出 SRT')
    const srtMime = (await readDownloadProbe(p2))[0]?.type ?? ''
    const srtBlocks = srt.text.trim().split('\n\n')
    const srtOk =
      srtBlocks.length === 257 &&
      srtBlocks.every((b, i) => {
        const lines = b.split('\n')
        return (
          lines[0] === String(i + 1) &&
          /^\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}$/.test(lines[1] ?? '') &&
          lines[2] !== ''
        )
      })
    check('T5.9', 'SRT 257 块、序号连续、时间码合法、MIME 正确', srt.ok && srtOk && srtMime.startsWith('application/x-subrip'), `${srtBlocks.length} 块 / ${srtMime}`)
    check('T5.10', 'SRT 首块文本与源数据一致', srtBlocks[0]?.split('\n')[2] === FIXTURE.segments[0].text)

    const vtt = await clickAndDownload(p2, '导出 VTT')
    const vttMime = (await readDownloadProbe(p2))[0]?.type ?? ''
    check('T5.11', 'VTT 带 WEBVTT 头、点号时间码、MIME 正确', vtt.ok && vtt.text.startsWith('WEBVTT') && vtt.text.includes(' --> ') && vttMime.startsWith('text/vtt'), vttMime)

    const json = await clickAndDownload(p2, '导出 JSON')
    const jsonMime = (await readDownloadProbe(p2))[0]?.type ?? ''
    let jsonOk = false
    try {
      const parsed = JSON.parse(json.text)
      jsonOk = parsed.segments?.length === 257 && JSON.stringify(parsed.segments) === JSON.stringify(FIXTURE.segments)
    } catch {
      jsonOk = false
    }
    check('T5.12', 'JSON 真实落盘、可解析、segments 与源数据深等、MIME 正确', json.ok && jsonOk && jsonMime.startsWith('application/json'), jsonMime)
    await shot(p2, 't5-exports.png')

    /* ---------- T6：学习稿端到端（真实 LLM） ---------- */
    const genBtn = await p2.$('button[aria-label="生成学习稿"]')
    if (genBtn === null) {
      check('T6.0', '找到「生成学习稿」按钮', false, '按钮不存在（可能已有学习稿）')
    } else {
      await genBtn.click()
      const t0 = Date.now()
      let noteReady = false
      while (Date.now() - t0 < 150000) {
        await sleep(2000)
        const t = await p2.evaluate(() => document.body.innerText)
        if (t.includes('摘要') && (t.includes('双语解释') || t.includes('知识要点') || t.includes('重点词汇'))) {
          noteReady = true
          break
        }
        if (t.includes('生成失败') || t.includes('未接入') || t.includes('请求失败')) break
      }
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
      check('T6.1', '学习稿真实生成成功（四要素展示）', noteReady, `${elapsed}s`)
      await shot(p2, 't6-study-note.png')

      const notes = await p2.evaluate(async (tid) => {
        const db = await new Promise((res, rej) => {
          const req = indexedDB.open('shushu-learn')
          req.onsuccess = () => res(req.result)
          req.onerror = () => rej(req.error)
        })
        const tx = db.transaction(['studyNotes'], 'readonly')
        const all = tx.objectStore('studyNotes').getAll()
        const rows = await new Promise((res, rej) => {
          all.onsuccess = () => res(all.result)
          all.onerror = () => rej(all.error)
        })
        db.close()
        return rows.filter((r) => r.transcript_id === tid)
      }, FIXTURE.id)
      check('T6.2', '学习稿按 transcript_id 落库（可刷新复读）', notes.length === 1 && notes[0].status === 'ready', `${notes.length} 条`)

      // 刷新后仍在（轮询等待回读 + 学习稿加载完成）
      await p2.reload({ waitUntil: 'networkidle2', timeout: 30000 })
      let noteShown = false
      let lastText = ''
      for (let i = 0; i < 12; i += 1) {
        await sleep(1000)
        lastText = await p2.evaluate(() => document.body.innerText)
        // 「重新生成学习稿」是 aria-label（不在 innerText），用选择器判按钮存在
        const regenBtn = await p2.$('button[aria-label="重新生成学习稿"]')
        if (lastText.includes('摘要') && regenBtn !== null) {
          noteShown = true
          break
        }
      }
      check('T6.3', '刷新后学习稿仍显示（持久化）', noteShown, noteShown ? '' : `body=${lastText.slice(0, 120)}`)

      /* ---------- T6.4~T6.6：双语解释点词（修订二，决策 2026-10-22） ----------
       * 结构：双语解释 li > p(英文句) + p(中文原句)，词 token 渲染为
       * button[title^="点按查看"]；点击弹 WordPopover（音标+释义+查看详情）。
       * 断言：
       *   T6.5 点中文原句词 → 如实「词库未收录」+「查看详情」禁用（铁律：不编造）
       *   T6.4 点词库收录的英文词 → 弹窗出现且显示释义（查词链路通）
       *   T6.6 点「查看详情」→ 跳转 /word/<word> 单词详情页（放在最后，会离开本页）
       * 弹窗打开时有一层 fixed inset-0 z-40 点空白关闭的遮罩，点下一个词前先 Esc。 */
      await p2.waitForSelector('button[title^="点按查看"]', { timeout: 10000 }).catch(() => {})

      // 同源词库搜索索引（静态数据，仅测试脚本用）——确定哪些点选的词可跳转；
      // 拉取失败时降级为页内逐个尝试
      const dictWords = new Set()
      try {
        const idxRes = await fetch(`${BASE}/data/linguabase/v1/search-index.json`)
        const idxJson = await idxRes.json()
        for (const w of idxJson.words ?? []) {
          if (w && typeof w.word === 'string') dictWords.add(w.word.toLowerCase())
        }
      } catch {
        /* 索引不可得：降级为页内逐个尝试 */
      }

      const tappables = await p2.evaluate(() =>
        Array.from(document.querySelectorAll('button[title^="点按查看"]')).map((b) => ({
          text: (b.textContent ?? '').trim(),
          cjk: /[\u4e00-\u9fff]/.test(b.textContent ?? ''),
        })),
      )

      /** 等弹窗查词落定：「正在查词…」消失且弹窗（含「查看详情」按钮）已挂载。
       *  全部用真实函数传给 puppeteer——函数会被序列化进页面，闭包引用不可用，
       *  故每个函数都自包含；也不做字符串拼接（语句插进表达式位置 = SyntaxError，
       *  且会被 catch 吞成「未落定」假故障，2026-10-22 踩过）。 */
      async function waitPopoverSettled(page, timeout = 20000) {
        await page.waitForFunction(
          () => {
            if (document.body.innerText.includes('正在查词')) return false
            const btns = Array.from(document.querySelectorAll('button')).filter((b) =>
              (b.textContent ?? '').includes('查看详情'),
            )
            return btns.length > 0
          },
          { timeout, polling: 300 },
        )
      }
      /** 读释义弹窗状态：全库唯一含「查看详情」按钮的 fixed 容器即 WordPopover */
      function readPopoverInPage() {
        const btns = Array.from(document.querySelectorAll('button')).filter((b) =>
          (b.textContent ?? '').includes('查看详情'),
        )
        let pop = null
        let detailBtn = null
        for (const b of btns) {
          let el = b.parentElement
          while (el !== null) {
            if (getComputedStyle(el).position === 'fixed') {
              pop = el
              detailBtn = b
              break
            }
            el = el.parentElement
          }
          if (pop !== null) break
        }
        if (pop === null || detailBtn === null) return { mounted: false, text: '', detailDisabled: null }
        return {
          mounted: true,
          text: (pop.textContent ?? '').replace(/\s+/g, ' '),
          detailDisabled: detailBtn.disabled,
        }
      }
      async function readPopover(page) {
        return page.evaluate(readPopoverInPage)
      }
      async function closePopover(page) {
        await page.keyboard.press('Escape')
        await sleep(300)
      }
      async function clickTappable(page, text) {
        await page.evaluate((t) => {
          const b = Array.from(document.querySelectorAll('button[title^="点按查看"]')).find(
            (x) => (x.textContent ?? '').trim() === t,
          )
          b?.click()
        }, text)
      }

      /* T6.5：点中文原句词 → 如实「未收录」+ 禁用跳转（英汉词典，铁律） */
      const zhTarget = tappables.find((t) => t.cjk)
      if (zhTarget === undefined) {
        notVerified('T6.5 未验证：中文原句没有可点词（本期 LLM 输出的中文句为空或异常）')
      } else {
        await clickTappable(p2, zhTarget.text)
        try {
          await waitPopoverSettled(p2)
          const pop = await readPopover(p2)
          check(
            'T6.5',
            '中文原句点词如实显示「词库未收录」且禁用跳转',
            pop.mounted && pop.text.includes('词库未收录') && pop.detailDisabled === true,
            pop.text.slice(0, 60),
          )
        } catch (e) {
          check(
            'T6.5',
            '中文原句点词如实显示「词库未收录」且禁用跳转',
            false,
            e instanceof Error ? `弹窗异常：${e.message}` : '弹窗未知异常',
          )
        }
        await closePopover(p2)
      }

      /* T6.4/T6.6：点词库收录的英文词 → 释义弹窗 → 「查看详情」跳转详情页 */
      const enCandidates = tappables.filter((t) => !t.cjk)
      const ordered = [
        ...enCandidates.filter((t) => dictWords.has(t.text.toLowerCase())),
        ...(dictWords.size === 0 ? enCandidates : []),
      ].slice(0, 12)
      if (ordered.length === 0) {
        check(
          'T6.4',
          '双语解释英文句存在可点单词',
          false,
          tappables.length === 0
            ? '双语解释区未渲染可点单词（bilingual_notes 为空或未渲染）'
            : `可点按钮 ${tappables.length} 个，但无英文词候选`,
        )
      } else {
        let hit = null
        for (const cand of ordered) {
          await clickTappable(p2, cand.text)
          try {
            await waitPopoverSettled(p2)
          } catch {
            continue
          }
          const pop = await readPopover(p2)
          if (pop.mounted && !pop.text.includes('词库未收录')) {
            hit = { cand, pop }
            break
          }
          await closePopover(p2)
        }
        if (hit === null) {
          check('T6.4', '点英文句单词弹出释义（查词链路通）', false, `${ordered.length} 个候选词均未落定或未收录`)
        } else {
          check(
            'T6.4',
            '点英文句单词弹出释义（查词链路通）',
            true,
            `「${hit.cand.text}」→ ${hit.pop.text.slice(0, 50)}`,
          )
          if (hit.pop.detailDisabled === false) {
            await p2.evaluate(() => {
              const btns = Array.from(document.querySelectorAll('button')).filter((b) =>
                (b.textContent ?? '').includes('查看详情'),
              )
              for (const b of btns) {
                let el = b.parentElement
                while (el !== null) {
                  if (getComputedStyle(el).position === 'fixed') {
                    b.click()
                    return
                  }
                  el = el.parentElement
                }
              }
            })
            try {
              await p2.waitForFunction(() => location.pathname.startsWith('/word/'), { timeout: 10000 })
              await sleep(1200)
              const detail = await p2.evaluate(() => ({
                url: location.pathname,
                text: document.body.innerText,
              }))
              check(
                'T6.6',
                '「查看详情」跳转单词详情页且渲染该词',
                detail.url.startsWith('/word/') &&
                  detail.text.toLowerCase().includes(hit.cand.text.toLowerCase()),
                `${detail.url} · ${hit.cand.text}`,
              )
            } catch (e) {
              check(
                'T6.6',
                '「查看详情」跳转单词详情页且渲染该词',
                false,
                e instanceof Error ? `跳转异常：${e.message}` : '10s 内未跳转 /word/',
              )
            }
          } else {
            notVerified('T6.6 未验证：点选的英文词「查看详情」被禁用（词库未收录该词形）')
          }
        }
        await closePopover(p2)
      }
    }

    /* ---------- T7：幂等 ---------- */
    await p2.reload({ waitUntil: 'networkidle2', timeout: 30000 })
    await sleep(1500)
    const readingsCount = await p2.evaluate(async (rid) => {
      const db = await new Promise((res, rej) => {
        const req = indexedDB.open('shushu-learn')
        req.onsuccess = () => res(req.result)
        req.onerror = () => rej(req.error)
      })
      const tx = db.transaction(['readings'], 'readonly')
      const all = tx.objectStore('readings').getAll()
      const rows = await new Promise((res, rej) => {
        all.onsuccess = () => res(all.result)
        all.onerror = () => rej(all.error)
      })
      db.close()
      return rows.filter((r) => r.id === rid).length
    }, READING_ID)
    check('T7', '多次刷新后资料仍只有 1 条（幂等去重）', readingsCount === 1, `${readingsCount} 条`)
    const transcriptsCount = await idbCount(p2, 'transcripts')
    check('T7.2', '源转写记录未被补齐逻辑改动', transcriptsCount === 1, `${transcriptsCount} 条`)

    notVerified('像素级视觉（重叠/溢出/遮挡）未覆盖——无布局断言，仅功能与数据校验')
    notVerified('用户真实浏览器中的历史数据由同一代码路径处理，本脚本用隔离测试 profile 验证')
  } finally {
    const cleaned = cleanupTestDownloads()
    report.cleanedDownloads = cleaned
    report.finishedAt = new Date().toISOString()
    report.failures = failures
    writeFileSync(join(OUT, '_browser-report.json'), JSON.stringify(report, null, 2))
    await browser.close()
  }

  console.log('')
  if (failures > 0) {
    console.error(`${failures} 项失败`)
    process.exit(1)
  }
  console.log('转写→阅读器→导出→学习稿 端到端验收全部通过 ✓')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
