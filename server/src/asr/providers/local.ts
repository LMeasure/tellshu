// =============================================================================
// 本地 ASR provider：与 faster-whisper sidecar（server/asr_service/）对话
// -----------------------------------------------------------------------------
// 形态（Phase 1.5 修订版 §3）：
//   submit         POST /transcribe   {path, job_id, language} -> 202（毫秒级入队）
//   getStatus      GET  /jobs/{id}     queued/running/done/failed
//   fetchTranscript GET /jobs/{id}     取 canonical {language,duration,segments}
//
// 错误映射（sidecar HTTP 状态 -> AsrProviderError.kind，service 再映射 ApiError）：
//   503 SIDECAR_BUSY         -> unavailable（队列满 / 服务未就绪）
//   410 INPUT_FILE_GONE      -> bad_file（输入文件没了）
//   415 UNSUPPORTED_MEDIA    -> bad_file（容器不在白名单）
//   400 EMPTY/DECODE/LANG    -> bad_file（空文件 / 解码失败 / 语言非法）
//   网络错误 / AbortError     -> unavailable / timeout
// 单次 HTTP 超时走 config.sidecarTimeoutMs（默认 10s）；sidecar 是自有进程，
// 超时即故障，不重试（重试会让同一个 job 在 sidecar 重复入队）。
// =============================================================================

import fs from 'node:fs/promises';
import path from 'node:path';
import type { AsrProviderConfig } from '../../config';
import { AsrProviderError } from '../providerError';
import { redactSecrets } from '../providerError';
import type { AsrProvider, AsrProviderJobState, AsrSubmitInput, AsrProviderTranscript } from '../provider';
import { SidecarProcess } from '../sidecar';

export interface LocalProviderDeps {
  /** 注入已构造的 sidecar 句柄（测试 / 外部托管场景） */
  sidecar?: SidecarProcess;
  fetchImpl?: typeof fetch;
}

/** sidecar 合同响应（宽松形态，字段逐个校验）。 */
interface SidecarJobBody {
  job_id?: unknown;
  status?: unknown;
  transcript?: unknown;
  error?: unknown;
}

export class LocalAsrProvider implements AsrProvider {
  readonly name = 'local';

  private readonly config: AsrProviderConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly sidecar: SidecarProcess;
  private readonly ownsSidecar: boolean;

  constructor(config: AsrProviderConfig, deps: LocalProviderDeps = {}) {
    this.config = config;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    if (deps.sidecar !== undefined) {
      // 外部托管：生命周期归注入方（测试不启动真实进程）
      this.sidecar = deps.sidecar;
      this.ownsSidecar = false;
      return;
    }
    this.sidecar = new SidecarProcess(config, { fetchImpl: this.fetchImpl });
    this.ownsSidecar = true;
    this.sidecar.start();
  }

  async submit(input: AsrSubmitInput): Promise<{ providerJobId: string }> {
    // health 门控：模型加载期（约 2-5s）提交会在此等待，超时/死亡 -> 503
    await this.sidecar.waitReady(this.config.sidecarLoadMs);
    const form = new FormData();
    form.append('path', input.filePath);
    // 两侧同一 id：Node JobStore 与 sidecar 队列用同一个 jobId，便于对账
    form.append('job_id', input.nodeJobId);
    form.append('language', input.language ?? 'auto');
    const response = await this._send('/transcribe', { method: 'POST', body: form }, '提交转录任务');
    const body = (await response.json().catch(() => null)) as SidecarJobBody | null;
    if (response.status === 202 && body !== null && typeof body.job_id === 'string') {
      return { providerJobId: body.job_id };
    }
    throw classifySidecarError(response.status, body, '提交转录任务失败');
  }

