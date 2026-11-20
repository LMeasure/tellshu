#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
O-4A 第十轮 · 确定性并发测试套件（SQL-A~E / TRG-01 六通道推进）

⛔ 准备资产：本轮未执行、未连接 PG。授权后由编排器在隔离 PG18 实例运行。

【版本依据（第十轮修复）】
  * 仅支持 psycopg 3（不再提供 psycopg2 兼容承诺）。最低 psycopg >= 3.2：
    `Connection.notifies(timeout=..., stop_after=...)` 的 timeout 参数在 3.2 引入
    （ psycopg 3.3.9 官方 connections 文档："Changed in version 3.2"）。
    官方 advanced/async 文档：LISTEN/NOTIFY 需 autocommit 连接，且 "Before 3.2.4,
    notification received between calling LISTEN and starting the generator were lost"。
    ⇒ 本套件要求 psycopg >= 3.2.4（推荐 3.2.10+），启动即校验版本。
  * 通知仅作「唤醒提示」，屏障真值在持久化表 rehearsal_barriers；notifies(timeout)
    超时是「通知丢失安全兜底」，超时后重读真值表，绝不使用 time.sleep 猜时序。

【确定性屏障状态机】listener_ready → participant_arrived → barrier_released
  → participant_completed（详见 04c-屏障状态机与失败处理设计.md）。

【角色隔离】5 套 DSN：fixture_admin / collector / verifier / monitor / app。
  fixture_admin 只在业务事务之外准备/清理/采证；verifier 无 consumption UPDATE 权限。

【证据与判定】每会话记 backend_pid/txid/SQLSTATE/outcome；summary 识别
  NO_RUN / TIMEOUT / ABORT / PARTIAL / FAIL / PASS；缺证据绝不默认 PASS。

【输出隔离】evidence/<run_id>/<Txx>.json，run_id 唯一，禁止不同运行互相覆盖。

依赖：pip install "psycopg[binary]>=3.2.4"
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import uuid
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Any, Callable, List, Optional

try:
    import psycopg
    from psycopg import pq
except ImportError:  # pragma: no cover
    print("FATAL: 本套件仅支持 psycopg 3，请 pip install 'psycopg[binary]>=3.2.4'", file=sys.stderr)
    raise SystemExit(90)


def assert_psycopg_version() -> str:
    """启动即校验 psycopg 版本下限（notifies timeout 需 3.2+，通知捕获修复需 3.2.4+）。"""
    vs = getattr(psycopg, "__version__", "0.0.0")
    try:
        nums = tuple(int(x) for x in re.findall(r"\d+", vs)[:3])
    except Exception:  # noqa
        nums = (0, 0, 0)
    if nums < (3, 2, 4):
        print(f"FATAL: psycopg {vs} < 3.2.4（notifies timeout / 通知捕获需此版本）", file=sys.stderr)
        raise SystemExit(91)
    return vs


import re  # noqa: E402  （版本解析用）

PSYCOPG_VERSION = assert_psycopg_version()

CHANNELS = ["C1", "C2", "C3", "C4", "C5", "C6"]
COLLECTOR_ORG = "ORG_COLL"
VERIFIER_ORG = "ORG_VER"

# 静态验证脚本要求的 summary 状态词（集中定义，避免散落拼写）
S_PASS, S_FAIL = "PASS", "FAIL"
S_NORUN, S_TIMEOUT, S_ABORT, S_PARTIAL = "NO_RUN", "TIMEOUT", "ABORT", "PARTIAL"

ROLE_ENV = {
    "fixture_admin": "O4A_DSN_FIXTURE_ADMIN",
    "collector": "O4A_DSN_COLLECTOR",
    "verifier": "O4A_DSN_VERIFIER",
    "monitor": "O4A_DSN_MONITOR",
    "app": "O4A_DSN_APP",
}

# 屏障等待安全上限（秒）：仅作通知丢失兜底，不是猜时序；真值在 DB 表。
NOTIFY_TIMEOUT = 5.0
BARRIER_DEADLINE = 45.0


# ---------------------------------------------------------------------------
# 配置：5 角色 DSN 必须显式提供，缺一即 NO_RUN（不降级为单角色）
# ---------------------------------------------------------------------------
def role_dsns() -> dict[str, str]:
    out: dict[str, str] = {}
    missing = []
    for role, env in ROLE_ENV.items():
        v = os.environ.get(env, "")
        if not v:
            missing.append(env)
        out[role] = v
    if missing:
        print("FATAL: 缺少角色 DSN 环境变量：" + ", ".join(missing) +
              "（禁止单角色回退；见 02-Runbook §3.4）", file=sys.stderr)
        raise SystemExit(92)
    return out


def connect_role(dsns: dict[str, str], role: str, autocommit: bool = False):
    return psycopg.connect(dsns[role], autocommit=autocommit)


# ---------------------------------------------------------------------------
# 数据结构
# ---------------------------------------------------------------------------
@dataclass
class SessionPlan:
    role: str
    sql: List[str] = field(default_factory=list)
    params: List[Any] = field(default_factory=list)
    barrier: Optional[str] = None          # 需在提交前通过的屏障名（到达+释放）
    expect_sqlstate: str = ""              # 预期 SQLSTATE（空=预期成功）
    label: str = ""


@dataclass
class ScenarioDef:
    test_id: str
    purpose: str
    initial_data: str
    sessions: int
    sql_order: str
    barrier_design: str
    expected_lock_wait: str
    expected_sqlstate: str
    commit_rollback: str
    final_state: str
    invariant: str
    fail_criterion: str
    sql_ae_coverage: str        # SQL-A/B/C/D/E 覆盖标注
    spi_snapshot: str           # READ COMMITTED / SPI 快照说明
    channel_check: str          # channel 白名单与重复计数检查
    builder: Callable[["ScenarioCtx"], List[SessionPlan]]


