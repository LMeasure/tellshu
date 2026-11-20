-- =============================================================================
-- O-4A 第十轮 · 隔离 PG18 预演 清理脚本（独立可执行 / 授权后运行）
-- =============================================================================
-- ⛔ DO NOT EXECUTE UNTIL O-4A AUTHORIZED
--    由隔离实例超级用户在授权后执行。首选销毁方式见 02-Runbook §6.1（直接删数据目录）。
--    本脚本用于「保留实例、原地清理重建」场景；不接触任何生产/既有库。
--    第十轮纪律：本轮未执行。
--
-- 【幂等 / 事务】可重复执行；单事务，失败整体回滚；ON_ERROR_STOP 失败即停。
-- 【调用】
--   psql -v O4A_AUTHORIZED=1 -h 127.0.0.1 -p "$O4A_PORT" -U o4a_admin \
--        -d shutree_o4a -f 03-cleanup.sql
-- 【角色清理策略】隔离实例通常随实例销毁，默认不 DROP ROLE；如需彻底清理见文件末尾注释。
-- =============================================================================

\set ON_ERROR_STOP on

\if :{?O4A_AUTHORIZED}
\else
\echo 'O-4A CLEANUP ABORT: O4A_AUTHORIZED not set.'
\quit
\endif
\if :O4A_AUTHORIZED
\else
\echo 'O-4A CLEANUP ABORT: not authorized.'
\quit
\endif

BEGIN;

-- DROP SCHEMA CASCADE 自动移除表 / 触发器 / 函数 / 协调表 / 约束
DROP SCHEMA IF EXISTS shutree_sec CASCADE;
DROP SCHEMA IF EXISTS app CASCADE;

COMMIT;
\echo 'O-4A CLEANUP: schemas dropped. Roles intentionally retained (dropped with instance).'

-- 彻底清理角色（仅在复用实例时手动执行，DEFAULT 注释保留）：
-- DROP ROLE IF EXISTS shutree_evidence_verifier, shutree_evidence_collector,
--                    shutree_fixture_admin, shutree_monitor, shutree_app,
--                    shutree_fn_owner, shutree_admin;
-- REVOKE pg_monitor FROM shutree_monitor;  -- 需在 DROP ROLE 前执行
