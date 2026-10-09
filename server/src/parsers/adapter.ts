// =============================================================================
// adapter.ts —— 把 PaddleOCR 多种返回形态归一化为 OcrPage[]
//
// 支持四种形态：
//   A. result.layoutParsingResults[].markdown.text + prunedResult（PP-StructureV3 主形态）
//   B. result.pages[].layouts[] / tables[]（分页形态）
//   C. result.ocrResults[].prunedResult.rec_texts（纯识别文本形态）
//   D. 顶层直接给出 markdown / text
//   其它未知形态 -> 空数组（不抛异常，由调用方决定降级策略）
//
// 纯函数模块。
// =============================================================================

import type { BBox, OcrBlock, OcrPage, OcrTable } from '../types';
import { asString, asUnknownArray, isRecord } from '../types';
import { leadingIndent, normalizeSpace, stripMarkdown } from './normalize';
import { isTableRow, parseHtmlTables, parseMarkdownTables, splitMarkdownRow } from './table';

function getField(source: unknown, key: string): unknown {
  return isRecord(source) ? source[key] : undefined;
}

function getArray(source: unknown, key: string): unknown[] {
  return asUnknownArray(getField(source, key));
}

function getString(source: unknown, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = asString(getField(source, key));
    if (value !== null) return value;
  }
  return null;
}

// -----------------------------------------------------------------------------
// bbox 归一化：[x0, y0, x1, y1]
// -----------------------------------------------------------------------------

