import { cn } from '@/lib/utils'

/**
 * 书签柳条（2026-10-07 需求 6）
 * ------------------------------------------------------------------
 * 有书签的页面：从顶部垂下的一条柳枝（茎 + 五片柳叶），挂在页面右上角。
 * 纯 SVG 装饰，pointer-events:none 不挡点击；添加/移除时带垂下动画。
 */
export function BookmarkRibbon({ animate = false }: { animate?: boolean }) {
  return (
    <svg
      viewBox="0 0 64 150"
      className={cn('bookmark-ribbon right-5', animate && 'animate')}
      aria-hidden="true"
      data-testid="bookmark-ribbon"
    >
      {/* 茎：从顶部垂下、微微摆动的弧线 */}
      <path
        d="M32 0 C 36 40, 30 90, 26 146"
        fill="none"
        stroke="hsl(152 56% 40%)"
        strokeWidth="3"
        strokeLinecap="round"
      />
      {/* 柳叶：沿茎交错分布 */}
      {[
        { x: 33, y: 26, r: -38 },
        { x: 32, y: 46, r: 142 },
        { x: 31, y: 66, r: -30 },
        { x: 28, y: 92, r: 150 },
        { x: 27, y: 114, r: -24 },
      ].map((leaf, i) => (
        <ellipse
          key={i}
          cx={leaf.x}
          cy={leaf.y}
          rx="5"
          ry="14"
          transform={`rotate(${leaf.r} ${leaf.x} ${leaf.y})`}
          fill="hsl(152 56% 40%)"
          opacity={0.92 - i * 0.06}
        />
      ))}
    </svg>
  )
}
