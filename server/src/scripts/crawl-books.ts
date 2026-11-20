// =============================================================================
// npm run crawl:books —— 发现书籍链路 Stage 1 crawler
//
// 数据源：Project Gutenberg
//   robots.txt 仅 Disallow: /ebooks/search；本脚本只访问
//   /browse/scores/top、/cache/epub/<id>/pg<id>.rdf、/cache/epub/<id>/pg<id>.txt
//   三者均不在禁令内，且不使用任何伪装 UA / proxy / 多账号。
//
// 合规：版权过滤口径 A（见 POLICY 常量）—— language=en 且所有 dcterms:creator
//   （以及 marcrel:* 贡献者）均有真实卒年且 ≤1975；缺失卒年一律跳过，不推断。
//
// 产物：server/.crawl-cache/<id>.json（原始只读快照）+ _manifest.json（统计与失败清单）
// 约束：TypeScript strict，禁止 any；疑似字段缺失一律写 null，不编造。
// =============================================================================

import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const SOURCE_SITE = 'gutenberg.org';
const LIST_URL = 'https://www.gutenberg.org/browse/scores/top';
const ROBOTS_URL = 'https://www.gutenberg.org/robots.txt';
const LICENSE_PAGE_URL = 'https://www.gutenberg.org/policy/license.html';

// 真实浏览器 UA（不伪装搜索引擎 / Googlebot / Bingbot）
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const CONNECT_TIMEOUT_MS = 10_000;
const READ_TIMEOUT_MS = 30_000;

/**
 * ⚠️ TLS 特例（实测根因，不是随手加的开关）
 * www.gutenberg.org 在握手过程中会发起 TLS 重协商（curl -v 可见
 * "schannel: renegotiating SSL/TLS connection"）。Node 内置 OpenSSL 3 默认拒绝
 * legacy renegotiation（防护 CVE-2009-3555），不开这个开关会直接报
 * "Client network socket disconnected before secure TLS connection was established"，
 * 表现为本机 Node 全部连不上、但 curl / 浏览器正常。
 *
 * 安全措施并未放松：依然走 https、依然校验证书（rejectUnauthorized 默认 true）、
 * 本 crawler 全程不带任何 token / cookie / Authorization，只下载公有领域纯文本，
 * 不存在可被中间人套取的凭据。
 */
const ENABLE_UNSAFE_RENEGOTIATION = true;

/** 冷启动预热：本机到 gutenberg 的前几次握手失败率明显偏高，先用 robots.txt 探通 */
const WARMUP_ATTEMPTS = 6;
const WARMUP_BACKOFF_MS = 1_500;

// —— 限速 / 并发 / 重试 ——
const MAX_PER_MINUTE = 30;
const MIN_DELAY_MS = 800;
const MAX_DELAY_MS = 2_000;
// 单域名并发硬上限 5（规格要求）；本机到 gutenberg.org 的握手在 5 并发下失败率明显升高，
// 默认取 3 以求稳，--concurrency 可上调但不超过 5。
const MAX_CONCURRENCY = 5;
const DEFAULT_CONCURRENCY = 3;
const MAX_RETRIES = 3;
const MAX_REDIRECTS = 3;
const SLOWDOWN_STATUSES: readonly number[] = [429, 503];
const CONSECUTIVE_SLOWDOWN_LIMIT = 3;
const PAUSE_MS = 60_000;
const MAX_RESUME_ROUNDS = 16;
const CANDIDATE_BATCH = 8;
// 网络类（TLS/连接）失败的退避基数比 HTTP 错误更长：本机实测这类失败会连续成簇出现
const NETWORK_BACKOFF_BASE_MS = 2_000;
const HTTP_BACKOFF_BASE_MS = 1_000;

/** 版权口径 A：所有作者卒年必须 ≤ 该年份（中国 life+50，按当前年份留余量） */
const POLICY_MAX_DEATH_YEAR = 1975;
/** 版权口径 A：只收该语言 */
const POLICY_LANGUAGE = 'en';

/**
 * 复用 TLS 会话的连接池（必须在 MAX_CONCURRENCY 之后声明，避免 TDZ）。
 * 实测对照：每次请求都新建握手 → 12 次里失败 6 次（失败集中在冷启动阶段）；
 * 同一 keep-alive 池 → 12 次里失败 3 次。@types/node 未收录该 TLS 选项，用交集类型补，不用 any。
 */
type HttpsAgentOptions = https.AgentOptions & { enableUnsafeRenegotiation: boolean };
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: MAX_CONCURRENCY,
  enableUnsafeRenegotiation: ENABLE_UNSAFE_RENEGOTIATION,
} as HttpsAgentOptions);
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: MAX_CONCURRENCY });

const START_MARKER_PATTERNS: readonly RegExp[] = [
  /\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG EBOOK\b/,
  /\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG[^\n]*?EBOOK\b/,
];
const END_MARKER_PATTERNS: readonly RegExp[] = [
  /\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG EBOOK\b/,
  /\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG[^\n]*?EBOOK\b/,
];

const ROMAN_VALUES: Readonly<Record<string, number>> = {
  I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000,
};

const WORD_NUMBERS: Readonly<Record<string, number>> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, 'twenty-one': 21, 'twenty two': 22, 'twenty-two': 22,
  'twenty-three': 23, 'twenty-four': 24, 'twenty-five': 25, 'twenty-six': 26, 'twenty-seven': 27,
  'twenty-eight': 28, 'twenty-nine': 29, thirty: 30,
};

/**
 * 章节识别模式。
 * 实测同一本书（Pride and Prejudice）内就并存 `CHAPTER II.` / `CHAPTER XIII`（无句点）/
 * `Chapter XLVI.`（混合大小写）/ `Chapter I.]`（录入手误）四种写法，
 * 别的书还会出现 `CHAPTER 1. Loomings.`（阿拉伯数字 + 同行标题）。
 * → 绝不能只写一条正则；这里按 tier 分层尝试。
 */
interface ChapterPattern {
  readonly name: string;
  readonly regex: RegExp;
}
const CHAPTER_PATTERNS: readonly ChapterPattern[] = [
  { name: 'chapter-roman', regex: /^ *(?:CHAPTER|Chapter) +([IVXLCM]+)\.? *(?:\])? *(?:[:.\u2014\u2013-] *(.*))?$/ },
  { name: 'chapter-roman-colon', regex: /^ *(?:CHAPTER|Chapter) +([IVXLCM]+) *[:.\u2014\u2013-]+ *(.*)$/ },
  { name: 'chapter-arabic', regex: /^ *(?:CHAPTER|Chapter) +(\d+)\.? *(\])? *(?:[:.\u2014\u2013-] *(.*))?$/ },
  { name: 'chapter-word', regex: /^ *(?:CHAPTER|Chapter) +([A-Za-z][A-Za-z -]{2,12})\.? *(?:[:.\u2014\u2013-] *(.*))?$/ },
];
const FALLBACK_SECTION_PATTERNS: readonly ChapterPattern[] = [
  { name: 'part-roman', regex: /^ *(?:PART|Part|BOOK|Book|VOLUME|Volume) +([IVXLCM]+)\.? *(?:[:.\u2014\u2013-] *(.*))?$/ },
  { name: 'part-arabic', regex: /^ *(?:PART|Part|BOOK|Book|VOLUME|Volume) +(\d+)\.? *(?:[:.\u2014\u2013-] *(.*))?$/ },
];
/**
 * 第三梯队：既不带 CHAPTER 也不带 BOOK，直接以序号 + 标题成行。
 * 真实样本：#6133《Arsène Lupin》正文里就是 `I. The Arrest of Arsène Lupin`，
 * 目录区则是缩进的同款写法（`     I.      The Arrest of Arsène Lupin`）。
 * 这类模式泛化风险高，因此排在最后，且必须靠「序号单调 + 目录簇剔除」兜住。
 */
const BARE_COUNTER_PATTERNS: readonly ChapterPattern[] = [
  { name: 'bare-roman-title', regex: /^ *([IVXLCM]{1,6})\. +(\S.{0,70})$/ },
  { name: 'bare-arabic-title', regex: /^ *(\d{1,3})\. +(\S.{0,70})$/ },
];
/**
 * 剧本类：<罗密欧与朱丽叶> 正文没有 CHAPTER，只有 `ACT I` / `Scene II. A public place.`。
 * 真实样本命中：ACT 10 条、Scene 44 条。
 */
const SCENE_PATTERNS: readonly ChapterPattern[] = [
  { name: 'scene-roman', regex: /^ *(?:SCENE|Scene) +([IVXLCM]+)\.? *(?:[:.\u2014\u2013-] *(.*))?$/ },
  { name: 'scene-arabic', regex: /^ *(?:SCENE|Scene) +(\d+)\.? *(?:[:.\u2014\u2013-] *(.*))?$/ },
];
/**
 * 上层分界（PART / BOOK / VOLUME / ACT）。它们本身不是章节，
 * 但承担着「章节号重排」的语义，必须单独收集。
 */
