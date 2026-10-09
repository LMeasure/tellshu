import { useState, type CSSProperties, type ReactNode } from 'react'
import {
  BookOpen,
  ChevronRight,
  Dices,
  Moon,
  Music,
  Play,
  Pause,
  Square,
  Sun,
  X,
} from 'lucide-react'
import { Sheet } from '@/components/ui/sheet'
import { Segmented } from '@/components/ui/segmented'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  READER_BRIGHTNESS,
  READER_FONT_SIZE,
  READER_LINE_HEIGHT,
  SPEECH_RATE_OPTIONS,
  SPEECH_TIMER_OPTIONS,
  SPEECH_TIMER_LABELS,
  type ReaderPrefs,
} from '@/store/useAppStore'
import { RATIO_OPTIONS, type MaskConfig, type MaskMode, type MaskTarget } from '@/lib/masking'
import { isWeChatBrowser } from '@/lib/speech'

/**
 * 阅读器设置模块 V3.0（2026-10-09 需求二/四）
 * ------------------------------------------------------------------
 * 不再自带 Sheet 外壳：本文件只导出**内容面板**，由「综合控制中心」承载
 * （顶部 5 项导航：目录 / 笔记 / 进度 / 听书 / 设置）。
 *
 *   SettingsPanel —— 设置页：顶部【阅读】/【记忆】双 Tab（条件渲染，不滑动隐藏）
 *      阅读：第一行 字号滑块 + 首行缩进按钮；第二行 行距 + 边距；
 *            合并行 字体 / 背景 / 翻页 等分宽度，显示当前值 + › ，点击弹出选择器。
 *      记忆：隐藏方式 / 比例 / 中英文目标 / 含标点。
 *   ListenPanel —— 听书页：播放/暂停 + 语速 + 刻度定时关闭 + 本集结束后关闭。
 */

export type SettingsTab = 'read' | 'memo'
type PickKind = 'font' | 'bg' | 'page'

const THEME_OPTIONS: { key: ReaderPrefs['theme']; label: string }[] = [
  { key: 'white', label: '纯白' },
  { key: 'sepia', label: '羊皮' },
  { key: 'green', label: '护眼' },
  { key: 'dark', label: '夜间' },
]

const THEME_SWATCH: Record<ReaderPrefs['theme'], string> = {
  white: '#ffffff',
  sepia: '#f5ecd8',
  green: '#dfe8d8',
  dark: '#16191b',
}

const FONT_OPTIONS: { key: ReaderPrefs['fontFamily']; label: string }[] = [
  { key: 'kai', label: '楷体' },
  { key: 'sans', label: '黑体' },
  { key: 'serif', label: '宋体' },
]

const PAGE_MODES: { key: ReaderPrefs['pageMode']; label: string; hint: string }[] = [
  { key: 'slide', label: '平滑', hint: '连续滑动' },
  { key: 'cover', label: '覆盖', hint: '整页盖上' },
  { key: 'book', label: '仿书本', hint: '绕页缘翻出' },
  { key: 'scroll', label: '上下滚动', hint: '连续滚动' },
]

const MARGINS: ReaderPrefs['margin'][] = ['sm', 'md', 'lg']
const MARGIN_SHORT: Record<ReaderPrefs['margin'], string> = { sm: '窄', md: '标准', lg: '宽' }

const MASK_TABS: { key: MaskMode; label: string }[] = [
  { key: 'random', label: '随机隐藏' },
  { key: 'full', label: '完全隐藏' },
  { key: 'manual', label: '自主选择' },
]

const TARGET_TABS: { key: MaskTarget; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'zh', label: '中' },
  { key: 'en', label: '英' },
]

const RATIO_LABEL: Record<number, string> = {
  0.15: '15%',
  0.3: '30%',
  0.45: '45%',
  0.65: '65%',
  0.9: '90%',
}

export interface MemoPanelProps {
  config: MaskConfig
  onChange: (patch: Partial<MaskConfig>) => void
  bilingual: boolean
  onReshuffle: () => void
}

/* ============================ 设置面板 ============================ */

interface SettingsProps {
  tab: SettingsTab
  onTabChange: (t: SettingsTab) => void
  prefs: ReaderPrefs
  onChange: (patch: Partial<ReaderPrefs>) => void
  memo: MemoPanelProps
}

