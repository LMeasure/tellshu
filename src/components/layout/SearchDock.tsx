import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLocation, useNavigate } from 'react-router-dom'
import { Camera, Clock, Loader2, Mic, Search, X } from 'lucide-react'
import { repository, type SearchHit } from '@/data/repository'
import { speechService } from '@/services/speech'
import { useAppStore, MAX_SEARCH_HISTORY } from '@/store/useAppStore'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { cn } from '@/lib/utils'

/**
 * 全局搜索（2026-10-21 全屏 overlay 版，推翻此前「底部停靠面板」v2）：
 * 停靠在底部 Tab 栏上方的入口行 → 点一下展开**全屏搜索层**（Portal 到 body，
 * 层级高于 Tab 栏 / 同步角标；键盘弹起时层底贴在键盘上沿）。
 *
 * 功能与规则（用户 2026-10-21 定稿）：
 *  - 输入任意字符 300ms 尾延迟防抖自动查询；竞态序号丢旧响应；
 *  - onSubmit / Enter 判 isComposing：中文拼音组词期间按回车只确认候选词，
 *    不触发全页搜索跳转；
 *  - 排序与贴底：匹配度最高的结果固定在**最下方**（紧贴输入框），越往上越低；
 *    结果少时列表整体靠下、多余空间留在上方（CSS 贴底 + 变化后滚底双保险）；
 *  - 无「全部结果」快捷入口：点结果跳详情、回车去全页搜索 /search?q=；
 *  - 空态文案统一「该词暂未收录」（与 /search、/word 全站一致）；
 *  - 历史 = **访问记录**：只在用户点击搜索结果、真正跳转详情页时写入
 *    （store.recordSearchVisit）；单纯打字 / 按回车不留痕。按时间倒序
 *    （最近点击在最上面），重复点击同一词 count+1 + 置顶（×N 角标仅 >1 显示），
 *    可一键清空；
 *  - 语音输入（zh-CN，partial 实时回填）/ 扫描识别（跳 /import?tab=scan）
 *    保留在入口行；输入框聚焦无绿框无环，只保留光标（全局焦点环是有意
 *    为键盘导航加的，这里按用户要求对文本输入框显式豁免）。
 */

/** 防抖时长（ms）：输入停下 300ms 才查询，避免每键一次全库扫描 */
const DEBOUNCE_MS = 300
/** 结果最多展示几条（全页结果区可滚动） */
const PANEL_LIMIT = 30

