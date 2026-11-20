/**
 * 语音服务契约（platform-agnostic）
 * ------------------------------------------------------------------
 * 目标：页面与 lib 不再直接碰 `window.speechSynthesis` / `SpeechRecognition`。
 * Web 上用浏览器内置的 Web Speech API；将来包原生壳时换成本地 TTS/ASR
 * （iOS AVSpeechSynthesizer / Android TextToSpeech + SpeechRecognizer），
 * 只需新增一个实现，上层零改动。
 *
 * 能力探测必须走这里的 `isSynthesisSupported` / `isRecognitionSupported`：
 * 不同内核支持度差异极大（Safari 的识别仅在有网络时可用、Firefox 完全不支持识别），
 * 硬编码判断是 bug 的常见来源。
 */

/** 朗读参数。rate 优先于 slow（两者都给时 rate 生效）。 */
export interface SpeakOptions {
  /** true = 慢速跟读模式（约 0.6 倍速） */
  slow?: boolean
  /** 显式倍速，1 = 常速；会自动收敛到合法区间。听书默认 0.9 —— 需求定死的 */
  rate?: number
  /** 音调，1 = 原调；会自动收敛到 0–2。听书默认 1.0 —— 需求定死的 */
  pitch?: number
  /** BCP-47 语言标签，如 en-US / zh-CN；不给时按文本里的字符自动判 */
  lang?: string
  /**
   * true = 走浏览器默认（需求【1】英文听书）：
   * **不指定 voice、不设置 rate / pitch**，只把 lang 交给引擎。
   * 挑嗓音在跨系统上的结果很不稳定（Windows 上常被挑到带口音或不对语言的嗓音），
   * 而浏览器默认嗓音是内核自己调过的、最稳的那一个。
   */
  natural?: boolean
}

/** 一次跟读识别。onPartial 用于实时显示中间结果。 */
export interface ListenOptions {
  lang?: string
  onPartial?: (text: string) => void
}

export interface SpeechService {
  /** 实现标识：web=浏览器内置；none=完全不支持（原生壳占位/服务端渲染） */
  readonly driver: 'web' | 'none'

  /** 朗读（合成）是否可用 */
  isSynthesisSupported(): boolean
  /** 识别（跟读评测）是否可用 */
  isRecognitionSupported(): boolean

  /** 朗读文本，不等待结束；返回是否真的触发了合成 */
  speak(text: string, options?: SpeakOptions): boolean
  /**
   * 朗读并等待结束（听书逐句高亮依赖它）。
   * 被 cancel() 打断时也应 resolve（而不是 reject），
   * 否则调用方的 await 会挂住 —— 这是 listenSession 抢占逻辑的前提。
   */
  speakAsync(text: string, options?: SpeakOptions): Promise<void>
  /** 立刻中断当前朗读 */
  cancel(): void

  /**
   * 播放「错误提示音」（单词默写 V2：任意真实错误字母发生时立即播放）。
   * 与 speak() 分开：提示音是短促非语音音，不占用朗读队列、不打断听书。
   * 返回是否真的触发了发声；不支持/被浏览器自动播放策略拦截时返回 false，
   * 调用方不得据此判定判错失败（提示音是反馈，不是正确性依据）。
   */
  playErrorTone(): boolean

  /** 实时识别一次跟读，resolve 为最终识别文本；不支持时 reject(new Error('unsupported')) */
  listen(options?: ListenOptions): Promise<string>
}

/** 朗读倍速合法区间（SpeechSynthesis 实际可用范围比规范窄） */
export function clampRate(rate: number): number {
  if (!Number.isFinite(rate)) return 1
  return Math.min(Math.max(rate, 0.1), 4)
}

/** 音调合法区间 0–2（规范要求）；越界会被部分内核直接拒绝发声 */
export function clampPitch(pitch: number): number {
  if (!Number.isFinite(pitch)) return 1
  return Math.min(Math.max(pitch, 0), 2)
}

/** slow/rate → 最终倍速。听书需求把默认值钉在 0.9 */
export function resolveRate(options?: SpeakOptions): number {
  return clampRate(options?.rate ?? (options?.slow ? 0.6 : 0.9))
}

/** 听书需求把 pitch 钉在 1.0（原调） */
export function resolvePitch(options?: SpeakOptions): number {
  return clampPitch(options?.pitch ?? 1)
}
