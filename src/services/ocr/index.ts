/**
 * 图像采集服务出口
 * ------------------------------------------------------------------
 * 页面只 import 这里的 ocrService，不直接碰 getUserMedia / canvas。
 */

import { webOcrService } from './web'
import { noopOcrService } from './noop'
import type { OcrService } from './types'

export type { OcrService, PickedImage } from './types'

function pickDriver(): OcrService {
  return webOcrService.isSupported() ? webOcrService : noopOcrService
}

export const ocrService: OcrService = pickDriver()

/** 当前环境是否支持图片采集 */
export const isOcrSupported = (): boolean => ocrService.isSupported()

/** 当前环境是否支持摄像头（需 https / localhost） */
export const isCameraSupported = (): boolean => ocrService.isCameraSupported()
