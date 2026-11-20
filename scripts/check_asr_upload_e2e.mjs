#!/usr/bin/env node
/**
 * ASR 真实上传 · 端到端验收（2026-10-22，用户任务书第 5 步）
 * ------------------------------------------------------------------
 * 用一份小型测试音频走完整真实链路：
 *   U1  浏览器真实文件选择（FileChooser 拦截，非 mock）
 *   U2  上传提交 POST /api/asr/jobs（4174 preview 代理 → 8787 → 8177 sidecar）
 *   U3  轮询至 done，UI 显示语言/时长/段数
 *   U4  结果落本机 Dexie transcripts（source=asr，主键=服务端 jobId）
 *   U5  阅读器资料自动登记 t_<jobId>（segments 全量、与源逐段一致）
 *   U6  服务端 API 回读同一 jobId：status=done、段数一致
 *   U7  刷新后字幕页回读（持久化生效，不要求重新上传）
 *   U8  阅读器打开 t_<jobId>，正文含首段文本
 *   U9  导出 SRT/TXT 真实落盘、格式合法、段数与源一致
 *   U1.5 无语言选择器 + 提交恒 language=auto（决策 2026-10-22 修订：不让用户选语言）
 *
 * 隔离：incognito browser context，与用户真实浏览器数据完全隔离；
 *       测试音频为一次性切片产物（20s），不重转写任何既有资料。
 *
 * 前置：npm run preview -- --port 4174 --strictPort 在跑；8787 / 8177 在跑。
 * 测试音频（ASR_E2E_AUDIO 可覆盖）：
 *   %LOCALAPPDATA%\Temp\shutree-e2e-audio.wav
 *   = LibriVox《The Innocence of Father Brown》前 20s，
 *     PyAV 重采样 16kHz 单声道 s16 WAV（Temp\slice_e2e_audio.py 生成，
 *     源文件 server/data/asr/in/59630b62-<uuid>/…mp3，仅取切片、不改原文件）。
 * 用法：node scripts/check_asr_upload_e2e.mjs
 */

import puppeteer from 'puppeteer-core'
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const BASE = process.env.BROWSER_ACCEPT_BASE ?? 'http://127.0.0.1:4174'
const AUDIO =
  process.env.ASR_E2E_AUDIO ??
  join(homedir(), 'AppData', 'Local', 'Temp', 'shutree-e2e-audio.wav')
const AUDIO_BASE = 'shutree-e2e-audio' // 下载文件名前缀 = <base>-字幕.<ext>
const OUT = join(HERE, '..', '练习', '_asr-upload-e2e')
const DL_DIR = join(homedir(), 'Downloads')
const DL_PREFIX = `${AUDIO_BASE}-字幕.`
const DONE_TIMEOUT_MS = 240_000

mkdirSync(OUT, { recursive: true })

if (!existsSync(AUDIO)) {
  console.error(`FATAL 测试音频不存在：${AUDIO}`)
  process.exit(2)
}
const AUDIO_BYTES = statSync(AUDIO).size

const report = {
  startedAt: new Date().toISOString(),
  base: BASE,
  audio: { path: AUDIO, bytes: AUDIO_BYTES },
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
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}
async function shot(page, file) {
  const p = join(OUT, file)
  report.screenshots.push(p)
  await page.screenshot({ path: p, fullPage: true }).catch(() => {})
}