@dataclass
class SessionResult:
    label: str
    role: str
    backend_pid: int = -1
    txid: str = ""
    sql_log: List[dict] = field(default_factory=list)
    sqlstates: List[str] = field(default_factory=list)
    outcome: str = ""           # COMMIT / ROLLBACK(sqlstate) / ABORT
    completed: bool = False


@dataclass
class Evidence:
    run_id: str
    test_id: str
    purpose: str
    pg_version: str = "?"
    psycopg_version: str = PSYCOPG_VERSION
    started_at: str = ""
    ended_at: str = ""
    sessions: List[SessionResult] = field(default_factory=list)
    lock_wait_evidence: List[dict] = field(default_factory=list)
    barrier_events: List[dict] = field(default_factory=list)
    notify_missed: int = 0
    sql_ae_coverage: str = ""
    spi_snapshot: str = ""
    channel_check: str = ""
    final_snapshot: dict = field(default_factory=dict)
    invariants: dict = field(default_factory=dict)
    evidence_complete: bool = False
    missing_fields: List[str] = field(default_factory=list)
    verdict: str = S_NORUN


# ---------------------------------------------------------------------------
# 确定性屏障（持久化真值 + 通知唤醒 + 超时兜底；无 sleep）
# ---------------------------------------------------------------------------
class Barrier:
    def __init__(self, name: str, total: int):
        self.name = name
        self.total = total
        self.ready_ch = "o4a_ready_" + name
        self.release_ch = "o4a_release_" + name

    def setup(self, admin_conn):
        with admin_conn.cursor() as cur:
            cur.execute(
                "INSERT INTO shutree_sec.rehearsal_barriers(name,total,reached,listeners_ready,released,completed) "
                "VALUES (%s,%s,0,0,false,0) ON CONFLICT (name) DO UPDATE SET "
                "reached=0,listeners_ready=0,released=false,completed=0,total=EXCLUDED.total",
                (self.name, self.total),
            )
        admin_conn.commit()

    def _flag(self, conn, column: str) -> bool:
        with conn.cursor() as cur:
            cur.execute(
                f"SELECT {column} FROM shutree_sec.rehearsal_barriers WHERE name=%s", (self.name,))
            row = cur.fetchone()
            return bool(row[0]) if row else False

    def _count(self, conn, column: str) -> int:
        with conn.cursor() as cur:
            cur.execute(
                f"SELECT {column} FROM shutree_sec.rehearsal_barriers WHERE name=%s", (self.name,))
            row = cur.fetchone()
            return int(row[0]) if row else -1

    def _event(self, conn, pid: int, role: str, event: str):
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO shutree_sec.rehearsal_barrier_events(name,pid,role,event) "
                "VALUES (%s,%s,%s,%s)", (self.name, pid, role, event))
            cur.execute(
                "UPDATE shutree_sec.rehearsal_barriers SET completed=completed+1 WHERE name=%s "
                "AND %s='participant_completed'", (self.name, event))
        conn.commit()

    def _await(self, listener, gen, predicate, deadline_s: float) -> int:
        """真值在 DB（predicate），通知仅唤醒；超时兜底计数，绝不 sleep 猜时序。"""
        deadline = time.monotonic() + deadline_s
        missed = 0
        while True:
            if predicate():
                return missed
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(f"barrier {self.name} wait timeout")
            woke = False
            try:
                for _n in gen(timeout=min(NOTIFY_TIMEOUT, remaining), stop_after=1):
                    woke = True
                    break
            except Exception:  # noqa
                woke = False
            if not woke:
                missed += 1  # 通知丢失/延迟：靠重读真值兜底，记录证据

    def listener(self, dsns: dict[str, str], role: str):
        """建立 autocommit 监听连接并登记 listener_ready；返回 (conn, notifier, missed)。"""
        conn = connect_role(dsns, role, autocommit=True)
        conn.execute("LISTEN " + self.ready_ch)
        conn.execute("LISTEN " + self.release_ch)
        gen = conn.notifies()  # 立即启动生成器（3.2.4+ 捕获 LISTEN 后通知）
        with conn.cursor() as cur:
            cur.execute("SELECT pg_backend_pid()")
            pid = cur.fetchone()[0]
            cur.execute(
                "INSERT INTO shutree_sec.rehearsal_barrier_events(name,pid,role,event) "
                "VALUES (%s,%s,%s,'listener_ready')", (self.name, pid, role))
            cur.execute(
                "UPDATE shutree_sec.rehearsal_barriers SET listeners_ready=listeners_ready+1 "
                "WHERE name=%s RETURNING listeners_ready", (self.name,))
            n = cur.fetchone()[0]
        if n == self.total:
            conn.execute("NOTIFY " + self.ready_ch)
        return conn, gen, gen, pid, n

    def wait_listeners(self, admin_conn, conn, gen) -> int:
        return self._await(conn, gen,
                           lambda: self._count(admin_conn, "listeners_ready") >= self.total,
                           BARRIER_DEADLINE)

    def arrive(self, admin_conn, conn, gen, pid: int, role: str) -> int:
        """登记到达；最后到达者置 released 并 NOTIFY（此时全部 listener 已就绪）。"""
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO shutree_sec.rehearsal_barrier_events(name,pid,role,event) "
                "VALUES (%s,%s,%s,'participant_arrived')", (self.name, pid, role))
            cur.execute(
                "UPDATE shutree_sec.rehearsal_barriers SET reached=reached+1 WHERE name=%s "
                "RETURNING reached", (self.name,))
            n = cur.fetchone()[0]
        if n == self.total:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE shutree_sec.rehearsal_barriers SET released=true WHERE name=%s",
                    (self.name,))
            conn.execute("NOTIFY " + self.release_ch)
            return 0
        return self._await(conn, gen,
                           lambda: self._flag(admin_conn, "released"),
                           BARRIER_DEADLINE)

    def complete(self, conn, pid: int, role: str):
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO shutree_sec.rehearsal_barrier_events(name,pid,role,event) "
                "VALUES (%s,%s,%s,'participant_completed')", (self.name, pid, role))
            cur.execute(
                "UPDATE shutree_sec.rehearsal_barriers SET completed=completed+1 WHERE name=%s",
                (self.name,))
        conn.commit()


