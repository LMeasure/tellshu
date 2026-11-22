import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import {
  BookOpen,
  Camera,
  CheckCircle2,
  FileText,
  Image as ImageIcon,
  Languages,
  Music,
  Plus,
  RefreshCw,
  Trash2,
  ArrowRight,
  AlertCircle,
  Upload,
  Pencil,
  ScanLine,
  X,
} from 'lucide-react'
import { Card, CardBody } from '@/components/ui/card'
import { Tabs } from '@/components/ui/tabs'
import { EmptyState } from '@/components/ui/empty-state'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useMediaAudio } from '@/hooks/useMediaAudio'
import {
  fetchScanJob,
  submitMaterialScans,
  translateText,
  type JobStatusResponse,
  type ScanStatus,
  type TranslateResult,
} from '@/data/dictClient'
import { isCameraSupported, isOcrSupported, ocrService, type PickedImage } from '@/services/ocr'
import { ConvertPanel as ConvertImport } from '@/components/convert/ConvertPanel'
import { MediaTranscriptImport } from '@/components/transcript/MediaTranscriptImport'
import { extractEpubBook, parseTxtBook } from '@/lib/epub'
import { detectLanguage, countChars, type LangKind } from '@/lib/textLang'
import { MaterialShelfButton } from '@/components/import/MaterialShelfButton'
import {
  saveReading,
  getReadings,
  deleteReading,
  clearDictationProgress,
  type ReadingDoc,
  type ReadingType,
} from '@/domain/learning'

/**
 * 需求【7】从阅读器点「编辑」过来时携带的上下文。
 * 带 editId 就是编辑已有素材：文本框回填原文，保存时按 id 覆盖并重置进度。
 */
export interface EditSeed {
  editId: string
  title: string
  content: string
}

/** 导入页页签：前三个是素材类型，最后三个是「图片识别」「格式转换」「音视频字幕」 */
type ImportTab = ReadingType | 'scan' | 'convert' | 'media'

const LANG_LABEL: Record<LangKind, string> = {
  zh: '中文',
  en: '英文',
  mixed: '中英混排',
}

/** 中文说「字」、英文说「词」 */
function unitLabel(lang: LangKind, n: number): string {
  return `${n} ${lang === 'zh' ? '字' : lang === 'en' ? '词' : '字词'}`
}

/**
 * 导入页（见优化计划）：个人中心 → 导入
 *  - 文本：粘贴**中文 / 英文 / 中英混排**文章（自动判断语言）
 *  - 书籍：上传 TXT / EPUB（真实提取文本，复用阅读器）；其余格式标注「敬请期待」。
 *    导入时不写 on_shelf，默认不进首页书架；在「我的素材」对书籍点「加入书架」后才上架。
 *  - 音频：上传 MP3 / M4A / M4B（文件存入本地，内联播放）
 * 全部本地解析/保存，完全离线。
 */
