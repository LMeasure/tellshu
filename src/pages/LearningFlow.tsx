import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useNavigate } from 'react-router-dom'
import { ChevronLeft, ChevronRight, Sparkles, Layers, PartyPopper } from 'lucide-react'
import { Progress } from '@/components/ui/progress'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Dialog } from '@/components/ui/dialog'
import { WordCard } from '@/components/learning/WordCard'
import { FireworkBurst } from '@/components/fx/FireworkBurst'
import { repository, sortWords } from '@/data/repository'
import { bucketByDifficulty } from '@/lib/diagnostic'
import { useAppStore } from '@/store/useAppStore'
import { addManyToVocab, getLayerCounts } from '@/domain/learning'
import type { ContentWord, DifficultyLevel } from '@/data/types'

/**
 * 完成一轮的鼓励语。按「第几轮」取，同一轮重复打开看到的是同一句，
 * 轮次推进自然换一句 —— 不用随机数，避免刷新就跳字。
 */
const ENCOURAGE = [
  '万事开头难，最难的那一步你已经走完了。',
  '每天一点点，比一次猛学一整天更管用。',
  '这些词已经进了生词本，明天复习一次就稳了。',
  '能坚持走完一轮，词汇量已经在涨了。',
  '别急着赶进度，真正记住的才是你自己的。',
]

interface RoundResult {
  /** 本轮词数 */
  total: number
  /** 本次新进生词本的词数 */
  added: number
  /** 原本就在生词本里的（不重置其进度） */
  existed: number
  /** 生词本现有总词数 */
  vocabTotal: number
}

/**
 * 学习流程（见 04 §2.4、05 §2.4）：单词卡浏览 → 点读/跟读（卡片内完成），
 * 整轮学完由 finishRound 自动加入生词本（卡片上不提供手动收藏）。
 * 支持：
 *   ?book=CET4        指定词本（默认第一本）
 *   ?level=1          只学该难度档（由学习路径带过来）
 * 每轮词数取设置里的 studyBatchSize，分批推进；改设置立即生效。
 */