  async getStatus(providerJobId: string): Promise<{ state: AsrProviderJobState; errorMessage: string | null }> {
    const response = await this._send(`/jobs/${encodeURIComponent(providerJobId)}`, undefined, '查询转录状态');
    if (response.status === 404) {
      // sidecar 不认这个 id（进程重启过）：如实报失败，不假装还在跑
      return { state: 'failed', errorMessage: '转录任务在识别服务中不存在（服务可能已重启），请重新提交' };
    }
    const body = (await response.json().catch(() => null)) as SidecarJobBody | null;
    if (!response.ok || body === null) {
      throw classifySidecarError(response.status, body, '查询转录状态失败');
    }
    const status = typeof body.status === 'string' ? body.status : '';
    if (status === 'done') return { state: 'done', errorMessage: null };
    if (status === 'failed') {
      return { state: 'failed', errorMessage: typeof body.error === 'string' ? body.error : '识别失败' };
    }
    if (status === 'queued' || status === 'running') return { state: status, errorMessage: null };
    return { state: 'failed', errorMessage: `识别服务返回未知状态：${status === '' ? '(缺失)' : status}` };
  }

  async fetchTranscript(providerJobId: string): Promise<AsrProviderTranscript> {
    const response = await this._send(`/jobs/${encodeURIComponent(providerJobId)}`, undefined, '拉取转录结果');
    const body = (await response.json().catch(() => null)) as SidecarJobBody | null;
    if (!response.ok || body === null) {
      throw classifySidecarError(response.status, body, '拉取转录结果失败');
    }
    if (body.status !== 'done' || body.transcript === undefined || body.transcript === null) {
      throw new AsrProviderError('unknown', '识别结果尚未就绪，无法拉取');
    }
    if (this.config.debugSaveRaw) {
      await this._saveDebugRaw(providerJobId, body);
    }
    // canonical 形态直接交给 normalize.ts 做结构校验与清洗
    return body.transcript;
  }

  async close(): Promise<void> {
    if (this.ownsSidecar) {
      await this.sidecar.close();
    }
  }

  // ---- 内部 ----

  private async _send(urlPath: string, init: RequestInit | undefined, action: string): Promise<Response> {
    try {
      return await this.fetchImpl(`${this.sidecar.baseUrl}${urlPath}`, {
        ...init,
        signal: AbortSignal.timeout(this.config.sidecarTimeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new AsrProviderError('timeout', `${action}超时（${this.config.sidecarTimeoutMs}ms）`);
      }
      if (error instanceof AsrProviderError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new AsrProviderError('unavailable', `${action}失败：${message}`);
    }
  }

  private async _saveDebugRaw(jobId: string, body: SidecarJobBody): Promise<void> {
    try {
      const debugDir = path.join(this.config.dataDir, '..', 'asr-debug');
      await fs.mkdir(debugDir, { recursive: true });
      await fs.writeFile(
        path.join(debugDir, `${jobId}.json`),
        JSON.stringify(redactSecrets(body), null, 2),
        'utf8',
      );
    } catch (error) {
      // debug 落盘失败绝不打断主链路
      process.stderr.write(`[asr] debug 原始响应落盘失败 job=${jobId}：${String(error)}\n`);
    }
  }
}

/** sidecar HTTP 错误 -> kind（不含网络异常，那在 _send 里已收敛）。 */
export function classifySidecarError(status: number, body: SidecarJobBody | null, fallbackMessage: string): AsrProviderError {
  const code = body !== null && typeof (body as { code?: unknown }).code === 'string'
    ? ((body as { code: string }).code)
    : '';
  const message = body !== null && typeof body.error === 'string' && body.error !== ''
    ? body.error
    : `${fallbackMessage}（HTTP ${status}${code !== '' ? ` / ${code}` : ''}）`;
  switch (status) {
    case 503: // SIDECAR_BUSY：队列饱和 / sidecar 未就绪
      return new AsrProviderError('unavailable', message);
    case 410: // INPUT_FILE_GONE
    case 415: // UNSUPPORTED_MEDIA_TYPE
    case 400: // EMPTY_FILE / AUDIO_DECODE_ERROR / INVALID_LANGUAGE
      return new AsrProviderError('bad_file', message);
    default:
      return new AsrProviderError('unknown', message);
  }
}
