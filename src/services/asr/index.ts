/**
 * 媒体采集服务出口
 * ------------------------------------------------------------------
 * 页面只 import 这里的 asrService，不直接碰 DOM 文件选择。
 */

import { webAsrService } from './web'
import { noopAsrService } from './noop'
import type { AsrCaptureService } from './types'

export type { AsrCaptureService, PickedMedia } from './types'

function pickDriver(): AsrCaptureService {
  return webAsrService.isSupported() ? webAsrService : noopAsrService
}

export const asrService: AsrCaptureService = pickDriver()

/** 当前环境是否支持媒体采集 */
export const isAsrSupported = (): boolean => asrService.isSupported()
