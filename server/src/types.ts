// =============================================================================
// 全量类型定义：API / PaddleOCR / 领域模型
// 约定：外部输入一律 unknown，通过类型守卫收敛；本文件不出现 any。
// =============================================================================

// -----------------------------------------------------------------------------
// JSON 基础类型与守卫
// -----------------------------------------------------------------------------

export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

export interface JsonObject {
  [key: string]: JsonValue;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isJsonArray(value: JsonValue): value is JsonValue[] {
  return Array.isArray(value);
}

/** 把 unknown 收敛为 JsonValue；无法表达的（undefined / 函数 / Symbol）归为 null。 */
export function toJsonValue(value: unknown): JsonValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => toJsonValue(item));
  }
  if (isRecord(value)) {
    const out: JsonObject = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = toJsonValue(item);
    }
    return out;
  }
  return null;
}

/** unknown -> string（仅接受非空字符串）。 */
export function asString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '') return value;
  return null;
}

/** unknown -> string（接受空串，用于「显式为空」的场景）。 */
export function asStringAllowEmpty(value: unknown): string | null {
  if (typeof value === 'string') return value;
  return null;
}

/** unknown -> number（接受数字与数字字符串）。 */
export function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** unknown -> 数组（任意元素）。 */
export function asUnknownArray(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

/** unknown -> JsonValue[]。 */
export function asJsonArray(value: unknown): JsonValue[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => toJsonValue(item));
}

/** 从对象上读取字符串字段（深度路径）。 */
export function readString(source: unknown, ...path: string[]): string | null {
  let current: unknown = source;
  for (const key of path) {
    if (!isRecord(current)) return null;
    current = current[key];
  }
  return asString(current);
}

/** 从对象上读取数组字段（深度路径）。 */
export function readArray(source: unknown, ...path: string[]): unknown[] {
  let current: unknown = source;
  for (const key of path) {
    if (!isRecord(current)) return null as never;
    current = current[key];
  }
  return asUnknownArray(current);
}

// -----------------------------------------------------------------------------
// PaddleOCR 异步 API
// -----------------------------------------------------------------------------

export const PADDLE_DEFAULT_MODEL = 'PP-StructureV3';

/** 单文件上限（PaddleOCR 契约）。 */
export const PADDLE_MAX_FILE_BYTES = 50 * 1024 * 1024;
/** 单个 batchId 内文件数上限。 */
export const PADDLE_MAX_BATCH_FILES = 100;

/** 单次请求的批量上限（服务端自保阈值，<= PADDLE_MAX_BATCH_FILES）。 */
export const SERVER_MAX_BATCH_FILES = 20;

export type PaddleJobState = 'pending' | 'running' | 'done' | 'failed';

export interface PaddleJobSubmitResult {
  jobId: string;
  batchId: string | null;
  rawState: string | null;
}

export interface PaddleResultUrl {
  jsonUrl: string;
  imageUrl: string | null;
  markdownUrl: string | null;
}

export interface PaddleJobStatus {
  jobId: string;
  state: PaddleJobState;
  resultUrl: PaddleResultUrl | null;
  errorCode: number | null;
  errorMsg: string | null;
}

export interface PaddleSubmitInput {
  /** 原始文件字节 */
  buffer: Buffer;
  /** 上传给 Paddle 的文件名 */
  fileName: string;
  mimeType: string;
  model?: string;
  optionalPayload?: JsonObject;
  pageRanges?: string;
  batchId?: string;
}

export type PaddleErrorKind =
  | 'network'
  | 'timeout'
  | 'auth'
  | 'quota'
  | 'retryable'
  | 'server'
  | 'client'
  | 'protocol';

// -----------------------------------------------------------------------------
// OCR 归一化结构（adapter 的输出）
// -----------------------------------------------------------------------------

/** [x0, y0, x1, y1] */
export type BBox = readonly [number, number, number, number] | null;

