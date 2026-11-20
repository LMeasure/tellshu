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
import { getLatestTranscriptRecord } from '@/domain/transcript/store'
import { toCsv, toJson, toSrt, toTxt, toVtt } from '@/domain/transcript/subtitle'
import type { Transcript } from '@/domain/transcript/types'
import { ApiRequestError } from '@/data/asrClient'
import { StudyNotePanel } from '@/components/transcript/StudyNotePanel'

/**
 * 音视频转字幕（Phase 1 / Phase 2 M1-M2）
 * ------------------------------------------------------------------
 * 状态机：idle -> picked -> submitting -> running -> done；
 * 分支：failed（重试）、not-configured（503 -> 空态引导，不造假字幕）。
 * 选完文件即自动进入 submitting（决策 2026-10-22 修订：无「开始转写」按钮，
 * 语言也不让用户选，恒 auto 自动检测）。
 *
 * 持久化口径（M1 起，用户拍板）：转写成功即落本机 Dexie `transcripts`
 * （用户资产起点，永久留存），并自动登记为阅读器资料（幂等键
 * t_<jobId>，见 transcribeAndSave -> ensureTranscriptReading；
 * 历史任务由 main.tsx 启动期 reconcile 补齐）。
 * 本页挂载时回读**最近一次**转写：刷新 / 重新进页面不丢入口，
 * 导出与学习稿立即可用（媒体文件句柄不持久，刷新后仅播放需重选）。
 */

type Phase = 'idle' | 'picked' | 'submitting' | 'running' | 'done' | 'failed'

/** 导出格式（下载按钮与 MIME 共用的单一来源）。 */
type ExportKind = 'txt' | 'srt' | 'vtt' | 'csv' | 'json'

const WEAK_HINT =
  '选择文件后即自动上传服务端转录（语种自动检测）；字幕后自动保存在本机并进入阅读器，刷新不丢；字幕只读展示，暂不支持修改。'

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

  // 挂载回读最近一次转写（Dexie 持久化）：刷新 / 重新进页面后
  // 导出与学习稿入口立即可用，不要求重新上传或重新转写。
  // 只回读一次（deps 空）：用户主动选新文件/重新转写以内存态为准。
  useEffect(() => {
    let cancelled = false
    void getLatestTranscriptRecord()
      .then((record) => {
        if (cancelled || record === undefined) return
        setTranscript({
          id: record.id,
          language: record.language,
          duration: record.duration,
          segments: record.segments,
          fileName: record.fileName,
        })
        setPhase('done')
      })
      .catch((e) => {
        if (!cancelled) console.warn('[transcript] 回读最近转写失败：', e)
      })
    return () => {
      cancelled = true
    }
  }, [])

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
    // 选完文件即自动开始转写（决策 2026-10-22 修订：去掉「开始转写」步骤）。
    // 文件不合法时上面已拦下并留错误态，不会误上传。
    await runTranscribe(file)
  }

  /**
   * 提交转写并落库（选文件后自动触发；失败重试也走这里）。
   * 语言恒为 auto（不让用户选语言）：学习稿的中英方向由服务端按检测到的
   * 字幕语种自适应——en → 英文原句+中文释义；zh → 中文原句+英文释义
   * （见 server/src/llmStudyNote.ts 双 prompt）。
   */
  async function runTranscribe(file: PickedMedia): Promise<void> {
    const check = validateMediaFile(file.name, file.sizeBytes)
    if (!check.ok) {
      setError(check.reason)
      setPhase('picked')
      return
    }
    setPhase('submitting')
    setError('')
    setNotConfigured(false)
    setTranscript(null)
    setActiveIndex(-1)
    try {
      const result = await transcribeAndSave(
        { file: file.blob, fileName: file.name, language: 'auto' },
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
      // 服务未接入（服务端 503 service_unavailable）：空态引导，绝不显示假字幕。
      // 代理层 503（code=backend_unreachable，后端没启动）走错误态——
      // 后端没启动 ≠ 转录服务未接入，不能误导用户。
      if (
        e instanceof ApiRequestError &&
        e.status === 503 &&
        e.code !== 'backend_unreachable'
      ) {
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

  /** 秒级跳转（学习稿词汇回匹给出的是段起点秒，不是 index）。 */
  function seekToSeconds(seconds: number): void {
    const el = mediaElRef.current
    if (el === null) return
    el.currentTime = seconds
    void el.play().catch(() => undefined)
  }

  /**
   * 导出（TXT / SRT / VTT / CSV / JSON）。
   * 数据源一律取 transcript.segments（Dexie 持久化的完整结果），
   * **不依赖 media**——刷新后回读的转写同样可导出；
   * 文件名取原始文件名（回读态同样带 fileName），缺失时用通用名。
   * 下载失败抛错 -> 错误态明示，绝不静默无响应。
   */
  function exportAs(kind: ExportKind): void {
    if (transcript === null) return
    const raw = transcript.fileName ?? ''
    const base = raw.replace(/\.[a-z0-9]+$/i, '') || '字幕素材'
    try {
      if (kind === 'txt') downloadTextFile(`${base}-字幕.txt`, toTxt(transcript.segments), 'txt')
      else if (kind === 'srt') downloadTextFile(`${base}-字幕.srt`, toSrt(transcript.segments), 'srt')
      else if (kind === 'vtt') downloadTextFile(`${base}-字幕.vtt`, toVtt(transcript.segments), 'vtt')
      else if (kind === 'csv') downloadTextFile(`${base}-字幕.csv`, toCsv(transcript.segments), 'csv')
      else
        downloadTextFile(
          `${base}-字幕.json`,
          toJson({
            id: transcript.id,
            language: transcript.language,
            duration: transcript.duration,
            fileName: transcript.fileName,
            segments: transcript.segments,
          }),
          'json',
        )
    } catch (e) {
      setError(e instanceof Error ? e.message : '导出失败，请重试')
    }
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
            title="选择本机音频或视频文件（单选，选完自动开始转写）"
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
            // 自动转写链路：重试即用已选文件再次提交（media 丢失则回 idle 重新选）
            if (media === null) {
              setPhase('idle')
              return
            }
            void runTranscribe(media)
          }}
        />
      ) : transcript === null ? (
        <EmptyState
          icon={Captions}
          title="还没有字幕"
          description="选择一个音频或视频文件并开始转写，时间轴字幕会出现在这里，可导出 TXT / SRT / VTT / CSV / JSON。"
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

            {media === null && (
              <p className="rounded-lg bg-secondary/50 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
                已从本机存储恢复最近一次转写（自动保存在阅读器「我的素材」中）。
                媒体文件句柄不随刷新保留，如需播放请重新选择同一文件；导出与学习稿不受影响。
              </p>
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
                title="导出纯文本（每段一行，无时间戳）"
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
              <Button
                variant="outline"
                size="sm"
                onClick={() => exportAs('csv')}
                aria-label="导出 CSV"
                title="导出 CSV 表格（index,start_time,end_time,text）"
              >
                <Download className="h-4 w-4" /> CSV
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => exportAs('json')}
                aria-label="导出 JSON"
                title="导出 JSON（完整结构化数据，含每段时间戳）"
              >
                <Download className="h-4 w-4" /> JSON
              </Button>
            </div>
          </CardBody>
        </Card>
      )}

      {/* 学习稿面板（M2）：字幕完成后可用；503 未接入走空态引导 */}
      {transcript !== null && <StudyNotePanel transcript={transcript} onSeek={seekToSeconds} />}
    </div>
  )
}
