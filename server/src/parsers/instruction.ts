// =============================================================================
// instruction.ts —— 从「使用说明」页抽取解析规则
//
// 产出 ParserRules，供同一 source_book 的后续页面（词条页）复用：
//   · 词性缩写表：n. = 名词 / vt. = 及物动词 / adj. = adjective ...
//   · 符号语义：★ 表示考纲词汇 -> { "★": "syllabus" }
//   · 各类前缀标记：同义词 / 反义词 / 词根词缀 / 例句 / 短语
//
// 纯函数模块。
// =============================================================================

import type { OcrPage, ParserRules } from '../types';
import { EMPTY_PARSER_RULES } from '../types';
import { dedupeKeepOrder, normalizeKey, normalizeSpace, stripMarkdown } from './normalize';
import { isTableRow } from './table';

const ZH_POS_CANONICAL: Record<string, string> = {
  名词: 'noun',
  名: 'noun',
  动词: 'verb',
  动: 'verb',
  及物动词: 'verb.transitive',
  不及物动词: 'verb.intransitive',
  助动词: 'auxiliary',
  情态动词: 'modal',
  形容词: 'adjective',
  形容: 'adjective',
  副词: 'adverb',
  介词: 'preposition',
  代词: 'pronoun',
  连词: 'conjunction',
  连接词: 'conjunction',
  数词: 'numeral',
  冠词: 'article',
  感叹词: 'interjection',
  叹词: 'interjection',
  量词: 'quantifier',
  缩写: 'abbreviation',
  缩略: 'abbreviation',
  前缀: 'prefix',
  后缀: 'suffix',
  复数: 'plural',
};

const SYMBOL_SEMANTICS: Array<{ pattern: RegExp; value: string }> = [
  { pattern: /考纲|大纲|课标|中考|高考/, value: 'syllabus' },
  { pattern: /高频|常用/, value: 'high-frequency' },
  { pattern: /重点|核心/, value: 'key' },
  { pattern: /超纲|拓展/, value: 'out-of-syllabus' },
  { pattern: /口语|口語/, value: 'colloquial' },
  { pattern: /书面|正式/, value: 'formal' },
  { pattern: /非正式|俚语/, value: 'informal' },
];

const SYMBOL_CHARS = '★☆▲△▽●○◆◇■□▪▫※†‡§¶◊√¦«»→⇒←';
const SYMBOL_CLASS = `[${SYMBOL_CHARS.replace(/[[\]\\^-]/g, '\\$&')}]`;

const POS_LINE = new RegExp('^([A-Za-z]{1,8}\\.)\\s*(.+)$');
const SYMBOL_WITH_VERB = new RegExp(`${SYMBOL_CLASS}\\s*(?:表示|代表|意为|指|=|＝|:|：|-|–|—)\\s*([^\\s,，。;；、]{1,16})`, 'g');
const SYMBOL_BARE = new RegExp(`^${SYMBOL_CLASS}\\s*([^\\s,，。;；、]{1,16})`);
const MARKER_ALIAS = /^\s*(?:用|以|标为|标注为|记为)?\s*([A-Za-z][A-Za-z.]{1,12})/;

function canonicalizePosValue(raw: string): string {
  // 去掉括号注释与行首的「= / : / 空格」等引导符，只留真正的语义词
  const cleaned = normalizeSpace(raw).replace(/[（(【\[][^）)】\]]*[）)】\]]/g, '').replace(/^[=＝:：+\-\s]+/, '').trim();
  const firstToken = cleaned.split(/[\s、,，/;；]+/)[0] ?? '';
  if (firstToken === '') return '';
  const fromZh = ZH_POS_CANONICAL[firstToken];
  if (fromZh !== undefined) return fromZh;
  return normalizeKey(firstToken);
}

function semanticOf(raw: string): string {
  for (const entry of SYMBOL_SEMANTICS) {
    if (entry.pattern.test(raw)) return entry.value;
  }
  return normalizeKey(raw) === '' ? 'marked' : normalizeKey(raw);
}