export interface OcrBlock {
  text: string;
  /** 块标签：text / title / table / formula ... */
  label: string | null;
  bbox: BBox;
  /** 左缩进（像素），用于判定标题层级 */
  indent: number | null;
}

/** 一张表格：行 -> 单元格 */
export type OcrTable = string[][];

export interface OcrPage {
  /** 该页 markdown 全文 */
  markdown: string;
  /** 有序文本块 */
  blocks: OcrBlock[];
  /** markdown 表格（已解析成二维数组） */
  tables: OcrTable[];
  /** 纯识别文本列表（rec_texts 等） */
  texts: string[];
}

export function createEmptyOcrPage(): OcrPage {
  return { markdown: '', blocks: [], tables: [], texts: [] };
}

// -----------------------------------------------------------------------------
// ASR 音视频转字幕（Phase 1）
// -----------------------------------------------------------------------------

/** 单文件上限（服务端自保阈值，env ASR_MAX_FILE_BYTES 可调）。 */
export const ASR_MAX_FILE_BYTES = 100 * 1024 * 1024;
/** 任务在进程内的存活时长（2 小时）；过期后 410，墓碑再保留一个 TTL。 */
export const ASR_JOB_TTL_MS = 2 * 60 * 60 * 1_000;

export type AsrJobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface AsrJobError {
  code: string;
  message: string;
}

/** 归一化后的一个字幕段（秒，允许小数）。 */
export interface AsrTranscriptSegment {
  start: number;
  end: number;
  text: string;
}

/** 归一化后的转录结果（normalize.ts 的输出，JobStore 只存这个）。 */
export interface AsrTranscript {
  /** ISO 语言码；供应商未给出时为 'und'（未定），不臆造 */
  language: string;
  /** 秒；供应商未给出时由段落最大 end 推导 */
  duration: number;
  segments: AsrTranscriptSegment[];
}

export interface AsrSubmitResponse {
  jobId: string;
  status: AsrJobStatus;
  error: AsrJobError | null;
}

export interface AsrJobResponse {
  jobId: string;
  status: AsrJobStatus;
  /** done 时的转录结果；未完成 / 失败为 null */
  transcript: AsrTranscript | null;
  error: AsrJobError | null;
}

// -----------------------------------------------------------------------------
// AI 学习稿生成（Phase 2 M2：字幕 -> 结构化学习稿，OpenAI 兼容 LLM 流式）
// -----------------------------------------------------------------------------

/** 重点词汇：word/pos/gloss 三项为契约必需（pos 供前端本地词库精确命中）；context 由前端回匹 segments 时补，LLM 不产出。 */
export interface StudyNoteVocabulary {
  word: string;
  pos: string;
  gloss: string;
}

/** 双语解释一条：en 必须是字幕中出现过的原句（可截取完整分句），不得编造。 */
export interface StudyNoteBilingualNote {
  en: string;
  zh: string;
}

/** LLM 返回的学习稿四要素（summary 与双语解释拆开，四者独立可编辑）。 */
export interface StudyNotePayload {
  summary: string;
  bilingual_notes: StudyNoteBilingualNote[];
  key_points: string[];
  vocabulary: StudyNoteVocabulary[];
}

/** POST /api/ai/study-notes 请求体：直接复用 canonical transcript 结构。 */
export interface StudyNoteRequest {
  transcript: AsrTranscript;
}

/**
 * SSE 事件协议（POST /api/ai/study-notes，Content-Type: text/event-stream）：
 *   data: {"type":"delta","text":"..."}                                 逐字增量
 *   data: {"type":"done","note":{ summary, bilingual_notes, ... }}      完成
 *   data: {"type":"error","code":"timeout_first_token","message":"..."} 失败
 * 注：fetch + ReadableStream 消费（EventSource 只能 GET）；客户端断开时
 * 服务端 abort 上游，不再回 error 事件。
 */
export type StudyNoteEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; note: StudyNotePayload }
  | { type: 'error'; code: string; message: string };

