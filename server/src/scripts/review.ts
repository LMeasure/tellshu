// =============================================================================
// 待确认数据预览：打印 status='parsed' 的扫描记录里暂存的结构化草稿
//
// 用法（在 server/ 目录）：
//   npm run db:review                      # 全部待确认
//   npm run db:review -- --scan=<uuid>     # 单条
//   npm run db:review -- --batch=<id>      # 单个批次
//   npm run db:review -- --source-book=X   # 某本书
//
// 只读，不写任何表。核对无误后用 `npm run db:confirm` 入库。
// =============================================================================

import { createPool } from '../db/pool';
import type { ScanRow } from '../db/repository';
import { loadConfig } from '../config';
import { parseParsedDrafts } from '../types';

interface Options {
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
    scanId: value('scan'),
    batchId: value('batch'),
    sourceBook: value('source-book'),
  };
}

function truncate(text: string, max: number): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length <= max ? single : `${single.slice(0, max)}…`;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const config = loadConfig();
  const pool = createPool({ connectionString: config.databaseUrl, max: 2 });

  try {
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
      console.log('提示：先跑 npm run db:reparse 重新解析（或等实时扫描完成后自动暂存）。');
      return;
    }

    console.log(`待确认扫描：${scans.length} 条\n`);

    let totalEntries = 0;
    let totalToc = 0;
    let totalGrammar = 0;
    let totalSenses = 0;
    let totalExamples = 0;

    for (const scan of scans) {
      const drafts = parseParsedDrafts(scan.parsed_drafts);
      console.log('='.repeat(72));
      console.log(
        `scan ${scan.id}  kind=${scan.page_kind}  book=${scan.source_book || '-'}  page=${scan.page_number ?? '-'}`,
      );

      for (const entry of drafts.entries) {
        totalEntries += 1;
        console.log(
          `  【词条】${entry.word}  ${entry.pos}  /${entry.phonetic ?? ''}/  p.${entry.sourcePage ?? '-'}`,
        );
        if (entry.senses.length > 0) {
          entry.senses.forEach((sense, i) => {
            totalSenses += 1;
            totalExamples += sense.examples.length;
            const defs: string[] = [];
            if (sense.definitionEn !== null) defs.push(`EN: ${truncate(sense.definitionEn, 60)}`);
            if (sense.definitionZh !== '') defs.push(`ZH: ${truncate(sense.definitionZh, 60)}`);
            console.log(`    义项${i + 1}  ${defs.join(' | ')}  例句 ${sense.examples.length} 条`);
            for (const ex of sense.examples) {
              console.log(`      - ${truncate(ex.en, 52)}${ex.zh ? `  ${truncate(ex.zh, 30)}` : ''}`);
            }
          });
        } else {
          console.log('    （未产出义项分组，回退整条释义）');
        }
        if (entry.examples.length > entry.senses.reduce((sum, s) => sum + s.examples.length, 0)) {
          const extra = entry.examples.length - entry.senses.reduce((sum, s) => sum + s.examples.length, 0);
          totalExamples += extra;
          console.log(`    未归属义项的例句 ${extra} 条（入库后在「其他例句」里展示）`);
        }
      }

      for (const toc of drafts.toc) {
        totalToc += 1;
        console.log(`  【目录】p.${toc.pageStart}${toc.pageEnd !== null ? `-${toc.pageEnd}` : ''}  ${truncate(toc.title, 40)}`);
      }

      for (const rule of drafts.grammar) {
        totalGrammar += 1;
        console.log(
          `  【语法】${rule.baseForm}  ${rule.pastTense ?? '-'} / ${rule.pastParticiple ?? '-'}`,
        );
      }

      if (
        drafts.entries.length === 0 &&
        drafts.toc.length === 0 &&
        drafts.grammar.length === 0
      ) {
        console.log('  （本页没有解析出任何结构化草稿）');
      }
    }

    console.log('='.repeat(72));
    console.log(
      `合计：词条 ${totalEntries}（义项 ${totalSenses}）/ 目录 ${totalToc} / 语法 ${totalGrammar}；例句 ${totalExamples} 条`,
    );
    console.log('核对无误后执行：npm run db:confirm');
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[review] 失败：${message}\n`);
  process.exit(1);
});
