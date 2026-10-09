/**
 * 图像采集服务契约（platform-agnostic）
 * ------------------------------------------------------------------
 * 职责边界：只负责「把图片拿进来 + 压一压」，**不做 OCR 识别**。
 * 识别（PaddleOCR）在后端完成，前端只拿结果，见 src/data/dictClient.ts。
 *
 * ⚠️ 平台前提：
 *   · 相册 / 文件选择：任何环境都能用（走 <input type=file>）
 *   · 摄像头：getUserMedia 只在**安全上下文**（https 或 localhost）可用，
 *     局域网 IP 直连 http://192.168.x.x 会静默失败 —— 这也是为什么要固定 https 域。
 */

/** 采集到的一张图片 */
export interface PickedImage {
  blob: Blob
  /** 原始文件名（拍摄时按时间生成） */
  name: string
  mimeType: string
  width: number
  height: number
}

export interface OcrService {
  readonly driver: 'web' | 'none'
  /** 是否具备图片采集能力（DOM 可用即可） */
  isSupported(): boolean
  /** 是否具备摄像头能力（需安全上下文 + mediaDevices） */
  isCameraSupported(): boolean
  /** 从相册 / 文件选择；multiple=true 可多选（批量上传多页靠这个） */
  pickFromFiles(multiple: boolean): Promise<PickedImage[]>
  /** 调用系统相机拍一张（<input capture>，不需要常驻权限） */
  capture(): Promise<PickedImage[]>
  /** 打开取景器实时拍摄（getUserMedia + canvas）；失败由调用方回退到 capture() */
  captureLive(): Promise<PickedImage[]>
  /** 压缩到长边不超过 maxEdge（默认 1600），JPEG 质量 0.85 */
  compress(image: PickedImage, maxEdge?: number): Promise<PickedImage>
}
