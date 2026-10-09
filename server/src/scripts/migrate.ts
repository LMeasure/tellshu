// =============================================================================
// npm run db:migrate —— 按文件名升序执行 sql/ 目录下的全部 .sql 迁移
//
// 顺序（必须靠文件名保证，不靠手写列表）：
//   001_init.sql       OCR / 词典链路（既有，本脚本不修改它）
//   002_discover.sql   发现书籍链路 discovered_books / discovered_book_chunks
//
// 幂等：每个迁移文件自身必须写成 IF NOT EXISTS / ON CONFLICT DO NOTHING 风格，
//       本脚本只负责「按序执行 + 记录」，因此连续运行两次结果一致。
//
// 只依赖 DATABASE_URL：迁移不应被 ADMIN_API_KEY / PADDLEOCR_ACCESS_TOKEN 阻塞。
// =============================================================================

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { Client } from 'pg';
import { SERVER_ROOT } from '../config';

loadDotenv();

const SQL_DIR = path.resolve(SERVER_ROOT, 'sql');

async function main(): Promise<void> {
  const connectionString = process.env['DATABASE_URL'];
  if (connectionString === undefined || connectionString.trim() === '') {
    throw new Error('缺少环境变量 DATABASE_URL');
  }

  const entries = await readdir(SQL_DIR, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .sort(); // 升序：001 → 002 → …，顺序由文件名决定

  if (files.length === 0) {
    throw new Error(`sql/ 目录里没有 .sql 文件：${SQL_DIR}`);
  }

  const client = new Client({ connectionString });
  await client.connect();
  try {
    for (const name of files) {
      const sql = await readFile(path.resolve(SQL_DIR, name), 'utf8');
      // 无参数调用走 simple query 协议，支持一次执行多条语句（含 BEGIN/COMMIT）
      await client.query(sql);
      process.stdout.write(`[db:migrate] 已执行 sql/${name}\n`);
    }
    process.stdout.write(`[db:migrate] 完成，共 ${files.length} 个迁移\n`);
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[db:migrate] 失败：${message}\n`);
  process.exit(1);
});
