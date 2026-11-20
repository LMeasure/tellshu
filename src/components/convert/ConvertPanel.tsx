import { useEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  Archive,
  CheckCircle2,
  Download,
  FileText,
  RefreshCw,
  Upload,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardBody } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { cn } from '@/lib/utils'
import {
  ACCEPT_ATTR,
  ALLOWED_CONVERSIONS,
  FORMAT_LABEL,
  detectFormat,
  targetCandidates,
  type ConvertFormat,
} from '@/domain/convert'
import { saveReading } from '@/domain/learning'
import {
  convertResultDownloadUrl,
  convertZipDownloadUrl,
  createConvertTask,
  getConvertTask,
  pingConvertService,
  requestConvertOcr,
  uploadConvertFile,
} from '@/services/convert/client'

const POLL_INTERVAL_MS = 2_000
const POLL_MAX_TIMES = 60

/** 可作为「目标格式」的集合（取自合法转换组合的目标侧，按常用顺序排列） */
const TARGET_FORMATS: ConvertFormat[] = (['pdf', 'docx', 'png', 'jpg', 'xlsx'] as ConvertFormat[]).filter((f) =>
  ALLOWED_CONVERSIONS.some(([, t]) => t === f),
)

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function makeId(): string {
  return `c_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

type ConvertItemStatus = 'pending' | 'uploading' | 'converting' | 'success' | 'failed'

interface ConvertItem {
  id: string
  file: File
  fmt: ConvertFormat | null
  status: ConvertItemStatus
  progress: number
  error?: string
  resultFileId?: string | null
  taskId?: string | null
  ocrBusy?: boolean
  savedTitle?: string | null
  ocrErr?: string
}

/**
 * 格式转换面板（导入页「格式转换」Tab）—— 批量版
 * - 一次可选多个文件，逐个独立转换（一个失败不影响其余）
 * - 每文件显示状态；失败项可「一键重传失败项」
 * 后端不可达 / 引擎未部署时，如实显示 EmptyState，绝不伪造结果或假装转换成功。
 */
export function ConvertPanel() {
  const [serviceOk, setServiceOk] = useState<boolean | null>(null)
  const [target, setTarget] = useState<ConvertFormat | null>(null)
  const [items, setItems] = useState<ConvertItem[]>([])
  const [err, setErr] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  // 卸载守卫：轮询最长 120s，用户切走页签后及时中止，避免对已卸载组件 setState
  const aliveRef = useRef(true)
  useEffect(() => {
    return () => {
      aliveRef.current = false
    }
  }, [])

  useEffect(() => {
    let alive = true
    pingConvertService()
      .then((ok) => alive && setServiceOk(ok))
      .catch(() => alive && setServiceOk(false))
    return () => {
      alive = false
    }
  }, [])

  const pendingCount = items.filter((i) => i.status === 'pending').length
  const failedCount = items.filter((i) => i.status === 'failed').length
  const busy = items.some((i) => i.status === 'uploading' || i.status === 'converting')

  async function processItem(item: ConvertItem, tgt: ConvertFormat): Promise<void> {
    const patch = (p: Partial<ConvertItem>) =>
      setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, ...p } : i)))
    patch({ status: 'uploading', progress: 0, error: undefined })
    try {
      const up = await uploadConvertFile(item.file)
      if (!aliveRef.current) return
      patch({ status: 'converting' })
      const task = await createConvertTask(up.fileId, tgt)
      if (!aliveRef.current) return
      patch({ taskId: task.taskId })
      for (let i = 0; i < POLL_MAX_TIMES; i += 1) {
        const t = await getConvertTask(task.taskId)
        if (!aliveRef.current) return
        if (t.status === 'success') {
          patch({ status: 'success', progress: t.progress, resultFileId: t.resultFileId })
          return
        }
        if (t.status === 'failed') {
          throw new Error(t.errorMessage ?? '转换失败')
        }
        patch({ status: 'converting', progress: t.progress })
        await sleep(POLL_INTERVAL_MS)
      }
      throw new Error('转换超时，请稍后再试')
    } catch (e) {
      patch({ status: 'failed', error: e instanceof Error ? e.message : '转换失败' })
    }
  }

  function addFiles(files: FileList | null): void {
    if (!files || files.length === 0) return
    const next: ConvertItem[] = []
    for (const file of Array.from(files)) {
      const fmt = detectFormat(file.name, file.type)
      let status: ConvertItemStatus = 'pending'
      let error: string | undefined
      if (fmt === null) {
        status = 'failed'
        error = `无法识别「${file.name}」的格式；仅支持 PDF / DOCX / PNG / JPG / XLSX`
      } else if (target && !targetCandidates(fmt).includes(target)) {
        status = 'failed'
        error = `${FORMAT_LABEL[fmt]} 暂不支持转换为 ${FORMAT_LABEL[target]}`
      }
      next.push({ id: makeId(), file, fmt, status, progress: 0, error })
    }
    setItems((prev) => [...prev, ...next])
  }

  /** 重新校验兼容性（target 可能已变），把待处理/失败项整理为 pending 或 failed，再逐个跑 */
  function validateAndRun(pick: (i: ConvertItem) => boolean): Promise<void> {
    if (!target) {
      setErr('请先选择目标格式')
      return Promise.resolve()
    }
    setErr('')
    const validated = items.map((i) => {
      if (!pick(i) || !i.fmt) return i
      if (!targetCandidates(i.fmt).includes(target)) {
        return {
          ...i,
          status: 'failed' as ConvertItemStatus,
          error: `${FORMAT_LABEL[i.fmt]} 暂不支持转换为 ${FORMAT_LABEL[target]}`,
        }
      }
      return { ...i, status: 'pending' as ConvertItemStatus, error: undefined }
    })
    setItems(validated)
    const toRun = validated.filter((i) => i.status === 'pending' && i.fmt !== null)
    if (toRun.length === 0) return Promise.resolve()
    return Promise.allSettled(toRun.map((it) => processItem(it, target))).then(() => undefined)
  }

  function startAll(): void {
    void validateAndRun((i) => i.status === 'pending')
  }

  function retryFailed(): void {
    void validateAndRun((i) => i.status === 'failed')
  }

  function removeItem(id: string): void {
    setItems((prev) => prev.filter((i) => i.id !== id))
  }

  function clearAll(): void {
    setItems([])
  }

  async function handleOcrSave(item: ConvertItem): Promise<void> {
    if (!item.taskId) return
    const patch = (p: Partial<ConvertItem>) =>
      setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, ...p } : i)))
    patch({ ocrBusy: true, ocrErr: '', savedTitle: null })
    try {
      const { text } = await requestConvertOcr(item.taskId)
      const base = item.file.name.replace(/\.[^.]+$/, '')
      const title = `${base}（转换文章）`
      await saveReading({ title, type: 'article', content: text })
      patch({ savedTitle: title })
    } catch (e) {
      patch({ ocrErr: e instanceof Error ? e.message : 'OCR 提取失败' })
    } finally {
      patch({ ocrBusy: false })
    }
  }

  if (serviceOk === null) {
    return (
      <Card>
        <CardBody>
          <div className="text-sm text-muted-foreground">正在检测转换服务…</div>
        </CardBody>
      </Card>
    )
  }

  if (serviceOk === false) {
    return (
      <EmptyState
        icon={Upload}
        title="格式转换服务未接入"
        description="转换引擎需要后端部署（Python 转换 Worker），当前环境未启动。文件不会被处理，也不会伪造任何结果。"
      />
    )
  }

  return (
    <div className="space-y-3">
      <Card>
        <CardBody className="space-y-3">
          <div
            className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-input p-8 text-center"
            onClick={() => inputRef.current?.click()}
          >
            <Upload className="h-8 w-8 text-primary" />
            <div className="text-sm font-medium">点击上传文件（可多选）</div>
            <div className="text-xs text-muted-foreground">支持 PDF / DOCX / PNG / JPG / XLSX</div>
          </div>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept={ACCEPT_ATTR}
            className="hidden"
            onChange={(e) => {
              addFiles(e.target.files)
              e.target.value = ''
            }}
          />

          <div>
            <div className="mb-1.5 text-xs font-medium text-muted-foreground">
              转换为（所有文件统一目标格式）
            </div>
            <div className="flex flex-wrap gap-2">
              {TARGET_FORMATS.map((c) => (
                <Button
                  key={c}
                  size="sm"
                  variant={target === c ? 'primary' : 'outline'}
                  onClick={() => setTarget(c)}
                  aria-label={`目标格式 ${FORMAT_LABEL[c]}`}
                  title={FORMAT_LABEL[c]}
                >
                  {FORMAT_LABEL[c]}
                </Button>
              ))}
            </div>
          </div>

          {err !== '' && (
            <div className="flex items-center gap-1 text-xs text-destructive">
              <AlertCircle className="h-3.5 w-3.5" /> {err}
            </div>
          )}

          {items.length > 0 && (
            <div className="space-y-2">
              {items.map((it) => (
                <div
                  key={it.id}
                  className={cn(
                    'rounded-lg border px-3 py-2 text-sm',
                    it.status === 'failed' ? 'border-destructive/40 bg-destructive/5' : 'border-input bg-background',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate">{it.file.name}</span>
                    {it.fmt && (
                      <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                        {FORMAT_LABEL[it.fmt]}
                      </span>
                    )}
                    {it.status === 'uploading' && (
                      <RefreshCw className="h-4 w-4 shrink-0 animate-spin text-primary" />
                    )}
                    {it.status === 'converting' && (
                      <RefreshCw className="h-4 w-4 shrink-0 animate-spin text-primary" />
                    )}
                    {it.status === 'success' && <CheckCircle2 className="h-4 w-4 shrink-0 text-primary" />}
                    {it.status === 'failed' && <AlertCircle className="h-4 w-4 shrink-0 text-destructive" />}
                    {it.status === 'pending' && (
                      <span className="shrink-0 text-xs text-muted-foreground">等待中</span>
                    )}
                    <button
                      type="button"
                      onClick={() => removeItem(it.id)}
                      aria-label="移除"
                      title="移除"
                      className="text-muted-foreground hover:text-destructive"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  {it.status === 'converting' && it.progress > 0 && (
                    <div className="mt-1 text-xs text-muted-foreground">转换中（{it.progress}%）</div>
                  )}
                  {it.status === 'failed' && it.error && (
                    <div className="mt-1 text-xs text-destructive">{it.error}</div>
                  )}
                  {it.status === 'success' && it.resultFileId && it.taskId && (
                    <div className="mt-1.5 flex flex-wrap gap-2">
                      <a
                        href={convertResultDownloadUrl(it.resultFileId)}
                        download
                        className="inline-flex items-center gap-1 rounded-lg bg-secondary px-2.5 py-1.5 text-xs font-medium"
                        aria-label="下载单文件结果"
                        title="下载单文件结果"
                      >
                        <Download className="h-3.5 w-3.5" /> 下载
                      </a>
                      <a
                        href={convertZipDownloadUrl(it.taskId)}
                        download
                        className="inline-flex items-center gap-1 rounded-lg bg-secondary px-2.5 py-1.5 text-xs font-medium"
                        aria-label="打包下载"
                        title="打包下载（ZIP）"
                      >
                        <Archive className="h-3.5 w-3.5" /> ZIP
                      </a>
                      {target === 'png' && (
                        <Button
                          size="sm"
                          onClick={() => void handleOcrSave(it)}
                          disabled={it.ocrBusy}
                          aria-label="OCR 成文章并保存"
                          title="OCR 成文章并保存"
                        >
                          {it.ocrBusy ? (
                            <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <FileText className="h-3.5 w-3.5" />
                          )}
                          {it.ocrBusy ? '提取中…' : 'OCR 成文章'}
                        </Button>
                      )}
                    </div>
                  )}
                  {it.status === 'success' && it.ocrErr && (
                    <div className="mt-1 flex items-center gap-1 text-xs text-destructive">
                      <AlertCircle className="h-3.5 w-3.5" /> {it.ocrErr}
                    </div>
                  )}
                  {it.status === 'success' && it.savedTitle !== null && (
                    <div className="mt-1 flex items-center gap-1 text-xs text-primary">
                      <CheckCircle2 className="h-3.5 w-3.5" /> 已保存为文章：{it.savedTitle}
                    </div>
                  )}
                </div>
              ))}

              <div className="flex flex-wrap items-center gap-2">
                {pendingCount > 0 && (
                  <Button
                    className="flex-1"
                    onClick={startAll}
                    disabled={busy || !target}
                    aria-label="开始批量转换"
                  >
                    {busy ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                    {busy ? '转换中…' : `开始转换（${pendingCount}）`}
                  </Button>
                )}
                {failedCount > 0 && (
                  <Button
                    variant="outline"
                    className="flex-1"
                    onClick={retryFailed}
                    disabled={busy}
                    aria-label="重传失败项"
                  >
                    <RefreshCw className="h-4 w-4" /> 重传失败项（{failedCount}）
                  </Button>
                )}
                <button
                  type="button"
                  onClick={clearAll}
                  className="text-xs text-muted-foreground hover:text-destructive"
                  aria-label="清空列表"
                >
                  清空
                </button>
              </div>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  )
}