const BOUNDARY_REGEX =
  /^ *(PART|Part|BOOK|Book|VOLUME|Volume|ACT|Act) +([IVXLCM\d]{1,6}|[A-Za-z]{3,10})\.? *(?:\])? *(?:[:.\u2014\u2013-] *(.*))?$/;

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

interface CliOptions {
  readonly limit: number;
  readonly dryRun: boolean;
  readonly outDir: string;
  readonly concurrency: number;
  readonly force: boolean;
  /** 只对已落盘的 raw JSON 重跑章节解析，不发起任何网络请求（便于离线迭代解析规则） */
  readonly reparse: boolean;
  /**
   * 只处理这些 Gutenberg ID（逗号分隔，榜单内过滤）。
   * 为 null 时按榜单顺序取前 limit 本——这是 Stage 1 起就有的原有行为，未改动。
   */
  readonly ids: readonly string[] | null;
}

interface RequestLogEntry {
  readonly url: string;
  readonly status: number | null;
  readonly duration_ms: number;
  readonly retries: number;
  readonly ok: boolean;
  readonly note: string | null;
  readonly at: string;
}

interface FailureRecord {
  readonly book_id: string | null;
  readonly url: string;
  readonly stage: 'list' | 'rdf' | 'copyright' | 'text' | 'validate' | 'parse';
  readonly error_type: string;
  readonly reason: string;
  readonly http_status: number | null;
  readonly retries: number;
  readonly retryable: boolean;
}

interface AgentInfo {
  readonly role: string;
  readonly agent_uri: string | null;
  readonly name: string | null;
  readonly birthdate: number | null;
  readonly deathdate: number | null;
}

interface CopyrightDecision {
  readonly policy: 'A';
  readonly max_author_death_year: number | null;
  readonly require_language: string;
  readonly decision: 'include' | 'skip';
  readonly reason_code: string;
  readonly detail: string;
}

interface ParsedChapter {
  readonly index: number;
  readonly number: number | null;
  readonly title: string | null;
  readonly source_line: number;
}

interface ChapterParse {
  readonly chapters: readonly ParsedChapter[] | null;
  readonly status: 'ok' | 'no-headings' | 'sequence-unreliable';
  readonly note: string;
  readonly pattern_used: string | null;
  readonly toc_entries_in_rdf: number | null;
  readonly toc_from_rdf: string | null;
}

interface TextValidation {
  readonly ok: boolean;
  readonly reason: string | null;
  readonly byte_length: number;
  readonly content_length: number | null;
  readonly content_length_match: boolean | null;
  readonly partial_content_used: boolean;
  readonly resume_rounds: number;
  readonly start_marker: string | null;
  readonly end_marker: string | null;
  readonly body_chars: number;
}

interface CrawledBookFile {
  readonly schema_version: 1;
  readonly source_id: string;
  readonly source_site: string;
  readonly source_url: string;
  readonly rank_in_top_list: number | null;
  readonly list_anchor_title: string | null;
  readonly list_anchor_author: string | null;
  readonly title: string | null;
  readonly alternative_title: string | null;
  readonly authors: readonly AgentInfo[];
  readonly contributors: readonly AgentInfo[];
  readonly author_display: string | null;
  readonly description: string | null;
  readonly description_source: string | null;
  readonly rights: string | null;
  readonly license_raw: string | null;
  readonly license_url: string | null;
  readonly language: string | null;
  readonly issued: string | null;
  readonly subjects_lcsh: readonly string[];
  readonly classification_lcc: readonly string[];
  readonly bookshelves: readonly string[];
  readonly reading_ease: string | null;
  readonly toc_from_rdf: string | null;
  readonly cover_url: string | null;
  readonly has_medium_cover: boolean;
  readonly text_url: string;
  readonly text_sha256: string;
  readonly crawl_time: string;
  readonly copyright: CopyrightDecision;
  readonly text_validation: TextValidation;
  readonly chapters: readonly ParsedChapter[] | null;
  readonly chapter_parse: ChapterParse;
  readonly text: string | null;
}

interface ManifestBookSummary {
  readonly source_id: string;
  readonly source_url: string;
  readonly title: string | null;
  readonly author_display: string | null;
  readonly rights: string | null;
  readonly license_url: string | null;
  readonly cover_url: string | null;
  readonly language: string | null;
  readonly max_author_death_year: number | null;
  readonly text_bytes: number;
  readonly text_sha256: string;
  readonly chapter_count: number | null;
  readonly chapter_parse_status: string | null;
}

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

const DIST_MARKER = `${path.sep}dist${path.sep}`;
const SERVER_ROOT = __dirname.includes(DIST_MARKER)
  ? path.resolve(__dirname.split(DIST_MARKER)[0] ?? __dirname)
  : path.resolve(__dirname, '..', '..');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function xmlUnescape(input: string): string {
  return input
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** 迭代 XML 中某个可重复标签的每一次出现（不依赖 xmlns 声明顺序） */
function iterateElements(xml: string, tag: string): Array<{ opening: string; content: string }> {
  const results: Array<{ opening: string; content: string }> = [];
  const openToken = `<${tag}`;
  const closeToken = `</${tag}>`;
  let cursor = 0;
  for (;;) {
    const start = xml.indexOf(openToken, cursor);
    if (start < 0) break;
    const openEnd = xml.indexOf('>', start);
    if (openEnd < 0) break;
    const opening = xml.slice(start, openEnd + 1);
    if (opening.endsWith('/>')) {
      results.push({ opening, content: '' });
      cursor = openEnd + 1;
      continue;
    }
    const end = xml.indexOf(closeToken, openEnd);
    if (end < 0) break;
    results.push({ opening, content: xml.slice(openEnd + 1, end) });
    cursor = end + closeToken.length;
  }
  return results;
}

function textOfTag(xml: string, tag: string): string | null {
  for (const element of iterateElements(xml, tag)) {
    const value = xmlUnescape(element.content.trim());
    if (value !== '') return value;
  }
  return null;
}

function attrOf(opening: string, attr: string): string | null {
  const match = new RegExp(`${attr}="([^"]*)"`).exec(opening);
  return match?.[1] ?? null;
}

function romanToInt(input: string): number | null {
  const text = input.toUpperCase();
  if (!/^[IVXLCM]+$/.test(text)) return null;
  let total = 0;
  let previous = 0;
  for (let i = text.length - 1; i >= 0; i -= 1) {
    const char = text[i];
    if (char === undefined) return null;
    const value = ROMAN_VALUES[char];
    if (value === undefined) return null;
    if (value < previous) total -= value;
    else {
      total += value;
      previous = value;
    }
  }
  return total;
}

function parseCounter(raw: string): number | null {
  const trimmed = raw.trim();
  const arabic = /^\d+$/.exec(trimmed);
  if (arabic !== null) return Number.parseInt(trimmed, 10);
  const roman = romanToInt(trimmed);
  if (roman !== null) return roman;
  return WORD_NUMBERS[trimmed.toLowerCase()] ?? null;
}

// ---------------------------------------------------------------------------
// HTTP 层：连接 10s / 读取 30s / Range / 重定向
// ---------------------------------------------------------------------------

type HttpFailureKind =
  | 'connect-timeout'
  | 'read-timeout'
  | 'truncated'
  | 'network'
  | 'http-status'
  | 'too-many-redirects';

class HttpFailure extends Error {
  constructor(
    readonly kind: HttpFailureKind,
    message: string,
    readonly status: number | null,
    readonly partial: Buffer | null,
  ) {
    super(message);
    this.name = 'HttpFailure';
  }
}

interface RawResponse {
  readonly url: string;
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: Buffer;
  readonly durationMs: number;
}

function headerString(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function requestOnce(rawUrl: string, headers: Readonly<Record<string, string>>): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve, reject) => {
    const startedAt = Date.now();
    let target: URL;
    try {
      target = new URL(rawUrl);
    } catch {
      reject(new HttpFailure('network', `URL 非法：${rawUrl}`, null, null));
      return;
    }
    const chunks: Buffer[] = [];
    let finished = false;
    let connectTimer: NodeJS.Timeout | null = null;
    let readTimer: NodeJS.Timeout | null = null;

    const clearTimers = (): void => {
      if (connectTimer !== null) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }
      if (readTimer !== null) {
        clearTimeout(readTimer);
        readTimer = null;
      }
    };

    const settle = (failure: HttpFailure | null, statusCode: number, resHeaders: http.IncomingHttpHeaders): void => {
      if (finished) return;
      finished = true;
      clearTimers();
      if (failure !== null) {
        reject(failure);
        return;
      }
      resolve({
        url: rawUrl,
        status: statusCode,
        headers: resHeaders,
        body: Buffer.concat(chunks),
        durationMs: Date.now() - startedAt,
      });
    };

    const baseOptions: http.RequestOptions =       {
        method: 'GET',
        agent: target.protocol === 'http:' ? httpAgent : httpsAgent,
        headers: {
        'User-Agent': USER_AGENT,
        Accept: '*/*',
        'Accept-Encoding': 'identity',
        Connection: 'close',
        ...headers,
      },
    };
    // @types/node 的 https.RequestOptions 未收录 enableUnsafeRenegotiation，
    // 但 Node 运行期会把它透传给 tls.connect（已实测生效），这里用交集类型补上而非 any。
    type HttpsOptions = https.RequestOptions & { enableUnsafeRenegotiation: boolean };
    const httpsOptions: HttpsOptions = { ...baseOptions, enableUnsafeRenegotiation: ENABLE_UNSAFE_RENEGOTIATION };

    const onResponse = (response: http.IncomingMessage): void => {
      // 响应头已到达 → 连接阶段结束，转由读取空闲超时接管
      if (connectTimer !== null) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }
      readTimer = setTimeout(() => {
          response.destroy();
          settle(
            new HttpFailure(
              'read-timeout',
              `读取空闲超时 ${READ_TIMEOUT_MS}ms（已收 ${Buffer.concat(chunks).length} 字节）`,
              response.statusCode ?? null,
              Buffer.concat(chunks),
            ),
            response.statusCode ?? 0,
            response.headers,
          );
        }, READ_TIMEOUT_MS);

        response.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
          if (readTimer !== null) readTimer.refresh();
        });
        response.on('end', () => settle(null, response.statusCode ?? 0, response.headers));
        response.on('aborted', () => {
          settle(
            new HttpFailure(
              'truncated',
              `连接被服务端中断（已收 ${Buffer.concat(chunks).length} 字节）`,
              response.statusCode ?? null,
              Buffer.concat(chunks),
            ),
            response.statusCode ?? 0,
            response.headers,
          );
        });
        response.on('error', (error: Error) => {
          settle(
            new HttpFailure('network', error.message, null, Buffer.concat(chunks)),
            response.statusCode ?? 0,
            response.headers,
          );
        });
    };

    const request =
      target.protocol === 'http:'
        ? http.request(target, baseOptions, onResponse)
        : https.request(target, httpsOptions, onResponse);

    // 连接超时：从发起请求到收到响应头，硬上限 10s
    connectTimer = setTimeout(() => {
      request.destroy(new Error('connect timeout'));
      settle(
        new HttpFailure('connect-timeout', `连接超时 ${CONNECT_TIMEOUT_MS}ms 未收到响应头`, null, null),
        0,
        {},
      );
    }, CONNECT_TIMEOUT_MS);

    request.on('error', (error: Error) => {
      settle(new HttpFailure('network', error.message, null, null), 0, {});
    });
    request.end();
  });
}

