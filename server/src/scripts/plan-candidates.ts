/**
 * plan-candidates.ts —— 批次 A 候选书单生成器（只读元数据，不抓正文）
 *
 * 为什么单独一个脚本：
 *   受控召回实验要把库从 10 本扩到 30 本，但用户明确要求「先提交候选清单，确认后再抓取」。
 *   crawl-books.ts 是「判定通过就顺手把正文下载下来」的一体化脚本，没有「只判定不下载」的模式。
 *   本脚本补上这个缺口：只做 榜单 → RDF 元数据 → 版权判定，绝不做下面任何一件事：
 *     - 不下载 pg<id>.txt 正文
 *     - 不写 server/.crawl-cache
 *     - 不连数据库、不写 discovered_books / discovered_book_chunks
 *     - 不生成任何 embedding
 *
 * 版权判定口径：与 crawl-books.ts 的「口径 A」逐条对齐（同一套规则、同一套阈值），
 *   并通过 --cross-check 用 Stage 1 已落地的 12 本（10 本入库 + 2 本被拒）反向验证一致性。
 *
 * 请求纪律（与 crawl-books.ts 一致）：
 *   - 先抓 robots.txt 预热并留下证据
 *   - 单请求串行，随机间隔 0.8~2.0s，全局 ≤30 req/min
 *   - 失败重试 3 次，指数退避
 *   - 真实浏览器 User-Agent，不用代理、不用多账号、不伪装搜索引擎
 *   - Node 访问 gutenberg.org 必须开 enableUnsafeRenegotiation（服务端要求 legacy TLS 重协商）
 *
 * 用法：
 *   cd server && npm run build
 *   node dist/src/scripts/plan-candidates.js --want 25 --max-scan 70
 *   node dist/src/scripts/plan-candidates.js --cross-check      # 校验解析口径与 Stage 1 一致
 */

import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';

// ---------------------------------------------------------------------------
// 常量与请求纪律
// ---------------------------------------------------------------------------

const SOURCE_SITE = 'gutenberg.org';
const LIST_URL = 'https://www.gutenberg.org/browse/scores/top';
const ROBOTS_URL = 'https://www.gutenberg.org/robots.txt';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const MIN_DELAY_MS = 800;
const MAX_DELAY_MS = 2_000;
const MAX_PER_MINUTE = 30;
const MAX_RETRIES = 3;
const CONNECT_TIMEOUT_MS = 10_000;
const READ_TIMEOUT_MS = 30_000;

const POLICY_LANGUAGE = 'en';
const POLICY_MAX_DEATH_YEAR = 1975;

/** 已入库的 10 本（Stage 1 产物），候选阶段直接跳过，不重复评估 */
const ALREADY_INGESTED: readonly string[] = [
  '1260', '1342', '1513', '1695', '1727', '2465', '2554', '2641', '3268', '59828',
];

interface Element {
  readonly opening: string;
  readonly content: string;
}

interface AgentInfo {
  readonly role: string;
  readonly name: string | null;
  readonly birthdate: number | null;
  readonly deathdate: number | null;
}

interface RdfParse {
  readonly title: string | null;
  readonly rights: string | null;
  readonly language: string | null;
  readonly issued: string | null;
  readonly authors: AgentInfo[];
  readonly contributors: AgentInfo[];
  /** 纯文本正文的字节数（取自 dcterms:extent，仅用于规模预估，不下载正文） */
  readonly txtBytes: number | null;
  readonly txtUrl: string | null;
}

type DecisionCode =
  | 'include'
  | 'language_not_en'
  | 'rights_not_public_domain_usa'
  | 'no_creator'
  | 'author_deathdate_missing'
  | 'contributor_deathdate_missing'
  | 'death_year_after_limit'
  | 'rdf_unavailable';

interface Decision {
  readonly decision: 'include' | 'skip';
  readonly code: DecisionCode;
  readonly detail: string;
  readonly maxDeathYear: number | null;
}

