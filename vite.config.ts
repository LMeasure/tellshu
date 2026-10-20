import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { fileURLToPath, URL } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 词库数据外置中间件（P0）
 * ------------------------------------------------------------------
 * 410MB 词库已移出 public/，放在仓库根 `data/linguabase/v1/`，**不参与打包**。
 * 但开发与本地预览仍需要能读到它，所以在这里把同源路径
 * `/data/linguabase/v1/**` 直接映射到本地数据目录。
 *
 * 生产环境不走这里：由 VITE_DATA_BASE_URL 指向 Cloudflare R2 等对象存储。
 * 自托管（把 data/ 一起放到站点根目录）时，交给 Nginx / 静态服务器处理，
 * 与本中间件路径完全一致，因此行为一致。
 */
// 版本号与前端 dataClient 的 DATA_VERSION 同源（都读 VITE_DATA_VERSION），
// 否则会出现「中间件按 v2 找目录、前端按 v1 拼 URL」的错位。
const DATA_VERSION = process.env.VITE_DATA_VERSION || 'v1'
const DATA_URL_PREFIX = `/data/linguabase/${DATA_VERSION}/`
const DATA_DIR = fileURLToPath(new URL(`./data/linguabase/${DATA_VERSION}`, import.meta.url))

function localDataPlugin(): Plugin {
  /** 注册到 dev server / preview server 的同一个处理函数。 */
  const middleware = (
    req: { url?: string },
    res: {
      statusCode: number
      setHeader: (k: string, v: string) => void
      end: (body?: string) => void
    },
    next: () => void,
  ): void => {
    const url = req.url ?? ''
    if (!url.startsWith(DATA_URL_PREFIX)) {
      next()
      return
    }
    const raw = url.slice(DATA_URL_PREFIX.length).split('?')[0] ?? ''
    let rel: string
    try {
      rel = decodeURIComponent(raw)
    } catch {
      res.statusCode = 400
      res.end('bad request')
      return
    }
    // 目录穿越防护：解析后必须仍在数据目录内
    const file = path.resolve(DATA_DIR, rel)
    if (file !== DATA_DIR && !file.startsWith(DATA_DIR + path.sep)) {
      res.statusCode = 403
      res.end('forbidden')
      return
    }
    fs.stat(file, (err, stat) => {
      if (err || !stat.isFile()) {
        res.statusCode = 404
        res.end('not found')
        return
      }
      res.statusCode = 200
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.setHeader('Cache-Control', 'no-cache')
      // 大分片（释义最大约 10MB）用流式读取，避免整文件进内存
      fs.createReadStream(file)
        .on('error', () => {
          res.statusCode = 500
          res.end('read error')
        })
        .pipe(res as unknown as NodeJS.WritableStream)
    })
  }

  return {
    name: 'shushu-local-data',
    configureServer(server) {
      server.middlewares.use(middleware)
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware)
    },
  }
}

/**
 * PWA 配置（P1）
 * ------------------------------------------------------------------
 * 目标：可「添加到主屏幕」，离线打开已加载过的内容。
 *
 * ⚠️ 绝不 precache 410MB 数据。数据走 runtimeCaching 按需入缓存：
 *   - 稳定小索引（index/manifest/catalog/themes|bank 的 index.json）→ NetworkFirst
 *     联网优先拿最新，断网回退缓存，避免版本更新后读到旧索引
 *   - 版本化分片（books/ themes/<id>.json bank/L*.json defs/*.json）→ CacheFirst
 *     路径里带 v1，内容不可变，命中即回缓存，最省流量
 *
 * iOS 注意：Safari 对「未安装到主屏幕」的站点会在 7 天不活跃后清空
 * CacheStorage/IndexedDB。已 Load 的内容在安装成 PWA 后才会长期保留。
 */
/**
 * ⚠️ 这里必须传 **RegExp 字面量**，不能传 `({url}) => RE.test(url.pathname)` 这种函数。
 * workbox 会把 runtimeCaching 的配置字符串化写进 sw.js：RegExp 会被写成正则字面量，
 * 而**函数体会被原样复制** —— 函数里引用的外部常量（哪怕就在本文件里定义）
 * 在 Service Worker 作用域里根本不存在，运行时直接 ReferenceError，整条路由失效。
 * 曾经踩过这个坑，别改回函数写法。
 *
 * 正则保持「两边都能命中」：同源路径 `.../data/linguabase/v1/x.json` 与
 * 跨域 R2 路径 `https://cdn/linguabase/v1/x.json` 都含 `/linguabase/vN/`。
 */