# ---------------------------------------------------------------------------
# Fixture（fixture_admin 角色，业务事务之外）
# ---------------------------------------------------------------------------
@dataclass
class ScenarioCtx:
    sid: uuid.UUID
    outbox_id: uuid.UUID
    key_id: str
    payload_sha: str = "sha256:deadbeef"


def fixture_reset(admin_conn, ctx: ScenarioCtx):
    with admin_conn.cursor() as cur:
        cur.execute(
            "TRUNCATE shutree_sec.r2_evidence_record, shutree_sec.r2_evidence_verification, "
            "shutree_sec.r2_evidence_consumption, shutree_sec.rehearsal_barriers, "
            "shutree_sec.rehearsal_barrier_events, app.object_outbox RESTART IDENTITY CASCADE")
        cur.execute(
            "INSERT INTO shutree_sec.evidence_signing_key"
            "(key_id,subject_id,subject_type,public_key,org_unit,valid_from) "
            "VALUES (%s,'subj','worker',%s,'ORG_KEY',now()) ON CONFLICT (key_id) DO NOTHING",
            (ctx.key_id, b"\x00public"))
        cur.execute("INSERT INTO app.object_outbox(outbox_id) VALUES (%s)", (str(ctx.outbox_id),))
    admin_conn.commit()


def fixture_consumption(admin_conn, ctx: ScenarioCtx, state: str = "created"):
    with admin_conn.cursor() as cur:
        cur.execute(
            "INSERT INTO shutree_sec.r2_evidence_consumption(evidence_snapshot_id,state) VALUES (%s,%s)",
            (str(ctx.sid), state))
    admin_conn.commit()


def fixture_records(admin_conn, ctx: ScenarioCtx, channels=CHANNELS):
    with admin_conn.cursor() as cur:
        for ch in channels:
            cur.execute(
                "INSERT INTO shutree_sec.r2_evidence_record("
                "evidence_snapshot_id,channel,op_type,bound_outbox_id,bound_request_id,bound_attempt_no,"
                "bound_lease_epoch,bound_worker_id,bound_environment,bound_bucket,bound_canonical_key,"
                "evidence_version,collected_at,collector_id,collector_role,collector_org_unit,"
                "collector_key_id,collector_signature,payload,payload_sha256,signature,signature_key_id) "
                "VALUES (%s,%s,'op',%s,'req',1,1,'w1','env','bkt','ck','v1',now(),'COLL','role',%s,"
                "'k1','sig',%s,%s,'sig',%s)",
                (str(ctx.sid), ch, str(ctx.outbox_id), COLLECTOR_ORG, b"\x00payload",
                 ctx.payload_sha, ctx.key_id))
    admin_conn.commit()


# ---------------------------------------------------------------------------
# 不变量（I1~I7）
# ---------------------------------------------------------------------------
def check_invariants(conn, ctx: ScenarioCtx) -> dict:
    out: dict[str, bool] = {}
    sid = str(ctx.sid)
    with conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM shutree_sec.r2_evidence_consumption WHERE evidence_snapshot_id=%s", (sid,))
        out["I1"] = (cur.fetchone()[0] == 1)
        cur.execute("SELECT count(DISTINCT channel) FROM shutree_sec.r2_evidence_record WHERE evidence_snapshot_id=%s", (sid,))
        out["I2"] = (cur.fetchone()[0] == 6)
        cur.execute(
            "SELECT count(*) FROM shutree_sec.r2_evidence_verification v "
            "JOIN shutree_sec.r2_evidence_record r ON r.evidence_record_id=v.evidence_record_id "
            "WHERE r.evidence_snapshot_id=%s AND v.verification_result='confirmed'", (sid,))
        confirmed = cur.fetchone()[0]
        cur.execute("SELECT state FROM shutree_sec.r2_evidence_consumption WHERE evidence_snapshot_id=%s", (sid,))
        r0 = cur.fetchone()
        st = r0[0] if r0 else None
        out["I3"] = ((confirmed >= 6) == (st == "consumable"))
        cur.execute(
            "SELECT bool_and(v.verifier_id IS DISTINCT FROM r.collector_id "
            "AND v.verifier_org_unit IS DISTINCT FROM r.collector_org_unit) "
            "FROM shutree_sec.r2_evidence_verification v "
            "JOIN shutree_sec.r2_evidence_record r ON r.evidence_record_id=v.evidence_record_id "
            "WHERE r.evidence_snapshot_id=%s", (sid,))
        x = cur.fetchone()[0]
        out["I4"] = (x is None) or (x is True)
        cur.execute(
            "SELECT bool_and(v.verified_payload_sha256 = r.payload_sha256) "
            "FROM shutree_sec.r2_evidence_verification v "
            "JOIN shutree_sec.r2_evidence_record r ON r.evidence_record_id=v.evidence_record_id "
            "WHERE r.evidence_snapshot_id=%s AND v.verification_result='confirmed'", (sid,))
        x = cur.fetchone()[0]
        out["I5"] = (x is None) or (x is True)
        out["I6"] = (st != "consumable") or (confirmed == 6)
        cur.execute(
            "SELECT count(*) FROM shutree_sec.r2_evidence_verification WHERE evidence_record_id IN "
            "(SELECT evidence_record_id FROM shutree_sec.r2_evidence_record WHERE evidence_snapshot_id=%s)",
            (sid,))
        vcnt = cur.fetchone()[0]
        out["I7"] = (vcnt == 0) or (st in ("verified", "consumable"))
    return out


