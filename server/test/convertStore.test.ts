// =============================================================================
// ConvertStore.cleanupExpiredResultFiles 单测：mock pg Pool + mock fs，
// 不依赖真实 PostgreSQL / 磁盘。覆盖：未过期不删 / 已过期删+清空 / 非 success
// 不受影响 / ENOENT 静默跳过；另加一例「非 ENOENT 错误计入失败、不中断」。
// 运行：cd server && npm test
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool } from 'pg';
import { ConvertStore } from '../src/db/convertStore';

interface MockRow {
  [key: string]: unknown;
}

interface MockPool {
  query: (
    text: string,
    params?: unknown[],
  ) => Promise<{ rows: MockRow[]; rowCount: number }>;
}

/** 构造 mock fs（仅 unlink）：记录调用、可按路径注入错误。 */
function makeMockFs() {
  const calls: string[] = [];
  const errors = new Map<string, Error>();
  const unlink = async (p: string): Promise<void> => {
    calls.push(p);
    const err = errors.get(p);
    if (err !== undefined) throw err;
  };
  return { calls, errors, unlink };
}

/** 构造 mock pg Pool：按 SQL 子串路由（仅覆盖 cleanup 用到的三种语句）。 */
function makeMockPool(opts: {
  listRows: MockRow[];
  paths: Record<string, string | null>;
  onUpdate?: (id: string) => void;
  captureSql?: (sql: string) => void;
}): MockPool {
  return {
    query: async (text: string, params?: unknown[]) => {
      if (opts.captureSql) opts.captureSql(text);
      if (text.includes("status = 'success'")) {
        return { rows: opts.listRows, rowCount: opts.listRows.length };
      }
      if (text.includes('storage_path FROM convert_files')) {
        const id = params?.[0] as string | undefined;
        const p = id === undefined ? null : opts.paths[id];
        if (p === undefined || p === null) return { rows: [], rowCount: 0 };
        return { rows: [{ storage_path: p }], rowCount: 1 };
      }
      if (text.includes('SET result_files')) {
        const id = params?.[0] as string | undefined;
        if (id !== undefined) opts.onUpdate?.(id);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

const TTL = 3_600_000;

test('未过期的 success 任务 → 不清理（list 返回空）', async () => {
  const fs = makeMockFs();
  const pool = makeMockPool({ listRows: [], paths: {} });
  const store = new ConvertStore(pool as unknown as Pool);
  const res = await store.cleanupExpiredResultFiles(TTL, { unlink: fs.unlink });
  assert.strictEqual(res.deletedFiles, 0);
  assert.strictEqual(res.deletedTasks, 0);
  assert.strictEqual(fs.calls.length, 0, '不应有任何 unlink 调用');
});

test('已过期的 success 任务 → 删除结果文件并清空 result_files', async () => {
  const fs = makeMockFs();
  const updates: string[] = [];
  const pool = makeMockPool({
    listRows: [{ id: 'task-1', result_files: ['f1', 'f2'] }],
    paths: { f1: '/tmp/f1.png', f2: '/tmp/f2.png' },
    onUpdate: (id) => updates.push(id),
  });
  const store = new ConvertStore(pool as unknown as Pool);
  const res = await store.cleanupExpiredResultFiles(TTL, { unlink: fs.unlink });
  assert.strictEqual(res.deletedFiles, 2, '两个结果文件都应被删除');
  assert.strictEqual(res.deletedTasks, 1, '该任务应被计入');
  assert.deepStrictEqual([...fs.calls].sort(), ['/tmp/f1.png', '/tmp/f2.png']);
  assert.deepStrictEqual(updates, ['task-1'], '应清空该任务的 result_files');
});

test('failed/processing/waiting 状态 → 被 WHERE 过滤，不受影响', async () => {
  const fs = makeMockFs();
  let capturedSql = '';
  // 模拟 DB 中只有非 success 任务（WHERE 已排除），list 返回空
  const pool = makeMockPool({ listRows: [], paths: {}, captureSql: (s) => (capturedSql = s) });
  const store = new ConvertStore(pool as unknown as Pool);
  const res = await store.cleanupExpiredResultFiles(TTL, { unlink: fs.unlink });
  assert.ok(
    capturedSql.includes("status = 'success'"),
    '清理查询必须限定 status=success，排除 failed/waiting/processing',
  );
  assert.strictEqual(res.deletedFiles, 0);
  assert.strictEqual(res.deletedTasks, 0);
  assert.strictEqual(fs.calls.length, 0, '非 success 任务不应触发任何文件删除');
});

test('结果文件已被其他途径删除（ENOENT）→ 静默跳过，不报错不计入', async () => {
  const fs = makeMockFs();
  const enoent = Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
  fs.errors.set('/tmp/gone.png', enoent);
  const updates: string[] = [];
  const pool = makeMockPool({
    listRows: [{ id: 'task-x', result_files: ['fx'] }],
    paths: { fx: '/tmp/gone.png' },
    onUpdate: (id) => updates.push(id),
  });
  const store = new ConvertStore(pool as unknown as Pool);
  // 不应抛错
  const res = await store.cleanupExpiredResultFiles(TTL, { unlink: fs.unlink });
  assert.strictEqual(res.deletedFiles, 0, 'ENOENT 不应计入已删');
  assert.strictEqual(res.deletedTasks, 1, '任务字段仍应被清空（保留审计轨迹）');
  assert.strictEqual(fs.calls.length, 1, '仍应尝试一次 unlink');
  assert.deepStrictEqual(updates, ['task-x']);
});

test('其他删除错误（非 ENOENT）→ 计入失败并记日志、不中断其余处理', async () => {
  const fs = makeMockFs();
  const other = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
  fs.errors.set('/tmp/locked.png', other);
  const updates: string[] = [];
  const pool = makeMockPool({
    listRows: [{ id: 'task-y', result_files: ['fy', 'fz'] }],
    paths: { fy: '/tmp/locked.png', fz: '/tmp/ok.png' },
    onUpdate: (id) => updates.push(id),
  });
  const store = new ConvertStore(pool as unknown as Pool);
  const res = await store.cleanupExpiredResultFiles(TTL, { unlink: fs.unlink });
  assert.strictEqual(res.deletedFiles, 1, '仅成功的那一个计入已删');
  assert.strictEqual(res.deletedTasks, 1, '任务仍应被清空');
  assert.strictEqual(fs.calls.length, 2, '两个文件都应尝试删除');
  assert.deepStrictEqual(updates, ['task-y']);
});
