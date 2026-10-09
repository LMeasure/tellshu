// =============================================================================
// 词条正文页解析器
//
// 输入：OCR 归一化后的页（OcrPage[]）+ 该书的使用说明规则（ParserRules）
// 输出：EntryDraft[]
//
// 【修复 1】切分策略重写（2026-10-06 真实样本驱动）
//   旧实现按「词头行」切：判定某行是否以单词开头，行之间即为一个词条。
//   本机实测（server/data/dump/01-entry.markdown.txt）暴露三个失败：
//     · 词头被音节间隔号截断：aba·cus / aban·don -> word 变成 aba / aban，
//       且 abandon 与 abandonment 的 word_key 撞成同一个 "aban"；
//     · 一行里挤了多个词条（第 42 行同时含 election policy / abate / abbey /
//       abbreviate），按行切分只能取到第一个；
//     · 跨行错拼：abandonment 的例句尾巴与下一词条 abate 拼在一起，
//       被当成新词条，产出 "election policy" 这种假词。
//   新实现改为：在整页文本上用「词条起始模式」正则扫描，命中即开新词条，
//   命中不到就把内容并入上一条的释义/例句。
//
// 起始模式：边界 + 词头(+音节点) + 可选空白 + 可选音标 + 可选符号 + 词性缩写
//   a /,er/★★art. / aba·cus/'aebkas/n.[c] / aban·don·ment/'baendanmant/n.[U]
//   abate /ə'bert/ v. / ABC/ier bi: si:/abbr.
//
// 原则：只抽取页面上真实出现的文本。抽不到就留空，绝不生成示例内容。
// =============================================================================

import type { EntryDraft, EntryExample, EntryPhrase, EntrySense, OcrPage, ParserRules } from '../types';
import {
  clamp,
  dedupeKeepOrder,
  maxRunLength,
  normalizeKey,
  normalizeSpace,
  splitByScript,
  splitList,
  stripMarkdown,
} from './normalize';

/** 默认词性缩写 -> 规范词性（书籍使用说明里若给出同名映射则优先用书籍的） */
export const DEFAULT_POS_ABBREVIATIONS: Readonly<Record<string, string>> = {
  'n.': 'noun',
  'n': 'noun',
  'noun': 'noun',
  'pron.': 'pronoun',
  'pron': 'pronoun',
  'v.': 'verb',
  'v': 'verb',
  'verb': 'verb',
  'vt.': 'verb.transitive',
  'vt': 'verb.transitive',
  'vi.': 'verb.intransitive',
  'vi': 'verb.intransitive',
  'adj.': 'adjective',
  'adj': 'adjective',
  'a.': 'adjective',
  'adv.': 'adverb',
  'adv': 'adverb',
  // 真实样本里「ad.」是副词缩写（aback /ə'bæek/ ad. backwards）
  'ad.': 'adverb',
  'ad': 'adverb',
  'prep.': 'preposition',
  'prep': 'preposition',
  'conj.': 'conjunction',
  'conj': 'conjunction',
  'num.': 'numeral',
  'num': 'numeral',
  'art.': 'article',
  'art': 'article',
  'int.': 'interjection',
  'int': 'interjection',
  'interj.': 'interjection',
  'aux.': 'auxiliary',
  'aux': 'auxiliary',
  'modal.': 'modal',
  'modal': 'modal',
  'phr.': 'phrase',
  'abbr.': 'abbreviation',
  'pl.': 'plural',
};

// -----------------------------------------------------------------------------
// 词条起始模式
// -----------------------------------------------------------------------------

/**
 * 词性缩写备选（长串在前，避免 adj. 被 a. 抢先匹配后卡在点上）。
 */
const POS_ALTERNATION =
  'abbr|adj|adv|aux|modal|pron|prep|conj|interj|int|num|art|vi|vt|pl|ad|n|v|a';

/**
 * 起始边界：词条要么出现在行首，要么紧跟空白 / 汉字 / 假名 / 日汉句号类标点 /
 * 右括号。刻意不包含半角与全角冒号——发音规则表里大量出现「读作/ei/：gate/gert/n.」
 * 这类「中文 + 冒号 + 微型词条」，它们不是正文词条。
 */
