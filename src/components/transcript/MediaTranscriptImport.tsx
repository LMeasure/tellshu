import { useEffect, useRef, useState } from 'react'
import { AlertCircle, Captions, Download, FileAudio, FileVideo, X } from 'lucide-react'
import { Card, CardBody } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorState } from '@/components/ui/error-state'
import { cn } from '@/lib/utils'
import { downloadTextFile } from '@/lib/download'
import { useMediaAudio } from '@/hooks/useMediaAudio'
import { asrService, isAsrSupported, type PickedMedia } from '@/services/asr'
import { validateMediaFile } from '@/domain/transcript/validate'
import { transcribeAndSave } from '@/domain/transcript/transcribe'
import { toSrt, toTxt, toVtt } from '@/domain/transcript/subtitle'
import type { Transcript } from '@/domain/transcript/types'
import { ApiRequestError } from '@/data/asrClient'

/**
 * 音视频转字幕（Phase 1）
 * ------------------------------------------------------------------
 * 状态机：idle -> picked -> submitting -> running -> done；
 * 分支：failed（重试）、not-configured（503 -> 空态引导，不造假字幕）。
 *
 * 范围锁定（用户拍板）：只做「音视频 -> 字幕」。结果区**只读展示**，
 * 不做字幕编辑 / 学习稿 / 思维导图等任何下游能力；
 * Phase 2 M1 起字幕自动落本机 Dexie（刷新不丢，离线可用），
 * 历史字幕列表 / 学习稿入口属 M2 范围，本期不做。
 */

type Phase = 'idle' | 'picked' | 'submitting' | 'running' | 'done' | 'failed'

const WEAK_HINT =
  '文件将上传至服务端转录；字幕后自动保存在本机，刷新不丢；字幕只读展示，暂不支持修改。'

function formatClock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

