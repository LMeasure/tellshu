import { useEffect, useState } from 'react'

/**
 * 尾延迟防抖：value 稳定 delay 毫秒后才返回新值。
 * - 空串立即返回（清空输入不等防抖，面板要马上收）；
 * - 卸载 / value 变化自动取消待触发定时器，不会打完字还跳一次。
 */
export function useDebouncedValue(value: string, delay: number): string {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    if (value === '') {
      setDebounced('')
      return
    }
    const t = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(t)
  }, [value, delay])
  return debounced
}