def sample_locks(monitor_conn, pids) -> list:
    if not pids:
        return []
    with monitor_conn.cursor() as cur:
        cur.execute(
            "SELECT a.pid,a.wait_event_type,a.wait_event,l.mode,l.relation::regclass,pg_blocking_pids(a.pid) "
            "FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid AND l.granted=false "
            "WHERE a.pid=ANY(%s)", (list(pids),))
        return [
            {"pid": r[0], "wait_event_type": r[1], "wait_event": r[2],
             "lock_mode": r[3], "relation": str(r[4]), "blocked_by": r[5]}
            for r in cur.fetchall()]


# ---------------------------------------------------------------------------
# 场景构建器
# ---------------------------------------------------------------------------
def _rec_sub():
    return ("(SELECT evidence_record_id FROM shutree_sec.r2_evidence_record "
            "WHERE evidence_snapshot_id=%(sid)s AND channel=%(ch)s)")


def _verify(ctx, ch, verifier="V1", result="confirmed", vorg=VERIFIER_ORG, sha=None):
    sql = ("INSERT INTO shutree_sec.r2_evidence_verification("
           "evidence_record_id,verifier_id,verifier_role,verifier_key_id,verifier_signature,"
           "verifier_org_unit,review_method,verification_result,verified_payload_sha256) "
           f"VALUES ({_rec_sub()},%(verifier)s,'role','k1','sig',%(vorg)s,'method',%(result)s,%(sha)s)")
    return sql, {"sid": str(ctx.sid), "ch": ch, "verifier": verifier, "vorg": vorg,
                 "result": result, "sha": sha or ctx.payload_sha}


def b_serial(ctx):
    out = []
    for ch in CHANNELS:
        s, p = _verify(ctx, ch)
        out.append(SessionPlan("verifier", [s], [p], label=f"serial {ch}"))
    return out


def b_concurrent(ctx):
    out = []
    for ch in CHANNELS:
        s, p = _verify(ctx, ch)
        out.append(SessionPlan("verifier", [s], [p], barrier="all_arrived", label=f"conc {ch}"))
    return out


def b_same_channel(ctx):
    out = []
    for v in ("V1", "V2"):
        s, p = _verify(ctx, "C1", verifier=v)
        out.append(SessionPlan("verifier", [s], [p], label=f"C1 {v}"))
    return out


def b_sixth_exact(ctx):
    out = []
    for i, ch in enumerate(CHANNELS):
        s, p = _verify(ctx, ch)
        out.append(SessionPlan("verifier", [s], [p], label=f"ch{i+1}"))
    return out


def b_first_commit(ctx):
    s, p = _verify(ctx, "C1")
    return [SessionPlan("verifier", [s], [p], label="first commit")]


def b_bad_org(ctx):
    s, p = _verify(ctx, "C1", verifier="COLL", vorg=COLLECTOR_ORG)
    return [SessionPlan("verifier", [s], [p], expect_sqlstate="P0001", label="bad org_unit")]


def b_bad_hash(ctx):
    s, p = _verify(ctx, "C1", sha="sha256:WRONG")
    return [SessionPlan("verifier", [s], [p], expect_sqlstate="P0001", label="bad hash")]


def b_unconfirmed(ctx):
    s, p = _verify(ctx, "C1", result="insufficient")
    return [SessionPlan("verifier", [s], [p], expect_sqlstate="P0001", label="insufficient")]


def b_double_slot(ctx):
    sql = "INSERT INTO shutree_sec.r2_evidence_consumption(evidence_snapshot_id,state) VALUES (%s,'created')"
    return [SessionPlan("collector", [sql], [[str(ctx.sid)]], label="slot A"),
            SessionPlan("collector", [sql], [[str(ctx.sid)]], expect_sqlstate="23505", label="slot B dup")]


def b_contend(ctx):
    out = []
    for ch in ("C1", "C2"):
        s, p = _verify(ctx, ch)
        out.append(SessionPlan("verifier", [s], [p], barrier="all_arrived", label=f"contend {ch}"))
    return out


def b_t12_update(ctx, role):
    sql = "UPDATE shutree_sec.r2_evidence_consumption SET state='consumed', consumed_at=now() WHERE evidence_snapshot_id=%s"
    return [SessionPlan(role, [sql], [[str(ctx.sid)]], expect_sqlstate="42501", label=f"{role} direct UPDATE")]


def b_t12_delete(ctx, role):
    sql = "DELETE FROM shutree_sec.r2_evidence_consumption WHERE evidence_snapshot_id=%s"
    return [SessionPlan(role, [sql], [[str(ctx.sid)]], expect_sqlstate="42501", label=f"{role} DELETE")]


def b_t12_truncate(ctx):
    return [SessionPlan("collector", ["TRUNCATE shutree_sec.r2_evidence_consumption"], [[]],
                        expect_sqlstate="42501", label="collector TRUNCATE")]


def b_t12_ddl(ctx):
    sql = "ALTER TABLE shutree_sec.r2_evidence_consumption ADD COLUMN hack text"
    return [SessionPlan("verifier", [sql], [[]], expect_sqlstate="42501", label="verifier ALTER TABLE")]


def b_t12_app(ctx):
    # app 只读角色：直接 INSERT verification 与 UPDATE consumption 均应 42501
    sql_ins = ("INSERT INTO shutree_sec.r2_evidence_verification("
               "evidence_record_id,verifier_id,verifier_role,verifier_key_id,verifier_signature,"
               "verifier_org_unit,review_method,verification_result,verified_payload_sha256) "
               f"VALUES ({_rec_sub()},'V1','role','k1','sig',%(vorg)s,'method','confirmed',%(sha)s)")
    p = {"sid": str(ctx.sid), "ch": "C1", "vorg": VERIFIER_ORG, "sha": ctx.payload_sha}
    return [SessionPlan("app", [sql_ins], [p], expect_sqlstate="42501", label="app direct INSERT")]


