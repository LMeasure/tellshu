// =============================================================================
// 进程入口：装配依赖 -> createApp -> listen -> 优雅退出
//
// 路由总表（全部挂在 /api 下）：
//   GET  /api/health
//   POST /api/ocr/material                  素材识别（可选开放，受 OCR_PUBLIC_ENABLED 控制）
//   GET  /api/ocr/jobs/:scanId              单个任务轮询 / 结果
//   POST /api/translate                     在线翻译（未配置时 503）
//   POST /api/asr/jobs                      音视频转字幕提交（未配置供应商时 503）
//   GET  /api/asr/jobs/:jobId               字幕任务轮询 / 结果（410 = 已过期）
//   GET  /api/convert/health                格式转换服务健康（含 engineEnabled）
//   POST /api/convert/files/upload           上传源文件（落盘）
//   POST /api/convert/tasks                  创建转换任务（引擎未接入时 503）
//   GET  /api/convert/tasks/:taskId          轮询任务状态
//   GET  /api/convert/files/:fileId/download 下载结果（仅 success 且有 resultFileId）
//   GET  /api/sync/dictionary?since=&limit= 增量同步
//   GET  /api/search?q=&limit=              词典检索
//   POST /api/admin/dictionary/scans        管理端批量上传（Bearer ADMIN_API_KEY）
//   GET  /api/admin/dictionary/batches/:id  批量任务状态
// =============================================================================

import { createApp } from './app';
import { loadConfig } from './config';
import { createPool } from './db/pool';
import { DictionaryRepository } from './db/repository';
import { ConvertStore } from './db/convertStore';
import { AsrJobStore } from './asr/jobStore';
import { resolveAsrProvider } from './asr/provider';
import { AsrService } from './asr/service';
import { OcrPipeline } from './ocr/pipeline';
import { ensureStorageDir } from './ocr/storage';
import { PaddleOcrClient } from './paddle/client';
import { ASR_JOB_TTL_MS } from './types';

// ---------------------------------------------------------------------------
// 结果文件 TTL 自动清理：安全拼图最后一块（默认引擎关，无实际文件；启用后自动回收）
//   默认保留 1 小时、每 10 分钟扫描一次；两个值均可经环境变量配置。
// ---------------------------------------------------------------------------
const DEFAULT_CONVERT_TTL_MS = 3_600_000; // 1 小时
const DEFAULT_CONVERT_CLEANUP_INTERVAL_MS = 600_000; // 10 分钟
const MIN_CONVERT_TTL_MS = 60_000; // 下限 1 分钟，避免误配导致疯狂清理
const MIN_CONVERT_CLEANUP_INTERVAL_MS = 30_000; // 下限 30 秒

/** 解析整数型环境变量，越界（NaN / 负数 / 过小）回退默认值，不锁死服务。 */
function resolveCleanupIntEnv(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return Math.floor(parsed);
}

/**
 * 启动结果文件 TTL 清理定时器。返回 timer 句柄（供优雅关闭 clearInterval）。
 * 每次扫描后记 info 级日志（即便清理 0 条也记，证明定时器在跑），异常只记 stderr 不退出。
 */
function startConvertCleanup(store: ConvertStore): ReturnType<typeof setInterval> {
  const ttlMs = resolveCleanupIntEnv('CONVERT_RESULT_TTL_MS', DEFAULT_CONVERT_TTL_MS, MIN_CONVERT_TTL_MS);
  const intervalMs = resolveCleanupIntEnv(
    'CONVERT_CLEANUP_INTERVAL_MS',
    DEFAULT_CONVERT_CLEANUP_INTERVAL_MS,
    MIN_CONVERT_CLEANUP_INTERVAL_MS,
  );
  const tick = async (): Promise<void> => {
    try {
      const { deletedFiles, deletedTasks } = await store.cleanupExpiredResultFiles(ttlMs);
      process.stdout.write(`[convert-cleanup] deleted ${deletedFiles} files across ${deletedTasks} tasks\n`);
    } catch (err: unknown) {
      process.stderr.write(`[convert-cleanup] 清理异常（下个周期重试）：${String(err)}\n`);
    }
  };
  // 启动后立即跑一次（清掉部署前已过期文件），之后按间隔轮询
  void tick();
  return setInterval(tick, intervalMs);
}

async function main(): Promise<void> {
  const config = loadConfig();
  await ensureStorageDir(config.storageDir);
  await ensureStorageDir(config.convert.storageDir);

  const pool = createPool({ connectionString: config.databaseUrl });
  const repository = new DictionaryRepository(pool);
  const convertStore = new ConvertStore(pool);
  const paddle = new PaddleOcrClient({
    baseUrl: config.paddle.baseUrl,
    accessToken: config.paddle.accessToken,
    timeoutMs: config.paddle.timeoutMs,
    model: config.paddle.model,
  });
  const pipeline = new OcrPipeline(paddle, repository, config.storageDir);

  // ASR：provider 未接入时 resolveAsrProvider 返回 null，
  // 任务路由对该情况如实返回 503（不返回假字幕）。
  // 本地形态下 provider 构造时会自行 spawn sidecar 子进程（health 门控），
  // 这里的 dataDir 显式传入（与 sidecar 的 in/out 目录约定同根）。
  const asrProvider = resolveAsrProvider(config.asr);
  const asrService = new AsrService(
    asrProvider,
    new AsrJobStore({ ttlMs: ASR_JOB_TTL_MS }),
    config.asr.dataDir,
  );

  const app = createApp({ config, repository, pipeline, asr: asrService, convertStore });

  // 结果文件 TTL 自动清理定时器（默认引擎关，无实际文件；启用后自动回收过期结果）
  const cleanupTimer = startConvertCleanup(convertStore);

  const server = app.listen(config.port, () => {
    process.stdout.write(`[shutree-server] 监听 http://127.0.0.1:${config.port}/api\n`);
    process.stdout.write(`[shutree-server] 图片存储目录：${config.storageDir}\n`);
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(`[shutree-server] 收到 ${signal}，正在关闭…\n`);
    // 先停定时器，避免关闭期间再触发清理
    if (cleanupTimer !== null) {
      clearInterval(cleanupTimer);
    }
    // ASR sidecar 是 Node spawn 的子进程：Node 退出必须带走它，
    // 否则残留进程占着 8177 端口与约 0.5GB 内存，下次启动 health 门控必失败
    void Promise.resolve(asrProvider?.close?.())
      .catch((error: unknown) => {
        process.stderr.write(`[shutree-server] 关闭 ASR sidecar 失败：${String(error)}\n`);
      })
      .finally(() => {
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
