/**
 * 单词释义解析（纯逻辑，可在 Node 下单测）
 * ------------------------------------------------------------------
 * 真实数据里 `definition_zh` 是**一整串带词性前缀的中文释义**，例如：
 *   by      → "prep. 在...旁边；通过（某种方式）；由（某人完成）；到（某时）之前；adv. 经过；附近；搁置"
 *   aboard  → "adv. /prep. 在（船、飞机、火车等）上；登（交通工具）"
 *   absorb  → "vt. 吸收（液体、热量、知识等）；vt. 使全神贯注"
 * 所以要展示成「词性斜体灰 + 该词性下逐条释义」，必须先把它切成结构化分组。
 *
 * ⚠️ 关于「每条释义配一条专属例句」（需求 5）：
 *   实测 22,791 条真实词条 —— 例句**固定 3 条**（97.8%），释义平均 3.14 条，
 *   「释义数 == 例句数」只占 22.2%，且 `senses` 字段 100% 缺失。
 *   也就是说**数据里不存在「例句属于哪个释义」的标注**。
 *   因此这里只在「释义数恰好等于例句数」时才按数据顺序一一绑定（此时可证），
 *   否则一律 pooled（集中展示），**绝不硬配**，避免给用户错误示范。
 */

export interface WordExample {
  en: string
  zh: string
}

/** 一个词性组：pos 形如 "prep." / "adv. / prep." / ""（无标注） */
export interface PosGroup {
  pos: string
  senses: string[]
}

/** 渲染用：一条释义 + 它绑定的例句（null = 未绑定） */
export interface SenseView {
  sense: string
  example: WordExample | null
}

/** 渲染用：一个词性组 */
export interface PosGroupView {
  pos: string
  senses: SenseView[]
}

export interface ExampleBinding {
  /**
   * paired —— 释义数与例句数相等，按数据顺序一一绑定（可证，非推测）
   * pooled —— 数据不足以判定归属，例句集中展示
   */
  mode: 'paired' | 'pooled'
  groups: PosGroupView[]
  /** pooled 模式下展示的例句；paired 模式为空数组 */
  pooled: WordExample[]
}

/** 真实数据里出现过的词性标记（只认这些，避免把 "Mr." 之类误吃成词性） */
const POS_WORDS = new Set([
  'n', 'v', 'vt', 'vi', 'adj', 'adv', 'prep', 'pron',
  'conj', 'int', 'interj', 'aux', 'art', 'num', 'phr', 'pl', 'abbr',
])

/** 段首的词性前缀，兼容 "adv." 与 "adv. /prep." 两种写法 */
const POS_PREFIX_RE = /^([A-Za-z]{1,6}\.(?:\s*[/、,]\s*[A-Za-z]{1,6}\.)*)\s*/

/** 释义分隔符：中英文分号都算（真实数据两种都有） */
const SPLIT_RE = /[;；]/

/**
 * 取段首词性前缀。返回 null 表示这一段没有词性标记（归属于上一组）。
 * 前缀里的每个标记都必须在 POS_WORDS 内，否则整段视为普通释义。
 */
