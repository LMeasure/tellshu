/**
 * 目录树 / 语法表格 / 扫描上传面板（功能 B 的展示与入库侧）
 */

import { useEffect, useState } from 'react'
import { Camera, ChevronRight, Image as ImageIcon, Lock, Upload } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardBody, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorState } from '@/components/ui/error-state'
import { getDictTocTree, listDictBooks, resetDictCache, type DictTocTreeNode } from '@/domain/dict'
import { isCameraSupported, isOcrSupported, ocrService } from '@/services/ocr'
import {
  fetchDictionaryBatch,
  submitDictionaryScans,
  type PageKind,
  type ScanProcessSummary,
} from '@/data/dictClient'
import { PAGE_KIND_OPTIONS, useDictStore } from '@/store/useDictStore'

/* ------------------------------------------------------------------ */
/* 目录树                                                              */
/* ------------------------------------------------------------------ */

function TocBranch({ node }: { node: DictTocTreeNode }) {
  return (
    <div className="ml-3 border-l border-border pl-3">
      <div className="flex items-baseline gap-2 py-1">
        <span className="text-sm text-foreground">{node.title}</span>
        <span className="text-xs text-muted-foreground">
          P{node.page_start}
          {node.page_end !== null ? `–${node.page_end}` : ''}
        </span>
      </div>
      {node.children.map((child) => (
        <TocBranch key={child.id} node={child} />
      ))}
    </div>
  )
}