const BOUNDARY_SRC =
  '(?:^|[\\u3002-\\u300f\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\s]|[\\)\\]\\uff09\\uff3d\\uff5d])';

/**
 * 词头：拉丁开头，允许内部出现音节间隔号（·・•）——OCR 把 aba·cus 的间隔号
 * 当成普通字符输出，必须整体吃掉再还原成 abacus。
 */
const HEADWORD_SRC = "([A-Za-z][A-Za-z'’\\-]*(?:[·・•][A-Za-z'’\\-]+)*)";
const PHONETIC_SRC = '(\\/[^\\/\\n]{1,64}\\/|\\[[^\\]\\n]{1,64}\\])?';
/** 标记符号 + 空格（刻意不含换行，避免跨行把两行拼成一个假词条） */
const MARKS_SRC = '([★☆＊*· \\t]*)';

const ENTRY_START_RE = new RegExp(
  `${BOUNDARY_SRC}${HEADWORD_SRC}${MARKS_SRC}${PHONETIC_SRC}${MARKS_SRC}((?:${POS_ALTERNATION})\\.)`,
  'g',
);

/** 音标提取（方括号或斜杠包裹），用于词头已给出但要在正文里二次确认的场景 */
const PHONETIC_RE = /(\[[^\]\n]{1,64}\]|\/[^/\n]{1,64}\/)/;

/** OCR 插图占位（<div …><img …></div>），不属于词条正文 */
const HTML_BLOCK_RE = /<[^>]+>/g;
const HTML_IMG_DIV_RE = /<div[^>]*>\s*<img[^>]*\/?>\s*<\/div>/gi;

interface EntryStart {
  /** 词头在页面文本中的起始下标 */
  index: number;
  word: string;
  phonetic: string | null;
  posToken: string;
  /** 词性缩写结束的下标，正文从此处开始 */
  bodyStart: number;
}

function countWords(text: string): number {
  return text.split(/\s+/).filter((item) => item !== '').length;
}

/** index 是否位于某一行的开头（前面只有空白） */
function isLineStart(text: string, index: number): boolean {
  const before = text.slice(0, index);
  const lastBreak = before.lastIndexOf('\n');
  const head = lastBreak < 0 ? before : before.slice(lastBreak + 1);
  return head.replace(/[ \t]/g, '') === '';
}

/** markdown 标题行（## 用法用a或an的情况）永远另起一段，不能并进上一条词条 */
const HEADING_LINE_RE = /^[ \t]{0,3}#{1,6}\s.*$/gm;

function headingPositions(text: string): number[] {
  const out: number[] = [];
  const regex = new RegExp(HEADING_LINE_RE.source, HEADING_LINE_RE.flags);
  let match: RegExpExecArray | null = regex.exec(text);
  while (match !== null) {
    const index = match.index ?? 0;
    out.push(index);
    regex.lastIndex = index + Math.max((match[0] ?? '').length, 1);
    match = regex.exec(text);
  }
  return out;
}

/** 把带音节间隔号的词头还原成正常单词：aba·cus -> abacus */
export function normalizeHeadword(raw: string): string {
  return normalizeSpace(raw.replace(/[·・•]/g, ''));
}

/**
 * 【修复 1】去掉 HTML 标签块与 markdown 标题符，得到用于扫描的纯文本。
 * 保留行结构，词条起始模式依赖 \n 作为最常见的边界。
 */
function toScanText(input: string): string {
  return input
    .replace(HTML_IMG_DIV_RE, (div) => (/<img/i.test(div) ? '\n' : ''))
    .replace(HTML_BLOCK_RE, '')
    .replace(/[ \t]+$/gm, '');
}

/** 构造一枚「页面级的纯文本」，优先 markdown（最完整），退化时用文本块拼接。 */
function pageText(page: OcrPage): string {
  const markdown =
    page.markdown.trim() !== '' ? page.markdown : page.blocks.map((block) => block.text).join('\n');
  // 注意：这里刻意保留 markdown 标题符 —— headingPositions() 要靠它找硬性分段边界。
  return toScanText(markdown);
}

