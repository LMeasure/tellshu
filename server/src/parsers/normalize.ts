// =============================================================================
// 解析公共工具：全部为纯函数，不依赖运行环境。
// =============================================================================

/** 归一化键：折叠空白 + 小写（与 SQL 侧 shutree_normalize_key 保持一致）。 */
export function normalizeKey(input: string): string {
  return input.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** 折叠空白并去首尾空格。 */
export function normalizeSpace(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

/** 去掉 markdown 强调符号（表格管线 | 由调用方另行处理）。 */
export function stripMarkdown(input: string): string {
  return input
    .replace(/^\s{0,3}#{1,6}\s+/g, '')
    .replace(/^\s{0,3}>\s?/g, '')
    .replace(/\*\*/g, '')
    .replace(/`{1,3}/g, '')
    .replace(/(^|\s)\*(\S)/g, '$1$2')
    .trim();
}

// CJK 范围：汉字 / 扩展区 / 假名 / 中文标点（U+3000–U+303F，含 。、，「」） / 全角标点
const CJK_RANGE = /[㐀-䶿一-鿿぀-ヿ　-〿！-｠]/;
const CJK_RUN_SOURCE = '[㐀-䶿一-鿿぀-ヿ　-〿！-｠]+';

export function isCjkPresent(input: string): boolean {
  return CJK_RANGE.test(input);
}

/** 中英文切分：首个 CJK 字符之前视为英文，之后视为中文。 */
export function splitEnZh(input: string): { en: string; zh: string | null } {
  const raw = normalizeSpace(input);
  const index = raw.search(CJK_RANGE);
  if (index < 0) {
    return { en: stripEdgeSeparators(raw), zh: null };
  }
  const en = stripEdgeSeparators(raw.slice(0, index));
  const zh = stripEdgeSeparators(raw.slice(index));
  return { en, zh: zh === '' ? null : zh };
}

const EDGE_SEPARATORS = /^[\s:：;；,，.。、—–\-~～·•|]+|[\s:：;；,，.。、—–\-~～·•|]+$/g;

function stripEdgeSeparators(input: string): string {
  return input.replace(EDGE_SEPARATORS, '').trim();
}

/** 列表切分：逗号 / 顿号 / 分号 / 斜杠 / 竖线。保持原顺序去重。 */
export function splitList(input: string): string[] {
  const parts = input
    .split(/[,，、;；/｜|]+/)
    .map((part) => normalizeSpace(part.replace(/^[-•*·\s]+/, '')))
    .filter((part) => part !== '');
  return dedupeKeepOrder(parts);
}

export function dedupeKeepOrder(input: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of input) {
    const key = normalizeKey(item);
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/** 判断是否为「单词形态」（允许空格分隔的短语动词、连字符、撇号）。 */
export function isWordLike(input: string): boolean {
  const text = input.trim();
  if (text === '' || text.length > 48) return false;
  return /^[A-Za-z][A-Za-z'’\-]*(?:\s[A-Za-z'’\-]+)*$/.test(text);
}

/** 行首缩进估算：优先表格化空格，bbox 场景由调用方传入 x0。 */
export function leadingIndent(line: string): number {
  const match = /^(\s*)/.exec(line);
  const spaces = match?.[1]?.length ?? 0;
  const tabs = match?.[1]?.split('\t').length ?? 1;
  return spaces * 4 + (tabs - 1) * 8;
}

/** 是否为 markdown 表格行（供目录 / 词条解析跳过）。 */
export function isMarkdownTableLine(line: string): boolean {
  const text = line.trim();
  if (!text.includes('|')) return false;
  return text.startsWith('|') || /^[^\s|]+\s*\|/.test(text);
}

export function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// -----------------------------------------------------------------------------
// 以下为目录页 / 词条页解析器需要的补充工具
// -----------------------------------------------------------------------------

/** 按文字系统切分为拉丁段与 CJK 段（各自按出现顺序拼接）。
 *  与 splitEnZh 的区别：splitEnZh 以「首个 CJK 字符」为界一刀切，
 *  本函数可处理「中文在前、英文在后」这类混排（如「放弃 to give up」）。 */
export function splitByScript(input: string): { latin: string; cjk: string } {
  const source = new RegExp(CJK_RUN_SOURCE, 'g');
  let latin = '';
  let cjk = '';
  let last = 0;
  const re = new RegExp(source.source, 'g');
  let match: RegExpExecArray | null = re.exec(input);
  while (match !== null) {
    // 注意：CJK_RUN_SOURCE 不带捕获组，这里必须取 match[0]
    const hit = match[0] ?? '';
    latin += input.slice(last, match.index);
    cjk += hit;
    last = match.index + hit.length;
    match = re.exec(input);
  }
  latin += input.slice(last);
  return { latin: normalizeSpace(latin), cjk: normalizeSpace(cjk) };
}

/** 安全整数解析：仅接受纯十进制数字串，失败返回 null。 */
export function toIntOrNull(input: string | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  const trimmed = input.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}

/** 区间裁剪 */
export function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** 统计某字符连续出现的最大次数（用于 ★ 考纲星级） */
export function maxRunLength(input: string, ch: string): number {
  let best = 0;
  let current = 0;
  for (const c of input) {
    if (c === ch) {
      current += 1;
      if (current > best) best = current;
    } else {
      current = 0;
    }
  }
  return best;
}

/** 两个字符串数组求并集并去重（保序） */
export function mergeUnique(a: readonly string[], b: readonly string[]): string[] {
  return dedupeKeepOrder([...a, ...b]);
}

/** 去掉行首编号前缀（1. / 1.1 / ① / (1) / 一、 等） */
export function stripLeadingNumbering(line: string): string {
  return line
    .replace(/^\s*[（(]?\s*\d+(?:\.\d+)*\s*[)）.、]?\s*/, '')
    .replace(/^\s*[①②③④⑤⑥⑦⑧⑨⑩]\s*/, '');
}