// -----------------------------------------------------------------------------
// 解析规则（来自「使用说明」页，作用于同 source_book 的后续页）
// -----------------------------------------------------------------------------

export interface ParserRules {
  /** 词性缩写 -> 规范词性，例：{ "n.": "noun", "vt.": "verb.transitive" } */
  posAbbreviations: Record<string, string>;
  /** 符号 -> 语义标签，例：{ "★": "syllabus" } */
  symbols: Record<string, string>;
  /** 同义词前缀标记，例：["同义词", "syn."] */
  synonymMarkers: string[];
  /** 反义词前缀标记 */
  antonymMarkers: string[];
  /** 词根词缀前缀标记 */
  rootAffixMarkers: string[];
  /** 例句前缀标记 */
  exampleMarkers: string[];
  /** 短语前缀标记 */
  phraseMarkers: string[];
  /** 额外标签（整页生效） */
  globalTags: string[];
}

export const EMPTY_PARSER_RULES: ParserRules = {
  posAbbreviations: {},
  symbols: {},
  synonymMarkers: ['同义词', '近义词', 'syn.', 'syn:', 'synonyms', 'synonym'],
  antonymMarkers: ['反义词', 'ant.', 'ant:', 'antonyms', 'antonym'],
  rootAffixMarkers: ['词根', '词缀', '词根词缀', 'root', 'affix'],
  exampleMarkers: ['例', '例句', '例:', '例：', 'e.g.', 'eg.', 'example'],
  phraseMarkers: ['短语', '搭配', 'phrase', 'phr.'],
  globalTags: [],
};

// -----------------------------------------------------------------------------
// 领域草稿（parser 输出，repository 落库）
// -----------------------------------------------------------------------------

export interface EntryExample {
  en: string;
  zh: string | null;
}

export interface EntryPhrase {
  text: string;
  meaning: string | null;
}

/**
 * 义项：词典正文里一个词条下的「第 1 / 2 / 3 …」条释义。
 * 例句从属于它前面紧挨着的释义（纸质词典排版如此，解析按原文归属，不猜）。
 */
export interface EntrySense {
  definitionEn: string | null;
  definitionZh: string;
  examples: EntryExample[];
}

export interface EntryDraft {
  word: string;
  wordKey: string;
  phonetic: string | null;
  pos: string;
  posKey: string;
  definitionEn: string | null;
  definitionZh: string | null;
  /** 按义项分组的释义与例句（例句有多少收多少，归属不到任何义项时 senses 里不含它） */
  senses: EntrySense[];
  examples: EntryExample[];
  synonyms: string[];
  antonyms: string[];
  phrases: EntryPhrase[];
  tags: string[];
  rootAffix: string | null;
  sourcePage: number | null;
}

export interface TocDraft {
  title: string;
  /** 解析器内部临时键，用于在同一批内解析 parent_id */
  tempKey: string;
  parentTempKey: string | null;
  pageStart: number | null;
  pageEnd: number | null;
  level: number;
  orderIndex: number;
}

export type GrammarRuleType = 'irregular-verb' | 'irregular-noun' | 'irregular-adjective' | 'generic';

export interface GrammarRuleDraft {
  type: GrammarRuleType;
  baseForm: string;
  pastTense: string | null;
  pastParticiple: string | null;
  extra: JsonObject;
}

// -----------------------------------------------------------------------------
// 扫描记录
// -----------------------------------------------------------------------------

export type ScanPurpose = 'material' | 'dictionary';
/**
 * 'parsed' = OCR 与解析已完成、结构化草稿已暂存（parsed_drafts），
 * 等人工确认（npm run db:confirm）后才写 entries / toc / grammar_rules。
 * material 用途的扫描不走确认流程，完成即 'done'。
 */
export type ScanStatus = 'queued' | 'pending' | 'running' | 'parsed' | 'done' | 'failed';
export type PageKind = 'material' | 'toc' | 'entry' | 'table' | 'instruction' | 'unknown';