export function LearningFlow() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const bookParam = params.get('book')
  const levelParam = params.get('level')

  const batchSize = useAppStore((s) => s.settings.studyBatchSize)

  const [allWords, setAllWords] = useState<ContentWord[] | null>(null)
  const [batchIdx, setBatchIdx] = useState(0)
  const [idx, setIdx] = useState(0)
  /** 一轮学完的结算弹窗（null = 不弹） */
  const [roundResult, setRoundResult] = useState<RoundResult | null>(null)
  const [saving, setSaving] = useState(false)
  /** 点「完成」后的烟花庆祝（挂载即放，放完自动卸载） */
  const [celebrate, setCelebrate] = useState(false)

  useEffect(() => {
    let active = true
    repository.getBookIndex().then(async (bs) => {
      if (!active) return
      const id = bookParam && bs.some((b) => b.id === bookParam) ? bookParam : (bs[0]?.id ?? 'CET4')
      const raw = await repository.getWords(id)
      if (!active) return
      let pool = raw
      const lv = Number(levelParam)
      if (lv === 1 || lv === 2 || lv === 3) {
        // 按真实特征分档（词长 + 语素），与诊断/路径口径一致
        const picked = bucketByDifficulty(raw)[lv as DifficultyLevel]
        const ids = new Set(picked.map((w) => w.id))
        pool = raw.filter((w) => ids.has(w.id))
      }
      setAllWords(sortWords(pool))
    })
    return () => {
      active = false
    }
  }, [bookParam, levelParam])

  // 切换批次 / 词本时回到组内第一张
  useEffect(() => {
    setIdx(0)
  }, [batchIdx, bookParam, levelParam])

  const batches = useMemo(() => {
    if (!allWords) return []
    const out: ContentWord[][] = []
    for (let i = 0; i < allWords.length; i += batchSize) {
      out.push(allWords.slice(i, i + batchSize))
    }
    return out
  }, [allWords, batchSize])

  if (allWords === null) {
    return <div className="p-6 text-sm text-muted-foreground">加载学习内容…</div>
  }

  if (allWords.length === 0) {
    return (
      <EmptyState
        icon={Sparkles}
        title="学习内容待接入"
        description="知识卡由 OpenEtymology 词包驱动，前端按字段自动渲染。"
      />
    )
  }

  const realBatch = Math.min(batchIdx, Math.max(0, batches.length - 1))
  const group = batches[realBatch] ?? []
  const current = group[idx]
  const isLastInGroup = idx >= group.length - 1
  const isLastGroup = realBatch >= batches.length - 1

  /**
   * 结束一轮：把本轮的词**自动加入生词本**（layer=new，10min 后首次复习），
   * 之后就交给「生词 → 运用 → 掌握」的 SRS 闯关逻辑推进。
   * 已经在生词本里的不会被重置（addManyToVocab 保证）。
   */
  async function finishRound() {
    if (saving) return
    setSaving(true)
    try {
      const res = await addManyToVocab(
        group.map((w) => ({
          id: w.id,
          word: w.word,
          book: w.book,
          ipa: w.ipa,
          definition_zh: w.definition_zh,
          pos: w.pos,
        })),
      )
      const counts = await getLayerCounts()
      setRoundResult({
        total: group.length,
        added: res.added,
        existed: res.existed,
        vocabTotal: counts.total,
      })
    } finally {
      setSaving(false)
    }
  }

  function nextGroup() {
    setBatchIdx(realBatch + 1)
    setIdx(0)
    setRoundResult(null)
  }

  return (
    <div className="flex min-h-screen flex-col px-4 py-4">
      <div className="mb-2 flex items-center justify-between">
        <button onClick={() => navigate(-1)} className="text-muted-foreground">
          <ChevronLeft className="h-6 w-6" />
        </button>
        <Progress value={((idx + 1) / group.length) * 100} className="mx-3 flex-1" />
        <span className="text-xs text-muted-foreground">
          {idx + 1}/{group.length}
        </span>
      </div>

      <div className="mb-3 flex items-center justify-center gap-1 text-xs text-muted-foreground">
        <Layers className="h-3.5 w-3.5" />
        第 {realBatch + 1} / {batches.length} 组 · 每组 {batchSize} 词
      </div>

      <div className="flex-1">
        {current && <WordCard word={current} />}
      </div>

      <div className="mt-3 flex gap-2">
        <Button
          variant="outline"
          className="flex-1"
          disabled={idx === 0 && realBatch === 0}
          onClick={() => {
            if (idx === 0 && realBatch > 0) setBatchIdx(realBatch - 1)
            else setIdx((i) => Math.max(0, i - 1))
          }}
        >
          <ChevronLeft className="h-4 w-4" /> 上一张
        </Button>
        <Button
          className="flex-1"
          disabled={saving}
          onClick={() => {
            if (isLastInGroup) {
              // 一轮走完：先结算（弹窗内再决定继续下一组或点「完成」庆祝）
              void finishRound()
            } else {
              setIdx((i) => i + 1)
            }
          }}
        >
          {isLastInGroup ? (isLastGroup ? '学完了' : '完成本轮') : '下一张'}
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>

      {/* 一轮学完：鼓励 + 真实结算（不编造数字） */}
      <Dialog
        open={roundResult !== null}
        onClose={() => setRoundResult(null)}
        title={
          <span className="flex items-center justify-center gap-1.5">
            <PartyPopper className="h-5 w-5 text-accent" /> 这一轮学完了
          </span>
        }
        footer={
          <>
            {isLastGroup ? (
              <Button variant="primary" className="w-full" onClick={() => navigate('/review')}>
                <Sparkles className="h-4 w-4" /> 去生词本闯关
              </Button>
            ) : (
              <Button variant="primary" className="w-full" onClick={nextGroup}>
                继续下一组 <ChevronRight className="h-4 w-4" />
              </Button>
            )}
            {isLastGroup ? (
              <Button variant="outline" className="w-full" onClick={() => setRoundResult(null)}>
                留在这里
              </Button>
            ) : (
              /* 学习时不提供生词本跳转：副按钮就是「完成」，配烟花庆祝后留在原地 */
              <Button
                variant="outline"
                className="w-full"
                onClick={() => {
                  setRoundResult(null)
                  setCelebrate(true)
                }}
              >
                完成
              </Button>
            )}
          </>
        }
      >
        {roundResult && (
          <div className="space-y-2">
            <p className="text-base font-medium text-foreground">
              {ENCOURAGE[realBatch % ENCOURAGE.length]}
            </p>
            <p>
              本轮 {roundResult.total} 词已加入生词本
              {roundResult.existed > 0 && `（其中 ${roundResult.existed} 个之前就在）`}
            </p>
            <p className="text-xs">
              生词本现有 {roundResult.vocabTotal} 词 · 接下来按
              <b className="text-foreground">生词 → 运用 → 掌握</b> 的节奏复习
            </p>
          </div>
        )}
      </Dialog>

      {/* 点「完成」后的烟花庆祝：放完自动卸载（prefers-reduced-motion 时 CSS 直接隐藏） */}
      {celebrate && <FireworkBurst onDone={() => setCelebrate(false)} />}
    </div>
  )
}
