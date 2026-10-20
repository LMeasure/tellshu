// =============================================================================
// 运行时配置：全部来自环境变量（.env），不含任何硬编码密钥。
// 必需项缺失时直接抛错，避免带着半成品配置启动。
// =============================================================================

import path from 'node:path';
import { config as loadDotenv } from 'dotenv';

loadDotenv();

/** server/ 目录（编译后 __dirname 为 dist/src，源码运行时为 src，均上溯两级）。 */
export const SERVER_ROOT = path.resolve(__dirname, '..', '..');

export interface TranslateConfig {
  url: string | null;
  apiKey: string | null;
}

/**
 * ASR 配置（Phase 1.5：本地自建 faster-whisper sidecar）。
 * provider != 'local' 或缺 pythonPath 时转录接口如实 503，绝不返回假字幕。
 *   provider          = 'local' 时装配本地转录（自动 spawn sidecar）
 *   pythonPath        = venv 的 python.exe（asr_service/requirements-asr.txt 安装）
 *   modelDir          = Whisper 模型目录（默认 server/data/asr-models/whisper-small）
 *   sidecarPort       = sidecar 监听端口（默认 8177，仅回环）
 *   sidecarTimeoutMs  = Node → sidecar 单次 HTTP 超时（默认 10s）
 *   sidecarLoadMs     = sidecar 启动 + 模型加载的 health 门控宽限（默认 60s）
 *   dataDir           = 媒体中转目录（in/<jobId>/ 由 Node 写、终态清理）
 *   debugSaveRaw      = debug：保存 sidecar 原始响应（默认 false，绝不进 Transcript）
 */
export interface AsrProviderConfig {
  provider: string | null;
  pythonPath: string | null;
  modelDir: string | null;
  sidecarPort: number;
  sidecarTimeoutMs: number;
  sidecarLoadMs: number;
  dataDir: string;
  debugSaveRaw: boolean;
}

/** 格式转换：引擎开关（默认关，关时任务接口如实 503）；存储目录独立于 OCR。 */
export interface ConvertConfig {
  engineEnabled: boolean;
  storageDir: string;
}

/**
 * AI 学习稿生成（Phase 2 M2：OpenAI 兼容云端 LLM，SSE 流式）。
 * 未配置时接口如实 503「AI 服务未接入」，服务器正常启动、不崩。
 *   baseUrl            完整端点或基址都接受：已含 /chat/completions 则原样用，
 *                       否则自动拼 /chat/completions
 *   apiKey / model     凭据与模型名（只在 .env，不进日志/前端）
 *   firstTokenMs       首 token 超时（防上游卡死，默认 30000）
 *   streamMs           总流式超时（防生成过长，默认 120000）
 *   maxSegments        单次请求允许的最大段数（防超大 transcript，默认 1200）
 */
export interface AiConfig {
  baseUrl: string | null;
  apiKey: string | null;
  model: string | null;
  firstTokenMs: number;
  streamMs: number;
  maxSegments: number;
}

export interface AppConfig {
  port: number;
  databaseUrl: string;
  paddle: {
    baseUrl: string;
    accessToken: string;
    timeoutMs: number;
    model: string;
  };
  adminApiKey: string;
  corsOrigins: string[];
  ocrPublicEnabled: boolean;
  translate: TranslateConfig;
  asr: AsrProviderConfig;
  storageDir: string;
  convert: ConvertConfig;
  ai: AiConfig;
}

function required(name: string): string {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    throw new Error(`缺少必需的环境变量 ${name}；请复制 server/.env.example 为 server/.env 后填写`);
  }
  return raw.trim();
}

function optional(name: string): string | null {
  const raw = process.env[name];
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

function parsePort(raw: string | null): number {
  if (raw === null) return 8787;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > 65535) {
    throw new Error(`PORT 不是合法端口：${raw}`);
  }
  return value;
}

function parseBool(raw: string | null): boolean {
  if (raw === null) return false;
  return ['1', 'true', 'yes', 'on', 'enable', 'enabled'].includes(raw.toLowerCase());
}

function parseOrigins(raw: string | null): string[] {
  if (raw === null) return [];
  const seen = new Set<string>();
  for (const item of raw.split(',')) {
    const trimmed = item.trim().replace(/\/+$/, '');
    if (trimmed !== '') seen.add(trimmed);
  }
  return [...seen];
}

