import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Camera, Mic, Search } from 'lucide-react'
import { speechService } from '@/services/speech'
import { cn } from '@/lib/utils'

/**
 * 顶部搜索栏（2026-10-07 改版）：
 *  - 去掉「搜索 / AI 问答」切换按钮组 —— AI 问答无真实后端，不留假入口；
 *  - 搜索框放大独占一行，位置在页面内容（主页等按钮）上方；
 *  - 框内右侧两个能力按钮：
 *      · 语音输入 —— Web Speech 识别直接把词填进搜索框（不支持的环境如实隐藏）；
 *      · 扫描 —— 跳导入页扫描识别页签（/import?tab=scan）。
 */
export function TopSearchBar() {
  const [value, setValue] = useState('')
  const [listening, setListening] = useState(false)
  /** 语音识别期间收到部分结果就实时回填，停止后写最终值 */
  const partialRef = useRef('')
  const navigate = useNavigate()
  const recognitionOk = speechService.isRecognitionSupported()

  function startVoice() {
    if (listening) return
    setListening(true)
    partialRef.current = ''
    speechService
      .listen({
        lang: 'zh-CN',
        onPartial: (t) => {
          partialRef.current = t
          setValue(t)
        },
      })
      .then((finalText) => {
        setValue(finalText || partialRef.current)
      })
      .catch(() => {
        // 用户取消 / 无权限 / 出错：保留已听到的部分，不打断输入
        setValue(partialRef.current)
      })
      .finally(() => setListening(false))
  }

  return (
    <div className="safe-top sticky top-0 z-20 border-b border-border bg-card/95 px-3 py-2.5 backdrop-blur">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (value.trim()) navigate(`/search?q=${encodeURIComponent(value.trim())}`)
        }}
        className="flex items-center gap-2 rounded-2xl bg-muted px-4 py-3"
      >
        <Search className="h-5 w-5 shrink-0 text-muted-foreground" />
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="搜单词、课程、句型…"
          aria-label="搜索"
          className="w-full bg-transparent text-base outline-none placeholder:text-muted-foreground"
        />
        {recognitionOk && (
          <button
            type="button"
            onClick={startVoice}
            aria-label={listening ? '正在听…' : '语音输入'}
            title={listening ? '正在听…' : '语音输入'}
            className={cn(
              'flex h-9 w-9 shrink-0 items-center justify-center rounded-full touch-target',
              listening
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-secondary',
            )}
          >
            <Mic className={cn('h-5 w-5', listening && 'animate-pulse')} />
          </button>
        )}
        <button
          type="button"
          onClick={() => navigate('/import?tab=scan')}
          aria-label="扫描识别"
          title="扫描识别"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-secondary touch-target"
        >
          <Camera className="h-5 w-5" />
        </button>
      </form>
    </div>
  )
}
