/**
 * 语法分析（轻量、纯前端、离线）
 * ------------------------------------------------------------------
 * 基于 compromise（动态 import 分包，仅在阅读器点词时加载，不拖首屏）。
 * 目标：在点词弹层里给出「句型结构 / 时态 / 该词词性(POS) + 推测角色」，
 * 帮助零基础用户理解句子。全部为真实分析，不编造。
 *
 * 说明：compromise 的 three 精简构建暴露的是词性标签（tags），而非完整时态方法，
 * 故时态/句型由标签启发式推导；角色（主/谓/宾）同样为轻量启发式，
 * 界面会如实标注「推测」，非专业依存句法分析。
 */

export interface GrammarTerm {
  /** 原文词形（小写，去标点） */
  text: string
  /** 词性中文标签（名词/动词/形容词…） */
  posZh: string
  /** 原始 POS 标签（如 Noun/Verb），用于展示 */
  posRaw: string
  /** 推测的句子角色（主语/谓语/宾语/…），仅对命中词给出 */
  role?: string
}

export interface GrammarAnalysis {
  /** 句型：陈述句/疑问句/祈使句/感叹句/未知 */
  sentenceType: string
  /** 时态：现在时/过去时/将来时/进行时/完成时/未知 */
  tense: string
  /** 该句逐词分析 */
  terms: GrammarTerm[]
  /** 是否成功调用 compromise（false 时退化为启发式） */
  engine: 'compromise' | 'fallback'
}

// 动态加载 compromise（分包），避免首屏体积膨胀
let nlpPromise: Promise<any> | null = null
function getNlp(): Promise<any> {
  if (!nlpPromise) {
    nlpPromise = import('compromise').then((m: any) => {
      const nlp = m.default ?? m.nlp ?? m
      if (typeof nlp !== 'function') throw new Error('compromise entry invalid')
      return nlp
    })
  }
  return nlpPromise
}

const POS_ZH: Record<string, string> = {
  Noun: '名词',
  Verb: '动词',
  Auxiliary: '助动词',
  Modal: '情态动词',
  Copula: '系动词',
  Adjective: '形容词',
  Adverb: '副词',
  Pronoun: '代词',
  Determiner: '限定词',
  Article: '冠词',
  Preposition: '介词',
  Conjunction: '连词',
  Interjection: '感叹词',
  Cardinal: '数词',
  Ordinal: '序数词',
  Quantity: '量词',
  Date: '时间词',
  Time: '时间词',
  Money: '货币词',
  Percent: '百分比词',
  Value: '数值词',
  Place: '地名',
  Organization: '机构名',
  Person: '人名',
  Singular: '名词',
  Plural: '名词',
  ProperNoun: '专有名词',
  Text: '文本',
  Symbol: '符号',
  Gerund: '动名词',
  Infinitive: '不定式',
  Participle: '分词',
  Possessive: '所有格',
  Contraction: '缩略词',
  Unknown: '未知词',
}

function posToZh(raw: string): string {
  if (!raw) return '未知词'
  const base = raw.replace(/s$/, '')
  if (POS_ZH[base]) return POS_ZH[base]
  if (POS_ZH[raw]) return POS_ZH[raw]
  for (const k of Object.keys(POS_ZH)) {
    if (raw.startsWith(k)) return POS_ZH[k]
  }
  return raw
}

type Tagged = { word: string; tags: string[] }

