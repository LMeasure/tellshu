/**
 * 词典扫描库（功能 B 的权限入口页）
 * ------------------------------------------------------------------
 * 路由 /dict-ingest，从「设置 → 词典扫描库（管理员）」进入。
 *
 * 四个页签：
 *   检索 —— 本地 Dexie 三档检索（精确 / 前缀 / 全文）+ 搜索建议 + 词条详情
 *   目录 —— 按书目展示目录树（缩进层级 + 页码区间）
 *   语法 —— 不规则动词 / 语法规则表格
 *   入库 —— 管理员口令解锁后批量上传扫描页（PaddleOCR → 解析 → upsert）
 *
 * 红线：
 *   - 平台 API（getMedia / canvas / Dexie）只在 services 层，本页不直接碰。
 *   - 数据只有两个来源：本地缓存与服务端同步；查不到就 EmptyState，不编造。
 *   - 管理员密钥只存在内存（useDictStore + dictClient 模块变量），刷新即失效。
 */

import { useEffect, useState } from 'react'
import { Database, RefreshCw, ScanLine } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Tabs } from '@/components/ui/tabs'
import { ErrorState } from '@/components/ui/error-state'
import { DictSearchPanel } from '@/components/dict/DictSearchPanel'
import { EntryDetailCard } from '@/components/dict/EntryDetailCard'
import { GrammarTableView, ScanUploadPanel, TocTreeView } from '@/components/dict/DictPanels'
import { useDictStore, type DictTab } from '@/store/useDictStore'
import type { DictEntry } from '@/domain/types'

const TAB_ITEMS: ReadonlyArray<{ key: DictTab; label: string }> = [
  { key: 'search', label: '检索' },
  { key: 'toc', label: '目录' },
  { key: 'grammar', label: '语法' },
  { key: 'upload', label: '扫描入库' },
]

export function DictIngest() {
  const tab = useDictStore((s) => s.tab)
  const setTab = useDictStore((s) => s.setTab)
  const syncing = useDictStore((s) => s.syncing)
  const syncError = useDictStore((s) => s.syncError)
  const lastSync = useDictStore((s) => s.lastSync)
  const cacheCount = useDictStore((s) => s.cacheCount)
  const syncFromServer = useDictStore((s) => s.syncFromServer)
  const refreshCacheCount = useDictStore((s) => s.refreshCacheCount)

  /** 检索页签里点中的词条，用于展示详情卡 */
  const [picked, setPicked] = useState<DictEntry | null>(null)

  // 进入页面先看一眼本地缓存规模（纯本地读，不联网）
  useEffect(() => {
    void refreshCacheCount()
  }, [refreshCacheCount])

  return (
    <div className="px-4 py-4">
      <h1 className="mb-1 flex items-center gap-2 text-xl font-bold">
        <ScanLine className="h-5 w-5 text-primary" aria-hidden />
        词典扫描库
      </h1>
      <p className="mb-4 text-sm text-muted-foreground">
        把纸质词典扫描页解析成结构化数据：搜单词 / 短语 / 语法点、看目录树与变形表。
        新扫描的数据会与已有数据合并补全，不会覆盖已有释义。
      </p>

      <div className="mb-4 flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => void syncFromServer()}
          disabled={syncing}
          aria-label="从服务端同步词典数据"
          title="增量同步服务端已入库的词条 / 目录 / 语法规则"
        >
          <RefreshCw className={syncing ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
          {syncing ? '同步中…' : '同步服务端数据'}
        </Button>
        <span className="text-xs text-muted-foreground">
          本地缓存 {cacheCount.entries} 词条 · {cacheCount.toc} 目录 · {cacheCount.grammar} 语法
        </span>
      </div>

      {syncError !== null && <ErrorState message={syncError} onRetry={() => void syncFromServer()} />}

      {lastSync !== null && (
        <p className="mb-3 rounded-lg bg-secondary/60 px-3 py-2 text-xs text-muted-foreground">
          上次同步：新增/更新 词条 {lastSync.entries} · 目录 {lastSync.toc} · 语法{' '}
          {lastSync.grammar}
        </p>
      )}

      <Tabs
        items={TAB_ITEMS.map((it) => ({ key: it.key, label: it.label }))}
        active={tab}
        onChange={(k) => setTab(k as DictTab)}
        className="mb-4"
      />

      {tab === 'search' && (
        <div className="space-y-3">
          <DictSearchPanel
            onPickEntry={(entry) => setPicked((prev) => (prev?.key === entry.key ? null : entry))}
          />
          {picked !== null && <EntryDetailCard entry={picked} />}
        </div>
      )}

      {tab === 'toc' && <TocTreeView />}

      {tab === 'grammar' && <GrammarTableView />}

      {tab === 'upload' && <ScanUploadPanel />}

      <p className="mt-6 flex items-start gap-2 px-1 text-xs leading-relaxed text-muted-foreground">
        <Database className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        说明：OCR 识别结果在云端只保留 30 天，入库后的结构化数据才长期可查。
        上传页提交后请回到本页点「同步服务端数据」把新数据拉到本地。
      </p>
    </div>
  )
}