interface Evaluation {
  readonly id: string;
  readonly rank: number;
  readonly ebookUrl: string;
  readonly rdfUrl: string;
  readonly anchorTitle: string | null;
  readonly anchorAuthor: string | null;
  readonly title: string | null;
  readonly authors: AgentInfo[];
  readonly contributors: AgentInfo[];
  readonly rights: string | null;
  readonly language: string | null;
  readonly issued: string | null;
  readonly verdict: Decision;
  readonly uncertainties: string[];
  readonly note: string | null;
  /** 正文字节数与预估 chunk 数（只读 RDF 元数据，未下载正文） */
  readonly txtBytes: number | null;
  readonly estimatedChunks: number | null;
  readonly txtUrl: string | null;
}

// ---------------------------------------------------------------------------
// XML / HTML 小工具（与 crawl-books.ts 同实现，保证解析口径一致）
// ---------------------------------------------------------------------------

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

function iterateElements(xml: string, tag: string): Element[] {
  const results: Element[] = [];
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

function decodeEntities(input: string): string {
  return input
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');
}

interface Candidate {
  readonly id: string;
  readonly rank: number;
  readonly anchorTitle: string | null;
  readonly anchorAuthor: string | null;
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
    candidates.push({ id, rank: candidates.length + 1, anchorTitle: title, anchorAuthor: author });
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// RDF 解析（只取判定所需字段）
// ---------------------------------------------------------------------------

function parseAgentBlock(block: string, role: string): AgentInfo | null {
  const agent = iterateElements(block, 'pgterms:agent')[0];
  if (agent === undefined) return null;
  const rawBirth = textOfTag(agent.content, 'pgterms:birthdate');
  const rawDeath = textOfTag(agent.content, 'pgterms:deathdate');
  const birth = rawBirth === null ? null : Number.parseInt(rawBirth, 10);
  const death = rawDeath === null ? null : Number.parseInt(rawDeath, 10);
  return {
    role,
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

  const languageBlock = iterateElements(ebook, 'dcterms:language')[0]?.content ?? null;

  // 正文纯文本体积：只用于规模预估（chunk 数、索引大小、耗时），本脚本绝不下载正文
  let txtBytes: number | null = null;
  let txtUrl: string | null = null;
  for (const element of iterateElements(ebook, 'pgterms:file')) {
    const about = attrOf(element.opening, 'rdf:about') ?? '';
    if (!about.endsWith('.txt')) continue;
    const extent = textOfTag(element.content, 'dcterms:extent');
    const bytes = extent === null ? null : Number.parseInt(extent, 10);
    if (bytes !== null && Number.isFinite(bytes)) {
      txtBytes = bytes;
      txtUrl = about;
      break;
    }
  }

  return {
    title: textOfTag(ebook, 'dcterms:title'),
    rights: textOfTag(ebook, 'dcterms:rights'),
    language: languageBlock === null ? null : textOfTag(languageBlock, 'rdf:value'),
    issued: textOfTag(ebook, 'dcterms:issued'),
    authors,
    contributors,
    txtBytes,
    txtUrl,
  };
}

/** Stage 1 实测：10 本正文合计约 8.3MB → 24,244 chunk，平均每 chunk ≈ 342 字节 */
const BYTES_PER_CHUNK = 342;

function estimateChunks(bytes: number | null): number | null {
  if (bytes === null) return null;
  return Math.round(bytes / BYTES_PER_CHUNK);
}

// ---------------------------------------------------------------------------
// 版权判定：口径 A（与 crawl-books.ts 逐条一致）
// ---------------------------------------------------------------------------

function decideCopyright(parsed: RdfParse): Decision {
  const deaths = parsed.authors.map((author) => author.deathdate);
  const contributorDeaths = parsed.contributors.map((person) => person.deathdate);
  const allKnown = [...deaths, ...contributorDeaths].filter((year): year is number => year !== null);
  const maxDeath = allKnown.length === 0 ? null : Math.max(...allKnown);
  const rightsText = parsed.rights ?? '';

  if (parsed.language !== POLICY_LANGUAGE) {
    return {
      decision: 'skip',
      code: 'language_not_en',
      detail: `dcterms:language = ${parsed.language ?? 'null'}，要求 ${POLICY_LANGUAGE}`,
      maxDeathYear: maxDeath,
    };
  }
  if (!/Public domain in the USA/i.test(rightsText)) {
    return {
      decision: 'skip',
      code: 'rights_not_public_domain_usa',
      detail: `dcterms:rights = ${parsed.rights ?? 'null'}`,
      maxDeathYear: maxDeath,
    };
  }
  if (parsed.authors.length === 0) {
    return {
      decision: 'skip',
      code: 'no_creator',
      detail: 'RDF 中没有 dcterms:creator，作者不可确认，不推断',
      maxDeathYear: maxDeath,
    };
  }
  const missingAuthorDeath = parsed.authors.filter((author) => author.deathdate === null);
  if (missingAuthorDeath.length > 0) {
    return {
      decision: 'skip',
      code: 'author_deathdate_missing',
      detail: `缺失卒年的作者：${missingAuthorDeath.map((a) => a.name ?? '(未具名)').join('; ')}`,
      maxDeathYear: maxDeath,
    };
  }
  const missingContributor = parsed.contributors.filter((person) => person.deathdate === null);
  if (missingContributor.length > 0) {
    return {
      decision: 'skip',
      code: 'contributor_deathdate_missing',
      detail: `缺失卒年的贡献者（${missingContributor.map((p) => p.role).join(',')}）：${missingContributor
        .map((p) => p.name ?? '(未具名)')
        .join('; ')}`,
      maxDeathYear: maxDeath,
    };
  }
  if (maxDeath !== null && maxDeath > POLICY_MAX_DEATH_YEAR) {
    return {
      decision: 'skip',
      code: 'death_year_after_limit',
      detail: `最大卒年 ${maxDeath} > ${POLICY_MAX_DEATH_YEAR}`,
      maxDeathYear: maxDeath,
    };
  }
  return {
    decision: 'include',
    code: 'include',
    detail: `language=${parsed.language}；rights 含 Public domain in the USA；最大卒年 ${maxDeath ?? 'n/a'} ≤ ${POLICY_MAX_DEATH_YEAR}`,
    maxDeathYear: maxDeath,
  };
}

// ---------------------------------------------------------------------------
// 不确定项：不改写判定结果，只把「需要人工复核」的地方如实标出来
// ---------------------------------------------------------------------------

function collectUncertainties(parsed: RdfParse, verdict: Decision): string[] {
  const notes: string[] = [];
  const title = parsed.title ?? '';

  if (parsed.authors.length > 1) {
    notes.push(`多位 dcterms:creator（${parsed.authors.length} 位，可能合集/合著），需逐一核验卒年`);
  }
  if (parsed.contributors.length > 0) {
    const roles = parsed.contributors.map((person) => person.role.replace('marcrel:', '')).join(',');
    notes.push(`存在 marcrel 贡献者（${roles}），译本/改编者卒年同样参与判定`);
  }
  if (verdict.maxDeathYear !== null && verdict.maxDeathYear >= 1950) {
    notes.push(
      `最大卒年 ${verdict.maxDeathYear} 距阈值 ${POLICY_MAX_DEATH_YEAR} 较近：美国已公有领域，中国 life+50 需复核到期日（卒于该年则保护至 ${verdict.maxDeathYear + 50}-12-31）`,
    );
  }
  const rights = parsed.rights ?? '';
  if (rights !== '' && !/^Public domain in the USA\.?$/i.test(rights.trim())) {
    notes.push(`rights 文本非标准表述：「${rights}」，需人工确认是否等同 PD-USA`);
  }
  if (/complete works|anthology|collection|selected |omnibus/i.test(title)) {
    notes.push('标题含合集特征词，可能收录他人作品，各篇权利需单列核验');
  }
  if (parsed.issued === null) {
    notes.push('RDF 无 dcterms:issued，出版年不可确认');
  }
  if (parsed.authors.some((author) => author.birthdate === null)) {
    notes.push('至少一位作者缺生年，无法交叉校验卒年是否为录入错误');
  }
  return notes;
}

// ---------------------------------------------------------------------------
// HTTP：串行 + 限流 + 重试 + TLS 重协商
// ---------------------------------------------------------------------------

type HttpsAgentOptions = https.AgentOptions & { enableUnsafeRenegotiation: boolean };

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 2,
  ...({ enableUnsafeRenegotiation: true } as HttpsAgentOptions),
});

interface FetchResult {
  readonly ok: boolean;
  readonly status: number | null;
  readonly body: string;
  readonly error: string | null;
  readonly retries: number;
}

const requestWindow: number[] = [];

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function pace(): Promise<void> {
  const now = Date.now();
  while (requestWindow.length > 0 && now - (requestWindow[0] ?? now) > 60_000) {
    requestWindow.shift();
  }
  if (requestWindow.length >= MAX_PER_MINUTE) {
    const waitFor = 60_000 - (now - (requestWindow[0] ?? now)) + 50;
    await sleep(Math.max(waitFor, 1_000));
    requestWindow.shift();
  }
  const gap = MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS);
  await sleep(gap);
}