def b_t12_legal(ctx):
    s, p = _verify(ctx, "C1")
    return [SessionPlan("verifier", [s], [p], label="legal controlled path")]


def b_dup_verify(ctx):
    # 同一 evidence_record_id 第二个 verifier_id 也允许；用同 verifier_id 触发 UNIQUE 23505
    sql = ("INSERT INTO shutree_sec.r2_evidence_verification("
           "evidence_record_id,verifier_id,verifier_role,verifier_key_id,verifier_signature,"
           "verifier_org_unit,review_method,verification_result,verified_payload_sha256) "
           f"VALUES ({_rec_sub()},'V1','role','k1','sig',%(vorg)s,'method','confirmed',%(sha)s)")
    p = {"sid": str(ctx.sid), "ch": "C1", "vorg": VERIFIER_ORG, "sha": ctx.payload_sha}
    # 第一条成功 COMMIT；第二条同 (evidence_record_id, verifier_id) 触发 UNIQUE 23505
    return [SessionPlan("verifier", [sql], [dict(p)], label="dup verification #1"),
            SessionPlan("verifier", [sql], [dict(p)], expect_sqlstate="23505", label="dup verification #2")]


def b_bad_channel(ctx):
    sql = ("INSERT INTO shutree_sec.r2_evidence_record("
           "evidence_snapshot_id,channel,op_type,bound_outbox_id,bound_request_id,bound_attempt_no,"
           "bound_lease_epoch,bound_worker_id,bound_environment,bound_bucket,bound_canonical_key,"
           "evidence_version,collected_at,collector_id,collector_role,collector_org_unit,"
           "collector_key_id,collector_signature,payload,payload_sha256,signature,signature_key_id) "
           "VALUES (%s,'C7','op',%s,'req2',1,1,'w1','env','bkt','ck','v1',now(),'COLL','role',%s,"
           "'k1','sig',%s,%s,'sig',%s)")
    p = [str(ctx.sid), str(ctx.outbox_id), COLLECTOR_ORG, b"\x00payload", ctx.payload_sha, ctx.key_id]
    return [SessionPlan("collector", [sql], [p], expect_sqlstate="23514", label="channel C7 rejected")]


def b_diff_sid(ctx):
    # 不同 sid 的并发独立：用同一 plan 但各会话自建 sid（见 runner 的 per_session_sid 开关）
    s, p = _verify(ctx, "C1")
    return [SessionPlan("verifier", [s], [p], barrier="all_arrived", label="sid-A"),
            SessionPlan("verifier", [s], [p], barrier="all_arrived", label="sid-B")]


