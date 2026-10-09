// =============================================================================
// classify.ts —— 判定一页 OCR 结果属于哪种页面，决定走哪个 parser
//
// 判定顺序（先强特征后弱特征）：
//   1. 用途为 material（功能 A）-> 直接 material
//   2. 使用说明页（含「使用说明 / 凡例 / 体例」等，且带词性缩写表）
//   3. 表格页（存在表格，且首列是单词形态）
//   4. 目录页（标题 + 引导点 + 页码 命中率高）
//   5. 词条页（词头行数量达标）
//   6. 兜底 unknown —— 调用方应把 unknown 页留给人工，不要硬塞进任何表
// =============================================================================

import type { OcrPage, PageKind, ScanPurpose } from '../types';
import { isWordLike, normalizeSpace } from './normalize';
import { tocPageScore } from './toc';

/** 使用说明页特征词 */
const INSTRUCTION_HINTS = [
  '使用说明',
  '凡例',
  '体例',
  '编写说明',
  '符号说明',
  '略语表',
  '缩写表',
  '本书用法',
];

/** 目录页特征词 */
const TOC_HINTS = ['目录', '目次', 'contents', 'content'];

/** 表格页特征词 */
const TABLE_HINTS = ['不规则动词', '不规则变化', '过去式', '过去分词', '复数形式', '变化表'];

function pageLines(page: OcrPage): string[] {
  if (page.blocks.length > 0) return page.blocks.map((block) => block.text);
  return page.markdown
    .split(/\r?\n/)
    .map((line) => normalizeSpace(line))
    .filter((line) => line !== '');
}

function includesAny(text: string, hints: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return hints.some((hint) => lower.includes(hint.toLowerCase()));
}

/** 表格是否像「单词变形表」：首列是单词形态且至少两列 */
function looksLikeInflectionTable(page: OcrPage): boolean {
  let hits = 0;
  for (const table of page.tables) {
    for (const row of table) {
      const filled = row.filter((cell) => cell !== '');
      if (filled.length < 2) continue;
      const first = filled[0] ?? '';
      if (isWordLike(first)) hits += 1;
    }
  }
  return hits >= 3;
}

/** 粗略统计词头行数量（与 entry.ts 的判定保持一致即可，不追求完全一致） */
function headwordLikeCount(page: OcrPage): number {
  const phonetic = /(\[[^\]\n]{1,64}\]|\/[^/\n]{1,64}\/)/;
  const posTokens = new Set([
    'n.',
    'v.',
    'vt.',
    'vi.',
    'adj.',
    'adv.',
    'prep.',
    'conj.',
    'pron.',
    'num.',
    'art.',
    'int.',
  ]);
  let count = 0;
  for (const line of pageLines(page)) {
    const match = /^([A-Za-z][A-Za-z'’\-]*(?:[ ][A-Za-z][A-Za-z'’\-]*){0,3})/.exec(line);
    if (!match) continue;
    const rest = line.slice((match[1] ?? '').length);
    if (phonetic.test(rest.slice(0, 48))) {
      count += 1;
      continue;
    }
    const tokens = rest.slice(0, 40).split(/[^A-Za-z.]+/).filter((token) => token !== '');
    if (tokens.some((token) => posTokens.has(token) || posTokens.has(`${token}.`))) count += 1;
  }
  return count;
}

export interface ClassifyOptions {
  purpose: ScanPurpose;
  /** 目录页判定阈值，默认 0.5 */
  tocThreshold?: number;
}

/** 判定单页类型 */
export function classifyPage(page: OcrPage, options: ClassifyOptions): PageKind {
  const { purpose } = options;
  const tocThreshold = options.tocThreshold ?? 0.5;
  const lines = pageLines(page);
  const joined = lines.join('\n');
  if (joined.trim() === '' && page.tables.length === 0) return 'unknown';

  if (purpose === 'material') return 'material';

  if (includesAny(joined, INSTRUCTION_HINTS)) return 'instruction';

  if (page.tables.length > 0 && (looksLikeInflectionTable(page) || includesAny(joined, TABLE_HINTS))) {
    return 'table';
  }

  const tocScore = tocPageScore(page);
  if (tocScore >= tocThreshold || (includesAny(joined, TOC_HINTS) && tocScore > 0.2)) {
    return 'toc';
  }

  // 一页内出现 >= 2 个「词头 + 音标/词性」即可判定为词条页
  if (headwordLikeCount(page) >= 2) return 'entry';

  return 'unknown';
}

/** 批量判定 */
export function classifyPages(pages: readonly OcrPage[], options: ClassifyOptions): PageKind[] {
  return pages.map((page) => classifyPage(page, options));
}
