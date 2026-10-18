// =============================================================================
// Express 应用装配
// =============================================================================

import cors from 'cors';
import express from 'express';
import type { AppConfig } from './config';
import type { DictionaryRepository } from './db/repository';
import { errorHandler, notFoundHandler } from './http/errors';
import type { AsrService } from './asr/service';
import type { OcrPipeline } from './ocr/pipeline';
import { createAdminRouter } from './routes/admin';
import { createAsrRouter } from './routes/asr';
import { createConvertRouter } from './routes/convert';
import { ConvertStore } from './db/convertStore';
import { createDictionaryRouter } from './routes/dictionary';
import { createHealthRouter } from './routes/health';
import { createOcrRouter } from './routes/ocr';
import { createTranslateRouter } from './routes/translate';

/** 翻译服务超时（与 Paddle 超时解耦）。 */
const TRANSLATE_TIMEOUT_MS = 15_000;

export interface AppDeps {
  config: AppConfig;
  repository: DictionaryRepository;
  pipeline: OcrPipeline;
  asr: AsrService;
  convertStore: ConvertStore;
}

export function createApp(deps: AppDeps): express.Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', false);

  // CORS：只放行 CORS_ORIGIN 里显式配置的来源，绝不使用 * 通配
  if (deps.config.corsOrigins.length > 0) {
    const allowList = new Set(deps.config.corsOrigins);
    app.use(
      cors({
        origin: (origin, callback) => {
          // 同源 / 服务端直连（无 Origin 头）一律放行；浏览器跨域时精确匹配
          if (origin === undefined || allowList.has(origin)) {
            callback(null, true);
            return;
          }
          callback(null, false);
        },
        methods: ['GET', 'POST', 'OPTIONS'],
        allowedHeaders: ['authorization', 'content-type'],
        credentials: false,
        maxAge: 600,
      }),
    );
  }

  app.use(express.json({ limit: '1mb' }));

  app.use('/api', createHealthRouter({ repository: deps.repository, config: deps.config }));
  app.use(
    '/api',
    createOcrRouter({ pipeline: deps.pipeline, ocrPublicEnabled: deps.config.ocrPublicEnabled }),
  );
  app.use(
    '/api',
    createTranslateRouter({
      translate: deps.config.translate,
      timeoutMs: TRANSLATE_TIMEOUT_MS,
    }),
  );
  app.use('/api', createAsrRouter({ service: deps.asr }));
  app.use(
    '/api',
    createConvertRouter({
      store: deps.convertStore,
      config: deps.config,
      pipeline: deps.pipeline,
    }),
  );
  app.use('/api', createDictionaryRouter({ repository: deps.repository }));
  app.use(
    '/api',
    createAdminRouter({ pipeline: deps.pipeline, adminApiKey: deps.config.adminApiKey }),
  );

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
