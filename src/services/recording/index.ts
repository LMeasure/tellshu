/**
 * 录音服务出口
 * ------------------------------------------------------------------
 * 有 MediaRecorder + getUserMedia + 安全上下文 → Web 实现，否则空实现。
 * 页面只 import 这里的 `recordingService`，不直接碰 MediaRecorder。
 */

import { webRecordingService } from './web'
import { noopRecordingService } from './noop'
import type { RecordingService } from './types'

export type { Recording, RecordingService, RecordingSession } from './types'

function pickDriver(): RecordingService {
  return webRecordingService.isSupported() ? webRecordingService : noopRecordingService
}

export const recordingService: RecordingService = pickDriver()

/** 当前环境是否具备录音能力（界面据此显示/隐藏录音入口） */
export const isRecordingSupported = (): boolean => recordingService.isSupported()
