import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, BookOpen } from 'lucide-react'
import { Card, CardBody } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/empty-state'
import { OfflineNotice } from '@/components/OfflineNotice'
import { useOnline } from '@/lib/offline'
import { repository } from '@/data/repository'
import type { ContentWord } from '@/data/types'

/** 每页词条数：百万级词库必须分页，一次渲染上千条会卡死移动端 */
const PAGE = 80

const LEVEL_LABEL: Record<string, string> = {
  L1: '基础常用',
  L2: '进阶常用',
  L3: '长尾 / 专业',
}

const LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('')

/**
 * 全量词库词条页
 * ------------------------------------------------------------------
 * /bank/theme/:id    45 个日常主题（动物 / 水果 / 颜色 …）
 * /bank/level/:key   难度档：L1 / L2 直接列词；L3 百万级先选首字母再列词
 *
 * 数据全部来自 Linguabase(CC0)：词条为真实英文单词 + 真实难度档 + 真实词频序。
 * Linguabase **不提供中文释义与音标**，故这里只展示英文释义，并明确标注来源，
 * 绝不编造中文/音标（见「不编造数据」原则）。
 */
export function WordBank() {
  const { kind = '', key = '' } = useParams()
  const navigate = useNavigate()
  const [words, setWords] = useState<ContentWord[] | null>(null)
  const [defs, setDefs] = useState<Record<string, string>>({})
  const [title, setTitle] = useState('')
  const [limit, setLimit] = useState(PAGE)
  // 分片按需缓存：断网时打开没访问过的分页会是空列表，需要给出明确说法
  const offline = !useOnline()

  // L3 选字母：key 为 'L3' 时先渲染字母表，选中后再加载对应分片
  const isLetterPicker = kind === 'level' && key === 'L3'

  useEffect(() => {
    if (isLetterPicker) {
      setTitle('长尾 / 专业词库 · 选择首字母')
      setWords([])
      return
    }
    let alive = true
    setWords(null)
    setDefs({})
    setLimit(PAGE)

    void (async () => {
      if (kind === 'theme') {
        const themes = await repository.getLinguaThemes()
        const t = themes.find((x) => x.id === key)
        if (!t) {
          if (alive) setWords([])
          return
        }
        if (alive) setTitle(`${t.name_zh} · ${t.name}`)
        const [w, d] = await Promise.all([
          repository.getLinguaThemeWords(key),
          repository.getLinguaDefs(`themes_${key}`),
        ])
        if (alive) {
          setWords(w)
          setDefs(d)
        }
        return
      }
      // kind === 'level'
      const base = key.split('_')[0]
      const suffix = key.includes('_') ? key.slice(key.indexOf('_') + 1) : ''
      if (alive) {
        setTitle(
          `${LEVEL_LABEL[base] ?? base}词库${suffix ? ` · 首字母 ${suffix.toUpperCase()}` : ''}`,
        )
      }
      const [w, d] = await Promise.all([
        repository.getLinguaBankWords(`bank/${key}.json`),
        repository.getLinguaDefs(`bank_${key}`),
      ])
      if (alive) {
        setWords(w)
        setDefs(d)
      }
    })()

    return () => {
      alive = false
    }
  }, [kind, key, isLetterPicker])

  const shown = (words ?? []).slice(0, limit)

  return (
    <div className="px-4 py-4">
      <div className="mb-3 flex items-center gap-2">
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="rounded-full p-1 text-muted-foreground"
          aria-label="返回"
        >
          <ArrowLeft size={20} />
        </button>
        <h1 className="text-base font-semibold">{title || '词库'}</h1>
      </div>

      {isLetterPicker ? (
        <div className="grid grid-cols-6 gap-2">
          {[...LETTERS, 'other'].map((ch) => (
            <button
              key={ch}
              type="button"
              onClick={() => navigate(`/bank/level/L3_${ch}`)}
              className="rounded-lg bg-secondary py-3 text-sm font-medium uppercase"
            >
              {ch === 'other' ? '#' : ch}
            </button>
          ))}
        </div>
      ) : words === null ? (
        <div className="p-4 text-sm text-muted-foreground">加载中…</div>
      ) : words.length === 0 ? (
        <>
          {offline && (
            <OfflineNotice>
              这个词库分片你还没有打开过，所以本地没有缓存。联网打开一次，之后断网也能看。
            </OfflineNotice>
          )}
          <EmptyState
            icon={BookOpen}
            title={offline ? '离线 · 该内容未缓存' : '暂无词条'}
            description={
              offline
                ? '词库是按需缓存的，只有打开过的分片才会存在本机。联网打开一次本页即可。'
                : '该分类下没有可用单词（数据缺失时留空，不编造）。'
            }
          />
        </>
      ) : (
        <>
          <div className="mb-2 text-xs text-muted-foreground">
            共 {words.length.toLocaleString()} 词 · 已显示 {shown.length} · 数据来自
            Linguabase(CC0)，仅提供英文释义
          </div>
          <div className="space-y-2">
            {shown.map((w) => (
              <Card key={w.id}>
                <CardBody>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-sm font-semibold">{w.word}</span>
                    <div className="flex shrink-0 items-center gap-1">
                      <Badge>L{w.difficulty_level}</Badge>
                      {typeof w.frequency_rank === 'number' && (
                        <span className="text-[10px] text-muted-foreground">
                          #{w.frequency_rank.toLocaleString()}
                        </span>
                      )}
                    </div>
                  </div>
                  {defs[w.word] ? (
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      {defs[w.word]}
                    </p>
                  ) : (
                    <p className="mt-1 text-xs text-muted-foreground/60">
                      {offline ? '（离线，英文释义未缓存）' : '（暂无英文释义）'}
                    </p>
                  )}
                </CardBody>
              </Card>
            ))}
          </div>
          {limit < words.length && (
            <button
              type="button"
              onClick={() => setLimit((n) => n + PAGE)}
              className="mt-3 w-full rounded-lg bg-secondary py-2 text-sm"
            >
              加载更多（还有 {(words.length - limit).toLocaleString()} 词）
            </button>
          )}
        </>
      )}
    </div>
  )
}