interface GetOptions {
  readonly headers?: Readonly<Record<string, string>>;
  /** 允许把 4xx/5xx 当作正常结果返回（由调用方判断），而不是抛错 */
  readonly acceptStatus?: readonly number[];
}

/**
 * 全局限速 + 并发 + 重试 + 退避 + 429/503 降速的 HTTP 客户端。
 * 两条硬约束同时生效：① 每次请求间隔 0.8~2.0s 随机；② 60s 窗口内 ≤30 次；取其更严格者。
 */
class CrawlClient {
  private readonly window: number[] = [];
  private lastRequestAt = 0;
  private throttleFactor = 1;
  private consecutiveSlowdown = 0;
  private inFlight = 0;
  public concurrency = DEFAULT_CONCURRENCY;
  public readonly requestLog: RequestLogEntry[] = [];
  public throttled = false;

  private async waitSlot(): Promise<void> {
    while (this.inFlight >= this.concurrency) {
      await sleep(40);
    }
    this.inFlight += 1;
  }

  private async waitRate(): Promise<void> {
    for (;;) {
      const now = Date.now();
      const cutoff = now - 60_000;
      while (this.window.length > 0 && (this.window[0] ?? 0) < cutoff) {
        this.window.shift();
      }
      const randomGap = MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS);
      const sinceLast = this.lastRequestAt === 0 ? Number.POSITIVE_INFINITY : now - this.lastRequestAt;
      let waitMs = Math.max(0, randomGap * this.throttleFactor - sinceLast);
      if (this.window.length >= MAX_PER_MINUTE) {
        const oldest = this.window[0] ?? now;
        waitMs = Math.max(waitMs, oldest + 60_000 - now + 10);
      }
      if (waitMs <= 0) {
        this.lastRequestAt = Date.now();
        this.window.push(Date.now());
        return;
      }
      await sleep(waitMs);
    }
  }

  private release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
  }

  private registerSlowdown(status: number): void {
    this.consecutiveSlowdown += 1;
    this.throttleFactor = Math.min(8, this.throttleFactor * 2);
    out(`  [限速] ${status} → throttleFactor=${this.throttleFactor} 连续=${this.consecutiveSlowdown}`);
  }

  private registerSuccess(): void {
    this.consecutiveSlowdown = 0;
  }

  private log(entry: RequestLogEntry): void {
    this.requestLog.push(entry);
    out(
      `  [HTTP] ${entry.status ?? '-'} ${entry.duration_ms}ms retry=${entry.retries} ${entry.url}${
        entry.note === null ? '' : ` (${entry.note})`
      }`,
    );
  }

  /** 每次 HTTP 请求的公开日志（含失败），用于事后核对速率与失败率 */
  async get(rawUrl: string, options: GetOptions = {}): Promise<RawResponse> {
    let lastFailure: HttpFailure | null = null;
    const acceptStatus = options.acceptStatus ?? [];
    // MAX_RETRIES 是「重试次数」，所以总尝试次数 = 1 + MAX_RETRIES
    const maxAttempts = MAX_RETRIES + 1;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      await this.waitSlot();
      try {
        await this.waitRate();
        let currentUrl = rawUrl;
        let redirects = 0;
        let response: RawResponse | null = null;
        let accumulatedRetries = attempt;

        for (;;) {
          const single = await requestOnce(currentUrl, options.headers ?? {});
          if (
            [301, 302, 303, 307, 308].includes(single.status) &&
            headerString(single.headers['location']) !== null
          ) {
            redirects += 1;
            if (redirects > MAX_REDIRECTS) {
              throw new HttpFailure('too-many-redirects', '重定向次数过多', single.status, null);
            }
            const location = headerString(single.headers['location']);
            if (location === null) break;
            currentUrl = new URL(location, currentUrl).toString();
            await this.waitRate();
            continue;
          }
          response = single;
          break;
        }

        if (response === null) {
          throw new HttpFailure('network', '无响应', null, null);
        }

        this.release();

        if (SLOWDOWN_STATUSES.includes(response.status)) {
          this.registerSlowdown(response.status);
        } else if (response.status < 400 || acceptStatus.includes(response.status)) {
          this.registerSuccess();
        } else if (response.status >= 400) {
          this.registerSuccess();
        }

        this.log({
          url: rawUrl,
          status: response.status,
          duration_ms: response.durationMs,
          retries: accumulatedRetries,
          ok: response.status < 400 || acceptStatus.includes(response.status),
          note: acceptStatus.includes(response.status) ? '已按可接受状态处理' : null,
          at: new Date().toISOString(),
        });

        if (SLOWDOWN_STATUSES.includes(response.status) && attempt < maxAttempts - 1) {
          const retryAfter = headerString(response.headers['retry-after']);
          await this.applySlowdownPenalty(retryAfter);
          continue;
        }
        if (response.status >= 400 && !acceptStatus.includes(response.status)) {
          if (attempt < maxAttempts - 1 && response.status >= 500) {
            await sleep(1000 * 2 ** attempt + Math.floor(Math.random() * 300));
            continue;
          }
          return response;
        }
        return response;
      } catch (error) {
        this.release();
        const failure =
          error instanceof HttpFailure
            ? error
            : new HttpFailure('network', error instanceof Error ? error.message : String(error), null, null);
        lastFailure = failure;
        this.log({
          url: rawUrl,
          status: failure.status,
          duration_ms: 0,
          retries: attempt,
          ok: false,
          note: `请求层失败：${failure.kind}`,
          at: new Date().toISOString(),
        });
        if (attempt >= maxAttempts - 1) break;
        const base =
          failure.kind === 'network' || failure.kind === 'connect-timeout'
            ? NETWORK_BACKOFF_BASE_MS
            : HTTP_BACKOFF_BASE_MS;
        await sleep(base * 2 ** attempt + Math.floor(Math.random() * 300));
      }
    }

    throw lastFailure ?? new HttpFailure('network', '未知网络错误', null, null);
  }

  private async applySlowdownPenalty(retryAfter: string | null): Promise<void> {
    let waitMs = 1000;
    if (retryAfter !== null) {
      const seconds = Number.parseInt(retryAfter, 10);
      if (Number.isFinite(seconds)) waitMs = Math.min(PAUSE_MS, Math.max(waitMs, seconds * 1000));
    }
    await sleep(waitMs);
    if (this.consecutiveSlowdown >= CONSECUTIVE_SLOWDOWN_LIMIT) {
      this.throttled = true;
      out(`  [限速] 连续 ${this.consecutiveSlowdown} 次 429/503 → 暂停 ${PAUSE_MS / 1000}s 并降低并发`);
      await sleep(PAUSE_MS);
      this.concurrency = Math.max(1, Math.floor(this.concurrency / 2));
      out(`  [限速] concurrency → ${this.concurrency}`);
      this.consecutiveSlowdown = 0;
    }
  }
}

