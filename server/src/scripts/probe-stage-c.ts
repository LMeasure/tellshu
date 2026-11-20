// =============================================================================
// Stage C 前置探针 · 下载与校验（实验专用，不进入正式数据链路）
//
// 目的：只为了测出真实的下载耗时 / 文件大小 / SHA256 / START-END 校验 / 章节与切块结果，
//       给后面的 embedding benchmark 提供真实语料。**不做任何数据库写入。**
//
// 隔离：产物只写到 --out 指定目录（默认 server/.probe-cache/），
//       绝不写 server/.crawl-cache/（那是正式抓取的缓存目录）。
//
// 行为对齐 crawl-books.ts：
//   - 同样的 TLS 选项（enableUnsafeRenegotiation + keep-alive），否则本机握手会大面积失败
//   - 同样的 Range 续传 + 重试退避 + 限速（0.8~2.0s/请求）
//   - 同样的 START / END 标记正则与正文裁切方式
//   - robots.txt 仍然先抓，作为「本次运行检查过 robots」的留痕
//
// 与 crawl-books.ts 的唯一差别：按显式 ID 抓取（正式抓取只走榜单 + --limit），
// 且输出文件名带 .probe 后缀以便一眼区分。
// =============================================================================

import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

const SOURCE_SITE = 'gutenberg.org';
const ROBOTS_URL = 'https://www.gutenberg.org/robots.txt';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const CONNECT_TIMEOUT_MS = 10_000;
const READ_TIMEOUT_MS = 30_000;
const MIN_DELAY_MS = 800;
const MAX_DELAY_MS = 2_000;
const MAX_RETRIES = 3;
const MAX_REDIRECTS = 3;
const MAX_RESUME_ROUNDS = 16;
const NETWORK_BACKOFF_BASE_MS = 2_000;
const HTTP_BACKOFF_BASE_MS = 1_000;
const ENABLE_UNSAFE_RENEGOTIATION = true;

const START_MARKER_PATTERNS: readonly RegExp[] = [
  /\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG EBOOK\b/,
  /\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG[^\n]*?EBOOK\b/,
];
const END_MARKER_PATTERNS: readonly RegExp[] = [
  /\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG EBOOK\b/,
  /\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG[^\n]*?EBOOK\b/,
];

const DIST_MARKER = `${path.sep}dist${path.sep}`;
const SERVER_ROOT = __dirname.includes(DIST_MARKER)
  ? path.resolve(__dirname.split(DIST_MARKER)[0] ?? __dirname)
  : path.resolve(__dirname, '..', '..');

type HttpsAgentOptions = https.AgentOptions & { enableUnsafeRenegotiation: boolean };
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 2,
  enableUnsafeRenegotiation: ENABLE_UNSAFE_RENEGOTIATION,
} as HttpsAgentOptions);
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 2 });

