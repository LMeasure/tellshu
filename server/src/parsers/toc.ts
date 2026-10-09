// =============================================================================
// 目录页解析器
//
// 输入：OCR 归一化后的若干页（OcrPage[]）
// 输出：TocDraft[]（扁平，带 tempKey / parentTempKey），可再组装成树
//
// 【修复 2】按行切分 + 支持同行多条目（2026-10-06 真实样本驱动）
//   旧实现把「一个 OCR 块 = 一行目录」。本机实测（server/data/dump/07-toc.*）
//   两张目录页各自只有 1 个 block，整页 40 行全在一个 block_content 里，
//   于是整页被当成 1 行 -> title 578 字符、page_start=1254。
//   新实现：
//     1. 先把每个 block 再按 \n 拆成真正的行（这是本次的核心 bug）；
//     2. 每行先试「标题 + 引导点 + 页码」标准式，再试「标题 + 页码」同行多条目式；
//     3. 层级：有真实缩进（bbox.x0 / 行首空格）时按缩进排名，
//        缩进不可用时退化成「按编号前缀」推导 —— 因为多栏目录的 OCR 结果
//        行首一律从第 0 列开始，缩进信息根本不存在。
//
// 原则：抽不到就跳过，绝不补页码、绝不臆造层级。
// =============================================================================

import type { OcrPage, TocDraft } from '../types';
import {
  clamp,
  leadingIndent,
  normalizeSpace,
  stripMarkdown,
  toIntOrNull,
} from './normalize';

/** 目录行：「标题 + 引导点/空白 + 页码」 */
const DOT_LEADER_RE = /^(.*?)[\s.．·•・]{2,}\s*(\d{1,4})\s*$/;
/** 起止页码式：「附录 1179~1254」 */
const PAGE_RANGE_RE = /^(.+?)\s*(\d{1,4})\s*[~～—－-]\s*(\d{1,4})\s*$/;
/** 同行多条目扫描用的页码 token */
const PAGE_TOKEN_RE = /\d{1,9}|\d{1,4}\s*[~～—－-]\s*\d{1,4}/g;

/** 罗马数字页码（前言/序言常见）：i / ii / iv / xii */
const ROMAN_RE = /^(?=[ivxlcdmIVXLCDM]+$)(?=[ivxlcdmIVXLCDM]*[ivxlIVXL])/;

/** 无页码的分级标题（例如「词典正文」「定语从句」）：page_start 记为 0（未知）
 *  刻意不收含数字的候选 —— 多栏粘连的行（"T 4771116"）页码已经无法复原。 */
const HEADING_ONLY_RE = /^[\u4e00-\u9fffA-Za-z][\u4e00-\u9fffA-Za-z ·・]{0,11}$/;

export interface TocParseOptions {
  /** 最大层级，超出会被压平到该层 */
  maxLevel?: number;
  /** 是否把罗马数字页码也纳入（默认 true） */
  allowRoman?: boolean;
  /** 是否把「无页码的分级标题」也纳入（默认 true，page_start = 0） */
  allowHeadingWithoutPage?: boolean;
  /**
   * 一页里至少要有这么大比例的条目带真实页码，才承认它是目录页（默认 0.4）。
   * 真实证据：动物图形图这类「单词 + 中文」页也会被同行切分逻辑切成若干段，
   * 但它们一条页码都没有；没有页码的目录不叫目录，整页丢弃。
   */
  minPageCoverage?: number;
  /**
   * 是否丢弃「序号式索引页」（默认 true）。
   * 真实证据：考点索引页形如「1a在重读音节中的读音规则 / 2用a或an的情况 / 3be able to…」，
   * 条目序号 1..52 会被同行多条目解析当成页码，产出一批页码全错的目录行。
   * 判定依据：整页页码去重后恰好构成 1..N 的稠密序列（N >= 8 且 <= 200）。
   * 若某本书正文确实按 1..N 逐页排列，可通过该选项关掉这道过滤。
   */
  rejectOrdinalIndex?: boolean;
}

interface RawTocEntry {
  title: string;
  pageStart: number | null;
  pageEnd: number | null;
  indent: number;
  order: number;
  raw: string;
}

// -----------------------------------------------------------------------------
// 行拆分
// -----------------------------------------------------------------------------

interface SourceLine {
  text: string;
  indent: number;
}