function formatSize(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

export function MediaTranscriptImport() {
  const [phase, setPhase] = useState<Phase>('idle')
  const [media, setMedia] = useState<PickedMedia | null>(null)
  const [mediaUrl, setMediaUrl] = useState<string | null>(null)
  const [stage, setStage] = useState('')
  const [error, setError] = useState('')
  const [notConfigured, setNotConfigured] = useState(false)
  const [transcript, setTranscript] = useState<Transcript | null>(null)
  const [activeIndex, setActiveIndex] = useState(-1)

  const audioBusRef = useMediaAudio()
  const mediaElRef = useRef<HTMLMediaElement | null>(null)
  const pickerOk = isAsrSupported()
  const busy = phase === 'submitting' || phase === 'running'

  // objectURL 随选中文件创建 / 销毁
  useEffect(() => {
    if (media === null) {
      setMediaUrl(null)
      return
    }
    const url = URL.createObjectURL(media.blob)
    setMediaUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [media])

  async function pick(): Promise<void> {
    setError('')
    setNotConfigured(false)
    const picked = await asrService.pickMedia()
    const file = picked[0]
    if (file === undefined) return
    const check = validateMediaFile(file.name, file.sizeBytes)
    if (!check.ok) {
      setError(check.reason)
      return
    }
    setMedia(file)
    setTranscript(null)
    setActiveIndex(-1)
    setPhase('picked')
  }

  async function start(): Promise<void> {
    if (media === null) return
    const check = validateMediaFile(media.name, media.sizeBytes)
    if (!check.ok) {
      setError(check.reason)
      return
    }
    setPhase('submitting')
    setError('')
    setNotConfigured(false)
    setTranscript(null)
    setActiveIndex(-1)
    try {
      const result = await transcribeAndSave(
        { file: media.blob, fileName: media.name, language: 'auto' },
        {
          onStage: (text, status) => {
            setStage(text)
            setPhase(status === 'submit' ? 'submitting' : 'running')
          },
        },
      )
      setTranscript(result)
      setStage('')
      setPhase('done')
    } catch (e) {
      setStage('')
      if (e instanceof ApiRequestError && e.status === 503) {
        // 服务未接入：空态引导，绝不显示假字幕
        setNotConfigured(true)
        setPhase('idle')
        return
      }
      setError(e instanceof Error ? e.message : '转写失败')
      setPhase('failed')
    }
  }

  function onTimeUpdate(): void {
    const el = mediaElRef.current
    if (el === null || transcript === null) return
    const t = el.currentTime
    const index = transcript.segments.findIndex((seg) => t >= seg.start && t < seg.end)
    setActiveIndex(index)
  }

  function seekTo(index: number): void {
    const el = mediaElRef.current
    const seg = transcript?.segments[index]
    if (el === null || seg === undefined) return
    el.currentTime = seg.start
    void el.play().catch(() => undefined)
    setActiveIndex(index)
  }

  function exportAs(kind: 'txt' | 'srt' | 'vtt'): void {
    if (transcript === null || media === null) return
    const base = media.name.replace(/\.[a-z0-9]+$/i, '') || 'media'
    if (kind === 'txt') downloadTextFile(`${base}-字幕.txt`, toTxt(transcript.segments))
    else if (kind === 'srt') downloadTextFile(`${base}-字幕.srt`, toSrt(transcript.segments))
    else downloadTextFile(`${base}-字幕.vtt`, toVtt(transcript.segments))
  }

  return (
    <div className="space-y-3">
      <Card>
        <CardBody className="space-y-3">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void pick()}
            disabled={!pickerOk || busy}
            aria-label="选择音视频文件"
            title="选择本机音频或视频文件（单选）"
          >
            <FileAudio className="h-4 w-4" /> 选择音视频文件
          </Button>

          {!pickerOk && <p className="text-xs text-muted-foreground">当前环境不支持文件选择。</p>}

          {media !== null && phase !== 'done' && (
            <div className="flex items-center gap-1 rounded-lg bg-secondary px-2 py-1 text-xs">
              {media.kind === 'video' ? <FileVideo className="h-3.5 w-3.5" /> : <FileAudio className="h-3.5 w-3.5" />}
              <span className="max-w-[12rem] truncate">{media.name}</span>
              <span className="text-muted-foreground">{formatSize(media.sizeBytes)}</span>
              {!busy && (
                <button
                  type="button"
                  onClick={() => {
                    setMedia(null)
                    setPhase('idle')
                  }}
                  aria-label="移除已选文件"
                  title="移除"
                  className="text-muted-foreground hover:text-destructive"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          )}

          <Button
            className="w-full"
            onClick={() => void start()}
            disabled={media === null || busy}
            aria-label="开始转写"
            title="上传到服务端并开始转写（未接入时会如实提示）"
          >
            <Captions className="h-4 w-4" />
            {busy ? stage || '处理中…' : '开始转写'}
          </Button>

          {stage !== '' && busy && <p className="text-xs text-muted-foreground">{stage}</p>}
          {error !== '' && (
            <div className="flex items-center gap-1 text-xs text-destructive">
              <AlertCircle className="h-3.5 w-3.5" /> {error}
            </div>
          )}
          <div className="rounded-lg bg-secondary/50 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
            弱提示：{WEAK_HINT}
          </div>
        </CardBody>
      </Card>

      {notConfigured ? (
        <EmptyState
          icon={Captions}
          title="转录服务未接入"
          description="音视频转字幕需要服务端配置 ASR 供应商。未接入时不返回任何结果，也不会编造字幕。"
        />
      ) : phase === 'failed' ? (
        <ErrorState
          message={error || '转写失败'}
          onRetry={() => {
            setError('')
            setPhase(media === null ? 'idle' : 'picked')
          }}
        />
      ) : transcript === null ? (
        <EmptyState
          icon={Captions}
          title="还没有字幕"
          description="选择一个音频或视频文件并开始转写，时间轴字幕会出现在这里，可导出 TXT / SRT / VTT。"
        />
      ) : (
        <Card>
          <CardBody className="space-y-3">
            {mediaUrl !== null && media !== null && (
              media.kind === 'video' ? (
                <video
                  ref={(el) => {
                    mediaElRef.current = el
                  }}
                  controls
                  src={mediaUrl}
                  onTimeUpdate={onTimeUpdate}
                  className="w-full rounded-lg bg-black"
                />
              ) : (
                <audio
                  ref={(el) => {
                    audioBusRef(el)
                    mediaElRef.current = el
                  }}
                  controls
                  src={mediaUrl}
                  onTimeUpdate={onTimeUpdate}
                  className="w-full"
                />
              )
            )}

            <div className="text-xs text-muted-foreground">
              {transcript.language === 'und' ? '语言未识别' : `语言 ${transcript.language}`} · 时长{' '}
              {formatClock(transcript.duration)} · {transcript.segments.length} 段
            </div>

            {/* 只读字幕列表：点段落跳转播放；不做任何编辑 / 保存 */}
            <div className="max-h-72 space-y-1 overflow-y-auto rounded-lg border border-border/60 p-2">
              {transcript.segments.map((seg, index) => (
                <button
                  key={`${seg.start}-${index}`}
                  type="button"
                  onClick={() => seekTo(index)}
                  className={cn(
                    'flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors touch-target',
                    index === activeIndex ? 'bg-secondary text-secondary-foreground' : 'hover:bg-muted',
                  )}
                  aria-label={`跳转到 ${formatClock(seg.start)}`}
                  title="点按跳转到该段"
                >
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">
                    {formatClock(seg.start)}
                  </span>
                  <span className="min-w-0 flex-1">{seg.text}</span>
                </button>
              ))}
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => exportAs('txt')}
                aria-label="导出 TXT"
                title="导出纯文本（每段一行）"
              >
                <Download className="h-4 w-4" /> TXT
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => exportAs('srt')}
                aria-label="导出 SRT"
                title="导出 SRT 字幕（播放器通用）"
              >
                <Download className="h-4 w-4" /> SRT
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => exportAs('vtt')}
                aria-label="导出 VTT"
                title="导出 WebVTT 字幕"
              >
                <Download className="h-4 w-4" /> VTT
              </Button>
            </div>
          </CardBody>
        </Card>
      )}
    </div>
  )
}