export function SettingsPanel({ tab, onTabChange, prefs, onChange, memo }: SettingsProps) {
  const [picker, setPicker] = useState<PickKind | null>(null)

  const fontLabel = FONT_OPTIONS.find((f) => f.key === prefs.fontFamily)?.label ?? '黑体'
  const pageLabel = PAGE_MODES.find((p) => p.key === prefs.pageMode)?.label ?? '平滑'
  const themeLabel = THEME_OPTIONS.find((t) => t.key === prefs.theme)?.label ?? '纯白'

  return (
    <div className="space-y-5">
      <Segmented<SettingsTab>
        value={tab}
        onChange={onTabChange}
        items={[
          { key: 'read', label: '阅读' },
          { key: 'memo', label: '记忆' },
        ]}
      />

      {tab === 'read' ? (
        <div className="space-y-4">
          {/* 第一行：字号滑块 + 首行缩进按钮 */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <RowLabel text="字体大小" trailing={`${prefs.fontSize}px`} />
              <input
                type="range"
                aria-label="字体大小"
                min={READER_FONT_SIZE.min}
                max={READER_FONT_SIZE.max}
                step={READER_FONT_SIZE.step}
                value={prefs.fontSize}
                onChange={(e) => onChange({ fontSize: Number(e.target.value) })}
                className="range-primary h-9 w-full"
              />
            </div>
            <div>
              <RowLabel text="首行缩进" />
              <IndentButton on={prefs.indent} onClick={() => onChange({ indent: !prefs.indent })} />
            </div>
          </div>

          {/* 第二行：行距 + 边距 */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <RowLabel text="行距" trailing={prefs.lineHeight.toFixed(1)} />
              <input
                type="range"
                aria-label="行距"
                min={READER_LINE_HEIGHT.min}
                max={READER_LINE_HEIGHT.max}
                step={READER_LINE_HEIGHT.step}
                value={prefs.lineHeight}
                onChange={(e) => onChange({ lineHeight: Number(e.target.value) })}
                className="range-primary h-9 w-full"
              />
            </div>
            <div>
              <RowLabel text="边距" trailing={MARGIN_SHORT[prefs.margin]} />
              <input
                type="range"
                aria-label="边距"
                min={0}
                max={MARGINS.length - 1}
                step={1}
                value={Math.max(0, MARGINS.indexOf(prefs.margin))}
                onChange={(e) => onChange({ margin: MARGINS[Number(e.target.value)] })}
                className="range-primary h-9 w-full"
              />
            </div>
          </div>

          {/* 合并行：字体 / 背景 / 翻页 等分宽度，显示当前值 + › */}
          <div className="grid grid-cols-3 gap-2">
            <MergeItem label="字体" value={fontLabel} onClick={() => setPicker('font')} />
            <MergeItem label="背景" value={themeLabel} onClick={() => setPicker('bg')} />
            <MergeItem label="翻页" value={pageLabel} onClick={() => setPicker('page')} />
          </div>
        </div>
      ) : (
        /* ——————— 记忆：记忆功能设置项 ——————— */
        <div className="space-y-5">
          <div>
            <RowLabel icon={BookOpen} text="隐藏方式" />
            <Segmented<MaskMode>
              size="sm"
              value={memo.config.mode}
              onChange={(m) => memo.onChange({ mode: m })}
              items={MASK_TABS}
            />
          </div>

          {memo.config.mode === 'random' && (
            <div>
              <div className="flex items-baseline justify-between">
                <RowLabel text="隐藏比例" trailing={RATIO_LABEL[memo.config.ratio]} />
                <button
                  onClick={memo.onReshuffle}
                  className="mb-1 flex items-center gap-1 rounded-full bg-secondary px-2.5 py-1 text-xs text-secondary-foreground touch-target-sm"
                >
                  <Dices className="h-3.5 w-3.5" /> 换一批
                </button>
              </div>
              <input
                type="range"
                aria-label="隐藏比例"
                min={0}
                max={RATIO_OPTIONS.length - 1}
                step={1}
                value={Math.max(0, RATIO_OPTIONS.findIndex((r) => r === memo.config.ratio))}
                onChange={(e) => memo.onChange({ ratio: RATIO_OPTIONS[Number(e.target.value)] })}
                className="range-primary h-9 w-full"
              />
            </div>
          )}

          {memo.config.mode === 'random' && memo.bilingual && (
            <div>
              <RowLabel text="隐藏哪一门" />
              <div className="flex gap-1.5">
                {TARGET_TABS.map((t) => (
                  <ChoiceChip
                    key={t.key}
                    label={t.label}
                    active={(memo.config.target ?? 'all') === t.key}
                    onClick={() => memo.onChange({ target: t.key })}
                    compact
                  />
                ))}
              </div>
            </div>
          )}

          {memo.config.mode === 'full' && (
            <div>
              <RowLabel text="标点" />
              <Segmented<'no-punc' | 'with-punc'>
                size="sm"
                value={memo.config.hidePunctuation ? 'with-punc' : 'no-punc'}
                onChange={(v) => memo.onChange({ hidePunctuation: v === 'with-punc' })}
                items={[
                  { key: 'no-punc', label: '不含标点' },
                  { key: 'with-punc', label: '含标点' },
                ]}
              />
            </div>
          )}

          {memo.config.mode === 'manual' && (
            <p className="rounded-xl bg-secondary/60 p-3 text-xs text-muted-foreground">
              在正文里点按或横向滑动选词（再滑一次取消），选好后回到正文点「完成选择」开始默写。
            </p>
          )}

          <p className="border-t border-border pt-3 text-xs text-muted-foreground">
            默写的计时、清空、核验、录音按钮都在正文里，随当前页操作。
          </p>
        </div>
      )}

      {/* —— 选择器（点击合并行弹出）—— */}
      <PickerSheet
        open={picker !== null}
        title={picker === 'font' ? '字体' : picker === 'bg' ? '背景' : '翻页方式'}
        onClose={() => setPicker(null)}
      >
        {picker === 'font' && (
          <div className="grid grid-cols-3 gap-2">
            {FONT_OPTIONS.map((f) => (
              <ChoiceChip
                key={f.key}
                label={f.label}
                active={prefs.fontFamily === f.key}
                onClick={() => {
                  onChange({ fontFamily: f.key })
                  setPicker(null)
                }}
                style={{ fontFamily: FONT_PREVIEW[f.key] }}
              />
            ))}
          </div>
        )}
        {picker === 'page' && (
          <div className="grid grid-cols-2 gap-2">
            {PAGE_MODES.map((p) => (
              <button
                key={p.key}
                onClick={() => {
                  onChange({ pageMode: p.key })
                  setPicker(null)
                }}
                aria-pressed={prefs.pageMode === p.key}
                className={cn(
                  'rounded-xl border px-3 py-2.5 text-left touch-target',
                  prefs.pageMode === p.key ? 'border-primary bg-primary/10' : 'border-border bg-card',
                )}
              >
                <div className="text-sm font-medium">{p.label}</div>
                <div className="text-[11px] text-muted-foreground">{p.hint}</div>
              </button>
            ))}
          </div>
        )}
        {picker === 'bg' && (
          <div className="space-y-4">
            <div>
              <RowLabel icon={Sun} text="亮度" trailing={`${Math.round(prefs.brightness * 100)}%`} />
              <div className="flex items-center gap-3">
                <Sun className="h-4 w-4 text-muted-foreground" />
                <input
                  type="range"
                  aria-label="亮度"
                  min={READER_BRIGHTNESS.min}
                  max={READER_BRIGHTNESS.max}
                  step={READER_BRIGHTNESS.step}
                  value={prefs.brightness}
                  onChange={(e) => onChange({ brightness: Number(e.target.value) })}
                  className="range-primary h-9 flex-1"
                />
                <Moon className="h-4 w-4 text-muted-foreground" />
              </div>
            </div>
            <div className="grid grid-cols-4 gap-2">
              {THEME_OPTIONS.map((t) => (
                <button
                  key={t.key}
                  onClick={() => {
                    onChange({ theme: t.key })
                    setPicker(null)
                  }}
                  aria-pressed={prefs.theme === t.key}
                  aria-label={`主题：${t.label}`}
                  title={`主题：${t.label}`}
                  className={cn(
                    'flex h-14 items-center justify-center rounded-xl border-2 touch-target',
                    prefs.theme === t.key ? 'border-primary' : 'border-border',
                  )}
                  style={{ background: THEME_SWATCH[t.key] }}
                >
                  {t.key === 'dark' && <Moon className="h-4 w-4 text-primary" />}
                </button>
              ))}
            </div>
          </div>
        )}
      </PickerSheet>
    </div>
  )
}

/* ============================ 听书面板 ============================ */

export interface ListenPanelProps {
  speechSupported: boolean
  listening: boolean
  paused: boolean
  onToggle: () => void
  onStop: () => void
  speechRate: number
  onSpeechRateChange: (r: number) => void
  timerMin: number
  onTimerChange: (m: number) => void
  stopAtEnd: boolean
  onStopAtEndChange: (v: boolean) => void
  remainingSec: number | null
}

export function ListenPanel({
  speechSupported,
  listening,
  paused,
  onToggle,
  onStop,
  speechRate,
  onSpeechRateChange,
  timerMin,
  onTimerChange,
  stopAtEnd,
  onStopAtEndChange,
  remainingSec,
}: ListenPanelProps) {
  const playing = listening && !paused
  if (!speechSupported) {
    return (
      <p className="rounded-xl bg-secondary/60 p-3 text-sm text-muted-foreground">
        当前浏览器不支持语音合成，无法使用听书（可换 Chrome / Edge，或升级系统浏览器）。
      </p>
    )
  }

  return (
    <div className="space-y-5">
      {/* 播放控制：音符图标 + 播放/暂停 */}
      <div className="flex items-center gap-3 rounded-2xl bg-secondary/50 p-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-full bg-primary/12 text-primary">
          <Music className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">
            {playing ? '正在朗读' : paused ? '已暂停' : '听书'}
          </div>
          <div className="text-[11px] text-muted-foreground">
            {remainingSec !== null ? `播放 ${fmtClock(remainingSec)} 后关闭` : '点下方按钮开始'}
          </div>
        </div>
        <Button variant={playing ? 'accent' : 'primary'} onClick={onToggle} className="shrink-0">
          {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          {playing ? '暂停' : paused ? '继续' : '播放'}
        </Button>
        {listening && (
          <Button variant="outline" onClick={onStop} className="shrink-0">
            <Square className="h-4 w-4" /> 停止
          </Button>
        )}
      </div>

      {/* 定时关闭：刻度滑杆 关 / 30 / 60 / 90（15 / 45 为小刻度） */}
      <div className="rounded-2xl bg-secondary/60 p-3">
        <div className="mb-1 flex items-baseline justify-between">
          <span className="text-sm font-medium">
            {playing && remainingSec !== null ? `播放 ${fmtClock(remainingSec)} 后关闭` : '定时关闭'}
          </span>
          <span className="text-xs font-semibold tabular-nums text-primary">
            {timerMin > 0 ? `${timerMin} 分钟` : '关'}
          </span>
        </div>
        <TickSlider
          options={SPEECH_TIMER_OPTIONS}
          value={timerMin}
          onChange={onTimerChange}
          labelOf={(v) => (v === 0 ? '关' : String(v))}
          majorSet={SPEECH_TIMER_LABELS}
        />
      </div>

      {/* 本集结束后关闭 */}
      <button
        onClick={() => onStopAtEndChange(!stopAtEnd)}
        aria-pressed={stopAtEnd}
        className={cn(
          'flex w-full items-center justify-between rounded-2xl border px-4 py-3 text-left touch-target',
          stopAtEnd ? 'border-primary bg-primary/10' : 'border-border bg-card',
        )}
      >
        <span>
          <span className="block text-sm font-medium">本集结束后关闭</span>
          <span className="block text-[11px] text-muted-foreground">
            {stopAtEnd ? '读完本集自动停止' : '读完自动续读下一章'}
          </span>
        </span>
        <span
          className={cn(
            'relative h-6 w-11 shrink-0 rounded-full transition-colors',
            stopAtEnd ? 'bg-primary' : 'bg-muted-foreground/30',
          )}
        >
          <span
            className={cn(
              'absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all',
              stopAtEnd ? 'left-[22px]' : 'left-0.5',
            )}
          />
        </span>
      </button>

      {/* 语速 */}
      <div>
        <RowLabel text="语速" trailing={`${speechRate}x`} />
        <div className="flex gap-1.5">
          {SPEECH_RATE_OPTIONS.map((r) => (
            <ChoiceChip
              key={r}
              label={`${r}x`}
              active={speechRate === r}
              onClick={() => onSpeechRateChange(r)}
              compact
            />
          ))}
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        听书时单击正在朗读的句子可暂停，再点一次继续。
      </p>

      {isWeChatBrowser() && (
        <p className="rounded-xl bg-amber-500/12 p-3 text-xs text-amber-700">
          微信内置浏览器对语音合成支持不稳定，听书常无声且无报错。请点右上角「···」→「在浏览器打开」后再听。
        </p>
      )}
    </div>
  )
}

/* ============================ 原子组件 ============================ */

const FONT_PREVIEW: Record<ReaderPrefs['fontFamily'], string> = {
  kai: '"Kaiti SC", KaiTi, STKaiti, serif',
  sans: 'system-ui, "PingFang SC", "Microsoft YaHei", sans-serif',
  serif: '"Songti SC", SimSun, "Noto Serif SC", serif',
}

function fmtClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const mm = String(Math.floor(s / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return `${mm}:${ss}`
}

function RowLabel({
  icon: Icon,
  text,
  trailing,
}: {
  icon?: typeof Sun
  text: string
  trailing?: string
}) {
  return (
    <div className="mb-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
      {Icon && <Icon className="h-3.5 w-3.5" />}
      <span>{text}</span>
      {trailing && <span className="ml-auto font-semibold tabular-nums text-primary">{trailing}</span>}
    </div>
  )
}

/**
 * 首行缩进按钮（需求二·严格按此设计）：
 *   未开启 = 绿框 + 白底 + 绿字；已开启 = 绿框 + 绿底 + 白字。
 */
function IndentButton({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      aria-label={on ? '关闭首行缩进' : '开启首行缩进'}
      className={cn(
        'flex h-9 w-full items-center justify-center rounded-xl border text-sm font-medium transition-colors touch-target',
        on
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-primary bg-card text-primary',
      )}
    >
      {on ? '首行缩进 开' : '首行缩进 关'}
    </button>
  )
}

/** 合并行条目：小标签 + 「当前值 ›」 */
function MergeItem({ label, value, onClick }: { label: string; value: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={`${label}：${value}`}
      className="flex min-w-0 flex-col items-start gap-1 rounded-xl bg-secondary/40 px-3 py-2.5 text-left touch-target"
    >
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className="flex w-full min-w-0 items-center justify-between text-sm font-medium">
        <span className="truncate">{value}</span>
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
      </span>
    </button>
  )
}

/** 简易选择器弹层（合并行点击后弹出） */
function PickerSheet({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
}) {
  return (
    <Sheet open={open} onClose={onClose}>
      <div className="mb-3 flex items-center justify-between">
        <span className="text-base font-semibold">{title}</span>
        <button
          onClick={onClose}
          aria-label="关闭"
          title="关闭"
          className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-secondary"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      {children}
    </Sheet>
  )
}

function ChoiceChip({
  label,
  active,
  onClick,
  compact,
  style,
}: {
  label: string
  active: boolean
  onClick: () => void
  compact?: boolean
  style?: CSSProperties
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      style={style}
      className={cn(
        'rounded-xl border text-center touch-target',
        compact ? 'flex-1 py-2 text-sm' : 'py-2.5 text-base',
        active ? 'border-primary bg-primary/10 font-medium text-primary' : 'border-border bg-card',
      )}
    >
      {label}
    </button>
  )
}

/**
 * 刻度滑杆（定时关闭）：药丸轨道 + 刻度线 + 圆形拇指 + 当前值气泡。
 * 用「下标 range」驱动，刻度与拇指按同一套 calc 定位，两端对齐。
 */
export function TickSlider({
  options,
  value,
  onChange,
  labelOf,
  majorSet,
}: {
  options: readonly number[]
  value: number
  onChange: (v: number) => void
  labelOf: (v: number) => string
  majorSet: Set<number>
}) {
  const idx = Math.max(0, options.indexOf(value))
  const last = options.length - 1
  const leftOf = (i: number) => `calc(12px + (100% - 24px) * ${last === 0 ? 0 : i / last})`

  const marks: ReactNode = (
    <>
      {options.map((o, i) => {
        const major = majorSet.has(o)
        return (
          <span
            key={o}
            className="pointer-events-none absolute top-1/2 -translate-x-1/2 -translate-y-1/2 text-center"
            style={{ left: leftOf(i) }}
          >
            <span
              className={cn(
                'mx-auto block w-px',
                major ? 'h-3 bg-muted-foreground/40' : 'h-2 bg-muted-foreground/25',
              )}
              aria-hidden
            />
            {major && (
              <span className="mt-4 block text-xs tabular-nums text-muted-foreground">{labelOf(o)}</span>
            )}
          </span>
        )
      })}
      <span
        className="pointer-events-none absolute top-1/2 z-10 flex h-9 w-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white text-sm font-semibold text-foreground shadow-soft ring-1 ring-black/5"
        style={{ left: leftOf(idx) }}
      >
        {labelOf(value)}
      </span>
    </>
  )

  return (
    <div className="relative h-16">
      <div
        className="pointer-events-none absolute inset-x-3 top-1/2 h-9 -translate-y-1/2 rounded-full bg-muted"
        aria-hidden
      />
      {marks}
      <input
        type="range"
        aria-label="定时关闭"
        min={0}
        max={last}
        step={1}
        value={idx}
        onChange={(e) => onChange(options[Number(e.target.value)])}
        className="tick-range absolute inset-x-3 top-1/2 h-9 -translate-y-1/2"
      />
    </div>
  )
}