// ---------------------------------------------------------------------------
// 正文下载：HTTP Range 续传 + 206 合并
// ---------------------------------------------------------------------------

interface DownloadResult {
  readonly buffer: Buffer;
  readonly totalBytes: number;
  readonly contentLength: number | null;
  readonly partialUsed: boolean;
  readonly rounds: number;
}

async function downloadText(client: CrawlClient, url: string): Promise<DownloadResult> {
  const chunks: Buffer[] = [];
  let have = 0;
  let rounds = 0;
  let partialUsed = false;
  let expectedTotal: number | null = null;

  for (let round = 0; round < MAX_RESUME_ROUNDS; round += 1) {
    rounds = round + 1;
    const headers: Record<string, string> = have > 0 ? { Range: `bytes=${have}-` } : {};
    try {
      const response = await client.get(url, { headers, acceptStatus: [206, 416] });
      if (response.status === 416) {
        out('  [续传] 416 Range Not Satisfiable → 视为已收满');
        break;
      }
      if (response.status === 200) {
        chunks.length = 0;
        chunks.push(response.body);
        have = response.body.length;
        if (have > 0) expectedTotal = response.headers['content-length']
          ? Number.parseInt(headerString(response.headers['content-length']) ?? '', 10) || null
          : null;
        break;
      }
      if (response.status === 206) {
        partialUsed = true;
        chunks.push(response.body);
        have += response.body.length;
        const range = headerString(response.headers['content-range']);
        const match = range === null ? null : /\/(\d+)$/.exec(range);
        if (match?.[1] !== undefined) expectedTotal = Number.parseInt(match[1], 10);
        if (expectedTotal !== null && have < expectedTotal) {
          out(`  [续传] 已收 ${have}/${expectedTotal} 字节，继续请求剩余部分`);
          continue;
        }
        break;
      }
      break;
    } catch (error) {
      if (error instanceof HttpFailure && error.partial !== null && error.partial.length > 0) {
        chunks.push(error.partial);
        have += error.partial.length;
        partialUsed = true;
        out(`  [续传] ${error.kind}：已累积 ${have} 字节，下一轮 Range 继续`);
        continue;
      }
      throw error;
    }
  }

  return {
    buffer: Buffer.concat(chunks),
    totalBytes: have,
    contentLength: expectedTotal,
    partialUsed,
    rounds,
  };
}

// ---------------------------------------------------------------------------
// RDF 解析（严格按真实结构，见《发现书籍链路-Stage1-RDF结构确认.md》）
// ---------------------------------------------------------------------------

interface RdfParse {
  readonly title: string | null;
  readonly alternativeTitle: string | null;
  readonly description: string | null;
  readonly descriptionSource: string | null;
  readonly rights: string | null;
  readonly licenseRaw: string | null;
  readonly issued: string | null;
  readonly language: string | null;
  readonly subjectsLcsh: string[];
  readonly classificationLcc: string[];
  readonly bookshelves: string[];
  readonly readingEase: string | null;
  readonly toc: string | null;
  readonly authors: AgentInfo[];
  readonly contributors: AgentInfo[];
  readonly coverUrl: string | null;
}

function parseAgentBlock(block: string, role: string): AgentInfo | null {
  const agent = iterateElements(block, 'pgterms:agent')[0];
  if (agent === undefined) return null;
  const rawBirth = textOfTag(agent.content, 'pgterms:birthdate');
  const rawDeath = textOfTag(agent.content, 'pgterms:deathdate');
  const birth = rawBirth === null ? null : Number.parseInt(rawBirth, 10);
  const death = rawDeath === null ? null : Number.parseInt(rawDeath, 10);
  return {
    role,
    agent_uri: attrOf(agent.opening, 'rdf:about'),
    name: textOfTag(agent.content, 'pgterms:name'),
    birthdate: Number.isFinite(birth ?? Number.NaN) ? birth : null,
    deathdate: Number.isFinite(death ?? Number.NaN) ? death : null,
  };
}

function parseRdf(xml: string): RdfParse {
  const ebook = iterateElements(xml, 'pgterms:ebook')[0]?.content ?? xml;

  const authors: AgentInfo[] = [];
  for (const element of iterateElements(ebook, 'dcterms:creator')) {
    const agent = parseAgentBlock(element.content, 'dcterms:creator');
    if (agent !== null) authors.push(agent);
  }

  const contributors: AgentInfo[] = [];
  for (const match of ebook.matchAll(/<(marcrel:[a-zA-Z]+)>/g)) {
    const role = match[1];
    if (role === undefined) continue;
    for (const element of iterateElements(ebook, role)) {
      const agent = parseAgentBlock(element.content, role);
      if (agent !== null) contributors.push(agent);
    }
  }

  // 描述：优先 marc520（PG 官方摘要）；dcterms:description 第一条常是无用的 "Wikipedia page about this book: <url>"
  let description: string | null = null;
  let descriptionSource: string | null = null;
  const marc520 = textOfTag(ebook, 'pgterms:marc520');
  if (marc520 !== null) {
    description = marc520;
    descriptionSource = 'pgterms:marc520';
  } else {
    for (const element of iterateElements(ebook, 'dcterms:description')) {
      const value = xmlUnescape(element.content.trim());
      if (value === '' || /^Wikipedia page about this book:/i.test(value)) continue;
      description = value;
      descriptionSource = 'dcterms:description';
      break;
    }
  }

  const subjectsLcsh: string[] = [];
  const classificationLcc: string[] = [];
  for (const element of iterateElements(ebook, 'dcterms:subject')) {
    const value = textOfTag(element.content, 'rdf:value');
    if (value === null) continue;
    const memberOf = /<dcam:memberOf rdf:resource="([^"]+)"\/>/.exec(element.content)?.[1] ?? '';
    if (memberOf.includes('LCC')) classificationLcc.push(value);
    else subjectsLcsh.push(value);
  }

  const bookshelves: string[] = [];
  for (const element of iterateElements(ebook, 'pgterms:bookshelf')) {
    const value = textOfTag(element.content, 'rdf:value');
    if (value !== null) bookshelves.push(value);
  }

  // 封面：唯一可靠来源是 hasFormat 中真实出现的 pg<id>.cover.medium.jpg
  let coverUrl: string | null = null;
  for (const element of iterateElements(ebook, 'pgterms:file')) {
    const about = attrOf(element.opening, 'rdf:about');
    if (about !== null && about.endsWith('.cover.medium.jpg')) {
      coverUrl = about;
      break;
    }
  }

  const languageBlock = iterateElements(ebook, 'dcterms:language')[0]?.content ?? null;
  const language = languageBlock === null ? null : textOfTag(languageBlock, 'rdf:value');

  const licenseElement = iterateElements(ebook, 'dcterms:license')[0];

  return {
    title: textOfTag(ebook, 'dcterms:title'),
    alternativeTitle: textOfTag(ebook, 'dcterms:alternative'),
    description,
    descriptionSource,
    rights: textOfTag(ebook, 'dcterms:rights'),
    licenseRaw: licenseElement === undefined ? null : attrOf(licenseElement.opening, 'rdf:resource'),
    issued: textOfTag(ebook, 'dcterms:issued'),
    language,
    subjectsLcsh,
    classificationLcc,
    bookshelves,
    readingEase: textOfTag(ebook, 'pgterms:marc908'),
    toc: textOfTag(ebook, 'dcterms:tableOfContents'),
    authors,
    contributors,
    coverUrl,
  };
}

// ---------------------------------------------------------------------------
// 版权判定：口径 A
// ---------------------------------------------------------------------------

