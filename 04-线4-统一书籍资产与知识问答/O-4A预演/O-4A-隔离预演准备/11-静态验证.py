#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
O-4A 第十轮 · 本地静态验证（不启动 PG、不执行 SQL、不连 R2）

仅做文本/结构级检查：
  1. 初始化脚本不存在「被 -- 注释掉的可执行 DDL/DML 关键字」。
  2. 括号/引号/dollar-quote 闭合；语句以分号结束。
  3. 三道闸门（O4A_AUTHORIZED + 6 个 *_pw）齐全；ON_ERROR_STOP 存在；事务 BEGIN/COMMIT 配对。
  4. 对象创建顺序正确：schema → 表 → FK 目标先行 → 函数 → 触发器 → 授权。
  5. TRG-01 具备 SECURITY DEFINER + search_path 锁定 + OWNER；verifier 无 consumption UPDATE 授权。
  6. 屏障状态机四状态齐全；notifies(timeout=, stop_after=) 是方法调用而非对生成器再调用；
     屏障场景用 ThreadPoolExecutor(max_workers=...) 重叠；无 time.sleep；psycopg3 版本下限声明。
  7. 测试套件角色 DSN 分离（fixture_admin/collector/verifier/monitor/app）。

注意：py_compile 只证明语法，本脚本是结构断言；二者都不是 PG 实测通过。
"""
from __future__ import annotations

import ast
import io
import re
import sys
import tokenize
from pathlib import Path

HERE = Path(__file__).resolve().parent
INIT = HERE / "03-init-cleanup.sql"
CLEAN = HERE / "03-cleanup.sql"
SUITE = HERE / "04-并发测试套件.py"

PASS: list[str] = []
FAIL: list[str] = []


def ck(cond: bool, msg: str) -> None:
    (PASS if cond else FAIL).append(msg)


def read(p: Path) -> str:
    return p.read_text(encoding="utf-8")


def strip_sql_comments(sql: str) -> str:
    """移除整行 -- 注释（保留行结构），用于检查注释掉的可执行语句。"""
    return "\n".join(
        "" if ln.lstrip().startswith("--") else ln for ln in sql.splitlines()
    )


def check_init() -> None:
    sql = read(INIT)
    code = strip_sql_comments(sql)

    # 1. 不存在被注释掉的可执行 DDL/DML（第十轮核心修复点）
    commented_kw = re.findall(
        r"^\s*--\s*(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|TRUNCATE|GRANT|REVOKE|BEGIN|COMMIT)\b",
        sql,
        flags=re.M | re.I,
    )
    ck(len(commented_kw) == 0,
       f"初始化脚本无被注释掉的可执行语句（命中 {len(commented_kw)} 处）")

    # 2. 结构闭合（忽略 dollar-quote 与字符串内的括号，做近似配平）
    code_nodollar = re.sub(r"\$fn\$|\$do\$", "", code)
    ck(code_nodollar.count("(") == code_nodollar.count(")"), "括号配平")
    ck(sql.count("$fn$") == 2, "$fn$ dollar-quote 成对")
    ck(sql.count("$do$") == 2, "$do$ dollar-quote 成对")

    # 3. 闸门 + fail-fast + 事务
    ck("O4A_AUTHORIZED" in sql, "授权闸门 O4A_AUTHORIZED 存在")
    for pw in ("collector_pw", "verifier_pw", "fixture_pw", "monitor_pw", "app_pw", "admin_pw"):
        ck(f"{pw}" in sql and "not provided" in sql, f"密码闸门 {pw} 存在")
    ck("\\set ON_ERROR_STOP on" in sql, "ON_ERROR_STOP fail-fast 存在")
    ck(re.search(r"^\s*BEGIN\s*;", code, re.M) is not None, "事务 BEGIN 存在")
    ck(re.search(r"^\s*COMMIT\s*;", code, re.M) is not None, "事务 COMMIT 存在")
    ck("\\quit" in sql, "闸门失败 quit 存在")

    # 4. 对象顺序（用首次出现位置）
    def pos(pat: str) -> int:
        m = re.search(pat, code, re.I)
        return m.start() if m else -1

    order = [
        (pos(r"CREATE SCHEMA\s+app"), "schema app"),
        (pos(r"CREATE SCHEMA\s+shutree_sec"), "schema shutree_sec"),
        (pos(r"CREATE TABLE\s+app\.object_outbox"), "object_outbox(FK目标)"),
        (pos(r"CREATE TABLE\s+shutree_sec\.evidence_signing_key"), "signing_key(FK目标)"),
        (pos(r"CREATE TABLE\s+shutree_sec\.r2_evidence_record"), "record"),
        (pos(r"CREATE TABLE\s+shutree_sec\.r2_evidence_verification"), "verification"),
        (pos(r"CREATE TABLE\s+shutree_sec\.r2_evidence_consumption"), "consumption"),
        (pos(r"CREATE OR REPLACE FUNCTION"), "TRG-01 function"),
        (pos(r"CREATE TRIGGER\s+trg_evidence_verification"), "TRG-01 trigger"),
        (pos(r"CREATE TABLE\s+shutree_sec\.rehearsal_barriers"), "barrier协调表"),
        # 用段 F 独有语句定位授权段，避免匹配到文件前部的 REVOKE ON SCHEMA
        (pos(r"GRANT INSERT ON shutree_sec\.r2_evidence_verification"), "授权段"),
    ]
    bad = [n for (p, n), (p2, n2) in zip(order, order[1:]) if p == -1 or p2 == -1 or p > p2]
    ck(not bad, f"对象创建顺序正确（异常：{bad}）")

    # 5. TRG-01 DEFINER + search_path + owner；verifier 无 consumption UPDATE
    fn_block = sql[sql.find("CREATE OR REPLACE FUNCTION"):sql.find("$fn$;")]
    ck("SECURITY DEFINER" in fn_block, "TRG-01 = SECURITY DEFINER")
    ck("SET search_path = pg_catalog, pg_temp" in fn_block, "TRG-01 search_path 锁定")
    ck("OWNER TO shutree_fn_owner" in sql, "TRG-01 owner=fn_owner")
    ck("REVOKE ALL ON FUNCTION shutree_sec.trg_evidence_verification_fn() FROM PUBLIC" in sql,
       "SECURITY DEFINER 函数 REVOKE PUBLIC EXECUTE")
    # verifier 的 UPDATE 授权只能出现在 barrier 表上，不能出现在 consumption 上
    bad_grant = re.findall(
        r"GRANT[^;]*UPDATE[^;]*r2_evidence_consumption[^;]*TO[^;]*evidence_verifier",
        sql, re.I | re.S)
    ck(len(bad_grant) == 0, "verifier 无 r2_evidence_consumption 的 UPDATE 授权")

    # 6. 屏障四状态
    for st in ("listener_ready", "participant_arrived", "barrier_released", "participant_completed"):
        ck(st in sql, f"屏障状态枚举 {st} 存在")


def _check_suite_calls(py: str) -> None:
    """用语法树核对调用形态。子串 notifies( / timeout= 挡不住「对生成器再调用」。"""
    tree = ast.parse(py)
    notifies_kw: list[set[str]] = []
    bad_lines: set[int] = set()
    pool_with_workers = False
    sleep_calls = 0
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        kw = {k.arg for k in node.keywords if k.arg}
        is_notifies = isinstance(func, ast.Attribute) and func.attr == "notifies"
        if is_notifies:
            notifies_kw.append(kw)
        # 缺陷形态：gen(timeout=..., stop_after=1)，gen 是名字而不是 .notifies
        if isinstance(func, ast.Name) and ({"timeout", "stop_after"} & kw):
            bad_lines.add(node.lineno)
        if "stop_after" in kw and not is_notifies:
            bad_lines.add(node.lineno)
        is_pool = (
            (isinstance(func, ast.Name) and func.id == "ThreadPoolExecutor")
            or (isinstance(func, ast.Attribute) and func.attr == "ThreadPoolExecutor")
        )
        if is_pool and "max_workers" in kw:
            pool_with_workers = True
        if (
            isinstance(func, ast.Attribute)
            and func.attr == "sleep"
            and isinstance(func.value, ast.Name)
            and func.value.id == "time"
        ):
            sleep_calls += 1
    ck(
        bool(notifies_kw) and all({"timeout", "stop_after"} <= kw for kw in notifies_kw),
        "每一处 notifies() 都是方法调用且带关键字 timeout 与 stop_after",
    )
    ck(not bad_lines, "timeout/stop_after 没有传给生成器或其他非 notifies 调用"
       + (f"（行 {sorted(bad_lines)}）" if bad_lines else ""))
    ck(pool_with_workers, "屏障重叠使用 ThreadPoolExecutor(max_workers=...)")
    ck(sleep_calls == 0, "套件不调用 time.sleep")



def _check_t16(py: str) -> None:
    """T16 不同 sid 并发独立：双 sid 预置 + 双 sid 校验，防数据准备残留回归。"""
    ck("sid_b" in py, "ScenarioCtx 含第二独立 sid（sid_b）")
    ck(re.search(r"b_diff_sid[\s\S]{0,600}?sid=ctx\.sid_b", py) is not None,
       "b_diff_sid 第二会话用 ctx.sid_b（非复用 ctx.sid）")
    # T16 fixture 段：两个 sid 各有 record 与 consumption 预置
    seg = py[py.find('sc.test_id == "T16"'):]
    seg = seg[:seg.find("plans = sc.builder")]
    ck(seg.count("fixture_records(") >= 2 and seg.count("fixture_consumption(") >= 2,
       "T16 fixture 为两个 sid 各预置 record 与 consumption")
    ck("sid=ctx.sid_b" in seg, "T16 fixture 使用 ctx.sid_b 预置第二组数据")
    # 不变量按场景声明覆盖：T16 只校验 I1/I6，不去无差别检查全七项
    ck('"I1":' in py and '"I6":' in py and "sid_override=ctx.sid_b" in py,
       "T16 不变量按声明覆盖 I1/I6 并对双 sid 校验")

def check_suite() -> None:
    py = read(SUITE)
    # 语法检查（tokenize 不做执行）
    try:
        list(tokenize.generate_tokens(io.StringIO(py).readline))
        ck(True, "测试套件 tokenize 语法通过")
    except Exception as e:  # noqa
        ck(False, f"测试套件 tokenize 语法失败: {e}")

    ck("psycopg" in py, "使用 psycopg（py3）")
    ck("3.2" in py, "声明 psycopg >= 3.2 版本依据")
    ck(re.search(r"\bconn\.wait\s*\(", py) is None, "不再使用误导性的 conn.wait() 等通知")
    _check_suite_calls(py)
    _check_t16(py)

    for role in ("fixture_admin", "collector", "verifier", "monitor", "app"):
        ck(role in py, f"角色 DSN 分离：{role}")

    # 状态协议与失败处理
    for st in ("listener_ready", "participant_arrived", "barrier_released", "participant_completed"):
        ck(st in py, f"测试套件含屏障状态 {st}")

    # summary 状态识别
    for st in ("NO_RUN", "TIMEOUT", "ABORT", "PARTIAL", "PASS", "FAIL"):
        ck(st in py, f"summary 状态词 {st} 存在")


def check_cleanup() -> None:
    sql = read(CLEAN)
    ck("O4A_AUTHORIZED" in sql, "清理脚本有授权闸门")
    ck("DROP SCHEMA IF EXISTS shutree_sec CASCADE" in sql, "清理脚本 DROP shutree_sec")
    ck("DROP SCHEMA IF EXISTS app CASCADE" in sql, "清理脚本 DROP app")


def main() -> int:
    check_init()
    check_suite()
    check_cleanup()
    print(f"PASS = {len(PASS)}  FAIL = {len(FAIL)}")
    for m in FAIL:
        print("  [FAIL]", m)
    if FAIL:
        print("静态验证未通过（注意：即便通过也不代表 PG 实测）", file=sys.stderr)
        return 1
    print("静态结构验证通过（非 PG 实测，非并发测试通过证据）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