function getOnce(url: string): Promise<FetchResult> {
  return new Promise((resolve) => {
    const request = https.request(
      url,
      { agent: httpsAgent, headers: { 'User-Agent': USER_AGENT, Accept: '*/*' } },
      (response) => {
        const chunks: Buffer[] = [];
        let settled = false;
        const finish = (result: FetchResult): void => {
          if (settled) return;
          settled = true;
          resolve(result);
        };
        response.setTimeout(READ_TIMEOUT_MS, () => {
          request.destroy(new Error('read timeout'));
          finish({ ok: false, status: null, body: '', error: 'read-timeout', retries: 0 });
        });
        response.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        response.on('end', () => {
          const status = response.statusCode ?? 0;
          finish({
            ok: status >= 200 && status < 300,
            status,
            body: Buffer.concat(chunks).toString('utf8'),
            error: null,
            retries: 0,
          });
        });
        response.on('error', (error: Error) => {
          finish({ ok: false, status: null, body: '', error: `network: ${error.message}`, retries: 0 });
        });
      },
    );
    request.setTimeout(CONNECT_TIMEOUT_MS, () => {
      request.destroy(new Error('connect timeout'));
    });
    request.on('error', (error: Error) => {
      resolve({ ok: false, status: null, body: '', error: `network: ${error.message}`, retries: 0 });
    });
    request.end();
  });
}