function decideCopyright(parsed: RdfParse): CopyrightDecision {
  const deaths = parsed.authors.map((author) => author.deathdate);
  const contributorDeaths = parsed.contributors.map((person) => person.deathdate);
  const allKnown = [...deaths, ...contributorDeaths].filter((year): year is number => year !== null);
  const maxDeath = allKnown.length === 0 ? null : Math.max(...allKnown);
  const rightsText = parsed.rights ?? '';

  const base = {
    policy: 'A' as const,
    max_author_death_year: maxDeath,
    require_language: POLICY_LANGUAGE,
  };

  if (parsed.language !== POLICY_LANGUAGE) {
    return {
      ...base,
      decision: 'skip',
      reason_code: 'language_not_en',
      detail: `dcterms:language = ${parsed.language ?? 'null'}，要求 ${POLICY_LANGUAGE}`,
    };
  }
  if (!/Public domain in the USA/i.test(rightsText)) {
    return {
      ...base,
      decision: 'skip',
      reason_code: 'rights_not_public_domain_usa',
      detail: `dcterms:rights = ${parsed.rights ?? 'null'}`,
    };
  }
  if (parsed.authors.length === 0) {
    return {
      ...base,
      decision: 'skip',
      reason_code: 'no_creator',
      detail: 'RDF 中没有 dcterms:creator，作者不可确认，不推断',
    };
  }
  const missingAuthorDeath = parsed.authors.filter((author) => author.deathdate === null);
  if (missingAuthorDeath.length > 0) {
    return {
      ...base,
      decision: 'skip',
      reason_code: 'author_deathdate_missing',
      detail: `缺失卒年的作者：${missingAuthorDeath
        .map((author) => author.name ?? '(未具名)')
        .join('; ')}`,
    };
  }
  const missingContributorDeath = parsed.contributors.filter((person) => person.deathdate === null);
  if (missingContributorDeath.length > 0) {
    return {
      ...base,
      decision: 'skip',
      reason_code: 'contributor_deathdate_missing',
      detail: `缺失卒年的贡献者（${missingContributorDeath.map((p) => p.role).join(',')}）：${missingContributorDeath
        .map((person) => person.name ?? '(未具名)')
        .join('; ')}`,
    };
  }
  if (maxDeath !== null && maxDeath > POLICY_MAX_DEATH_YEAR) {
    return {
      ...base,
      decision: 'skip',
      reason_code: 'death_year_after_limit',
      detail: `最大卒年 ${maxDeath} > ${POLICY_MAX_DEATH_YEAR}`,
    };
  }
  return {
    ...base,
    decision: 'include',
    reason_code: 'ok',
    detail: `language=${parsed.language}，作者数=${parsed.authors.length}，贡献者数=${parsed.contributors.length}，最大卒年=${maxDeath ?? 'n/a'}`,
  };
}

// ---------------------------------------------------------------------------
// 正文校验与切正文
// ---------------------------------------------------------------------------

function findMarker(text: string, patterns: readonly RegExp[]): { index: number; line: string } | null {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match !== null && match.index >= 0) {
      const lineEnd = text.indexOf('\n', match.index);
      const line = text.slice(match.index, lineEnd < 0 ? text.length : lineEnd).trim();
      return { index: match.index, line };
    }
  }
  return null;
}

function validateAndExtract(
  raw: string,
  download: DownloadResult,
): { validation: TextValidation; body: string | null } {
  const start = findMarker(raw, START_MARKER_PATTERNS);
  const endCandidates = END_MARKER_PATTERNS.map((pattern) => {
    const global = new RegExp(pattern.source, 'g');
    let last: { index: number; line: string } | null = null;
    for (const match of raw.matchAll(global)) {
      if (match.index === undefined) continue;
      const lineEnd = raw.indexOf('\n', match.index);
      last = { index: match.index, line: raw.slice(match.index, lineEnd < 0 ? raw.length : lineEnd).trim() };
    }
    return last;
  }).filter((value): value is { index: number; line: string } => value !== null);

  const end = endCandidates.sort((a, b) => b.index - a.index)[0] ?? null;

  const contentLengthMatch =
    download.contentLength === null ? null : download.totalBytes === download.contentLength;

  let reason: string | null = null;
  if (start === null) reason = '未找到 START OF THE PROJECT GUTENBERG EBOOK 标记';
  else if (end === null || end.index <= start.index) reason = '未找到位于正文之后的 END OF THE PROJECT GUTENBERG EBOOK 标记';
  else if (contentLengthMatch === false) reason = `Content-Length 不符：收到 ${download.totalBytes} / 应为 ${download.contentLength ?? -1}`;

  let body: string | null = null;
  if (reason === null && start !== null && end !== null) {
    const startLineEnd = raw.indexOf('\n', start.index);
    const bodyStart = startLineEnd < 0 ? raw.length : startLineEnd + 1;
    body = raw.slice(bodyStart, end.index);
  }

  return {
    validation: {
      ok: reason === null,
      reason,
      byte_length: download.totalBytes,
      content_length: download.contentLength,
      content_length_match: contentLengthMatch,
      partial_content_used: download.partialUsed,
      resume_rounds: download.rounds,
      start_marker: start?.line ?? null,
      end_marker: end?.line ?? null,
      body_chars: body?.length ?? 0,
    },
    body,
  };
}

// ---------------------------------------------------------------------------
// 章节解析：多模式 + 空行隔离 + 单调性校验 + RDF TOC 交叉核对
// ---------------------------------------------------------------------------

/**
 * ⚠️ Gutenberg 的 .txt 是 CRLF 行尾。若不先归一化，每行末尾会残留 \r，
 * 而本章节正则用 `$` 收尾 —— 结果就是「明明肉眼看得见 CHAPTER XX.，程序命中 0 条」。
 * 这是实测踩到的 bug，务必保留这一步归一化。
 */
interface SectionBoundary {
  readonly line: number;
  readonly label: string;
  readonly counter: number | null;
}

/**
 * 收集 PART / BOOK / VOLUME / ACT 这类上层分界。
 * 它们本身不是章节，但《罪与罚》《Udolpho》的章号在每个 PART/VOLUME 内重新从 I 开始，
 * 不识别分界就会把正常的分卷编号误判成「序号重复」。
 * 隔离规则放宽到「单侧空行」，因为有些书的分界紧贴其上也可以成立。
 */
function collectBoundaries(lines: readonly string[]): SectionBoundary[] {
  const found: SectionBoundary[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (line.trim() === '' || line.length > 80) continue;
    const previous = (lines[i - 1] ?? '').trim();
    const next = (lines[i + 1] ?? '').trim();
    if (!(i === 0 || i === lines.length - 1 || previous === '' || next === '')) continue;
    const match = BOUNDARY_REGEX.exec(line);
    if (match === null) continue;
    const rawCounter = match[2] ?? '';
    found.push({
      line: i,
      label: line.trim(),
      counter: parseCounter(rawCounter),
    });
  }
  return found;
}

function nearestBoundary(boundaries: readonly SectionBoundary[], line: number): SectionBoundary | null {
  let best: SectionBoundary | null = null;
  for (const boundary of boundaries) {
    if (boundary.line <= line && (best === null || boundary.line > best.line)) {
      best = boundary;
    }
  }
  return best;
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

function extractHeadingCandidates(
  lines: readonly string[],
  patterns: readonly ChapterPattern[],
  strictIsolation: boolean,
) {
  const candidates: Array<{
    line: number;
    counter: number | null;
    title: string | null;
    raw: string;
    pattern: string;
  }> = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (line.length === 0 || line.length > 80) continue;
    const previous = (lines[i - 1] ?? '').trim();
    const next = (lines[i + 1] ?? '').trim();
    // 严格模式：前后都要空行（真正独立的标题行）；宽松模式：只需一侧有空行
    const isolated = strictIsolation
      ? (i === 0 || previous === '') && (i === lines.length - 1 || next === '')
      : i === 0 || i === lines.length - 1 || previous === '' || next === '';
    if (!isolated) continue;
    for (const pattern of patterns) {
      const match = pattern.regex.exec(line);
      if (match === null) continue;
      const rawCounter = match[1] ?? '';
      const counter = parseCounter(rawCounter);
      if (counter === null) continue;
      const inlineTitle = (match[2] ?? '').trim();
      candidates.push({
        line: i,
        counter,
        title: inlineTitle === '' ? null : inlineTitle,
        raw: line.trim(),
        pattern: pattern.name,
      });
      break;
    }
  }
  return candidates;
}

