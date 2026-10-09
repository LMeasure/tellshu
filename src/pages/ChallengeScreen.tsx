import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronLeft, Check, X, Sparkles, Volume2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { EmptyState } from '@/components/ui/empty-state'
import { repository } from '@/data/repository'
import { getDueReviews, recordQuiz, type VocabEntry } from '@/domain/learning'
import { useAppStore } from '@/store/useAppStore'
import { speakFocused, isSpeechSupported } from '@/lib/speech'
import { buildQuizQuestions, type QuizQuestion, type QuizDrop } from '@/lib/reviewQuiz'
import { OFFLINE_QUIZ_HINT } from '@/lib/offlineCopy'

/** 题目形状由纯函数层定义，这里起个别名保持本文件内写法不变 */
type Question = QuizQuestion

/**
 * 生词本闯关（见 04 §5.7、05 §5.7、06 §4）：
 * 选词义题型，干扰项从同难度其他词随机抽 3 个；连续对 5 次（同一题型不轮替）晋级；
 * 答对按遗忘曲线推后 next_review，答错清零并回流错题本。完全离线可用。
 */
export function ChallengeScreen() {
  const navigate = useNavigate()
  const batchSize = useAppStore((s) => s.settings.studyBatchSize)
  const [questions, setQuestions] = useState<QuizQuestion[] | null>(null)
  /** 本轮到期词条总数 —— 用来区分「真的没到期」和「有到期词但组不出题」 */
  const [dueCount, setDueCount] = useState(0)
  const [drops, setDrops] = useState<QuizDrop[]>([])
  const [idx, setIdx] = useState(0)
  const [answered, setAnswered] = useState(false)
  const [picked, setPicked] = useState<string | null>(null)
  const [streak, setStreak] = useState(0)
  const [done, setDone] = useState(0)
  const [promoted, setPromoted] = useState(0)

  useEffect(() => {
    let active = true
    getDueReviews()
      .then(async (all) => {
        if (!active) return
        setDueCount(all.length)
        // 本轮题量取设置里的每轮词数（超出的部分留到下一轮）
        const batch = all.slice(0, batchSize)
        if (batch.length === 0) {
          setQuestions([])
          return
        }
        // 词本**可以拿不到**：离线且分片未缓存时会返回空数组。
        // 组题优先用生词入库时已持久化的释义，所以拿不到也不影响出题。
        const books = [...new Set(batch.map((x) => x.book).filter(Boolean))] as string[]
        const pools = await Promise.all(books.map((b) => repository.getWords(b)))
        if (!active) return
        const { questions: qs, dropped } = buildQuizQuestions(batch, pools.flat())
        setDrops(dropped)
        setQuestions(qs)
      })
      .catch(() => {
        if (active) {
          setQuestions([])
          setDueCount(0)
        }
      })
    return () => {
      active = false
    }
  }, [batchSize])

  const q = questions?.[idx]
  const isLast = questions ? idx >= questions.length - 1 : false

  async function choose(opt: string) {
    if (!q || answered) return
    const correct = opt === q.correct
    setAnswered(true)
    setPicked(opt)
    const prevLayer = q.entry.layer
    const updated = await recordQuiz(q.entry.word_id, correct, 'choose-meaning')
    if (updated) {
      setStreak(updated.consecutive_correct)
      if (correct && updated.layer !== prevLayer) setPromoted((p) => p + 1)
    } else {
      setStreak(correct ? q.entry.consecutive_correct + 1 : 0)
    }
    setDone((d) => d + 1)
    window.setTimeout(() => {
      if (isLast) return // 停留完成页（answered 保持 true）
      setIdx((i) => i + 1)
      setAnswered(false)
      setPicked(null)
    }, 850)
  }

  if (questions === null) {
    return <div className="p-6 text-sm text-muted-foreground">加载复习队列…</div>
  }

  if (questions.length === 0) {
    // 这里必须区分两种情况。以前统一显示「暂无可复习」，
    // 导致「有到期词但组不出题」被误报成「没有到期词」，用户会以为数据丢了。
    const blocked = dueCount > 0
    return (
      <EmptyState
        icon={Sparkles}
        title={blocked ? `${dueCount} 个词到期了，但没能组出题目` : '暂无可复习'}
        description={
          blocked
            ? `${OFFLINE_QUIZ_HINT}（未能出题的词：${drops
                .map((d) => d.word)
                .slice(0, 5)
                .join('、')}${drops.length > 5 ? ' 等' : ''}）`
            : '去单词卡点「生词本」加入几个词，加入即排程 10 分钟后复习；答对后会在 1 小时 / 1 天 / 3 天…后再次出现。'
        }
      />
    )
  }

  if (isLast && answered) {
    return (
      <div className="px-4 py-6">
        <EmptyState
          icon={Check}
          title="本轮闯关完成"
          description={`本轮复习 ${done} 词，晋级 ${promoted} 个。它们会按遗忘曲线在 1 小时 / 1 天 / 3 天 / 7 天 / 14 天 / 30 天后再次出现。`}
        />
        <div className="mt-4 flex gap-2">
          <Button variant="outline" className="flex-1" onClick={() => navigate('/review')}>
            返回复习
          </Button>
          <Button className="flex-1" onClick={() => navigate('/')}>
            回首页
          </Button>
        </div>
      </div>
    )
  }

  if (!q) return null

  return (
    <div className="flex min-h-screen flex-col px-4 py-4">
      <div className="mb-4 flex items-center justify-between">
        <button onClick={() => navigate(-1)} className="text-muted-foreground">
          <ChevronLeft className="h-6 w-6" />
        </button>
        <Progress value={((idx + 1) / questions.length) * 100} className="mx-3 flex-1" />
        <span className="text-xs text-muted-foreground">
          {idx + 1}/{questions.length}
        </span>
      </div>

      <div className="flex-1">
        <div className="rounded-lg bg-card p-5 shadow-soft">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-3xl font-bold">{q.word}</div>
              {q.ipa && <div className="mt-1 text-sm text-muted-foreground">/{q.ipa}/</div>}
            </div>
            {isSpeechSupported() && (
              <button
                onClick={() => void speakFocused(q.word, true)}
                className="flex h-10 w-10 items-center justify-center rounded-full bg-secondary text-primary"
                aria-label="听发音"
              >
                <Volume2 className="h-5 w-5" />
              </button>
            )}
          </div>
          <p className="mt-3 text-sm text-muted-foreground">听音 / 看词，选出正确中文释义：</p>
          <div className="mt-3 space-y-2">
            {q.options.map((opt, i) => {
              const isCorrect = opt === q.correct
              const isPicked = opt === picked
              const cls = !answered
                ? 'bg-secondary text-foreground'
                : isCorrect
                  ? 'bg-emerald-500 text-white'
                  : isPicked
                    ? 'bg-rose-500 text-white'
                    : 'bg-secondary text-muted-foreground'
              return (
                <button
                  key={i}
                  disabled={answered}
                  onClick={() => choose(opt)}
                  className={`w-full rounded-lg px-4 py-3 text-left text-sm ${cls}`}
                >
                  {opt}
                </button>
              )
            })}
          </div>
          {answered && (
            <div className={`mt-3 text-sm ${picked === q.correct ? 'text-emerald-600' : 'text-rose-600'}`}>
              {picked === q.correct ? (
                <>
                  <Check className="mr-1 inline h-4 w-4" /> 答对！
                </>
              ) : (
                <>
                  <X className="mr-1 inline h-4 w-4" /> 正确：{q.correct}
                </>
              )}
            </div>
          )}
        </div>
        <div className="mt-3 text-center text-sm text-muted-foreground">
          连续答对 <b className="text-accent">{streak}</b> / 5 晋级
        </div>
      </div>
    </div>
  )
}
