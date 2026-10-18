// =============================================================================
// ASR 任务编排：submit（提交）-> syncJob（轮询同步）
// -----------------------------------------------------------------------------
// 与 OcrPipeline 的分工：这里不碰数据库；任务状态只在进程内 JobStore
// （重启即丢，与「会话内」口径一致）。
//
// 媒体生命周期（Phase 1.5 本地形态，用户拍板「文件不驻内存」）：
//   路由 memoryStorage 读入内存 -> submit 落盘 data/asr/in/<jobId>/<原名>
//   -> provider.submit 只传路径（sidecar 自行读取，不过 HTTP 传媒体）
//   -> submit 一返回 mediaBuffer 引用即释放；磁盘文件在任务终态
//     （done / failed / expired）后由 removeMedia 清理。
//   JobStore 本身仍只存「任务状态 + 转录结果」，不持有任何媒体。
//
// 错误分流（Phase 1.5 修订版 §4 约束④）：
//   · AsrProviderError（确定性：未就绪/坏文件/超时）-> 映射 HTTP 码抛出
//     （503 / 400 / 504），任务同时落 failed（不留 queued 幽灵）；
//   · 未知异常 -> 保留 Phase 1 防御行为：202 + failed 记录，轮询可见原因。
// =============================================================================

import path from 'node:path';
import { ApiError } from '../http/errors';
import { SERVER_ROOT } from '../config';
import type { AsrProvider, AsrSubmitInput } from './provider';
import { AsrProviderError, PROVIDER_ERROR_STATUS } from './providerError';
import type { AsrJobLookup, AsrJobRecord, AsrJobStore } from './jobStore';
import { normalizeProviderTranscript } from './normalize';
import { removeMedia, saveMedia } from './mediaStore';
import type { AsrJobResponse, AsrSubmitResponse, AsrTranscript } from '../types';

/** 与 config.ts 的 ASR_DATA_DIR 默认值保持一致（index.ts 装配用默认路径）。 */
const DEFAULT_ASR_DATA_DIR = path.resolve(SERVER_ROOT, 'data/asr');

export interface AsrSubmitRequest {
  buffer: Buffer;
  fileName: string;
  mimeType: string;
  language: string | null;
}

export class AsrService {
  private readonly provider: AsrProvider | null;
  private readonly store: AsrJobStore;
  private readonly dataDir: string;

  constructor(provider: AsrProvider | null, store: AsrJobStore, dataDir: string = DEFAULT_ASR_DATA_DIR) {
    this.provider = provider;
    this.store = store;
    this.dataDir = dataDir;
  }

  /**
   * 提交转录任务。
   * provider 未接入 -> 503（与 translate 同口径，绝不造假结果）。
   * 供应商确定性错误（未就绪 / 文件问题 / 超时）-> 503/400/504 抛出。
   * 未知异常 -> 落一条 failed 记录并返回 202，前端轮询一次即可看到失败原因。
   */
  async submit(request: AsrSubmitRequest): Promise<AsrSubmitResponse> {
    if (this.provider === null) {
      throw ApiError.serviceUnavailable('未配置 ASR 供应商，转录服务不可用');
    }

    const record = this.store.create();
    let mediaBuffer: Buffer | null = request.buffer;
    try {
      const filePath = await saveMedia(this.dataDir, record.jobId, request.fileName, mediaBuffer);
      const input: AsrSubmitInput = {
        filePath,
        fileName: request.fileName,
        language: request.language,
        nodeJobId: record.jobId,
      };
      const { providerJobId } = await this.provider.submit(input);
      const updated = this.store.update(record.jobId, { status: 'running', providerJobId });
      return this.toSubmitResponse(updated ?? record);
    } catch (error) {
      if (error instanceof AsrProviderError) {
        const code = `provider_${error.kind}`;
        this.store.update(record.jobId, {
          status: 'failed',
          error: { code, message: error.message },
        });
        await removeMedia(this.dataDir, record.jobId);
        throw new ApiError(PROVIDER_ERROR_STATUS[error.kind], code, error.message);
      }
      const message = error instanceof Error ? error.message : String(error);
      const updated = this.store.update(record.jobId, {
        status: 'failed',
        error: { code: 'submit_failed', message },
      });
      await removeMedia(this.dataDir, record.jobId);
      return this.toSubmitResponse(updated ?? record);
    } finally {
      // 媒体 buffer 用完即释：不进 JobStore、不留任何长生命周期引用
      mediaBuffer = null;
    }
  }

  /**
   * 轮询同步：按需回查供应商，done 时归一化结果并存入 JobStore。
   * 404 = 任务不存在；410 = 任务已过期（TTL 2h，重启同样丢失）。
   * 到达终态（done / failed）时清理该任务的磁盘媒体。
   */
  async syncJob(jobId: string): Promise<AsrJobResponse> {
    const lookup: AsrJobLookup = this.store.lookup(jobId);
    if (lookup.kind === 'missing') {
      throw ApiError.notFound('任务不存在或已过期');
    }
    if (lookup.kind === 'expired') {
      await removeMedia(this.dataDir, jobId);
      throw new ApiError(410, 'job_expired', '任务已过期（转录结果仅在服务端保留 2 小时）');
    }

    const record = lookup.record;
    if (record.status === 'done' || record.status === 'failed') {
      return this.toJobResponse(record);
    }
    if (this.provider === null) {
      // 理论上不可达（submit 时 provider 为 null 会直接 503）；防御性兜底，
      // 同样返回 503 而不是假装任务在跑。
      throw ApiError.serviceUnavailable('未配置 ASR 供应商，转录服务不可用');
    }

    try {
      if (record.providerJobId === null) {
        throw new Error('任务缺少供应商侧 jobId，无法同步');
      }
      const status = await this.provider.getStatus(record.providerJobId);
      if (status.state === 'failed') {
        const updated = this.store.update(record.jobId, {
          status: 'failed',
          error: { code: 'provider_failed', message: status.errorMessage ?? '供应商返回失败' },
        });
        await removeMedia(this.dataDir, record.jobId);
        return this.toJobResponse(updated ?? record);
      }
      if (status.state === 'done') {
        const raw = await this.provider.fetchTranscript(record.providerJobId);
        const { transcript, dropped } = normalizeProviderTranscript(raw);
        if (dropped > 0) {
          process.stderr.write(`[asr] 任务 ${record.jobId} 丢弃 ${dropped} 个缺字段片段\n`);
        }
        const updated = this.store.update(record.jobId, { status: 'done', transcript });
        await removeMedia(this.dataDir, record.jobId);
        return this.toJobResponse(updated ?? record);
      }
      const updated = this.store.update(record.jobId, { status: status.state });
      return this.toJobResponse(updated ?? record);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const updated = this.store.update(record.jobId, {
        status: 'failed',
        error: { code: 'sync_failed', message },
      });
      await removeMedia(this.dataDir, record.jobId);
      return this.toJobResponse(updated ?? record);
    }
  }

  private toSubmitResponse(record: AsrJobRecord): AsrSubmitResponse {
    return { jobId: record.jobId, status: record.status, error: record.error };
  }

  private toJobResponse(record: AsrJobRecord): AsrJobResponse {
    const transcript: AsrTranscript | null =
      record.status === 'done' && record.transcript !== null ? record.transcript : null;
    return { jobId: record.jobId, status: record.status, transcript, error: record.error };
  }
}
