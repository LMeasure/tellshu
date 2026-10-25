import { useEffect } from 'react'

/**
 * 移动端键盘弹起监听：把键盘高度写进 CSS 变量 `--kb-inset`（px，默认 0）。
 * 底部停靠组（Tab 栏 + 全局搜索入口行）用 `bottom: var(--kb-inset, 0px)` 整体上移，
 * 全屏搜索层用同一变量把层底贴在键盘上沿，保证键盘弹出时不被挡死、收起时归位。
 *
 * 三个坑的处理：
 * 1. iOS Safari 弹键盘**不缩布局视口**（window.innerHeight 不变），只有
 *    visualViewport 会缩 —— 必须优先用 visualViewport，这是唯一可靠来源；
 * 2. 两条路径都只有差值 >120px 才认键盘：避开移动端地址栏收起 / 页面滚动
 *    造成的视觉视口小幅抖动（会把停靠组和搜索层顶得乱跳）；
 * 3. 降级路径（无 visualViewport 的老环境）用布局高度差，阈值同上。
 */

/** 判定「键盘确实弹起」的最小高度差（px）：低于此值按 0 处理，防地址栏抖动 */
const KEYBOARD_MIN_PX = 120

export function useKeyboardInset() {
  useEffect(() => {
    const root = document.documentElement
    const setInset = (px: number) => root.style.setProperty('--kb-inset', `${Math.round(px)}px`)
    const vv = window.visualViewport

    if (vv) {
      const apply = () => {
        const h = Math.max(0, window.innerHeight - (vv.height + vv.offsetTop))
        setInset(h > KEYBOARD_MIN_PX ? h : 0)
      }
      apply()
      vv.addEventListener('resize', apply)
      // 键盘弹出时 visualViewport 可能位移（页面被顶），scroll 也要跟
      vv.addEventListener('scroll', apply)
      return () => {
        vv.removeEventListener('resize', apply)
        vv.removeEventListener('scroll', apply)
        root.style.removeProperty('--kb-inset')
      }
    }

    const baseline = window.innerHeight
    const onResize = () => {
      const delta = baseline - window.innerHeight
      setInset(delta > KEYBOARD_MIN_PX ? delta : 0)
    }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      root.style.removeProperty('--kb-inset')
    }
  }, [])
}
