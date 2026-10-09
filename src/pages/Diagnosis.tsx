import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { BookOpen, Headphones, Type, Sparkles, Loader2 } from 'lucide-react'
import { Progress } from '@/components/ui/progress'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { repository } from '@/data/repository'
import { DATA_VERSION } from '@/data/dataClient'
import { gradeDiagnosis, saveDiagnoseResult, type DiagnoseAnswer } from '@/domain/learning'
import type { ContentDiagnostic, DifficultyLevel } from '@/data/types'

const LEVEL_ICON: Record<DifficultyLevel, typeof Type> = {
  1: Type,
  2: BookOpen,
  3: Headphones,
}

const LEVEL_NAME: Record<DifficultyLevel, string> = {
  1: '起步级',
  2: '基础级',
  3: '进阶级',
}

/**
 * 诊断测试：5 题梯度（L1 最基础 ×2 / L2 基础词汇 ×2 / L3 难词 ×1，见 01-PRD §5）。
 * 题目由真实词库（OpenEtymology 五本，22,791 词）现场生成；
 * 词库不可用时渲染空状态，**绝不编造题目**。
 * 答完按梯度定级，写入本地库并据此推荐起始词本。
 */
export function Diagnosis() {
  const navigate = useNavigate()
  const [questions, setQuestions] = useState<ContentDiagnostic[] | null>(null)
  const [idx, setIdx] = useState(0)
  const [picked, setPicked] = useState<string | null>(null)
  const [answers, setAnswers] = useState<DiagnoseAnswer[]>([])
  const [result, setResult] = useState<ReturnType<typeof gradeDiagnosis> | null>(null)

  useEffect(() => {
    repository.getDiagnostics().then(setQuestions)
  }, [])

  // 词库约 6MB，首诊有一次加载，这里给出明确进度反馈而不是干等
  if (questions === null) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 px-6 text-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
        <div className="text-sm text-muted-foreground">
          正在从本地词库生成题目…
          <br />
          （首次需要读取 CET-4 词本，约需几秒）
        </div>
      </div>
    )
  }

  if (questions.length === 0) {
    return (
      <EmptyState
        icon={BookOpen}
        title="词库未就绪"
        description={`诊断题是从本地 OpenEtymology 词库实时生成的。当前未能读取词库数据，请确认 data/linguabase/${DATA_VERSION}/ 已生成、且 VITE_DATA_BASE_URL 指向正确后重试。`}
      />
    )
  }

  // 结果页：定级 + 建议起始词本
  if (result) {
    const correct = answers.filter((a) => a.correct).length
    return (
      <div className="flex min-h-screen flex-col items-center justify-center px-6 text-center">
        <Sparkles className="mb-4 h-10 w-10 text-accent" />
        <h2 className="mb-1 text-2xl font-bold">
          你的起点：{LEVEL_NAME[result.level as DifficultyLevel]}
        </h2>
        <p className="mb-6 text-sm text-muted-foreground">
          答对 {correct} / {answers.length} 题 · 建议从「{result.start_book}」词本开始
        </p>
        <div className="mb-8 w-full space-y-2 text-left">
          {answers.map((a, i) => (
            <div
              key={i}
              className="flex items-center justify-between rounded-lg border border-border bg-card px-4 py-2 text-sm"
            >
              <span className="text-muted-foreground">第 {i + 1} 题（难度 {a.level}）</span>
              <span className={a.correct ? 'text-primary' : 'text-muted-foreground'}>
                {a.correct ? '答对' : '答错'}
              </span>
            </div>
          ))}
        </div>
        <Button className="w-full" size="lg" onClick={() => navigate('/')}>
          开始我的学习
        </Button>
      </div>
    )
  }

  const q = questions[idx]
  const Icon = LEVEL_ICON[q.difficulty_level]
  const isLast = idx === questions.length - 1

  const next = () => {
    const nextAnswers: DiagnoseAnswer[] = [
      ...answers,
      { level: q.difficulty_level, correct: picked === q.answer },
    ]
    setAnswers(nextAnswers)
    if (isLast) {
      const graded = gradeDiagnosis(nextAnswers)
      saveDiagnoseResult({
        correct: nextAnswers.filter((a) => a.correct).length,
        total: nextAnswers.length,
        level: graded.level,
        start_book: graded.start_book,
      })
      setResult(graded)
      return
    }
    setPicked(null)
    setIdx((i) => i + 1)
  }

  return (
    <div className="flex min-h-screen flex-col px-5 py-6">
      <div className="mb-1 flex items-center justify-between text-sm text-muted-foreground">
        <span>
          第 {idx + 1} / {questions.length} 题
        </span>
        <span className="flex items-center gap-1">
          <Icon className="h-4 w-4" /> 难度 {q.difficulty_level}
        </span>
      </div>
      <Progress value={((idx + 1) / questions.length) * 100} className="mb-6" />

      <h2 className="mb-5 text-xl font-semibold leading-snug">{q.question}</h2>

      <div className="space-y-3">
        {q.options.map((opt) => (
          <button
            key={opt}
            onClick={() => setPicked(opt)}
            className={`w-full rounded-xl border px-4 py-3 text-left text-base transition-colors touch-target ${
              picked === opt ? 'border-primary bg-primary/10' : 'border-border bg-card'
            }`}
          >
            {opt}
          </button>
        ))}
      </div>

      {picked && (
        <p className="mt-5 rounded-lg bg-secondary px-4 py-3 text-sm text-secondary-foreground">
          {picked === q.answer
            ? '答对了，继续保持！'
            : '没关系，我们换个方式学。'}
        </p>
      )}

      <div className="mt-auto pt-8">
        <Button className="w-full" size="lg" disabled={!picked} onClick={next}>
          {isLast ? '生成我的学习计划' : '下一题'}
        </Button>
      </div>
    </div>
  )
}
