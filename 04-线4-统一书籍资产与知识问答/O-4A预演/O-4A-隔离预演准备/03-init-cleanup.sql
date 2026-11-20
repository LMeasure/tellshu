-- =============================================================================
-- O-4A 第十轮 · 隔离 PG18 预演 初始化脚本（真正可执行 / NO 手工去注释）
-- =============================================================================
-- ⛔ DO NOT EXECUTE UNTIL O-4A AUTHORIZED
--    本文件是「授权后由编排器在独立隔离 PG18 实例执行」的可执行资产。
--    第十轮纪律：本轮未启动 PG、未执行任何 DDL/DML、未连接 R2、未使用真实凭证、
--    未触碰正式迁移链（server/sql/*）、未改代码/前提卡/V1.2.30、未 Git stage/commit。
--
-- 【可执行性设计（第十轮修复）】
--   * 全文件 SQL 均为真实可执行语句，不存在任何「被 -- 注释、需人工去注释」的代码。
--   * 说明性内容已外移到 02-O-4A-Runbook.md；本文件只保留执行所必需的短注释。
--   * 三道启动闸门：O4A_AUTHORIZED=1 + 四个 *_pw 变量，缺一即 \quit（fail-fast）。
--   * ON_ERROR_STOP on：任一句失败立即停止；全程包在单个事务内，失败整体回滚。
--   * 幂等：开头 DROP SCHEMA ... CASCADE 后重建（隔离实例、合成数据，可安全重建）。
--   * TRG-01 采用 SECURITY DEFINER + search_path 锁定 + OWNER=fn_owner（第十轮 P0 修复），
--     使 verifier 无 consumption UPDATE 权限也能由触发器合法推进状态，同时 T12 负向
--     测试可证明「普通业务角色直改 consumption 被拒」。
--
-- 【调用方式（授权后，编排器执行；密码走 -v，绝不写进仓库/聊天）】
--   psql -v O4A_AUTHORIZED=1 \
--        -v collector_pw="$COLLECTOR_PW" -v verifier_pw="$VERIFIER_PW" \
--        -v fixture_pw="$FIXTURE_PW"   -v monitor_pw="$MONITOR_PW"   \
--        -v app_pw="$APP_PW" -v admin_pw="$ADMIN_PW" \
--        -h 127.0.0.1 -p "$O4A_PORT" -U o4a_admin -d shutree_o4a \
--        -f 03-init-cleanup.sql
-- 目标基线：PostgreSQL 18；对象前缀 app / shutree_sec；闭环子集见 01-SQL依赖清单。
-- =============================================================================

\set ON_ERROR_STOP on

-- ---- 闸门 1：O-4A 授权标志 ---------------------------------------------------
\if :{?O4A_AUTHORIZED}
\else
\echo 'O-4A ABORT: O4A_AUTHORIZED not set. Refusing to run.'
\quit
\endif
\if :O4A_AUTHORIZED
\else
\echo 'O-4A ABORT: O4A_AUTHORIZED is not true. Refusing to run.'
\quit
\endif

-- ---- 闸门 2：所有角色密码必须显式注入（禁止空密码/默认密码） ----------------
\if :{?collector_pw}
\else
\echo 'O-4A ABORT: collector_pw not provided (-v collector_pw=...).'
\quit
\endif
\if :{?verifier_pw}
\else
\echo 'O-4A ABORT: verifier_pw not provided.'
\quit
\endif
\if :{?fixture_pw}
\else
\echo 'O-4A ABORT: fixture_pw not provided.'
\quit
\endif
\if :{?monitor_pw}
\else
\echo 'O-4A ABORT: monitor_pw not provided.'
\quit
\endif
\if :{?app_pw}
\else
\echo 'O-4A ABORT: app_pw not provided.'
\quit
\endif
\if :{?admin_pw}
\else
\echo 'O-4A ABORT: admin_pw not provided.'
\quit
\endif

\echo 'O-4A: authorization + password gates passed; initializing isolated rehearsal.'

-- =============================================================================
-- 事务边界：全部 DDL 单事务，任一失败整体回滚（ON_ERROR_STOP + 连接断开即回滚）
-- =============================================================================
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 幂等重置：隔离实例内合成数据，可安全 DROP 重建（重复初始化 = 重跑本脚本）
DROP SCHEMA IF EXISTS shutree_sec CASCADE;
DROP SCHEMA IF EXISTS app CASCADE;
CREATE SCHEMA app;
CREATE SCHEMA shutree_sec;

-- -----------------------------------------------------------------------------
-- 角色（幂等创建；密码用 ALTER ROLE 在 DO 块外注入，避免 psql 变量在 dollar-quote
-- 内的替换歧义）。fn_owner 无登录、无旁路，仅作 SECURITY DEFINER 执行主体/属主。
-- -----------------------------------------------------------------------------
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='shutree_fn_owner') THEN
    CREATE ROLE shutree_fn_owner NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='shutree_fixture_admin') THEN
    CREATE ROLE shutree_fixture_admin NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='shutree_evidence_collector') THEN
    CREATE ROLE shutree_evidence_collector NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='shutree_evidence_verifier') THEN
    CREATE ROLE shutree_evidence_verifier NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='shutree_monitor') THEN
    CREATE ROLE shutree_monitor NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='shutree_app') THEN
    CREATE ROLE shutree_app NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='shutree_admin') THEN
    CREATE ROLE shutree_admin SUPERUSER LOGIN;
  END IF;
END
$do$;

-- 保证属性（重复初始化时角色已存在，显式复位属性与密码）
ALTER ROLE shutree_fn_owner          NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOLOGIN;
ALTER ROLE shutree_fixture_admin     NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE LOGIN PASSWORD :'fixture_pw';
ALTER ROLE shutree_evidence_collector NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE LOGIN PASSWORD :'collector_pw';
ALTER ROLE shutree_evidence_verifier  NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE LOGIN PASSWORD :'verifier_pw';
ALTER ROLE shutree_monitor           NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE LOGIN PASSWORD :'monitor_pw';
ALTER ROLE shutree_app               NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE LOGIN PASSWORD :'app_pw';
ALTER ROLE shutree_admin             SUPERUSER LOGIN PASSWORD :'admin_pw';

-- 最小 schema 权限：业务角色不得在 shutree_sec 内 CREATE 对象
REVOKE ALL ON SCHEMA shutree_sec FROM PUBLIC;
REVOKE ALL ON SCHEMA app FROM PUBLIC;
GRANT USAGE ON SCHEMA shutree_sec TO shutree_fixture_admin, shutree_evidence_collector,
    shutree_evidence_verifier, shutree_monitor, shutree_app;
GRANT USAGE ON SCHEMA app TO shutree_fixture_admin, shutree_evidence_collector,
    shutree_evidence_verifier, shutree_monitor, shutree_app;
-- monitor 只读系统视图：pg_monitor 内置角色授予（可看 pg_stat_activity/pg_locks 全列）
GRANT pg_monitor TO shutree_monitor;

-- -----------------------------------------------------------------------------
-- 段 B：基线最小桩（满足 FK 目标；非产品完整 schema，见 01 §6-D4）
-- -----------------------------------------------------------------------------
CREATE TABLE app.object_outbox (
    outbox_id uuid PRIMARY KEY
);
ALTER TABLE app.object_outbox OWNER TO shutree_fn_owner;

-- -----------------------------------------------------------------------------
-- 段 C：WP-02 闭环对象（OBJ-02/03/04/05，含第十轮保留的 org_unit 修正）
-- -----------------------------------------------------------------------------
CREATE TABLE shutree_sec.evidence_signing_key (
    key_id          text PRIMARY KEY,
    subject_id      text NOT NULL,
    subject_type    text NOT NULL,
    public_key      bytea NOT NULL,
    org_unit        text NOT NULL,
    valid_from      timestamptz NOT NULL,
    valid_to        timestamptz,
    revoked_at      timestamptz,
    compromised_at  timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CHECK (((valid_to IS NULL OR valid_from < valid_to)) IS TRUE),
    CHECK (((revoked_at IS NULL OR revoked_at >= valid_from)) IS TRUE)
    -- 注：revoked_at/compromised_at 为「可变治理状态」；不可变密钥材料与可变治理状态
    -- 分表的完整方案见 08-U-R8-2-U-R8-3-实施设计.md（本预演为最小可执行桩）。
);
ALTER TABLE shutree_sec.evidence_signing_key OWNER TO shutree_fn_owner;

CREATE TABLE shutree_sec.r2_evidence_record (
    evidence_record_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    evidence_snapshot_id  uuid NOT NULL,
    channel               text NOT NULL,
    op_type               text NOT NULL,
    bound_outbox_id       uuid NOT NULL REFERENCES app.object_outbox(outbox_id),
    bound_request_id      text NOT NULL,
    bound_attempt_no      bigint NOT NULL,
    bound_lease_epoch     bigint NOT NULL,
    bound_worker_id       text NOT NULL,
    bound_environment     text NOT NULL,
    bound_bucket          text NOT NULL,
    bound_canonical_key   text NOT NULL,
    r2_operation_id       text,
    evidence_version      text NOT NULL,
    collected_at          timestamptz NOT NULL,
    collector_id          text NOT NULL,
    collector_role        text NOT NULL,
    collector_org_unit    text NOT NULL,
    collector_key_id      text NOT NULL,
    collector_signature   text NOT NULL,
    payload               bytea NOT NULL,
    payload_sha256        text NOT NULL,
    signature             text NOT NULL,
    signature_key_id      text NOT NULL REFERENCES shutree_sec.evidence_signing_key(key_id),
    created_at            timestamptz NOT NULL DEFAULT now(),
    CHECK ((channel IN ('C1','C2','C3','C4','C5','C6')) IS TRUE),
    UNIQUE (evidence_snapshot_id, channel, op_type),
    UNIQUE (bound_request_id, bound_attempt_no, bound_lease_epoch, op_type,
            bound_environment, bound_bucket, bound_canonical_key, payload_sha256)
);
ALTER TABLE shutree_sec.r2_evidence_record OWNER TO shutree_fn_owner;

CREATE TABLE shutree_sec.r2_evidence_verification (
    verification_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    evidence_record_id      uuid NOT NULL REFERENCES shutree_sec.r2_evidence_record(evidence_record_id),
    verifier_id             text NOT NULL,
    verifier_role           text NOT NULL,
    verifier_key_id         text NOT NULL,
    verifier_signature      text NOT NULL,
    verifier_org_unit       text NOT NULL,
    verified_at             timestamptz NOT NULL DEFAULT now(),
    review_method           text NOT NULL,
    verification_result     text NOT NULL,
    verified_payload_sha256 text NOT NULL,
    CHECK ((verification_result IN ('confirmed','contradicted','insufficient')) IS TRUE),
    UNIQUE (evidence_record_id, verifier_id)
);
ALTER TABLE shutree_sec.r2_evidence_verification OWNER TO shutree_fn_owner;

CREATE TABLE shutree_sec.r2_evidence_consumption (
    evidence_snapshot_id       uuid PRIMARY KEY,
    state                      text NOT NULL DEFAULT 'created',
    created_at                 timestamptz NOT NULL DEFAULT now(),
    verified_at                timestamptz,
    consumed_at                timestamptz,
    consumed_by_outbox_id      uuid,
    consumed_by_request_id     text,
    consumed_by_attempt_no     bigint,
    consumed_by_lease_epoch    bigint,
    consumed_by_op_type        text,
    consumed_by_environment    text,
    consumed_by_bucket         text,
    consumed_by_canonical_key  text,
    consumption_txid           xid8,
    consumption_db_role        text,
    rejected_at                timestamptz,
    reject_reason              text,
    CHECK ((state IN ('created','verified','consumable','consumed','rejected')) IS TRUE),
    CHECK (((state = 'consumed') IS NOT TRUE
            OR (consumed_at IS NOT NULL AND consumed_by_outbox_id IS NOT NULL
                AND consumption_txid IS NOT NULL AND consumption_db_role IS NOT NULL)) IS TRUE),
    CHECK (((state <> 'consumed' AND consumed_at IS NOT NULL) IS NOT TRUE))
);
ALTER TABLE shutree_sec.r2_evidence_consumption OWNER TO shutree_fn_owner;

-- -----------------------------------------------------------------------------
-- 段 D：TRG-01 —— SECURITY DEFINER + search_path 锁定（第十轮 P0 修复）
--   为何 DEFINER：verifier 仅获 verification 的 INSERT，不获 consumption 的 UPDATE；
--   触发器以其属主 shutree_fn_owner（表 owner）身份在临界区 UPDATE consumption，
--   从而「状态推进只能经受控入口」成立，T12 直改负向测试才有证明力。
--   SECURITY DEFINER 函数默认 PUBLIC 可执行，必须 REVOKE（见段 F）。
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION shutree_sec.trg_evidence_verification_fn()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_sid           uuid;
  v_collector     text;
  v_collector_org text;
  v_hash          text;
  v_state         text;
  v_rows          int;
  v_channels      int;
BEGIN
  -- SQL-A：普通 SELECT（SECURITY DEFINER 下以 fn_owner 读，见已提交 record）
  SELECT r.evidence_snapshot_id, r.collector_id, r.collector_org_unit, r.payload_sha256
    INTO v_sid, v_collector, v_collector_org, v_hash
    FROM shutree_sec.r2_evidence_record r
   WHERE r.evidence_record_id = NEW.evidence_record_id;

  -- SQL-B：三主体 + org_unit + confirmed + hash 闸门
  IF (NEW.verifier_id IS DISTINCT FROM v_collector) IS NOT TRUE
     OR (NEW.verifier_org_unit IS DISTINCT FROM v_collector_org) IS NOT TRUE
     OR (NEW.verification_result = 'confirmed') IS NOT TRUE
     OR (NEW.verified_payload_sha256 = v_hash) IS NOT TRUE
  THEN
    RAISE EXCEPTION 'verification_rejected' USING ERRCODE = 'P0001';
  END IF;

  -- SQL-C：LO-1 槽位行 FOR UPDATE（临界区入口；获锁前阻塞，获锁读最新已提交 state）
  SELECT c.state INTO v_state
    FROM shutree_sec.r2_evidence_consumption c
   WHERE c.evidence_snapshot_id = v_sid
     FOR UPDATE;

  -- SQL-D：created → verified（幂等，允许 0 行；多行 RAISE）
  IF v_state = 'created' THEN
    UPDATE shutree_sec.r2_evidence_consumption
       SET state='verified', verified_at=now()
     WHERE evidence_snapshot_id = v_sid AND state='created';
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows > 1 THEN RAISE 'cas_multi_rows'; END IF;

  -- SQL-E：verified → consumable（COUNT(DISTINCT channel)=6 才原子推进）
  ELSIF v_state = 'verified' THEN
    SELECT count(DISTINCT r.channel) INTO v_channels
      FROM shutree_sec.r2_evidence_record r
      JOIN shutree_sec.r2_evidence_verification v
        ON v.evidence_record_id = r.evidence_record_id
     WHERE r.evidence_snapshot_id = v_sid
       AND (v.verification_result = 'confirmed') IS TRUE
       AND (v.verified_payload_sha256 = r.payload_sha256) IS TRUE;
    IF v_channels = 6 THEN
      UPDATE shutree_sec.r2_evidence_consumption
         SET state='consumable' WHERE evidence_snapshot_id=v_sid AND state='verified';
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows > 1 THEN RAISE 'cas_multi_rows'; END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$fn$;
ALTER FUNCTION shutree_sec.trg_evidence_verification_fn() OWNER TO shutree_fn_owner;

DROP TRIGGER IF EXISTS trg_evidence_verification ON shutree_sec.r2_evidence_verification;
CREATE TRIGGER trg_evidence_verification
  AFTER INSERT ON shutree_sec.r2_evidence_verification
  FOR EACH ROW EXECUTE FUNCTION shutree_sec.trg_evidence_verification_fn();

-- -----------------------------------------------------------------------------
-- 段 E：测试协调表（持久化屏障状态，见 04-并发测试套件.py / 04c-屏障状态机设计.md）
--   状态：listener_ready → participant_arrived → barrier_released → participant_completed
-- -----------------------------------------------------------------------------
CREATE TABLE shutree_sec.rehearsal_barriers (
    name            text PRIMARY KEY,
    total           int  NOT NULL CHECK (total > 0),
    reached         int  NOT NULL DEFAULT 0,
    listeners_ready int  NOT NULL DEFAULT 0,
    released        bool NOT NULL DEFAULT false,
    completed       int  NOT NULL DEFAULT 0,
    created_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE shutree_sec.rehearsal_barriers OWNER TO shutree_fn_owner;

CREATE TABLE shutree_sec.rehearsal_barrier_events (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        text NOT NULL,
    pid         int  NOT NULL,
    role        text NOT NULL,
    event       text NOT NULL CHECK (event IN
                ('listener_ready','participant_arrived','barrier_released','participant_completed')),
    at          timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE shutree_sec.rehearsal_barrier_events OWNER TO shutree_fn_owner;

-- -----------------------------------------------------------------------------
-- 段 F：最小权限授权矩阵（逐项对照见 07-网络与权限隔离.md §2）
--   默认最小：先 REVOKE ALL FROM PUBLIC，再逐角色精确 GRANT。
--   证据表 append-only：任何业务角色均无 UPDATE/DELETE/TRUNCATE。
--   唯一可变槽位 consumption：业务角色无 UPDATE；仅受控触发器(DEFINER)推进。
-- -----------------------------------------------------------------------------
REVOKE ALL ON ALL TABLES IN SCHEMA shutree_sec FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA app FROM PUBLIC;
REVOKE ALL ON FUNCTION shutree_sec.trg_evidence_verification_fn() FROM PUBLIC;

-- 只读：app / monitor / 全部闭环角色
GRANT SELECT ON app.object_outbox,
    shutree_sec.evidence_signing_key, shutree_sec.r2_evidence_record,
    shutree_sec.r2_evidence_verification, shutree_sec.r2_evidence_consumption
    TO shutree_app, shutree_monitor, shutree_fixture_admin,
       shutree_evidence_collector, shutree_evidence_verifier;

-- fixture_admin：仅合成数据种子/清理（业务测试事务之外），可 DML 闭环全部对象 + 屏障表
GRANT INSERT, UPDATE, DELETE, TRUNCATE ON app.object_outbox,
    shutree_sec.evidence_signing_key, shutree_sec.r2_evidence_record,
    shutree_sec.r2_evidence_verification, shutree_sec.r2_evidence_consumption,
    shutree_sec.rehearsal_barriers, shutree_sec.rehearsal_barrier_events
    TO shutree_fixture_admin;

-- collector：仅 INSERT record（不 INSERT consumption；槽位由 fixture 预置，见 06）
GRANT INSERT ON shutree_sec.r2_evidence_record TO shutree_evidence_collector;
-- verifier：仅 INSERT verification（触发 TRG-01）。绝不 GRANT consumption 的 UPDATE/DELETE。
GRANT INSERT ON shutree_sec.r2_evidence_verification TO shutree_evidence_verifier;

-- 屏障参与：verifier / collector 可登记到达、读释放状态、写完成；不可改 total/released
GRANT SELECT, INSERT, UPDATE ON shutree_sec.rehearsal_barriers
    TO shutree_evidence_verifier, shutree_evidence_collector;
GRANT INSERT ON shutree_sec.rehearsal_barrier_events
    TO shutree_evidence_verifier, shutree_evidence_collector;
GRANT SELECT ON shutree_sec.rehearsal_barriers, shutree_sec.rehearsal_barrier_events
    TO shutree_monitor;

COMMIT;
\echo 'O-4A: init committed. Next: run 04-并发测试套件.py with per-role DSNs (see 02-Runbook §3.4).'
-- =============================================================================
-- 初始化结束。清理脚本见 03-cleanup.sql（独立可执行，同样有授权闸门）。
-- =============================================================================
