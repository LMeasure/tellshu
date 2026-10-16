-- =============================================================================
-- B.7 · P0 修复：hnsw.iterative_scan 落地文件
--
-- 问题（B.6 实测）：
--   hnsw.iterative_scan 会话默认 = off。带上 chapter_title IS NOT NULL 过滤时，
--   pgvector 的 HNSW 会「提前收手」—— top_k=10 只返回 2 行，
--   100 条 query 里 7 条返回 0 行、5 条返回不足。这是「饥饿」，不是「召回低」。
--
-- 修复：
--   在【连接级 / 事务级】设置 hnsw.iterative_scan = strict_order（或 relaxed_order）。
--   绝不用 postgresql.conf / ALTER SYSTEM / ALTER ROLE —— 那会变成全局或角色级，
--   违反红线 R5（新会话必须仍然是 off）。
--
-- 前提：pgvector >= 0.8.0（本机实测 0.8.6，三个取值 off/strict_order/relaxed_order 均可用）
--
-- ⚠ 当前状态：发现书籍**没有 HTTP API，也没有任何业务代码查询 discovered_book_chunks**
--   （已 grep 确认）。所以本文件是「预置」——真正的接入点是未来 /api/discover 的连接池。
-- =============================================================================


-- -----------------------------------------------------------------------------
-- §A. 修复前 / 修复后的验证查询（只读，随时可跑）
-- -----------------------------------------------------------------------------

-- A1. 确认 GUC 可见（pgvector 的 GUC 要等扩展在本会话加载后才存在）
SELECT '[0,0,0]'::vector(3);

-- A2. 新会话的默认值（红线 R5：期望 off）
SHOW hnsw.iterative_scan;      -- 期望: off
SHOW hnsw.ef_search;           -- 期望: 40（红线 R1，全程不得改）

-- A3. 「饥饿」复现（修复前）：以下查询在 iterative_scan=off 时只返回 2 行而不是 10 行
--     （把 :'qvec' 换成真实 1024 维向量字面量）
-- EXPLAIN (ANALYZE, BUFFERS)
-- SELECT b.id, b.title, c.chunk_index, c.chapter_title,
--        1 - (c.embedding <=> :'qvec'::vector) AS similarity
-- FROM discovered_book_chunks c JOIN discovered_books b ON b.id = c.book_id
-- WHERE c.embedding IS NOT NULL AND c.chapter_title IS NOT NULL
-- ORDER BY c.embedding <=> :'qvec'::vector
-- LIMIT 10;


-- -----------------------------------------------------------------------------
-- §B. 推荐落地方式（三选一，按你的连接池形态挑一个）
-- -----------------------------------------------------------------------------

-- 【方式 1】连接池 connect 钩子（推荐，node-postgres 示例）
--   在 pool 的 connect 事件里对每条新连接执行一次，false = 会话级，
--   连接关闭即失效，不影响其它连接、不落库。
--
--   pool.on('connect', (client) => {
--     client.query("SELECT set_config('hnsw.iterative_scan', 'strict_order', false)")
--           .catch((e) => logger.error({ msg: 'iterative_scan init failed', err: e.message }));
--   });
--
--   对应 SQL 就是这一句：
--   SELECT set_config('hnsw.iterative_scan', 'strict_order', false);
--                                                            ^^^^^ 会话级（非事务级）

-- 【方式 2】检索事务内设置（最保守，作用域最小）
--   与 B.6/B.7 实验完全一致：同事务内 set_config(..., true)，commit 后自动失效。
-- BEGIN;
--   SELECT set_config('hnsw.iterative_scan', 'strict_order', true);
--   SELECT set_config('hnsw.ef_search', '800', true);        -- 若决定切 ANN
--   <检索 SQL>;
-- COMMIT;

-- 【方式 3】SQL 函数内 PERFORM（配合 explain-plan-observer.sql）
--   PERFORM set_config('hnsw.iterative_scan', 'strict_order', true);


-- -----------------------------------------------------------------------------
-- §C. 严格禁止的做法（会违反红线）
-- -----------------------------------------------------------------------------
--   ✗ ALTER SYSTEM SET hnsw.iterative_scan = 'strict_order';   -- 改全局配置（R1）
--   ✗ ALTER ROLE <user> SET hnsw.iterative_scan = 'strict_order';
--        —— 角色级持久设置，会让「新会话 SHOW」不再是 off，违反 R5
--   ✗ ALTER DATABASE <db> SET hnsw.iterative_scan = 'strict_order';  -- 同样违反 R5
--   ✗ 修改 postgresql.conf 里的 hnsw.ef_search 默认值（R1）


-- -----------------------------------------------------------------------------
-- §D. 回滚
-- -----------------------------------------------------------------------------
--   连接级/事务级设置无需回滚：断开连接或结束事务即自动失效。
--   若已误用 ALTER ROLE，回滚：
--   ALTER ROLE <user> RESET hnsw.iterative_scan;


-- -----------------------------------------------------------------------------
-- §E. 取值选择：strict_order vs relaxed_order
-- -----------------------------------------------------------------------------
--   off           默认；带过滤时会饥饿（返回行数不足）—— 今天生产就是这个
--   strict_order  迭代扫描 + 严格保持距离顺序；消除饥饿，顺序精确
--   relaxed_order 迭代扫描 + 允许轻微乱序；消除饥饿，召回略好
--   本轮 B.7 实测对比见报告 §1/§2（含 starved 计数、Top1/Top10、延迟）。
