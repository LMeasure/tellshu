// =============================================================================
// 进程入口：装配依赖 -> createApp -> listen -> 优雅退出
//
// 路由总表（全部挂在 /api 下）：
//   GET  /api/health
//   POST /api/ocr/material                  素材识别（可选开放，受 OCR_PUBLIC_ENABLED 控制）
//   GET  /api/ocr/jobs/:scanId              单个任务轮询 / 结果
//   POST /api/translate                     在线翻译（未配置时 503）
//   GET  /api/sync/dictionary?since=&limit= 增量同步
//   GET  /api/search?q=&limit=              词典检索
//   POST /api/admin/dictionary/scans        管理端批量上传（Bearer ADMIN_API_KEY）
//   GET  /api/admin/dictionary/batches/:id  批量任务状态
// =============================================================================

import { createApp } from './app';
import { loadConfig } from './config';
import { createPool } from './db/pool';
import { DictionaryRepository } from './db/repository';
import { OcrPipeline } from './ocr/pipeline';
import { ensureStorageDir } from './ocr/storage';
import { PaddleOcrClient } from './paddle/client';

async function main(): Promise<void> {
  const config = loadConfig();
  await ensureStorageDir(config.storageDir);

  const pool = createPool({ connectionString: config.databaseUrl });
  const repository = new DictionaryRepository(pool);
  const paddle = new PaddleOcrClient({
    baseUrl: config.paddle.baseUrl,
    accessToken: config.paddle.accessToken,
    timeoutMs: config.paddle.timeoutMs,
    model: config.paddle.model,
  });
  const pipeline = new OcrPipeline(paddle, repository, config.storageDir);

  const app = createApp({ config, repository, pipeline });

  const server = app.listen(config.port, () => {
    process.stdout.write(`[shutree-server] 监听 http://127.0.0.1:${config.port}/api\n`);
    process.stdout.write(`[shutree-server] 图片存储目录：${config.storageDir}\n`);
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(`[shutree-server] 收到 ${signal}，正在关闭…\n`);
    server.close(() => {
      pool
        .end()
        .then(() => {
          process.stdout.write('[shutree-server] 已关闭\n');
          process.exit(0);
        })
        .catch((error: unknown) => {
          process.stderr.write(`[shutree-server] 关闭连接池失败：${String(error)}\n`);
          process.exit(1);
        });
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[shutree-server] 启动失败：${message}\n`);
  process.exit(1);
});
