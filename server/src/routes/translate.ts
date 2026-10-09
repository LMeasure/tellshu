// =============================================================================
// POST /api/translate —— 转发到 LibreTranslate 兼容服务
// 未配置 TRANSLATE_API_URL 时返回 503。
// =============================================================================

import { Router } from 'express';
import type { TranslateConfig } from '../config';
import { ApiError, asyncHandler } from '../http/errors';
import { asString, isRecord, type TranslateRequest, type TranslateResponse } from '../types';

export interface TranslateRouteDeps {
  translate: TranslateConfig;
  timeoutMs: number;
}

const MAX_TEXT_LENGTH = 5000;
const LANGUAGE_CODE = /^(?:auto|[a-zA-Z]{2,3}(?:-[a-zA-Z]{2,4})?)$/;

function readBody(body: unknown): TranslateRequest {
  if (!isRecord(body)) {
    throw ApiError.badRequest('请求体必须是 JSON 对象');
  }
  const q = asString(body['q']);
  if (q === null) {
    throw ApiError.badRequest('缺少待翻译文本 q');
  }
  if (q.length > MAX_TEXT_LENGTH) {
    throw ApiError.badRequest(`q 过长（上限 ${MAX_TEXT_LENGTH} 字符）`);
  }

  const source = asString(body['source']) ?? 'auto';
  const target = asString(body['target']) ?? 'zh';
  if (!LANGUAGE_CODE.test(source) || !LANGUAGE_CODE.test(target)) {
    throw ApiError.badRequest('source / target 必须是语言代码，如 en / zh / auto');
  }

  return { q, source, target };
}

export function createTranslateRouter(deps: TranslateRouteDeps): Router {
  const router = Router();

  router.post(
    '/translate',
    asyncHandler(async (req, res) => {
      if (deps.translate.url === null) {
        throw ApiError.serviceUnavailable('未配置 TRANSLATE_API_URL，翻译服务不可用');
      }

      const request = readBody(req.body);
      const payload: Record<string, unknown> = {
        q: request.q,
        source: request.source,
        target: request.target,
        format: 'text',
      };
      if (deps.translate.apiKey !== null) {
        payload['api_key'] = deps.translate.apiKey;
      }

      let response: Response;
      try {
        response = await fetch(deps.translate.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(deps.timeoutMs),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw ApiError.upstream(`调用翻译服务失败：${message}`);
      }

      if (!response.ok) {
        throw ApiError.upstream(`翻译服务返回 HTTP ${response.status}`);
      }

      let parsed: unknown = null;
      try {
        parsed = (await response.json()) as unknown;
      } catch {
        throw ApiError.upstream('翻译服务返回了非 JSON 响应');
      }

      if (!isRecord(parsed)) {
        throw ApiError.upstream('翻译服务响应格式不正确');
      }
      const translatedText = asString(parsed['translatedText']);
      if (translatedText === null) {
        throw ApiError.upstream('翻译服务响应缺少 translatedText');
      }

      const detectedRaw = parsed['detectedLanguage'];
      const detectedSource = isRecord(detectedRaw)
        ? asString(detectedRaw['language'])
        : asString(detectedRaw);

      const body: TranslateResponse = {
        translatedText,
        source: request.source,
        target: request.target,
        detectedSource,
      };
      res.json(body);
    }),
  );

  return router;
}
