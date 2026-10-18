// =============================================================================
// ASR 供应商适配层（provider seam）
// -----------------------------------------------------------------------------
// Phase 1 只做接缝：接口 + 配置解析入口，不绑定任何供应商。
// Phase 1.5：本地自建（faster-whisper sidecar，providers/local.ts）。
//
// 接入新供应商的固定姿势（上层零改动）：
//   1. 在 providers/ 下实现 AsrProvider（错误分类 -> providerError.ts；
//      响应归一化 -> normalize.ts 加形态）；
//   2. 在下面 resolveAsrProvider 的 switch 里加一个 case。
//
// 本地形态的媒体生命周期（Phase 1.5 用户拍板）：
//   路由 memoryStorage 读入内存 -> service.submit 落盘 data/asr/in/<jobId>/
//   -> provider.submit 只传**路径**（sidecar 自行读取，媒体不驻 HTTP 通道）
//   -> 任务终态（done/failed/expired）后由 service 清理该目录。
//
// 未接入 / 配置不齐时 resolveAsrProvider 返回 null —— 路由层如实返回 503，
// 绝不返回假字幕（与 translate 未配置时 503 同一口径）。
// =============================================================================

import type { AsrProviderConfig } from '../config';
import { LocalAsrProvider } from './providers/local';

/** 提交给供应商的媒体（本地形态：service 已落盘，本层只传路径）。 */
export interface AsrSubmitInput {
  /** service 落盘后的媒体绝对路径（data/asr/in/<jobId>/<文件名>） */
  filePath: string;
  /** 原始文件名（仅日志 / 排障用，不进 Transcript） */
  fileName: string;
  /** 语言代码或 'auto'；null 按 auto 处理 */
  language: string | null;
  /** Node 侧 JobStore 的任务 id（本地 sidecar 用同一 id，便于对账） */
  nodeJobId: string;
}

export type AsrProviderJobState = 'queued' | 'running' | 'done' | 'failed';

/** 供应商合同的原始转录响应（由 normalize.ts 收敛成 segments）。 */
export type AsrProviderTranscript = unknown;

export interface AsrProvider {
  /** 供应商标识（日志 / 排障用） */
  readonly name: string;
  /** 提交转录任务，返回供应商侧 jobId */
  submit(input: AsrSubmitInput): Promise<{ providerJobId: string }>;
  /** 查询供应商侧任务状态 */
  getStatus(providerJobId: string): Promise<{ state: AsrProviderJobState; errorMessage: string | null }>;
  /** 拉取供应商侧原始转录结果（未归一化） */
  fetchTranscript(providerJobId: string): Promise<AsrProviderTranscript>;
  /** 释放供应商占用的资源（本地 sidecar 子进程等）；装配失败即不可用 */
  close?(): void | Promise<void>;
}

/**
 * 按配置解析供应商。
 * 本地形态：provider='local' 且配了 pythonPath 才装配（sidecar 进程由
 * LocalAsrProvider 构造时自行 spawn，health 未就绪前 submit 会等待门控）。
 * 配置不齐同样返回 null（503），不静默降级。
 */
export function resolveAsrProvider(config: AsrProviderConfig): AsrProvider | null {
  switch (config.provider) {
    case 'local': {
      if (config.pythonPath === null) return null;
      return new LocalAsrProvider(config);
    }
    default:
      return null;
  }
}
