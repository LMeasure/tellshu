/**
 * 图像采集 · 空实现
 * ------------------------------------------------------------------
 * 用于 SSR / 无 DOM 环境：所有采集返回空数组，界面据此显示「当前环境不支持」。
 * 不抛错、不静默造假数据。
 */

import type { OcrService, PickedImage } from './types'

export const noopOcrService: OcrService = {
  driver: 'none',
  isSupported(): boolean {
    return false
  },
  isCameraSupported(): boolean {
    return false
  },
  async pickFromFiles(): Promise<PickedImage[]> {
    return []
  },
  async capture(): Promise<PickedImage[]> {
    return []
  },
  async captureLive(): Promise<PickedImage[]> {
    return []
  },
  async compress(image: PickedImage): Promise<PickedImage> {
    return image
  },
}