function learnMarker(line: string, zhTerms: readonly string[], target: string[]): void {
  for (const term of zhTerms) {
    const index = line.indexOf(term);
    if (index < 0) continue;
    const tail = line.slice(index + term.length);
    const alias = MARKER_ALIAS.exec(tail);
    const aliasText = alias?.[1];
    if (aliasText !== undefined && aliasText !== '') target.push(aliasText);
    target.push(term);
  }
}

export function cloneParserRules(rules: ParserRules): ParserRules {
  return {
    posAbbreviations: { ...rules.posAbbreviations },
    symbols: { ...rules.symbols },
    synonymMarkers: [...rules.synonymMarkers],
    antonymMarkers: [...rules.antonymMarkers],
    rootAffixMarkers: [...rules.rootAffixMarkers],
    exampleMarkers: [...rules.exampleMarkers],
    phraseMarkers: [...rules.phraseMarkers],
    globalTags: [...rules.globalTags],
  };
}

export function defaultParserRules(): ParserRules {
  return cloneParserRules(EMPTY_PARSER_RULES);
}

/** 从一段说明文本中抽取解析规则（增量写入传入的 rules）。 */
export function parseInstructionText(text: string, base: ParserRules = EMPTY_PARSER_RULES): ParserRules {
  const rules = cloneParserRules(base);

  for (const rawLine of text.split(/\r?\n/)) {
    const line = normalizeSpace(stripMarkdown(rawLine));
    if (line === '' || isTableRow(line)) continue;

    const posMatch = POS_LINE.exec(line);
    if (posMatch) {
      const abbr = normalizeKey(posMatch[1] ?? '');
      const value = canonicalizePosValue(posMatch[2] ?? '');
      if (abbr !== '' && value !== '') {
        rules.posAbbreviations[abbr] = value;
      }
    }

    for (const match of line.matchAll(SYMBOL_WITH_VERB)) {
      const symbol = match[0]?.[0];
      const meaning = match[1];
      if (symbol !== undefined && symbol !== '' && meaning !== undefined && meaning !== '') {
        rules.symbols[symbol] = semanticOf(meaning);
      }
    }
    const bare = SYMBOL_BARE.exec(line);
    if (bare && bare[0] !== undefined) {
      const symbol = bare[0][0];
      const meaning = bare[1];
      if (symbol !== undefined && rules.symbols[symbol] === undefined && meaning !== undefined && meaning !== '') {
        rules.symbols[symbol] = semanticOf(meaning);
      }
    }

    learnMarker(line, ['同义词', '近义词'], rules.synonymMarkers);
    learnMarker(line, ['反义词', '对立词'], rules.antonymMarkers);
    learnMarker(line, ['词根', '词缀'], rules.rootAffixMarkers);
    learnMarker(line, ['例句', '例证', '例'], rules.exampleMarkers);
    learnMarker(line, ['短语', '词组', '搭配'], rules.phraseMarkers);

    if (/考纲|大纲|课标/.test(line)) rules.globalTags.push('syllabus');
  }

  return {
    posAbbreviations: rules.posAbbreviations,
    symbols: rules.symbols,
    synonymMarkers: dedupeKeepOrder(rules.synonymMarkers),
    antonymMarkers: dedupeKeepOrder(rules.antonymMarkers),
    rootAffixMarkers: dedupeKeepOrder(rules.rootAffixMarkers),
    exampleMarkers: dedupeKeepOrder(rules.exampleMarkers),
    phraseMarkers: dedupeKeepOrder(rules.phraseMarkers),
    globalTags: dedupeKeepOrder(rules.globalTags),
  };
}

/** 从若干 OCR 页（使用说明页）中抽取解析规则。 */
export function parseInstructionPages(
  pages: readonly OcrPage[],
  base: ParserRules = EMPTY_PARSER_RULES,
): ParserRules {
  const chunks: string[] = [];
  for (const page of pages) {
    if (page.markdown.trim() !== '') {
      chunks.push(page.markdown);
      continue;
    }
    for (const block of page.blocks) {
      chunks.push(block.text);
    }
    for (const text of page.texts) {
      chunks.push(text);
    }
  }
  return parseInstructionText(chunks.join('\n'), base);
}
