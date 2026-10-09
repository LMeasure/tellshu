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
  storageDir: string;
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

function parseTimeout(raw: string | null): number {
  const fallback = 30_000;
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1_000 || value > 300_000) return fallback;
  return value;
}

export function loadConfig(): AppConfig {
  const storageDirInput = optional('OCR_STORAGE_DIR') ?? 'data/ocr';
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
    storageDir: path.isAbsolute(storageDirInput)
      ? storageDirInput
      : path.resolve(SERVER_ROOT, storageDirInput),
  };
}