function parseTimeout(raw: string | null, fallback = 30_000): number {
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1_000 || value > 300_000) return fallback;
  return value;
}

/** AI_MAX_SEGMENTS：单次请求最大段数，越界回退默认 1200（与 parseTimeout 同风格）。 */
function parseMaxSegments(raw: string | null): number {
  if (raw === null) return 1_200;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 5_000) return 1_200;
  return value;
}

function parseSidecarPort(raw: string | null): number {
  if (raw === null) return 8177;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > 65535) {
    throw new Error(`ASR_SIDECAR_PORT 不是合法端口：${raw}`);
  }
  return value;
}

export function loadConfig(): AppConfig {
  const storageDirInput = optional('OCR_STORAGE_DIR') ?? 'data/ocr';
  const convertStorageDirInput = optional('CONVERT_STORAGE_DIR') ?? 'data/convert';
  const asrDataDirInput = optional('ASR_DATA_DIR') ?? 'data/asr';
  const asrPythonInput = optional('ASR_PYTHON_PATH');
  const asrModelDirInput = optional('ASR_MODEL_DIR');
  return {
    port: parsePort(optional('PORT')),
    databaseUrl: required('DATABASE_URL'),
    paddle: {
      baseUrl: optional('PADDLEOCR_API_BASE_URL') ?? 'https://paddleocr.aistudio-app.com/api/v2/ocr/jobs',
      accessToken: required('PADDLEOCR_ACCESS_TOKEN'),
      timeoutMs: parseTimeout(optional('PADDLEOCR_TIMEOUT_MS')),
      model: optional('PADDLEOCR_MODEL') ?? 'PP-StructureV3',
    },
    adminApiKey: required('ADMIN_API_KEY'),
    corsOrigins: parseOrigins(optional('CORS_ORIGIN')),
    ocrPublicEnabled: parseBool(optional('OCR_PUBLIC_ENABLED')),
    translate: {
      url: optional('TRANSLATE_API_URL'),
      apiKey: optional('TRANSLATE_API_KEY'),
    },
    asr: {
      provider: optional('ASR_PROVIDER'),
      // 相对路径按 server/ 根解析（.env.example 的 asr_service/venv/... 即此口径）
      pythonPath:
        asrPythonInput === null
          ? null
          : path.isAbsolute(asrPythonInput)
            ? asrPythonInput
            : path.resolve(SERVER_ROOT, asrPythonInput),
      modelDir:
        asrModelDirInput === null
          ? null
          : path.isAbsolute(asrModelDirInput)
            ? asrModelDirInput
            : path.resolve(SERVER_ROOT, asrModelDirInput),
      sidecarPort: parseSidecarPort(optional('ASR_SIDECAR_PORT')),
      sidecarTimeoutMs: parseTimeout(optional('ASR_SIDECAR_TIMEOUT_MS'), 10_000),
      sidecarLoadMs: parseTimeout(optional('ASR_SIDECAR_LOAD_TIMEOUT_MS'), 60_000),
      dataDir: path.isAbsolute(asrDataDirInput)
        ? asrDataDirInput
        : path.resolve(SERVER_ROOT, asrDataDirInput),
      debugSaveRaw: parseBool(optional('ASR_DEBUG_SAVE_RAW')),
    },
    storageDir: path.isAbsolute(storageDirInput)
      ? storageDirInput
      : path.resolve(SERVER_ROOT, storageDirInput),
    convert: {
      engineEnabled: parseBool(optional('CONVERT_ENGINE_ENABLED')),
      storageDir: path.isAbsolute(convertStorageDirInput)
        ? convertStorageDirInput
        : path.resolve(SERVER_ROOT, convertStorageDirInput),
    },
    ai: {
      // 三项齐备才启用；任一缺失 → 路由层如实 503「AI 服务未接入」，
      // 服务器正常启动、不崩（与 translate / asr 同构）
      baseUrl: optional('AI_BASE_URL'),
      apiKey: optional('AI_API_KEY'),
      model: optional('AI_MODEL'),
      firstTokenMs: parseTimeout(optional('AI_FIRST_TOKEN_TIMEOUT_MS'), 30_000),
      streamMs: parseTimeout(optional('AI_STREAM_TIMEOUT_MS'), 120_000),
      maxSegments: parseMaxSegments(optional('AI_MAX_SEGMENTS')),
    },
  };
}