function parseChapters(body: string, tocFromRdf: string | null): ChapterParse {
  const lines = normalizeNewlines(body).split('\n');
  const tocEntries = tocFromRdf === null
    ? null
    : tocFromRdf.split(/ -- |\n/).map((entry) => entry.trim()).filter((entry) => entry !== '').length;

  // ① 上层分界：真实存在于多本书中（《罪与罚》PART I–VI 内章节号各自从 I 重排、
  //   《Udolpho》按 VOLUME 分卷重排、《罗密欧与朱丽叶》按 ACT 分幕重排）。
  //   收集它们是为了「分界内序号递增」，否则这些书的重复章号会被误判为不可靠。
  const boundaries = collectBoundaries(lines);

  // ② 按梯队尝试；每梯队先用严格隔离，命中不足再放宽
  const tiers: ReadonlyArray<{ name: string; patterns: readonly ChapterPattern[] }> = [
    { name: 'chapter', patterns: CHAPTER_PATTERNS },
    { name: 'scene', patterns: SCENE_PATTERNS },
    { name: 'part/book/volume', patterns: FALLBACK_SECTION_PATTERNS },
    { name: 'bare-counter', patterns: BARE_COUNTER_PATTERNS },
  ];
  let tier = '';
  let candidates: ReturnType<typeof extractHeadingCandidates> = [];
  for (const entry of tiers) {
    const strict = extractHeadingCandidates(lines, entry.patterns, true);
    const relaxed = strict.length >= 2 ? strict : extractHeadingCandidates(lines, entry.patterns, false);
    if (relaxed.length >= 2) {
      candidates = relaxed;
      tier = entry.name;
      break;
    }
  }

  if (candidates.length === 0) {
    return {
      chapters: null,
      status: 'no-headings',
      note: '未识别到任何章节标题：多模式正则 + 空行隔离后命中 0 条，按规则写 null，不猜测',
      pattern_used: null,
      toc_entries_in_rdf: tocEntries,
      toc_from_rdf: tocFromRdf,
    };
  }

  // ③ 目录行识别：连续出现且行间距 ≤3 的一簇命中判定为目录块（TOC），正文章节之间间隔远大于此
  const tocFlags = candidates.map(() => false);
  for (let i = 0; i < candidates.length; i += 1) {
    let j = i;
    while (
      j + 1 < candidates.length &&
      (candidates[j + 1]?.line ?? 0) - (candidates[j]?.line ?? 0) <= 3
    ) {
      j += 1;
    }
    if (j - i + 1 >= 3) {
      for (let k = i; k <= j; k += 1) tocFlags[k] = true;
    }
    i = j;
  }
  const bodyHeadings = candidates.filter((_candidate, index) => tocFlags[index] !== true);
  const finalList = bodyHeadings.length >= 2 ? bodyHeadings : candidates;

  // ④ 目录前缀剥离：有些书先给一份「带标题的目录」，正文里再用裸 `CHAPTER I.` 重排一遍
  //    （真样本 #1695《The Man Who Was Thursday》：目录 15 条带标题，正文 15 条裸标题）。
  //    判据：同一上层分界内，序号再次回到 1 → 前面那一段是目录，剥掉；
  //    分卷重排（PART 内各自从 I 开始）落在不同分界组，不会被误伤。
  //    剥离前先把目录里带的章节名继承给正文同名条目 —— 这些标题是原文真实内容，不是编造。
  const groupsForPrefix = new Map<number, typeof finalList>();
  for (const candidate of finalList) {
    const owner = nearestBoundary(boundaries, candidate.line);
    const key = owner === null ? -1 : owner.line;
    const bucket = groupsForPrefix.get(key);
    if (bucket === undefined) groupsForPrefix.set(key, [candidate]);
    else bucket.push(candidate);
  }
  const kept: typeof finalList = [];
  let tocPrefixRemoved = 0;
  for (const members of groupsForPrefix.values()) {
    let restartIndex = -1;
    for (let i = 1; i < members.length; i += 1) {
      if ((members[i]?.counter ?? null) === 1) restartIndex = i;
    }
    if (restartIndex <= 0) {
      kept.push(...members);
      continue;
    }
    const dropped = members.slice(0, restartIndex);
    const titleByCounter = new Map<number, string>();
    for (const entry of dropped) {
      if (entry.counter !== null && entry.title !== null && !titleByCounter.has(entry.counter)) {
        titleByCounter.set(entry.counter, entry.title);
      }
    }
    tocPrefixRemoved += dropped.length;
    for (const entry of members.slice(restartIndex)) {
      const inherited = entry.counter === null ? null : titleByCounter.get(entry.counter) ?? null;
      kept.push(entry.title === null && inherited !== null ? { ...entry, title: inherited } : entry);
    }
  }
  kept.sort((a, b) => a.line - b.line);

  // ⑤ 分层单调性校验：在同一个上层分界内，序号必须严格递增
  const finalListKept = kept.length >= 2 ? kept : finalList;
  const groups = new Map<number, typeof finalList>();
  for (const candidate of finalListKept) {
    const owner = nearestBoundary(boundaries, candidate.line);
    const key = owner === null ? -1 : owner.line;
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [candidate]);
    else bucket.push(candidate);
  }
  let monotonic = true;
  let violation = '';
  for (const [key, members] of groups) {
    let previous: number | null = null;
    for (const member of members) {
      const value = member.counter;
      if (value === null) continue;
      if (previous !== null && value <= previous) {
        monotonic = false;
        violation = `分界 ${key < 0 ? '(全书开头)' : boundaries.find((b) => b.line === key)?.label ?? key} 内出现 ${previous} → ${value}`;
        break;
      }
      previous = value;
    }
    if (!monotonic) break;
  }

  if (!monotonic) {
    return {
      chapters: null,
      status: 'sequence-unreliable',
      note: `章节序号不可靠：${violation}（共 ${finalListKept.length} 条命中，分界 ${groups.size} 组），按规则写 null，不猜测`,
      pattern_used: tier,
      toc_entries_in_rdf: tocEntries,
      toc_from_rdf: tocFromRdf,
    };
  }

  const chapters: ParsedChapter[] = finalListKept.map((candidate, index) => {
    const label = candidate.title ?? candidate.raw;
    const owner = nearestBoundary(boundaries, candidate.line);
    return {
      index,
      number: candidate.counter,
      title: owner === null ? label : `${owner.label} — ${label}`,
      source_line: candidate.line,
    };
  });

  let note =
    `tier=${tier}，命中 ${candidates.length} 条，目录簇剔除 ${candidates.length - bodyHeadings.length} 条、` +
    `目录前缀剥离 ${tocPrefixRemoved} 条，正文章节 ${chapters.length} 条，上层分界 ${boundaries.length} 个`;
  if (tocEntries !== null) {
    note += `；RDF 的 dcterms:tableOfContents 记 ${tocEntries} 条（交叉核对：${
      tocEntries === chapters.length ? '一致' : '不一致，以正文章节为准但如实记录'
    }）`;
  }

  return {
    chapters,
    status: 'ok',
    note,
    pattern_used: tier,
    toc_entries_in_rdf: tocEntries,
    toc_from_rdf: tocFromRdf,
  };
}

// ---------------------------------------------------------------------------
// 榜单解析
// ---------------------------------------------------------------------------

interface Candidate {
  readonly id: string;
  readonly rank: number;
  readonly anchorTitle: string | null;
  readonly anchorAuthor: string | null;
}

function decodeEntities(input: string): string {
  return input
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');
}