/** 解析 compromise `out('tags')`：数组，每项为 { 词: [标签...] }（verbs 会将多个词合并进同一对象） */
function parseTags(out: any): Tagged[] {
  const res: Tagged[] = []
  if (!Array.isArray(out)) return res
  for (const item of out) {
    if (item && typeof item === 'object') {
      for (const k of Object.keys(item)) {
        const w = k.replace(/[^A-Za-z'’]/g, '').toLowerCase()
        if (!w) continue
        const tags = Array.isArray(item[k]) ? (item[k] as string[]) : []
        res.push({ word: w, tags: tags.map((t) => t) })
      }
    }
  }
  return res
}

/** 由动词标签推导时态（中文） */
function tenseFromVerbTags(verbs: Tagged[]): string {
  if (verbs.length === 0) return '未知'
  let hasHave = false
  let hasBe = false
  const flags = { future: false, past: false, present: false, participle: false, gerund: false }
  for (const v of verbs) {
    const t = v.tags.map((x) => x.toLowerCase())
    if (t.includes('futuretense')) flags.future = true
    if (t.includes('pasttense')) flags.past = true
    if (t.includes('presenttense')) flags.present = true
    if (t.includes('participle')) flags.participle = true
    if (t.includes('gerund')) flags.gerund = true
    if (t.includes('auxiliary')) {
      if (['am', 'is', 'are', 'was', 'were', 'be', 'been', 'being'].includes(v.word)) hasBe = true
      if (['has', 'have', 'had'].includes(v.word)) hasHave = true
    }
  }
  if (flags.future || verbs.some((v) => ['will', 'shall'].includes(v.word))) return '将来时'
  if (flags.participle && hasHave) return '完成时'
  if (flags.gerund && hasBe) return '进行时'
  if (flags.past) return '过去时'
  if (flags.present) return '现在时'
  return '未知'
}

/** 句型判定（compromise 方法 + 标点 + 动词标签兜底） */
function sentenceTypeOf(text: string, doc: any, verbs: Tagged[]): string {
  const t = text.trim()
  try {
    const s = doc.sentences()
    if (s.isQuestion && s.isQuestion().found) return '疑问句'
    if (s.isExclamation && s.isExclamation().found) return '感叹句'
  } catch {
    /* ignore */
  }
  if (t.endsWith('?')) return '疑问句'
  if (t.endsWith('!')) return '感叹句'
  if (verbs.some((v) => v.tags.map((x) => x.toLowerCase()).includes('imperative'))) return '祈使句'
  return '陈述句'
}

/** 轻量主谓宾推断：首个非助动词的动词前名词≈主语，其后名词≈宾语/表语 */
function inferRoles(termOut: Tagged[]): Map<string, string> {
  const role = new Map<string, string>()
  let mainVerbIdx = -1
  for (let i = 0; i < termOut.length; i++) {
    const tags = termOut[i].tags.map((x) => x.toLowerCase())
    if (tags.includes('verb') && !tags.includes('auxiliary')) {
      mainVerbIdx = i
      break
    }
  }
  if (mainVerbIdx === -1) {
    for (let i = 0; i < termOut.length; i++) {
      const tags = termOut[i].tags.map((x) => x.toLowerCase())
      if (tags.includes('noun') || tags.includes('pronoun')) {
        role.set(termOut[i].word, '主语(推测)')
        break
      }
    }
    return role
  }
  for (let i = mainVerbIdx - 1; i >= 0; i--) {
    const tags = termOut[i].tags.map((x) => x.toLowerCase())
    if (tags.includes('noun') || tags.includes('pronoun')) {
      role.set(termOut[i].word, '主语(推测)')
      break
    }
  }
  role.set(termOut[mainVerbIdx].word, '谓语(推测)')
  for (let i = mainVerbIdx + 1; i < termOut.length; i++) {
    const tags = termOut[i].tags.map((x) => x.toLowerCase())
    if (tags.includes('noun') || tags.includes('pronoun')) {
      role.set(termOut[i].word, '宾语/表语(推测)')
      break
    }
  }
  return role
}

/**
 * 分析一句话，返回句型 / 时态 / 逐词词性与推测角色。
 * 失败时退化为标点 + 正则启发式，保证不崩溃。
 */
export async function analyzeSentence(text: string): Promise<GrammarAnalysis> {
  const clean = (text || '').trim()
  if (!clean) {
    return { sentenceType: '未知', tense: '未知', terms: [], engine: 'fallback' }
  }
  try {
    const nlp = await getNlp()
    const doc = nlp(clean)

    const termOut = parseTags(doc.terms().out('tags'))
    const verbOut = parseTags(doc.verbs().out('tags'))

    const tense = tenseFromVerbTags(verbOut)
    const sentenceType = sentenceTypeOf(clean, doc, verbOut)
    const roleByText = inferRoles(termOut)

    const terms: GrammarTerm[] = termOut.map((t) => {
      const raw = (t.tags[0] || 'Unknown').replace(/s$/, '')
      return {
        text: t.word,
        posRaw: t.tags[0] || 'Unknown',
        posZh: posToZh(raw),
        role: roleByText.get(t.word),
      }
    })

    return { sentenceType, tense, terms, engine: 'compromise' }
  } catch (e) {
    console.warn('[grammar] compromise 分析失败，退化为启发式', e)
    return fallbackAnalysis(clean)
  }
}

/** 无 compromise 时的兜底分析（仅标点/简单正则） */
function fallbackAnalysis(text: string): GrammarAnalysis {
  const t = text.trim()
  let sentenceType = '陈述句'
  if (t.endsWith('?')) sentenceType = '疑问句'
  else if (t.endsWith('!')) sentenceType = '感叹句'
  const words = (t.match(/[A-Za-z]+(?:['’\-][A-Za-z]+)*/g) || []).map((w) => w.toLowerCase())
  const terms: GrammarTerm[] = words.map((w) => ({ text: w, posRaw: 'Unknown', posZh: '未知词' }))
  let tense = '未知'
  if (/\b(will|shall|going to)\b/i.test(t)) tense = '将来时'
  else if (/\b(has|have|had)\b\s+\w+/i.test(t)) tense = '完成时'
  else if (/\b(is|are|was|were)\b\s+\w*ing\b/i.test(t)) tense = '进行时'
  else if (/\b\w+ed\b/i.test(t)) tense = '过去时'
  else if (/\b\w+s\b/i.test(t)) tense = '现在时'
  return { sentenceType, tense, terms, engine: 'fallback' }
}