export interface StoredImage {
  /** 相对 OCR_STORAGE_DIR 的路径 */
  relativePath: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
}

export interface ScanRecord {
  id: string;
  batchId: string;
  jobId: string | null;
  sourceBook: string;
  purpose: ScanPurpose;
  pageKind: PageKind;
  status: ScanStatus;
  imagePath: string | null;
  imageName: string | null;
  mimeType: string | null;
  sizeBytes: number;
  pageNumber: number | null;
  resultText: string | null;
  parserRules: ParserRules | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

// -----------------------------------------------------------------------------
// 待确认草稿（解析完成、未入库）
// -----------------------------------------------------------------------------

/** 一条扫描记录解析出的全部结构化草稿；入库前暂存在 scan_records.parsed_drafts。 */
export interface ParsedDrafts {
  entries: EntryDraft[];
  toc: TocDraft[];
  grammar: GrammarRuleDraft[];
}

export function emptyParsedDrafts(): ParsedDrafts {
  return { entries: [], toc: [], grammar: [] };
}

/** unknown -> ParsedDrafts（逐字段守卫，坏数据静默丢弃而不是让确认脚本崩掉）。 */
export function parseParsedDrafts(value: unknown): ParsedDrafts {
  const out = emptyParsedDrafts();
  if (!isRecord(value)) return out;

  const entryList = asJsonArray(value['entries']);
  for (const raw of entryList) {
    if (!isRecord(raw)) continue;
    const word = asString(raw['word']);
    if (word === null) continue;
    const examples: EntryExample[] = [];
    for (const item of asJsonArray(raw['examples'])) {
      if (!isRecord(item)) continue;
      const en = asString(item['en']);
      if (en === null) continue;
      const zh = item['zh'];
      examples.push({ en, zh: typeof zh === 'string' && zh.trim() !== '' ? zh : null });
    }
    const senses: EntrySense[] = [];
    for (const item of asJsonArray(raw['senses'])) {
      if (!isRecord(item)) continue;
      const definitionZh = typeof item['definitionZh'] === 'string' ? item['definitionZh'] : '';
      const rawEn = item['definitionEn'];
      const senseExamples: EntryExample[] = [];
      for (const ex of asJsonArray(item['examples'])) {
        if (!isRecord(ex)) continue;
        const en = asString(ex['en']);
        if (en === null) continue;
        const zh = ex['zh'];
        senseExamples.push({ en, zh: typeof zh === 'string' && zh.trim() !== '' ? zh : null });
      }
      senses.push({
        definitionEn: typeof rawEn === 'string' && rawEn.trim() !== '' ? rawEn : null,
        definitionZh,
        examples: senseExamples,
      });
    }
    const phrases: EntryPhrase[] = [];
    for (const item of asJsonArray(raw['phrases'])) {
      if (!isRecord(item)) continue;
      const text = asString(item['text']);
      if (text === null) continue;
      const meaning = item['meaning'];
      phrases.push({ text, meaning: typeof meaning === 'string' && meaning.trim() !== '' ? meaning : null });
    }
    out.entries.push({
      word,
      wordKey: normalizeKeyOf(word),
      phonetic: asString(raw['phonetic']),
      pos: typeof raw['pos'] === 'string' ? raw['pos'] : '',
      posKey: normalizeKeyOf(typeof raw['pos'] === 'string' ? raw['pos'] : ''),
      definitionEn: asString(raw['definitionEn']),
      definitionZh: asString(raw['definitionZh']),
      senses,
      examples,
      synonyms: parseJsonStringArray(raw['synonyms']),
      antonyms: parseJsonStringArray(raw['antonyms']),
      phrases,
      tags: parseJsonStringArray(raw['tags']),
      rootAffix: asString(raw['rootAffix']),
      sourcePage: asNumber(raw['sourcePage']),
    });
  }

  const tocList = asJsonArray(value['toc']);
  for (const raw of tocList) {
    if (!isRecord(raw)) continue;
    const title = asString(raw['title']);
    if (title === null) continue;
    out.toc.push({
      title,
      tempKey: typeof raw['tempKey'] === 'string' ? raw['tempKey'] : title,
      parentTempKey: asString(raw['parentTempKey']),
      pageStart: asNumber(raw['pageStart']) ?? 0,
      pageEnd: asNumber(raw['pageEnd']),
      level: asNumber(raw['level']) ?? 0,
      orderIndex: asNumber(raw['orderIndex']) ?? 0,
    });
  }

  const grammarList = asJsonArray(value['grammar']);
  const grammarTypes: readonly GrammarRuleType[] = [
    'irregular-verb',
    'irregular-noun',
    'irregular-adjective',
    'generic',
  ];
  for (const raw of grammarList) {
    if (!isRecord(raw)) continue;
    const baseForm = asString(raw['baseForm']);
    if (baseForm === null) continue;
    const extra = toJsonValue(raw['extra']);
    const rawType = raw['type'];
    out.grammar.push({
      type: grammarTypes.find((t) => t === rawType) ?? 'generic',
      baseForm,
      pastTense: asString(raw['pastTense']),
      pastParticiple: asString(raw['pastParticiple']),
      extra: isJsonObject(extra) ? extra : {},
    });
  }

  return out;
}

function parseJsonStringArray(value: unknown): string[] {
  const out: string[] = [];
  for (const item of asJsonArray(value)) {
    const text = asString(item);
    if (text !== null) out.push(text);
  }
  return out;
}

/** 与 parsers/normalize.ts 的 normalizeKey 一致的本地实现（避免脚本层循环依赖 parser） */
function normalizeKeyOf(input: string): string {
  return input.trim().replace(/\s+/g, ' ').toLowerCase();
}

// -----------------------------------------------------------------------------
// API 请求 / 响应
// -----------------------------------------------------------------------------

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: JsonValue;
  };
}

