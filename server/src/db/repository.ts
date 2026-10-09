// =============================================================================
// 仓储层：全部使用 pg 参数化 SQL（不使用 ORM）
//
// 合并策略（由 SQL 侧辅助函数实现）：
//   · phonetic / definition_en / definition_zh / root_affix：仅补空，不覆盖
//   · examples / phrases / synonyms / antonyms / tags：去重合并
//   · toc / grammar_rules 同理
// =============================================================================

import type { Pool, PoolClient } from 'pg';
import { withTransaction } from './pool';
import {
  EMPTY_PARSER_RULES,
  type EntryDraft,
  type EntryExample,
  type EntryPhrase,
  type EntrySense,
  type GrammarRuleDraft,
  type JsonObject,
  type PageKind,
  type ParsedDrafts,
  type ParserRules,
  type ScanPurpose,
  type ScanStatus,
  type SearchHit,
  type SearchMatchKind,
  type SearchResponse,
  type SyncEntry,
  type SyncGrammarRule,
  type SyncResponse,
  type SyncToc,
  type TocDraft,
  type WordBookRef,
  type WordSearchHit,
  asString,
  isRecord,
  toJsonValue,
} from '../types';

// -----------------------------------------------------------------------------
// 行类型
// -----------------------------------------------------------------------------

export interface ScanRow {
  id: string;
  batch_id: string;
  job_id: string | null;
  source_book: string;
  purpose: ScanPurpose;
  page_kind: PageKind;
  status: ScanStatus;
  image_path: string | null;
  image_name: string | null;
  mime_type: string | null;
  size_bytes: number;
  page_number: number | null;
  result_text: string | null;
  raw_ocr_json: unknown;
  parser_rules: unknown;
  parsed_drafts: unknown;
  error_code: string | null;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
}

interface EntryRow {
  id: string;
  sync_seq: string;
  word: string;
  phonetic: string | null;
  pos: string;
  definition_en: string;
  definition_zh: string;
  senses: unknown;
  examples: unknown;
  synonyms: string[] | null;
  antonyms: string[] | null;
  phrases: unknown;
  tags: string[] | null;
  root_affix: string | null;
  source_page: number | null;
  source_book: string;
  updated_at: Date;
}

interface TocRow {
  id: string;
  sync_seq: string;
  source_book: string;
  title: string;
  parent_id: string | null;
  page_start: number;
  page_end: number | null;
  order_index: number;
  updated_at: Date;
}

interface GrammarRow {
  id: string;
  sync_seq: string;
  type: string;
  base_form: string;
  past_tense: string | null;
  past_participle: string | null;
  extra: unknown;
  source_book: string;
  source_page: number | null;
  updated_at: Date;
}

interface SearchRow {
  id: string;
  word: string;
  phonetic: string | null;
  pos: string;
  definition_en: string;
  definition_zh: string;
  match_kind: string;
  score: string | number;
}

// -----------------------------------------------------------------------------
// 纯函数：unknown -> 领域类型
// -----------------------------------------------------------------------------

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const text = asString(item);
    if (text !== null) out.push(text);
  }
  return out;
}

function parseExamples(value: unknown): EntryExample[] {
  if (!Array.isArray(value)) return [];
  const out: EntryExample[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const en = asString(item['en']);
    if (en === null) continue;
    const rawZh = item['zh'];
    out.push({ en, zh: typeof rawZh === 'string' && rawZh.trim() !== '' ? rawZh : null });
  }
  return out;
}

function parsePhrases(value: unknown): EntryPhrase[] {
  if (!Array.isArray(value)) return [];
  const out: EntryPhrase[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const text = asString(item['text']);
    if (text === null) continue;
    const rawMeaning = item['meaning'];
    out.push({ text, meaning: typeof rawMeaning === 'string' && rawMeaning.trim() !== '' ? rawMeaning : null });
  }
  return out;
}