/**
 * 在整页文本里扫描所有词条起点。
 * 校验规则：没有音标时，词头与词性之间只允许极短的空白/符号间隔，
 * 否则「…teacher. He is a teacher…」这类正文会被误判成新词条。
 */
export function findEntryStarts(text: string): EntryStart[] {
  const starts: EntryStart[] = [];
  const regex = new RegExp(ENTRY_START_RE.source, ENTRY_START_RE.flags);
  let match: RegExpExecArray | null = regex.exec(text);

  while (match !== null) {
    const full = match[0] ?? '';
    const captured = match.slice(1).join('');
    const boundary = Math.max(full.length - captured.length, 0);
    const wordRaw = match[1] ?? '';
    const marksBefore = match[2] ?? '';
    const phoneticRaw = match[3] ?? '';
    const marksAfter = match[4] ?? '';
    const posToken = match[5] ?? '';

    const index = (match.index ?? 0) + boundary;
    const bodyStart = (match.index ?? 0) + full.length;

    const hasPhonetic = phoneticRaw !== '';
    const separator = `${marksBefore}${marksAfter}`;
    const word = normalizeHeadword(wordRaw);
    // 没有音标时收紧条件：必须至少有一个分隔符（避免 "rebellio|n." 这种回退式
    // 误伤，词尾字母被当成词性 n.），且必须出现在行首 —— 正文里的
    // 「He is a teacher.」绝不能被判成新词条。
    const tightOk =
      separator !== '' &&
      separator.length <= 4 &&
      /^[★☆＊*· \t]+$/.test(separator) &&
      isLineStart(text, index);
    const gapAcceptable = hasPhonetic || tightOk;

    if (word !== '' && gapAcceptable) {
      const phonetic = hasPhonetic
        ? normalizeSpace(phoneticRaw.replace(/^\[|\]$|^\/|\/$/g, ''))
        : null;
      starts.push({ index, word, phonetic, posToken, bodyStart });
      regex.lastIndex = bodyStart;
    } else {
      regex.lastIndex = (match.index ?? 0) + Math.max(full.length, 1);
    }
    match = regex.exec(text);
  }

  // 起始位置去重并保持顺序（同一位置可能由不同替代分支命中）
  const seen = new Set<number>();
  return starts.filter((item) => {
    if (seen.has(item.index)) return false;
    seen.add(item.index);
    return true;
  });
}

// -----------------------------------------------------------------------------
// 段落切分与字段抽取
// -----------------------------------------------------------------------------

function stripGrammarTags(text: string): string {
  // [c] / [U] / [sing.单] / 前导义项序号 —— 都不是释义本体
  return normalizeSpace(
    text
      .replace(/^\s*\[[^\]\n]{0,16}\]\s*/g, '')
      .replace(/^\s*\d+/, ''),
  ).replace(/^[\s.:：;；,，、]+/, '');
}

