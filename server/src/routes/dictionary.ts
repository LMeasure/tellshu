// =============================================================================
// GET /api/sync/dictionary?since&limit   增量同步 entries / toc / grammar_rules
// GET /api/search?q&limit                全局检索（内置词库 words + 扫描库 entries）
// GET /api/dictionary/entries?word       按单词取完整扫描词条（详情页回退）
// =============================================================================

import { Router } from 'express';
import type { DictionaryRepository } from '../db/repository';
import { ApiError, asyncHandler } from '../http/errors';
import type { EntriesByWordResponse, SearchResponse, SyncResponse } from '../types';

export interface DictionaryRouteDeps {
  repository: DictionaryRepository;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const MAX_SINCE = Number.MAX_SAFE_INTEGER;

function readLimit(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_LIMIT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw ApiError.badRequest('limit 必须是正整数');
  }
  return Math.min(value, MAX_LIMIT);
}

function readSince(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return 0;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > MAX_SINCE) {
    throw ApiError.badRequest('since 必须是非负整数');
  }
  return value;
}

function readQuery(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw ApiError.badRequest('缺少查询参数 q');
  }
  const trimmed = raw.trim();
  if (trimmed.length > 200) {
    throw ApiError.badRequest('q 过长（上限 200 字符）');
  }
  return trimmed;
}

export function createDictionaryRouter(deps: DictionaryRouteDeps): Router {
  const router = Router();

  router.get(
    '/sync/dictionary',
    asyncHandler(async (req, res) => {
      const since = readSince(req.query['since']);
      const limit = readLimit(req.query['limit']);
      const payload: SyncResponse = await deps.repository.syncSince(since, limit);
      res.json(payload);
    }),
  );

  router.get(
    '/search',
    asyncHandler(async (req, res) => {
      const query = readQuery(req.query['q']);
      const limit = readLimit(req.query['limit']);
      const payload: SearchResponse = await deps.repository.search(query, limit);
      res.json(payload);
    }),
  );

  router.get(
    '/dictionary/entries',
    asyncHandler(async (req, res) => {
      const word = readQuery(req.query['word']);
      const entries = await deps.repository.listEntriesByWord(word);
      const payload: EntriesByWordResponse = { word, entries };
      res.json(payload);
    }),
  );

  return router;
}
