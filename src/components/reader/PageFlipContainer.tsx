import { useEffect, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from 'react'
import { cn } from '@/lib/utils'

/**
 * 阅读器翻页容器（2026-10-07 需求 4；2026-10-08 V2.0 改造）
 * ------------------------------------------------------------------
 * 四种翻页方式：
 *   slide  —— 平滑：**前后页连排**（上一页 / 当前页 / 下一页并排在一个三页轨道里），
 *             手指横向拖动时整条轨道跟手平移，露出相邻页正文，松手按位移吸附翻页。
 *             因为相邻页始终在场，视觉上是「连续滚过去」而非「一页换一页」。
 *   cover  —— 覆盖：新页连同它的纸张一起从右侧盖到当前页上（当前页不动）。
 *   book   —— 仿书本：当前页绕左缘 3D 翻出，下一页在底下露出。
 *   scroll —— 上下滚动：不分页动画，整篇连续滚动，页码按滚动比例反算。
 *
 * 交互分区（点击）：左 1/4 上一页 · 右 1/4 下一页 · 中间 1/2 呼出工具栏。
 * 手势可用 gesturesDisabled 关闭（记忆模式选词、划词进行中）。
 * 除上下滚动外，页面层不显示内置滚动条（reader-nobar）。
 */

export type PageMode = 'slide' | 'book' | 'scroll' | 'cover'
type FlipDir = 'next' | 'prev'

interface FlipState {
  from: number
  to: number
  dir: FlipDir
}

export interface PageFlipHandle {
  /** scroll 模式：滚到某页对应的比例位置（目录跳转 / 续读定位用） */
  scrollToPage: (page: number) => void
}

interface Props {
  pageMode: PageMode
  page: number
  pageCount: number
  /** 手势/点击翻页是否禁用（记忆模式选词、划词中） */
  gesturesDisabled?: boolean
  /** 动画提交 & scroll 模式滚动反算都会回调 */
  onPage: (page: number) => void
  /** 点击中间 1/2 区域（呼出工具栏） */
  onTapCenter: () => void
  /** 渲染第 i 页内容（分页模式） */
  renderPage: (pageIndex: number) => ReactNode
  /** 渲染整篇内容（scroll 模式） */
  renderScroll: () => ReactNode
  /** 父级拿 scrollToPage 句柄（目录跳转 / 续读定位） */
  handleRef?: Ref<PageFlipHandle>
}

const SWIPE_PX = 60
/** slide：松手后按位移比例吸附（超过此比例即翻页，否则弹回） */
const SLIDE_SNAP_RATIO = 0.22
/** 单击判定：按下到抬起超过此时长（长按选词）不算单击 */
const TAP_MAX_MS = 400
/** 单击判定：位移超过此值（滑动翻页）不算单击 */
const TAP_MOVE_PX = 10

export function PageFlipContainer({
  pageMode,
  page,
  pageCount,
  gesturesDisabled = false,
  onPage,
  onTapCenter,
  renderPage,
  renderScroll,
  handleRef,
}: Props) {
  const [flip, setFlip] = useState<FlipState | null>(null)
  const committedRef = useRef(false)
  const touchStart = useRef<{ x: number; y: number } | null>(null)
  /** 用于「单击 = Toggle 面板」的时间/位移阈值判定（防滑动翻页误触） */
  const tapRef = useRef<{ t: number; x: number; y: number } | null>(null)
  const suppressClickRef = useRef(false)
  const scrollerRef = useRef<HTMLDivElement>(null)
  /** scroll 模式：最近一次由滚动反算出的页码（避免 page prop 回流触发 scrollTo 循环） */
  const lastCalcRef = useRef(page)

  /* ---------------- slide 模式：三页轨道 + 跟手拖动 ---------------- */
  const slideStageRef = useRef<HTMLDivElement>(null)
  const [dragPx, setDragPx] = useState(0)
  const dragPxRef = useRef(0)
  const [snap, setSnap] = useState<'next' | 'prev' | 'back' | null>(null)
  const snapRef = useRef<'next' | 'prev' | 'back' | null>(null)
  const snapTimerRef = useRef<number | null>(null)
  /** 供原生监听读取的最新状态（避免频繁重挂监听） */
  const live = useRef({ page, pageCount, disabled: gesturesDisabled, animating: false })
  live.current.page = page
  live.current.pageCount = pageCount
  live.current.disabled = gesturesDisabled

  function setDrag(v: number) {
    dragPxRef.current = v
    setDragPx(v)
  }

  /** 开始吸附动画（翻页或回弹），transitionend 或兜底定时器都会收尾 */
  function beginSnap(target: 'next' | 'prev' | 'back') {
    snapRef.current = target
    live.current.animating = true
    setSnap(target)
    if (snapTimerRef.current !== null) window.clearTimeout(snapTimerRef.current)
    snapTimerRef.current = window.setTimeout(finishSnap, 450)
  }

  /** 吸附收尾：幂等（transitionend 与兜底定时器二选一） */
  function finishSnap() {
    const target = snapRef.current
    if (!target) return
    snapRef.current = null
    if (snapTimerRef.current !== null) {
      window.clearTimeout(snapTimerRef.current)
      snapTimerRef.current = null
    }
    setSnap(null)
    setDrag(0)
    live.current.animating = false
    if (target === 'back') return
    const to = target === 'next' ? live.current.page + 1 : live.current.page - 1
    onPage(to)
  }

  useImperativeHandle(
    handleRef,
    () => ({
      scrollToPage: (target: number) => {
        const el = scrollerRef.current
        if (!el || pageCount <= 1) return
        const clamped = Math.min(Math.max(target, 0), pageCount - 1)
        lastCalcRef.current = clamped
        const ratio = pageCount <= 1 ? 0 : clamped / (pageCount - 1)
        el.scrollTop = ratio * (el.scrollHeight - el.clientHeight)
      },
    }),
    [pageCount],
  )

  // 卸载时清掉兜底定时器
  useEffect(
    () => () => {
      if (snapTimerRef.current !== null) window.clearTimeout(snapTimerRef.current)
    },
    [],
  )

  /** slide：原生触摸监听（touchmove 需要 passive:false 才能拦住纵向滚动） */
  useEffect(() => {
    if (pageMode !== 'slide') return
    const el = slideStageRef.current
    if (!el) return
    let sx = 0
    let sy = 0
    let axis: 'x' | 'y' | null = null
    let dragging = false

    const onStart = (e: TouchEvent) => {
      if (live.current.disabled || live.current.animating || e.touches.length !== 1) return
      const t = e.touches[0]
      sx = t.clientX
      sy = t.clientY
      axis = null
      dragging = true
    }
    const onMove = (e: TouchEvent) => {
      if (!dragging) return
      const t = e.touches[0]
      const dx = t.clientX - sx
      const dy = t.clientY - sy
      if (axis === null) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return
        axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'
      }
      if (axis !== 'x') return
      e.preventDefault()
      const cur = live.current.page
      let d = dx
      // 到顶/到底时加阻尼（橡皮筋），告诉用户没有下一页了
      if ((cur === 0 && d > 0) || (cur === live.current.pageCount - 1 && d < 0)) d *= 0.35
      setDrag(d)
    }
    const onEnd = () => {
      if (!dragging) return
      dragging = false
      if (axis !== 'x') {
        setDrag(0)
        return
      }
      const w = el.clientWidth || 1
      const cur = live.current.page
      const ratio = dragPxRef.current / w
      const canNext = cur < live.current.pageCount - 1
      const canPrev = cur > 0
      let target: 'next' | 'prev' | null = null
      if (ratio < -SLIDE_SNAP_RATIO && canNext) target = 'next'
      else if (ratio > SLIDE_SNAP_RATIO && canPrev) target = 'prev'

      suppressClickRef.current = true
      if (!target) {
        beginSnap('back')
        return
      }
      beginSnap(target)
    }

    el.addEventListener('touchstart', onStart, { passive: true })
    el.addEventListener('touchmove', onMove, { passive: false })
    el.addEventListener('touchend', onEnd)
    el.addEventListener('touchcancel', onEnd)
    return () => {
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchmove', onMove)
      el.removeEventListener('touchend', onEnd)
      el.removeEventListener('touchcancel', onEnd)
    }
  }, [pageMode])

  function go(dir: FlipDir) {
    if (flip || gesturesDisabled || snapRef.current) return
    const to = dir === 'next' ? page + 1 : page - 1
    if (to < 0 || to >= pageCount) return
    if (pageMode === 'slide') {
      beginSnap(dir)
      return
    }
    committedRef.current = false
    setFlip({ from: page, to, dir })
  }

  function commit() {
    if (!flip || committedRef.current) return
    committedRef.current = true
    lastCalcRef.current = flip.to
    onPage(flip.to)
    setFlip(null)
  }

  /**
   * 单击（V3.0 需求一/三）：只负责 Toggle 控制中心，不再做「左右 1/4 翻页」。
   * 加时间阈值（长按选词不算单击）与位移阈值（滑动翻页不算单击）防误触。
   */
  function handleClick(e: React.MouseEvent<HTMLDivElement>) {
    if (flip || snap || suppressClickRef.current) {
      suppressClickRef.current = false
      return
    }
    const s = tapRef.current
    tapRef.current = null
    if (s) {
      if (Date.now() - s.t > TAP_MAX_MS) return
      if (Math.hypot(e.clientX - s.x, e.clientY - s.y) > TAP_MOVE_PX) return
    }
    onTapCenter()
  }

  function handleTouchStart(e: React.TouchEvent) {
    if (e.touches.length !== 1) return
    const t = e.touches[0]
    touchStart.current = { x: t.clientX, y: t.clientY }
    tapRef.current = { t: Date.now(), x: t.clientX, y: t.clientY }
  }

  function handleTouchEnd(e: React.TouchEvent) {
    const start = touchStart.current
    touchStart.current = null
    if (!start || flip || gesturesDisabled || pageMode === 'scroll' || pageMode === 'slide') return
    const t = e.changedTouches[0]
    const dx = t.clientX - start.x
    const dy = t.clientY - start.y
    if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(dy) * 1.5) {
      suppressClickRef.current = true
      go(dx < 0 ? 'next' : 'prev')
    }
  }

  /* ---------------- scroll 模式：滚动反算页码 ---------------- */
  function handleScroll() {
    if (pageMode !== 'scroll') return
    const el = scrollerRef.current
    if (!el || pageCount <= 1) return
    const max = el.scrollHeight - el.clientHeight
    const ratio = max > 0 ? el.scrollTop / max : 0
    const calc = Math.min(pageCount - 1, Math.round(ratio * (pageCount - 1)))
    if (calc !== lastCalcRef.current) {
      lastCalcRef.current = calc
      onPage(calc)
    }
  }

  /* ---------------- 动画层类名（book / cover） ---------------- */
  function layerClasses(f: FlipState): { out: string; in: string } {
    if (f.dir === 'next') {
      switch (pageMode) {
        case 'cover':
          return { out: '', in: 'pf-cover-in' }
        case 'book':
          return { out: 'pf-book-next', in: '' }
        default:
          return { out: '', in: '' }
      }
    }
    switch (pageMode) {
      case 'cover':
        return { out: 'pf-cover-out', in: '' }
      case 'book':
        return { out: '', in: 'pf-book-prev' }
      default:
        return { out: '', in: '' }
    }
  }

  /* ---------------- scroll 模式渲染 ---------------- */
  if (pageMode === 'scroll') {
    return (
      <div className="page-flip-stage min-h-0 flex-1" onClick={handleClick} onTouchStart={handleTouchStart} data-testid="page-flip-scroll">
        <div
          ref={scrollerRef}
          className="page-flip-layer reader-scroll h-full"
          onScroll={handleScroll}
        >
          {renderScroll()}
        </div>
      </div>
    )
  }

  /* ---------------- slide 模式渲染：三页连排轨道 ---------------- */
  if (pageMode === 'slide') {
    const showPrev = page - 1 >= 0
    const showNext = page + 1 < pageCount
    const transition = snap ? 'transform 0.32s cubic-bezier(0.25, 0.8, 0.35, 1)' : 'none'
    const translate =
      snap === 'next' ? '-66.6667%' : snap === 'prev' ? '0%' : `calc(-33.3333% + ${dragPx}px)`
    return (
      <div
        ref={slideStageRef}
        className="page-flip-stage min-h-0 flex-1"
        onClick={handleClick}
        onTouchStart={handleTouchStart}
        data-testid="page-flip-slide"
      >
        <div
          className="pf-track"
          style={{ transform: `translateX(${translate})`, transition }}
          onTransitionEnd={(e) => {
            if (e.target === e.currentTarget && e.propertyName === 'transform') finishSnap()
          }}
        >
          <div className="pf-track-page reader-nobar">{showPrev ? renderPage(page - 1) : null}</div>
          <div className="pf-track-page reader-nobar">{renderPage(page)}</div>
          <div className="pf-track-page reader-nobar">{showNext ? renderPage(page + 1) : null}</div>
        </div>
      </div>
    )
  }

  /* ---------------- book / cover 模式渲染（两页动画） ---------------- */
  return (
    <div
      className={cn('page-flip-stage min-h-0 flex-1', pageMode === 'book' && 'pf-book-stage')}
      onClick={handleClick}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      data-testid={`page-flip-${pageMode}`}
    >
      {flip ? (
        <>
          <div
            className={cn('page-flip-layer pf-fit reader-nobar', layerClasses(flip).out)}
            onAnimationEnd={commit}
          >
            {renderPage(flip.from)}
          </div>
          <div
            className={cn('page-flip-layer pf-fit reader-nobar', layerClasses(flip).in)}
            onAnimationEnd={commit}
          >
            {renderPage(flip.to)}
          </div>
        </>
      ) : (
        <div className="page-flip-layer pf-fit reader-nobar">{renderPage(page)}</div>
      )}
    </div>
  )
}