/**
 * 【修复 2-A】拿到真正的行：block.text 往往是一整块带 \n 的文本，必须再拆一次。
 * 缩进优先取块的 bbox 左边界，取不到时用行首空白估算。
 */
function toSourceLines(page: OcrPage): SourceLine[] {
  const out: SourceLine[] = [];

  if (page.blocks.length > 0) {
    for (const block of page.blocks) {
      const baseIndent = block.indent ?? leadingIndent(block.text);
      const parts = block.text.split(/\r?\n/);
      parts.forEach((part, index) => {
        const text = stripMarkdown(part);
        if (text.trim() === '') return;
        // 块内部的行：首行用块缩进，后续行用自身行首缩进（保留多级缩进语义）
        const indent = index === 0 ? baseIndent : leadingIndent(part);
        out.push({ text, indent });
      });
    }
    return out;
  }

  for (const line of page.markdown.split(/\r?\n/)) {
    const text = stripMarkdown(line);
    if (text.trim() === '') continue;
    out.push({ text, indent: leadingIndent(line) });
  }
  return out;
}

// -----------------------------------------------------------------------------
// 单行解析
// -----------------------------------------------------------------------------

/** 清掉 OCR 噪声：markdown 残留符号、行首残留页码、行尾引导点 */
function cleanTitle(input: string): string {
  let text = normalizeSpace(input.replace(/[#*｜|]/g, ' ')).replace(/^[\s.．·•・]+/, '');

  // 「1.1 名词的分类」这类编号是有语义的，必须保留；
  // 「1202名词性从句」这种数字与标题之间没有空位的，是上一栏挤过来的页码，去掉。
  const numbered = /^\d+(?:[.．]\d+)*\s+\S/.test(text);
  if (!numbered) {
    text = text.replace(/^\d{1,9}\s*/, '');
  }
  return normalizeSpace(text.replace(/[\s.．·•・]+$/, ''));
}

function isPlausibleTitle(title: string): boolean {
  if (title === '') return false;
  if (/^[.．·•・\s]+$/.test(title)) return false;
  if (/^\d+$/.test(title)) return false;
  // 标题至少要有一个汉字或字母
  return /[\u4e00-\u9fffA-Za-z]/.test(title);
}

/**
 * 标题里若残留引导点，说明这一行是两栏被粘在了一起。
 * 取靠近页码的最后一段 —— 页码跟随的是它右侧（最后）那个标题。
 */
const GUIDE_RUN_RE = /[\s]*[.．·•・]{2,}[\s]*/;

function lastGuideSegment(input: string): string {
  if (!/[.．·•・]{2,}/.test(input)) return input;
  const parts = input.split(GUIDE_RUN_RE).filter((part) => normalizeSpace(part) !== '');
  return parts[parts.length - 1] ?? input;
}

/** 单个 token -> 起止页码；无法判定返回 null */
function tokenToPage(token: string): { pageStart: number; pageEnd: number | null } | null {
  const trimmed = token.trim();
  const rangeMatch = /^(\d{1,4})\s*[~～—－-]\s*(\d{1,4})$/.exec(trimmed);
  if (rangeMatch !== null) {
    const start = toIntOrNull(rangeMatch[1] ?? '');
    const end = toIntOrNull(rangeMatch[2] ?? '');
    if (start === null || end === null || start <= 0 || end < start) return null;
    return { pageStart: start, pageEnd: end };
  }

  const digits = trimmed;
  if (!/^\d+$/.test(digits)) return null;

  // 一页翘了 4 位以上：多栏目录最常见的错拼是两个页码被粘在一起
  // （"形容词和副词的比较级和最高级12001207" -> 1200 + 1207）
  if (digits.length > 4) {
    const half = Math.floor(digits.length / 2);
    if (digits.length % 2 !== 0 || half < 3 || half > 4) return null;
    const head = toIntOrNull(digits.slice(0, half));
    if (head === null || head <= 0) return null;
    // 后半段可能是另一栏的页码，但那里没有标题，宁可丢掉也不臆造
    return { pageStart: head, pageEnd: null };
  }

  const page = toIntOrNull(digits);
  return page === null || page <= 0 ? null : { pageStart: page, pageEnd: null };
}

/**
 * 一行里可能有 1 条也可能有多条目录（多栏排版的结果会被粘成一行）。
 * 逐行输出，绝不跨行回溯 —— 页码后面跟着的下一行可能是另一栏的标题。
 */
/** 残留的 HTML（OCR 插图占位 <div…><img src="imgs/img_in_image_box_278_151_2810_4059.jpg">） */
const HTML_REMNANT_RE = /<\/?[a-zA-Z]+[^>]*>/;

function parseLineToEntries(line: string): Array<{ title: string; pageStart: number | null; pageEnd: number | null }> {
  const cleaned = normalizeSpace(line);
  if (cleaned === '') return [];
  // 插图占位里的坐标数字（278_151_2810_4059）不是页码，整行丢弃
  if (HTML_REMNANT_RE.test(cleaned)) return [];

  // ① 标准式：标题 + 引导点 + 页码
  const dotted = DOT_LEADER_RE.exec(cleaned);
  if (dotted !== null) {
    const title = cleanTitle(dotted[1] ?? '');
    const page = toIntOrNull(dotted[2] ?? '');
    if (isPlausibleTitle(title) && page !== null && page > 0) {
      return [{ title, pageStart: page, pageEnd: null }];
    }
  }

  // ② 起止页码式：附录 1179~1254 / 英语发音表 7~24
  const range = PAGE_RANGE_RE.exec(cleaned);
  if (range !== null) {
    const title = cleanTitle(range[1] ?? '');
    const start = toIntOrNull(range[2] ?? '');
    const end = toIntOrNull(range[3] ?? '');
    if (isPlausibleTitle(title) && start !== null && end !== null && start > 0 && end >= start) {
      return [{ title, pageStart: start, pageEnd: end }];
    }
  }

  // ③ 同行多条目：扫描每个页码 token，切出「上一个切点 -> 该页码」的一段
  const out: Array<{ title: string; pageStart: number | null; pageEnd: number | null }> = [];
  const tokenRegex = new RegExp(PAGE_TOKEN_RE.source, PAGE_TOKEN_RE.flags);
  let cursor = 0;
  let match: RegExpExecArray | null = tokenRegex.exec(cleaned);
  while (match !== null) {
    const token = match[0] ?? '';
    const start = match.index ?? 0;
    const page = tokenToPage(token);
    if (page !== null) {
      // 粘贴在一起的两栏：只保留紧挨页码的那段标题
      const title = cleanTitle(lastGuideSegment(cleaned.slice(cursor, start)));
      // 标题里还残留数字，说明是多栏粘连且已无法复原（"T 4771116 J 5251133 K"），
      // 与其塞一条页码不可信的目录行，不如整条丢掉。
      if (isPlausibleTitle(title) && !/\d/.test(title)) {
        out.push({ title, pageStart: page.pageStart, pageEnd: page.pageEnd });
      }
      cursor = start + token.length;
    }
    tokenRegex.lastIndex = start + Math.max(token.length, 1);
    match = tokenRegex.exec(cleaned);
  }

  if (out.length > 0) return out;

  // ④ 整行没有页码，且形如分级标题 -> 收录为 page_start = 0 的标题节点
  const title = cleanTitle(cleaned);
  if (isPlausibleTitle(title) && HEADING_ONLY_RE.test(title)) {
    return [{ title, pageStart: null, pageEnd: null }];
  }
  return [];
}

/** 罗马数字页码转阿拉伯数字（仅支持 1..3999，够用） */
function romanToInt(input: string): number | null {
  if (!ROMAN_RE.test(input)) return null;
  const table: ReadonlyArray<readonly [string, number]> = [
    ['m', 1000],
    ['cm', 900],
    ['d', 500],
    ['cd', 400],
    ['c', 100],
    ['xc', 90],
    ['l', 50],
    ['xl', 40],
    ['x', 10],
    ['ix', 9],
    ['v', 5],
    ['iv', 4],
    ['i', 1],
  ];
  let rest = input.toLowerCase();
  let total = 0;
  for (const [sym, value] of table) {
    while (rest.startsWith(sym)) {
      total += value;
      rest = rest.slice(sym.length);
    }
  }
  return rest === '' && total > 0 ? total : null;
}

/** 罗马数字页码行（浪费象牙塔）：sth .............. xii */
function tryRomanLine(line: string): { title: string; pageStart: number } | null {
  const rm = /^(.*?)[\s.．·•・]{2,}\s*([ivxlcdmIVXLCDM]{1,7})\s*$/.exec(line);
  if (rm === null) return null;
  const title = cleanTitle(rm[1] ?? '');
  const page = romanToInt(rm[2] ?? '');
  if (title === '' || page === null || !isPlausibleTitle(title)) return null;
  return { title, pageStart: page };
}

function extractRawEntries(
  page: OcrPage,
  options: { allowRoman: boolean; allowHeadingWithoutPage: boolean; counter: { value: number } },
): RawTocEntry[] {
  const out: RawTocEntry[] = [];

  for (const source of toSourceLines(page)) {
    const entries = parseLineToEntries(source.text);
    if (entries.length > 0) {
      for (const entry of entries) {
        const allow = entry.pageStart !== null || options.allowHeadingWithoutPage;
        if (!allow) continue;
        out.push({
          title: entry.title,
          pageStart: entry.pageStart,
          pageEnd: entry.pageEnd,
          indent: source.indent,
          order: options.counter.value++,
          raw: source.text,
        });
      }
      continue;
    }
    if (options.allowRoman) {
      const roman = tryRomanLine(source.text);
      if (roman !== null) {
        out.push({
          title: roman.title,
          pageStart: roman.pageStart,
          pageEnd: null,
          indent: source.indent,
          order: options.counter.value++,
          raw: source.text,
        });
      }
    }
  }
  return out;
}

// -----------------------------------------------------------------------------
// 层级判定
// -----------------------------------------------------------------------------

/**
 * 缩进 -> 层级：不同缩进值升序排名 + 1。
 * 只有一种缩进时返回 null —— 多栏目录的 OCR 结果全部顶格，此时必须走编号推导。
 */
function indentToLevelMap(indents: readonly number[], maxLevel: number): Map<number, number> | null {
  const unique = [...new Set(indents)].sort((a, b) => a - b);
  if (unique.length < 2) return null;
  const map = new Map<number, number>();
  unique.forEach((value, index) => {
    map.set(value, clamp(index + 1, 1, maxLevel));
  });
  return map;
}

/**
 * 编号前缀 -> 层级（缩进不可用时的兜底）。
 * 只依据标题里真实出现的编号样式，不做任何猜测：
 *   第 X 部分 / 第 X 篇      -> 1
 *   拉丁或多字第标题（词典正文、Africa 非洲） -> 2
 *   中文数字序（一、Preliminaries）          -> 3
 *   罗马数字序（I. 书信）                     -> 4
 */
function levelFromNumbering(title: string): number {
  if (/^第[一二三四五六七八九十百]+[部分篇编]/.test(title)) return 1;
  if (/^[一二三四五六七八九十]{1,3}\s*[、.]/.test(title)) return 3;
  // 罗马数字序：ASCII ivxlcdm 与全角 ⅠⅡⅢ… 都要认（OCR 常输出全角）
  if (/^(?:[ivxlcdmIVXLCDM]{1,6}|[Ⅰ-ⅿ]{1,6})\s*[.、)]/.test(title)) return 4;
  return 2;
}

/**
 * 是否像「序号式索引页」：页码去重后恰好是 1..N 的稠密序列。
 * 这种页身上没有真正的页码，只有条目序号，命中则整页不入库（见 TocParseOptions 注释）。
 */
function looksLikeOrdinalIndex(entries: readonly RawTocEntry[]): boolean {
  const pages = entries
    .map((item) => item.pageStart)
    .filter((page): page is number => page !== null && page > 0);
  const unique = [...new Set(pages)].sort((a, b) => a - b);
  if (unique.length < 8) return false;
  const max = unique[unique.length - 1] ?? 0;
  // 真实书籍目录的页码会铺到几百上千，且大量缺号/重复；序号表恰好相反
  if (max > 120) return false;
  return unique.length / max >= 0.8;
}

/**
 * 解析目录页，输出扁平 TocDraft 列表（含父子临时键）。
 * 未识别到任何目录行时返回空数组——调用方应把该页标记为 unknown，而不是造数据。
 */
export function parseTocPages(pages: readonly OcrPage[], options: TocParseOptions = {}): TocDraft[] {
  const maxLevel = options.maxLevel ?? 4;
  const allowRoman = options.allowRoman ?? true;
  const allowHeadingWithoutPage = options.allowHeadingWithoutPage ?? true;
  const rejectOrdinalIndex = options.rejectOrdinalIndex ?? true;
  const minPageCoverage = options.minPageCoverage ?? 0.4;

  const raw: RawTocEntry[] = [];
  const counter = { value: 0 };
  for (const page of pages) {
    const perPage = extractRawEntries(page, { allowRoman, allowHeadingWithoutPage, counter });
    if (perPage.length === 0) continue;
    if (rejectOrdinalIndex && looksLikeOrdinalIndex(perPage)) continue;
    const withPage = perPage.filter((item) => item.pageStart !== null).length;
    if (withPage / perPage.length < minPageCoverage) continue;
    raw.push(...perPage);
  }
  if (raw.length === 0) return [];

  const levelMap = indentToLevelMap(
    raw.map((item) => item.indent),
    maxLevel,
  );

  const drafts: TocDraft[] = [];
  const stack: Array<{ level: number; tempKey: string }> = [];

  raw.forEach((item, index) => {
    // 缩进不可用时（多栏 OCR 全部顶格）按编号前缀推导层级
    const level = clamp(levelMap?.get(item.indent) ?? levelFromNumbering(item.title), 1, maxLevel);
    const tempKey = `toc-${index}-${level}`;

    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (!top || top.level < level) break;
      stack.pop();
    }
    const parent = stack[stack.length - 1];

    drafts.push({
      title: item.title,
      tempKey,
      parentTempKey: parent ? parent.tempKey : null,
      pageStart: item.pageStart,
      pageEnd: item.pageEnd,
      level,
      orderIndex: item.order,
    });
    stack.push({ level, tempKey });
  });

  fillPageEnd(drafts);
  return drafts;
}

/** 单页便捷入口 */
export function parseTocPage(page: OcrPage, options: TocParseOptions = {}): TocDraft[] {
  return parseTocPages([page], options);
}

/**
 * 回填 page_end：下一个「层级 <= 自己」的节点的起始页 - 1。
 * 没有后继节点则为 null（末章不臆造结束页）。
 */
export function fillPageEnd(drafts: readonly TocDraft[]): void {
  for (let i = 0; i < drafts.length; i += 1) {
    const current = drafts[i];
    if (!current) continue;
    for (let j = i + 1; j < drafts.length; j += 1) {
      const next = drafts[j];
      if (!next) continue;
      if (next.level <= current.level) {
        const start = current.pageStart;
        const end = next.pageStart !== null && next.pageStart > 0 ? next.pageStart - 1 : null;
        current.pageEnd = end !== null && start !== null && end >= start ? end : null;
        break;
      }
    }
  }
}

/** 把扁平 TocDraft 组装成树（供 API 直接返回给前端渲染） */
export interface TocTreeNode {
  title: string;
  pageStart: number | null;
  pageEnd: number | null;
  level: number;
  orderIndex: number;
  children: TocTreeNode[];
}

export function buildTocTree(drafts: readonly TocDraft[]): TocTreeNode[] {
  interface MutableNode extends TocTreeNode {
    children: MutableNode[];
  }
  const nodes = new Map<string, MutableNode>();
  const roots: MutableNode[] = [];

  for (const draft of drafts) {
    const node: MutableNode = {
      title: draft.title,
      pageStart: draft.pageStart,
      pageEnd: draft.pageEnd,
      level: draft.level,
      orderIndex: draft.orderIndex,
      children: [],
    };
    nodes.set(draft.tempKey, node);
  }

  for (const draft of drafts) {
    const node = nodes.get(draft.tempKey);
    if (!node) continue;
    const parentKey = draft.parentTempKey;
    const parent = parentKey ? nodes.get(parentKey) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const sortRec = (list: MutableNode[]): void => {
    list.sort((a, b) => a.orderIndex - b.orderIndex);
    for (const child of list) sortRec(child.children);
  };
  sortRec(roots);
  return roots;
}

/** 该页「像不像目录页」的打分（0~1），供页面分类使用 */
export function tocPageScore(page: OcrPage, allowRoman = true): number {
  const lines = toSourceLines(page);
  if (lines.length === 0) return 0;
  let hits = 0;
  for (const line of lines) {
    if (parseLineToEntries(line.text).length > 0) hits += 1;
    else if (allowRoman && tryRomanLine(line.text) !== null) hits += 1;
  }
  if (hits === 0) return 0;
  // 命中率越高越像目录；同时要求至少 3 行，避免单页噪声误判
  const ratio = hits / lines.length;
  return hits >= 3 ? Math.min(1, ratio) : ratio * 0.4;
}
