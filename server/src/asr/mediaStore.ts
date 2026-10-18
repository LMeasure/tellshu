// =============================================================================
// ASR 媒体中转存储（Phase 1.5 本地形态新增）
// -----------------------------------------------------------------------------
// 生命周期（用户拍板「文件不驻内存」的落地）：
//   路由 memoryStorage 读入内存 -> submit 落盘 data/asr/in/<jobId>/<安全名>
//   -> provider.submit 只把路径传给 sidecar（媒体不经过 HTTP 传输）
//   -> 任务到达终态（done / failed / expired）后 removeMedia 清理该目录。
//
// JobStore 本身仍只存「任务状态 + 转录结果」，不存任何媒体（Phase 1 口径不变）；
// 这里的磁盘文件是转录期间的临时载体，终态即清。
// =============================================================================

import fs from 'node:fs/promises';
import path from 'node:path';

/** 把原始文件名洗成安全单段名（去路径分隔符与控制字符，防穿越）。 */
export function safeMediaName(fileName: string): string {
  const base = path.basename(fileName.replace(/\\/g, '/')).trim();
  const cleaned = base.replace(/[\u0000-\u001f<>:"|?*]/g, '_');
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? 'media' : cleaned;
}

/** 任务媒体目录：<dataDir>/in/<jobId>/。 */
export function mediaJobDir(dataDir: string, jobId: string): string {
  return path.join(dataDir, 'in', jobId);
}

/**
 * 落盘媒体，返回绝对路径。目录不存在则创建；同名覆盖（jobId 唯一，不会撞）。
 */
export async function saveMedia(dataDir: string, jobId: string, fileName: string, buffer: Buffer): Promise<string> {
  const dir = mediaJobDir(dataDir, jobId);
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, safeMediaName(fileName));
  await fs.writeFile(target, buffer);
  return target;
}

/** 清理任务媒体目录（幂等：不存在也当成功；权限失败只记日志不抛出）。 */
export async function removeMedia(dataDir: string, jobId: string): Promise<void> {
  const dir = mediaJobDir(dataDir, jobId);
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch (error) {
    process.stderr.write(`[asr] 清理媒体目录失败 ${dir}：${String(error)}\n`);
  }
}
