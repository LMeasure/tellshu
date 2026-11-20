import { useMemo, useState } from 'react'
import {
  Volume2,
  Mic,
  Network,
  GitBranch,
  Contrast,
  Dna,
  BookOpen,
} from 'lucide-react'
import type { ContentWord } from '@/data/types'
import { useAppStore } from '@/store/useAppStore'
import { IconExpandCrown, IconCollapseBars } from '@/components/icons/shushu'
import { cn } from '@/lib/utils'
import { parseDefinitionZh } from '@/lib/wordSense'
import { WordCardExampleList } from '@/components/learning/WordCardExampleList'
import {
  speakFocused,
  isSpeechSupported,
  listen,
  isRecognitionSupported,
  pronunciationScore,
} from '@/lib/speech'

/**
 * 单词卡：渲染真实内容（OpenEtymology 字段），缺失字段静默降级。
 * 交互：
 *  - 点读：Web Speech API 实时合成（无音频文件也能真发声）。
 *  - 跟读：Web Speech Recognition 识别 + 相似度评分（MVP 字符串比对）。
 *  - 收藏：卡片上不提供 —— 整轮学完由学习流程自动加入生词本（2026-10-06 改）。
 */
export function WordCard({ word }: { word: ContentWord }) {
  const { settings } = useAppStore()
  /**
 * `chineseAssist`（设置页「中文辅助」）在学习卡里**只管助记提示（💡 word_hint）**；
 *   例句的中文翻译**常驻显示**（本轮统一：全局固定展示，不再受开关控制）。
 * 核心中文释义**永远显示**（2026-10-31 用户拍板）：释义是这张卡的主信息，
   * 不该因为一个「辅助」开关就没了 —— 尤其是零基础用户，看不懂释义这张卡就没有意义。
   * 注意：本文件只服务学习页 /learn；WordDetail 与其它页面的既有逻辑一行未动。
   */
  const showChineseAssist = settings.chineseAssist
  /**
   * 释义分组（2026-10-31 修复「释义不显示 / 多义项挤成一行」）：
   * 真实数据里 definition_zh 是一整串带词性前缀的中文释义，例如
   *   by → "prep. 在...旁边；通过（某种方式）；…；adv. 经过；附近；搁置"
   * 以前直接整串塞进一个 <p>，词性不分列、义项不逐条（全库 89.6% 的词条是多义项）。
   * 这里改用详情页同款纯函数 parseDefinitionZh 切分后分列展示，**一条不丢**。
   * 中文释义为空时才退回英文释义；两者都没有就显示明确提示，绝不留下空白。
   */
  const groups = useMemo(
    () => parseDefinitionZh(word.definition_zh ?? word.definition_en),
    [word.definition_zh, word.definition_en],
  )
  /** 词性列按本词最长词性留位（对齐单词详情页口径），位置固定不跳动 */
  const posColWidth = useMemo(() => {
    const maxLen = groups.reduce((m, g) => Math.max(m, (g.pos || word.pos || '释义').length), 0)
    return `${Math.min(Math.max(maxLen, 2), 12)}ch`
  }, [groups, word.pos])
  const examples = word.examples?.length
    ? word.examples
    : word.example_en
      ? [{ en: word.example_en, zh: word.example_zh ?? '' }]
      : []
  const [speaking, setSpeaking] = useState(false)
  const slow = settings.speed === 'slow'
  const canSpeak = isSpeechSupported() || Boolean(word.audio_path)

  const [listening, setListening] = useState(false)
  const [followText, setFollowText] = useState('')
  const [followScore, setFollowScore] = useState<number | null>(null)

  function handleSpeak() {
    if (word.audio_path) return
    setSpeaking(true)
    void speakFocused(word.word, slow).finally(() => setSpeaking(false))
  }

  async function handleFollow() {
    if (!isRecognitionSupported()) {
      setFollowText('当前浏览器不支持语音识别（可换 Chrome 试试）')
      setFollowScore(null)
      return
    }
    setListening(true)
    setFollowScore(null)
    setFollowText('')
    try {
      const text = await listen({ lang: 'en-US', onPartial: setFollowText })
      setFollowText(text)
      setFollowScore(pronunciationScore(word.word, text))
    } catch {
      setFollowText('识别失败，请重试')
    } finally {
      setListening(false)
    }
  }

  const followOk = followScore !== null && followScore >= 70

  return (
    <div className="rounded-lg bg-card p-5 shadow-soft">
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-bold text-foreground">{word.word}</span>
            {word.pos && <span className="text-xs text-muted-foreground">{word.pos}</span>}
          </div>
          {word.ipa && <div className="mt-1 text-sm text-muted-foreground">/{word.ipa}/</div>}
        </div>
        <div className="flex items-center gap-1">
          {canSpeak && (
            <button
              onClick={handleSpeak}
              onAnimationEnd={() => setSpeaking(false)}
              className={cn(
                'flex h-10 w-10 items-center justify-center rounded-full bg-secondary text-primary touch-target',
                speaking && 'animate-pulse',
              )}
              aria-label="点读"
              title={slow ? '慢速点读' : '点读'}
            >
              <Volume2 className="h-5 w-5" />
            </button>
          )}
          <button
            onClick={handleFollow}
            disabled={listening}
            className={cn(
              'flex h-10 w-10 items-center justify-center rounded-full touch-target',
              listening ? 'bg-accent text-white animate-pulse' : 'bg-secondary text-primary',
            )}
            aria-label="跟读"
            title="跟读评测"
          >
            <Mic className="h-5 w-5" />
          </button>
        </div>
      </div>

      {groups.length > 0 ? (
        <div className="mt-3 space-y-2" data-testid="word-senses">
          {groups.map((g, gi) => (
            <div key={`${g.pos}-${gi}`} className="flex items-start gap-2">
              {/* 词性标签：固定宽度独立列（宽=本词最长词性），右侧与释义统一间距由 gap-2 保证 */}
              <span
                className="shrink-0 text-[13px] italic leading-relaxed text-muted-foreground"
                style={{ width: posColWidth }}
              >
                {g.pos || word.pos || '释义'}
              </span>
              {/* 同词性多义项用中文分号「；」连成同一行；超出一行时在本 <p> 内自然换行，
                  续行左边缘对齐到释义文字起点（而非词性标签）。布局用 flex，不用空格对齐。 */}
              <p
                className="min-w-0 flex-1 break-words text-base leading-relaxed text-foreground"
                data-testid="word-sense-line"
              >
                {g.senses.join('；')}
              </p>
            </div>
          ))}
        </div>
      ) : (
        /* 确实没有释义数据才提示（与开关无关），绝不显示空白 */
        <p className="mt-3 text-sm text-muted-foreground" data-testid="word-senses-empty">
          该词暂未收录释义。
        </p>
      )}

      {/* 助记提示属于「额外辅助」：中文辅助关闭时收起 */}
      {showChineseAssist && word.word_hint && (
        <div
          className="mt-3 rounded-md bg-secondary/60 px-3 py-2 text-sm text-secondary-foreground"
          data-testid="word-hint"
        >
          💡 {word.word_hint}
        </div>
      )}

      {listening && (
        <div className="mt-3 rounded-md bg-accent/10 px-3 py-2 text-sm text-accent">
          正在聆听，请跟读「{word.word}」…
        </div>
      )}
      {!listening && followText && (
        <div
          className={cn(
            'mt-3 rounded-md px-3 py-2 text-sm',
            followScore === null
              ? 'bg-secondary/60 text-secondary-foreground'
              : followOk
                ? 'bg-emerald-500/10 text-emerald-600'
                : 'bg-amber-500/10 text-amber-600',
          )}
        >
          {followScore === null ? (
            <span>{followText}</span>
          ) : (
            <span>
              你读的：{followText} ・ 相似度 <b>{followScore}%</b> ・
              {followOk ? '很棒！' : '再试试'}
            </span>
          )}
        </div>
      )}

      {examples.length > 0 && (
        <details className="mt-3 group" open>
          <summary className="flex cursor-pointer list-none items-center gap-1 text-sm font-medium text-primary">
            {/* 需求 22 / 23：展开用 9 号双下箭，收起用两条平杠（同框同风格） */}
            <IconExpandCrown className="h-4 w-4 group-open:hidden" />
            <IconCollapseBars className="hidden h-4 w-4 group-open:block" />
            {'双语例句'}（{examples.length}）
          </summary>
          {/* 例句列表：英文可点词查词，中文翻译随「中文辅助」开关 */}
          <WordCardExampleList examples={examples} />
        </details>
      )}

      {word.morphemes?.length ? (
        <div className="mt-3 rounded-md border border-border/60 p-3">
          <div className="mb-2 flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <Dna className="h-3.5 w-3.5" /> 词根词缀
          </div>
          <ul className="space-y-1 text-sm">
            {word.morphemes.map((m, i) => (
              <li key={i}>
                <span className="rounded bg-secondary px-1.5 py-0.5 font-medium text-secondary-foreground">
                  {m.form}
                </span>
                <span className="ml-1.5 text-foreground">{m.meaning}</span>
                {m.note && (
                  <span className="ml-1 text-[11px] text-muted-foreground">（{m.note}）</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {word.etymology && (
        <div className="mt-3 rounded-md border border-border/60 p-3">
          <div className="mb-1 flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <BookOpen className="h-3.5 w-3.5" /> 词源
          </div>
          <p className="text-sm leading-relaxed text-foreground">{word.etymology}</p>
        </div>
      )}

      {(word.related?.length || word.antonyms?.length || word.relatives?.length) && (
        <div className="mt-3 rounded-md border border-border/60 p-3">
          <div className="mb-2 flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <Network className="h-3.5 w-3.5" /> 知识网络
          </div>
          <div className="space-y-2 text-sm">
            {word.related?.length ? (
              <div>
                <span className="text-muted-foreground">关联词：</span>
                {word.related.map((r) => (
                  <span
                    key={r}
                    className="mr-1.5 rounded bg-secondary px-1.5 py-0.5 text-secondary-foreground"
                  >
                    {r}
                  </span>
                ))}
              </div>
            ) : null}
            {word.antonyms?.length ? (
              <div className="flex items-start gap-1">
                <Contrast className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="text-muted-foreground">反义词：</span>
                <span className="flex flex-wrap gap-1">
                  {word.antonyms.map((a) => (
                    <span
                      key={a.term}
                      className="rounded bg-secondary px-1.5 py-0.5 text-secondary-foreground"
                    >
                      {a.term}
                      <span className="ml-0.5 text-[10px] text-muted-foreground">{a.rating}</span>
                    </span>
                  ))}
                </span>
              </div>
            ) : null}
            {word.relatives?.length ? (
              <div className="flex items-start gap-1">
                <GitBranch className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="text-muted-foreground">同根词：</span>
                <span className="flex flex-wrap gap-1">
                  {word.relatives.map((r) => (
                    <span
                      key={r}
                      className="rounded bg-secondary px-1.5 py-0.5 text-secondary-foreground"
                    >
                      {r}
                    </span>
                  ))}
                </span>
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  )
}