async function getWithRetry(url: string): Promise<FetchResult> {
  let last: FetchResult = { ok: false, status: null, body: '', error: 'not attempted', retries: 0 };
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    if (attempt > 0) {
      await sleep(Math.min(2 ** attempt * 1_000, 20_000));
    }
    await pace();
    requestWindow.push(Date.now());
    const result = await getOnce(url);
    last = { ...result, retries: attempt };
    if (result.ok) return last;
    if (result.status !== null && result.status >= 400 && result.status < 500 && result.status !== 429) {
      return last;
    }
    if (result.status === 429 || result.status === 503) {
      await sleep(10_000);
    }
  }
  return last;
}

// ---------------------------------------------------------------------------
// 评估
// ---------------------------------------------------------------------------

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function evaluate(id: string, rank: number, anchor: Candidate | null, rdfText: string | null, rdfError: string | null): Evaluation {
  const ebookUrl = `https://www.gutenberg.org/ebooks/${id}`;
  const rdfUrl = `https://www.gutenberg.org/cache/epub/${id}/pg${id}.rdf`;
  if (rdfText === null) {
    return {
      id,
      rank,
      ebookUrl,
      rdfUrl,
      anchorTitle: anchor?.anchorTitle ?? null,
      anchorAuthor: anchor?.anchorAuthor ?? null,
      title: null,
      authors: [],
      contributors: [],
      rights: null,
      language: null,
      issued: null,
      verdict: {
        decision: 'skip',
        code: 'rdf_unavailable',
        detail: rdfError ?? 'RDF 不可用',
        maxDeathYear: null,
      },
      uncertainties: ['RDF 未取到，版权状态不可确认，按「不确定即停」处理，不入库'],
      note: null,
      txtBytes: null,
      estimatedChunks: null,
      txtUrl: null,
    };
  }
  const parsed = parseRdf(rdfText);
  const verdict = decideCopyright(parsed);
  const uncertainties = collectUncertainties(parsed, verdict);
  const already = ALREADY_INGESTED.includes(id);
  return {
    id,
    rank,
    ebookUrl,
    rdfUrl,
    anchorTitle: anchor?.anchorTitle ?? null,
    anchorAuthor: anchor?.anchorAuthor ?? null,
    title: parsed.title,
    authors: parsed.authors,
    contributors: parsed.contributors,
    rights: parsed.rights,
    language: parsed.language,
    issued: parsed.issued,
    verdict,
    uncertainties,
    note: already ? 'Stage 1 已入库，本轮不重复评估' : null,
    txtBytes: parsed.txtBytes,
    estimatedChunks: estimateChunks(parsed.txtBytes),
    txtUrl: parsed.txtUrl,
  };
}

