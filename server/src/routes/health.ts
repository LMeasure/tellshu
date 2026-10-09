// =============================================================================
// GET /api/health
// =============================================================================

import { Router } from 'express';
import type { DictionaryRepository } from '../db/repository';
import type { AppConfig } from '../config';
import { asyncHandler } from '../http/errors';
import type { HealthResponse } from '../types';

export interface HealthRouteDeps {
  repository: DictionaryRepository;
  config: AppConfig;
}

export function createHealthRouter(deps: HealthRouteDeps): Router {
  const router = Router();

  router.get(
    '/health',
    asyncHandler(async (_req, res) => {
      const databaseOk = await deps.repository.healthCheck();
      const body: HealthResponse = {
        status: databaseOk ? 'ok' : 'degraded',
        service: 'shutree-server',
        time: new Date().toISOString(),
        database: databaseOk ? 'ok' : 'error',
        paddleConfigured: deps.config.paddle.accessToken !== '',
        translateConfigured: deps.config.translate.url !== null,
        ocrPublicEnabled: deps.config.ocrPublicEnabled,
      };
      res.status(databaseOk ? 200 : 503).json(body);
    }),
  );

  return router;
}
