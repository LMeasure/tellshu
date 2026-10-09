// =============================================================================
// 重解析脚本：拿库里留存的原始 OCR 重放解析器，产出【待确认草稿】
//
// 2026-10-06 起入库改为两段式：
//   db:reparse  本脚本 —— 解析 raw_ocr_json -> 暂存 parsed_drafts（status='parsed'）
//   db:review   打印待确认草稿，人工核对
//   db:confirm  核对无误后写正式表（--truncate 可先清空三表做全量重建）
//
// 本脚本不再写 entries / toc / grammar_rules，也不再支持 --no-truncate
//（清库动作移到了 confirm，因为只有 confirm 才写正式表）。
// scan_records（含原始 OCR JSON）永远不动。
//
// 用法（在 server/ 目录）：
//   npm run db:reparse -- --dry-run
//   npm run db:reparse
//   npm run db:reparse -- --source-book=英语词典
// =============================================================================

import { createPool } from '../db/pool';
import { DictionaryRepository, type ScanRow } from '../db/repository';
import { parseIngestPages } from '../ocr/ingest';
import { extractOcrPages } from '../parsers/adapter';
import { loadConfig } from '../config';
import { EMPTY_PARSER_RULES, type ParserRules, type ScanPurpose } from '../types';

interface Options {
  dryRun: boolean;
  sourceBook: string | null;
}

function parseOptions(argv: readonly string[]): Options {
  const value = (name: string): string | null => {
    const hit = argv.find((item) => item.startsWith(`--${name}=`));
    return hit === undefined ? null : hit.slice(name.length + 3);
  };
  return {
    dryRun: argv.includes('--dry-run'),
    sourceBook: value('source-book'),
  };
}

function isScanPurpose(value: unknown): value is ScanPurpose {
  return value === 'material' || value === 'dictionary';
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const config = loadConfig();
  const pool = createPool({ connectionString: config.databaseUrl, max: 4 });
  const repository = new DictionaryRepository(pool);

  try {
    const alive = await repository.healthCheck();
    if (!alive) throw new Error('数据库连接失败，请检查 DATABASE_URL 与 PostgreSQL 是否已启动');

    const beforeRows = await pool.query<{ parsed: string; done: string; scans: string }>(
      `SELECT (SELECT count(*) FROM scan_records WHERE status = 'parsed')::text AS parsed,
              (SELECT count(*) FROM scan_records WHERE status = 'done')::text   AS done,
              (SELECT count(*) FROM scan_records)::text                          AS scans`,
    );
    const counts = beforeRows.rows[0];
    console.log('=== 重解析前 ===');
    console.log(
      `scan_records=${counts?.scans ?? '?'}（待确认 ${counts?.parsed ?? '?'} / 已入库 ${counts?.done ?? '?'}）`,
    );

    const params: unknown[] = [];
    let where = `WHERE status IN ('done', 'parsed') AND raw_ocr_json IS NOT NULL
                 AND purpose = 'dictionary'`;
    if (options.sourceBook !== null) {
      params.push(options.sourceBook);
      where += ` AND source_book = $1`;
    }
    const scanResult = await pool.query<ScanRow>(
      `SELECT * FROM scan_records
       ${where}
       ORDER BY (page_kind = 'instruction') DESC, created_at ASC, id ASC`,
      params,
    );
    const scans = scanResult.rows;
    console.log(
      `可重放的扫描记录：${scans.length} 条${options.sourceBook === null ? '' : `（source_book=${options.sourceBook}）`}`,
    );

    if (scans.length === 0) {
      console.log('没有可重放的记录，结束。');
      return;
    }

    if (options.dryRun) {
      console.log('\n[dry-run] 不会写库。预览将要重放的扫描：');
      for (const scan of scans) {
        const pages = extractOcrPages(scan.raw_ocr_json);
        console.log(
          `  ${scan.id}  ${scan.page_kind.padEnd(11)}  pages=${pages.length}  blocks=${pages.reduce((sum, p) => sum + p.blocks.length, 0)}  tables=${pages.reduce((sum, p) => sum + p.tables.length, 0)}`,
        );
      }
      return;
    }

    console.log('\n=== 重放解析（暂存为待确认，不写正式表） ===');
    const rulesByBook = new Map<string, ParserRules>();
    let entriesTotal = 0;
    let tocTotal = 0;
    let grammarTotal = 0;
    let stagedCount = 0;

    for (const scan of scans) {
      const pages = extractOcrPages(scan.raw_ocr_json);
      if (pages.length === 0) {
        console.log(`  ${scan.id}  ${scan.page_kind.padEnd(11)}  跳过：原始 JSON 里没有可归一化的页`);
        continue;
      }

      if (!isScanPurpose(scan.purpose)) {
        console.log(`  ${scan.id}  ${scan.page_kind.padEnd(11)}  跳过：未知 purpose=${scan.purpose}`);
        continue;
      }

      const rules =
        rulesByBook.get(scan.source_book) ??
        (await repository.getParserRules(scan.source_book)) ??
        EMPTY_PARSER_RULES;

      const outcome = parseIngestPages({
        pages,
        sourceBook: scan.source_book,
        purpose: scan.purpose,
        requestedKind: scan.page_kind,
        sourcePage: scan.page_number,
        initialRules: rules,
      });
      rulesByBook.set(scan.source_book, outcome.rules);

      await repository.stageParsedScan(scan.id, {
        resultText: scan.result_text ?? '',
        rawOcrJson: scan.raw_ocr_json,
        parserRules: outcome.summary.parserRulesUpdated ? outcome.rules : null,
        drafts: outcome.drafts,
      });
      stagedCount += 1;
      entriesTotal += outcome.summary.entriesUpserted;
      tocTotal += outcome.summary.tocUpserted;
      grammarTotal += outcome.summary.grammarUpserted;

      console.log(
        `  ${scan.id}  ${scan.page_kind.padEnd(11)}  entries=${outcome.summary.entriesUpserted}  toc=${outcome.summary.tocUpserted}  grammar=${outcome.summary.grammarUpserted}${outcome.summary.parserRulesUpdated ? '  [规则已更新]' : ''}`,
      );
    }

    console.log(
      `\n已暂存 ${stagedCount} 条扫描（词条 ${entriesTotal} / 目录 ${tocTotal} / 语法 ${grammarTotal}）`,
    );
    console.log('下一步：npm run db:review   核对解析结果');
    console.log('然后：  npm run db:confirm [--truncate]   确认无误后入库');
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[reparse] 失败：${message}\n`);
  process.exit(1);
});