export function TocTreeView() {
  const [books, setBooks] = useState<string[]>([])
  const [book, setBook] = useState('')
  const [tree, setTree] = useState<DictTocTreeNode[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void listDictBooks().then((list) => {
      setBooks(list)
      if (list[0] !== undefined) setBook(list[0])
    })
  }, [])

  useEffect(() => {
    if (book === '') return
    setTree(null)
    setError(null)
    getDictTocTree(book)
      .then(setTree)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : '目录读取失败'))
  }, [book])

  if (error !== null) return <ErrorState message={error} onRetry={() => setBook(book)} />

  if (books.length === 0) {
    return (
      <EmptyState
        icon={ImageIcon}
        title="还没有目录数据"
        description="先在「扫描入库」里上传目录页，再从服务端同步一次。"
      />
    )
  }

  return (
    <div className="space-y-3">
      {books.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {books.map((b) => (
            <button
              key={b}
              type="button"
              onClick={() => setBook(b)}
              className={`rounded-full px-3 py-1 text-xs ${
                b === book
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-secondary text-secondary-foreground'
              }`}
            >
              {b}
            </button>
          ))}
        </div>
      )}
      {tree === null && <p className="text-sm text-muted-foreground">载入中…</p>}
      {tree !== null && tree.length === 0 && (
        <EmptyState title="这本书还没有目录" description="扫描目录页并同步后再来看。" />
      )}
      {tree !== null && tree.length > 0 && (
        <Card>
          <CardBody>
            {tree.map((node) => (
              <TocBranch key={node.id} node={node} />
            ))}
          </CardBody>
        </Card>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 语法 / 变形表                                                       */
/* ------------------------------------------------------------------ */

export function GrammarTableView() {
  const grammarQuery = useDictStore((s) => s.grammarQuery)
  const grammarRules = useDictStore((s) => s.grammarRules)
  const runGrammarSearch = useDictStore((s) => s.runGrammarSearch)

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <input
          value={grammarQuery}
          onChange={(e) => void runGrammarSearch(e.target.value)}
          placeholder="查不规则动词，如 go / be"
          aria-label="查询语法规则"
          className="h-11 flex-1 rounded-xl border border-border bg-card px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-primary"
        />
      </div>

      {grammarRules.length === 0 ? (
        <EmptyState
          title={grammarQuery.trim() === '' ? '输入一个动词原形' : '没有匹配的规则'}
          description={
            grammarQuery.trim() === ''
              ? '例如 go → went / gone。数据来自扫描的不规则动词表。'
              : '确认是否已扫描不规则动词表页并完成同步。'
          }
        />
      ) : (
        <Card>
          <CardBody className="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-4 py-2 font-medium">原形</th>
                  <th className="px-4 py-2 font-medium">过去式</th>
                  <th className="px-4 py-2 font-medium">过去分词</th>
                </tr>
              </thead>
              <tbody>
                {grammarRules.map((rule) => (
                  <tr key={rule.key} className="border-b border-border last:border-0">
                    <td className="px-4 py-2 text-foreground">{rule.base_form}</td>
                    <td className="px-4 py-2 text-foreground">{rule.past_tense ?? '—'}</td>
                    <td className="px-4 py-2 text-foreground">{rule.past_participle ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardBody>
        </Card>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 扫描上传                                                            */
/* ------------------------------------------------------------------ */

export function ScanUploadPanel() {
  const hasAdmin = useDictStore((s) => s.hasAdmin)
  const adminError = useDictStore((s) => s.adminError)
  const uploading = useDictStore((s) => s.uploading)
  const uploadError = useDictStore((s) => s.uploadError)
  const uploadSummary = useDictStore((s) => s.uploadSummary)
  const uploadedScans = useDictStore((s) => s.uploadedScans)
  const unlock = useDictStore((s) => s.unlock)
  const markUploadStarted = useDictStore((s) => s.markUploadStarted)
  const markUploadDone = useDictStore((s) => s.markUploadDone)
  const markUploadFailed = useDictStore((s) => s.markUploadFailed)
  const setUploadSummary = useDictStore((s) => s.setUploadSummary)

  const [token, setToken] = useState('')
  const [book, setBook] = useState('')
  const [pageKind, setPageKind] = useState<PageKind>('entry')
  const [images, setImages] = useState<Array<{ blob: Blob; name: string }>>([])

  const cameraOk = isCameraSupported()
  const pickerOk = isOcrSupported()

  async function pick(multiple: boolean): Promise<void> {
    const picked = await ocrService.pickFromFiles(multiple)
    const compressed = await Promise.all(picked.map((img) => ocrService.compress(img)))
    setImages((prev) => [...prev, ...compressed])
  }

  async function shoot(): Promise<void> {
    const picked = cameraOk
      ? await ocrService.captureLive().catch(() => ocrService.capture())
      : await ocrService.capture()
    const compressed = await Promise.all(picked.map((img) => ocrService.compress(img)))
    setImages((prev) => [...prev, ...compressed])
  }

  async function submit(): Promise<void> {
    if (book.trim() === '') {
      markUploadFailed('请填写书目名称（同一本书用同一个名字，便于合并）')
      return
    }
    if (images.length === 0) {
      markUploadFailed('请先选择或拍摄至少一张图片')
      return
    }
    markUploadStarted()
    try {
      const result = await submitDictionaryScans({
        images,
        sourceBook: book.trim(),
        pageKind,
      })
      markUploadDone(result.batchId, result.scans)
      // 提交后轮询一次批量状态：服务端把已完成页解析成【待确认草稿】（不直接入库，
      // 人工核对后由管理员在服务端执行 npm run db:confirm 才写正式表）
      const batch = await fetchDictionaryBatch(result.batchId)
      const summary: ScanProcessSummary = batch.summary
      setUploadSummary(summary)
    } catch (error) {
      markUploadFailed(error instanceof Error ? error.message : '上传失败')
    }
  }

  if (!hasAdmin) {
    return (
      <Card>
        <CardBody className="space-y-3">
          <div className="flex items-center gap-2">
            <Lock className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-base">管理员入口</CardTitle>
          </div>
          <p className="text-sm text-muted-foreground">
            扫描识别需要管理员密钥。识别结果先暂存为「待确认」，核对无误才写入共享词典库。
            密钥只保存在内存中，刷新页面即失效。
          </p>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="管理员密钥"
            aria-label="管理员密钥"
            className="h-11 w-full rounded-xl border border-border bg-card px-3 text-sm outline-none focus:border-primary"
          />
          {adminError !== null && <p className="text-sm text-destructive">{adminError}</p>}
          <Button onClick={() => unlock(token)} className="w-full">
            解锁
          </Button>
        </CardBody>
      </Card>
    )
  }

  return (
    <div className="space-y-3">
      <Card>
        <CardBody className="space-y-3">
          <input
            value={book}
            onChange={(e) => setBook(e.target.value)}
            placeholder="书目名称，如《牛津初阶英汉双解》"
            aria-label="书目名称"
            className="h-11 w-full rounded-xl border border-border bg-card px-3 text-sm outline-none focus:border-primary"
          />
          <select
            value={pageKind}
            onChange={(e) => setPageKind(e.target.value as PageKind)}
            aria-label="页面类型"
            title="页面类型"
            className="h-11 w-full rounded-xl border border-border bg-card px-3 text-sm outline-none focus:border-primary"
          >
            {PAGE_KIND_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>

          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void pick(true)}
              disabled={!pickerOk}
              aria-label="从相册选择图片"
              title="从相册选择图片（可多选）"
            >
              <ImageIcon className="h-4 w-4" /> 相册
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void shoot()}
              disabled={!pickerOk}
              aria-label="拍摄识别"
              title={cameraOk ? '调用摄像头拍摄' : '当前环境不支持实时取景，将调用系统相机'}
            >
              <Camera className="h-4 w-4" /> 拍摄
            </Button>
          </div>

          {!pickerOk && (
            <p className="text-xs text-muted-foreground">当前环境不支持图片采集。</p>
          )}

          {images.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {images.map((img, i) => (
                <div
                  key={`${img.name}-${i}`}
                  className="flex items-center gap-1 rounded-lg bg-secondary px-2 py-1 text-xs"
                >
                  <span className="max-w-[10rem] truncate">{img.name}</span>
                  <button
                    type="button"
                    onClick={() => setImages((prev) => prev.filter((_, idx) => idx !== i))}
                    aria-label={`移除第 ${i + 1} 张图片`}
                    title="移除"
                    className="text-muted-foreground hover:text-destructive"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}

          <Button onClick={() => void submit()} disabled={uploading} className="w-full">
            <Upload className="h-4 w-4" />
            {uploading ? '提交中…' : `提交 ${images.length} 页`}
          </Button>

          {uploadError !== null && <ErrorState message={uploadError} />}
        </CardBody>
      </Card>

      {uploadedScans.length > 0 && (
        <Card>
          <CardBody className="space-y-2">
            <CardTitle className="text-base">本次提交</CardTitle>
            {uploadedScans.map((scan) => (
              <div key={scan.scanId} className="flex items-center justify-between text-sm">
                <span className="truncate text-muted-foreground">
                  {scan.scanId.slice(0, 8)}…
                </span>
                <span className="text-foreground">
                  {scan.status === 'parsed' ? '待确认' : scan.status}
                </span>
              </div>
            ))}
          </CardBody>
        </Card>
      )}

      {uploadSummary !== null && (
        <Card>
          <CardBody className="space-y-1 text-sm">
            <CardTitle className="mb-2 text-base">解析摘要（待确认）</CardTitle>
            <p>
              词条 <b>{uploadSummary.entriesUpserted}</b> 条 · 目录{' '}
              <b>{uploadSummary.tocUpserted}</b> 条 · 语法规则{' '}
              <b>{uploadSummary.grammarUpserted}</b> 条
            </p>
            <p className="text-xs text-muted-foreground">
              识别到 {uploadSummary.blocks} 个文本块 / {uploadSummary.tables} 张表格
              {uploadSummary.parserRulesUpdated ? ' · 已更新本书解析规则' : ''}
            </p>
            <p className="text-xs text-muted-foreground">
              以上数据尚未入库。核对无误后请在服务端执行 npm run db:review / db:confirm。
            </p>
          </CardBody>
        </Card>
      )}

      <button
        type="button"
        onClick={() => void resetDictCache()}
        className="flex w-full items-center justify-between rounded-xl px-1 py-2 text-xs text-muted-foreground"
        aria-label="清空本地词典缓存"
        title="清空本地词典缓存（不会删除服务端数据）"
      >
        清空本地缓存
        <ChevronRight className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
