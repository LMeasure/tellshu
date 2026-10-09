// =============================================================================
// pg 连接池
// =============================================================================

import { Pool } from 'pg';

export interface PoolOptions {
  connectionString: string;
  max?: number;
}

export function createPool(options: PoolOptions): Pool {
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    allowExitOnIdle: true,
  });

  // 空闲连接出错时不要让进程崩溃
  pool.on('error', (error: Error) => {
    process.stderr.write(`[db] 连接池异常: ${error.message}\n`);
  });

  return pool;
}

/** 事务包装：回调内全部成功则 COMMIT，抛错则 ROLLBACK 并原样抛出。 */
export async function withTransaction<T>(pool: Pool, fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