function takePosPrefix(seg: string): { pos: string; rest: string } | null {
  const m = POS_PREFIX_RE.exec(seg)
  if (!m) return null
  const parts = m[1]
    .split(/[/、,]/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (parts.length === 0) return null
  const known = parts.every((p) => POS_WORDS.has(p.slice(0, -1).toLowerCase()))
  if (!known) return null
  return { pos: parts.join(' / '), rest: seg.slice(m[0].length).trim() }
}

/**
 * 把 `definition_zh` 切成词性分组。
 * 相邻的同词性段会合并（真实数据里 "vt. …；vt. …" 很常见）。
 * 无任何词性标记时返回单组 pos=''（调用方可用 word.pos 兜底）。
 */
export function parseDefinitionZh(definition?: string | null): PosGroup[] {
  if (!definition) return []
  const groups: PosGroup[] = []
  for (const raw of definition.split(SPLIT_RE)) {
    const seg = raw.trim()
    if (!seg) continue
    const head = takePosPrefix(seg)
    if (head) {
      const last = groups[groups.length - 1]
      if (last && last.pos === head.pos) {
        if (head.rest) last.senses.push(head.rest)
        continue
      }
      groups.push({ pos: head.pos, senses: head.rest ? [head.rest] : [] })
      continue
    }
    const last = groups[groups.length - 1]
    if (last) last.senses.push(seg)
    else groups.push({ pos: '', senses: [seg] })
  }
  return groups.filter((g) => g.senses.length > 0)
}

/** 释义总条数（跨所有词性） */
export function totalSenses(groups: readonly PosGroup[]): number {
  let n = 0
  for (const g of groups) n += g.senses.length
  return n
}

/**
 * 例句绑定。规则见文件头说明：只在数量相等时一一绑定，否则 pooled。
 */
export function bindExamples(
  groups: readonly PosGroup[],
  examples: readonly WordExample[],
): ExampleBinding {
  const ex = examples.filter((e) => e && typeof e.en === 'string' && e.en.trim() !== '')
  const total = totalSenses(groups)
  if (total > 0 && ex.length === total) {
    let k = 0
    return {
      mode: 'paired',
      pooled: [],
      groups: groups.map((g) => ({
        pos: g.pos,
        senses: g.senses.map((sense) => ({ sense, example: ex[k++] ?? null })),
      })),
    }
  }
  return {
    mode: 'pooled',
    pooled: ex,
    groups: groups.map((g) => ({
      pos: g.pos,
      senses: g.senses.map((sense) => ({ sense, example: null })),
    })),
  }
}

/**
 * 取例句：`examples` 有就用它，否则用单条 `example_en/zh` 兜底。
 * 保留原数组的对象引用 —— 调用方靠引用反查例句下标（评分存档要用稳定下标）。
 */
export function collectExamples(word: {
  examples?: { en: string; zh: string }[] | null
  example_en?: string | null
  example_zh?: string | null
}): WordExample[] {
  if (word.examples && word.examples.length > 0) {
    return word.examples.filter((e): e is WordExample => Boolean(e && e.en))
  }
  if (word.example_en) {
    return [{ en: word.example_en, zh: word.example_zh ?? '' }]
  }
  return []
}

/* ------------------------------------------------------------------
 * 例句里的「可点击单词」
 * ------------------------------------------------------------------ */

/** 去掉单词首尾的标点，只留可被词库收录的形式 */
export function stripWordPunct(token: string): string {
  return token.replace(/^[^A-Za-z'-]+/, '').replace(/[^A-Za-z'-]+$/, '')
}

/**
 * 查词候选（例句中出现的多是屈折形式，如 books / went / bigger）。
 * 只是**查询策略**（依次试原形），不是编造释义：查不到就如实显示「未收录」。
 */
export function lemmaCandidates(token: string): string[] {
  const raw = stripWordPunct(token).toLowerCase()
  if (!raw) return []
  const out = [raw]
  const push = (s: string) => {
    if (s.length > 1 && !out.includes(s)) out.push(s)
  }
  /** 双写辅音结尾（running → runn → run、bigger → bigg → big）再砍一个字母 */
  const dedouble = (s: string): string => {
    const n = s.length
    if (n >= 2 && s[n - 1] === s[n - 2] && !'aeiou'.includes(s[n - 1])) return s.slice(0, -1)
    return s
  }

  if (raw.endsWith('ies') && raw.length > 4) push(`${raw.slice(0, -3)}y`)
  if (raw.endsWith('ves') && raw.length > 4) push(`${raw.slice(0, -3)}f`)
  if (raw.endsWith('es') && raw.length > 3) push(raw.slice(0, -2))
  if (raw.endsWith('s') && !raw.endsWith('ss')) push(raw.slice(0, -1))
  if (raw.endsWith('ing')) {
    push(raw.slice(0, -3))
    push(`${raw.slice(0, -3)}e`)
    push(dedouble(raw.slice(0, -3))) // running → run
  }
  if (raw.endsWith('ied') && raw.length > 4) push(`${raw.slice(0, -3)}y`) // carried → carry
  if (raw.endsWith('ed')) {
    push(raw.slice(0, -2))
    push(raw.slice(0, -1))
    push(dedouble(raw.slice(0, -2))) // stopped → stop
  }
  if (raw.endsWith('er')) push(dedouble(raw.slice(0, -2))) // bigger → big
  if (raw.endsWith('est')) push(dedouble(raw.slice(0, -3))) // biggest → big
  if (raw.endsWith('ly')) push(raw.slice(0, -2))
  return out
}

/** 例句评分的持久化 key（切词再回来要还原成绩） */
export function exampleKey(word: string, index: number): string {
  return `${word.toLowerCase()}#${index}`
}
