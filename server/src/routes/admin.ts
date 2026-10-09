// =============================================================================
// 管理员接口（需要 Bearer ADMIN_API_KEY）
//   POST /api/admin/dictionary/scans           提交词典页扫描
//   GET  /api/admin/dictionary/batches/:batchId 轮询并处理整批
// =============================================================================

import { Router } from 'express';
import type { OcrPipeline } from '../ocr/pipeline';
import { requireAdminApiKey } from '../http/adminAuth';
import { ApiError, asyncHandler } from '../http/errors';
import { readUuidParam } from '../http/validate';
import { IMAGE_FIELD, createImageUpload, filesOf, toIncomingImages } from '../http/upload';
import {
  SERVER_MAX_BATCH_FILES,
  type BatchStatusResponse,
  type PageKind,
  type SubmitScansResponse,
} from '../types';

export interface AdminRouteDeps {
  pipeline: OcrPipeline;
  adminApiKey: string;
}

const upload = createImageUpload(SERVER_MAX_BATCH_FILES);

const PAGE_KINDS: readonly PageKind[] = ['material', 'toc', 'entry', 'table', 'instruction', 'unknown'];

function readBodyRecord(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
}

function readPageKind(body: Record<string, unknown>): PageKind {
  const raw = body['pageKind'];
  if (typeof raw !== 'string') {
    throw ApiError.badRequest('缺少 pageKind（toc | entry | table | instruction | unknown）');
  }
  const found = PAGE_KINDS.find((kind) => kind === raw.trim());
  if (found === undefined) {
    throw ApiError.badRequest(`pageKind 非法：${raw}`);
  }
  return found;
}

function readSourceBook(body: Record<string, unknown>): string {
  const raw = body['sourceBook'];
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw ApiError.badRequest('缺少 sourceBook');
  }
  return raw.trim().slice(0, 200);
}

/** pageNumbers 支持数组或逗号分隔字符串，长度不足时补 null。 */
function readPageNumbers(body: Record<string, unknown>, count: number): Array<number | null> {
  const raw = body['pageNumbers'];
  const values: Array<number | null> = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      values.push(typeof item === 'number' && Number.isInteger(item) && item >= 0 ? item : null);
    }
  } else if (typeof raw === 'string' && raw.trim() !== '') {
    for (const part of raw.split(',')) {
      const parsed = Number(part.trim());
      values.push(Number.isInteger(parsed) && parsed >= 0 ? parsed : null);
    }
  }
  while (values.length < count) values.push(null);
  return values.slice(0, count);
}

export function createAdminRouter(deps: AdminRouteDeps): Router {
  const router = Router();
  // 鉴权只作用于管理端路由本身：若用 router.use(...)，因为本 router 挂在 /api 下，
  // 会导致所有 /api/* 未知路径也返回 401 而不是 404。
  const adminOnly = requireAdminApiKey(deps.adminApiKey);

  router.post(
    '/admin/dictionary/scans',
    adminOnly,
    upload.array(IMAGE_FIELD, SERVER_MAX_BATCH_FILES),
    asyncHandler(async (req, res) => {
      const body = readBodyRecord(req.body);
      const sourceBook = readSourceBook(body);
      const pageKind = readPageKind(body);

      const files = filesOf(req);
      if (files.length === 0) {
        throw ApiError.badRequest(`缺少上传文件：请使用字段名 ${IMAGE_FIELD} 提交至少一张图片`);
      }
      if (files.length > SERVER_MAX_BATCH_FILES) {
        throw ApiError.badRequest(`单次最多提交 ${SERVER_MAX_BATCH_FILES} 张图片`);
      }

      const result = await deps.pipeline.submit({
        images: toIncomingImages(files),
        purpose: 'dictionary',
        pageKind,
        sourceBook,
        pageNumbers: readPageNumbers(body, files.length),
      });

      const response: SubmitScansResponse = {
        batchId: result.batchId,
        count: result.scans.length,
        scans: result.scans,
      };
      res.status(202).json(response);
    }),
  );

  router.get(
    '/admin/dictionary/batches/:batchId',
    adminOnly,
    asyncHandler(async (req, res) => {
      const batchId = readUuidParam(req.params as Record<string, string>, 'batchId');

      const result = await deps.pipeline.syncBatch(batchId);
      const response: BatchStatusResponse = {
        batchId: result.batchId,
        total: result.total,
        byStatus: result.byStatus,
        processed: result.processed,
        summary: result.summary,
        scans: result.scans.map((scan) => ({
          scanId: scan.scanId,
          status: scan.status,
          text: scan.status === 'done' ? scan.text : null,
          error: scan.error,
        })),
      };
      res.json(response);
    }),
  );

  return router;
}