/** 例句的英文部分可能带前导冒号/斜杠/引号（"…译。:The storm abated at last."） */
const EXAMPLE_LEADING_RE = /^[\s:：;；,，、.。/*"'’“”()（）]+/;

/** 例句（英文句子 + 紧随其后的中文译文）判定：首字母大写 + 至少 3 个词 + 句末标点 */
function looksLikeExample(en: string): boolean {
  if (en.length < 8 || countWords(en) < 3) return false;
  if (!/[.!?]["'’]?$/.test(en)) return false;
  return /^[A-Z]/.test(en.replace(EXAMPLE_LEADING_RE, ''));
}

/** 按文字系统切分成连续片段：{ script, text }（保留空格，例句要靠它断句） */
type ScriptRun = { script: 'latin' | 'cjk'; text: string };

const CJK_CHAR_RE = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;

function toScriptRuns(text: string): ScriptRun[] {
  const runs: ScriptRun[] = [];
  let buffer = '';
  let script: 'latin' | 'cjk' | null = null;

  for (const ch of text) {
    const kind: 'latin' | 'cjk' = CJK_CHAR_RE.test(ch) ? 'cjk' : 'latin';
    if (kind !== script) {
      if (buffer !== '' && script !== null) runs.push({ script, text: buffer });
      script = kind;
      buffer = '';
    }
    buffer += ch;
  }
  if (buffer !== '' && script !== null) runs.push({ script, text: buffer });
  return runs.filter((run) => normalizeSpace(run.text) !== '');
}

/** 从「英文段 + 中文段」的交替序列里挑出例句，其余归于释义。 */
function extractExamplesAndDefinitions(body: string): {
  examples: EntryExample[];
  latinParts: string[];
  cjkParts: string[];
} {
  const runs = toScriptRuns(body);
  const examples: EntryExample[] = [];
  const latinParts: string[] = [];
  const cjkParts: string[] = [];

  let i = 0;
  while (i < runs.length) {
    const current = runs[i] ?? { script: 'latin' as const, text: '' };
    const next = runs[i + 1];
    if (current.script === 'latin' && next !== undefined && next.script === 'cjk') {
      const rawEn = normalizeSpace(current.text);
      const zh = normalizeSpace(next.text);
      if (zh !== '' && looksLikeExample(rawEn)) {
        examples.push({ en: rawEn.replace(EXAMPLE_LEADING_RE, ''), zh });
        i += 2;
        continue;
      }
    }
    if (current.script === 'latin') latinParts.push(normalizeSpace(current.text));
    else cjkParts.push(normalizeSpace(current.text));
    i += 1;
  }

  return { examples, latinParts, cjkParts };
}

// -----------------------------------------------------------------------------
// 义项切分（2026-10-06：例句要挂到所属释义下）
// -----------------------------------------------------------------------------
// 真实样本（server/_entry_1f2915ee.txt 导出自 scan_records.result_text）：
//   a /,er/★★art.1 one(不定冠词…)一(…)：She has an apple…。2a member of a group(…)：He is a teacher.…
//   aban·don·ment …n.[U]1the act of leaving sb./sth.completely抛弃2 the act of giving sth.up放弃;中止：…
//   abate …v.1(of floods, storms,…)(洪水…)减少…:The storm abated at last.暴风雨终于减弱了。2 to do away with 废除…
// 义项标记 = 数字 1–9，前面是「明显非英文单词内部」的字符（汉字 / 中式标点 /
// 词性标签的句点 / [U] 的右括号），后面紧贴拉丁字母或 '('，或「空格 + 拉丁字母」。

/** 紧贴写法（"2a member"、"1(of floods"、"abbr.1 American"）允许的前置字符 */
const SENSE_PREV_DIRECT =
  /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef.。;；:：,，)）\]】」』"”’]/;
/** 空格写法（"。2 to do"、"）2 the basic"）允许的前置字符：只认中文语境（不含 ASCII 标点，
 *  避免 "etc. 2 things happened." 这类英文句子里的数字被误切） */
const SENSE_PREV_SPACED =
  /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;

/** body[i] 处的数字 1–9 是否是一个 义项起始标记 */
function senseMarkAt(text: string, index: number): boolean {
  const digit = text[index];
  if (digit === undefined || !/[1-9]/.test(digit)) return false;
  const prev = index > 0 ? (text[index - 1] ?? '') : '';
  if (/[0-9A-Za-z]/.test(prev)) return false; // 多位数 / 单词内部
  const after = text.slice(index + 1, index + 3);
  if (/^[A-Za-z(]/.test(after)) return SENSE_PREV_DIRECT.test(prev);
  if (/^ [A-Za-z]/.test(after)) return SENSE_PREV_SPACED.test(prev);
  return false;
}

/**
 * 把词条正文切成义项段。
 * 返回至少一段：没有义项标记时整段正文就是唯一义项。
 * 段首可能带「[c] / [U] 语法标签 + 义项数字」，由 stripGrammarTags 统一清掉。
 */
export function splitSenseSegments(body: string): string[] {
  // 哨兵句号：让「正文一开头就是义项 1」（art.1 one…）也满足「前置字符」检查
  const guarded = `。${body}`;
  const marks: number[] = [];
  for (let i = 1; i < guarded.length; i += 1) {
    if (senseMarkAt(guarded, i)) marks.push(i);
  }
  if (marks.length === 0) return [body];

  const segments: string[] = [];
  for (let i = 0; i < marks.length; i += 1) {
    const start = i === 0 ? 1 : (marks[i - 1] ?? 1); // 后续段从上一个标记数字开始（数字稍后清掉）
    const end = marks[i] ?? guarded.length;
    segments.push(guarded.slice(start, end));
  }
  segments.push(guarded.slice(marks[marks.length - 1] ?? 1));
  return segments;
}

/** 把一段正文解析成一个义项；释义抽不出来时返回 null（例句由调用方处理）。 */
function toSense(segment: string): {
  sense: EntrySense | null;
  examples: EntryExample[];
} {
  const cleaned = stripGrammarTags(normalizeSpace(segment));
  if (cleaned === '') return { sense: null, examples: [] };
  const { examples, latinParts, cjkParts } = extractExamplesAndDefinitions(cleaned);
  const definitionEn = joinParts(latinParts);
  const definitionZh = joinParts(cjkParts);
  if (definitionEn === '' && definitionZh === '') {
    // 只有例句没有释义：排版上它挂在前一个义项末尾，由调用方并入上一义项
    return { sense: null, examples };
  }
  return {
    sense: {
      definitionEn: definitionEn === '' ? null : definitionEn,
      definitionZh,
      examples,
    },
    examples,
  };
}

/**
 * 解析一批词条页。
 * @param sourcePageOf 页码提供者；无页码信息时返回 null，字段留空而不是猜。
 */
export function parseEntryPages(
  pages: readonly OcrPage[],
  rules: ParserRules,
  sourcePageOf: (pageIndex: number) => number | null = () => null,
): EntryDraft[] {
  const out: EntryDraft[] = [];
  pages.forEach((page, index) => {
    out.push(...parseEntryPage(page, rules, sourcePageOf(index)));
  });
  return out;
}

/** 解析单页 */
export function parseEntryPage(
  page: OcrPage,
  rules: ParserRules,
  sourcePage: number | null,
): EntryDraft[] {
  const text = pageText(page);
  if (text.trim() === '') return [];

  const posTokens = new Set<string>([
    ...Object.keys(DEFAULT_POS_ABBREVIATIONS),
    ...Object.keys(rules.posAbbreviations),
  ]);

  const starts = findEntryStarts(text);
  if (starts.length === 0) return [];

  // 标题行（## 用法用a或an的情况）是硬性分段边界：即使它后面没有新词条，
  // 也不能把它前面的正文并进上一条词条的释义里。
  const boundaries = [...headingPositions(text), text.length].sort((a, b) => a - b);
  const nextBoundary = (from: number): number => {
    for (const point of boundaries) {
      if (point > from) return point;
    }
    return text.length;
  };

  const drafts: EntryDraft[] = [];
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i];
    if (!start) continue;
    const nextStart = i + 1 < starts.length ? starts[i + 1]?.index ?? text.length : text.length;
    const end = Math.min(nextStart, nextBoundary(start.index));
    const posToken = posTokens.has(start.posToken) ? start.posToken : `${start.posToken}`;
    const draft = parseEntryChunk(
      {
        word: start.word,
        phonetic: start.phonetic,
        posToken,
        // head 保留「词头 + 音标 + 符号 + 词性」原文，★ 星级等标签统计要基于它
        head: text.slice(start.index, start.bodyStart),
        body: text.slice(start.bodyStart, end),
      },
      rules,
      sourcePage,
    );
    if (draft !== null) drafts.push(draft);
  }
  return drafts;
}