export interface HealthResponse {
  status: 'ok' | 'degraded';
  service: string;
  time: string;
  database: 'ok' | 'error';
  paddleConfigured: boolean;
  translateConfigured: boolean;
  ocrPublicEnabled: boolean;
}

export interface SubmitScansResponse {
  batchId: string;
  count: number;
  scans: Array<{
    scanId: string;
    jobId: string | null;
    status: ScanStatus;
    imagePath: string | null;
    error: { code: string; message: string } | null;
  }>;
}

export interface JobStatusResponse {
  scanId: string;
  batchId: string;
  jobId: string | null;
  state: PaddleJobState | ScanStatus;
  status: ScanStatus;
  sourceBook: string;
  pageKind: PageKind;
  /** material 用途在 done 后返回识别文本 */
  text: string | null;
  /** dictionary 用途在 done 后返回入库摘要 */
  summary: ScanProcessSummary | null;
  error: { code: string; message: string } | null;
}

export interface ScanProcessSummary {
  pageKind: PageKind;
  entriesUpserted: number;
  tocUpserted: number;
  grammarUpserted: number;
  blocks: number;
  tables: number;
  parserRulesUpdated: boolean;
}

export interface BatchStatusResponse {
  batchId: string;
  total: number;
  byStatus: Record<ScanStatus, number>;
  processed: number;
  summary: ScanProcessSummary;
  scans: Array<{
    scanId: string;
    status: ScanStatus;
    text: string | null;
    error: { code: string; message: string } | null;
  }>;
}

export interface TranslateRequest {
  q: string;
  source: string;
  target: string;
}

export interface TranslateResponse {
  translatedText: string;
  source: string;
  target: string;
  detectedSource: string | null;
}

// -----------------------------------------------------------------------------
// 同步 / 检索
// -----------------------------------------------------------------------------

