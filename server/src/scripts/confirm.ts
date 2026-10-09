// =============================================================================
// 确认入库：把 status='parsed' 的暂存草稿 upsert 进正式三表
//
// 用法（在 server/ 目录）：
//   npm run db:confirm                        # 确认全部待确认扫描
//   npm run db:confirm -- --scan=<uuid>       # 单条
//   npm run db:confirm -- --batch=<id>        # 单个批次
//   npm run db:confirm -- --source-book=X     # 某本书
//   npm run db:confirm -- --truncate          # 先清空 entries/toc/grammar_rules 再入库（全量重建）
//
// 建议：先 `npm run db:review` 逐条核对，再回来确认。scan_records 永远不动
//（parsed_drafts 保留，供追溯）。
// =============================================================================

import { createPool } from '../db/pool';
import { DictionaryRepository, type ScanRow } from '../db/repository';
import { applyParsedDrafts } from '../ocr/ingest';
import { loadConfig } from '../config';
import { parseParsedDrafts } from '../types';

interface Options {
  truncate: boolean;
  scanId: string | null;
  batchId: string | null;
  sourceBook: string | null;
}

function parseOptions(argv: readonly string[]): Options {
  const value = (name: string): string | null => {
    const hit = argv.find((item) => item.startsWith(`--${name}=`));
    return hit === undefined ? null : hit.slice(name.length + 3);
  };
  return {
    truncate: argv.includes('--truncate'),
    scanId: value('scan'),
    batchId: value('batch'),
    sourceBook: value('source-book'),
  };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const config = loadConfig();
  const pool = createPool({ connectionString: config.databaseUrl, max: 4 });
  const repository = new DictionaryRepository(pool);

  try {
    const alive = await repository.healthCheck();
    if (!alive) throw new Error('数据库连接失败，请检查 DATABASE_URL 与 PostgreSQL 是否已启动');

    const params: unknown[] = [];
    const conditions: string[] = [`status = 'parsed'`, `parsed_drafts IS NOT NULL`];
    if (options.scanId !== null) {
      params.push(options.scanId);
      conditions.push(`id = $${params.length}`);
    }
    if (options.batchId !== null) {
      params.push(options.batchId);
      conditions.push(`batch_id = $${params.length}`);
    }
    if (options.sourceBook !== null) {
      params.push(options.sourceBook);
      conditions.push(`source_book = $${params.length}`);
    }

    const result = await pool.query<ScanRow>(
      `SELECT * FROM scan_records WHERE ${conditions.join(' AND ')}
       ORDER BY created_at ASC, id ASC`,
      params,
    );
    const scans = result.rows;

    if (scans.length === 0) {
      console.log('没有待确认的扫描记录。');
      return;
    }

    if (options.truncate) {
      console.log('⚠️  --truncate：先清空 entries / toc / grammar_rules（scan_records 保留）');
      await pool.query(`TRUNCATE TABLE entries, toc, grammar_rules RESTART IDENTITY`);
    }

    console.log(`确认入库：${scans.length} 条扫描\n`);

    // 目录跨页偏移：同一本书内 order_index 全局递增（与重放顺序一致：created_at ASC）
    const tocOffsetByBook = new Map<string, number>();
    let entriesTotal = 0;
    let tocTotal = 0;
    let grammarTotal = 0;

    for (const scan of scans) {
      const drafts = parseParsedDrafts(scan.parsed_drafts);
      const offset = tocOffsetByBook.get(scan.source_book) ?? 0;
      const summary = await applyParsedDrafts(repository, {
        drafts,
        sourceBook: scan.source_book,
        tocOrderOffset: offset,
      });
      tocOffsetByBook.set(scan.source_book, offset + summary.tocUpserted);

      await repository.markScanStatus(scan.id, 'done');

      entriesTotal += summary.entriesUpserted;
      tocTotal += summary.tocUpserted;
      grammarTotal += summary.grammarUpserted;
      console.log(
        `  ${scan.id}  ${scan.page_kind.padEnd(11)}  entries+${summary.entriesUpserted}  toc+${summary.tocUpserted}  grammar+${summary.grammarUpserted}`,
      );
    }

    console.log(
      `\n合计入库：entries+${entriesTotal}  toc+${tocTotal}  grammar_rules+${grammarTotal}`,
    );

    const after = await pool.query<{ entries: string; toc: string; grammar: string; senses: string }>(
      `SELECT (SELECT count(*) FROM entries)::text AS entries,
              (SELECT count(*) FROM toc)::text AS toc,
              (SELECT count(*) FROM grammar_rules)::text AS grammar,
              (SELECT count(*) FROM entries WHERE jsonb_array_length(senses) > 0)::text AS senses`,
    );
    const row = after.rows[0];
    console.log(
      `当前库：entries=${row?.entries ?? '?'}（含义项分组 ${row?.senses ?? '?'}） toc=${row?.toc ?? '?'} grammar_rules=${row?.grammar ?? '?'}`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[confirm] 失败：${message}\n`);
  process.exit(1);
});