interface Chunk {
  word: string;
  phonetic: string | null;
  posToken: string;
  /** 「词头 + 音标 + 符号 + 词性」原文 */
  head: string;
  body: string;
}

function parseEntryChunk(chunk: Chunk, rules: ParserRules, sourcePage: number | null): EntryDraft | null {
  const word = normalizeSpace(chunk.word);
  if (word === '') return null;

  const pos = canonicalPos(chunk.posToken, rules);

  // ── 音标：起始模式没抓到时，退到正文前 60 字符再找一次 ──────────────
  let phonetic = chunk.phonetic;
  if (phonetic === null) {
    const headSlice = chunk.body.slice(0, 60);
    const found = PHONETIC_RE.exec(headSlice);
    if (found !== null) {
      phonetic = normalizeSpace((found[1] ?? '').replace(/^\[|\]$|^\/|\/$/g, ''));
    }
  }
  const phoneticValue = phonetic === null || phonetic === '' ? null : normalizeSpace(phonetic);

  // ── 标记符号（★ / ☆ / 使用说明自定义符号）不属于释义 ─────────────────
  const symbols = symbolListOf(rules);

  // ── 正文：按行处理标记条目，其余归入释义 ────────────────────────────
  const markerExamples: EntryExample[] = [];
  const synonyms: string[] = [];
  const antonyms: string[] = [];
  const phrases: EntryPhrase[] = [];
  let rootAffix: string | null = null;
  const plainLines: string[] = [];

  const lines = chunk.body.split(/\r?\n|\/\//);
  for (const rawLine of lines) {
    const line = stripSymbols(stripMarkdown(rawLine), symbols);
    if (normalizeSpace(line) === '') continue;

    // 例句标记
    const ex = stripMarker(line, rules.exampleMarkers);
    if (ex.hit) {
      const parts = splitByScript(ex.rest);
      if (parts.latin !== '') {
        markerExamples.push({ en: parts.latin, zh: parts.cjk === '' ? null : parts.cjk });
      }
      continue;
    }
    // 同义词
    const syn = stripMarker(line, rules.synonymMarkers);
    if (syn.hit) {
      synonyms.push(...splitList(syn.rest));
      continue;
    }
    // 反义词
    const ant = stripMarker(line, rules.antonymMarkers);
    if (ant.hit) {
      antonyms.push(...splitList(ant.rest));
      continue;
    }
    // 短语
    const phr = stripMarker(line, rules.phraseMarkers);
    if (phr.hit) {
      const parts = splitByScript(phr.rest);
      for (const item of splitList(parts.latin === '' ? phr.rest : parts.latin)) {
        phrases.push({ text: item, meaning: parts.cjk === '' ? null : parts.cjk });
      }
      continue;
    }
    // 词根词缀
    const root = stripMarker(line, rules.rootAffixMarkers);
    if (root.hit) {
      rootAffix = rootAffix === null ? root.rest : `${rootAffix} ${root.rest}`.trim();
      continue;
    }
    plainLines.push(normalizeSpace(line));
  }

  // ── 义项分组：例句挂到它前面紧挨的那条释义下（不猜、不编） ────────────
  const bodyRaw = plainLines.join(' ');
  const senses: EntrySense[] = [];
  const orphanExamples: EntryExample[] = []; // 有例句但前面没有任何释义可挂（极少见）

  for (const segment of splitSenseSegments(bodyRaw)) {
    const { sense, examples } = toSense(segment);
    if (sense !== null) {
      senses.push(sense);
      continue;
    }
    if (examples.length > 0) {
      const last = senses[senses.length - 1];
      if (last) last.examples.push(...examples);
      else orphanExamples.push(...examples);
    }
  }

  // 兜底：一个义项都没拼出来（极端 OCR 噪声 / 空正文），退回整段抽取，绝不丢内容；
  // 与 orphanExamples 可能重复，由 dedupeExamples 按英文句去重。
  let definitionEn: string | null = null;
  let definitionZh: string | null = null;
  const flatExamples: EntryExample[] = [...markerExamples];
  if (senses.length > 0) {
    definitionEn = joinParts(senses.map((s) => s.definitionEn ?? '').filter((t) => t !== ''));
    definitionZh = joinParts(senses.map((s) => s.definitionZh));
    for (const sense of senses) flatExamples.push(...sense.examples);
  } else {
    const body = stripGrammarTags(bodyRaw);
    const extracted = extractExamplesAndDefinitions(body);
    definitionEn = joinParts(extracted.latinParts);
    definitionZh = joinParts(extracted.cjkParts);
    flatExamples.push(...extracted.examples);
  }
  flatExamples.push(...orphanExamples);

  // ── 自动打标签（符号统计基于词头行 + 正文原文） ─────────────────────
  const fullText = `${chunk.head} ${pos} ${chunk.body}`;
  const tags: string[] = [];
  if (pos !== '') tags.push(`pos:${pos}`);
  const starCount = maxRunLength(fullText, '★');
  if (starCount > 0) tags.push(`syllabus:${clamp(starCount, 1, 5)}`);
  for (const [symbol, label] of Object.entries(rules.symbols)) {
    if (symbol !== '' && fullText.includes(symbol)) tags.push(label);
  }
  if (rootAffix !== null && rootAffix !== '') tags.push('has-root');
  if (flatExamples.length > 0) tags.push('has-example');
  tags.push(...rules.globalTags);

  return {
    word,
    wordKey: normalizeKey(word),
    phonetic: phoneticValue,
    pos,
    posKey: normalizeKey(pos),
    definitionEn: definitionEn === '' ? null : definitionEn,
    definitionZh: definitionZh === '' ? null : definitionZh,
    senses,
    examples: dedupeExamples(flatExamples),
    synonyms: dedupeKeepOrder(synonyms),
    antonyms: dedupeKeepOrder(antonyms),
    phrases: dedupePhrases(phrases),
    tags: dedupeKeepOrder(tags),
    rootAffix: rootAffix === null || rootAffix === '' ? null : normalizeSpace(rootAffix),
    sourcePage,
  };
}

function joinParts(parts: readonly string[]): string {
  return normalizeSpace(parts.filter((part) => part !== '').join(' '));
}

const SYMBOL_FALLBACKS = ['★', '☆'];

function symbolListOf(rules: ParserRules): string[] {
  const list = Object.keys(rules.symbols).filter((symbol) => symbol !== '');
  for (const fallback of SYMBOL_FALLBACKS) {
    if (!list.includes(fallback)) list.push(fallback);
  }
  return list;
}

function stripSymbols(text: string, symbols: readonly string[]): string {
  let out = text;
  for (const symbol of symbols) {
    if (symbol === '') continue;
    out = out.split(symbol).join(' ');
  }
  return normalizeSpace(out);
}

/** 去掉行首的标记词，返回剩余部分。长标记优先（先匹配「例：」再匹配「例」） */
function stripMarker(line: string, markers: readonly string[]): { hit: boolean; rest: string } {
  const lower = line.toLowerCase();
  const sorted = [...markers].sort((a, b) => b.length - a.length);
  for (const marker of sorted) {
    if (marker !== '' && lower.startsWith(marker.toLowerCase())) {
      return { hit: true, rest: normalizeSpace(line.slice(marker.length)) };
    }
  }
  return { hit: false, rest: normalizeSpace(line) };
}

function canonicalPos(token: string, rules: ParserRules): string {
  const fromRules = rules.posAbbreviations[token];
  if (fromRules !== undefined && fromRules !== '') return fromRules;
  const fallback = DEFAULT_POS_ABBREVIATIONS[token];
  if (fallback !== undefined) return fallback;
  return token;
}

function dedupeExamples(items: readonly EntryExample[]): EntryExample[] {
  const seen = new Set<string>();
  const out: EntryExample[] = [];
  for (const item of items) {
    if (item.en === '') continue;
    const key = normalizeKey(item.en);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function dedupePhrases(items: readonly EntryPhrase[]): EntryPhrase[] {
  const seen = new Set<string>();
  const out: EntryPhrase[] = [];
  for (const item of items) {
    if (item.text === '') continue;
    const key = normalizeKey(item.text);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
