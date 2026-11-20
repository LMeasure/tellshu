import { useEffect, useMemo, useRef } from 'react'
import type { CSSProperties } from 'react'

/**
 * 完成庆祝：烟花绽放小动画（2026-10-06 学习页改动；10-21 加密密度 + 扩配色）。
 * 学习页点「完成」→ 回主页时由 Home 挂载播放（不放学习页，否则导航即卸载）。
 *
 * - 纯 CSS 实现（keyframes 在 index.css 的 fw-* 段），不引第三方库。
 * - 父级用条件渲染控制挂载/卸载：挂载即放，放完自动回调 onDone。
 * - 时间线：第 i 朵 delay = i × STAGGER；亮点上升 RISE_S 后在原位绽放，
 *   粒子从中心炸开淡出。整体约 3.6s，onDone 在最后粒子消散后触发。
 * - prefers-reduced-motion: reduce 时 CSS 直接隐藏舞台（index.css 兜底）。
 */

/**
 * 烟花颜色（加权随机，绿/黄绿系为主、暖色点缀、白与淡粉少量）：
 * 主题绿与 EasyMad 黄绿是产品色，金/橙/翠绿承接庆祝感，
 * 淡粉一点春意；白色粒子带淡绿外阴影保证浅底可见。
 */
const PALETTE: Array<{ c: string; w: number }> = [
  { c: '#45b649', w: 3 }, // 主题绿
  { c: '#dce35b', w: 3 }, // EasyMad 黄绿
  { c: '#f59e0b', w: 2 }, // 暖橙
  { c: '#fbbf24', w: 2 }, // 金黄
  { c: '#22c55e', w: 2 }, // 翠绿
  { c: '#ffffff', w: 2 }, // 白
  { c: '#f472b6', w: 1 }, // 淡粉（点缀）
]

/** 烟花朵数与节奏（s） */
const BURST_COUNT = 11
const STAGGER_S = 0.16
/** 亮点上升时长（s） */
const RISE_S = 0.62
/** 粒子飞散时长（s） */
const FLY_S = 1.15

interface Particle {
  angle: number
  dist: number
  size: number
  delayJitter: number
}

interface Burst {
  /** 水平位置（%） */
  x: number
  /** 上升高度（vh） */
  rise: number
  /** 起爆延迟（s） */
  delay: number
  color: string
  /** 粒子飞散基准距离（px） */
  dist: number
  particles: Particle[]
}

function rand(min: number, max: number) {
  return min + Math.random() * (max - min)
}

/** 按权重取一个颜色 */
function pickColor() {
  const total = PALETTE.reduce((s, p) => s + p.w, 0)
  let r = Math.random() * total
  for (const p of PALETTE) {
    r -= p.w
    if (r <= 0) return p.c
  }
  return PALETTE[0].c
}

function makeBursts(): Burst[] {
  return Array.from({ length: BURST_COUNT }, (_, i) => {
    const count = Math.round(rand(26, 34))
    const baseDist = rand(52, 118)
    return {
      x: rand(6, 94),
      rise: rand(-62, -30),
      delay: i * STAGGER_S,
      color: pickColor(),
      dist: baseDist,
      particles: Array.from({ length: count }, (_, p) => ({
        angle: (360 / count) * p + rand(-9, 9),
        dist: baseDist * rand(0.72, 1.12),
        size: rand(3.5, 6),
        delayJitter: rand(0, 0.06),
      })),
    }
  })
}

/** 全部粒子消散的总时长（ms），供测试与 onDone 定时对齐 */
export const FIREWORK_TOTAL_MS = Math.round(
  ((BURST_COUNT - 1) * STAGGER_S + RISE_S + FLY_S + 0.25) * 1000,
)

export function FireworkBurst({ onDone }: { onDone?: () => void }) {
  const bursts = useMemo(makeBursts, [])
  // onDone 存 ref，定时器只挂一次，避免父级重渲染重放
  const doneRef = useRef(onDone)
  doneRef.current = onDone

  useEffect(() => {
    const t = setTimeout(() => doneRef.current?.(), FIREWORK_TOTAL_MS)
    return () => clearTimeout(t)
  }, [])

  return (
    <div className="fw-stage" aria-hidden="true">
      {bursts.map((b, bi) => (
        <div key={bi} className="fw-rocket" style={{ left: `${b.x}%` }}>
          {/* 上升亮点：从屏幕底升到绽放高度 */}
          <span
            className="fw-dot"
            style={{ '--rise': `${b.rise}vh`, animationDelay: `${b.delay}s` } as CSSProperties}
          />
          {/* 绽放中心：静态定位在上升终点，--d 控制光晕与粒子的起爆时刻 */}
          <span
            className="fw-burst"
            style={
              {
                '--rise': `${b.rise}vh`,
                '--d': `${b.delay + RISE_S + 0.02}s`,
                '--color': b.color,
              } as CSSProperties
            }
          >
            {b.particles.map((p, pi) => (
              <i
                key={pi}
                className="fw-p"
                style={
                  {
                    '--angle': `${p.angle}deg`,
                    '--dist': `${p.dist}px`,
                    width: `${p.size}px`,
                    height: `${p.size}px`,
                    animationDelay: `calc(var(--d) + ${p.delayJitter.toFixed(3)}s)`,
                    animationDuration: `${(FLY_S * rand(0.9, 1.15)).toFixed(3)}s`,
                  } as CSSProperties
                }
              />
            ))}
          </span>
        </div>
      ))}
    </div>
  )
}