export function SearchDock({ variant = 'dock' }: { variant?: 'dock' | 'topbar' }) {
  const navigate = useNavigate()
  const location = useLocation()
  const [raw, setRaw] = useState('')
  const q = useDebouncedValue(raw.trim(), DEBOUNCE_MS)
  /** 全屏搜索层是否展开 */
  const [open, setOpen] = useState(false)
  const [hits, setHits] = useState<SearchHit[]>([])
  const [loading, setLoading] = useState(false)

  /** 语音识别中（原 TopSearchBar 逻辑迁移） */
  const [listening, setListening] = useState(false)
  const partialRef = useRef('')
  const recognitionOk = speechService.isRecognitionSupported()

  /** 搜索历史（访问记录：新→旧，直接按序渲染=最近点击在最上面） */
  const history = useAppStore((s) => s.searchHistory)
  const recordSearchVisit = useAppStore((s) => s.recordSearchVisit)
  const clearSearchHistory = useAppStore((s) => s.clearSearchHistory)

  const inputRef = useRef<HTMLInputElement>(null)
  /** 结果/历史列表滚动容器（两者二选一渲染，共用一个 ref） */
  const listRef = useRef<HTMLDivElement>(null)
  /** 查询序号：只认最后一次，旧响应直接丢弃 */
  const reqRef = useRef(0)
  /** 最近一次真正执行的查询：点历史后防抖再来时跳过，避免重复搜 */
  const lastQueryRef = useRef('')

  /** 真正跑一次搜索（防抖 effect 与点历史共用） */
  function runSearch(query: string) {
    if (query === lastQueryRef.current) return
    lastQueryRef.current = query
    const seq = ++reqRef.current
    setLoading(true)
    repository
      .searchRanked(query, PANEL_LIMIT)
      .then((r) => {
        if (seq !== reqRef.current) return
        setHits(r)
        setLoading(false)
      })
      .catch(() => {
        if (seq !== reqRef.current) return
        setHits([])
        setLoading(false)
      })
  }

  // 防抖后的查询执行（空查询清空结果并放行同一词再次搜索）
  useEffect(() => {
    if (!q) {
      lastQueryRef.current = ''
      setHits([])
      setLoading(false)
      return
    }
    runSearch(q)
  }, [q])

  // 展开时聚焦输入框（桌面/Android 可直接唤起键盘；iOS Safari 对程序化
  // focus 不弹键盘，需用户再点一下输入框——平台限制，如实记录）
  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  // 结果/历史变化 → 列表滚到底：最匹配/最新的一条紧挨搜索框
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [hits, loading, open, history])

  // Esc 收起全屏搜索层（输入框内 Esc 同效）
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeOverlay()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  // 路由变化（含点结果跳详情 / 回车去全页）→ 收起，避免层挂在别的页面上
  useEffect(() => {
    setOpen(false)
  }, [location.pathname])

  function openOverlay(withVoice = false) {
    setOpen(true)
    if (withVoice) startVoice()
  }

  function closeOverlay() {
    setOpen(false)
    inputRef.current?.blur()
  }

  function startVoice() {
    if (listening) return
    setListening(true)
    partialRef.current = ''
    speechService
      .listen({
        lang: 'zh-CN',
        onPartial: (t) => {
          partialRef.current = t
          setRaw(t)
        },
      })
      .then((finalText) => {
        setRaw(finalText || partialRef.current)
      })
      .catch(() => {
        // 用户取消 / 无权限 / 出错：保留已听到的部分，不打断输入
        setRaw(partialRef.current)
      })
      .finally(() => setListening(false))
  }

  function clearInput() {
    setRaw('')
    setHits([])
    setLoading(false)
    lastQueryRef.current = ''
    inputRef.current?.focus()
  }

  function submitFullPage() {
    const t = raw.trim()
    if (!t) return
    closeOverlay()
    navigate(`/search?q=${encodeURIComponent(t)}`)
  }

  // 结果反序：模块给 desc（最匹配在前），结果区要最匹配在最底
  const shown = [...hits].reverse()

  return (
    <>
      {open &&
        createPortal(
          <div
            className="fixed inset-x-0 top-0 z-50 flex flex-col bg-card"
            style={{ bottom: 'var(--kb-inset, 0px)' }}
            role="dialog"
            aria-modal="true"
            aria-label="全局搜索"
            data-testid="search-overlay"
          >
            {/* 顶栏：标题 + 收起 */}
            <div className="flex h-12 shrink-0 items-center justify-between border-b border-border/60 px-4">
              <span className="text-sm font-semibold">搜索</span>
              <button
                onClick={closeOverlay}
                aria-label="收起搜索"
                title="收起搜索"
                className="-mr-2 flex h-11 w-11 items-center justify-center rounded-full text-muted-foreground hover:bg-secondary touch-target"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* 结果 / 历史区：外层滚动，内层贴底（结果少时整体靠下、多余空间留在上方） */}
            <div
              ref={listRef}
              className="scrollbar-hidden min-h-0 flex-1 overflow-y-auto overscroll-contain"
            >
              <div className="flex min-h-full flex-col justify-end">
                {q ? (
                  /* ---- 有输入：结果列表（最匹配在最底、紧贴输入框） ---- */
                  <ul>
                    {loading && (
                      <li className="flex items-center justify-center gap-2 px-4 py-6 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" /> 搜索中…
                      </li>
                    )}
                    {!loading && hits.length === 0 && (
                      <li className="px-4 py-6 text-center text-sm text-muted-foreground">该词暂未收录</li>
                    )}
                    {!loading &&
                      shown.map((h) => (
                        <li key={h.word.toLowerCase()}>
                          <button
                            onClick={() => {
                              // 历史唯一写入点：真跳详情了才记一次访问
                              recordSearchVisit(h.word)
                              closeOverlay()
                              navigate(`/word/${encodeURIComponent(h.word)}`)
                            }}
                            className="flex w-full items-center gap-2 px-4 py-3 text-left transition-colors hover:bg-secondary/60 active:bg-secondary"
                          >
                            <span className="shrink-0 text-[15px] font-semibold text-foreground">
                              {h.word}
                            </span>
                            {h.pos && (
                              <span className="shrink-0 text-xs italic leading-relaxed text-muted-foreground">
                                {h.pos}
                              </span>
                            )}
                            <span className="ml-auto line-clamp-1 max-w-[52%] text-right text-xs text-muted-foreground">
                              {h.zh ?? h.bookName}
                            </span>
                          </button>
                        </li>
                      ))}
                  </ul>
                ) : (
                  /* ---- 无输入：历史访问记录（最近点击在最上面） ---- */
                  <div>
                    {history.length === 0 ? (
                      <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                        暂无搜索历史
                        <br />
                        点击搜索结果后会记录在这里（最多 {MAX_SEARCH_HISTORY} 条）
                      </p>
                    ) : (
                      <>
                        <div className="flex h-11 items-center justify-between border-b border-border px-4">
                          <span className="text-xs text-muted-foreground">最近搜索</span>
                          <button
                            onClick={clearSearchHistory}
                            className="-mr-2 flex h-11 items-center px-2 text-xs font-medium text-foreground touch-target"
                            aria-label="清空历史记录"
                            title="清空历史记录"
                          >
                            清空
                          </button>
                        </div>
                        <ul>
                          {history.map((item) => (
                            <li key={item.query.toLowerCase()}>
                              <button
                                onClick={() => {
                                  // 点历史：回填输入框并立即重搜（防抖再来时按 lastQueryRef 跳过）；
                                  // 重搜不是访问，不写历史
                                  setRaw(item.query)
                                  runSearch(item.query)
                                }}
                                className="flex w-full items-center gap-2.5 px-4 py-3 text-left transition-colors hover:bg-secondary/60 active:bg-secondary"
                              >
                                <Clock className="h-4 w-4 shrink-0 text-muted-foreground" />
                                <span className="truncate text-[15px] text-foreground">{item.query}</span>
                                {item.count > 1 && (
                                  <span className="ml-auto shrink-0 rounded-full bg-secondary px-2 py-0.5 text-xs text-muted-foreground">
                                    ×{item.count}
                                  </span>
                                )}
                              </button>
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* 输入区：贴在全屏层底部（键盘弹起时贴在键盘上沿） */}
            <div className="shrink-0 border-t border-border px-3 py-2 safe-bottom">
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  submitFullPage()
                }}
                className="flex items-center gap-2 rounded-2xl bg-muted px-4 py-3"
              >
                <Search className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
                <input
                  ref={inputRef}
                  value={raw}
                  onChange={(e) => setRaw(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      closeOverlay()
                      return
                    }
                    // 中文输入法组词期间的回车只确认候选词：isComposing 为主，
                    // keyCode 229 兜底（部分旧环境不置 isComposing）
                    if (e.key === 'Enter' && (e.nativeEvent.isComposing || e.keyCode === 229)) {
                      e.preventDefault()
                    }
                  }}
                  placeholder="搜单词…（回车看全部结果）"
                  aria-label="全局搜索"
                  className="w-full bg-transparent text-base outline-none ring-0 ring-offset-0 placeholder:text-muted-foreground focus-visible:ring-0 focus-visible:ring-offset-0"
                />
                {raw && (
                  <button
                    type="button"
                    onClick={clearInput}
                    aria-label="清空搜索"
                    title="清空搜索"
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-secondary touch-target"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </form>
            </div>
          </div>,
          document.body,
        )}

      {/* 入口行：dock = 原底部停靠行（移动端，逐字保留）；topbar = 桌面顶部栏紧凑搜索框。
          两者仅外观不同，搜索逻辑（overlay / 防抖 / 竞态 / isComposing / 历史 / 语音 / Esc）完全共用。 */}
      {variant === 'topbar' ? (
        <div className="relative flex items-center" data-variant="topbar">
          <div className="flex w-full max-w-md items-center gap-2 rounded-xl bg-muted px-3 py-1.5">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            <button
              type="button"
              onClick={() => openOverlay(false)}
              className="flex-1 touch-target text-left text-sm text-muted-foreground"
              aria-label="打开全局搜索"
              title="搜单词"
            >
              搜单词…
            </button>
            {recognitionOk && (
              <button
                type="button"
                onClick={() => openOverlay(true)}
                aria-label={listening ? '正在听…' : '语音输入'}
                title={listening ? '正在听…' : '语音输入'}
                className={cn(
                  'flex h-8 w-8 shrink-0 items-center justify-center rounded-full touch-target',
                  listening
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-secondary',
                )}
              >
                <Mic className={cn('h-4 w-4', listening && 'animate-pulse')} />
              </button>
            )}
            <button
              type="button"
              onClick={() => navigate('/import?tab=scan')}
              aria-label="扫描识别"
              title="扫描识别"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-secondary touch-target"
            >
              <Camera className="h-4 w-4" />
            </button>
          </div>
        </div>
      ) : (
        <div className="relative border-t border-border bg-card/95 backdrop-blur" data-variant="dock">
          <div className="px-3 py-2">
            <div className="flex items-center gap-2 rounded-2xl bg-muted px-4 py-3">
              <Search className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
              <button
                type="button"
                onClick={() => openOverlay(false)}
                className="flex-1 touch-target text-left text-base text-muted-foreground"
                aria-label="打开全局搜索"
                title="搜单词"
              >
                搜单词…
              </button>
              {recognitionOk && (
                <button
                  type="button"
                  onClick={() => openOverlay(true)}
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
            </div>
          </div>
        </div>
      )}
    </>
  )
}
