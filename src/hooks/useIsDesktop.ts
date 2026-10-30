import { useEffect, useState } from 'react'

/**
 * 桌面档判定（阶段 1-A1）。
 *
 * 断点口径：与 tailwind 默认 `lg` 对齐 —— **≥1024px 为桌面档**，<1024px 为移动档。
 * tailwind.config.js 未自定义 screens，故 lg=1024；这里写死常量而不是引 CSS，
 * 是为了让 JS 分支与 CSS 断点始终同源可读（改断点时两处一起改）。
 *
 * 为什么用 JS 而不是纯 CSS（lg:hidden）：
 * 纯 CSS 方案会把「底部 Tab 栏」和「桌面侧栏」两套导航同时渲染进 DOM，
 * 产生两份 <nav> 与重复可聚焦元素，键盘/读屏体验会重复。用 JS 分支只渲染一套，
 * 语义干净。初值用 matchMedia 同步读取，首帧即正确，不会闪一下移动布局。
 *
 * 兼容性：Node / tsx 单测环境没有 window，全部做守卫，返回 false（移动档），
 * 绝不抛错（既有 test_*.ts 就是在 Node 下跑的）。
 */
export const DESKTOP_MIN_WIDTH = 1024

const QUERY = `(min-width: ${DESKTOP_MIN_WIDTH}px)`

function matchDesktop(): boolean {
  if (typeof window === 'undefined') return false
  if (typeof window.matchMedia !== 'function') return false
  return window.matchMedia(QUERY).matches
}

/**
 * 当前是否处于桌面档（≥1024px）。仅用于 AppShell 在「桌面外壳 / 移动外壳」间二选一。
 */
export function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState<boolean>(() => matchDesktop())

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia(QUERY)
    // 挂载时再同步一次：SSR/首帧与挂载之间视口可能已变化
    setIsDesktop(mql.matches)
    const onChange = (e: MediaQueryListEvent) => setIsDesktop(e.matches)
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onChange)
      return () => mql.removeEventListener('change', onChange)
    }
    // 老 Safari（<14）只有 addListener
    mql.addListener(onChange)
    return () => mql.removeListener(onChange)
  }, [])

  return isDesktop
}
