/**
 * 轻量词形还原（Phase 2 M3）
 * ------------------------------------------------------------------
 * 场景：学习稿 vocabulary 的词形来自 LLM 输出（lemma 倾向，如
 * "look" / "looking" 混用），与字幕原文、词库词形都可能不同。
 * 查本地 dictEntries 前先扩充候选词形，提高命中率。
 *
 * 口径（诚实边界，写进注释供审）：
 *   · 这是**规则近似**，不是完整 NLP 词形还原器——不追求 100% 正确，
 *     只求把常见变形收进候选集合；查不到就返回未命中，绝不编造词条。
 *   · 候选集合含原词本身，顺序即查询优先级（原词优先）。
 *   · 短语（含空格）按空格切词，逐词做单词级还原再重组；为控制组合
 *     爆炸，仅剥最常见后缀（-ing/-ed/-s/-es），且总组合数有上限。
 *   · 还原规则不依赖任何外部词典，纯字符串操作，可单测、确定性。
 */

/** 单词级候选：原词优先，随后按规则剥后缀。 */
export function lemmaCandidatesOfWord(word: string): string[] {
  const raw = word.trim()
  if (raw === '') return []
  const lower = raw.toLowerCase()
  const out: string[] = [raw]
  const seen = new Set<string>([lower])

  const push = (candidate: string | null): void => {
    if (candidate === null || candidate === '') return
    if (seen.has(candidate)) return
    seen.add(candidate)
    out.push(candidate)
  }

  // -ies -> -y（carries -> carry）
  if (lower.endsWith('ies') && lower.length > 4) {
    push(`${lower.slice(0, -3)}y`)
  }
  // -es -> 去 es / 去 s（boxes -> box，watches -> watch）
  if (lower.endsWith('es') && lower.length > 3) {
    push(lower.slice(0, -2))
    push(lower.slice(0, -1))
  }
  // -s -> 去 s（cats -> cat）
  if (lower.endsWith('s') && !lower.endsWith('ss') && lower.length > 2) {
    push(lower.slice(0, -1))
  }
  // -ing -> 去 ing / 去 ing+e / 双写辅音还原（running -> run）
  if (lower.endsWith('ing') && lower.length > 4) {
    const stem = lower.slice(0, -3)
    push(stem)
    push(`${stem}e`)
    if (stem.length >= 2 && stem[stem.length - 1] === stem[stem.length - 2]) {
      push(stem.slice(0, -1))
    }
  }
  // -ed -> 去 ed / 去 d / 双写辅音还原（stopped -> stop，liked -> like）
  if (lower.endsWith('ed') && lower.length > 3) {
    const stem = lower.slice(0, -2)
    push(stem)
    push(`${stem}e`)
    if (stem.length >= 2 && stem[stem.length - 1] === stem[stem.length - 2]) {
      push(stem.slice(0, -1))
    }
  }
  // -er / -est / -ly（比较级 / 最高级 / 副词）
  if (lower.endsWith('er') && lower.length > 3) push(lower.slice(0, -2))
  if (lower.endsWith('est') && lower.length > 4) push(lower.slice(0, -3))
  if (lower.endsWith('ly') && lower.length > 3) push(lower.slice(0, -2))

  return out
}

/** 短语候选：原短语优先，逐词还原重组（组合上限 8，防爆炸）。 */
export function lemmaCandidates(phrase: string): string[] {
  const trimmed = phrase.trim()
  if (trimmed === '') return []
  if (!trimmed.includes(' ')) return lemmaCandidatesOfWord(trimmed)

  const words = trimmed.split(/\s+/)
  const perWord: string[][] = words.map((w) => {
    // 功能词（to / a / the / of …）不还原，避免无意义组合
    if (FUNCTION_WORDS.has(w.toLowerCase())) return [w]
    // 短语里每词只给：原形 + 去 ing/ed/s 三类最常见还原，控制组合数
    const candidates = [w]
    const lower = w.toLowerCase()
    if (lower.endsWith('ing') && lower.length > 4) {
      const stem = lower.slice(0, -3)
      candidates.push(stem, `${stem}e`)
      if (stem.length >= 2 && stem[stem.length - 1] === stem[stem.length - 2]) candidates.push(stem.slice(0, -1))
    } else if (lower.endsWith('ed') && lower.length > 3) {
      const stem = lower.slice(0, -2)
      candidates.push(stem, `${stem}e`)
      if (stem.length >= 2 && stem[stem.length - 1] === stem[stem.length - 2]) candidates.push(stem.slice(0, -1))
    } else if (lower.endsWith('s') && !lower.endsWith('ss') && lower.length > 2) {
      candidates.push(lower.slice(0, -1))
    }
    return candidates
  })

  const out: string[] = []
  const seen = new Set<string>()
  const walk = (index: number, acc: string): void => {
    if (out.length >= 8) return
    if (index === words.length) {
      if (!seen.has(acc)) {
        seen.add(acc)
        out.push(acc)
      }
      return
    }
    for (const candidate of perWord[index]) walk(index + 1, acc === '' ? candidate : `${acc} ${candidate}`)
  }
  walk(0, '')
  return out
}

/** 短语还原时跳过的功能词（还原它们只会产生噪声候选）。 */
const FUNCTION_WORDS = new Set([
  'a', 'an', 'the', 'to', 'of', 'for', 'in', 'on', 'at', 'with', 'and', 'or', 'but', 'by', 'from', 'up', 'down', 'out',
])
