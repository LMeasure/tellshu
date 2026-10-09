/**
 * 录音服务契约（platform-agnostic）
 * ------------------------------------------------------------------
 * 背诵需要的是**真实音频文件**（可回放、可归档），不是识别出的文字，
 * 所以这里与 services/speech 的识别能力完全独立 —— 两者互不影响。
 *
 * ⚠️ 平台前提：`getUserMedia` 只在**安全上下文**可用（https 或 localhost）。
 * 局域网 IP 直连（http://192.168.x.x）在手机上会静默失败 ——
 * 这正是本地开发必须用 `--host` + https 隧道，或直接用 PWA 部署后的 https 域名的原因。
 */

/** 一次录音的产物 */
export interface Recording {
  blob: Blob
  durationMs: number
  mediaType: string
}

/**
 * 一次录音会话。**同一实例可反复 start/stop**（「继续录制」= 再录一条）。
 * 用完必须 dispose() 释放麦克风，否则浏览器标签页上的「正在录音」红点不会消失。
 */
export interface RecordingSession {
  readonly isRecording: boolean
  /** 申请麦克风并开始录制。已有录制进行中时抛错。 */
  start(): Promise<void>
  /** 停止并返回音频；若已被 cancel 则 reject(new Error('cancelled'))，调用方忽略即可。 */
  stop(): Promise<Recording>
  /** 丢弃本次录音（不产出文件） */
  cancel(): void
  /** 释放麦克风（组件卸载时调用） */
  dispose(): void
}

export interface RecordingService {
  /** 实现标识：web=MediaRecorder；none=不支持（SSR / 原生壳未接） */
  readonly driver: 'web' | 'none'
  /** 当前环境是否具备录音能力（含 getUserMedia 与安全上下文检查） */
  isSupported(): boolean
  createSession(): RecordingSession
}