/** unknown -> EntrySense[]（逐条守卫，坏数据丢弃；DB 里的 jsonb 一律不可信）。 */
function parseSenses(value: unknown): EntrySense[] {
  if (!Array.isArray(value)) return [];
  const out: EntrySense[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const rawZh = item['definitionZh'];
    if (typeof rawZh !== 'string' || rawZh.trim() === '') continue; // 无释义的义项没有展示价值
    const rawEn = item['definitionEn'];
    const examples: EntryExample[] = [];
    for (const rawEx of Array.isArray(item['examples']) ? item['examples'] : []) {
      if (!isRecord(rawEx)) continue;
      const en = asString(rawEx['en']);
      if (en === null) continue;
      const zh = rawEx['zh'];
      examples.push({ en, zh: typeof zh === 'string' && zh.trim() !== '' ? zh : null });
    }
    out.push({
      definitionEn: typeof rawEn === 'string' && rawEn.trim() !== '' ? rawEn : null,
      definitionZh: rawZh,
      examples,
    });
  }
  return out;
}

function parseStringMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(value)) return out;
  for (const [key, item] of Object.entries(value)) {
    const text = asString(item);
    if (text !== null) out[key] = text;
  }
  return out;
}

export function parseParserRules(value: unknown): ParserRules {
  if (!isRecord(value)) return { ...EMPTY_PARSER_RULES };
  return {
    posAbbreviations: parseStringMap(value['posAbbreviations']),
    symbols: parseStringMap(value['symbols']),
    synonymMarkers: parseStringArray(value['synonymMarkers']),
    antonymMarkers: parseStringArray(value['antonymMarkers']),
    rootAffixMarkers: parseStringArray(value['rootAffixMarkers']),
    exampleMarkers: parseStringArray(value['exampleMarkers']),
    phraseMarkers: parseStringArray(value['phraseMarkers']),
    globalTags: parseStringArray(value['globalTags']),
  };
}

function toJsonObject(value: unknown): JsonObject {
  const converted = toJsonValue(value);
  if (typeof converted === 'object' && converted !== null && !Array.isArray(converted)) return converted;
  return {};
}

