// =============================================================================
// 种子脚本：把内置 5 本词本（data/linguabase/v1/search-index.json，22,791 条）
// 导入 PostgreSQL `words` 表（一词一行，多本收录聚合进 books）。
//
// 用途：搜索改全局（2026-10-06）——服务端一次检索「内置词库 + 词典扫描库」，
// 前端不再依赖本地词包与手动同步。
//
// 幂等：ON CONFLICT (id) 覆盖式 upsert，可重复执行；不删除库里多出来的词。
//
// 用法（在 server/ 目录）：
//   npm run db:seed-words                 # 默认读 <仓库根>/data/linguabase/v1/
//   npm run db:seed-words -- --dir=路径    # 自定义数据目录（含 search-index.json + index.json）
// =============================================================================

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createPool } from '../db/pool';
import { loadConfig, SERVER_ROOT } from '../config';

interface Options {
  dataDir: string | null;
}

function parseOptions(argv: readonly string[]): Options {
  const value = (name: string): string | null => {
    const hit = argv.find((item) => item.startsWith(`--${name}=`));
    return hit === undefined ? null : hit.slice(name.length + 3);
  };
  return { dataDir: value('dir') };
}

/** search-index.json 里的一条词（与前端 lib/search.ts SearchIndexWord 同构） */
interface IndexWord {
  id: string;
  word: string;
  ipa: string | null;
  pos: string | null;
  zh: string | null;
  book: string;
  dl: number;
  tid: string;
}

/** index.json books[] 里的词本元数据 */
interface BookMeta {
  id: string;
  name: string;
}

/** index.json 的合法词行；字段缺失/类型不对的行直接丢弃（不编造） */
function toIndexWord(value: unknown): IndexWord | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw['id'] !== 'string' || raw['id'] === '') return null;
  if (typeof raw['word'] !== 'string' || raw['word'].trim() === '') return null;
  if (typeof raw['book'] !== 'string' || raw['book'] === '') return null;
  const dl = typeof raw['dl'] === 'number' && Number.isFinite(raw['dl']) ? raw['dl'] : 3;
  return {
    id: raw['id'],
    word: raw['word'],
    ipa: typeof raw['ipa'] === 'string' && raw['ipa'] !== '' ? raw['ipa'] : null,
    pos: typeof raw['pos'] === 'string' && raw['pos'] !== '' ? raw['pos'] : null,
    zh: typeof raw['zh'] === 'string' ? raw['zh'] : null,
    book: raw['book'],
    dl: Math.min(Math.max(Math.round(dl), 1), 9),
    tid: typeof raw['tid'] === 'string' ? raw['tid'] : '',
  };
}

function toBookMeta(value: unknown): BookMeta | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw['id'] !== 'string' || raw['id'] === '') return null;
  return { id: raw['id'], name: typeof raw['name'] === 'string' ? raw['name'] : raw['id'] };
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, 'utf8')) as unknown;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const dataDir =
    options.dataDir ?? path.resolve(SERVER_ROOT, '..', 'data', 'linguabase', 'v1');

  const indexRaw = await readJson(path.join(dataDir, 'search-index.json'));
  const booksRaw = await readJson(path.join(dataDir, 'index.json'));

  const indexWords = (() => {
    const words = (indexRaw as { words?: unknown } | null)?.['words'];
    if (!Array.isArray(words)) throw new Error(`search-index.json 里没有 words 数组：${dataDir}`);
    return words
      .map(toIndexWord)
      .filter((w): w is IndexWord => w !== null);
  })();

  const nameOf = new Map<string, string>();
  const booksList = (booksRaw as { books?: unknown } | null)?.['books'];
  if (Array.isArray(booksList)) {
    for (const b of booksList.map(toBookMeta)) {
      if (b !== null) nameOf.set(b.id, b.name);
    }
  }

  // ── 按 id 聚合：同一词多本收录 → books 聚合，字段取首个非空 ────────────────
  interface Aggregated {
    id: string;
    word: string;
    ipa: string | null;
    pos: string | null;
    definitionZh: string;
    books: { id: string; name: string }[];
    minLevel: number;
  }
  const byId = new Map<string, Aggregated>();
  for (const w of indexWords) {
    const existing = byId.get(w.id);
    if (existing === undefined) {
      byId.set(w.id, {
        id: w.id,
        word: w.word,
        ipa: w.ipa,
        pos: w.pos,
        definitionZh: w.zh ?? '',
        books: [{ id: w.book, name: nameOf.get(w.book) ?? w.book }],
        minLevel: w.dl,
      });
      continue;
    }
    if (existing.ipa === null && w.ipa !== null) existing.ipa = w.ipa;
    if (existing.pos === null && w.pos !== null) existing.pos = w.pos;
    if (existing.definitionZh === '' && w.zh !== null) existing.definitionZh = w.zh;
    if (!existing.books.some((b) => b.id === w.book)) {
      existing.books.push({ id: w.book, name: nameOf.get(w.book) ?? w.book });
    }
    existing.minLevel = Math.min(existing.minLevel, w.dl);
  }

  const config = loadConfig();
  const pool = createPool({ connectionString: config.databaseUrl, max: 4 });
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      let upserted = 0;
      for (const row of byId.values()) {
        await client.query(
          `INSERT INTO words (id, word, ipa, pos, definition_zh, books, min_level)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
           ON CONFLICT (id) DO UPDATE SET
             word          = EXCLUDED.word,
             ipa           = COALESCE(EXCLUDED.ipa, words.ipa),
             pos           = COALESCE(EXCLUDED.pos, words.pos),
             definition_zh = CASE WHEN EXCLUDED.definition_zh <> ''
                                  THEN EXCLUDED.definition_zh ELSE words.definition_zh END,
             books         = EXCLUDED.books,
             min_level     = LEAST(words.min_level, EXCLUDED.min_level)`,
          [
            row.id,
            row.word,
            row.ipa,
            row.pos,
            row.definitionZh,
            JSON.stringify(row.books),
            row.minLevel,
          ],
        );
        upserted += 1;
      }
      await client.query('COMMIT');

      const after = await pool.query<{ total: string; with_ipa: string }>(
        `SELECT count(*)::text AS total, count(ipa)::text AS with_ipa FROM words`,
      );
      const stats = after.rows[0];
      process.stdout.write(
        `[db:seed-words] 源 ${indexWords.length} 条 → 去重 ${byId.size} 词，` +
          `upsert ${upserted} 行；表内现有 ${stats?.total ?? '?'} 词` +
          `（含音标 ${stats?.with_ipa ?? '?'}）\n`,
      );
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[db:seed-words] 失败：${message}\n`);
  process.exit(1);
});
