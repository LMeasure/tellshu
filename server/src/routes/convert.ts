// =============================================================================
// 格式转换路由（复用 server/，按路由挂中间件，不污染 /api/* 其它路径）
// GET  /api/convert/health                    服务健康（含 engineEnabled）
// POST /api/convert/files/upload              上传源文件（落盘，返回 fileId + 识别格式）
// POST /api/convert/tasks                     创建转换任务（引擎未接入时 503）
// GET  /api/convert/tasks/:taskId             轮询任务状态
// GET  /api/convert/files/:fileId/download     下载结果（仅 success 且有 resultFileId）
// =============================================================================

import path from 'node:path'
import { promises as fs } from 'node:fs'
import { Router } from 'express'
import multer from 'multer'
import { ApiError, asyncHandler } from '../http/errors'
import { createIpRateLimiter } from '../http/rateLimit'
import type { ConvertStore } from '../db/convertStore'
import type { AppConfig } from '../config'
import type { OcrPipeline } from '../ocr/pipeline'
import type { IncomingImage } from '../ocr/storage'
import { createStoreOnlyZip } from '../lib/zip'
import type {
  ConvertCreateTaskResponse,
  ConvertFormat,
  ConvertHealthResponse,
  ConvertOcrResponse,
  ConvertTaskStatusResponse,
  ConvertUploadResponse,
} from '../types'

export interface ConvertRouteDeps {
  store: ConvertStore
  config: AppConfig
  /** 复用 OCR 流水线（PaddleOCR）对转换结果做 OCR 提取文字 */
  pipeline: OcrPipeline
}

/** ZIP 打包总体积上限：避免把超大结果一次性读进内存（机器内存紧张）。超出返回 413 提示分拆。 */
const MAX_ZIP_BYTES = 80 * 1024 * 1024

/**
 * 源文件大小上限：默认 50MB，可被 CONVERT_MAX_FILE_SIZE 覆盖（字节）。
 * 超出由 multer 触发 LIMIT_FILE_SIZE → 全局错误中间件统一返回 413。
 * 设定范围 1MB~200MB，越界则回退默认，避免误配导致上传被完全锁死或过大。
 */
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024
function resolveMaxFileBytes(): number {
  const raw = process.env['CONVERT_MAX_FILE_SIZE']
  if (raw === undefined) return DEFAULT_MAX_BYTES
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 1 * 1024 * 1024 || parsed > 200 * 1024 * 1024) {
    return DEFAULT_MAX_BYTES
  }
  return Math.floor(parsed)
}

/** V1 支持的扩展名（服务端白名单，与前端 domain/convert.ts 保持一致） */
const ALLOWED_EXT = new Set(['.pdf', '.docx', '.png', '.jpg', '.jpeg', '.xlsx'])
/** 允许的 Content-Type 白名单（与上面扩展名对应）。 */
const ALLOWED_MIME = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/png',
  'image/jpeg',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  // 浏览器对未知类型常回退为 octet-stream，放行以免误杀合法上传
  'application/octet-stream',
])
const EXT_TO_FORMAT: Record<string, ConvertFormat> = {
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.png': 'png',
  '.jpg': 'jpg',
  '.jpeg': 'jpg',
  '.xlsx': 'xlsx',
}
const ALL_FORMATS: readonly ConvertFormat[] = ['pdf', 'docx', 'png', 'jpg', 'xlsx']

/**
 * 清洗客户端原始文件名：剥离路径分隔符、`..`、空字节与控制字符，
 * 仅保留安全可见字符。存储路径本身只用 uuid（绝不依赖原始名），
 * 此处清洗仅用于入库展示与下载时的 Content-Disposition，防注入。
 */
function sanitizeOriginalName(name: string): string {
  let s = name.replace(/\0/g, '') // 空字节
  s = s.replace(/[\\/]/g, '_') // 路径分隔符（含反斜杠）
  s = s.replace(/\.\.+/g, '_') // 路径穿越片段
  // 剥离控制字符：C0 段(0x00-0x1F)、DEL(0x7F)、C1 段(0x80-0x9F)
  // 用 codePoint 过滤而非正则 \u 转义，规避不同 TS 版本对正则转义解析差异
  s = Array.from(s)
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0
      return !(code <= 0x1f || (code >= 0x7f && code <= 0x9f))
    })
    .join('')
  const stripped = s.trim()
  return stripped.length > 0 ? stripped.slice(0, 255) : 'upload.bin'
}

function detectFormatFromName(name: string): ConvertFormat | null {
  const lower = name.toLowerCase()
  const ext = lower.includes('.') ? `.${lower.split('.').pop() ?? ''}` : ''
  return ALLOWED_EXT.has(ext) ? (EXT_TO_FORMAT[ext] ?? null) : null
}

function isAllowedPair(source: ConvertFormat, target: ConvertFormat): boolean {
  if (source === target) return false
  const allowed: ReadonlyArray<readonly [ConvertFormat, ConvertFormat]> = [
    ['pdf', 'docx'],
    ['docx', 'pdf'],
    ['pdf', 'png'],
    ['png', 'pdf'],
    ['jpg', 'pdf'],
    ['xlsx', 'pdf'],
  ]
  return allowed.some(([s, t]) => s === source && t === target)
}