function out(message: string): void {
  process.stdout.write(`${message}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function randomDelay(): number {
  return MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS);
}

interface RawResponse {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: Buffer;
}

interface DownloadResult {
  readonly buffer: Buffer;
  readonly totalBytes: number;
  readonly contentLength: number | null;
  readonly partialUsed: boolean;
  readonly rounds: number;
  readonly attempts: number;
}

class HttpFailure extends Error {
  readonly kind: string;
  readonly status: number | null;
  readonly partial: Buffer | null;

  constructor(kind: string, message: string, status: number | null, partial: Buffer | null) {
    super(message);
    this.name = 'HttpFailure';
    this.kind = kind;
    this.status = status;
    this.partial = partial;
  }
}

function headerString(value: string | string[] | undefined): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length > 0) return value[0] ?? null;
  return null;
}

async function requestOnce(
  url: string,
  headers: Record<string, string>,
): Promise<{ response: RawResponse; partial: Buffer | null }> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      reject(new HttpFailure('network', `URL 非法：${url}`, null, null));
      return;
    }
    const transport = parsed.protocol === 'http:' ? http : https;
    const agent = parsed.protocol === 'http:' ? httpAgent : httpsAgent;
    const baseOptions: https.RequestOptions = {
      method: 'GET',
      headers: { 'User-Agent': USER_AGENT, Accept: '*/*', ...headers },
      agent,
      timeout: CONNECT_TIMEOUT_MS,
    };
    const options: https.RequestOptions =
      parsed.protocol === 'http:'
        ? baseOptions
        : ({ ...baseOptions, enableUnsafeRenegotiation: ENABLE_UNSAFE_RENEGOTIATION } as https.RequestOptions & {
            enableUnsafeRenegotiation: boolean;
          });

    const request = transport.request(parsed, options, (response) => {
      const chunks: Buffer[] = [];
      let received = 0;
      response.setTimeout(READ_TIMEOUT_MS, () => {
        request.destroy();
        reject(
          new HttpFailure('timeout', `读取超时（已收 ${received} 字节）`, null, Buffer.concat(chunks)),
        );
      });
      response.on('data', (piece: Buffer) => {
        chunks.push(piece);
        received += piece.length;
      });
      response.on('end', () => {
        resolve({
          response: {
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          },
          partial: null,
        });
      });
      response.on('error', (error: Error) => {
        reject(new HttpFailure('network', error.message, null, Buffer.concat(chunks)));
      });
    });
    request.on('timeout', () => {
      request.destroy();
      reject(new HttpFailure('timeout', '连接超时', null, null));
    });
    request.on('error', (error: Error) => {
      reject(new HttpFailure('network', error.message, null, null));
    });
    request.end();
  });
}

async function getWithRetry(url: string, extraHeaders: Record<string, string> = {}): Promise<RawResponse> {
  let lastFailure: HttpFailure | null = null;
  let currentUrl = url;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    if (attempt > 0) {
      const base = lastFailure?.kind === 'network' || lastFailure?.kind === 'timeout'
        ? NETWORK_BACKOFF_BASE_MS
        : HTTP_BACKOFF_BASE_MS;
      const wait = base * 2 ** (attempt - 1);
      out(`  [重试 ${attempt}/${MAX_RETRIES}] ${lastFailure?.kind ?? 'unknown'}：等待 ${wait}ms`);
      await sleep(wait);
    }
    await sleep(randomDelay());
    try {
      const { response } = await requestOnce(currentUrl, extraHeaders);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = headerString(response.headers.location);
        if (location !== null && MAX_REDIRECTS > 0) {
          currentUrl = new URL(location, currentUrl).toString();
          out(`  [重定向] → ${currentUrl}`);
          continue;
        }
      }
      if (response.status >= 400) {
        lastFailure = new HttpFailure('http', `HTTP ${response.status}`, response.status, null);
        continue;
      }
      return response;
    } catch (error) {
      lastFailure = error instanceof HttpFailure ? error : new HttpFailure('network', String(error), null, null);
    }
  }
  throw lastFailure ?? new HttpFailure('network', '请求失败（原因未知）', null, null);
}

async function downloadText(url: string): Promise<DownloadResult> {
  const chunks: Buffer[] = [];
  let have = 0;
  let rounds = 0;
  let partialUsed = false;
  let expectedTotal: number | null = null;
  let attempts = 0;

  for (let round = 0; round < MAX_RESUME_ROUNDS; round += 1) {
    rounds = round + 1;
    attempts += 1;
    const headers: Record<string, string> = have > 0 ? { Range: `bytes=${have}-` } : {};
    try {
      const response = await getWithRetry(url, headers);
      if (response.status === 416) {
        out('  [续传] 416 Range Not Satisfiable → 视为已收满');
        break;
      }
      if (response.status === 200) {
        chunks.length = 0;
        chunks.push(response.body);
        have = response.body.length;
        const lengthHeader = headerString(response.headers['content-length']);
        expectedTotal = lengthHeader === null ? null : Number.parseInt(lengthHeader, 10) || null;
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

  return { buffer: Buffer.concat(chunks), totalBytes: have, contentLength: expectedTotal, partialUsed, rounds, attempts };
}

function findMarker(text: string, patterns: readonly RegExp[]): { index: number; line: string } | null {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match !== null && match.index >= 0) {
      const lineEnd = text.indexOf('\n', match.index);
      return { index: match.index, line: text.slice(match.index, lineEnd < 0 ? text.length : lineEnd).trim() };
    }
  }
  return null;
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

function validateAndExtract(raw: string, download: DownloadResult): { validation: TextValidation; body: string | null } {
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

interface ProbeMetrics {
  readonly source_id: string;
  readonly rdf_url: string;
  readonly text_url: string;
  readonly rdf_bytes: number;
  readonly rdf_download_ms: number;
  readonly text_download_ms: number;
  readonly file_bytes: number;
  readonly sha256_raw: string;
  readonly validation: TextValidation;
  readonly body_chars: number;
  readonly resumed: boolean;
  readonly resume_rounds: number;
  readonly http_attempts: number;
  readonly utf8_replacement_chars: number | null;
}

function countReplacementChars(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 0xfffd) count += 1;
  }
  return count;
}

async function probeOne(id: string, outDir: string): Promise<ProbeMetrics> {
  const rdfUrl = `https://www.gutenberg.org/cache/epub/${id}/pg${id}.rdf`;
  const textUrl = `https://www.gutenberg.org/files/${id}/${id}-0.txt`;

  out(`\n[${id}] 下载 RDF：${rdfUrl}`);
  const rdfStart = Date.now();
  const rdfResponse = await getWithRetry(rdfUrl);
  const rdfBytes = rdfResponse.body.length;
  const rdfMs = Date.now() - rdfStart;
  out(`  RDF ${rdfBytes} 字节，耗时 ${rdfMs} ms`);
  await fs.writeFile(path.join(outDir, `${id}.rdf`), rdfResponse.body);

  out(`[${id}] 下载正文：${textUrl}`);
  const textStart = Date.now();
  const download = await downloadText(textUrl);
  const textMs = Date.now() - textStart;
  const raw = download.buffer.toString('utf8');
  out(`  正文 ${download.totalBytes} 字节，耗时 ${textMs} ms（续传轮次 ${download.rounds}，partial=${download.partialUsed}）`);

  const sha256 = createHash('sha256').update(download.buffer).digest('hex');
  const { validation, body } = validateAndExtract(raw, download);
  out(`  SHA256 = ${sha256}`);
  out(`  校验 ok=${validation.ok}${validation.reason === null ? '' : ` 原因=${validation.reason}`}`);
  out(`  正文字符数（去标记后）= ${validation.body_chars}`);

  if (body === null) {
    throw new Error(`[${id}] 正文校验未通过，终止：${validation.reason ?? '未知原因'}`);
  }

  const record = {
    schema_version: 1,
    source_id: id,
    source_site: SOURCE_SITE,
    source_url: `https://www.gutenberg.org/ebooks/${id}`,
    text_url: textUrl,
    text_sha256: sha256,
    crawl_time: new Date().toISOString(),
    text_validation: validation,
    // --reparse 只需要 text（非空）与 toc_from_rdf；chapters 由 crawl-books.ts --reparse 离线补写
    toc_from_rdf: null,
    chapters: null,
    text: body,
    probe: true,
  };
  await fs.writeFile(path.join(outDir, `${id}.json`), `${JSON.stringify(record, null, 2)}\n`, 'utf8');

  return {
    source_id: id,
    rdf_url: rdfUrl,
    text_url: textUrl,
    rdf_bytes: rdfBytes,
    rdf_download_ms: rdfMs,
    text_download_ms: textMs,
    file_bytes: download.totalBytes,
    sha256_raw: sha256,
    validation,
    body_chars: validation.body_chars,
    resumed: download.partialUsed,
    resume_rounds: download.rounds,
    http_attempts: download.attempts,
    utf8_replacement_chars: countReplacementChars(body),
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let ids: string[] = [];
  let outDir = path.resolve(SERVER_ROOT, '.probe-cache');
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--ids') {
      const raw = argv[i + 1] ?? '';
      ids = raw.split(',').map((value) => value.trim()).filter((value) => value !== '');
      i += 1;
    } else if (argv[i] === '--out') {
      outDir = path.resolve(SERVER_ROOT, argv[i + 1] ?? '.probe-cache');
      i += 1;
    }
  }
  if (ids.length === 0) ids = ['1661', '564'];

  if (path.resolve(outDir) === path.resolve(SERVER_ROOT, '.crawl-cache')) {
    throw new Error('禁止写入正式抓取缓存目录 .crawl-cache/');
  }

  await fs.mkdir(outDir, { recursive: true });
  out('='.repeat(72));
  out('Stage C 前置探针 · 下载与校验（实验专用，不写数据库）');
  out(`ids=${ids.join(',')}  out=${outDir}`);
  out('='.repeat(72));

  out('\n[robots] 预热 + 留痕：' + ROBOTS_URL);
  try {
    const robots = await getWithRetry(ROBOTS_URL);
    const firstLine = robots.body.toString('utf8').split('\n').find((line) => line.trim() !== '') ?? '';
    out(`  HTTP ${robots.status}，${robots.body.length} 字节，首行：${firstLine.trim()}`);
  } catch (error) {
    out(`  ⚠️ robots 抓取失败：${error instanceof Error ? error.message : String(error)}`);
    out('  （robots 预热失败不阻断后续请求，但已如实记录）');
  }

  const metrics: ProbeMetrics[] = [];
  for (const id of ids) {
    metrics.push(await probeOne(id, outDir));
  }

  const summary = { generated_at: new Date().toISOString(), out_dir: outDir, books: metrics };
  await fs.writeFile(path.join(outDir, '_probe-download.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

  out('\n' + '='.repeat(72));
  for (const item of metrics) {
    out(
      `${item.source_id.padEnd(6)} 文件 ${String(item.file_bytes).padStart(9)} B  ` +
        `正文 ${String(item.body_chars).padStart(8)} 字符  下载 ${String(item.text_download_ms).padStart(6)} ms  ` +
        `校验 ${item.validation.ok ? 'OK' : 'FAIL'}`,
    );
  }
  out(`输出目录：${outDir}`);
  out('='.repeat(72));
}

void main()
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[probe] 失败：${message}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    httpsAgent.destroy();
    httpAgent.destroy();
  });