/** 收窄 number | null | undefined -> number */
function isFiniteNumber(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function numbersOf(source: unknown): number[] {
  const out: number[] = [];
  for (const item of asUnknownArray(source)) {
    if (typeof item === 'number' && Number.isFinite(item)) out.push(item);
  }
  return out;
}

export function toBBox(value: unknown): BBox {
  if (Array.isArray(value)) {
    const flat = value.length === 4 && numbersOf(value).length === 4 ? numbersOf(value) : null;
    if (flat !== null) {
      const [a, b, c, d] = flat;
      if (a !== undefined && b !== undefined && c !== undefined && d !== undefined) {
        return [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
      }
      return null;
    }
    // 多边形：[[x, y], [x, y], ...]
    const xs: number[] = [];
    const ys: number[] = [];
    for (const point of value as unknown[]) {
      const pair = numbersOf(point);
      const x = pair[0];
      const y = pair[1];
      if (x !== undefined && y !== undefined) {
        xs.push(x);
        ys.push(y);
      }
    }
    if (xs.length === 0 || ys.length === 0) return null;
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }

  if (isRecord(value)) {
    const direct = [value['x0'], value['y0'], value['x1'], value['y1']].map((item): number | null =>
      typeof item === 'number' && Number.isFinite(item) ? item : null,
    );
    const [x0, y0, x1, y1] = direct;
    if (isFiniteNumber(x0) && isFiniteNumber(y0) && isFiniteNumber(x1) && isFiniteNumber(y1)) {
      return [x0, y0, x1, y1];
    }

    const rect = [value['left'], value['top'], value['right'], value['bottom']].map((item): number | null =>
      typeof item === 'number' && Number.isFinite(item) ? item : null,
    );
    const [left, top, right, bottom] = rect;
    if (isFiniteNumber(left) && isFiniteNumber(top) && isFiniteNumber(right) && isFiniteNumber(bottom)) {
      return [left, top, right, bottom];
    }

    const x = value['x'];
    const y = value['y'];
    const width = value['width'];
    const height = value['height'];
    if (
      typeof x === 'number' &&
      typeof y === 'number' &&
      typeof width === 'number' &&
      typeof height === 'number'
    ) {
      return [x, y, x + width, y + height];
    }
  }
  return null;
}

// -----------------------------------------------------------------------------
// 文本块归一化
// -----------------------------------------------------------------------------

/**
 * 【修复 2-B】块内换行必须保留：
 * 旧实现直接 normalizeSpace 整块文本，把 \n 压成空格 —— 目录页整页只有一个 block，
 * 于是 40 行变成 1 行，目录解析器只能吐出 1 条拼接标题。
 * 这里逐行折叠空白后再拼回，行结构不丢。
 */
function normalizeMultiline(input: string): string {
  return input
    .split(/\r?\n/)
    .map((line) => normalizeSpace(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function blockText(item: unknown): string {
  if (typeof item === 'string') return normalizeMultiline(item);
  return normalizeMultiline(
    getString(item, 'block_content', 'text', 'content', 'label_text', 'value') ?? '',
  );
}

function toBlock(item: unknown): OcrBlock | null {
  const text = blockText(item);
  if (text === '') return null;
  const bbox = toBBox(
    getField(item, 'block_bbox') ?? getField(item, 'bbox') ?? getField(item, 'box') ?? getField(item, 'coordinate'),
  );
  const labelRaw = isRecord(item) ? getString(item, 'block_label', 'label', 'type') : null;
  return {
    text,
    label: labelRaw,
    bbox,
    indent: bbox === null ? null : bbox[0],
  };
}

function toBlocks(source: unknown): OcrBlock[] {
  const out: OcrBlock[] = [];
  for (const item of asUnknownArray(source)) {
    const block = toBlock(item);
    if (block !== null) out.push(block);
  }
  return out;
}

// -----------------------------------------------------------------------------
// 表格归一化
//
// 【修复 3-B】真实证据（2026-10-06 本机实测）：PP-StructureV3 的表格结果位于
//   layoutParsingResults[].prunedResult.table_res_list[].pred_html
// 形态是 HTML（<table><tr><td>…），而不是 markdown 管道表格；
// 旧 tableToRows 只读 markdown/table_markdown/text -> 返回 null -> page.tables 恒为空
// -> 表格页 mapIrregularVerbs 拿不到数据 -> grammar_rules 0 行。
// -----------------------------------------------------------------------------

function tableToRows(item: unknown): OcrTable | null {
  if (typeof item === 'string') {
    const tables = parseHtmlTables(item);
    const table = tables[0] ?? parseMarkdownTables(item)[0];
    return table ?? null;
  }
  if (Array.isArray(item)) {
    const rows: OcrTable = [];
    for (const row of item as unknown[]) {
      if (Array.isArray(row)) {
        rows.push((row as unknown[]).map((cell) => normalizeSpace(String(cell ?? ''))));
      } else {
        const text = normalizeSpace(String(row ?? ''));
        if (text !== '') rows.push([text]);
      }
    }
    return rows.length > 0 ? rows : null;
  }
  if (isRecord(item)) {
    // 优先 pred_html（PP-StructureV3 实际字段），拿不到再退到 markdown 文本
    const html = getString(item, 'pred_html', 'predHtml', 'html');
    if (html !== null) {
      const first = parseHtmlTables(html)[0];
      if (first !== undefined) return first;
    }
    const markdown = getString(item, 'markdown', 'table_markdown', 'text');
    if (markdown !== null) {
      const first = parseHtmlTables(markdown)[0] ?? parseMarkdownTables(markdown)[0];
      if (first !== undefined) return first;
    }
    const cells = getField(item, 'cells') ?? getField(item, 'rows');
    if (cells !== undefined) return tableToRows(cells);
  }
  return null;
}

function toTables(source: unknown): OcrTable[] {
  const out: OcrTable[] = [];
  for (const item of asUnknownArray(source)) {
    const rows = tableToRows(item);
    if (rows !== null) out.push(rows);
  }
  return out;
}

// -----------------------------------------------------------------------------
// 展开 result 容器
// -----------------------------------------------------------------------------

function unwrapResult(input: unknown): unknown {
  let current = input;
  for (let depth = 0; depth < 3; depth += 1) {
    if (!isRecord(current)) return current;
    const result = current['result'];
    const data = current['data'];
    if (result !== undefined) {
      current = result;
      continue;
    }
    if (isRecord(data) && data['result'] !== undefined) {
      current = data['result'];
      continue;
    }
    if (isRecord(data)) {
      current = data;
      continue;
    }
    return current;
  }
  return current;
}

// -----------------------------------------------------------------------------
// 四种形态 -> OcrPage
// -----------------------------------------------------------------------------

function textsOf(blocks: readonly OcrBlock[]): string[] {
  return blocks.map((block) => block.text);
}

function pageFromMarkdown(markdown: string, blocks: OcrBlock[], tables: OcrTable[], texts: string[]): OcrPage {
  // 【修复 3-B】兜底：table_res_list 缺失时，表格也可能以 HTML 形式躺在 markdown 里
  const resolvedTables = tables.length > 0 ? tables : parseHtmlTables(markdown).concat(parseMarkdownTables(markdown));
  const resolvedTexts = texts.length > 0 ? texts : textsOf(blocks);
  return { markdown, blocks, tables: resolvedTables, texts: resolvedTexts };
}

/** 形态 A：layoutParsingResults[] */
export function pageFromLayoutResult(item: unknown): OcrPage {
  const markdownObject = getField(item, 'markdown');
  let markdown = '';
  if (typeof markdownObject === 'string') {
    markdown = markdownObject;
  } else if (isRecord(markdownObject)) {
    markdown = getString(markdownObject, 'text', 'content') ?? '';
  }
  if (markdown === '') markdown = getString(item, 'text', 'markdown_text') ?? '';

  const pruned = getField(item, 'prunedResult') ?? getField(item, 'pruned_result') ?? item;

  let blocks = toBlocks(
    getField(pruned, 'parsing_res_list') ?? getField(pruned, 'parsingResList') ?? getField(item, 'parsing_res_list'),
  );
  if (blocks.length === 0) {
    blocks = toBlocks(getField(pruned, 'layout_det_res') ?? getField(pruned, 'boxes') ?? getField(pruned, 'layouts'));
  }
  if (blocks.length === 0 && markdown !== '') {
    blocks = markdown
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '' && !isTableRow(line))
      .map((line) => ({
        // 缩进必须在 stripMarkdown 之前取，否则 trim() 会把缩进吃掉，目录层级全部塌陷成 1 级
        text: normalizeSpace(stripMarkdown(line)),
        label: null,
        bbox: null,
        indent: leadingIndent(line),
      }));
  }

  const tableSources = getField(pruned, 'table_res_list') ?? getField(pruned, 'tables');
  let tables = toTables(tableSources);
  if (tables.length === 0) {
    // 少数排版下表格会以 block_content 形式出现在正文块里
    const tableBlocks = asUnknownArray(getField(pruned, 'parsing_res_list'))
      .filter((block) => isRecord(block) && getString(block, 'block_label') === 'table')
      .map((block) => getString(block, 'block_content'));
    tables = toTables(tableBlocks.filter((value): value is string => value !== null));
  }
  const texts = asUnknownArray(getField(pruned, 'rec_texts'))
    .map((value) => (typeof value === 'string' ? normalizeSpace(value) : ''))
    .filter((value) => value !== '');

  return pageFromMarkdown(markdown, blocks, tables, texts);
}

/** 形态 B：pages[]，含 layouts[] / tables[] */
export function pageFromPageObject(item: unknown): OcrPage {
  const markdown = getString(item, 'markdown', 'text', 'md') ?? '';
  const blocks = toBlocks(getField(item, 'layouts') ?? getField(item, 'blocks') ?? getField(item, 'lines'));
  const tables = toTables(getField(item, 'tables'));
  const resolvedMarkdown =
    markdown !== '' ? markdown : blocks.map((block) => block.text).join('\n');
  return pageFromMarkdown(resolvedMarkdown, blocks, tables, []);
}

/** 形态 C：ocrResults[].prunedResult.rec_texts */
export function pageFromOcrResults(items: unknown): OcrPage {
  const blocks: OcrBlock[] = [];
  for (const item of asUnknownArray(items)) {
    const pruned = getField(item, 'prunedResult') ?? getField(item, 'pruned_result') ?? item;
    const texts = asUnknownArray(getField(pruned, 'rec_texts'));
    const boxes = asUnknownArray(getField(pruned, 'rec_boxes') ?? getField(pruned, 'rec_polys'));
    texts.forEach((value, index) => {
      if (typeof value !== 'string') return;
      const text = normalizeSpace(value);
      if (text === '') return;
      const bbox = toBBox(boxes[index]);
      blocks.push({ text, label: 'text', bbox, indent: bbox === null ? null : bbox[0] });
    });
  }
  const markdown = blocks.map((block) => block.text).join('\n');
  return pageFromMarkdown(markdown, blocks, [], textsOf(blocks));
}

/** 形态 D：顶层直接给出 markdown / text */
export function pageFromDirect(root: unknown): OcrPage | null {
  const markdown = getString(root, 'markdown', 'text', 'content', 'md');
  if (markdown === null || markdown.trim() === '') return null;
  const blocks = markdown
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const raw = line;
      const isRow = isTableRow(raw);
      return {
        text: isRow ? splitMarkdownRow(raw).join(' | ') : normalizeSpace(stripMarkdown(raw)),
        label: null,
        bbox: null,
        indent: null,
      } satisfies OcrBlock;
    })
    .filter((block) => block.text !== '');
  return pageFromMarkdown(markdown, blocks, [], textsOf(blocks));
}

/**
 * JSONL 单行解析后的对象（或直接是 result）-> 归一化页数组。
 * 未知形态返回空数组，绝不抛异常。
 *
 * 【修复 3-C】额外支持 scan_records.raw_ocr_json 的留存形态：
 *   { lineResults: [ { result: { layoutParsingResults: [...] } } ] }
 * 重跑脚本靠它直接回放库里的原始 OCR 结果，无需二次调用 PaddleOCR。
 */
export function extractOcrPages(input: unknown): OcrPage[] {
  const root = unwrapResult(input);
  if (root === null || root === undefined || typeof root !== 'object') return [];

  const lineResults = getArray(root, 'lineResults');
  if (lineResults.length > 0) {
    const out: OcrPage[] = [];
    for (const line of lineResults) {
      out.push(...extractOcrPages(line));
    }
    return out.filter((page) => !isEmptyPage(page));
  }

  const layoutResults = getArray(root, 'layoutParsingResults');
  if (layoutResults.length > 0) {
    return layoutResults.map((item) => pageFromLayoutResult(item)).filter((page) => !isEmptyPage(page));
  }

  const pages = getArray(root, 'pages');
  if (pages.length > 0) {
    return pages.map((item) => pageFromPageObject(item)).filter((page) => !isEmptyPage(page));
  }

  const ocrResults = getArray(root, 'ocrResults');
  if (ocrResults.length > 0) {
    const page = pageFromOcrResults(ocrResults);
    return isEmptyPage(page) ? [] : [page];
  }

  const direct = pageFromDirect(root);
  return direct === null || isEmptyPage(direct) ? [] : [direct];
}

function isEmptyPage(page: OcrPage): boolean {
  return page.markdown.trim() === '' && page.blocks.length === 0 && page.texts.length === 0;
}

/** 便捷入口：直接吃一条 JSONL 文本。 */
export function extractOcrPagesFromJsonLines(jsonl: string): OcrPage[] {
  const out: OcrPage[] = [];
  for (const line of jsonl.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      continue;
    }
    out.push(...extractOcrPages(parsed));
  }
  return out;
}