const upload = multer({
  storage: multer.memoryStorage(),
  // 大小上限来自环境配置（默认 50MB），超出 → LIMIT_FILE_SIZE → 413
  limits: { fileSize: resolveMaxFileBytes(), files: 1, fields: 10, parts: 20 },
  fileFilter: (_req, file, cb) => {
    // 安全防线 1：扩展名白名单 + 2：Content-Type 白名单，双重校验
    // 任一不合法 → 415（不是 400，语义更准确地表达「媒体类型不支持」）
    const ext = path.extname(file.originalname).toLowerCase()
    if (!ALLOWED_EXT.has(ext)) {
      cb(ApiError.unsupportedMediaType(`不支持的文件扩展名：${ext || file.originalname}（仅 PDF/DOCX/PNG/JPG/XLSX）`))
      return
    }
    if (file.mimetype !== undefined && file.mimetype !== '' && !ALLOWED_MIME.has(file.mimetype)) {
      cb(ApiError.unsupportedMediaType(`不支持的文件类型：${file.mimetype}（仅允许 PDF/DOCX/PNG/JPG/XLSX）`))
      return
    }
    cb(null, true)
  },
})

/** 10 次/小时/IP（文件上传，限流从紧，与 OCR 一致） */
const rateLimit = createIpRateLimiter({ windowMs: 60 * 60 * 1_000, maxRequests: 30 })