const DATA_SHARD_RE = /\/linguabase\/v\d+\//
const DATA_INDEX_RE =
  /\/linguabase\/v\d+\/(?:index|manifest|catalog)\.json$|\/linguabase\/v\d+\/(?:themes|bank)\/index\.json$/

/**
 * /api 反向代理（2026-10-07）：
 * 前端 DICT_API_BASE 默认是相对路径 `/api`（同源、无 CORS 问题）。
 * 手机 / 局域网设备访问 dev(5173) 或 preview(4174) 时，`/api/*` 会落在
 * vite 自己身上 —— 没有这条代理时：
 *   - POST（如扫描上传）→ vite 直接 404；
 *   - GET（如增量同步）→ 被 SPA history 回退接住，返回 200 + index.html，
 *     前端把 HTML 当 JSON 解析得到 null，炸出 TypeError。
 * 代理统一转发给本机 8787 的 shutree 后端（后端必须同时在跑）。
 *
 * /api/discover 书籍检索（2026-10-20，M4 之后接入）：
 * 检索 API 是独立的 FastAPI 只读服务（默认 8000），不是 8787 的 Node 后端
 * （Node 侧没有 discover 路由，拆分无冲突）。FastAPI 未配 CORS，
 * 所以前端同样走同源 /api/discover 路径，由这里转发。
 * ⚠️ 键序即优先级：`/api/discover` 必须先于 `/api` 注册，否则
 * `/api/discover/*` 会被 8787 接走（SPA 回退 → 前端拿到 HTML）。
 * 生产部署时需要一个反向代理规则：/api/discover/* → 检索 API 服务。
 */
const API_PROXY_TARGET = process.env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:8787'
const DISCOVER_API_PROXY_TARGET =
  process.env.VITE_DISCOVER_API_PROXY_TARGET || 'http://127.0.0.1:8000'
const apiProxy = {
  '/api/discover': {
    target: DISCOVER_API_PROXY_TARGET,
    changeOrigin: false, // 同机转发，保持 Host 即可
  },
  '/api': {
    target: API_PROXY_TARGET,
    changeOrigin: false, // 同机转发，保持 Host 即可
  },
}

export default defineConfig({
  plugins: [
    react(),
    localDataPlugin(),
    VitePWA({
      registerType: 'autoUpdate',
      // 不配 includeAssets：public/ 下的 ico/png 已被 globPatterns 覆盖，
      // 再写一遍只会产生重复条目。
      manifest: {
        name: '述树 · 零基础英语',
        short_name: '述树',
        description: '移动优先的离线英语学习应用：零基础起步，词库 / 听读 / 默写 / 背诵一站式。',
        lang: 'zh-CN',
        dir: 'ltr',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        theme_color: '#45b649',
        background_color: '#ffffff',
        categories: ['education'],
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          {
            src: 'icons/maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // 只预缓存应用外壳（js/css/html/图标），data/ 已不在 public 下
        globPatterns: ['**/*.{js,css,html,ico,png,svg,webp,woff2}'],
        globIgnores: ['**/data/**'], // 双保险：万一有数据漏进产物也不进 precache
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
        runtimeCaching: [
          {
            urlPattern: DATA_INDEX_RE,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'shushu-index',
              networkTimeoutSeconds: 5,
              expiration: { maxEntries: 12, maxAgeSeconds: 7 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: DATA_SHARD_RE,
            handler: 'CacheFirst',
            options: {
              cacheName: 'shushu-data',
              expiration: {
                maxEntries: 60,
                maxAgeSeconds: 90 * 24 * 60 * 60,
                purgeOnQuotaError: true, // 配额吃紧时优先丢数据缓存，别把外壳挤掉
              },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      // dev 下不开 SW：会缓存分片导致改了数据看不到，联调很痛苦。
      // 要验 PWA 用 npm run build && npm run preview。
      devOptions: { enabled: false },
    }),
  ],
  // 数据不再走 publicDir；public/ 只放 PWA 图标等小文件（几 KB）
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: true,
    port: Number(process.env.PORT) || 5173,
    allowedHosts: true,
    proxy: apiProxy, // dev 与 preview 共用（preview.proxy 默认继承 server.proxy，这里显式写出更稳）
  },
  preview: {
    // 与 dev 分端口：两个一起开才能对照「开发」与「PWA 生效」的差别
    host: true,
    port: Number(process.env.PREVIEW_PORT) || 4173,
    allowedHosts: true,
    proxy: apiProxy,
  },
})
