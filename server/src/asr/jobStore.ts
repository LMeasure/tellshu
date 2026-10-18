// =============================================================================
// ASR 任务存储（进程内内存，不落库）
// -----------------------------------------------------------------------------
// Phase 1 约束（用户拍板）：
//   · 只保存「任务状态 + 转录结果」——**绝不保存原始媒体文件**，
//     媒体 buffer 只在 provider.submit 调用期间存活，用完即释放；
//   · 不新增任何表（PG / Dexie 均不建），进程重启即全部丢失，
//     与「会话内」口径一致；
//   · TTL 过期后区分两种查询结果：
//       - 从未存在过        -> 404
//       - 存在过但已过期    -> 410（墓碑保留一个 TTL，之后自然降解为 404）
// =============================================================================

import { randomUUID } from 'node:crypto';
import type { AsrJobError, AsrJobStatus, AsrTranscript } from '../types';

export interface AsrJobRecord {
  jobId: string;
  status: AsrJobStatus;
  /** 供应商侧 jobId（任务状态的一部分，用于 syncJob 回查） */
  providerJobId: string | null;
  /** done 时的归一化转录结果；未完成为 null */
  transcript: AsrTranscript | null;
  error: AsrJobError | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

export type AsrJobLookup =
  | { kind: 'found'; record: AsrJobRecord }
  | { kind: 'expired' }
  | { kind: 'missing' };

export interface AsrJobStoreOptions {
  /** 任务存活时长（毫秒） */
  ttlMs: number;
}

export class AsrJobStore {
  private readonly jobs = new Map<string, AsrJobRecord>();
  /** 过期任务墓碑：jobId -> 墓碑过期时间（再用一个 TTL 后降解为 404） */
  private readonly tombstones = new Map<string, number>();
  private readonly ttlMs: number;

  constructor(options: AsrJobStoreOptions) {
    this.ttlMs = options.ttlMs;
  }

  /** 新建任务（status='queued'）。nowMs 可注入以便单测控制时间。 */
  create(nowMs: number = Date.now()): AsrJobRecord {
    const now = nowMs;
    const record: AsrJobRecord = {
      jobId: randomUUID(),
      status: 'queued',
      providerJobId: null,
      transcript: null,
      error: null,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + this.ttlMs,
    };
    this.jobs.set(record.jobId, record);
    return record;
  }

  /**
   * 查询任务。先做 lazy sweep 再把过期任务移入墓碑，
   * 从而区分 404（从未存在）与 410（存在过但已过期）。
   */
  lookup(jobId: string, nowMs: number = Date.now()): AsrJobLookup {
    this.sweep(nowMs);
    const record = this.jobs.get(jobId);
    if (record !== undefined) return { kind: 'found', record };
    if (this.tombstones.has(jobId)) return { kind: 'expired' };
    return { kind: 'missing' };
  }

  /** 局部更新任务字段。 */
  update(jobId: string, patch: Partial<Omit<AsrJobRecord, 'jobId' | 'createdAt'>>, nowMs: number = Date.now()): AsrJobRecord | null {
    const record = this.jobs.get(jobId);
    if (record === undefined) return null;
    Object.assign(record, patch, { updatedAt: nowMs });
    return record;
  }

  /** 当前存活任务数（探针 / 单测用）。 */
  size(): number {
    return this.jobs.size;
  }

  /** lazy sweep：过期任务移入墓碑，墓碑自身超时后删除。 */
  sweep(nowMs: number = Date.now()): void {
    for (const [jobId, record] of this.jobs) {
      if (record.expiresAt <= nowMs) {
        this.jobs.delete(jobId);
        this.tombstones.set(jobId, nowMs + this.ttlMs);
      }
    }
    for (const [jobId, graveExpiresAt] of this.tombstones) {
      if (graveExpiresAt <= nowMs) this.tombstones.delete(jobId);
    }
  }
}
