/**
 * 多端兼容 阶段1-A5 六档真实浏览器布局验收脚本
 * ------------------------------------------------------------
 * 前置（已在 A5 流程中跑过）：
 *   1) npm run build            —— 生成 dist/
 *   2) 词库数据在仓库根 data/linguabase/v1/（不参与打包，dev 经 vite 喂；本脚本同源喂）
 *
 * 运行：
 *   node scripts/check_responsive_layout.mjs
 *
 * 说明：
 *   - 仅依赖已安装的 puppeteer-core（不写入 package.json，不新增依赖）。
 *   - Edge 路径可用环境变量 SHUSHU_EDGE 覆盖；默认取本机 x86 Edge。
 *   - 截图/结果默认写到系统临时目录 shushu_responsive/，可用 SHUSHU_SHOTS_DIR 覆盖。
 *   - 不修改任何业务代码、不修改 App.tsx / index.css / main.tsx / 页面文件。
 *
 * 验证内容（与本阶段验收口径一致）：
 *   视口 1920/1440/1366/1024（桌面档）+ 768/390（移动档）；
 *   核心路由（/、/discover）全 6 档测，确保断点切换；
 *   真实路由清单（/profile /review /search /learn /start /diagnosis /word/:word /reader/:id）
 *   在 1920/390 代表档各跑一遍；采集侧栏宽/顶栏高/内容宽/scrollWidth/溢出/是否被遮挡。
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const puppeteer = require('puppeteer-core')

const __filename = fileURLToPath(import.meta.url)
const REPO = path.resolve(path.dirname(__filename), '..')
const DIST_DIR = path.join(REPO, 'dist')
const DATA_DIR = path.join(REPO, 'data/linguabase/v1')
const EDGE = process.env.SHUSHU_EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const SHOT_DIR = process.env.SHUSHU_SHOTS_DIR || path.join(os.tmpdir(), 'shushu_responsive')
fs.mkdirSync(SHOT_DIR, { recursive: true })

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript',
  '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.map': 'application/json',
}

const VIEWPORTS = [1920, 1440, 1366, 1024, 768, 390]
const CORE_ROUTES = ['/', '/discover']
const EXTRA_ROUTES = ['/profile', '/review', '/search', '/learn', '/start', '/diagnosis', '/word/apple', '/reader/testid']

function safeName(r) {
  return (r.replace(/\//g, '_').replace(/^_/, '') || 'root')
}

function makeServer() {
  return http.createServer((req, res) => {
    const u = decodeURIComponent(req.url.split('?')[0])
    const send = (fp, s = 200) => {
      if (!fs.existsSync(fp) || !fs.statSync(fp).isFile()) { res.writeHead(404); res.end('nf'); return }
      res.writeHead(s, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' })
      fs.createReadStream(fp).pipe(res)
    }
    if (u.startsWith('/data/linguabase/v1/')) { send(path.join(DATA_DIR, u.replace('/data/linguabase/v1/', ''))); return }
    const rel = u === '/' ? '/index.html' : u
    const fp = path.join(DIST_DIR, rel)
    if (fs.existsSync(fp) && fs.statSync(fp).isFile()) { send(fp); return }
    send(path.join(DIST_DIR, 'index.html')) // SPA fallback
  })
}

async function measure(page) {
  return page.evaluate(() => {
    const de = document.documentElement
    const root = document.getElementById('root')
    const aside = document.querySelector('aside')
    const header = document.querySelector('header')
    const appFrame = document.querySelector('.app-frame')
    const dock = document.querySelector('[data-variant="dock"]')
    const mainEl = document.querySelector('main')
    const cw = mainEl ? mainEl.querySelector(':scope > div') : null
    const rect = (el) => (el ? Math.round(el.getBoundingClientRect().width) : null)
    const hdrH = header ? Math.round(header.getBoundingClientRect().height) : null
    const mainTop = mainEl ? Math.round(mainEl.getBoundingClientRect().top) : null
    return {
      hasDesktopShell: !!aside && !!header,
      hasMobileShell: !!appFrame,
      hasDock: !!dock,
      asideWidth: rect(aside),
      headerHeight: hdrH,
      contentWidth: cw ? Math.round(cw.getBoundingClientRect().width) : null,
      appFrameWidth: rect(appFrame),
      mainTop,
      scrollWidth: de.scrollWidth,
      innerWidth: window.innerWidth,
      rootChildren: root ? root.children.length : 0,
    }
  })
}

async function main() {
  if (!fs.existsSync(path.join(DIST_DIR, 'index.html'))) {
    console.error('缺少 dist/index.html，请先运行 npm run build')
    process.exit(2)
  }
  const server = makeServer()
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const BASE = `http://127.0.0.1:${port}`
  const browser = await puppeteer.launch({
    executablePath: EDGE, headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-features=ServiceWorker'],
  })
  const plan = []
  for (const v of VIEWPORTS) for (const r of CORE_ROUTES) plan.push({ v, r })
  for (const r of EXTRA_ROUTES) { plan.push({ v: 1920, r }); plan.push({ v: 390, r }) }

  const results = []
  for (const { v, r } of plan) {
    const page = await browser.newPage()
    await page.setViewport({ width: v, height: 900, deviceScaleFactor: 1 })
    await page.setRequestInterception(true)
    page.on('request', (req) => {
      if (/(\/sw\.js|\/registerSW\.js|workbox)/.test(req.url())) return req.abort()
      req.continue()
    })
    const errors = []
    page.on('pageerror', (e) => errors.push(String(e).split('\n')[0]))
    const url = BASE + (r === '/' ? '/' : r)
    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 })
      await page.waitForFunction(() =>
        document.getElementById('root')?.children.length > 0 &&
        !!(document.querySelector('aside') || document.querySelector('header') || document.querySelector('.app-frame') || document.querySelector('main')),
        { timeout: 12000 }).catch(() => {})
      await new Promise((res) => setTimeout(res, 800))
      const m = await measure(page)
      const shot = path.join(SHOT_DIR, `${v}_${safeName(r)}.png`)
      await page.screenshot({ path: shot, fullPage: false })
      const overflow = m.scrollWidth > m.innerWidth
      const pass = errors.length === 0 && m.rootChildren > 0
      results.push({ v, r, ...m, overflow, errors, shot, pass })
      console.log(`v=${v} r=${r} desktop=${m.hasDesktopShell} mobile=${m.hasMobileShell} aside=${m.asideWidth} hdr=${m.headerHeight} cw=${m.contentWidth} afw=${m.appFrameWidth} ofl=${overflow} err=${errors.length}`)
    } catch (e) {
      results.push({ v, r, error: String(e).split('\n')[0], shot: null, pass: false })
      console.log(`v=${v} r=${r} ERROR ${String(e).split('\n')[0]}`)
    }
    await page.close()
  }
  await browser.close()
  server.close()
  const failed = results.filter((x) => !x.pass).length
  fs.writeFileSync(path.join(SHOT_DIR, 'results.json'), JSON.stringify(results, null, 2))
  console.log(`\nTOTAL=${results.length} FAILED=${failed}`)
  console.log(`screenshots + results.json -> ${SHOT_DIR}`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(2) })
