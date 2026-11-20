import { useNavigate } from 'react-router-dom'
import {
  ArrowLeft,
  ChevronRight,
  Moon,
  Languages,
  Gauge,
  ScanLine,
  Volume2,
  ListOrdered,
  Repeat,
} from 'lucide-react'
import { Card, CardBody } from '@/components/ui/card'
import { SourceAttribution } from '@/components/SourceAttribution'
import { useAppStore, BATCH_SIZE_OPTIONS, REPLAY_SCOPE_OPTIONS } from '@/store/useAppStore'
import type { SettingsState } from '@/store/useAppStore'
import { cn } from '@/lib/utils'

function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'relative h-6 w-11 rounded-full transition-colors touch-target',
        on ? 'bg-primary' : 'bg-muted',
      )}
    >
      <span
        className={cn(
          'absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform',
          on ? 'translate-x-5' : 'translate-x-0.5',
        )}
      />
    </button>
  )
}

function Row({
  icon: Icon,
  label,
  children,
}: {
  icon: typeof Moon
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between py-3">
      <div className="flex items-center gap-3">
        <Icon className="h-5 w-5 text-primary" />
        <span className="text-sm">{label}</span>
      </div>
      {children}
    </div>
  )
}

/** 设置：中文辅助开关 / 语速 / 口音 / 深色模式（见 04 §2.7、05 §2.7，均为本地生效） */
export function Settings() {
  const navigate = useNavigate()
  const settings = useAppStore((s) => s.settings)
  const toggleDarkMode = useAppStore((s) => s.toggleDarkMode)
  const setSetting = useAppStore((s) => s.setSetting)

  const Segment = <K extends keyof SettingsState>({
    value,
    options,
    onPick,
  }: {
    value: SettingsState[K]
    options: { v: SettingsState[K]; label: string }[]
    onPick: (v: SettingsState[K]) => void
  }) => (
    <div className="flex gap-1 rounded-lg bg-muted p-1">
      {options.map((o) => (
        <button
          key={String(o.v)}
          onClick={() => onPick(o.v)}
          className={cn(
            'rounded-md px-3 py-1 text-xs font-medium touch-target',
            value === o.v ? 'bg-card text-foreground shadow-soft' : 'text-muted-foreground',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )

  return (
    <div className="px-4 py-4">
      <div className="mb-3 flex items-center gap-2 text-lg font-semibold">
        <ArrowLeft className="h-5 w-5" /> 设置
      </div>

      <Card>
        <CardBody className="divide-y divide-border">
          <Row icon={Moon} label="深色模式">
            <Toggle on={settings.darkMode} onClick={toggleDarkMode} />
          </Row>
          <Row icon={Languages} label="中文辅助（控制助记提示；例句中文释义常驻显示）">
            <Toggle on={settings.chineseAssist} onClick={() => setSetting('chineseAssist', !settings.chineseAssist)} />
          </Row>
          <Row icon={Gauge} label="音频语速">
            <Segment<'speed'>
              value={settings.speed}
              options={[
                { v: 'slow', label: '慢速' },
                { v: 'normal', label: '常速' },
              ]}
              onPick={(v) => setSetting('speed', v)}
            />
          </Row>
          <Row icon={Volume2} label="发音口音">
            <Segment<'accent'>
              value={settings.accent}
              options={[
                { v: 'en-US', label: '美式' },
                { v: 'en-GB', label: '英式' },
              ]}
              onPick={(v) => setSetting('accent', v)}
            />
          </Row>

          {/* 需求【5】：双击句子重读，读完这一句之后要不要继续 */}
          <div className="py-3">
            <div className="mb-2 flex items-center gap-3">
              <Repeat className="h-5 w-5 text-primary" />
              <span className="text-sm">双击句子重读后</span>
            </div>
            <div className="flex gap-1 rounded-lg bg-muted p-1">
              {REPLAY_SCOPE_OPTIONS.map((o) => (
                <button
                  key={o.v}
                  onClick={() => setSetting('replayScope', o.v)}
                  className={cn(
                    'flex-1 rounded-md py-1 text-xs font-medium touch-target',
                    settings.replayScope === o.v
                      ? 'bg-card text-foreground shadow-soft'
                      : 'text-muted-foreground',
                  )}
                >
                  {o.label}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">
              阅读器里双击任意一句即可从该句重新朗读；选「只读这一句」时读完就停。
            </p>
          </div>

          {/* 每轮词数：选项较多，独占一行避免窄屏挤压；改动即存，长期生效 */}
          <div className="py-3">
            <div className="mb-2 flex items-center gap-3">
              <ListOrdered className="h-5 w-5 text-primary" />
              <span className="text-sm">每轮学习 / 复习词数</span>
              <span className="ml-auto text-sm font-semibold text-primary">
                {settings.studyBatchSize}
              </span>
            </div>
            <div className="flex gap-1 rounded-lg bg-muted p-1">
              {BATCH_SIZE_OPTIONS.map((n) => (
                <button
                  key={n}
                  onClick={() => setSetting('studyBatchSize', n)}
                  className={cn(
                    'flex-1 rounded-md py-1 text-xs font-medium touch-target',
                    settings.studyBatchSize === n
                      ? 'bg-card text-foreground shadow-soft'
                      : 'text-muted-foreground',
                  )}
                >
                  {n}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">
              学习流按此数分批出卡，复习闯关按此数限制本轮题量。修改后立即保存并长期生效。
            </p>
          </div>
        </CardBody>
      </Card>

      {/* 功能 B 权限入口：词典扫描库（页面内用管理员口令解锁） */}
      <Card className="mt-4">
        <CardBody>
          <button
            type="button"
            onClick={() => navigate('/dict-ingest')}
            aria-label="进入词典扫描库"
            title="词典扫描库（需管理员口令）"
            className="flex w-full items-center gap-3 text-left"
          >
            <ScanLine className="h-5 w-5 shrink-0 text-primary" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm">词典扫描库（管理员）</span>
              <span className="block text-xs text-muted-foreground">
                扫描词典页面 → OCR 解析 → 结构化入库，支持检索、目录树与变形表
              </span>
            </span>
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          </button>
        </CardBody>
      </Card>

      {/* 词库来源与 CC BY-SA 4.0 署名（合规要求，数据取自 index.json） */}
      <div className="mt-4">
        <SourceAttribution />
      </div>

      {/* 离线说明：一句话讲清"按需缓存"与 iOS 的清理策略，不多做 UI */}
      <p className="mt-3 px-1 text-xs leading-relaxed text-muted-foreground">
        离线说明：词库分片只有打开过才会存到本机，没打开过的部分断网时看不到。
        iOS Safari 对未「添加到主屏幕」的站点，长时间不活跃后可能清理本地数据 —— 需要长期离线使用，
        建议把述树添加到主屏幕。
      </p>
    </div>
  )
}
