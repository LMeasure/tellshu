// =============================================================================
// OCR 原始图片落盘
//
// · 文件名由 crypto 随机生成，绝不沿用客户端提供的文件名（防目录穿越 / 覆盖）
// · 数据库只保存相对 OCR_STORAGE_DIR 的路径（POSIX 分隔符）
// =============================================================================

import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { StoredImage } from '../types';

export const ALLOWED_IMAGE_TYPES: Readonly<Record<string, string>> = Object.freeze({
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/tiff': '.tiff',
});

export const ALLOWED_IMAGE_EXTENSIONS: readonly string[] = ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tiff', '.tif'];

export interface IncomingImage {
  buffer: Buffer;
  originalName: string;
  mimeType: string;
}

export function extensionForMime(mimeType: string): string | null {
  return ALLOWED_IMAGE_TYPES[mimeType] ?? null;
}

export function isAllowedMime(mimeType: string): boolean {
  return extensionForMime(mimeType) !== null;
}

export async function ensureStorageDir(storageDir: string): Promise<void> {
  await mkdir(storageDir, { recursive: true });
}

/** 把一张图片写入存储目录，返回相对路径等元信息。 */
export async function saveImage(storageDir: string, image: IncomingImage): Promise<StoredImage> {
  const extension = extensionForMime(image.mimeType);
  if (extension === null) {
    throw new Error(`不支持的图片类型：${image.mimeType}`);
  }

  const now = new Date();
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const fileName = `${randomBytes(24).toString('hex')}${extension}`;
  const relativePath = `${year}/${month}/${fileName}`;

  const root = path.resolve(storageDir);
  const target = path.resolve(root, year, month, fileName);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error('解析出的存储路径越界，已拒绝写入');
  }

  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, image.buffer);

  return {
    relativePath,
    originalName: image.originalName.slice(0, 255),
    mimeType: image.mimeType,
    sizeBytes: image.buffer.byteLength,
  };
}
