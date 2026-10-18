// =============================================================================
// 音视频转字幕（Phase 1.5：本地 faster-whisper sidecar）
// -----------------------------------------------------------------------------
// POST /api/asr/jobs        multipart/form-data：media（单文件）、language（可选）
//   202 { jobId, status, error }   提交即败（未知异常）时 status 直接为 failed
//   400 字段缺失 / 类型不符        413 超过 100MB        503 sidecar 未就绪/不可用
// GET  /api/asr/jobs/:jobId
//   200 { jobId, status, transcript, error }
//   400 非法 UUID   404 任务不存在   410 任务已过期（TTL 2h）
// =============================================================================

import { Router } from 'express';
import type { AsrService } from '../asr/service';
import { ApiError, asyncHandler } from '../http/errors';
import { createIpRateLimiter } from '../http/rateLimit';
import { readUuidParam } from '../http/validate';
import { MEDIA_FIELD, createMediaUpload, isAllowedMediaExtension, isAllowedMediaMime, mediaFileOf } from '../http/upload';
import { ASR_MAX_FILE_BYTES, type AsrJobResponse, type AsrSubmitResponse } from '../types';

export interface AsrRouteDeps {
  service: AsrService;
}

const upload = createMediaUpload(ASR_MAX_FILE_BYTES);

/** 与公开 OCR 一致：10 次/小时/IP（大文件上传，限流从紧）。 */
const asrRateLimit = createIpRateLimiter({
  windowMs: 60 * 60 * 1_000,
  maxRequests: 10,
});

const LANGUAGE_CODE = /^(?:auto|[a-zA-Z]{2,3}(?:-[a-zA-Z]{2,4})?)$/;

function readLanguage(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const raw = (body as Record<string, unknown>)['language'];
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const value = raw.trim();
  if (!LANGUAGE_CODE.test(value)) {
    throw ApiError.badRequest('language 必须是语言代码，如 en / zh / auto');
  }
  return value;
}

export function createAsrRouter(deps: AsrRouteDeps): Router {
  const router = Router();

  router.post(
    '/asr/jobs',
    asrRateLimit,
    upload.single(MEDIA_FIELD),
    asyncHandler(async (req, res) => {
      // 未接入优先判定：sidecar 未就绪 / 已死亡时 service.submit 抛 503
      // （AsrProviderError -> ApiError 映射）；前端据此显示「转录服务未接入」
      // 而不是拿到假结果。multer 读入的 buffer 由 service 落盘中转，
      // 任务终态后清理，请求栈上不留引用。
      const file = mediaFileOf(req);
      if (file === null) {
        throw ApiError.badRequest(`缺少上传文件：请使用字段名 ${MEDIA_FIELD} 提交一个音视频文件`);
      }

      const extension = file.originalname.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? '';
      if (file.mimetype !== '' && !isAllowedMediaMime(file.mimetype)) {
        throw ApiError.badRequest(`不支持的媒体类型：${file.mimetype}`);
      }
      if (extension !== '' && !isAllowedMediaExtension(extension)) {
        throw ApiError.badRequest(`不支持的文件扩展名：${extension}`);
      }
      if (file.size > ASR_MAX_FILE_BYTES) {
        throw ApiError.payloadTooLarge(`文件超过 ${Math.floor(ASR_MAX_FILE_BYTES / (1024 * 1024))}MB 上限`);
      }

      const language = readLanguage(req.body);
      const result = await deps.service.submit({
        buffer: file.buffer,
        fileName: file.originalname,
        mimeType: file.mimetype,
        language,
      });
      const body: AsrSubmitResponse = result;
      res.status(202).json(body);
    }),
  );

  router.get(
    '/asr/jobs/:jobId',
    asyncHandler(async (req, res) => {
      const jobId = readUuidParam(req.params as Record<string, string>, 'jobId');
      const body: AsrJobResponse = await deps.service.syncJob(jobId);
      res.json(body);
    }),
  );

  return router;
}