function parseTopList(html: string): Candidate[] {
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  const pattern = /<a href="\/ebooks\/(\d+)">([\s\S]*?)<\/a>/g;
  for (const match of html.matchAll(pattern)) {
    const id = match[1];
    if (id === undefined) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    const text = decodeEntities((match[2] ?? '').replace(/<[^>]+>/g, '')).trim();
    if (text === '') continue;
    const separator = ' by ';
    const at = text.lastIndexOf(separator);
    const title = at > 0 ? text.slice(0, at).trim() : text;
    const author = at > 0 ? text.slice(at + separator.length).trim() : null;
    candidates.push({
      id,
      rank: candidates.length + 1,
      anchorTitle: title === '' ? null : title,
      anchorAuthor: author === null || author === '' ? null : author,
    });
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: readonly string[]): CliOptions {
  let limit = 10;
  let dryRun = false;
  let outDir = path.resolve(SERVER_ROOT, '.crawl-cache');
  let concurrency = DEFAULT_CONCURRENCY;
  let force = false;
  let reparse = false;
  let ids: string[] | null = null;
  let limitSet = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--force') force = true;
    else if (arg === '--reparse') reparse = true;
    else if (arg === '--ids') {
      const raw = argv[i + 1];
      ids = raw === undefined ? [] : raw.split(',').map((s) => s.trim()).filter(Boolean);
      i += 1;
    }
    else if (arg === '--limit') {
      const raw = argv[i + 1];
      const value = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
      if (Number.isFinite(value) && value > 0) {
        limit = value;
        limitSet = true;
      }
      i += 1;
    } else if (arg === '--out') {
      const raw = argv[i + 1];
      if (raw !== undefined) outDir = path.resolve(SERVER_ROOT, raw);
      i += 1;
    } else if (arg === '--concurrency') {
      const raw = argv[i + 1];
      const value = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
      if (Number.isFinite(value) && value >= 1) concurrency = Math.min(MAX_CONCURRENCY, value);
      i += 1;
    }
  }

  // 给了 --ids 但没显式给 --limit 时，默认目标就是这批 ID 的数量；
  // 两种情况（显式 --limit / 无 --ids）都保持原有行为不变。
  const effectiveLimit = ids !== null && !limitSet ? Math.max(ids.length, 1) : limit;
  return { limit: effectiveLimit, dryRun, outDir, concurrency, force, reparse, ids };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

interface CandidateMeta {
  readonly candidate: Candidate;
  readonly rdfUrl: string;
  readonly textUrl: string;
  readonly parsed: RdfParse;
  readonly decision: CopyrightDecision;
}

async function readExisting(outDir: string, id: string): Promise<CrawledBookFile | null> {
  try {
    const raw = await fs.readFile(path.join(outDir, `${id}.json`), 'utf8');
    const parsed = JSON.parse(raw) as CrawledBookFile;
    if (typeof parsed.text === 'string' && parsed.text.length > 0) return parsed;
    return null;
  } catch {
    return null;
  }
}

interface RobotsProbe {
  readonly status: number;
  readonly bytes: number;
  readonly firstLine: string;
}

/**
 * 冷启动预热：本机到 gutenberg.org 的前几次 TLS 握手失败率显著偏高（实测常被 ~5.5s 掐断），
 * 所以每次运行先抓一次 robots.txt —— 既当连通性探针，也作为「本次运行检查过 robots」的留痕。
 * 成功即返回，失败最多重试 WARMUP_ATTEMPTS 次。
 */
async function fetchRobots(client: CrawlClient): Promise<RobotsProbe | null> {
  for (let attempt = 0; attempt < WARMUP_ATTEMPTS; attempt += 1) {
    try {
      const response = await client.get(ROBOTS_URL);
      const body = response.body.toString('utf8');
      const firstLine = body.split('\n').find((line) => line.trim() !== '') ?? '';
      return { status: response.status, bytes: response.body.length, firstLine: firstLine.trim() };
    } catch {
      await sleep(WARMUP_BACKOFF_MS);
    }
  }
  return null;
}

/**
 * --reparse：只重算已落盘书籍的 chapters / chapter_parse，不发起任何网络请求。
 * 存在意义：章节识别规则要对着真实样本反复调，没必要每次都重新下载几十 MB 正文。
 */
async function reparseChapters(outDir: string): Promise<void> {
  const entries = await fs.readdir(outDir);
  const files = entries.filter((name) => name.endsWith('.json') && name !== '_manifest.json');
  out('='.repeat(72));
  out(`reparse 模式：离线重算章节解析（不联网），目录 = ${outDir}`);
  out('='.repeat(72));

  for (const file of files.sort()) {
    const pathname = path.join(outDir, file);
    let record: CrawledBookFile;
    try {
      record = JSON.parse(await fs.readFile(pathname, 'utf8')) as CrawledBookFile;
    } catch {
      out(`  ✗ ${file} 不是可解析的 JSON，跳过`);
      continue;
    }
    if (typeof record.text !== 'string' || record.text === '') {
      out(`  – ${file} 无正文，跳过`);
      continue;
    }
    const before = record.chapters === null ? null : record.chapters.length;
    const chapterParse = parseChapters(record.text, record.toc_from_rdf);
    const after = chapterParse.chapters === null ? null : chapterParse.chapters.length;
    record = { ...record, chapters: chapterParse.chapters, chapter_parse: chapterParse };
    await fs.writeFile(pathname, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    out(
      `  ${file.padEnd(12)} ${String(record.title ?? '').slice(0, 40).padEnd(42)} ` +
        `章节 ${String(before ?? 'null').padStart(5)} → ${String(after ?? 'null').padStart(5)}  状态=${chapterParse.status}`,
    );
    out(`               ${chapterParse.note}`);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const client = new CrawlClient();
  client.concurrency = options.concurrency;
  const failures: FailureRecord[] = [];
  const writtenBooks: ManifestBookSummary[] = [];

  out('='.repeat(72));
  out(`发现书籍链路 · Stage 1 crawler   数据源=${SOURCE_SITE}`);
  out(`limit=${options.limit} dry-run=${options.dryRun} out=${options.outDir} concurrency=${options.concurrency} force=${options.force}`);
  out(`版权口径 A：language=${POLICY_LANGUAGE}，所有作者/贡献者卒年必须真实存在且 ≤${POLICY_MAX_DEATH_YEAR}`);
  out(`robots 依据：${ROBOTS_URL}（仅 Disallow: /ebooks/search，本脚本不访问该路径）`);
  out('='.repeat(72));

  if (options.reparse) {
    await reparseChapters(options.outDir);
    return;
  }

  out(`\n[0/4] 预热并检查 robots.txt ${ROBOTS_URL}`);
  const robots = await fetchRobots(client);
  out(
    robots === null
      ? '  ⚠ 预热阶段未能取到 robots.txt（已重试多次），继续但需人工复核'
      : `  robots.txt HTTP ${robots.status}，${robots.bytes} 字节，首行：${robots.firstLine}`,
  );

  out(`\n[1/4] 拉取榜单 ${LIST_URL}`);
  const listResponse = await client.get(LIST_URL);
  if (listResponse.status !== 200) {
    failures.push({
      book_id: null,
      url: LIST_URL,
      stage: 'list',
      error_type: 'http_status',
      reason: `榜单页返回 ${listResponse.status}`,
      http_status: listResponse.status,
      retries: MAX_RETRIES,
      retryable: true,
    });
    out(`榜单拉取失败（HTTP ${listResponse.status}），终止。`);
    return;
  }
  let candidates = parseTopList(listResponse.body.toString('utf8'));
  out(`榜单去重后共 ${candidates.length} 个书目`);

  if (options.ids !== null) {
    const wanted = new Set(options.ids);
    const before = candidates.length;
    candidates = candidates.filter((candidate) => wanted.has(candidate.id));
    const seen = new Set(candidates.map((candidate) => candidate.id));
    const missing = options.ids.filter((id) => !seen.has(id));
    out(`--ids 指定 ${wanted.size} 本 → 榜单内命中 ${candidates.length} 本（原 ${before} 本）`);
    if (missing.length > 0) {
      out(`  ⚠ 榜单中未找到：${missing.join(', ')}（将不会被抓取）`);
    }
  }

  out('\n[2/4] 逐个读取 RDF 元数据并做版权判定（并发受全局限速约束）');
  const qualifying: CandidateMeta[] = [];
  let scanned = 0;

  for (let batchStart = 0; batchStart < candidates.length && qualifying.length < options.limit; batchStart += CANDIDATE_BATCH) {
    const batch = candidates.slice(batchStart, batchStart + CANDIDATE_BATCH);
    const settled = await Promise.allSettled(
      batch.map(async (candidate) => {
        const rdfUrl = `https://www.gutenberg.org/cache/epub/${candidate.id}/pg${candidate.id}.rdf`;
        const response = await client.get(rdfUrl);
        if (response.status !== 200) {
          throw new HttpFailure('http-status', `RDF 返回 ${response.status}`, response.status, null);
        }
        return { candidate, response, rdfUrl };
      }),
    );

    for (let i = 0; i < batch.length; i += 1) {
      scanned += 1;
      const candidate = batch[i];
      if (candidate === undefined) continue;
      const result = settled[i];
      if (result === undefined) continue;
      if (result.status === 'rejected') {
        const error = result.reason;
        failures.push({
          book_id: candidate.id,
          url: `https://www.gutenberg.org/cache/epub/${candidate.id}/pg${candidate.id}.rdf`,
          stage: 'rdf',
          error_type: error instanceof HttpFailure ? error.kind : 'unknown',
          reason: error instanceof Error ? error.message : String(error),
          http_status: error instanceof HttpFailure ? error.status : null,
          retries: MAX_RETRIES,
          retryable: true,
        });
        out(`  ✗ #${candidate.rank} ${candidate.id} RDF 失败：${error instanceof Error ? error.message : String(error)}`);
        continue;
      }

      const parsed = parseRdf(result.value.response.body.toString('utf8'));
      const decision = decideCopyright(parsed);
      const label = parsed.title ?? candidate.anchorTitle ?? '(无标题)';
      if (decision.decision === 'skip') {
        out(`  – #${candidate.rank} ${candidate.id} 跳过 [${decision.reason_code}] ${label} — ${decision.detail}`);
        failures.push({
          book_id: candidate.id,
          url: `https://www.gutenberg.org/ebooks/${candidate.id}`,
          stage: 'copyright',
          error_type: decision.reason_code,
          reason: decision.detail,
          http_status: null,
          retries: 0,
          retryable: false,
        });
        continue;
      }
      out(`  ✓ #${candidate.rank} ${candidate.id} 通过 [${decision.reason_code}] ${label} — ${decision.detail}`);
      qualifying.push({
        candidate,
        rdfUrl: result.value.rdfUrl,
        textUrl: `https://www.gutenberg.org/cache/epub/${candidate.id}/pg${candidate.id}.txt`,
        parsed,
        decision,
      });
      if (qualifying.length >= options.limit) break;
    }
  }

  out(`\n扫描 ${scanned} 本，版权通过 ${qualifying.length} 本（目标 ${options.limit}）`);

  if (options.dryRun) {
    out('\n[dry-run] 不下载正文、不写任何文件。以下为将会抓取的清单：');
    for (const item of qualifying) {
      out(
        `  ${item.candidate.id}  ${item.parsed.title ?? 'null'}  |  ${item.parsed.authors
          .map((author) => `${author.name ?? 'null'}(${author.deathdate ?? 'n/a'})`)
          .join(' + ')}  |  cover=${item.parsed.coverUrl ?? 'null'}  |  ${item.textUrl}`,
      );
    }
    out(
      `\n[dry-run] 统计：通过=${qualifying.length} 跳过=${failures.length} HTTP 请求=${client.requestLog.length}`,
    );
    return;
  }

  await fs.mkdir(options.outDir, { recursive: true });

  out('\n[3/4] 下载正文（Range 续传 + 完整性校验）');
  let succeeded = 0;
  let skippedExisting = 0;

  for (const item of qualifying) {
    const { candidate, parsed, textUrl } = item;
    out(`\n  ── #${candidate.rank} ${candidate.id} ${parsed.title ?? '(无标题)'}`);

    const existing = options.force ? null : await readExisting(options.outDir, candidate.id);
    if (existing !== null) {
      skippedExisting += 1;
      out('    已存在且完整，跳过（resume）');
      writtenBooks.push({
        source_id: candidate.id,
        source_url: existing.source_url,
        title: existing.title,
        author_display: existing.author_display,
        rights: existing.rights,
        license_url: existing.license_url,
        cover_url: existing.cover_url,
        language: existing.language,
        max_author_death_year: existing.copyright.max_author_death_year,
        text_bytes: existing.text === null ? 0 : Buffer.byteLength(existing.text, 'utf8'),
        text_sha256: existing.text_sha256,
        chapter_count: existing.chapters === null ? null : existing.chapters.length,
        chapter_parse_status: existing.chapter_parse.status,
      });
      continue;
    }

    try {
      const download = await downloadText(client, textUrl);
  const raw = normalizeNewlines(download.buffer.toString('utf8'));
  const { validation, body } = validateAndExtract(raw, download);

      if (!validation.ok || body === null) {
        failures.push({
          book_id: candidate.id,
          url: textUrl,
          stage: 'validate',
          error_type: 'incomplete_text',
          reason: validation.reason ?? '未知原因',
          http_status: null,
          retries: download.rounds - 1,
          retryable: true,
        });
        out(`    ✗ 正文不完整，不入库：${validation.reason ?? '未知原因'}`);
        continue;
      }

      const chapterParse = parseChapters(body, parsed.toc);
      const record: CrawledBookFile = {
        schema_version: 1,
        source_id: candidate.id,
        source_site: SOURCE_SITE,
        source_url: `https://www.gutenberg.org/ebooks/${candidate.id}`,
        rank_in_top_list: candidate.rank,
        list_anchor_title: candidate.anchorTitle,
        list_anchor_author: candidate.anchorAuthor,
        title: parsed.title,
        alternative_title: parsed.alternativeTitle,
        authors: parsed.authors,
        contributors: parsed.contributors,
        author_display: parsed.authors.map((author) => author.name ?? '').filter((name) => name !== '').join('; ') || null,
        description: parsed.description,
        description_source: parsed.descriptionSource,
        rights: parsed.rights,
        license_raw: parsed.licenseRaw,
        license_url: parsed.licenseRaw === null ? null : LICENSE_PAGE_URL,
        language: parsed.language,
        issued: parsed.issued,
        subjects_lcsh: parsed.subjectsLcsh,
        classification_lcc: parsed.classificationLcc,
        bookshelves: parsed.bookshelves,
        reading_ease: parsed.readingEase,
        toc_from_rdf: parsed.toc,
        cover_url: parsed.coverUrl,
        has_medium_cover: parsed.coverUrl !== null,
        text_url: textUrl,
        text_sha256: createHash('sha256').update(download.buffer).digest('hex'),
        crawl_time: new Date().toISOString(),
        copyright: item.decision,
        text_validation: validation,
        chapters: chapterParse.chapters,
        chapter_parse: chapterParse,
        text: body,
      };

      await fs.writeFile(
        path.join(options.outDir, `${candidate.id}.json`),
        `${JSON.stringify(record, null, 2)}\n`,
        'utf8',
      );
      succeeded += 1;
      writtenBooks.push({
        source_id: candidate.id,
        source_url: record.source_url,
        title: record.title,
        author_display: record.author_display,
        rights: record.rights,
        license_url: record.license_url,
        cover_url: record.cover_url,
        language: record.language,
        max_author_death_year: record.copyright.max_author_death_year,
        text_bytes: Buffer.byteLength(body, 'utf8'),
        text_sha256: record.text_sha256,
        chapter_count: chapterParse.chapters === null ? null : chapterParse.chapters.length,
        chapter_parse_status: chapterParse.status,
      });
      out(
        `    ✓ 入库 ${Buffer.byteLength(body, 'utf8')} 字符 | 章节 ${
          chapterParse.chapters === null ? 'null' : chapterParse.chapters.length
        } (${chapterParse.status}) | cover=${parsed.coverUrl ?? 'null'} | 续传轮次=${download.rounds}`,
      );
      out(`      ${chapterParse.note}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({
        book_id: candidate.id,
        url: textUrl,
        stage: 'text',
        error_type: error instanceof HttpFailure ? error.kind : 'unknown',
        reason: message,
        http_status: error instanceof HttpFailure ? error.status : null,
        retries: MAX_RETRIES,
        retryable: true,
      });
      out(`    ✗ 正文抓取失败：${message}`);
    }
  }

  out('\n[4/4] 写 _manifest.json');
  const manifest = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    source: {
      site: SOURCE_SITE,
      list_url: LIST_URL,
      robots_url: ROBOTS_URL,
      note: 'robots.txt 仅 Disallow: /ebooks/search；本 crawler 未访问该路径，未使用 proxy，未使用多账号。',
    },
    copyright_policy: {
      name: 'A',
      require_language: POLICY_LANGUAGE,
      max_author_death_year: POLICY_MAX_DEATH_YEAR,
      rules: [
        'language 必须等于 en（取自 dcterms:language/rdf:value，嵌套两层，不以任何默认值兜底）',
        'dcterms:rights 必须含 "Public domain in the USA"',
        'dcterms:creator 至少一个；所有 creator 必须有真实 deathdate',
        'marcrel:* 贡献者（译者等）也必须有真实 deathdate',
        '所有卒年最大值 ≤ 1975；任何一项缺失或超限即跳过，不推断、不补全',
      ],
    },
    request_policy: {
      random_delay_ms: [MIN_DELAY_MS, MAX_DELAY_MS],
      max_requests_per_minute: MAX_PER_MINUTE,
      max_concurrency: client.concurrency,
      connect_timeout_ms: CONNECT_TIMEOUT_MS,
      read_timeout_ms: READ_TIMEOUT_MS,
      max_retries: MAX_RETRIES,
      range_resume: true,
      user_agent_is_real_browser: true,
      proxy: false,
      multiple_accounts: false,
    },
    options: {
      limit: options.limit,
      dry_run: options.dryRun,
      out_dir: options.outDir,
      force: options.force,
    },
    counts: {
      candidates_scanned: scanned,
      copyright_include: qualifying.length,
      succeeded,
      skipped_existing: skippedExisting,
      failed: failures.length,
      http_requests: client.requestLog.length,
    },
    books: writtenBooks,
    failures,
    request_log: client.requestLog,
  };
  await fs.writeFile(
    path.join(options.outDir, '_manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );

  out('\n' + '='.repeat(72));
  out(`抓取书籍：${succeeded}（新增）+ ${skippedExisting}（已存在跳过）`);
  out(`版权通过：${qualifying.length} / 扫描 ${scanned}`);
  out(`失败记录：${failures.length}（含版权跳过）`);
  out(`HTTP 请求总数：${client.requestLog.length}`);
  out(`输出目录：${options.outDir}`);
  out('='.repeat(72));
}

void main()
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[crawl:books] 失败：${message}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    // keep-alive 连接池要显式回收，否则进程会等空闲 socket 超时才退出
    httpsAgent.destroy();
    httpAgent.destroy();
  });