export interface SyncEntry {
  id: string;
  syncSeq: string;
  word: string;
  phonetic: string | null;
  pos: string;
  definitionEn: string;
  definitionZh: string;
  /** 义项分组（例句挂在自己所属的释义下；空数组 = 解析器未产出分组） */
  senses: EntrySense[];
  examples: EntryExample[];
  synonyms: string[];
  antonyms: string[];
  phrases: EntryPhrase[];
  tags: string[];
  rootAffix: string | null;
  sourcePage: number | null;
  sourceBook: string;
  updatedAt: string;
}

export interface SyncToc {
  id: string;
  syncSeq: string;
  sourceBook: string;
  title: string;
  parentId: string | null;
  pageStart: number;
  pageEnd: number | null;
  orderIndex: number;
  updatedAt: string;
}

export interface SyncGrammarRule {
  id: string;
  syncSeq: string;
  type: string;
  baseForm: string;
  pastTense: string | null;
  pastParticiple: string | null;
  extra: JsonObject;
  sourceBook: string;
  sourcePage: number | null;
  updatedAt: string;
}

export interface SyncResponse {
  since: string;
  nextSince: string;
  limit: number;
  truncated: boolean;
  entries: SyncEntry[];
  toc: SyncToc[];
  grammarRules: SyncGrammarRule[];
}

/** GET /api/dictionary/entries?word= 的响应：某词的全部扫描词条（含 senses/examples） */
export interface EntriesByWordResponse {
  word: string;
  entries: SyncEntry[];
}

export type SearchMatchKind = 'exact' | 'prefix' | 'fulltext' | 'fuzzy';

export interface SearchHit {
  id: string;
  word: string;
  phonetic: string | null;
  pos: string;
  definitionEn: string;
  definitionZh: string;
  matchKind: SearchMatchKind;
  score: number;
}

/** 内置词本引用（words.books 的元素；name 已在种子阶段解析，前端无需再映射） */
export interface WordBookRef {
  id: string;
  name: string;
}

/** 内置词库命中（words 表，/api/search 的 words 字段） */
export interface WordSearchHit {
  id: string;
  word: string;
  ipa: string | null;
  pos: string | null;
  definitionZh: string;
  books: WordBookRef[];
  matchKind: 'exact' | 'prefix' | 'contains' | 'zh';
}

export interface SearchResponse {
  query: string;
  limit: number;
  total: number;
  /** 词典扫描库（entries 表）命中 */
  hits: SearchHit[];
  /** 内置 5 本词库（words 表）命中；2026-10-06 起搜索为全局，与 hits 一次返回 */
  words: WordSearchHit[];
}

// -----------------------------------------------------------------------------
// 格式转换（复用 server/ 与现有 pg 连接池；转换引擎由 Python Worker 异步消费）
// -----------------------------------------------------------------------------

export type ConvertFormat = 'pdf' | 'docx' | 'png' | 'jpg' | 'xlsx';
export type ConvertTaskStatus = 'waiting' | 'processing' | 'success' | 'failed';

export interface ConvertUploadResponse {
  fileId: string;
  format: ConvertFormat;
  originalName: string;
  sizeBytes: number;
}

export interface ConvertCreateTaskResponse {
  taskId: string;
  status: ConvertTaskStatus;
}

export interface ConvertTaskStatusResponse {
  taskId: string;
  status: ConvertTaskStatus;
  progress: number;
  sourceFormat: ConvertFormat | null;
  targetFormat: ConvertFormat | null;
  errorMessage: string | null;
  /** 完成后可下载结果的文件 id（指向 convert_files 的一行） */
  resultFileId: string | null;
}

export interface ConvertHealthResponse {
  ok: boolean;
  engineEnabled: boolean;
}

/** 转换结果 OCR 成文章：逐页识别后按页码顺序拼接的文本 */
export interface ConvertOcrResponse {
  taskId: string;
  /** 按页码顺序拼接的识别文本（页间以空行分隔） */
  text: string;
  /** 实际识别的页数 */
  pages: number;
}
