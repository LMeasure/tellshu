// =============================================================================
// table.ts —— markdown 表格 -> 二维数组；不规则动词 -> grammar_rules 草稿
// 纯函数模块，无副作用。
// =============================================================================

import type { GrammarRuleDraft, GrammarRuleType, JsonObject, OcrPage, OcrTable } from '../types';
import { isCjkPresent, isWordLike, normalizeSpace } from './normalize';

// -----------------------------------------------------------------------------
// markdown 表格 -> 二维数组
// -----------------------------------------------------------------------------

/** 一行是否为 markdown 表格行。 */
export function isTableRow(line: string): boolean {
  const text = line.trim();
  if (text === '' || !text.includes('|')) return false;
  return text.startsWith('|') || /^[^\s|]+\s*\|/.test(text);
}

/** 单元格清洗：去粗体、折叠空白。 */
export function normalizeCell(input: string): string {
  return normalizeSpace(input.replace(/\*\*/g, '').replace(/`/g, ''));
}

/** 拆分一行 markdown 表格（支持 \| 转义）。 */
export function splitMarkdownRow(line: string): string[] {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);

  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] ?? '';
    if (ch === '\\' && text[i + 1] === '|') {
      current += '|';
      i += 1;
      continue;
    }
    if (ch === '|') {
      cells.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  cells.push(current);
  return cells.map((cell) => normalizeCell(cell));
}

function isSeparatorRow(cells: readonly string[]): boolean {
  if (cells.length === 0) return false;
  return cells.every((cell) => cell === '' || /^:?-{1,}:?$/.test(cell));
}

/** 从 markdown 文本中抽取所有表格，每个表格是「行 -> 单元格」二维数组。 */
export function parseMarkdownTables(markdown: string): OcrTable[] {
  return parseGenericTables(markdown, isTableRow, splitMarkdownRow);
}

// -----------------------------------------------------------------------------
// 【修复 3-A】HTML 表格 -> 二维数组
//
// 真实证据：本机 2026-10-06 跑通的 PP-StructureV3 结果里，表格不在 markdown 里，
// 而是 table_res_list[].pred_html，形态为
//   <html><body><table><tr><td>动词原形(Infinitive）</td>...
// 旧代码只认 markdown 管道表格 -> page.tables 恒为空 -> grammar_rules 0 行。
// 这里补 HTML 解析，并兼容 rowspan / colspan。
// -----------------------------------------------------------------------------

const HTML_TABLE_RE = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;
const HTML_ROW_RE = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
const HTML_CELL_RE = /<(td|th)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
const HTML_TAG_RE = /<[^>]*>/g;
const HTML_ATTR_RE = /(rowspan|colspan)\s*=\s*["']?(\d+)["']?/i;

function decodeEntities(input: string): string {
  return input
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'");
}

function htmlCellText(raw: string): string {
  // <br> 视为换行再折叠成空格，其余标签直接剥掉
  const withoutTags = raw
    .replace(/<\s*br\s*\/?\s*>/gi, ' ')
    .replace(HTML_TAG_RE, '');
  return normalizeCell(decodeEntities(withoutTags));
}

function spanCount(attrs: string, name: 'rowspan' | 'colspan'): number {
  const lower = attrs.toLowerCase();
  let total = 1;
  const re = new RegExp(HTML_ATTR_RE.source, 'gi');
  let match: RegExpExecArray | null = re.exec(lower);
  while (match !== null) {
    if ((match[1] ?? '').toLowerCase() === name) {
      const value = Number.parseInt(match[2] ?? '1', 10);
      if (Number.isFinite(value) && value > 1) total = value;
    }
    match = re.exec(lower);
  }
  return total;
}

/** 解析一段 HTML（可含多张表），返回二维数组列表。无法解析时返回空数组。 */
export function parseHtmlTables(html: string): OcrTable[] {
  if (typeof html !== 'string' || html === '') return [];
  const tables: OcrTable[] = [];

  HTML_TABLE_RE.lastIndex = 0;
  let tableMatch: RegExpExecArray | null = HTML_TABLE_RE.exec(html);
  while (tableMatch !== null) {
    const body = tableMatch[1] ?? '';
    const rows: OcrTable = [];
    // 上一行遗留的 rowspan：`列 -> [剩余行数, 值]`
    let carried: Array<{ remaining: number; value: string }> = [];

    HTML_ROW_RE.lastIndex = 0;
    let rowMatch: RegExpExecArray | null = HTML_ROW_RE.exec(body);
    while (rowMatch !== null) {
      const cells: string[] = [];
      const nextCarried: Array<{ remaining: number; value: string }> = [];

      // 先把本行开始前仍生效的 rowspan 铺到对应列
      for (const slot of carried) {
        if (slot.remaining > 1) {
          cells.push(slot.value);
          nextCarried.push({ remaining: slot.remaining - 1, value: slot.value });
        }
      }

      HTML_CELL_RE.lastIndex = 0;
      let cellMatch: RegExpExecArray | null = HTML_CELL_RE.exec(rowMatch[1] ?? '');
      while (cellMatch !== null) {
        const attrs = cellMatch[2] ?? '';
        const value = htmlCellText(cellMatch[3] ?? '');
        const colspan = spanCount(attrs, 'colspan');
        const rowspan = spanCount(attrs, 'rowspan');
        for (let i = 0; i < colspan; i += 1) cells.push(i === 0 ? value : '');
        if (rowspan > 1) nextCarried.push({ remaining: rowspan, value });
        cellMatch = HTML_CELL_RE.exec(rowMatch[1] ?? '');
      }

      if (cells.some((cell) => cell !== '')) rows.push(cells);
      carried = nextCarried;
      rowMatch = HTML_ROW_RE.exec(body);
    }

    if (rows.length > 0) tables.push(rows);
    tableMatch = HTML_TABLE_RE.exec(html);
  }
  return tables;
}

/**
 * 通用表格抽取：同一段文本里 markdown 管道表与 HTML 表都可能出现，结果按出现顺序合并。
 */
export function parseAllTables(text: string): OcrTable[] {
  return [...parseHtmlTables(text), ...parseMarkdownTables(text)];
}

/** 内部通用实现：按「行判定 + 行拆分」策略扫描文本，供 markdown / 其它行列式文本复用。 */
function parseGenericTables(
  text: string,
  rowTest: (line: string) => boolean,
  rowSplit: (line: string) => string[],
): OcrTable[] {
  const lines = text.split(/\r?\n/);
  const tables: OcrTable[] = [];

  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (!rowTest(line)) {
      index += 1;
      continue;
    }
    const block: string[] = [];
    while (index < lines.length && rowTest(lines[index] ?? '')) {
      block.push(lines[index] ?? '');
      index += 1;
    }
    const rows = block
      .map((row) => rowSplit(row))
      .filter((cells) => !isSeparatorRow(cells))
      .filter((cells) => cells.some((cell) => cell !== ''));
    if (rows.length > 0) {
      tables.push(rows);
    }
  }
  return tables;
}

// -----------------------------------------------------------------------------
// 不规则动词映射
// -----------------------------------------------------------------------------

type VerbColumn = 'baseForm' | 'pastTense' | 'pastParticiple';

const PARTICIPLE_PATTERNS = [/past\s*participle/i, /participle/i, /过去分词/i, /完成式/i, /-ed\s*form/i];
const TENSE_PATTERNS = [/past\s*tense/i, /preterite/i, /过去式/i, /过去时/i, /^past$/i];
const BASE_PATTERNS = [/base\s*form/i, /infinitive/i, /原形/i, /原型/i, /^verb$/i, /动词/i, /不定式/i];

function classifyColumn(cell: string): VerbColumn | null {
  const text = normalizeSpace(cell);
  if (text === '') return null;
  if (PARTICIPLE_PATTERNS.some((pattern) => pattern.test(text))) return 'pastParticiple';
  if (TENSE_PATTERNS.some((pattern) => pattern.test(text))) return 'pastTense';
  if (BASE_PATTERNS.some((pattern) => pattern.test(text))) return 'baseForm';
  return null;
}

export interface IrregularVerbOptions {
  /** 规则类型，默认 irregular-verb */
  type?: GrammarRuleType;
  /** 来源页码，写入 extra */
  sourcePage?: number | null;
}

interface ColumnMap {
  baseForm: number;
  pastTense: number;
  pastParticiple: number;
}

/** 在表格前若干行中寻找表头，返回列映射；找不到返回 null。 */
function detectHeaderColumns(rows: readonly string[][]): { columns: ColumnMap; headerIndex: number } | null {
  const scanDepth = Math.min(3, rows.length);
  for (let headerIndex = 0; headerIndex < scanDepth; headerIndex += 1) {
    const row = rows[headerIndex];
    if (!row) continue;
    const found: Partial<ColumnMap> = {};
    for (let i = 0; i < row.length; i += 1) {
      const kind = classifyColumn(row[i] ?? '');
      if (kind === null) continue;
      if (found[kind] === undefined) found[kind] = i;
    }
    if (found.baseForm !== undefined && found.pastTense !== undefined && found.pastParticiple !== undefined) {
      return {
        columns: {
          baseForm: found.baseForm,
          pastTense: found.pastTense,
          pastParticiple: found.pastParticiple,
        },
        headerIndex,
      };
    }
  }
  return null;
}

/**
 * 动词形式是否可信。
 * 真实表里存在「be (am,is,are)」「have (has,had)」这类带括号的写法，
 * isWordLike 会因括号/逗号把它判掉 -> be 这行丢失。这里单独放宽。
 */
function looksLikeVerbForm(input: string): boolean {
  const text = input.trim();
  if (text === '' || text.length > 48) return false;
  if (isCjkPresent(text)) return false;
  return /^[A-Za-z][A-Za-z'’\-,/() ]*$/.test(text);
}

/** 无表头时的兜底：三列且首列是单词形态。 */
function looksLikeVerbTriple(cells: readonly string[]): boolean {
  const filled = cells.filter((cell) => cell !== '');
  if (filled.length !== 3) return false;
  const first = filled[0] ?? '';
  if (!isWordLike(first)) return false;
  return filled.slice(1).every((cell) => /^[A-Za-z][A-Za-z'’\-/ ]*$/.test(cell));
}

function pick(cells: readonly string[], index: number): string | null {
  if (index < 0 || index >= cells.length) return null;
  const value = cells[index] ?? '';
  return value === '' ? null : value;
}

/**
 * 把一组 markdown 表格映射为不规则动词规则。
 * 支持：带表头（原形 / 过去式 / 过去分词）与无表头三列两种形态。
 */
export function mapIrregularVerbs(
  tables: readonly OcrTable[],
  options: IrregularVerbOptions = {},
): GrammarRuleDraft[] {
  const type: GrammarRuleType = options.type ?? 'irregular-verb';
  const sourcePage = options.sourcePage ?? null;
  const drafts: GrammarRuleDraft[] = [];

  for (let tableIndex = 0; tableIndex < tables.length; tableIndex += 1) {
    const rows = tables[tableIndex];
    if (!rows || rows.length === 0) continue;

    const header = detectHeaderColumns(rows);
    const startIndex = header ? header.headerIndex + 1 : 0;

    for (let rowIndex = startIndex; rowIndex < rows.length; rowIndex += 1) {
      const cells = rows[rowIndex];
      if (!cells) continue;

      let baseForm: string | null = null;
      let pastTense: string | null = null;
      let pastParticiple: string | null = null;

      if (header) {
        baseForm = pick(cells, header.columns.baseForm);
        pastTense = pick(cells, header.columns.pastTense);
        pastParticiple = pick(cells, header.columns.pastParticiple);
      } else {
        const filled = cells.filter((cell) => cell !== '');
        if (!looksLikeVerbTriple(filled)) continue;
        baseForm = filled[0] ?? null;
        pastTense = filled[1] ?? null;
        pastParticiple = filled[2] ?? null;
      }

      if (baseForm === null || !looksLikeVerbForm(baseForm)) continue;
      if (pastTense === null && pastParticiple === null) continue;

      // 「be (am,is,are)」这类带括号的写法，额外记一个可直接检索的短形式
      const bare = /^([A-Za-z][A-Za-z'’\-]*)/.exec(baseForm)?.[1] ?? baseForm;
      const extra: JsonObject = {
        sourceTableIndex: tableIndex,
        sourceRowIndex: rowIndex,
        sourcePage,
        cells,
      };
      if (bare !== baseForm) extra.baseFormAlias = bare;

      drafts.push({
        type,
        baseForm,
        pastTense,
        pastParticiple,
        extra,
      });
    }
  }
  return drafts;
}

/**
 * 【修复 3-C】汇总所有页的表格：优先用 adapter 已解析的（含 pred_html），
 * 其次从 markdown / HTML 文本里再解析一次。
 */
export function collectTables(pages: readonly OcrPage[]): OcrTable[] {
  const tables: OcrTable[] = [];
  for (const page of pages) {
    if (page.tables.length > 0) {
      tables.push(...page.tables);
      continue;
    }
    tables.push(...parseHtmlTables(page.markdown), ...parseMarkdownTables(page.markdown));
  }
  return tables;
}

/** 便捷入口：直接传 markdown 文本。 */
export function parseIrregularVerbsFromMarkdown(
  markdown: string,
  options: IrregularVerbOptions = {},
): GrammarRuleDraft[] {
  return mapIrregularVerbs(parseAllTables(markdown), options);
}

/** 便捷入口：直接传 PaddleOCR 的 table_res_list[].pred_html。 */
export function parseIrregularVerbsFromHtml(
  html: string,
  options: IrregularVerbOptions = {},
): GrammarRuleDraft[] {
  return mapIrregularVerbs(parseHtmlTables(html), options);
}