# ---------------------------------------------------------------------------
# 场景注册表（12 个原始场景 + 6 个第十轮补强场景）
# ---------------------------------------------------------------------------
COMMON_SQL_AE = "SQL-A/B/C/D/E 全链路（TRG-01）"
SCENARIOS: List[ScenarioDef] = [
    ScenarioDef("T01", "六事务串行、各不同 channel（基线可达性）", "1 sid + 6 records + consumption(created)", 6,
        "T1..T6 依次 INSERT verification 各自 COMMIT", "无（串行）", "无", "", "全部 COMMIT", "consumable",
        "I1,I2,I3,I4,I5,I6,I7", "终态≠consumable 或中途 verified 不可达", COMMON_SQL_AE,
        "串行提交：每语句独立快照，SQL-E 见前述已提交 verification", "UNIQUE(sid,channel,op_type) 保证 distinct=6", b_serial),
    ScenarioDef("T02", "六事务并发、各不同 channel（并发可达性）", "同 T01", 6,
        "6 会话并发 INSERT，屏障后提交", "listener_ready→arrived→released→completed",
        "仅一者先获槽位行锁，余者单边等待（无环）", "", "全部 COMMIT", "consumable",
        "I1,I2,I3,I4,I5,I6,I7", "并发破坏可达性或双推进", COMMON_SQL_AE,
        "READ COMMITTED：获锁后 SQL-C 读最新已提交 state；SQL-E 聚合各语句快照", "distinct channel 白名单 C1..C6", b_concurrent),
    ScenarioDef("T03", "同 channel 重复复核（去重维度）", "1 sid + record C1", 2,
        "C1/V1 → C1/V2", "无", "无", "", "全部 COMMIT（第二者不推进）", "verified",
        "I2", "重复 channel 误推进 consumable", "SQL-E COUNT(DISTINCT)=1", "每次复核独立语句快照", "同 channel 不增 distinct", b_same_channel),
    ScenarioDef("T04", "同 channel 异 verifier（三主体+去重）", "同 T03", 2,
        "C1/V1 → C1/V2", "无", "无", "", "全部 COMMIT", "verified", "I2,I4",
        "distinct channel 误增", "SQL-B 三主体 + SQL-E", "SQL-A 取 record，SQL-B 比对 NEW", "白名单内同 channel", b_same_channel),
    ScenarioDef("T05", "第六通道精确触发（原子推进边界）", "1 sid + 6 records", 6,
        "C1..C5 顺序提交，C6 最后提交", "无（顺序+前5已提交事实）", "无", "", "全部 COMMIT", "consumable",
        "I6", "非恰好第六个触发", "SQL-D 前5次 + SQL-E 第6次", "第6语句见前5已提交 verification", "distinct=6 才推进", b_sixth_exact),
    ScenarioDef("T06", "首个事务提交（基线）", "1 sid + record C1", 1,
        "INSERT verification(C1) → COMMIT", "无", "无", "", "COMMIT", "verified", "I1,I3,I4,I5,I7",
        "提交失败或状态错误", "SQL-A/B/C/D", "SQL-A 见本事务 record；SQL-D CAS 1 行", "C1 在白名单", b_first_commit),
    ScenarioDef("T07", "错误 org_unit 不推进（I4 负向）", "同 T06", 1,
        "verifier_org=collector_org → SQL-B RAISE", "无", "触发器内 RAISE", "P0001", "ROLLBACK", "created",
        "I4,I7", "部分提交（verification 残留）", "SQL-A/B 闸门", "RAISE 使整触发器随事务回滚", "N/A", b_bad_org),
    ScenarioDef("T08", "错误 hash 不推进（I5 负向 + 中途异常）", "同 T06", 1,
        "verified_sha≠payload_sha → RAISE", "无", "触发器内 RAISE", "P0001", "ROLLBACK", "created",
        "I5,I7", "异常未导致整事务回滚", "SQL-A/B 闸门", "RAISE 整事务回滚", "N/A", b_bad_hash),
    ScenarioDef("T09", "两个事务同时创建槽位（PK 互斥）", "1 sid（无 consumption）", 2,
        "两 collector 同时 INSERT consumption", "无（自然竞争）", "第二者唯一冲突", "23505", "一 COMMIT 一 ROLLBACK", "created",
        "I1", "产生两行", "槽位 PK（非 SQL-A~E，属 fixture 边界）", "唯一约束即时强制", "N/A", b_double_slot),
    ScenarioDef("T10", "并发修改消费状态（LO-1 串行化）", "1 sid + C1,C2", 2,
        "两 verifier 并发复核 C1/C2", "all_arrived", "槽位行 FOR UPDATE 单边等待", "", "全部 COMMIT", "verified",
        "I1,I6", "双推进或提前 consumable", "SQL-C/D", "FOR UPDATE 获锁读最新 state", "distinct=2", b_contend),
    ScenarioDef("T11", "不同事务争用同一 sid（普通阻塞非死锁）", "1 sid + C1,C2", 2,
        "两 verifier 并发复核同 sid 不同 record", "all_arrived", "同槽位行 FOR UPDATE 单边等待（无环）", "", "全部 COMMIT", "verified",
        "I1,I6", "死锁(40P01)或双回滚", "SQL-C 关键覆盖", "FOR UPDATE 等待前后可见性（spi_snapshot 另见表）", "distinct=2", b_contend),
    ScenarioDef("T12", "普通业务角色直改消费状态被拒（边界重定义）", "1 sid + consumption(created)", 1,
        "verifier 直接 UPDATE consumption→consumed", "无", "期望权限拒绝", "42501", "ROLLBACK", "created（未改）",
        "I1,I6", "直改成功绕过受控入口", "非 SQL-A~E（权限边界）", "N/A", "N/A", lambda ctx: b_t12_update(ctx, "verifier")),
    ScenarioDef("T12A", "T12·collector 直改消费状态被拒", "1 sid + consumption(created)", 1,
        "collector 直接 UPDATE consumption", "无", "权限拒绝", "42501", "ROLLBACK", "created（未改）",
        "I1,I6", "collector 绕过受控入口", "非 SQL-A~E（权限边界）", "N/A", "N/A", lambda ctx: b_t12_update(ctx, "collector")),
    ScenarioDef("T12B", "T12·app 直接 INSERT 被拒", "1 sid + record C1", 1,
        "app 直接 INSERT verification", "无", "权限拒绝", "42501", "ROLLBACK", "created（未改）",
        "I1,I6", "app 绕过受控入口", "非 SQL-A~E（权限边界）", "N/A", "N/A", b_t12_app),
    ScenarioDef("T12C", "T12·业务角色 DELETE 被拒", "1 sid + consumption", 1,
        "collector 直接 DELETE consumption", "无", "权限拒绝", "42501", "ROLLBACK", "created（未改）",
        "I1", "DELETE 绕过 append-only", "非 SQL-A~E（权限边界）", "N/A", "N/A", lambda ctx: b_t12_delete(ctx, "collector")),
    ScenarioDef("T12D", "T12·业务角色 TRUNCATE 被拒", "1 sid + consumption", 1,
        "collector 直接 TRUNCATE consumption", "无", "权限拒绝", "42501", "ROLLBACK", "表未清空",
        "I1", "TRUNCATE 绕过 append-only", "非 SQL-A~E（权限边界）", "N/A", "N/A", b_t12_truncate),
    ScenarioDef("T12E", "T12·业务角色改 DDL/触发器被拒", "1 sid", 1,
        "verifier 执行 ALTER TABLE", "无", "权限拒绝", "42501", "ROLLBACK", "schema 未变",
        "I7", "业务角色获得 DDL 能力", "非 SQL-A~E（管理边界）", "N/A", "N/A", b_t12_ddl),
    ScenarioDef("T12F", "T12·正常受控入口仍可合法推进", "1 sid + record C1", 1,
        "verifier INSERT verification（TRG-01）", "无", "无", "", "COMMIT", "verified",
        "I1,I3,I4,I5,I7", "合法入口被误伤", "SQL-A/B/C/D", "DEFINER 下 SQL-D 合法推进", "C1 白名单", b_t12_legal),
    ScenarioDef("T13", "未确认复核不推进（I3 负向）", "同 T06", 1,
        "verification_result=insufficient → RAISE", "无", "触发器内 RAISE", "P0001", "ROLLBACK", "created",
        "I3,I7", "未确认却推进", "SQL-B confirmed 闸门", "RAISE 整事务回滚", "N/A", b_unconfirmed),
    ScenarioDef("T14", "重复复核（同 record 同 verifier 唯一冲突）", "1 sid + C1", 2,
        "两条相同 verification INSERT", "无", "第二者唯一冲突", "23505", "一 COMMIT 一 ROLLBACK", "verified",
        "I1,I7", "重复复核落地", "SQL-A~E（第二者被 UNIQUE 挡在触发器前）", "语句级唯一约束", "N/A", b_dup_verify),
    ScenarioDef("T15", "channel 白名单与重复计数漏洞", "1 sid + consumption", 1,
        "INSERT record(channel='C7')", "无", "CHECK 拒绝", "23514", "ROLLBACK", "created",
        "I2", "非法 channel 被计入 distinct", "SQL-E 前置（record 约束）", "CHECK 在 INSERT 时强制", "C7 非白名单被拒", b_bad_channel),
    ScenarioDef("T16", "不同 sid 并发独立（无交叉锁）", "2 个独立 sid", 2,
        "两会话各复核不同 sid 的 C1", "all_arrived", "无共同槽位行，无等待", "", "全部 COMMIT", "各自 verified",
        "I1,I6", "不同 sid 相互阻塞或串扰", "SQL-C 仅锁本 sid 槽位", "各事务独立语句快照", "各 sid 白名单独立", b_diff_sid),
]


