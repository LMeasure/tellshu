/**
 * 媒体采集 · 空实现
 * ------------------------------------------------------------------
 * 用于 SSR / 无 DOM 环境：采集返回空数组，界面据此显示「当前环境不支持」。
 * 不抛错、不静默造假数据。
 */

import type { AsrCaptureService, PickedMedia } from './types'

export const noopAsrService: AsrCaptureService = {
  driver: 'none',
  isSupported(): boolean {
    return false
  },
  async pickMedia(): Promise<PickedMedia[]> {
    return []
  },
}
