// =============================================================================
// 执行单个 SQL 文件（用于新增迁移脚本，如 sql/002_discover.sql）
//
// 用法：
//   npm run apply:sql -- sql/002_discover.sql
//
// 说明：既有 npm run db:migrate 硬编码只执行 sql/001_init.sql。
//      为了不改动它的行为，新增迁移走本脚本；是否并入 db:migrate 由产品侧决定。
// 约束：SQL 文件本身必须幂等（IF NOT EXISTS），本脚本不做任何数据变更以外的动作。
// =============================================================================

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import pg from 'pg';

// 不 import ../config：config.ts 会在模块加载时校验全部环境变量，
// 而 apply-sql 只需要 DATABASE_URL，避免被无关的 OCR/管理密钥配置卡住。
const DIST_MARKER = `${path.sep}dist${path.sep}`;
const SERVER_ROOT = __dirname.includes(DIST_MARKER)
  ? path.resolve(__dirname.split(DIST_MARKER)[0] ?? __dirname)
  : path.resolve(__dirname, '..', '..');

loadDotenv();

async function main(): Promise<void> {
  const relative = process.argv[2];
  if (relative === undefined || relative.trim() === '') {
    throw new Error('缺少参数：请传入 sql 文件路径，例如 npm run apply:sql -- sql/002_discover.sql');
  }
  const connectionString = process.env['DATABASE_URL'];
  if (connectionString === undefined || connectionString.trim() === '') {
    throw new Error('缺少环境变量 DATABASE_URL');
  }

  const file = path.resolve(SERVER_ROOT, relative);
  const sql = await readFile(file, 'utf8');

  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    // 无参数调用走 simple query 协议，支持一次执行多条语句（含 BEGIN/COMMIT）
    await client.query(sql);

    // @types/pg 的 query() 不带行泛型，这里用显式断言而不是 any
    interface TableRow { table_name: string }
    interface IndexRow { indexname: string }
    interface ExtRow { extversion: string }

    const tables = await client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'discovered%' ORDER BY table_name",
    );
    const indexes = await client.query(
      "SELECT indexname FROM pg_indexes WHERE tablename LIKE 'discovered%' ORDER BY indexname",
    );
    const extension = await client.query(
      "SELECT extversion FROM pg_extension WHERE extname='vector'",
    );

    const tableNames = (tables.rows as TableRow[]).map((row) => row.table_name);
    const indexNames = (indexes.rows as IndexRow[]).map((row) => row.indexname);
    const extVersion = (extension.rows as ExtRow[])[0]?.extversion ?? '未安装';

    process.stdout.write(`[apply:sql] 已执行 ${path.relative(SERVER_ROOT, file)}\n`);
    process.stdout.write(`[apply:sql] pgvector 版本 = ${extVersion}\n`);
    process.stdout.write(`[apply:sql] 相关表 = ${tableNames.join(', ') || '(无)'}\n`);
    process.stdout.write(`[apply:sql] 相关索引 = ${indexNames.join(', ') || '(无)'}\n`);
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[apply:sql] 失败：${message}\n`);
  process.exitCode = 1;
});
