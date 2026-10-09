/**
 * 网络状态探测
 * ------------------------------------------------------------------
 * ⚠️ `navigator.onLine` 只能反映"网卡是否连上"，**不能**反映"能否访问到服务器"：
 * 连着一个没有外网的 WiFi 时它依然是 true；反过来，能开网页时它一定是 true。
 *
 * 所以它**只用来决定文案**，不用来决定是否发起请求 —— 请求照发，
 * 拿不到数据时 dataClient 返回空，页面再结合这个值给出"离线 / 未缓存"的明确说明。
 * 用 onLine 去拦截请求是常见误用：会造成本来能加载的内容也加载不了。
 */

import { useEffect, useState } from 'react'

/** 当前是否在线（SSR / 无 navigator 时保守认为在线，避免误报离线） */
export function isOnline(): boolean {
  if (typeof navigator === 'undefined') return true
  return navigator.onLine !== false
}

/** 订阅 online / offline 事件的 Hook */
export function useOnline(): boolean {
  const [online, setOnline] = useState<boolean>(isOnline)

  useEffect(() => {
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])

  return online
}