function formatAuthors(authors: AgentInfo[]): string {
  if (authors.length === 0) return '(RDF 无 creator)';
  return authors.map((a) => `${a.name ?? '(未具名)'} (${a.birthdate ?? '?'}–${a.deathdate ?? '?'})`).join(' / ');
}

interface CliOptions {
  want: number;
  maxScan: number;
  crossCheck: boolean;
  outFile: string;
}

function parseArgs(argv: readonly string[]): CliOptions {
  let want = 25;
  let maxScan = 70;
  let crossCheck = false;
  let outFile = '.candidate-plan.json';
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--want') want = Number.parseInt(argv[i + 1] ?? '', 10) || want;
    else if (arg === '--max-scan') maxScan = Number.parseInt(argv[i + 1] ?? '', 10) || maxScan;
    else if (arg === '--out') outFile = argv[i + 1] ?? outFile;
    else if (arg === '--cross-check') crossCheck = true;
    i += arg === '--want' || arg === '--max-scan' || arg === '--out' ? 1 : 0;
  }
  return { want, maxScan, crossCheck, outFile };
}

async function crossCheck(): Promise<void> {
  out('='.repeat(78));
  out('口径一致性交叉验证：用 Stage 1 已落地的 12 本反向校验本脚本的解析与判定');
  out('  期望：10 本 include（已入库） + 2 本 skip（65238 卒年 1976 / 62215 语言 fr）');
  out('='.repeat(78));
  const expected: Record<string, 'include' | 'skip'> = {};
  for (const id of ALREADY_INGESTED) expected[id] = 'include';
  expected['65238'] = 'skip';
  expected['62215'] = 'skip';

  let pass = 0;
  let fail = 0;
  for (const [id, expect] of Object.entries(expected)) {
    const result = await getWithRetry(`https://www.gutenberg.org/cache/epub/${id}/pg${id}.rdf`);
    if (!result.ok) {
      out(`  ? ${id.padEnd(6)} RDF 取不到（${result.error}）—— 无法验证，不计入通过`);
      continue;
    }
    const evaluation = evaluate(id, 0, null, result.body, null);
    const ok = evaluation.verdict.decision === expect;
    if (ok) pass += 1;
    else fail += 1;
    out(
      `  ${ok ? '✓' : '✗'} ${id.padEnd(6)} 期望=${expect.padEnd(7)} 实际=${evaluation.verdict.decision.padEnd(7)} ` +
        `${evaluation.verdict.code}  maxDeath=${evaluation.verdict.maxDeathYear ?? 'n/a'}  ${evaluation.title ?? ''}`.slice(0, 150),
    );
  }
  out(`\n交叉验证结果：通过 ${pass}，不符 ${fail}`);
  out(fail === 0 ? '判定口径与 Stage 1 一致，可用于生成候选清单。' : '存在不一致，禁止用本脚本出候选清单。');
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.crossCheck) {
    await crossCheck();
    httpsAgent.destroy();
    return;
  }

  out('='.repeat(78));
  out(`批次 A 候选书单生成器   数据源=${SOURCE_SITE}`);
  out(`目标：新增 ${options.want} 本通过判定（最多扫描榜单前 ${options.maxScan} 个条目）`);
  out(`版权口径 A：language=${POLICY_LANGUAGE}；所有作者/贡献者卒年真实存在且 ≤${POLICY_MAX_DEATH_YEAR}`);
  out('本脚本只读元数据：不下载正文、不写 .crawl-cache、不连数据库、不生成 embedding');
  out('='.repeat(78));

  out(`\n[1/3] robots.txt ${ROBOTS_URL}`);
  const robots = await getWithRetry(ROBOTS_URL);
  out(robots.ok ? `  HTTP ${robots.status ?? '?'}，${robots.body.length} 字节` : `  未能取到：${robots.error}`);
  const disallow = robots.ok
    ? robots.body
        .split(/\r?\n/)
        .filter((line) => /^\s*Disallow:/i.test(line))
        .map((line) => line.trim())
    : [];
  out(`  Disallow 条目：${disallow.length === 0 ? '(无)' : disallow.join(' | ')}`);
  out(`  本脚本只访问 /browse/scores/top 与 /cache/epub/<id>/pg<id>.rdf，均不在 Disallow 内`);

  out(`\n[2/3] 榜单 ${LIST_URL}`);
  const list = await getWithRetry(LIST_URL);
  if (!list.ok) {
    out(`榜单拉取失败（${list.error}），终止。`);
    httpsAgent.destroy();
    return;
  }
  const candidates = parseTopList(list.body);
  out(`  去重后 ${candidates.length} 个书目，已入库 10 本将跳过`);

  out('\n[3/3] 逐个读取 RDF 并判定');
  const evaluations: Evaluation[] = [];
  let included = 0;
  let scanned = 0;
  let rdfFailures = 0;

  for (const candidate of candidates.slice(0, options.maxScan)) {
    if (ALREADY_INGESTED.includes(candidate.id)) {
      out(`  - #${candidate.rank} ${candidate.id} 已入库，跳过`);
      continue;
    }
    if (included >= options.want) break;
    scanned += 1;
    const rdf = await getWithRetry(`https://www.gutenberg.org/cache/epub/${candidate.id}/pg${candidate.id}.rdf`);
    const evaluation = evaluate(
      candidate.id,
      candidate.rank,
      candidate,
      rdf.ok ? rdf.body : null,
      rdf.ok ? null : (rdf.error ?? '未知错误'),
    );
    evaluations.push(evaluation);
    if (!rdf.ok) rdfFailures += 1;
    if (evaluation.verdict.decision === 'include') included += 1;
    const mark = evaluation.verdict.decision === 'include' ? '✓' : '✗';
    const size =
      evaluation.estimatedChunks === null
        ? '   ? chunk'
        : `${String(evaluation.estimatedChunks).padStart(6)} chunk`;
    out(
      `  ${mark} #${String(candidate.rank).padStart(3)} ${candidate.id.padEnd(6)} ` +
        `${(evaluation.title ?? evaluation.anchorTitle ?? '(无标题)').slice(0, 38).padEnd(38)} ` +
        `${formatAuthors(evaluation.authors).slice(0, 32).padEnd(32)} ` +
        `${size}  ${evaluation.verdict.code}${evaluation.uncertainties.length > 0 ? `  ⚠${evaluation.uncertainties.length}` : ''}`,
    );
  }

  const payload = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    source: { site: SOURCE_SITE, list_url: LIST_URL, robots_url: ROBOTS_URL },
    policy: {
      name: 'A',
      require_language: POLICY_LANGUAGE,
      max_author_death_year: POLICY_MAX_DEATH_YEAR,
      note: '与 crawl-books.ts 口径 A 逐条一致；美国 PD 不等于其他司法辖区 PD，中国按 life+50 复核',
    },
    counts: { scanned, included, rdf_failures: rdfFailures, evaluated: evaluations.length },
    already_ingested: ALREADY_INGESTED,
    evaluations,
  };
  const target = path.resolve(process.cwd(), options.outFile);
  fs.writeFileSync(target, JSON.stringify(payload, null, 2), 'utf8');

  const estimatedChunks = evaluations
    .filter((item) => item.verdict.decision === 'include')
    .reduce((sum, item) => sum + (item.estimatedChunks ?? 0), 0);
  const currentChunks = 24_244;
  const bytesPerIndexRow = (189 * 1024 * 1024) / currentChunks;

  out('\n' + '='.repeat(78));
  out(`扫描 ${scanned} 本，通过 ${included} 本，RDF 取不到 ${rdfFailures} 本`);
  out(`规模预估（按 Stage 1 实测 342 字节/chunk 外推，未下载正文，属估算不是实测）：`);
  out(`  新增 chunk ≈ ${estimatedChunks.toLocaleString('en-US')}`);
  out(`  合计 chunk ≈ ${(currentChunks + estimatedChunks).toLocaleString('en-US')}（现有 ${currentChunks.toLocaleString('en-US')}）`);
  out(`  主表 HNSW 索引 ≈ ${Math.round(((currentChunks + estimatedChunks) * bytesPerIndexRow) / 1024 / 1024)} MB（现有 189MB，按 7.8KB/chunk 外推）`);
  out(`明细已写入：${target}`);
  out('='.repeat(78));
  httpsAgent.destroy();
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  httpsAgent.destroy();
  process.exitCode = 1;
});