/** 语法规则草稿的页码可能写在 extra.sourcePage 里（表格解析器会写入）。 */
function extraSourcePage(extra: JsonObject): number | null {
  const raw = extra['sourcePage'];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

function rowToSyncEntry(row: EntryRow): SyncEntry {
  return {
    id: row.id,
    syncSeq: row.sync_seq,
    word: row.word,
    phonetic: row.phonetic,
    pos: row.pos,
    definitionEn: row.definition_en,
    definitionZh: row.definition_zh,
    senses: parseSenses(row.senses),
    examples: parseExamples(row.examples),
    synonyms: parseStringArray(row.synonyms),
    antonyms: parseStringArray(row.antonyms),
    phrases: parsePhrases(row.phrases),
    tags: parseStringArray(row.tags),
    rootAffix: row.root_affix,
    sourcePage: row.source_page,
    sourceBook: row.source_book,
    updatedAt: row.updated_at.toISOString(),
  };
}

const SEARCH_KINDS: readonly SearchMatchKind[] = ['exact', 'prefix', 'fulltext', 'fuzzy'];

function toMatchKind(value: string): SearchMatchKind {
  const found = SEARCH_KINDS.find((kind) => kind === value);
  return found ?? 'fuzzy';
}

const WORD_MATCH_KINDS = ['exact', 'prefix', 'contains', 'zh'] as const;

function toWordMatchKind(value: string): (typeof WORD_MATCH_KINDS)[number] {
  const found = WORD_MATCH_KINDS.find((kind) => kind === value);
  return found ?? 'zh';
}

/** words.books jsonb -> WordBookRef[]；脏数据丢弃不崩（元素缺 id 的整条跳过）。 */
function parseWordBooks(value: unknown): WordBookRef[] {
  if (!Array.isArray(value)) return [];
  const out: WordBookRef[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const id = asString(item['id']);
    if (id === null) continue;
    const name = asString(item['name']) ?? id;
    out.push({ id, name });
  }
  return out;
}

// -----------------------------------------------------------------------------
// 仓储实现
// -----------------------------------------------------------------------------

export interface ScanInsertInput {
  batchId: string;
  sourceBook: string;
  purpose: ScanPurpose;
  pageKind: PageKind;
  imagePath: string;
  imageName: string;
  mimeType: string;
  sizeBytes: number;
  pageNumber: number | null;
}

export interface ScanCompletionInput {
  resultText: string;
  rawOcrJson: unknown;
  parserRules: ParserRules | null;
}

export class DictionaryRepository {
  constructor(private readonly pool: Pool) {}

  async healthCheck(): Promise<boolean> {
    try {
      const result = await this.pool.query('SELECT 1 AS ok');
      return result.rowCount === 1;
    } catch {
      return false;
    }
  }

  async insertScan(input: ScanInsertInput): Promise<string> {
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO scan_records
         (batch_id, source_book, purpose, page_kind, status, image_path, image_name, mime_type, size_bytes, page_number)
       VALUES ($1, $2, $3, $4, 'queued', $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        input.batchId,
        input.sourceBook,
        input.purpose,
        input.pageKind,
        input.imagePath,
        input.imageName,
        input.mimeType,
        input.sizeBytes,
        input.pageNumber,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('插入扫描记录失败：未返回 id');
    return row.id;
  }

  async markScanSubmitted(scanId: string, jobId: string): Promise<void> {
    await this.pool.query(
      `UPDATE scan_records SET job_id = $2, status = 'pending', error_code = NULL, error_message = NULL, updated_at = now()
       WHERE id = $1`,
      [scanId, jobId],
    );
  }

  async markScanStatus(scanId: string, status: ScanStatus): Promise<void> {
    await this.pool.query(`UPDATE scan_records SET status = $2, updated_at = now() WHERE id = $1`, [scanId, status]);
  }

  async markScanFailed(scanId: string, code: string, message: string): Promise<void> {
    await this.pool.query(
      `UPDATE scan_records SET status = 'failed', error_code = $2, error_message = $3, updated_at = now() WHERE id = $1`,
      [scanId, code, message.slice(0, 500)],
    );
  }

  async completeScan(scanId: string, input: ScanCompletionInput): Promise<void> {
    await this.pool.query(
      `UPDATE scan_records
          SET status = 'done',
              result_text = $2,
              raw_ocr_json = $3::jsonb,
              parser_rules = COALESCE($4::jsonb, parser_rules),
              error_code = NULL,
              error_message = NULL,
              updated_at = now()
        WHERE id = $1`,
      [
        scanId,
        input.resultText,
        JSON.stringify(toJsonValue(input.rawOcrJson)),
        input.parserRules === null ? null : JSON.stringify(input.parserRules),
      ],
    );
  }

  async saveParserRules(scanId: string, rules: ParserRules): Promise<void> {
    await this.pool.query(`UPDATE scan_records SET parser_rules = $2::jsonb, updated_at = now() WHERE id = $1`, [
      scanId,
      JSON.stringify(rules),
    ]);
  }

  /**
   * 暂存解析结果（2026-10-06 起 dictionary 用途的默认出口）：
   * status='parsed' + parsed_drafts，绝不直接写 entries / toc / grammar_rules，
   * 等人工 `npm run db:review` 核对、`npm run db:confirm` 确认后才入库。
   * material 用途不经过这里（无结构化草稿，完成即 done）。
   */
  async stageParsedScan(
    scanId: string,
    input: ScanCompletionInput & { drafts: ParsedDrafts },
  ): Promise<void> {
    await this.pool.query(
      `UPDATE scan_records
          SET status = 'parsed',
              result_text = $2,
              raw_ocr_json = $3::jsonb,
              parser_rules = COALESCE($4::jsonb, parser_rules),
              parsed_drafts = $5::jsonb,
              error_code = NULL,
              error_message = NULL,
              updated_at = now()
        WHERE id = $1`,
      [
        scanId,
        input.resultText,
        JSON.stringify(toJsonValue(input.rawOcrJson)),
        input.parserRules === null ? null : JSON.stringify(input.parserRules),
        JSON.stringify(toJsonValue(input.drafts)),
      ],
    );
  }

  async getScan(scanId: string): Promise<ScanRow | null> {
    const result = await this.pool.query<ScanRow>(`SELECT * FROM scan_records WHERE id = $1`, [scanId]);
    return result.rows[0] ?? null;
  }

  async listScansByBatch(batchId: string): Promise<ScanRow[]> {
    const result = await this.pool.query<ScanRow>(
      `SELECT * FROM scan_records WHERE batch_id = $1 ORDER BY created_at ASC, id ASC`,
      [batchId],
    );
    return result.rows;
  }

  /** 取该书「使用说明」页解析出来的规则，供后续词条页复用。 */
  async getParserRules(sourceBook: string): Promise<ParserRules | null> {
    const result = await this.pool.query<{ parser_rules: unknown }>(
      `SELECT parser_rules
         FROM scan_records
        WHERE source_book = $1
          AND page_kind = 'instruction'
          AND parser_rules IS NOT NULL
        ORDER BY updated_at DESC
        LIMIT 1`,
      [sourceBook],
    );
    const row = result.rows[0];
    if (!row) return null;
    return parseParserRules(row.parser_rules);
  }

  /** 批量 upsert 词条（事务内）。返回受影响条数。 */
  async upsertEntries(drafts: readonly EntryDraft[], sourceBook: string): Promise<number> {
    if (drafts.length === 0) return 0;
    return withTransaction(this.pool, async (client: PoolClient) => {
      let count = 0;
      for (const draft of drafts) {
        if (draft.word.trim() === '') continue;
        await client.query(
          `INSERT INTO entries
             (word, phonetic, pos, definition_en, definition_zh, senses, examples, phrases,
              synonyms, antonyms, tags, root_affix, source_page, source_book)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::text[], $10::text[], $11::text[], $12, $13, $14)
           ON CONFLICT (word_key, pos_key) DO UPDATE SET
             phonetic      = shutree_merge_text(entries.phonetic, EXCLUDED.phonetic),
             definition_en = shutree_merge_text(entries.definition_en, EXCLUDED.definition_en),
             definition_zh = shutree_merge_text(entries.definition_zh, EXCLUDED.definition_zh),
             senses        = CASE WHEN jsonb_array_length(EXCLUDED.senses) > 0
                              THEN EXCLUDED.senses ELSE entries.senses END,
             root_affix    = shutree_merge_text(entries.root_affix, EXCLUDED.root_affix),
             examples      = shutree_merge_jsonb_array_by_key(entries.examples, EXCLUDED.examples, 'en'),
             phrases       = shutree_merge_jsonb_array_by_key(entries.phrases, EXCLUDED.phrases, 'text'),
             synonyms      = shutree_merge_text_array(entries.synonyms, EXCLUDED.synonyms),
             antonyms      = shutree_merge_text_array(entries.antonyms, EXCLUDED.antonyms),
             tags          = shutree_merge_text_array(entries.tags, EXCLUDED.tags),
             source_page   = COALESCE(entries.source_page, EXCLUDED.source_page)
           WHERE entries.phonetic IS DISTINCT FROM shutree_merge_text(entries.phonetic, EXCLUDED.phonetic)
              OR entries.definition_en IS DISTINCT FROM shutree_merge_text(entries.definition_en, EXCLUDED.definition_en)
              OR entries.definition_zh IS DISTINCT FROM shutree_merge_text(entries.definition_zh, EXCLUDED.definition_zh)
              OR entries.senses IS DISTINCT FROM
                   CASE WHEN jsonb_array_length(EXCLUDED.senses) > 0
                     THEN EXCLUDED.senses ELSE entries.senses END
              OR entries.root_affix IS DISTINCT FROM shutree_merge_text(entries.root_affix, EXCLUDED.root_affix)
              OR entries.examples IS DISTINCT FROM shutree_merge_jsonb_array_by_key(entries.examples, EXCLUDED.examples, 'en')
              OR entries.phrases IS DISTINCT FROM shutree_merge_jsonb_array_by_key(entries.phrases, EXCLUDED.phrases, 'text')
              OR entries.synonyms IS DISTINCT FROM shutree_merge_text_array(entries.synonyms, EXCLUDED.synonyms)
              OR entries.antonyms IS DISTINCT FROM shutree_merge_text_array(entries.antonyms, EXCLUDED.antonyms)
              OR entries.tags IS DISTINCT FROM shutree_merge_text_array(entries.tags, EXCLUDED.tags)
              OR entries.source_page IS DISTINCT FROM COALESCE(entries.source_page, EXCLUDED.source_page)`,
          [
            draft.word,
            draft.phonetic,
            draft.pos,
            draft.definitionEn ?? '',
            draft.definitionZh ?? '',
            JSON.stringify(draft.senses ?? []),
            JSON.stringify(draft.examples),
            JSON.stringify(draft.phrases),
            draft.synonyms,
            draft.antonyms,
            draft.tags,
            draft.rootAffix,
            draft.sourcePage,
            sourceBook,
          ],
        );
        count += 1;
      }
      return count;
    });
  }

  /** 批量 upsert 目录（事务内，按序解析 parent_id）。 */
  async upsertToc(drafts: readonly TocDraft[], sourceBook: string): Promise<number> {
    if (drafts.length === 0) return 0;
    return withTransaction(this.pool, async (client: PoolClient) => {
      const keyToId = new Map<string, string>();
      let count = 0;
      for (const draft of drafts) {
        if (draft.title.trim() === '') continue;
        const parentId = draft.parentTempKey === null ? null : keyToId.get(draft.parentTempKey) ?? null;
        const pageStart = draft.pageStart ?? 0;
        const result = await client.query<{ id: string }>(
          `WITH upserted AS (
             INSERT INTO toc (source_book, title, parent_id, page_start, page_end, order_index)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (source_book, title_key, page_start) DO UPDATE SET
               parent_id   = COALESCE(EXCLUDED.parent_id, toc.parent_id),
               page_end    = COALESCE(EXCLUDED.page_end, toc.page_end),
               order_index = EXCLUDED.order_index
             WHERE toc.parent_id IS DISTINCT FROM COALESCE(EXCLUDED.parent_id, toc.parent_id)
                OR toc.page_end IS DISTINCT FROM COALESCE(EXCLUDED.page_end, toc.page_end)
                OR toc.order_index IS DISTINCT FROM EXCLUDED.order_index
             RETURNING id
           )
           SELECT id FROM upserted
           UNION ALL
           SELECT id
             FROM toc
            WHERE source_book = $1
              AND title_key = shutree_normalize_key($2)
              AND page_start = $4
           LIMIT 1`,
          [sourceBook, draft.title, parentId, pageStart, draft.pageEnd, draft.orderIndex],
        );
        const row = result.rows[0];
        if (row) keyToId.set(draft.tempKey, row.id);
        count += 1;
      }
      return count;
    });
  }

  /** 批量 upsert 语法规则（事务内）。 */
  async upsertGrammarRules(
    drafts: readonly GrammarRuleDraft[],
    sourceBook: string,
    sourcePage: number | null = null,
  ): Promise<number> {
    if (drafts.length === 0) return 0;
    return withTransaction(this.pool, async (client: PoolClient) => {
      let count = 0;
      for (const draft of drafts) {
        if (draft.baseForm.trim() === '') continue;
        await client.query(
          `INSERT INTO grammar_rules (type, base_form, past_tense, past_participle, extra, source_book, source_page)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
           ON CONFLICT (type, base_form_key) DO UPDATE SET
             past_tense      = shutree_merge_text(grammar_rules.past_tense, EXCLUDED.past_tense),
             past_participle = shutree_merge_text(grammar_rules.past_participle, EXCLUDED.past_participle),
             extra           = grammar_rules.extra || EXCLUDED.extra,
             source_page     = COALESCE(grammar_rules.source_page, EXCLUDED.source_page)
           WHERE grammar_rules.past_tense IS DISTINCT FROM shutree_merge_text(grammar_rules.past_tense, EXCLUDED.past_tense)
              OR grammar_rules.past_participle IS DISTINCT FROM shutree_merge_text(grammar_rules.past_participle, EXCLUDED.past_participle)
              OR grammar_rules.extra IS DISTINCT FROM (grammar_rules.extra || EXCLUDED.extra)
              OR grammar_rules.source_page IS DISTINCT FROM COALESCE(grammar_rules.source_page, EXCLUDED.source_page)`,
          [
            draft.type,
            draft.baseForm,
            draft.pastTense,
            draft.pastParticiple,
            JSON.stringify(toJsonObject(draft.extra)),
            sourceBook,
            sourcePage ?? extraSourcePage(draft.extra),
          ],
        );
        count += 1;
      }
      return count;
    });
  }

  /** 增量同步：先从三张表合并出的全局序列切片，再按该窗口回表，避免跨表游标跳读。 */
  async syncSince(since: number, limit: number): Promise<SyncResponse> {
    const cursorResult = await this.pool.query<{ sync_seq: string }>(
      `SELECT sync_seq
         FROM (
           SELECT sync_seq FROM entries WHERE sync_seq > $1
           UNION ALL
           SELECT sync_seq FROM toc WHERE sync_seq > $1
           UNION ALL
           SELECT sync_seq FROM grammar_rules WHERE sync_seq > $1
         ) AS changes
        ORDER BY sync_seq ASC
        LIMIT $2`,
      [since, limit],
    );

    if (cursorResult.rows.length === 0) {
      return {
        since: String(since),
        nextSince: String(since),
        limit,
        truncated: false,
        entries: [],
        toc: [],
        grammarRules: [],
      };
    }

    const endSeq = Number(cursorResult.rows[cursorResult.rows.length - 1]?.sync_seq ?? since);
    const [entriesResult, tocResult, grammarResult, remainingResult] = await Promise.all([
      this.pool.query<EntryRow>(
        `SELECT id, sync_seq, word, phonetic, pos, definition_en, definition_zh,
                senses, examples, synonyms, antonyms, phrases, tags, root_affix,
                source_page, source_book, updated_at
           FROM entries
          WHERE sync_seq > $1 AND sync_seq <= $2
          ORDER BY sync_seq ASC`,
        [since, endSeq],
      ),
      this.pool.query<TocRow>(
        `SELECT id, sync_seq, source_book, title, parent_id, page_start, page_end, order_index, updated_at
           FROM toc
          WHERE sync_seq > $1 AND sync_seq <= $2
          ORDER BY sync_seq ASC`,
        [since, endSeq],
      ),
      this.pool.query<GrammarRow>(
        `SELECT id, sync_seq, type, base_form, past_tense, past_participle, extra, source_book, source_page, updated_at
           FROM grammar_rules
          WHERE sync_seq > $1 AND sync_seq <= $2
          ORDER BY sync_seq ASC`,
        [since, endSeq],
      ),
      this.pool.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM entries WHERE sync_seq > $1
           UNION ALL
           SELECT 1 FROM toc WHERE sync_seq > $1
           UNION ALL
           SELECT 1 FROM grammar_rules WHERE sync_seq > $1
         ) AS exists`,
        [endSeq],
      ),
    ]);

    const entries = entriesResult.rows.map(rowToSyncEntry);
    const toc: SyncToc[] = tocResult.rows.map((row) => ({
      id: row.id,
      syncSeq: row.sync_seq,
      sourceBook: row.source_book,
      title: row.title,
      parentId: row.parent_id,
      pageStart: row.page_start,
      pageEnd: row.page_end,
      orderIndex: row.order_index,
      updatedAt: row.updated_at.toISOString(),
    }));
    const grammarRules: SyncGrammarRule[] = grammarResult.rows.map((row) => ({
      id: row.id,
      syncSeq: row.sync_seq,
      type: row.type,
      baseForm: row.base_form,
      pastTense: row.past_tense,
      pastParticiple: row.past_participle,
      extra: toJsonObject(row.extra),
      sourceBook: row.source_book,
      sourcePage: row.source_page,
      updatedAt: row.updated_at.toISOString(),
    }));

    return {
      since: String(since),
      nextSince: String(endSeq),
      limit,
      truncated: remainingResult.rows[0]?.exists ?? false,
      entries,
      toc,
      grammarRules,
    };
  }

  /** 按单词取全部扫描词条（完整字段，单词详情页服务端回退用）。
   *  大小写不敏感（word_key 生成列），按 sync_seq 稳定排序。 */
  async listEntriesByWord(word: string): Promise<SyncEntry[]> {
    const key = word.trim().toLowerCase();
    if (key === '') return [];
    const result = await this.pool.query<EntryRow>(
      `SELECT id, sync_seq, word, phonetic, pos, definition_en, definition_zh,
              senses, examples, synonyms, antonyms, phrases, tags, root_affix,
              source_page, source_book, updated_at
         FROM entries
        WHERE word_key = $1
        ORDER BY sync_seq ASC`,
      [key],
    );
    return result.rows.map(rowToSyncEntry);
  }

  /** 检索（全局）：词典扫描库（entries）+ 内置词库（words）一次返回。
   *  entries：精确 > 前缀 > 全文 > trigram 模糊；
   *  words：精确 > 前缀 > 词内包含 > 中文释义包含。 */
  async search(query: string, limit: number): Promise<SearchResponse> {
    const normalized = query.trim().toLowerCase().replace(/\s+/g, ' ');
    if (normalized === '') {
      return { query, limit, total: 0, hits: [], words: [] };
    }
    const [entries, words] = await Promise.all([
      this.searchEntries(normalized, query, limit),
      this.searchWords(normalized, limit),
    ]);
    return { query, limit, total: entries.length + words.length, hits: entries, words };
  }

  /** entries 表检索（原有逻辑，抽出为私有方法） */
  private async searchEntries(
    normalized: string,
    originalQuery: string,
    limit: number,
  ): Promise<SearchHit[]> {
    // LIKE 通配符转义，避免用户输入 % / _ 影响前缀匹配
    const likePattern = `${normalized.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

    const result = await this.pool.query<SearchRow>(
      `SELECT ranked.id, ranked.word, ranked.phonetic, ranked.pos,
              ranked.definition_en, ranked.definition_zh, ranked.match_kind, ranked.score
         FROM (
           SELECT e.id, e.word, e.phonetic, e.pos, e.definition_en, e.definition_zh,
                  CASE
                    WHEN e.word_key = $2                        THEN 'exact'
                    WHEN e.word_key LIKE $4 ESCAPE '\\'          THEN 'prefix'
                    WHEN e.search_tsv @@ websearch_to_tsquery('english', $3) THEN 'fulltext'
                    ELSE 'fuzzy'
                  END AS match_kind,
                  CASE
                    WHEN e.word_key = $2               THEN 100::float8
                    WHEN e.word_key LIKE $4 ESCAPE '\\' THEN 80::float8
                    WHEN e.search_tsv @@ websearch_to_tsquery('english', $3)
                      THEN 20::float8 + COALESCE(ts_rank(e.search_tsv, websearch_to_tsquery('english', $3)), 0) * 40
                    ELSE COALESCE(similarity(e.word_key, $2), 0) * 40
                  END AS score
             FROM entries e
            WHERE e.word_key = $2
               OR e.word_key LIKE $4 ESCAPE '\\'
               OR e.search_tsv @@ websearch_to_tsquery('english', $3)
               OR e.word_key % $2
         ) AS ranked
        ORDER BY ranked.score DESC, ranked.word ASC
        LIMIT $1`,
      [limit, normalized, originalQuery, likePattern],
    );

    return result.rows.map((row) => ({
      id: row.id,
      word: row.word,
      phonetic: row.phonetic,
      pos: row.pos,
      definitionEn: row.definition_en,
      definitionZh: row.definition_zh,
      matchKind: toMatchKind(row.match_kind),
      score: Number(row.score),
    }));
  }

  /** words 表检索（内置词库）：exact > prefix > contains > zh，词本聚合已在行内。 */
  private async searchWords(normalized: string, limit: number): Promise<WordSearchHit[]> {
    // LIKE 通配符转义（与 searchEntries 同策略）
    const escaped = normalized.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    const prefixPattern = `${escaped}%`;
    const containsPattern = `%${escaped}%`;

    interface WordRow {
      id: string;
      word: string;
      ipa: string | null;
      pos: string | null;
      definition_zh: string;
      books: unknown;
      match_kind: string;
    }

    const result = await this.pool.query<WordRow>(
      `SELECT w.id, w.word, w.ipa, w.pos, w.definition_zh, w.books,
              CASE
                WHEN w.word_key = $2                        THEN 'exact'
                WHEN w.word_key LIKE $3 ESCAPE '\\'         THEN 'prefix'
                WHEN w.word_key LIKE $4 ESCAPE '\\'         THEN 'contains'
                ELSE 'zh'
              END AS match_kind
         FROM words w
        WHERE w.word_key = $2
           OR w.word_key LIKE $3 ESCAPE '\\'
           OR w.word_key LIKE $4 ESCAPE '\\'
           OR w.definition_zh LIKE $4 ESCAPE '\\'
        ORDER BY CASE
                   WHEN w.word_key = $2                THEN 0
                   WHEN w.word_key LIKE $3 ESCAPE '\\' THEN 1
                   WHEN w.word_key LIKE $4 ESCAPE '\\' THEN 2
                   ELSE 3
                 END ASC,
                 w.word ASC
        LIMIT $1`,
      [limit, normalized, prefixPattern, containsPattern],
    );

    return result.rows.map((row) => ({
      id: row.id,
      word: row.word,
      ipa: row.ipa,
      pos: row.pos,
      definitionZh: row.definition_zh,
      books: parseWordBooks(row.books),
      matchKind: toWordMatchKind(row.match_kind),
    }));
  }
}
