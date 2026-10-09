import { useCallback, useEffect, useRef, useState } from 'react'
import {
  listen,
  isRecognitionSupported,
  pronunciationScore,
} from '@/lib/speech'
import { recordingService, isRecordingSupported, type RecordingSession } from '@/services/recording'
import { mockFollowScore, formatSeconds } from '@/lib/followScore'
import { useAppStore } from '@/store/useAppStore'

/**
 * 跟读录音（单词级 / 例句级共用一套逻辑）
 * ------------------------------------------------------------------
 * 两条路互斥，绝不并行（抢同一个麦克风会互相掐死）：
 *   1. 浏览器支持语音识别 → 直接比对识别文本，出**真实分**；
 *   2. 不支持 → 用 MediaRecorder 录真实音频，按时长出**模拟分**（调用方必须标注「模拟」）。
 *
 * 卸载时必定 dispose，否则标签页上的「正在录音」红点不会消失。
 * 状态不进 store：跟读是瞬时交互，不跨页保留。
 */

export type FollowPhase = 'idle' | 'recognizing' | 'recording'

export function useFollowMic(onScore: (score: number, real: boolean) => void) {
  /** 用 ref 存回调：父组件每次 render 传新函数也不会让 toggle 失效 */
  const scoreRef = useRef(onScore)
  scoreRef.current = onScore

  const accent = useAppStore((s) => s.settings.accent)
  const [phase, setPhase] = useState<FollowPhase>('idle')
  const [msg, setMsg] = useState('')
  const sessionRef = useRef<RecordingSession | null>(null)

  useEffect(() => {
    return () => {
      sessionRef.current?.dispose()
      sessionRef.current = null
    }
  }, [])

  /** 结束录音 → 按录音时长给模拟分（真实分走识别分支，不经过这里） */
  const stopAndScore = useCallback(async (target: string) => {
    const s = sessionRef.current
    if (!s) {
      setPhase('idle')
      return
    }
    try {
      const rec = await s.stop()
      const sc = mockFollowScore(target, rec.durationMs)
      if (sc === 0) {
        setMsg(`录了 ${formatSeconds(rec.durationMs)}，太短了，跟着原句再读一次`)
      } else {
        setMsg(`录了 ${formatSeconds(rec.durationMs)}`)
        scoreRef.current(sc, false)
      }
    } catch {
      setMsg('录音没能保存，再试一次')
    } finally {
      sessionRef.current = null
      setPhase('idle')
    }
  }, [])

  /** 点一下开始 / 再点一下结束 */
  const toggle = useCallback(
    async (target: string) => {
      const text = (target ?? '').trim()
      if (!text) return
      // 识别进行中点不动：这时没有 MediaRecorder 会话，只能等它自己结束
      if (phase === 'recognizing') return
      if (phase === 'recording') {
        await stopAndScore(text)
        return
      }
      setMsg('')
      // 路线一：能识别就走真实比对（不碰 MediaRecorder）
      if (isRecognitionSupported()) {
        setPhase('recognizing')
        try {
          const heard = await listen({ lang: accent })
          if (!heard.trim()) {
            setMsg('没听清，再读一次')
            return
          }
          scoreRef.current(pronunciationScore(text, heard), true)
        } catch {
          setMsg('识别不可用，已切换为录音模式，再点一次麦克风')
        } finally {
          setPhase('idle')
        }
        return
      }
      // 路线二：不能识别 → 真录音 + 模拟分
      if (!isRecordingSupported()) {
        setMsg('当前环境不支持录音（需要 https 或 localhost）')
        return
      }
      const session = recordingService.createSession()
      try {
        await session.start()
        sessionRef.current = session
        setPhase('recording')
      } catch (err) {
        session.dispose()
        setMsg(err instanceof Error ? err.message : '打不开麦克风')
      }
    },
    [accent, phase, stopAndScore],
  )

  return { phase, msg, toggle, clearMsg: () => setMsg('') }
}