export function Import() {
  const navigate = useNavigate()
  const location = useLocation()
  /** 搜索框扫描入口等场景用 ?tab= 直开某个页签（如 /import?tab=scan） */
  const [searchParams] = useSearchParams()
  const tabParam = searchParams.get('tab')
  const [tab, setTab] = useState<ImportTab>(
    ['article', 'book', 'audio', 'scan', 'convert', 'media'].includes(tabParam ?? '')
      ? (tabParam as ImportTab)
      : 'article',
  )
  const [readings, setReadings] = useState<ReadingDoc[] | null>(null)

  /** 阅读器「编辑」跳过来时带的原文（需求【7】） */
  const edit = (location.state as EditSeed | null) ?? null

  const loadList = () => getReadings().then(setReadings)
  useEffect(() => {
    loadList()
  }, [])

  return (
    <div className="px-4 py-4">
      <h1 className="mb-1 text-xl font-bold">{edit?.editId ? '编辑素材' : '导入素材'}</h1>
      <p className="mb-4 text-sm text-muted-foreground">
        {edit?.editId
          ? '原文已回填，改完保存即覆盖；分词、隐藏状态与朗读进度会一并重置。'
          : '粘贴中英文文章 / 上传书籍 / 导入音频，点词加生词本、进记忆模式默写。'}
      </p>

      <Tabs
        items={[
          { key: 'article', label: '文本' },
          { key: 'book', label: '书籍' },
          { key: 'audio', label: '音频' },
          { key: 'scan', label: '扫描识别' },
          { key: 'convert', label: '格式转换' },
          { key: 'media', label: '音视频字幕' },
        ]}
        active={tab}
        onChange={(k) => setTab(k as ImportTab)}
        className="mb-4"
      />

      {tab === 'article' && <TextImport onSaved={loadList} edit={edit} />}
      {tab === 'book' && <BookImport onSaved={loadList} />}
      {tab === 'audio' && <AudioImport onSaved={loadList} />}
      {tab === 'scan' && <ScanImport onSaved={loadList} />}
      {tab === 'convert' && <ConvertImport />}
      {tab === 'media' && <MediaTranscriptImport />}

      <div className="mt-6">
        <div className="mb-2 text-sm font-semibold text-muted-foreground">我的素材</div>
        {readings === null ? (
          <div className="p-4 text-sm text-muted-foreground">加载中…</div>
        ) : readings.length === 0 ? (
          <EmptyState
            icon={Plus}
            title="还没有导入"
            description="粘贴一段中文或英文，或上传 TXT/EPUB 书籍、MP3/M4A/M4B 等音视频。"
          />
        ) : (
          <div className="space-y-2">
            {readings.map((r) => (
              <ReadingRow key={r.id} doc={r} onChanged={loadList} navigate={navigate} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/** 单行素材：文章/书籍可点进阅读器；音频内联播放 */
function ReadingRow({
  doc,
  onChanged,
  navigate,
}: {
  doc: ReadingDoc
  onChanged: () => void
  navigate: (p: string) => void
}) {
  if (doc.type === 'audio') {
    return <AudioRow doc={doc} onChanged={onChanged} />
  }
  return (
    <Card className="cursor-pointer" onClick={() => navigate(`/reader/${doc.id}`)}>
      <CardBody className="flex items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-secondary text-primary">
          {doc.type === 'book' ? <BookOpen className="h-4 w-4" /> : <FileText className="h-4 w-4" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{doc.title}</div>
          {(() => {
            const lang = detectLanguage(doc.content)
            return (
              <div className="text-xs text-muted-foreground">
                {LANG_LABEL[lang]} · {unitLabel(lang, doc.word_count)} ·{' '}
                {doc.type === 'book' ? '书籍' : doc.type === 'transcript' ? '字幕' : '文章'}
                {doc.type === 'book' && doc.on_shelf ? ' · 已在书架' : ''}
              </div>
            )
          })()}
        </div>
        <MaterialShelfButton doc={doc} onChanged={onChanged} />
        <button
          className="text-muted-foreground hover:text-destructive"
          onClick={(e) => {
            e.stopPropagation()
            deleteReading(doc.id).then(onChanged)
          }}
          aria-label="删除"
        >
          <Trash2 className="h-4 w-4" />
        </button>
        <ArrowRight className="h-4 w-4 text-muted-foreground" />
      </CardBody>
    </Card>
  )
}

/** 音频卡片：内联播放器 */
function AudioRow({ doc, onChanged }: { doc: ReadingDoc; onChanged: () => void }) {
  const [url, setUrl] = useState<string | null>(null)
  const mediaRef = useMediaAudio()
  const isVideo = (doc.media_type ?? '').startsWith('video/')
  useEffect(() => {
    if (!doc.blob) return
    const u = URL.createObjectURL(doc.blob)
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [doc.blob])
  return (
    <Card>
      <CardBody className="space-y-2">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-secondary text-primary">
            <Music className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium">{doc.title}</div>
            <div className="text-xs text-muted-foreground">
              {isVideo ? '视频' : '音频'}
              {doc.ext ? ` · ${doc.ext.toUpperCase()}` : ''}
            </div>
          </div>
          <button
            className="text-muted-foreground hover:text-destructive"
            onClick={() => deleteReading(doc.id).then(onChanged)}
            aria-label="删除"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
        {url ? (
          isVideo ? (
            <video controls src={url} className="w-full rounded-lg" />
          ) : (
            <audio ref={mediaRef} controls src={url} className="w-full" />
          )
        ) : (
          <div className="text-xs text-muted-foreground">媒体文件缺失</div>
        )}
      </CardBody>
    </Card>
  )
}

/**
 * 文本导入：粘贴中文 / 英文 / 中英混排 + 标题。
 * 传入 edit 时是「编辑已有素材」：文本框回填原文，保存覆盖同 id 并重置进度（需求【7】）。
 */
function TextImport({ onSaved, edit }: { onSaved: () => void; edit: EditSeed | null }) {
  const navigate = useNavigate()
  const [title, setTitle] = useState(edit?.title ?? '')
  const [content, setContent] = useState(edit?.content ?? '')
  const [err, setErr] = useState('')

  // 实时判断语言：中文会被识别出来，让用户立刻知道系统将按哪种方式分词和朗读
  const lang = detectLanguage(content)
  const stats = countChars(content)
  const editing = !!edit?.editId

  async function handleSave() {
    if (!content.trim()) {
      setErr('请先粘贴文本内容')
      return
    }
    const id = edit?.editId
    const doc = await saveReading({
      title: title || '粘贴的文章',
      type: 'article',
      content,
      // 同 id 覆盖；页码归零 —— 需求【7】要求「朗读进度全部重置」
      ...(id ? { id, last_page: 0 } : {}),
    })
    // 隐藏方式 / 已选词 / 已填内容一并清空，等于「分词、隐藏状态」重置
    if (id) await clearDictationProgress(id)
    onSaved()
    setErr('')
    if (editing) {
      navigate(`/reader/${doc.id}`)
      return
    }
    setTitle('')
    setContent('')
  }

  return (
    <Card>
      <CardBody className="space-y-3">
        <input
          className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          placeholder="标题（可选）"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <textarea
          className="h-44 w-full resize-none rounded-lg border border-input bg-background px-3 py-2 text-sm leading-relaxed outline-none focus:ring-2 focus:ring-ring"
          placeholder="粘贴中文 / 英文 / 中英混排的文章…"
          value={content}
          onChange={(e) => setContent(e.target.value)}
        />
        {content.trim() && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span className="rounded-full bg-secondary px-2 py-0.5 font-medium text-secondary-foreground">
              {LANG_LABEL[lang]}
            </span>
            <span>
              汉字 {stats.zh} · 英文字母 {stats.en}
            </span>
            <span className="text-muted-foreground/70">
              {lang === 'zh'
                ? '将按中文词组分词、用中文嗓音朗读'
                : lang === 'en'
                  ? '将按空格分词、用英文嗓音朗读'
                  : '中英文分别处理，各用各的分词与嗓音'}
            </span>
          </div>
        )}
        {editing && (
          <div className="rounded-lg bg-primary/10 px-3 py-2 text-xs leading-relaxed text-primary">
            编辑模式：保存后覆盖原文，页码回到第 1 页，隐藏的词与已填内容全部清空重新来过。
          </div>
        )}
        {err && (
          <div className="flex items-center gap-1 text-xs text-destructive">
            <AlertCircle className="h-3.5 w-3.5" /> {err}
          </div>
        )}
        <Button className="w-full" onClick={handleSave}>
          {editing ? <Pencil className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
          {editing ? '保存修改' : '保存到阅读器'}
        </Button>
        {editing && (
          <Button variant="outline" className="w-full" onClick={() => navigate(-1)}>
            取消
          </Button>
        )}
      </CardBody>
    </Card>
  )
}

const BOOK_HINT = '支持 TXT / EPUB；MOBI / AZW3 / FB2 / PDF / DJVU / CBZ / CBR 敬请期待'

/** 书籍导入：上传 .txt / .epub（真实提取文本） */
function BookImport({ onSaved }: { onSaved: () => void }) {
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  async function handleFile(file: File) {
    const lower = file.name.toLowerCase()
    setStatus('')
    if (lower.endsWith('.txt')) {
      setBusy(true)
      try {
        const text = await file.text()
        if (!text.trim()) {
          setStatus('文件为空或无法读取')
          return
        }
        // 解析章节（识别 Chapter N / 第X章 等标记），并直接落本地库
        const parsed = parseTxtBook(text)
        const title = file.name.replace(/\.txt$/i, '')
        await saveReading({
          title,
          type: 'book',
          content: parsed.content,
          chapters: parsed.chapters,
        })
        onSaved()
        setStatus(
          `已保存到本机：「${title}」（${parsed.content.length} 字${
            parsed.chapters.length ? ` · ${parsed.chapters.length} 章` : ''
          }）`,
        )
      } finally {
        setBusy(false)
      }
    } else if (lower.endsWith('.epub')) {
      setBusy(true)
      try {
        const parsed = await extractEpubBook(file)
        const title = file.name.replace(/\.epub$/i, '')
        await saveReading({
          title,
          type: 'book',
          content: parsed.content,
          chapters: parsed.chapters,
        })
        onSaved()
        setStatus(
          `已保存到本机：「${title}」（${parsed.content.length} 字 · ${parsed.chapters.length} 章）`,
        )
      } catch (e: any) {
        setStatus(`EPUB 解析失败：${e?.message ?? e}`)
      } finally {
        setBusy(false)
      }
    } else {
      setStatus(BOOK_HINT)
    }
  }

  return (
    <Card>
      <CardBody className="space-y-3">
        <div
          className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-input p-8 text-center"
          onClick={() => inputRef.current?.click()}
        >
          <BookOpen className="h-8 w-8 text-primary" />
          <div className="text-sm font-medium">点击上传 TXT / EPUB 书籍</div>
          <div className="text-xs text-muted-foreground">
            选中即解析并直接存入本机（IndexedDB），文件不会上传服务器
          </div>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept=".txt,.epub,text/plain,application/epub+zip"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) handleFile(f)
            e.target.value = ''
          }}
        />
        {busy && <div className="text-xs text-accent">正在解析 EPUB…</div>}
        {status && <div className="text-xs text-muted-foreground">{status}</div>}
        <div className="rounded-lg bg-secondary/50 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
          弱提示：{BOOK_HINT}
        </div>
      </CardBody>
    </Card>
  )
}

const AUDIO_HINT = '支持 MP3 / WAV / AAC / FLAC / M4A / OGG / MP4 / AVI / MKV / MOV / WMV / FLV'
const AUDIO_EXT_RE = /\.(mp3|wav|aac|flac|m4a|ogg|mp4|avi|mkv|mov|wmv|flv)$/i

type AudioItemStatus = 'pending' | 'uploading' | 'success' | 'failed'

interface AudioItem {
  id: string
  file: File
  status: AudioItemStatus
  error?: string
}

function audioExt(name: string): string {
  const lower = name.toLowerCase()
  return lower.includes('.') ? lower.split('.').pop() ?? '' : ''
}

function guessMediaType(file: File, ext: string): string {
  if (file.type) return file.type
  const isVideo = /\.(mp4|avi|mkv|mov|wmv|flv)$/.test(ext)
  return isVideo ? `video/${ext}` : `audio/${ext}`
}

/** 音视频导入：批量选择、逐个本地保存，失败项可一键重传。视频以 video 媒体类型入库，列表内可播放。 */
function AudioImport({ onSaved }: { onSaved: () => void }) {
  const [items, setItems] = useState<AudioItem[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  const failedCount = items.filter((i) => i.status === 'failed').length

  async function processItem(item: AudioItem): Promise<void> {
    setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, status: 'uploading', error: undefined } : i)))
    const ext = audioExt(item.file.name)
    try {
      const title = item.file.name.replace(/\.[^.]+$/, '')
      await saveReading({
        title,
        type: 'audio',
        content: '',
        blob: item.file,
        media_type: guessMediaType(item.file, ext),
        ext,
      })
      setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, status: 'success' } : i)))
      onSaved()
    } catch (e) {
      setItems((prev) =>
        prev.map((i) =>
          i.id === item.id ? { ...i, status: 'failed', error: e instanceof Error ? e.message : '保存失败' } : i,
        ),
      )
    }
  }

  function addFiles(files: FileList | null): void {
    if (!files || files.length === 0) return
    const next: AudioItem[] = []
    for (const file of Array.from(files)) {
      const lower = file.name.toLowerCase()
      const ok = AUDIO_EXT_RE.test(lower)
      next.push({
        id: `a_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        file,
        status: ok ? 'pending' : 'failed',
        error: ok ? undefined : `不支持的格式：${audioExt(lower) || '未知'}`,
      })
    }
    setItems((prev) => [...prev, ...next])
    for (const it of next) {
      if (it.status === 'pending') void processItem(it)
    }
  }

  async function retryFailed(): Promise<void> {
    const failed = items.filter((i) => i.status === 'failed')
    await Promise.allSettled(failed.map((it) => processItem(it)))
  }

  function clearAll(): void {
    setItems([])
  }

  return (
    <Card>
      <CardBody className="space-y-3">
        <div
          className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-input p-8 text-center"
          onClick={() => inputRef.current?.click()}
        >
          <Music className="h-8 w-8 text-primary" />
          <div className="text-sm font-medium">点击上传音视频文件（可多选）</div>
          <div className="text-xs text-muted-foreground">本地保存，可反复听 / 看</div>
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept="audio/*,video/*,.mp3,.wav,.aac,.flac,.m4a,.ogg,.mp4,.avi,.mkv,.mov,.wmv,.flv"
          className="hidden"
          onChange={(e) => {
            addFiles(e.target.files)
            e.target.value = ''
          }}
        />

        {items.length > 0 && (
          <div className="space-y-2">
            {items.map((it) => (
              <div
                key={it.id}
                className={cn(
                  'flex items-center gap-2 rounded-lg border px-3 py-2 text-sm',
                  it.status === 'failed' ? 'border-destructive/40 bg-destructive/5' : 'border-input bg-background',
                )}
              >
                <span className="min-w-0 flex-1 truncate">{it.file.name}</span>
                {it.status === 'uploading' && <RefreshCw className="h-4 w-4 shrink-0 animate-spin text-primary" />}
                {it.status === 'success' && <CheckCircle2 className="h-4 w-4 shrink-0 text-primary" />}
                {it.status === 'failed' && <AlertCircle className="h-4 w-4 shrink-0 text-destructive" />}
                {it.status === 'pending' && <span className="shrink-0 text-xs text-muted-foreground">等待中</span>}
              </div>
            ))}
            {failedCount > 0 && (
              <Button variant="outline" className="w-full" onClick={() => void retryFailed()} aria-label="重传失败项">
                <RefreshCw className="h-4 w-4" /> 重传失败项（{failedCount}）
              </Button>
            )}
            <button
              type="button"
              onClick={clearAll}
              className="w-full text-center text-xs text-muted-foreground hover:text-destructive"
              aria-label="清空列表"
            >
              清空列表
            </button>
          </div>
        )}

        <div className="rounded-lg bg-secondary/50 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
          弱提示：{AUDIO_HINT}
        </div>
      </CardBody>
    </Card>
  )
}

/* ------------------------------------------------------------------ */
/* 功能 A：扫描识别 / 拍摄识别 / 上传照片识别                             */
/* ------------------------------------------------------------------ */

const SCAN_POLL_INTERVAL_MS = 2_000
const SCAN_POLL_MAX_TIMES = 30
const SCAN_HINT = '支持一次选多张；识别在服务端完成，令牌不出后端'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

/** 轮询一个 OCR 任务直到 done / failed（服务端是异步任务，必须轮询） */
async function pollScanJob(
  scanId: string,
  onTick: (status: ScanStatus) => void,
): Promise<JobStatusResponse> {
  for (let attempt = 0; attempt < SCAN_POLL_MAX_TIMES; attempt += 1) {
    const job = await fetchScanJob(scanId)
    onTick(job.status)
    if (job.status === 'done' || job.status === 'failed') return job
    await sleep(SCAN_POLL_INTERVAL_MS)
  }
  throw new Error('识别超时，任务仍在处理，请稍后再试')
}

/**
 * 图片识别（功能 A）
 * 识别出的文本有两个**独立**去向：
 *   1. 在线翻译 —— 后端未配置翻译服务时如实显示「未接入」，绝不返回假译文
 *   2. 保存到我的素材 —— 复用 saveReading 落本地 readings 表，进阅读器继续用
 */
function ScanImport({ onSaved }: { onSaved: () => void }) {
  const navigate = useNavigate()
  const [images, setImages] = useState<PickedImage[]>([])
  const [text, setText] = useState('')
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState('')
  const [err, setErr] = useState('')
  const [translation, setTranslation] = useState<TranslateResult | null>(null)
  const [translateErr, setTranslateErr] = useState('')
  const [translating, setTranslating] = useState(false)

  const pickerOk = isOcrSupported()
  const cameraOk = isCameraSupported()
  const lang = detectLanguage(text)

  async function addImages(picked: PickedImage[]): Promise<void> {
    if (picked.length === 0) return
    const compressed = await Promise.all(
      picked.map((image) => ocrService.compress(image)),
    )
    setImages((prev) => [...prev, ...compressed])
  }

  async function pick(): Promise<void> {
    setErr('')
    await addImages(await ocrService.pickFromFiles(true))
  }

  async function shoot(): Promise<void> {
    setErr('')
    const picked = cameraOk
      ? await ocrService.captureLive().catch(() => ocrService.capture())
      : await ocrService.capture()
    await addImages(picked)
  }

  async function recognize(): Promise<void> {
    if (images.length === 0) {
      setErr('先选一张照片，或直接拍一张')
      return
    }
    setBusy(true)
    setErr('')
    setStage('提交中…')
    setTranslation(null)
    setTranslateErr('')
    try {
      const submitted = await submitMaterialScans(images)
      const chunks: string[] = []
      const failures: string[] = []
      let index = 0
      for (const scan of submitted.scans) {
        index += 1
        setStage(`识别中 ${index}/${submitted.scans.length}`)
        const job = await pollScanJob(scan.scanId, () => undefined)
        if (job.status === 'failed') {
          failures.push(job.error?.message ?? '该页识别失败')
          continue
        }
        if (job.text !== null && job.text.trim() !== '') chunks.push(job.text.trim())
      }
      const merged = chunks.join('\n\n')
      if (merged === '') {
        setText('')
        setStage('')
        setErr(failures[0] ?? '没能识别出文字，换一张更清晰、光线更均匀的图片试试')
        return
      }
      setText(merged)
      if (title.trim() === '') {
        setTitle(`扫描识别 ${new Date().toLocaleString('zh-CN', { hour12: false })}`)
      }
      setStage(
        failures.length > 0
          ? `完成 ${chunks.length} 页，${failures.length} 页失败（已忽略）`
          : `完成 ${chunks.length} 页`,
      )
    } catch (e) {
      setErr(e instanceof Error ? e.message : '识别失败')
      setStage('')
    } finally {
      setBusy(false)
    }
  }

  async function runTranslate(): Promise<void> {
    if (text.trim() === '') {
      setTranslateErr('先识别出文本，或粘贴一段内容')
      return
    }
    setTranslating(true)
    setTranslateErr('')
    setTranslation(null)
    try {
      setTranslation(await translateText(text.slice(0, 5000), 'auto', 'zh'))
    } catch (e) {
      setTranslateErr(e instanceof Error ? e.message : '翻译失败')
    } finally {
      setTranslating(false)
    }
  }

  async function handleSave(): Promise<void> {
    if (text.trim() === '') {
      setErr('还没有可保存的文本')
      return
    }
    const doc = await saveReading({
      title: title.trim() || '扫描识别',
      type: 'article',
      content: text,
    })
    onSaved()
    setImages([])
    setText('')
    setTitle('')
    setTranslation(null)
    setStage('')
    navigate(`/reader/${doc.id}`)
  }

  return (
    <div className="space-y-3">
      <Card>
        <CardBody className="space-y-3">
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void pick()}
              disabled={!pickerOk || busy}
              aria-label="从相册选择照片识别"
              title="从相册选择照片（可多选）"
            >
              <ImageIcon className="h-4 w-4" /> 上传照片
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void shoot()}
              disabled={!pickerOk || busy}
              aria-label="拍摄照片识别"
              title={cameraOk ? '调用摄像头拍摄' : '当前环境不支持实时取景，将调用系统相机'}
            >
              <Camera className="h-4 w-4" /> 拍摄识别
            </Button>
          </div>

          {!pickerOk && (
            <p className="text-xs text-muted-foreground">当前环境不支持图片采集。</p>
          )}

          {images.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {images.map((image, i) => (
                <div
                  key={`${image.name}-${i}`}
                  className="flex items-center gap-1 rounded-lg bg-secondary px-2 py-1 text-xs"
                >
                  <span className="max-w-[10rem] truncate">{image.name}</span>
                  <button
                    type="button"
                    onClick={() => setImages((prev) => prev.filter((_, idx) => idx !== i))}
                    disabled={busy}
                    aria-label={`移除第 ${i + 1} 张图片`}
                    title="移除"
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <Button
            className="w-full"
            onClick={() => void recognize()}
            disabled={busy || images.length === 0}
          >
            <ScanLine className="h-4 w-4" />
            {busy ? '识别中…' : `开始识别 ${images.length} 张`}
          </Button>

          {stage !== '' && <p className="text-xs text-muted-foreground">{stage}</p>}
          {err !== '' && (
            <div className="flex items-center gap-1 text-xs text-destructive">
              <AlertCircle className="h-3.5 w-3.5" /> {err}
            </div>
          )}
          <div className="rounded-lg bg-secondary/50 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
            弱提示：{SCAN_HINT}
          </div>
        </CardBody>
      </Card>

      {text === '' ? (
        <EmptyState
          icon={ScanLine}
          title="还没有识别结果"
          description="选一张照片或拍一页书，识别出的文字会出现在这里，可以直接改，然后翻译或存进素材库。"
        />
      ) : (
        <Card>
          <CardBody className="space-y-3">
            <input
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              placeholder="标题（可选）"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              aria-label="素材标题"
            />
            <textarea
              className="h-44 w-full resize-none rounded-lg border border-input bg-background px-3 py-2 text-sm leading-relaxed outline-none focus:ring-2 focus:ring-ring"
              value={text}
              onChange={(e) => setText(e.target.value)}
              aria-label="识别结果"
              placeholder="识别结果（可直接修改）"
            />
            <div className="text-xs text-muted-foreground">
              {LANG_LABEL[lang]} · {text.length} 字
            </div>

            {/* 去向一：在线翻译 */}
            <Button
              variant="outline"
              className="w-full"
              onClick={() => void runTranslate()}
              disabled={translating || text.trim() === ''}
              aria-label="在线翻译识别结果"
              title="调用服务端翻译接口（未接入时会如实提示）"
            >
              <Languages className="h-4 w-4" />
              {translating ? '翻译中…' : '在线翻译'}
            </Button>

            {translation !== null && (
              <div className="rounded-lg bg-secondary/50 px-3 py-2 text-sm leading-relaxed text-foreground">
                {translation.translatedText}
              </div>
            )}

            {translateErr !== '' && (
              <EmptyState
                icon={Languages}
                title="翻译服务未接入"
                description={`${translateErr}。翻译需要后端配置 TRANSLATE_API_URL；未接入时不返回任何译文，也不会编造结果。`}
              />
            )}

            {/* 去向二：保存到我的素材（与翻译互不影响） */}
            <Button
              className="w-full"
              onClick={() => void handleSave()}
              disabled={text.trim() === ''}
              aria-label="保存到我的素材"
              title="存入本机素材库并打开阅读器"
            >
              <Plus className="h-4 w-4" /> 保存到我的素材
            </Button>
          </CardBody>
        </Card>
      )}
    </div>
  )
}
