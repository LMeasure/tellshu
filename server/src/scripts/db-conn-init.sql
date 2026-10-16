-- =============================================================================
-- B.8 · 应用连接初始化（生产检索配置）
--
-- 用法（三选一）：
--   1) psql 会话开头：  psql "$DATABASE_URL" -f server/src/scripts/db-conn-init.sql
--   2) node-postgres 连接池 connect 钩子：
--        pool.on('connect', (c) => c.query(INIT_SQL).catch(logError))
--      其中 INIT_SQL 就是本文件的三条语句拼成的一条多语句串
--   3) 任意 ORM 的连接建立钩子，执行同样三条语句
--
-- 作用域：会话级（SET 不带 LOCAL = 会话级）。连接断开即失效，
--         不影响其它连接、不落库、不改 postgresql.conf。
--         裸会话（不执行本文件）SHOW 仍应为 ef_search=40 / iterative_scan=off（红线 R1 / R5）。
--
-- 配置来源（B.7 决策）：
--   ef_search = 800           Top1 与 EXACT 无显著差异（McNemar p=0.727）
--   iterative_scan = strict_order   消除「饥饿」（B.6：7/100 条返回 0 行 → 0）
--   已知代价：Top10 Δ −9pp（p=0.0117），该损失不被 iterative_scan 修复所改善
-- =============================================================================

-- ⚠ 这三行顺序不能改：pgvector 的 GUC 要等扩展在本会话加载后才存在。
--    少了第一行，下面的 SET 会直接报
--    "unrecognized configuration parameter \"hnsw.ef_search\""
SELECT NULL::vector;

SET hnsw.ef_search = 800;
SET hnsw.iterative_scan = strict_order;

-- -----------------------------------------------------------------------------
-- 自检（可选）：执行完应看到 800 / strict_order
-- -----------------------------------------------------------------------------
-- SHOW hnsw.ef_search;        -- 期望 800
-- SHOW hnsw.iterative_scan;   -- 期望 strict_order

-- -----------------------------------------------------------------------------
-- 红线对照（在【不执行】本文件的裸会话里跑，期望看到默认值）
-- -----------------------------------------------------------------------------
-- SELECT NULL::vector;
-- SHOW hnsw.ef_search;        -- 期望 40   （R1）
-- SHOW hnsw.iterative_scan;   -- 期望 off  （R5）

-- -----------------------------------------------------------------------------
-- 明确禁止
-- -----------------------------------------------------------------------------
--   ✗ ALTER SYSTEM SET ...        -- 改全局配置
--   ✗ ALTER ROLE ... SET ...      -- 角色级持久，会让裸会话不再是 40/off
--   ✗ ALTER DATABASE ... SET ...  -- 同上
--   ✗ 编辑 postgresql.conf
