import { useEffect, useState } from 'react'
import { Cloud, GitMerge } from 'lucide-react'
import { Dialog } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { syncEngine } from '@/services/sync'

/**
 * 同步结果提示：
 *  - 轻量 toast：本地变更成功推送到云端时（pushed > 0）短暂提示「已同步 N 条」。
 *  - 合并弹窗：从云端拉回并 LWW 合并了记录（pulled > 0）时弹出，告知用户发生了合并。
 *    LWW 是自动裁决（updated_at 大者胜），无需人工决策，弹窗仅做透明告知。
 *    本地桩阶段多为同一设备的回拉，文案保持中性；接入真实多端（Phase C）后即代表跨设备合并。
 */
export function SyncNotice() {
  const [toast, setToast] = useState<string | null>(null)
  const [merged, setMerged] = useState(0)

  useEffect(() => {
    const off = syncEngine.onResult((r) => {
      if (r.pushed > 0) {
        setToast(`已同步 ${r.pushed} 条到云端`)
        window.setTimeout(() => setToast(null), 2600)
      }
      if (r.pulled > 0) {
        setMerged(r.pulled)
      }
    })
    return off
  }, [])

  return (
    <>
      {toast && (
        <div className="pointer-events-none fixed bottom-20 left-1/2 z-40 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-foreground/90 px-4 py-2 text-xs font-medium text-background shadow-soft">
          <Cloud className="h-4 w-4" />
          {toast}
        </div>
      )}

      <Dialog
        open={merged > 0}
        onClose={() => setMerged(0)}
        title={
          <span className="flex items-center justify-center gap-2">
            <GitMerge className="h-5 w-5 text-primary" /> 已合并云端变更
          </span>
        }
        footer={
          <Button className="w-full" onClick={() => setMerged(0)}>
            知道了
          </Button>
        }
      >
        云端有 {merged} 条变更已拉回，按「最新修改时间」自动合并（LWW），无需手动处理。
      </Dialog>
    </>
  )
}