/* ---------------- IndexedDB 读数（raw IDB，非产品代码路径） ---------------- */
async function idbAll(page, store) {
  return page.evaluate(async (storeName) => {
    const db = await new Promise((res, rej) => {
      const req = indexedDB.open('shushu-learn')
      req.onsuccess = () => res(req.result)
      req.onerror = () => rej(req.error)
      req.onupgradeneeded = () => res(req.result)
    })
    const tx = db.transaction([storeName], 'readonly')
    const allReq = tx.objectStore(storeName).getAll()
    const rows = await new Promise((res, rej) => {
      allReq.onsuccess = () => res(allReq.result)
      allReq.onerror = () => rej(allReq.error)
    })
    db.close()
    return rows
  }, store)
}
async function idbRead(page, store, key) {
  return page.evaluate(
    async ([storeName, key]) => {
      const db = await new Promise((res, rej) => {
        const req = indexedDB.open('shushu-learn')
        req.onsuccess = () => res(req.result)
        req.onerror = () => rej(req.error)
        req.onupgradeneeded = () => res(req.result)
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

/* ---------------- 下载捕获（同既有 E2E：轮询 Downloads） ---------------- */
function snapshotDownloads() {
  return new Set(readdirSync(DL_DIR))
}
async function clickAndDownload(page, ariaLabel) {
  const before = await snapshotDownloads()
  await page.$eval(`button[aria-label="${ariaLabel}"]`, (el) =>
    el.scrollIntoView({ block: 'center' }),
  )
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

function parseSrt(text) {
  const blocks = text.replace(/\r/g, '').split(/\n\n+/).filter((b) => b.trim() !== '')
  return blocks.map((b) => {
    const lines = b.split('\n')
    return { index: lines[0], time: lines[1] ?? '', text: lines.slice(2).join(' ') }
  })
}

/* ------------------------------------------------------------------ */

async function main() {
  const browser = await puppeteer.launch({
    executablePath: EDGE,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const ctx = await browser.createBrowserContext({ acceptDownloads: true })
  const page = await ctx.newPage()
  await page.setViewport({ width: 420, height: 900 })

  let jobId = null
  let segCount = 0
  let firstSegText = ''

  try {
    /* ---------- U0 打开转写页 ---------- */
    await page.goto(`${BASE}/import?tab=media`, { waitUntil: 'networkidle2', timeout: 30000 })
    await page.waitForSelector('button[aria-label="选择音视频文件"]', { timeout: 15000 })
    check('U0', '转写页打开且文件选择器可用', true, BASE + '/import?tab=media')

    /* ---------- U1 真实文件选择 + 选完自动开始（无「开始转写」按钮） ---------- */
    // fetch 探针须在选文件前装好：自动转写链路在 accept 后立即提交
    // （puppeteer 的 request.postData() 对 fetch FormData 流式 body 取不到内容）
    await page.evaluate(() => {
      window.__asrForm = null
      const orig = window.fetch
      window.fetch = async (...args) => {
        try {
          const url = typeof args[0] === 'string' ? args[0] : ''
          const init = args[1]
          if (url.includes('/asr/jobs') && init && init.body instanceof FormData) {
            window.__asrForm = {
              url,
              language: init.body.get('language') ?? null,
              hasMedia: init.body.has('media'),
            }
          }
        } catch {
          /* 探针失败不打断主链路 */
        }
        return orig(...args)
      }
    })
    const [chooser] = await Promise.all([
      page.waitForFileChooser(),
      page.click('button[aria-label="选择音视频文件"]'),
    ])
    await chooser.accept([AUDIO])
    const t0 = Date.now()
    // 自动开始证据：没有「开始转写」按钮 + 已进入处理态（阶段文本或字幕段出现）
    let autoStart = false
    let autoDetail = ''
    try {
      await page.waitForFunction(
        () =>
          document.querySelector('button[aria-label="开始转写"]') === null &&
          (document.querySelectorAll('button[aria-label^="跳转到"]').length >= 1 ||
            /提交中|排队中|转写中/.test(document.body.innerText)),
        { timeout: 15000 },
      )
      autoStart = true
    } catch (e) {
      autoDetail = e instanceof Error ? e.message.split('\n')[0] : String(e)
    }
    check(
      'U1',
      '选完文件自动开始转写（无「开始转写」按钮）',
      autoStart,
      autoStart ? `${(AUDIO_BYTES / 1024).toFixed(0)}KB wav 自动进入处理态` : `未自动开始（${autoDetail}）`,
    )
    // 语言不让用户选（决策 2026-10-22 修订）：页面不应出现语言选择器
    const langGroup = await page.$('div[role="group"][aria-label="转写语言"]')
    check('U1.5a', '无语言选择器（语言恒自动检测）', langGroup === null)
    const asrForm = await page.evaluate(() => window.__asrForm)
    check(
      'U2.0',
      '提交请求携带 language=auto（自动检测）',
      asrForm !== null && asrForm.language === 'auto' && asrForm.hasMedia === true,
      asrForm ? `language=${asrForm.language} / media=${asrForm.hasMedia}` : '探针未捕获到提交',
    )
    await shot(page, 'u1-picked.png')

    let waitErr = ''
    await page
      .waitForFunction(
        () => document.querySelectorAll('button[aria-label^="跳转到"]').length >= 1,
        { timeout: DONE_TIMEOUT_MS },
      )
      .catch((e) => {
        waitErr = e instanceof Error ? e.message.split('\n')[0] : String(e)
      })
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
    segCount = await page.evaluate(
      () => document.querySelectorAll('button[aria-label^="跳转到"]').length,
    )
    const infoText = await page.evaluate(() => document.body.innerText)
    const m = infoText.match(/语言[^\n]*·\s*时长\s*(\d+:\d+)\s*·\s*(\d+)\s*段/)
    check(
      'U2',
      '上传→ASR→done：UI 渲染出时间轴字幕段',
      segCount >= 1,
      segCount >= 1
        ? `${segCount} 段 / 耗时 ${elapsed}s`
        : `超时或失败（${waitErr}）｜UI 摘要：${infoText.replace(/\s+/g, ' ').slice(0, 120)}`,
    )
    check(
      'U3',
      'UI 信息行显示时长与段数',
      m !== null,
      m ? `时长 ${m[1]} / ${m[2]} 段` : '未匹配信息行',
    )
    await shot(page, 'u3-done.png')

    /* ---------- U4 落库 transcripts ---------- */
    const transcripts = await idbAll(page, 'transcripts')
    const rec = transcripts.length === 1 ? transcripts[0] : null
    jobId = rec?.id ?? null
    check(
      'U4',
      '结果落本机 Dexie transcripts（隔离 profile 内恰好 1 条）',
      transcripts.length === 1 && rec !== null && rec.source === 'asr',
      rec ? `id=${rec.id} / source=${rec.source} / ${rec.segments?.length ?? 0} 段` : '缺失',
    )
    check(
      'U4.2',
      '落库记录 fileName/语言/时长/段数与上传一致',
      rec !== null &&
        rec.fileName === 'shutree-e2e-audio.wav' &&
        rec.segments?.length === segCount &&
        typeof rec.duration === 'number' &&
        rec.duration > 0,
      rec ? `${rec.fileName} / ${rec.language} / ${rec.duration?.toFixed(2)}s` : '缺失',
    )
    firstSegText = rec?.segments?.[0]?.text ?? ''

    /* ---------- U5 阅读器资料自动登记 ---------- */
    if (jobId !== null) {
      const reading = await idbRead(page, 'readings', `t_${jobId}`)
      check(
        'U5',
        '阅读器资料自动登记 t_<jobId>',
        reading !== null,
        reading ? `id=${reading.id} / type=${reading.type}` : '缺失',
      )
      const same =
        reading !== null &&
        JSON.stringify(reading.segments) === JSON.stringify(rec.segments)
      check(
        'U5.2',
        '资料 segments 与转写结果逐段一致（不重生成、不截断）',
        same,
        `${reading?.segments?.length ?? 0} 段`,
      )
    } else {
      check('U5', '阅读器资料自动登记 t_<jobId>', false, '无 jobId（U4 失败）')
      check('U5.2', '资料 segments 与转写结果逐段一致', false, '无 jobId')
    }

    /* ---------- U6 服务端 API 回读 ---------- */
    if (jobId !== null) {
      const resp = await fetch(`${BASE}/api/asr/jobs/${jobId}`)
      const body = await resp.json().catch(() => null)
      check(
        'U6',
        '服务端 API 回读同一 jobId：done 且段数一致',
        resp.status === 200 && body?.status === 'done' && body?.transcript?.segments?.length === segCount,
        `HTTP ${resp.status} / status=${body?.status} / ${body?.transcript?.segments?.length ?? 0} 段`,
      )
    } else {
      check('U6', '服务端 API 回读同一 jobId', false, '无 jobId')
    }

    /* ---------- U7 刷新回读（持久化） ---------- */
    await page.reload({ waitUntil: 'networkidle2' })
    await sleep(1800)
    const afterReload = await page.evaluate(
      () => document.querySelectorAll('button[aria-label^="跳转到"]').length,
    )
    const reloadText = await page.evaluate(() => document.body.innerText)
    check(
      'U7',
      '刷新后字幕页回读最近转写（不要求重新上传）',
      afterReload === segCount && afterReload >= 1,
      `${afterReload} 段 / 含「已从本机存储恢复」提示=${reloadText.includes('已从本机存储恢复')}`,
    )
    await shot(page, 'u7-reload.png')

    /* ---------- U9 导出（在回读态导出，验证不依赖媒体句柄） ---------- */
    const srt = await clickAndDownload(page, '导出 SRT')
    const srtBlocks = srt.ok ? parseSrt(srt.text) : []
    const srtOk =
      srt.ok &&
      srtBlocks.length === segCount &&
      srtBlocks.every((b, i) => b.index === String(i + 1)) &&
      srtBlocks.every((b) => /^\d{2}:\d{2}:\d{2},\d{3}\s-->\s\d{2}:\d{2}:\d{2},\d{3}$/.test(b.time)) &&
      srtBlocks.some((b) => b.text.trim() !== '')
    check(
      'U9.1',
      '导出 SRT：真实落盘、序号连续、时间码合法、段数一致',
      srtOk,
      srt.ok ? `${srt.suggested} / ${srtBlocks.length} 块` : '未捕获下载',
    )
    const txt = await clickAndDownload(page, '导出 TXT')
    const txtLines = txt.ok ? txt.text.replace(/\r/g, '').split('\n').filter((l) => l !== '') : []
    check(
      'U9.2',
      '导出 TXT：真实落盘、每段一行、无时间戳',
      txt.ok && txtLines.length === segCount,
      txt.ok ? `${txt.suggested} / ${txtLines.length} 行` : '未捕获下载',
    )

    /* ---------- U8 阅读器 ---------- */
    if (jobId !== null) {
      await page.goto(`${BASE}/reader/t_${jobId}`, { waitUntil: 'networkidle2', timeout: 30000 })
      await sleep(1500)
      const readerText = await page.evaluate(() => document.body.innerText)
      const needle = firstSegText.replace(/\s+/g, '')
      const hay = readerText.replace(/\s+/g, '')
      check(
        'U8',
        '阅读器打开 t_<jobId>，正文含首段文本',
        needle !== '' && hay.includes(needle),
        firstSegText.slice(0, 40),
      )
      await shot(page, 'u8-reader.png')
    } else {
      check('U8', '阅读器打开 t_<jobId>', false, '无 jobId')
    }
  } catch (e) {
    check('EX', '脚本执行期未捕获异常', false, e instanceof Error ? e.message : String(e))
    await shot(page, 'error.png').catch(() => {})
  } finally {
    const removed = cleanupTestDownloads()
    await browser.close()
    if (removed.length > 0) console.log(`cleaned test downloads: ${removed.join(', ')}`)
  }

  report.notVerified.push('用户真实浏览器中的既有数据由用户刷新后自行确认；本脚本只用隔离 incognito context')
  report.finishedAt = new Date().toISOString()
  report.failures = failures
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2))
  console.log(`\n===== ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`} =====`)
  console.log(`report: ${join(OUT, 'report.json')}`)
  process.exit(failures === 0 ? 0 : 1)
}

await main()