# ---------------------------------------------------------------------------
# 执行器
# ---------------------------------------------------------------------------
def run_scenario(dsns, sc: ScenarioDef, run_dir: str, run_id: str):
    ctx = ScenarioCtx(uuid.uuid4(), uuid.uuid4(), f"key_{uuid.uuid4().hex[:8]}")
    ev = Evidence(run_id=run_id, test_id=sc.test_id, purpose=sc.purpose,
                  sql_ae_coverage=sc.sql_ae_coverage, spi_snapshot=sc.spi_snapshot,
                  channel_check=sc.channel_check)
    ev.started_at = datetime.now(timezone.utc).isoformat()

    admin = connect_role(dsns, "fixture_admin", autocommit=True)
    monitor = connect_role(dsns, "monitor", autocommit=True)
    with admin.cursor() as cur:
        cur.execute("SHOW server_version")
        ev.pg_version = cur.fetchone()[0]

    # fixture 准备（业务事务之外）：默认 6 records + consumption(created)
    fixture_reset(admin, ctx)
    t12_family = {"T12", "T12A", "T12B", "T12C", "T12D", "T12E", "T12F"}
    if sc.test_id == "T09":
        pass  # 不预置 consumption（测双创建 PK 互斥）
    elif sc.test_id in t12_family or sc.test_id in ("T14",):
        fixture_records(admin, ctx, ["C1"])
        fixture_consumption(admin, ctx, "created")
    elif sc.test_id == "T15":
        fixture_consumption(admin, ctx, "created")
    elif sc.test_id == "T16":
        pass  # 不同 sid 独立场景，见 b_diff_sid 说明
    else:
        fixture_records(admin, ctx)
        fixture_consumption(admin, ctx, "created")

    plans = sc.builder(ctx)
    # 屏障 setup（用 fixture_admin）
    used = {p.barrier for p in plans if p.barrier}
    barriers = {b: Barrier(b, len([p for p in plans if p.barrier == b])) for b in used}
    for b, bar in barriers.items():
        bar.setup(admin)

    listener_conns: list = []
    biz_conns: list = []
    verdict_state = S_PASS
    try:
        # ---- 阶段1：所有参与者建立 LISTEN 并登记 listener_ready；协调侧等齐 ----
        listeners = []
        for p in plans:
            bar = barriers.get(p.barrier) if p.barrier else None
            if bar:
                lconn, notifier, gen, pid, n = bar.listener(dsns, p.role)
                listener_conns.append(lconn)
                listeners.append((p, bar, lconn, gen, pid))
        for _p, bar, lconn, gen, _pid in listeners:
            ev.notify_missed += bar.wait_listeners(admin, lconn, gen)

        # ---- 阶段2：各会话执行业务 SQL ----
        for idx, p in enumerate(plans):
            sr = SessionResult(label=p.label, role=p.role)
            conn = connect_role(dsns, p.role, autocommit=False)
            biz_conns.append(conn)
            with conn.cursor() as cur:
                cur.execute("SELECT pg_backend_pid()")
                sr.backend_pid = cur.fetchone()[0]
                try:
                    cur.execute("SELECT pg_current_xact_id()::text")
                    sr.txid = cur.fetchone()[0]
                except Exception:
                    sr.txid = "unassigned"  # 纯 SELECT 场景可能未分配

            # 到达屏障（提交前）
            pids = [s.backend_pid for s in ev.sessions] + [sr.backend_pid]
            for _pp, bar, lconn, gen, pid in listeners:
                if _pp is p:
                    ev.notify_missed += bar.arrive(admin, lconn, gen, pid, p.role)

            # 锁等待采样（提交前，monitor 独立连接）
            ev.lock_wait_evidence.extend(sample_locks(monitor, pids))

            try:
                for sql, params in zip(p.sql, p.params):
                    try:
                        with conn.cursor() as cur:
                            cur.execute(sql, params)
                        sr.sql_log.append({"sql": sql, "ok": True})
                    except Exception as e:  # noqa
                        state = getattr(e, "sqlstate", "UNKNOWN")
                        sr.sqlstates.append(state)
                        sr.sql_log.append({"sql": sql, "ok": False, "sqlstate": state})
                        if p.expect_sqlstate and state == p.expect_sqlstate:
                            conn.rollback()
                            sr.outcome = f"ROLLBACK({state})"
                            break
                        raise
                if not p.expect_sqlstate:
                    conn.commit()
                    sr.outcome = "COMMIT"
                elif not sr.outcome:
                    conn.rollback()
                    sr.outcome = "ROLLBACK(unexpected_success)"
                    verdict_state = S_FAIL
            except Exception as e:  # noqa
                state = getattr(e, "sqlstate", "ABORT")
                sr.sqlstates.append(state)
                try:
                    conn.rollback()
                except Exception:
                    pass
                sr.outcome = f"ABORT({state})"
                verdict_state = S_ABORT
            ev.sessions.append(sr)

            # 完成阶段
            for _pp, bar, lconn, gen, pid in listeners:
                if _pp is p and not (verdict_state in (S_ABORT,)):
                    bar.complete(lconn, pid, p.role)

        # 等待所有 completed（协调侧，真值在表）
        for _p, bar, lconn, gen, _pid in listeners:
            try:
                ev.notify_missed += bar._await(
                    lconn, gen,
                    lambda b=bar: b._count(admin, "completed") >= b.total,
                    BARRIER_DEADLINE)
            except TimeoutError:
                verdict_state = S_TIMEOUT

        # 屏障事件落证据
        with admin.cursor() as cur:
            cur.execute(
                "SELECT name,pid,role,event,at FROM shutree_sec.rehearsal_barrier_events ORDER BY id")
            ev.barrier_events = [
                {"name": r[0], "pid": r[1], "role": r[2], "event": r[3], "at": str(r[4])}
                for r in cur.fetchall()]

    except TimeoutError:
        verdict_state = S_TIMEOUT
    except Exception as e:  # noqa
        verdict_state = S_ABORT
        ev.sqlstates = getattr(e, "sqlstate", "ABORT")
    finally:
        for c in biz_conns + listener_conns:
            try:
                c.close()
            except Exception:
                pass
        for c in (monitor, admin):
            try:
                c.close()
            except Exception:
                pass

    # ---- 终态快照 + 不变量（app 只读连接）----
    rconn = connect_role(dsns, "app", autocommit=True)
    with rconn.cursor() as cur:
        cur.execute(
            "SELECT state,consumed_at IS NOT NULL,consumption_txid IS NOT NULL "
            "FROM shutree_sec.r2_evidence_consumption WHERE evidence_snapshot_id=%s", (str(ctx.sid),))
        row = cur.fetchone()
        ev.final_snapshot = {
            "state": row[0] if row else None,
            "consumed_has_txid": bool(row[1]) if row else False,
            "consumed_has_xid": bool(row[2]) if row else False,
        }
    ev.invariants = check_invariants(rconn, ctx)
    rconn.close()

    ev.ended_at = datetime.now(timezone.utc).isoformat()

    # ---- 证据完整性 + 判定（缺证据绝不 PASS）----
    need = ["pg_version", "started_at", "ended_at", "final_snapshot", "invariants"]
    for f in need:
        v = getattr(ev, f)
        if not v or v == "?":
            ev.missing_fields.append(f)
    if len(ev.sessions) != sc.sessions:
        ev.missing_fields.append("sessions_count")
    for sr in ev.sessions:
        if sr.backend_pid <= 0 or not sr.outcome:
            ev.missing_fields.append(f"session[{sr.label}]")
    ev.evidence_complete = (len(ev.missing_fields) == 0)

    if not ev.evidence_complete:
        ev.verdict = S_ABORT
    elif verdict_state in (S_TIMEOUT, S_ABORT, S_FAIL):
        ev.verdict = verdict_state
    elif not all(ev.invariants.values()):
        ev.verdict = S_FAIL
    elif any(sr.outcome.startswith("ABORT") for sr in ev.sessions):
        ev.verdict = S_ABORT
    elif barriers and any(b._flag(connect_role(dsns, "monitor", True), "completed") is False
                          for b in barriers.values()):
        ev.verdict = S_PARTIAL
    else:
        ev.verdict = S_PASS

    os.makedirs(run_dir, exist_ok=True)
    with open(os.path.join(run_dir, f"{sc.test_id}.json"), "w", encoding="utf-8") as f:
        json.dump(asdict(ev), f, ensure_ascii=False, indent=2, default=str)
    return ev


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="evidence", help="证据根目录（自动追加 run_id 子目录）")
    ap.add_argument("--only", default=None, help="仅跑指定 test_id，逗号分隔")
    args = ap.parse_args()
    dsns = role_dsns()
    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "_" + uuid.uuid4().hex[:6]
    run_dir = os.path.join(args.out, run_id)

    only = set(args.only.split(",")) if args.only else None
    summary = {"run_id": run_id, "psycopg_version": PSYCOPG_VERSION,
               "total": 0, S_PASS: 0, S_FAIL: 0, S_NORUN: 0, S_TIMEOUT: 0,
               S_ABORT: 0, S_PARTIAL: 0, "tests": []}
    for sc in SCENARIOS:
        if only and sc.test_id not in only:
            continue
        print(f"== {sc.test_id}: {sc.purpose}")
        ev = run_scenario(dsns, sc, run_dir, run_id)
        summary["total"] += 1
        summary[ev.verdict] = summary.get(ev.verdict, 0) + 1
        summary["tests"].append({"test_id": sc.test_id, "verdict": ev.verdict,
                                 "invariants": ev.invariants,
                                 "evidence_complete": ev.evidence_complete,
                                 "missing_fields": ev.missing_fields})
        print(f"   -> {ev.verdict}  state={ev.final_snapshot.get('state')}")

    with open(os.path.join(run_dir, "summary.json"), "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2, default=str)
    print(f"\n[runtime_dir] {run_dir}")
    print(f"合计 {summary['total']}：PASS {summary[S_PASS]} FAIL {summary[S_FAIL]} "
          f"TIMEOUT {summary[S_TIMEOUT]} ABORT {summary[S_ABORT]} PARTIAL {summary[S_PARTIAL]}")
    return 0 if (summary[S_PASS] == summary["total"]) else 1


if __name__ == "__main__":
    raise SystemExit(main())
