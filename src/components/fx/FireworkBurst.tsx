import { useEffect, useMemo, useRef } from 'react'
import type { CSSProperties } from 'react'

/**
 * 完成庆祝：烟花绽放小动画（学习页完成弹窗专用，见 2026-10-06 学习页改动）。
 *
 * - 纯 CSS 实现（keyframes 在 index.css 的 fw-* 段），不引第三方库。
 * - 父级用条件渲染控制挂载/卸载：挂载即放，放完自动回调 onDone。
 * - 时间线：第 i 朵 delay = i × STAGGER；亮点上升 RISE_MS 后在原位绽放，
 *   粒子从中心炸开淡出。整体约 3.4s，onDone 在最后粒子消散后触发。
 * - prefers-reduced-motion: reduce 时 CSS 直接隐藏舞台（index.css 兜底）。
 */

/** 烟花颜色：主题绿 + EasyMad 黄绿 + 暖橙 + 白，全部取自 App 视觉样板 */
const PALETTE = ['#45b649', '#dce35b', '#f59e0b', '#ffffff', '#22c55e'] as const

/** 烟花朵数与节奏（s） */
const BURST_COUNT = 6
const STAGGER_S = 0.32
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

function makeBursts(): Burst[] {
  return Array.from({ length: BURST_COUNT }, (_, i) => {
    const count = Math.round(rand(20, 26))
    const baseDist = rand(58, 104)
    return {
      x: rand(10, 90),
      rise: rand(-56, -38),
      delay: i * STAGGER_S,
      color: PALETTE[i % PALETTE.length],
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
