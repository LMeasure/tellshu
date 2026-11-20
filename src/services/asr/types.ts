/**
 * 媒体采集服务契约（platform-agnostic）
 * ------------------------------------------------------------------
 * 职责边界：只负责「把音视频文件选进来 + 判个类型」，**不做转写**。
 * 转写在服务端完成（供应商 adapter），前端只拿结果，
 * 见 src/data/asrClient.ts 与 src/domain/transcript/。
 *
 * ⚠️ 平台前提：文件选择走 <input type=file>，任何环境都能用；
 * 本服务不碰 getUserMedia / canvas（Phase 1 无录音需求）。
 */

/** 采集到的一个媒体文件 */
export interface PickedMedia {
  blob: Blob
  /** 原始文件名 */
  name: string
  mimeType: string
  sizeBytes: number
  /** 按扩展名判定的媒体类型（决定结果区用 <audio> 还是 <video>） */
  kind: 'audio' | 'video'
}

export interface AsrCaptureService {
  readonly driver: 'web' | 'none'
  /** 是否具备媒体采集能力（DOM 可用即可） */
  isSupported(): boolean
  /** 弹出系统文件选择器（单选）；用户取消返回空数组 */
  pickMedia(): Promise<PickedMedia[]>
}
