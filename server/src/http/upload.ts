// =============================================================================
// multer 上传配置：memoryStorage（不落临时文件），MIME / 扩展名 / 体积 / 数量校验
// =============================================================================

import path from 'node:path';
import type { Request } from 'express';
import multer from 'multer';
import { ALLOWED_IMAGE_EXTENSIONS, isAllowedMime } from '../ocr/storage';
import { ApiError } from './errors';
import { PADDLE_MAX_FILE_BYTES, SERVER_MAX_BATCH_FILES } from '../types';

export const IMAGE_FIELD = 'images';

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