export function createConvertRouter(deps: ConvertRouteDeps): Router {
  const router = Router()

  router.get('/convert/health', (_req, res) => {
    const body: ConvertHealthResponse = { ok: true, engineEnabled: deps.config.convert.engineEnabled }
    res.json(body)
  })

  router.post(
    '/convert/files/upload',
    rateLimit,
    upload.single('file'),
    asyncHandler(async (req, res) => {
      const file = req.file
      if (file === undefined) {
        throw ApiError.badRequest('缺少上传文件：请使用字段名 file 提交一个文件')
      }
      const format = detectFormatFromName(file.originalname)
      if (format === null) {
        throw ApiError.unsupportedMediaType('无法识别文件格式（仅支持 PDF/DOCX/PNG/JPG/XLSX）')
      }
      const cleanName = sanitizeOriginalName(file.originalname)
      const { fileId, storagePath } = await deps.store.createFile({
        originalName: cleanName,
        format,
        mimeType: file.mimetype,
        sizeBytes: file.size,
        storageDir: deps.config.convert.storageDir,
      })
      // 落盘：物理文件名只用 uuid（storagePath 由 store 用 randomUUID 生成），
      // 客户端原始名不进入路径，杜绝路径穿越。
      await fs.writeFile(storagePath, file.buffer)
      const body: ConvertUploadResponse = {
        fileId,
        format,
        originalName: cleanName,
        sizeBytes: file.size,
      }
      res.status(201).json(body)
    }),
  )

  router.post(
    '/convert/tasks',
    rateLimit,
    asyncHandler(async (req, res) => {
      // 引擎未接入：如实 503（与 translate/asr 一致），前端显示「未接入」而非伪造结果
      if (!deps.config.convert.engineEnabled) {
        throw ApiError.serviceUnavailable('转换引擎未接入（Python 转换 Worker 未部署）')
      }
      const body = req.body as Record<string, unknown>
      const fileId = typeof body['fileId'] === 'string' ? (body['fileId'] as string) : null
      const targetFormat =
        typeof body['targetFormat'] === 'string' ? (body['targetFormat'] as ConvertFormat) : null
      if (fileId === null || fileId.trim() === '') {
        throw ApiError.badRequest('缺少 fileId')
      }
      if (targetFormat === null || !ALL_FORMATS.includes(targetFormat)) {
        throw ApiError.badRequest('targetFormat 非法')
      }
      const source = await deps.store.getFileSourceFormat(fileId)
      if (source === null) {
        throw ApiError.notFound('fileId 不存在或已过期')
      }
      if (!isAllowedPair(source, targetFormat)) {
        throw ApiError.badRequest(`不支持的转换：${source} → ${targetFormat}`)
      }
      const taskId = await deps.store.createTask({ fileId, sourceFormat: source, targetFormat })
      const out: ConvertCreateTaskResponse = { taskId, status: 'waiting' }
      res.status(202).json(out)
    }),
  )

  router.get(
    '/convert/tasks/:taskId',
    asyncHandler(async (req, res) => {
      const taskId = req.params['taskId']
      if (taskId === undefined) {
        throw ApiError.badRequest('缺少 taskId')
      }
      const task = await deps.store.getTask(taskId)
      if (task === null) {
        throw ApiError.notFound('任务不存在')
      }
      const body: ConvertTaskStatusResponse = {
        taskId,
        status: task.status,
        progress: task.progress,
        sourceFormat: task.sourceFormat,
        targetFormat: task.targetFormat,
        errorMessage: task.errorMessage,
        resultFileId: task.resultFileId,
      }
      res.json(body)
    }),
  )

  router.get(
    '/convert/files/:fileId/download',
    asyncHandler(async (req, res) => {
      const fileId = req.params['fileId']
      if (fileId === undefined) {
        throw ApiError.badRequest('缺少 fileId')
      }
      const file = await deps.store.getFile(fileId)
      if (file === null) {
        throw ApiError.notFound('文件不存在或已过期')
      }
      // 文件名仅作 Content-Disposition，清洗后去除路径分隔符与控制字符，防注入
      const safeName = sanitizeOriginalName(file.originalName)
      res.download(file.storagePath, safeName)
    }),
  )

  // 转换结果打包下载（ZIP）：把全部结果文件（多页 PDF→PNG 等）合成一个压缩包一次性下发
  router.get(
    '/convert/tasks/:taskId/zip',
    rateLimit,
    asyncHandler(async (req, res) => {
      const taskId = req.params['taskId']
      if (taskId === undefined) {
        throw ApiError.badRequest('缺少 taskId')
      }
      const meta = await deps.store.getTaskResultFiles(taskId)
      if (meta === null) {
        throw ApiError.notFound('任务不存在')
      }
      if (meta.status !== 'success') {
        throw ApiError.badRequest(`任务尚未完成（当前状态：${meta.status}），无法打包下载`)
      }
      if (meta.resultFileIds.length === 0) {
        throw ApiError.notFound('该任务没有可下载的结果文件')
      }

      const buffers: Array<{ name: string; data: Buffer }> = []
      let total = 0
      for (let i = 0; i < meta.resultFileIds.length; i += 1) {
        const fileId = meta.resultFileIds[i]
        if (fileId === undefined) continue
        const file = await deps.store.getFile(fileId)
        if (file === null) continue
        const data = await fs.readFile(file.storagePath)
        total += data.length
        if (total > MAX_ZIP_BYTES) {
          throw ApiError.payloadTooLarge('结果文件总体积过大，无法打包下载，请分拆源文件后重试')
        }
        const base = sanitizeOriginalName(file.originalName) || `page_${i + 1}`
        const name = `${String(i + 1).padStart(3, '0')}_${base}`
        buffers.push({ name, data })
      }
      if (buffers.length === 0) {
        throw ApiError.notFound('没有可读取的结果文件')
      }

      const zip = createStoreOnlyZip(buffers)
      const downloadName = `convert-${taskId.slice(0, 8)}.zip`
      res.setHeader('Content-Type', 'application/zip')
      res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`)
      res.send(zip)
    }),
  )

  // 转换结果 OCR 成文章：仅 PDF→PNG 的图片结果可逐页识别，返回按页码拼接的文本
  router.post(
    '/convert/tasks/:taskId/ocr',
    rateLimit,
    asyncHandler(async (req, res) => {
      const taskId = req.params['taskId']
      if (taskId === undefined) {
        throw ApiError.badRequest('缺少 taskId')
      }
      const meta = await deps.store.getTaskResultFiles(taskId)
      if (meta === null) {
        throw ApiError.notFound('任务不存在')
      }
      if (meta.status !== 'success') {
        throw ApiError.badRequest(`任务尚未完成（当前状态：${meta.status}），无法提取文字`)
      }
      if (meta.targetFormat !== 'png') {
        throw ApiError.badRequest('仅 PDF→PNG 的图片结果支持 OCR 提取文字')
      }

      const images: IncomingImage[] = []
      for (let i = 0; i < meta.resultFileIds.length; i += 1) {
        const fileId = meta.resultFileIds[i]
        if (fileId === undefined) continue
        const file = await deps.store.getFile(fileId)
        if (file === null) continue
        const data = await fs.readFile(file.storagePath)
        images.push({
          buffer: data,
          originalName: file.originalName,
          mimeType: file.mimeType || 'image/png',
        })
      }
      if (images.length === 0) {
        throw ApiError.notFound('没有可识别的图片结果')
      }

      const { text, pages } = await deps.pipeline.ocrBuffersToText(images)
      const body: ConvertOcrResponse = { taskId, text, pages }
      res.status(200).json(body)
    }),
  )

  return router
}

// 安全说明（对应 格式转换.md §9）：
//   1) 本路由只做「收文件 + 建任务 + 下发结果」，绝不调用 subprocess / os.system / shell；
//      真正的转换由 Python Worker 用纯库（如 PyMuPDF）完成，无命令注入面。
//   2) 输入源文件由 Worker 在任务处理完成后（成功或失败）删除，不在服务端长期留存；
//      结果文件（转换产物）由 server 启动时注册的定时器按 TTL 自动清理：
//      默认保留 1 小时、每 10 分钟扫描一次；环境变量 CONVERT_RESULT_TTL_MS（TTL）/
//      CONVERT_CLEANUP_INTERVAL_MS（扫描间隔）可配，越界回退默认。实现位于
//      ConvertStore.cleanupExpiredResultFiles，由 index.ts 的 setInterval 周期调用。
