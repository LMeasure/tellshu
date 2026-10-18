// =============================================================================
// 格式转换·持久化（复用现有 pg 连接池；不新增连接）
// 文件名只用 uuid，原文件名仅入库展示，绝不以原文件名写盘（防路径穿越）。
// =============================================================================
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import * as nodeFs from 'node:fs/promises';
import type { ConvertFormat, ConvertTaskStatus } from '../types';

/** 仅暴露 unlink 的最小文件系统接口，便于单测注入 mock（无需真实磁盘）。 */
export interface FsUnlink {
  unlink(path: string): Promise<void>;
}

export class ConvertStore {
  constructor(private readonly pool: Pool) {}

  /**
   * 登记源文件元数据，返回 fileId 与完整存储路径（按 id 命名）。
   * 调用方负责把 bytes 写到 storagePath。
   */
  async createFile(input: {
    originalName: string;
    format: ConvertFormat;
    mimeType: string;
    sizeBytes: number;
    storageDir: string;
  }): Promise<{ fileId: string; storagePath: string }> {
    const fileId = randomUUID();
    const storagePath = `${input.storageDir}/${fileId}`;
    await this.pool.query(
      `INSERT INTO convert_files (id, original_name, format, mime_type, size_bytes, storage_path)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [fileId, input.originalName, input.format, input.mimeType, input.sizeBytes, storagePath],
    );
    return { fileId, storagePath };
  }

  /** 取源文件的存储路径（worker 读取源、写结果用） */
  async getFilePath(fileId: string): Promise<string | null> {
    const res = await this.pool.query('SELECT storage_path FROM convert_files WHERE id = $1', [fileId]);
    return res.rowCount === 0 ? null : (res.rows[0]['storage_path'] as string);
  }

  /** 取结果文件的下载信息（路径 + 原名 + MIME） */
  async getFile(fileId: string): Promise<{ storagePath: string; originalName: string; mimeType: string } | null> {
    const res = await this.pool.query(
      'SELECT storage_path, original_name, mime_type FROM convert_files WHERE id = $1',
      [fileId],
    );
    if (res.rowCount === 0) return null;
    const row = res.rows[0];
    return {
      storagePath: row['storage_path'] as string,
      originalName: row['original_name'] as string,
      mimeType: row['mime_type'] as string,
    };
  }

  /** 源文件的格式（创建任务时校验合法性用） */
  async getFileSourceFormat(fileId: string): Promise<ConvertFormat | null> {
    const res = await this.pool.query('SELECT format FROM convert_files WHERE id = $1', [fileId]);
    return res.rowCount === 0 ? null : (res.rows[0]['format'] as ConvertFormat);
  }

  async createTask(input: {
    fileId: string;
    sourceFormat: ConvertFormat;
    targetFormat: ConvertFormat;
  }): Promise<string> {
    const taskId = randomUUID();
    await this.pool.query(
      `INSERT INTO convert_tasks (id, file_id, source_format, target_format, status, progress)
       VALUES ($1, $2, $3, $4, 'waiting', 0)`,
      [taskId, input.fileId, input.sourceFormat, input.targetFormat],
    );
    return taskId;
  }

  async getTask(taskId: string): Promise<{
    status: ConvertTaskStatus;
    progress: number;
    sourceFormat: ConvertFormat | null;
    targetFormat: ConvertFormat | null;
    errorMessage: string | null;
    resultFileId: string | null;
  } | null> {
    const res = await this.pool.query(
      `SELECT status, progress, source_format, target_format, error_message, result_file_id
       FROM convert_tasks WHERE id = $1`,
      [taskId],
    );
    if (res.rowCount === 0) return null;
    const row = res.rows[0];
    return {
      status: row['status'] as ConvertTaskStatus,
      progress: Number(row['progress']),
      sourceFormat: row['source_format'] as ConvertFormat | null,
      targetFormat: row['target_format'] as ConvertFormat | null,
      errorMessage: (row['error_message'] as string | null) ?? null,
      resultFileId: (row['result_file_id'] as string | null) ?? null,
    };
  }

  /**
   * 取任务状态 + 目标格式 + 全部结果文件 id（result_files jsonb 数组）。
   * 用于「打包下载(ZIP)」与「OCR 成文章」：两者都需要遍历所有结果文件。
   * result_files 为空 / 非数组时返回空数组（不抛错，由调用方按场景判空）。
   */
  async getTaskResultFiles(taskId: string): Promise<{
    status: ConvertTaskStatus;
    targetFormat: ConvertFormat | null;
    resultFileIds: string[];
  } | null> {
    const res = await this.pool.query(
      `SELECT status, target_format, result_files
       FROM convert_tasks WHERE id = $1`,
      [taskId],
    );
    if (res.rowCount === 0) return null;
    const row = res.rows[0];
    const raw = row['result_files'];
    const ids: string[] = Array.isArray(raw)
      ? raw.filter((x: unknown): x is string => typeof x === 'string')
      : [];
    return {
      status: row['status'] as ConvertTaskStatus,
      targetFormat: (row['target_format'] as ConvertFormat | null) ?? null,
      resultFileIds: ids,
    };
  }

  /**
   * 清理过期的「已完成」转换结果文件（安全拼图最后一块）。
   *
   * 逻辑：
   *  1) 选出 status='success' 且 created_at 早于 now-ttlMs 的任务
   *     （注意：schema 真实枚举是 'success'，不是 "completed"；
   *      状态类型见 types.ts 的 ConvertTaskStatus）；
   *  2) 对每条任务的 result_files（jsonb 数组，存的是 convert_files.id）
   *     逐个查出 storage_path 并删除磁盘文件；
   *  3) 将任务的 result_files 字段置空（并清空 result_file_id 主结果指针，
   *     避免留下指向已删文件的悬空引用），但**保留任务记录本身**留审计轨迹；
   *  4) 返回删除的文件数与受影响的任务数。
   *
   * 安全：文件删除用注入的 fsModule（默认 node:fs/promises），
   *  单个文件删除失败不中断（catch + 计入失败并告警）；
   *  文件已不存在（ENOENT）视为已被其他途径清理，静默跳过、不计入失败。
   *  fsModule 可注入以便单测（mock fs，不碰真实磁盘）。
   */
  async cleanupExpiredResultFiles(
    ttlMs: number,
    fsModule: FsUnlink = nodeFs,
  ): Promise<{ deletedFiles: number; deletedTasks: number }> {
    // 1) 仅筛 success（非 success 的 waiting/processing/failed 一律不受影响）
    const listRes = await this.pool.query(
      `SELECT id, result_files
       FROM convert_tasks
       WHERE status = 'success'
         AND created_at < now() - ($1::bigint / 1000.0) * INTERVAL '1 second'`,
      [ttlMs],
    );

    let deletedFiles = 0;
    let deletedTasks = 0;
    let failedFiles = 0;

    for (const row of listRes.rows) {
      const taskId = row['id'] as string;
      const raw = row['result_files'];
      const fileIds: string[] = Array.isArray(raw)
        ? raw.filter((x: unknown): x is string => typeof x === 'string')
        : [];

      for (const fileId of fileIds) {
        const pathRes = await this.pool.query(
          'SELECT storage_path FROM convert_files WHERE id = $1',
          [fileId],
        );
        if (pathRes.rowCount === 0) continue; // 文件记录已不在，跳过
        const storagePath = pathRes.rows[0]['storage_path'] as string;
        try {
          await fsModule.unlink(storagePath);
          deletedFiles += 1;
        } catch (err: unknown) {
          // ENOENT：文件可能已被 Worker / 其他清理途径删除，静默跳过
          if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') {
            continue;
          }
          // 其它错误（权限 / 磁盘故障等）：记录但不中断其余文件与任务
          failedFiles += 1;
          process.stderr.write(`[convert-cleanup] 删除结果文件失败 ${storagePath}: ${String(err)}\n`);
        }
      }

      // 3) 清空该任务的 result_files（及主结果引用），保留任务记录
      await this.pool.query(
        `UPDATE convert_tasks SET result_files = '[]'::jsonb, result_file_id = NULL WHERE id = $1`,
        [taskId],
      );
      deletedTasks += 1;
    }

    if (failedFiles > 0) {
      process.stderr.write(`[convert-cleanup] 有 ${failedFiles} 个结果文件删除失败（已跳过，下个周期重试）\n`);
    }
    return { deletedFiles, deletedTasks };
  }
}
