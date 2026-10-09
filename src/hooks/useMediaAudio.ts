import { useCallback, useRef } from 'react'
import { audioBus, type AudioHolder } from '@/lib/audioBus'

/**
 * 让 <audio> 参与音频仲裁（背诵回放 / 导入的音频素材都用它）
 * ------------------------------------------------------------------
 * 用法：把返回的 ref 挂到 <audio ref={mediaRef}> 上即可，无需手写事件。
 *   · 开始播放 → claim（正在听书就先暂停听书）
 *   · 播完/用户暂停 → release（自动恢复听书）
 * 注意 `selfPause`：仲裁自己调 el.pause() 也会触发 pause 事件，
 * 必须区分「被抢占」与「用户主动暂停」，否则会立刻把自己恢复回去。
 */
export function useMediaAudio<T extends HTMLAudioElement = HTMLAudioElement>() {
  const disposeRef = useRef<(() => void) | null>(null)

  const ref = useCallback((el: T | null) => {
    disposeRef.current?.()
    disposeRef.current = null
    if (!el) return

    let selfPause = false
    const holder: AudioHolder = {
      role: 'media',
      suspend() {
        selfPause = true
        el.pause()
      },
      resume() {
        void el.play().catch(() => {
          /* 自动播放被拦就算了，不打扰用户 */
        })
      },
    }

    const onPlay = () => audioBus.claim(holder)
    const onPause = () => {
      if (selfPause) {
        selfPause = false
        return
      }
      audioBus.release(holder)
    }
    const onEnded = () => audioBus.release(holder)

    el.addEventListener('play', onPlay)
    el.addEventListener('pause', onPause)
    el.addEventListener('ended', onEnded)

    disposeRef.current = () => {
      el.removeEventListener('play', onPlay)
      el.removeEventListener('pause', onPause)
      el.removeEventListener('ended', onEnded)
      audioBus.release(holder)
    }
  }, [])

  return ref
}
