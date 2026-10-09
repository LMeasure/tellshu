import type { SVGProps } from 'react'

/**
 * 述树自绘图标集（对应需求截图的 1–11 号图标）
 * ------------------------------------------------------------------
 * 设计约定（与参考图标一致）：
 *   - 24×24 视窗，strokeWidth 2，圆角线帽（round cap/join）
 *   - 线性图标用 stroke=currentColor；实心图标（首页 / 我的 / 收藏星 / 信封）用 fill=currentColor
 *   - 图标本身不携带语义：必须由外层按钮提供 aria-label + title（项目红线）
 *
 * 用途登记（每个图标只干一件事，不为了好看加功能）：
 *   IconDiscover   1号  发现 Tab（知识网络节点）
 *   IconReviewCards 2号  复习 Tab（翻卡/卡片叠）
 *   IconHomeSolid  3号  首页 Tab（实心房）
 *   IconUserSolid  4号  我的 Tab（实心人）
 *   IconBack       5号  页面左上角返回
 *   IconForward    6号  单词卡右侧「去详情页」
 *   IconStarMark   8号  收藏（加入生词本）：实心橙=已收藏，空心=未收藏
 *   IconExpandCrown 9号 例句展开
 *   IconCollapseBars   例句收起（两条平杠，与 9 号同风格）
 *   IconReset      10号 重置 / 重新开始（阅读器清空本页、错误重试）
 *   IconMailSolid  11号 我的页消息入口
 *   IconSeqPlay        连续朗读全部例句（播放列表）
 *   IconImport         导入素材（托盘 + 下箭）
 * 书籍类图标维持 lucide 的 BookOpen（需求：书籍保持原有图标）。
 */

type IconProps = SVGProps<SVGSVGElement>

/** 线性图标公共外框：strokeWidth 2 + 圆头，保证整套图标风格统一 */
function StrokeIcon({ children, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  )
}

/** 1号 · 发现：中心节点向四周辐射连接（知识网络） */
export function IconDiscover(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <circle cx="12" cy="12" r="2.1" fill="currentColor" stroke="none" />
      <path d="M10.6 10.3 6.2 6.9" />
      <path d="M13.4 10.3l4.4-3.4" />
      <path d="M10.4 13.4l-3.6 3.4" />
      <path d="M13.6 13.4l3.8 3.2" />
      <circle cx="5.2" cy="6" r="1.7" fill="currentColor" stroke="none" />
      <circle cx="18.8" cy="6" r="1.7" fill="currentColor" stroke="none" />
      <circle cx="5.8" cy="17.9" r="1.7" fill="currentColor" stroke="none" />
      <circle cx="18.4" cy="17.6" r="1.7" fill="currentColor" stroke="none" />
    </StrokeIcon>
  )
}

/** 2号 · 复习：上下叠放的两张翻卡 */
export function IconReviewCards(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <path d="M7.6 6.9V6a2 2 0 0 1 2-2h8.5a2 2 0 0 1 2 2v8.2a2 2 0 0 1-2 2h-.9" />
      <rect x="3.9" y="6.9" width="13.3" height="13.1" rx="2" />
    </StrokeIcon>
  )
}

/** 3号 · 首页：实心小房（带门洞） */
export function IconHomeSolid(props: IconProps) {
  return (
    <StrokeIcon {...props} fill="currentColor" stroke="none">
      <path d="M12 3.2 21 10.9h-2.1v8.4a1.5 1.5 0 0 1-1.5 1.5h-3.2v-6.2H9.8v6.2H6.6a1.5 1.5 0 0 1-1.5-1.5v-8.4H3Z" />
    </StrokeIcon>
  )
}

/** 4号 · 我的：实心人形（头 + 肩） */
export function IconUserSolid(props: IconProps) {
  return (
    <StrokeIcon {...props} fill="currentColor" stroke="none">
      <circle cx="12" cy="7.2" r="3.9" />
      <path d="M12 12.9c-4.5 0-7.6 2.9-7.6 6.3 0 1 .6 1.6 1.6 1.6h12c1 0 1.6-.6 1.6-1.6 0-3.4-3.1-6.3-7.6-6.3Z" />
    </StrokeIcon>
  )
}

/** 5号 · 返回：细左箭头 */
export function IconBack(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <path d="M14.8 5.3 8.1 12l6.7 6.7" />
    </StrokeIcon>
  )
}

/** 6号 · 去详情页：细右箭头 */
export function IconForward(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <path d="m9.2 5.3 6.7 6.7-6.7 6.7" />
    </StrokeIcon>
  )
}

/**
 * 8号 · 收藏星：filled=true 实心（已收藏，配合 text-accent 呈橙色），
 * false 空心描边（未收藏）。
 */
export function IconStarMark({ filled = false, ...props }: IconProps & { filled?: boolean }) {
  return (
    <StrokeIcon {...props} fill={filled ? 'currentColor' : 'none'}>
      <path d="m12 3.4 2.5 5.2 5.8.8-4.2 4 1 5.7-5.1-2.7-5.1 2.7 1-5.7-4.2-4 5.8-.8Z" />
    </StrokeIcon>
  )
}

/** 9号 · 展开：圆角方框内双下箭头（例句展开） */
export function IconExpandCrown(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <rect x="3.6" y="3.6" width="16.8" height="16.8" rx="4.4" />
      <path d="m8.7 9.3 3.3 3.2 3.3-3.2" />
      <path d="m8.7 13.5 3.3 3.2 3.3-3.2" />
    </StrokeIcon>
  )
}

/** 收起：圆角方框内两条平杠（与 9 号同框同风格） */
export function IconCollapseBars(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <rect x="3.6" y="3.6" width="16.8" height="16.8" rx="4.4" />
      <path d="M8.4 10.2h7.2" />
      <path d="M8.4 13.8h7.2" />
    </StrokeIcon>
  )
}

/** 10号 · 重置 / 重新开始：逆时针回转箭头 */
export function IconReset(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <path d="M3.4 4.2v5h5" />
      <path d="M4.6 9.2a8.3 8.3 0 1 1-1 4" />
    </StrokeIcon>
  )
}

/** 11号 · 消息：实心信封（盖边用负线划出封盖） */
export function IconMailSolid(props: IconProps) {
  return (
    <StrokeIcon {...props} fill="currentColor" stroke="none">
      <rect x="3" y="5.2" width="18" height="13.6" rx="2.2" />
      <path
        d="m4.6 7.4 7.4 5.4 7.4-5.4"
        fill="none"
        stroke="hsl(var(--card))"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </StrokeIcon>
  )
}

/** 连续播放：播放列表（三行词单 + 右下播放角标）——只用于「连续朗读全部例句」 */
export function IconSeqPlay(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <path d="M4.6 6.4h10.2" />
      <path d="M4.6 11.4h10.2" />
      <path d="M4.6 16.4h6.2" />
      <path d="M14.8 14.6v6l4.9-3Z" fill="currentColor" stroke="none" />
    </StrokeIcon>
  )
}

/** 导入：托盘 + 下箭（把素材收进来）；替代原 Upload 图标 */
export function IconImport(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <path d="M4.4 14.6v3.6a2 2 0 0 0 2 2h11.2a2 2 0 0 0 2-2v-3.6" />
      <path d="M12 3.8v9.4" />
      <path d="m8.4 9.8 3.6 3.6 3.6-3.6" />
    </StrokeIcon>
  )
}
