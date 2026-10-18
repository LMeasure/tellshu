// =============================================================================
// multer 上传配置：memoryStorage（不落临时文件），MIME / 扩展名 / 体积 / 数量校验
// =============================================================================

import path from 'node:path';
import type { Request } from 'express';
import multer from 'multer';
import { ALLOWED_IMAGE_EXTENSIONS, isAllowedMime } from '../ocr/storage';
import { ApiError } from './errors';
import { ASR_MAX_FILE_BYTES, PADDLE_MAX_FILE_BYTES, SERVER_MAX_BATCH_FILES } from '../types';

export const IMAGE_FIELD = 'images';

/** 音视频上传字段名（Phase 1 音视频转字幕）。 */
export const MEDIA_FIELD = 'media';

/** 音视频扩展名白名单（与前端 domain/transcript/validate.ts 保持一致）。 */
export const ALLOWED_MEDIA_EXTENSIONS: readonly string[] = ['.mp3', '.wav', '.m4a', '.mp4', '.mov', '.webm'];

/** MIME 前缀白名单：audio/* 与 video/*。 */
export function isAllowedMediaMime(mimeType: string): boolean {
  return mimeType.startsWith('audio/') || mimeType.startsWith('video/');
}

export function isAllowedMediaExtension(extension: string): boolean {
  return ALLOWED_MEDIA_EXTENSIONS.includes(extension.toLowerCase());
}

/**
 * 音视频上传（memoryStorage，不落临时文件）。
 * 校验口径与图片一致：MIME 非空时须为 audio|video，扩展名非空时须在白名单；
 * 两者都为空（客户端没给任何类型信息）时拒绝 —— 宁可错杀不放过。
 */
export function createMediaUpload(maxBytes: number = ASR_MAX_FILE_BYTES): multer.Multer {
  return multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: maxBytes,
      files: 1,
      fields: 10,
      parts: 20,
    },
    fileFilter: (_req, file, callback) => {
      const extension = path.extname(file.originalname).toLowerCase();
      const mimeOk = file.mimetype === '' || isAllowedMediaMime(file.mimetype);
      const extOk = extension === '' || isAllowedMediaExtension(extension);
      if (!mimeOk || !extOk || (file.mimetype === '' && extension === '')) {
        callback(ApiError.badRequest('不支持的媒体文件：仅支持 mp3 / wav / m4a / mp4 / mov / webm'));
        return;
      }
      callback(null, true);
    },
  });
}

export function createImageUpload(maxFiles: number = SERVER_MAX_BATCH_FILES): multer.Multer {
  return multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: PADDLE_MAX_FILE_BYTES,
      files: maxFiles,
      fields: 20,
      parts: maxFiles + 20,
    },
    fileFilter: (_req, file, callback) => {
      if (!isAllowedMime(file.mimetype)) {
        callback(ApiError.badRequest(`不支持的图片类型：${file.mimetype}`));
        return;
      }
      const extension = path.extname(file.originalname).toLowerCase();
      if (extension !== '' && !ALLOWED_IMAGE_EXTENSIONS.includes(extension)) {
        callback(ApiError.badRequest(`不支持的文件扩展名：${extension}`));
        return;
      }
      callback(null, true);
    },
  });
}

/** 把 multer 的 files 统一成数组。 */
export function filesOf(req: Request): Express.Multer.File[] {
  const files = req.files;
  if (Array.isArray(files)) return files;
  if (typeof files === 'object' && files !== null) {
    return Object.values(files).flat();
  }
  return [];
}

/** upload.single() 场景读取唯一文件（音视频上传用）；没有则返回 null。 */
export function mediaFileOf(req: Request): Express.Multer.File | null {
  const file = req.file;
  return file === undefined ? null : file;
}

/** 校验体积并转换成 pipeline 需要的结构。 */
export function toIncomingImages(files: readonly Express.Multer.File[]): Array<{
  buffer: Buffer;
  originalName: string;
  mimeType: string;
}> {
  return files.map((file) => {
    if (file.size > PADDLE_MAX_FILE_BYTES) {
      throw ApiError.payloadTooLarge(`文件 ${file.originalname} 超过 50MB 上限`);
    }
    return {
      buffer: file.buffer,
      originalName: file.originalname,
      mimeType: file.mimetype,
    };
  });
}
