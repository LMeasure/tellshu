// 接收素材扫描
// =============================================================================
// POST /api/ocr/material         （公开，受 OCR_PUBLIC_ENABLED 控制）
// GET  /api/ocr/jobs/:scanId     （轮询，done 后归档解析，material 返回 text）
// =============================================================================

import { Router } from 'express';
import type { OcrPipeline } from '../ocr/pipeline';
import { ApiError, asyncHandler } from '../http/errors';
import { createIpRateLimiter } from '../http/rateLimit';
import { readUuidParam } from '../http/validate';
import { IMAGE_FIELD, createImageUpload, filesOf, toIncomingImages } from '../http/upload';
import { SERVER_MAX_BATCH_FILES, type JobStatusResponse, type SubmitScansResponse } from '../types';

export interface OcrRouteDeps {
  pipeline: OcrPipeline;
  ocrPublicEnabled: boolean;
}

const upload = createImageUpload(SERVER_MAX_BATCH_FILES);
const publicOcrRateLimit = createIpRateLimiter({
  windowMs: 60 * 60 * 1_000,
  maxRequests: 10,
});

function readOptionalBook(body: unknown): string {
  if (typeof body !== 'object' || body === null) return '';
  const raw = (body as Record<string, unknown>)['sourceBook'];
  return typeof raw === 'string' ? raw.trim().slice(0, 200) : '';
}

export function createOcrRouter(deps: OcrRouteDeps): Router {
  const router = Router();

  router.post(
    '/ocr/material',
    publicOcrRateLimit,
    upload.array(IMAGE_FIELD, SERVER_MAX_BATCH_FILES),
    asyncHandler(async (req, res) => {
      if (!deps.ocrPublicEnabled) {
        throw ApiError.forbidden('公开素材 OCR 接口当前未开启（OCR_PUBLIC_ENABLED）');
      }

      const files = filesOf(req);
      if (files.length === 0) {
        throw ApiError.badRequest(`缺少上传文件：请使用字段名 ${IMAGE_FIELD} 提交至少一张图片`);
      }
      if (files.length > SERVER_MAX_BATCH_FILES) {
        throw ApiError.badRequest(`单次最多提交 ${SERVER_MAX_BATCH_FILES} 张图片`);
      }

      const result = await deps.pipeline.submit({
        images: toIncomingImages(files),
        purpose: 'material',
        pageKind: 'material',
        sourceBook: readOptionalBook(req.body),
      });

      const body: SubmitScansResponse = {
        batchId: result.batchId,
        count: result.scans.length,
        scans: result.scans,
      };
      res.status(202).json(body);
    }),
  );

  router.get(
    '/ocr/jobs/:scanId',
    asyncHandler(async (req, res) => {
      const scanId = readUuidParam(req.params as Record<string, string>, 'scanId');

      const result = await deps.pipeline.syncScan(scanId);
      const body: JobStatusResponse = {
        scanId: result.scanId,
        batchId: result.batchId,
        jobId: result.jobId,
        state: result.status,
        status: result.status,
        sourceBook: result.sourceBook,
        pageKind: result.pageKind,
        text: result.status === 'done' && result.pageKind === 'material' ? result.text : null,
        summary: result.summary,
        error: result.error,
      };
      res.json(body);
    }),
  );

  return router;
}
