import { Library } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { setOnShelf, type ReadingDoc } from '@/domain/learning'

/**
 * T-P2 scheme B：书架动作只给 type==='book'。
 * 文章 / 扫描（article）、字幕、音频不渲染按钮，因此不会因为这个入口进入首页书架。
 * 未上架 → setOnShelf(id, true)；已上架 → setOnShelf(id, false)。
 * 导入本身不写 on_shelf，这个按钮是上架的入口。
 */
export function MaterialShelfButton({
  doc,
  onChanged,
}: {
  doc: Pick<ReadingDoc, 'id' | 'type' | 'on_shelf'>
  onChanged: () => void
}) {
  if (doc.type !== 'book') return null
  const onShelf = doc.on_shelf === true
  const label = onShelf ? '移出书架' : '加入书架'
  return (
    <Button
      type="button"
      variant={onShelf ? 'secondary' : 'outline'}
      size="sm"
      className="shrink-0"
      aria-label={label}
      title={label}
      onClick={(e) => {
        // 素材行整卡可点进阅读器，按钮自己处理，不能把点击冒泡成跳转
        e.stopPropagation()
        const next = !onShelf
        void setOnShelf(doc.id, next).then(() => onChanged())
      }}
    >
      <Library className="h-4 w-4" />
      {label}
    </Button>
  )
}
