#!/usr/bin/env python3
"""
WP-02/03/04 语义审计轮 · 升级后的独立静态验证工具（只读，零外部依赖）

本校验器【继承】而不删除旧断言：
  * 通过 import 调用 verify_stage_specs.main()  → 继承 66 项
  * 通过 import 调用 verify_stage_evidence.main() → 继承 139 项
  * 再叠加本轮新增的语义断言（sem/*）
  * 合计 = 66 + 139 + N；三项分别统计，任一失败即 exit 1

新增断言覆盖（任务书 §五）：
  1. 交叉引用不只是「存在」，还要检查语义映射（CK/WF × FI 三要素匹配）
  2. 不只检查 SQL 对象数量，还检查关键字段/状态转换/权限/约束关系
  3. 不只检查锁顺序文本存在，还逐条检查每个事务路径的锁顺序
  4. WP-03 两维分类建立严格枚举约束 + 派生一致性 + 漂移显式登记
  5. WP-04 恢复目标与 manifest 的数据归属一致性
  6. 跨报告 / 注册表 / SQL 草稿的双向一致性
  7. 保留旧 66/139 项（见上）
  8. 新增断言必须有真实失败样例 → 见 verify_semantics_fixtures.py

本脚本【不】做且【不声称】做：
  * 不连接 PostgreSQL / Cloudflare R2，不执行任何 SQL / DDL / DML / API 调用
  * 不验证运行时行为、不验证官方文档当前可达性
  * 不修改任何文件（只读取）

通过只能记为「静态一致性自动化测试通过」，绝不等于
L4 PG 实际验证 / L5 R2 实际验证 / L6 阶段准入通过。

用法：
  python verify_stage_semantics.py            # 逐项输出
  python verify_stage_semantics.py --json    # 机器可读
  python verify_stage_semantics.py --list    # 只列新增断言名
退出码：0 = 全部通过；1 = 存在失败项
"""
from __future__ import annotations

import argparse
import contextlib
import copy
import importlib
import io
import json
import re
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REG_FILE = ROOT / "stage_evidence_registry.json"
BASE_REG = ROOT / "stage_spec_registry.json"
SQL_DRAFT_V2 = ROOT / "WP-02-隔离SQL草稿-禁止执行.sql.draft"
SQL_DRAFT_V3 = ROOT / "WP-02-语义修正设计资产-禁止执行.sql.draft"
REPORT_V2 = ROOT / "阶段推进-WP02-03-04深化与执行准备闭环-全量交付报告.md"
REPORT_V3 = ROOT / "阶段推进-WP02-03-04语义审计与修正-全量交付报告.md"

# 本轮唯一权威枚举（注册表 / 报告 / 校验器三处字面必须一致）
A_ENUM = frozenset({
    "explicitly_supported", "conditionally_supported", "officially_unimplemented",
    "officially_unstated", "officially_documented_risk",
})
B_ENUM = frozenset({
    "official_evidence_only", "static_verification", "real_r2_test",
    "currently_unverifiable",
})
DERIVE = {
    "explicitly_supported": "guaranteed_with_caveat",
    "conditionally_supported": "partial_guaranteed",
    "officially_unimplemented": "not_guaranteed",
    "officially_unstated": "not_guaranteed",
    "officially_documented_risk": "risk_documented",
}
# 禁止出现的旧同义枚举（防止三处混用）
FORBIDDEN_SYNONYMS = frozenset({
    "guaranteed", "partial", "not_supported", "unsupported", "risk",
    "supported_with_caveat", "partial_supported", "no_guarantee",
})


def _load_legacy(module_name: str) -> list[tuple[str, bool, str]]:
    """import 旧校验器并调用其 main()，读取其全局 results → 继承旧断言。"""
    mod = importlib.import_module(module_name)
    mod.results.clear()
    old_argv = sys.argv
    try:
        sys.argv = [module_name]
        with contextlib.redirect_stdout(io.StringIO()):
            mod.main()
    finally:
        sys.argv = old_argv
    return list(mod.results)


def semantic_assertions(data: dict, ctx: dict | None = None) -> list[tuple[str, bool, str]]:
    """
    本轮新增语义断言。纯函数：只依赖传入的 data（注册表内容）与 ctx（文件文本），
    因此可被 verify_semantics_fixtures.py 用「注入缺陷的副本」重复调用，
    用来证明每条新断言确实能抓住对应缺陷。
    """
    out: list[tuple[str, bool, str]] = []

    def ck(name: str, ok: bool, detail: str = "") -> None:
        out.append((name, bool(ok), detail))

    S = data.get("semantic_audit", {})
    ctx = ctx or {}

    # ================= 1. 锁与并发模型 =================
    lm = S.get("wp02_lock_model", {})
    scen = lm.get("scenarios", [])
    by_id = {s["id"]: s for s in scen}
    ck("sem/lock_scenarios_count", len(scen) == 8, f"实际 {len(scen)}")
    ck("sem/lock_ids", set(by_id) == {f"LW-{i:02d}" for i in range(1, 9)})
    ck("sem/lock_levels_lo0_lo4",
       [x["id"] for x in lm.get("lock_levels", [])] == [f"LO-{i}" for i in range(5)])
    # 核心纠错：LW-02 必须判为普通阻塞，不得写成死锁
    w2 = by_id.get("LW-02", {})
    ck("sem/lock_LW02_is_blocking_not_deadlock",
       w2.get("outcome") == "blocking" and w2.get("has_cycle") is False
       and w2.get("sqlstate") is None,
       "不同主行先锁再争同一共享槽位 = 普通阻塞")
    ck("sem/lock_LW02_no_whole_tx_rollback",
       w2.get("whole_tx_rollback") is False
       and "COMMIT" in str(w2.get("loser", "")),
       "败者以幂等 COMMIT 退出，不是两者回滚")
    # 真死锁必须成环，且只中止一个事务
    w3 = by_id.get("LW-03", {})
    ck("sem/lock_LW03_has_cycle",
       w3.get("has_cycle") is True and w3.get("outcome") == "deadlock"
       and w3.get("sqlstate") == "40P01")
    ck("sem/lock_deadlock_single_abort",
       ("其中一个" in str(w3.get("detail", "")) or "one of the transactions" in str(w3.get("detail", "")))
       and "abort" in str(w3.get("detail", "")).lower()
       and "继续" in str(w3.get("winner", ""))
       and "ROLLBACK" in str(w3.get("loser", "")),
       "PG 只 abort 一个事务，胜者继续并可提交")
    ck("sem/lock_deadlock_wait_cycle",
       set(w3.get("wait_edges", [])) >= {"T1->T2", "T2->T1"})
    # 区分 lock_timeout / deadlock_timeout
    w4, w5 = by_id.get("LW-04", {}), by_id.get("LW-05", {})
    ck("sem/lock_timeout_is_statement_level",
       w4.get("outcome") == "lock_timeout" and w4.get("whole_tx_rollback") is False
       and "语句" in str(w4.get("detail", "")),
       "lock_timeout 是语句级，不自动整事务回滚")
    ck("sem/deadlock_timeout_is_detection_interval",
       w5.get("outcome") == "continue_waiting" and w5.get("has_cycle") is False
       and "检查" in str(w5.get("detail", "")),
       "deadlock_timeout 是检测间隔，不是超时")
    ck("sem/lock_all_scenarios_have_hold_order",
       all("hold_order" in s and "wait_edges" in s and "whole_tx_rollback" in s
           and "outcome" in s for s in scen))
    ck("sem/lock_failure_matrix_corrected",
       "相反顺序" in lm.get("corrected_failure_matrix_row", {}).get("scenario", "")
       and "仅中止其中" in lm.get("corrected_failure_matrix_row", {}).get("expected", ""))
    ck("sem/lock_invariants_consistent_order",
       any("一致顺序" in x or "无死锁环" in x for x in lm.get("invariants", [])))

    # ================= 2. SQL 语义关系（不只看数量） =================
    sq = S.get("wp02_sql_semantic_audit", {})
    objs = sq.get("objects", [])
    ck("sem/sql_objects_count", len(objs) == 9, f"实际 {len(objs)}")
    ck("sem/sql_objects_all_have_preconditions",
       all(o.get("preconditions") for o in objs))
    ck("sem/sql_dependency_order_complete",
       len(sq.get("object_dependency_order", [])) >= 10
       and any("CREATE SCHEMA" in x for x in sq["object_dependency_order"])
       and any("CREATE ROLE" in x for x in sq["object_dependency_order"]))
    issues = sq.get("triggers", [])
    # 编号在 id 字段、严重度在 issue 字段；两者都要检查（修复只查 issue 的实现 bug）
    declared_ids = {t.get("id", "") for t in issues}
    ck("sem/sql_p0_findings_declared",
       all(k in declared_ids for k in ("TRG-01", "TRG-02", "TRG-09"))
       and sum(1 for t in issues if t.get("issue", "").startswith("P0")) == 3,
       "3 项 P0 均有编号与严重度登记")
    ck("sem/sql_trg01_idempotent_fix",
       any(t["id"] == "TRG-01" and "幂等" in t.get("fix", "")
           and "COUNT(DISTINCT channel)=6" in t.get("fix", "") for t in issues))
    ck("sem/sql_trg02_insert_guard_fix",
       any(t["id"] == "TRG-02" and "BEFORE INSERT" in t.get("fix", "") for t in issues))
    ck("sem/sql_trg09_missing_column_declared",
       any("TRG-09" in t["id"] and "origin_outbox_id" in t.get("detail", "") for t in issues))
    ck("sem/sql_function_grant_chain_declared",
       "占位符" in sq.get("functions", {}).get("issue", ""))
    fsum = sq.get("findings_summary", {})
    ck("sem/sql_findings_p0_count", len(fsum.get("P0", [])) == 3)
    ck("sem/sql_findings_all_static",
       "静态语义推演" in fsum.get("note", ""))
    # 注册表 ↔ 设计资产字段一致性
    design_asset = S.get("wp02_sql_semantic_audit", {}).get("design_asset", "")
    ck("sem/sql_design_asset_declared", "禁止执行" in design_asset and ".sql.draft" in design_asset)
    v3 = ctx.get("sql_v3", "")
    ck("sem/sql_v3_marked_do_not_execute",
       "DO NOT EXECUTE" in v3 and "禁止执行" in v3 and ".sql.draft" in v3)
    ck("sem/sql_v3_has_trg01_idempotent_body",
       "GET DIAGNOSTICS" in v3 and "v_channels = 6" in v3
       and "不】使用 RETURNING ... INTO STRICT" in v3)
    ck("sem/sql_v3_has_insert_guard",
       "BEFORE INSERT OR UPDATE OR DELETE" in v3 and "terminal_state_not_insertable" in v3)
    # 仅【可执行 GRANT 行】不得含占位符；缺陷说明里引用旧占位符文字是允许的
    grant_lines = [ln for ln in v3.splitlines()
                   if re.search(r"^\s*--?\s*GRANT\s+EXECUTE", ln)]
    ck("sem/sql_v3_grants_named_roles",
       "GRANT  EXECUTE ON FUNCTION" in v3 and "shutree_terminality_exec" in v3
       and bool(grant_lines)
       and all("<" not in ln and ">" not in ln for ln in grant_lines),
       "GRANT 给具名角色，可执行行无占位符")
    ck("sem/sql_v3_origin_column_fix",
       "ADD COLUMN origin_outbox_id" in v3)
    ck("sem/sql_v3_all_transaction_paths",
       all(f"PATH {p}" in v3 for p in (
           "T-TERMINALIZE", "T-CROSSGEN-DECIDE", "T-REQUEUE",
           "T-KEY-REVOKE", "settleErrorEvent", "TRG-01")))
    # 逐路径锁顺序：所有写路径必须是 LO-0..LO-4 的升序子序列
    path_lines = re.findall(r"^-- PATH ([^:]+)\s*:\s*(.+)$", v3, re.M)
    def lo_seq(txt: str) -> list[int]:
        return [int(x) for x in re.findall(r"LO-(\d)", txt)]
    write_paths = [(n.strip(), lo_seq(v)) for n, v in path_lines
                   if not n.strip().startswith("sp_recovery")]
    ck("sem/lock_path_count", len(write_paths) >= 6, f"实际 {len(write_paths)}")
    ck("sem/lock_paths_monotonic",
       all(seq == sorted(seq) for _, seq in write_paths),
       "每条路径取锁顺序单调递增（含只读路径的合法子序列）")
    # TRG-01 复核推进在复核 INSERT 事务内，由该事务已持有的 LO-0 覆盖，
    # 因此其局部序列以 LO-1 起手是合法的；其余写路径必须以 LO-0 起手。
    ck("sem/lock_paths_start_lo0",
       all((seq and seq[0] == 0) for name, seq in write_paths
           if not name.startswith("TRG-01")),
       "写路径一律以 LO-0 advisory 起手（TRG-01 在复核事务内除外）")

    # ================= 3. WP-03 两维严格枚举 =================
    tax = S.get("wp03_evidence_taxonomy", {})
    A = set(tax.get("dimension_A", {}).get("enum", []))
    B = set(tax.get("dimension_B", {}).get("enum", []))
    ck("sem/wp03_A_enum_exact", A == set(A_ENUM), f"A={sorted(A)}")
    ck("sem/wp03_B_enum_exact", B == set(B_ENUM), f"B={sorted(B)}")
    ck("sem/wp03_enum_no_synonym_mix",
       not (A & FORBIDDEN_SYNONYMS) and not (B & FORBIDDEN_SYNONYMS)
       and not (A & B),
       "两枚举互斥且无旧同义别名")
    pm = tax.get("probe_matrix", [])
    ck("sem/wp03_probe_matrix_count", len(pm) == 13)
    ck("sem/wp03_probe_ids",
       [p["id"] for p in pm] == [f"U4-{i:02d}" for i in range(1, 14)])
    ck("sem/wp03_all_A_in_enum", all(p["dimension_A"] in A_ENUM for p in pm))
    ck("sem/wp03_all_B_in_enum", all(p["dimension_B"] in B_ENUM for p in pm))
    ck("sem/wp03_derive_rule_complete",
       tax.get("derive_rule", {}) == DERIVE)
    # 探针字段 ↔ matrix 双向一致
    probes = {p["id"]: p for p in data.get("wp03_probes", [])}
    ck("sem/wp03_probe_fields_match_matrix",
       all(p["dimension_A_evidence_nature"] == m["dimension_A"]
           and p["dimension_B_verification_requirement"] == m["dimension_B"]
           for m in pm for p in [probes.get(m["id"], {})]))
    # 派生一致性 + 漂移必须显式登记
    drift = {d["id"]: d for d in tax.get("legacy_semantic_drift", [])}
    actual_drift = {m["id"] for m in pm
                    if m["legacy_classification"] != DERIVE[m["dimension_A"]]}
    ck("sem/wp03_drift_all_declared",
       set(drift) == actual_drift and len(actual_drift) == 3,
       f"实际偏差 {sorted(actual_drift)} / 登记 {sorted(drift)}")
    ck("sem/wp03_drift_has_official_basis",
       all(d.get("basis") and d.get("why") for d in drift.values()))
    ck("sem/wp03_no_rewrite_of_legacy",
       all(m["legacy_classification"] == probes[m["id"]]["classification"] for m in pm),
       "旧 classification 未被改写，仅降级为派生视图")
    ck("sem/wp03_official_recheck_no_overreach",
       "未说明" in tax.get("official_recheck", {}).get("version_id", "")
       and "不得推导" in tax.get("official_recheck", {}).get("version_id", "")
       and "不得把 S3 API 兼容性推导为完整实现" in
           tax.get("official_recheck", {}).get("request_level_forensics", ""))
    # 报告表格 ↔ 注册表枚举字面一致（双向）。
    # 断言【始终执行】：报告缺失必须判 FAIL，不得静默跳过（否则断言总数随文件存在与否漂移，
    # 且等于对「报告未交付」这一缺陷放宽校验）。
    rep = ctx.get("report_v3", "")
    ck("sem/cross_report_enum_literals",
       bool(rep) and all(e in rep for e in A_ENUM) and all(e in rep for e in B_ENUM),
       "报告含全部 9 个权威枚举字面")
    ck("sem/cross_report_no_legacy_enum_as_authority",
       bool(rep) and ("唯一权威" in rep or "权威枚举" in rep),
       "报告明确声明两维枚举为唯一权威")

    # ================= 4. WP-04 恢复目标与 manifest 数据归属 =================
    own = S.get("wp04_manifest_ownership", {})
    corr = own.get("correction", {})
    ck("sem/manifest_T_not_backup_intrinsic",
       "否" in next((a["a"] for a in own.get("answers", [])
                     if "recovery_target_lsn" in a["q"]), ""),
       "T 不是备份固有属性")
    ck("sem/manifest_multiple_T_allowed",
       "允许" in next((a["a"] for a in own.get("answers", [])
                       if "不同 T" in a["q"]), ""))
    ck("sem/manifest_remove_T_column",
       any("recovery_target_lsn" in x for x in corr.get("manifest_remove", [])))
    ck("sem/manifest_keep_backup_intrinsic",
       all(k in corr.get("manifest_keep", []) for k in
           ("backup_start_lsn", "backup_stop_lsn", "backup_end_time")))
    ck("sem/manifest_constraint_relocated",
       "sp_recovery_precheck" in corr.get("constraint_relocation", "")
       and "跨表" in corr.get("constraint_relocation", ""))
    runs = corr.get("recovery_runs_table", {})
    ck("sem/recovery_runs_1_to_N",
       "1 : N" in runs.get("cardinality", "") or "1 : N" in str(runs))
    ck("sem/recovery_runs_has_actual_stop_fields",
       all(k in " ".join(runs.get("columns", [])) for k in
           ("actual_stop_lsn", "actual_stop_time", "actual_timeline", "verification_result")))
    ck("sem/recovery_runs_outside_cluster",
       "之外" in runs.get("placement", ""))
    ck("sem/manifest_official_basis",
       any("must be reset" in x for x in own.get("official_basis", [])))
    ck("sem/sql_v3_manifest_no_T",
       "--     backup_start_lsn" in v3
       and "--     recovery_target_lsn" not in v3
       and "recovery_runs" in v3
       and "【移除】recovery_target_lsn" in v3)

    # ================= 5. FI 语义覆盖（不靠编号相同） =================
    cov = S.get("wp04_fi_semantic_coverage", {})
    mat = cov.get("matrix", [])
    subs = cov.get("new_subcases", [])
    ck("sem/fi_matrix_16_checkpoints", len(mat) == 16)
    ck("sem/fi_matrix_ids",
       [m["id"] for m in mat] ==
       [f"CK-{i:02d}" for i in range(1, 9)] + [f"WF-{i:02d}" for i in range(1, 9)])
    ck("sem/fi_three_checks_declared",
       len(cov.get("rule", {}).get("three_checks", [])) == 3)
    # 三要素一致的项才能判 matched —— 这是「不能只凭编号」的核心断言
    ck("sem/fi_matched_iff_three_checks",
       all((m["legacy_verdict"] == "matched") ==
           (m["object_match"] and m["injection_match"] and m["outcome_match"])
           for m in mat))
    ck("sem/fi_mismatched_all_have_action",
       all(m["action"] in ("rebind", "add_subcase", "gap")
           and m["rationale"] for m in mat if m["legacy_verdict"] == "mismatched"))
    ck("sem/fi_all_refs_resolvable",
       all(r in ctx.get("resolvable_ids", set()) for m in mat for r in m["semantic_refs"]),
       "语义引用全部可解析（含新增子用例）")
    ck("sem/fi_subcases_13", len(subs) == 13)
    ck("sem/fi_subcases_not_counted",
       all(s.get("counted_in_parent_215") is False for s in subs)
       and all(s.get("verification_status", "").startswith("用例定义") for s in subs))
    ck("sem/fi_subcases_five_fields",
       all(all(str(s.get(k, "")).strip() for k in
               ("test_object", "injection", "expected_result", "rollback_required"))
           and isinstance(s.get("needs_pg"), bool) for s in subs))
    ck("sem/fi_subcases_bound_checkpoints",
       all(set(s["bound_checkpoint"]) <= {m["id"] for m in mat} for s in subs))
    ck("sem/fi_parent_count_unchanged",
       len(data.get("fault_injections_215", [])) == 215
       and data.get("fi_summary", {}).get("total") == 215
       and cov.get("summary", {}).get("deleted") == 0)
    ck("sem/fi_summary_numbers_consistent",
       cov.get("summary", {}).get("checkpoints") == 16
       and cov["summary"]["matched"] + cov["summary"]["partial"]
           + cov["summary"]["mismatched"] == 16)

    # ================= 6. 跨文件双向一致性 & 准入 =================
    ck("sem/cross_sql_v2_still_intact",
       "DO NOT EXECUTE" in ctx.get("sql_v2", "")
       and "此文件从未被任何数据库执行" in ctx.get("sql_v2", ""))
    ck("sem/cross_report_v2_still_intact",
       "139 / 139" in ctx.get("report_v2", ""))
    ck("sem/cross_registry_v1_intact",
       ctx.get("base_reg", {}).get("schema_version") == "1.0"
       or bool(ctx.get("base_reg", {}).get("dag")))
    ck("sem/maturity_no_upgrade",
       data.get("maturity_levels", {}).get("L4_pg_verified") is False
       and data.get("maturity_levels", {}).get("L5_r2_verified") is False
       and data.get("maturity_levels", {}).get("L6_stage_admission_passed") is False
       and data.get("admission", {}).get("upgraded_this_round") is False)
    ck("sem/no_v1231",
       not list(ROOT.glob("V1.2.31*")))

    # ================= 7. 其他无需授权推进（可观测性等） =================
    ext = S.get("other_no_auth_work", {})
    ck("sem/other_no_auth_declared", bool(ext) and len(ext.get("work_items", [])) >= 5)
    ck("sem/other_no_auth_has_observability",
       any("漂移" in str(w) or "可观测" in str(w) for w in ext.get("work_items", [])))
    ck("sem/other_no_auth_no_real_env_claim",
       all("未执行" in str(w) or "静态" in str(w) for w in ext.get("work_items", [])))
    plan = S.get("next_batch_plan", {})
    ck("sem/next_batch_plan_declared", len(plan.get("items", [])) >= 4)
    ck("sem/next_batch_no_owner_gate",
       all(not i.get("needs_owner_authorization") for i in plan.get("items", [])))

    # ================= 8. WP-03 原子能力粒度 + 派生一致性 =================
    tax = S.get("wp03_evidence_taxonomy", {})
    acm = tax.get("atomic_capability_model", {})
    probes = data.get("wp03_probes", []) or []
    A_ORDER = ["explicitly_supported", "conditionally_supported",
               "officially_documented_risk", "officially_unstated",
               "officially_unimplemented"]
    B_ORDER = ["official_evidence_only", "static_verification",
               "real_r2_test", "currently_unverifiable"]

    def _derive_A(caps):
        cls = {c.get("official_evidence_class") for c in caps}
        for a in A_ORDER:
            if a in cls:
                return a
        return "explicitly_supported"

    def _derive_B(caps):
        reqs = [c.get("verification_requirement") for c in caps]
        idx = [B_ORDER.index(r) for r in reqs if r in B_ORDER]
        return max(idx) if idx else 0

    ck("sem/wp03_atomic_model_present",
       bool(acm) and acm.get("counts", {}).get("probes") == 13
       and acm.get("counts", {}).get("atomic_total") == 40
       and acm.get("counts", {}).get("multi_capability_probes") == 12)
    ck("sem/wp03_probes_count", len(probes) == 13, f"实际 {len(probes)}")
    caps_all = [c for p in probes for c in p.get("capability_assertions", [])]
    ck("sem/wp03_probes_have_caps",
       all(isinstance(p.get("capability_assertions"), list)
           and len(p["capability_assertions"]) > 0 for p in probes))
    ck("sem/wp03_atomic_total_40", len(caps_all) == 40, f"实际 {len(caps_all)}")
    model_fields = acm.get("fields", [])
    ck("sem/wp03_cap_fields_complete",
       bool(model_fields)
       and all(all(k in c and str(c.get(k, "")).strip() for k in model_fields)
                and c.get("official_evidence_class") in A_ENUM
                and c.get("verification_requirement") in B_ENUM
                for c in caps_all))
    # 逐探针重算 derive_A/B 与 overall_derived 比对（派生正确性）
    derive_ok = True
    for p in probes:
        caps = p.get("capability_assertions", [])
        od = p.get("overall_derived", {})
        if not caps or od.get("dimension_A_evidence_nature") != _derive_A(caps):
            derive_ok = False
        if B_ORDER.index(od.get("dimension_B_verification_requirement", "")) != _derive_B(caps):
            derive_ok = False
    ck("sem/wp03_derive_A_B_consistent", derive_ok)
    # 注册表自报计数与实测一致（跨交付物一致性）
    multi = [p for p in probes if len(p.get("capability_assertions", [])) > 1]
    ck("sem/wp03_counts_cross_consistent",
       acm.get("counts", {}).get("probes") == len(probes)
       and acm.get("counts", {}).get("atomic_total") == len(caps_all)
       and acm.get("counts", {}).get("multi_capability_probes") == len(multi))
    # 未说明 ≠ 未实现：两类都必须存在，且模型显式声明该纪律
    classes = {c.get("official_evidence_class") for c in caps_all}
    ck("sem/wp03_unstated_ne_unimplemented",
       "officially_unstated" in classes and "officially_unimplemented" in classes
       and "unstated_not_unimplemented" in acm)
    # 多能力不压缩：len>1 的探针数 =12；整体仍保留原子粒度
    ck("sem/wp03_multi_cap_count", len(multi) == 12, f"实际 {len(multi)}")
    ck("sem/wp03_multi_cap_not_collapsed",
       all(isinstance(p.get("overall_derived", {}).get("atomic_classes"), list)
           and set(p["overall_derived"]["atomic_classes"])
              == {c.get("official_evidence_class") for c in p["capability_assertions"]}
           for p in multi))
    # conditionally_supported 必须保留 limitation（有条件支持不能掩盖限制）
    ck("sem/wp03_conditional_keeps_limitation",
       all(str(c.get("limitation", "")).strip()
           for c in caps_all
           if c.get("official_evidence_class") == "conditionally_supported"))
    # 官方支持 + 必须实测 可同时成立
    coexist = any(p.get("overall_derived", {}).get("dimension_A_evidence_nature") == "explicitly_supported"
                  and p.get("overall_derived", {}).get("dimension_B_verification_requirement") == "real_r2_test"
                  for p in probes)
    ck("sem/wp03_supported_and_test_coexist", coexist)
    # 保留历史 classification，不覆盖、不掩盖
    ck("sem/wp03_keep_legacy",
       all("classification" in p or "legacy_classification" in p for p in probes)
       and "keep_legacy" in acm and "drift_handling" in tax)

    # ================= 9. FI-S 依赖标记（PG / R2 两侧必须显式） =================
    fi_subs = S.get("wp04_fi_semantic_coverage", {}).get("new_subcases", [])
    fi_by_id = {s["id"]: s for s in fi_subs}
    ck("sem/fi_s_06_07_r2",
       fi_by_id.get("FI-S-06", {}).get("needs_r2") is True
       and fi_by_id.get("FI-S-06", {}).get("needs_pg") is True
       and fi_by_id.get("FI-S-07", {}).get("needs_r2") is True
       and fi_by_id.get("FI-S-07", {}).get("needs_pg") is True)
    pure_pg = [f"FI-S-{i:02d}" for i in list(range(1, 6)) + list(range(8, 14))]
    ck("sem/fi_s_pure_pg",
       all(fi_by_id.get(fid, {}).get("needs_pg") is True
           and fi_by_id.get(fid, {}).get("needs_r2") is False for fid in pure_pg))

    # ================= 10. recovery_runs 跨库逻辑引用（替代物理 FK） =================
    ck("sem/recovery_runs_no_physical_fk",
       "REFERENCES shutree_sec.backup_manifests(manifest_id)" not in v3)
    ck("sem/recovery_runs_logical_ref",
       "manifest_content_sha256" in v3 and "manifest_hmac" in v3
       and "manifest_verified" in v3)
    ck("sem/recovery_runs_verify_fn",
       "sp_verify_recovery_manifest" in v3
       and "'pending_external'" in v3 and "'unverifiable'" in v3)

    # ================= 11. TRG-01 六通道幂等可达性（设计资产层面） =================
    ck("sem/trg01_dual_branch_idempotent",
       "GET DIAGNOSTICS v_rows = ROW_COUNT" in v3
       and "count(DISTINCT r.channel)" in v3
       and "= 6" in v3)
    ck("sem/trg01_no_strict_on_first",
       "此处【不】使用 RETURNING ... INTO STRICT" in v3
       or "不】使用 RETURNING" in v3)
    ck("sem/trg01_consumable_atomic",
       "IF v_channels = 6 THEN" in v3 and "state = 'consumable'" in v3)

    # ================= 12. WP-02 跨库核验架构（真实执行边界） =================
    cdb = S.get("wp02_cross_db_verification", {})
    arch = cdb.get("arch", {})
    ck("sem/cdb_arch_two_db_explicit",
       arch.get("backup_manifests_location") == "DB-A"
       and arch.get("recovery_runs_location") == "DB-B"
       and arch.get("backup_manifests_location") != arch.get("recovery_runs_location"))
    ck("sem/cdb_arch_verify_fn_same_db_as_runs",
       arch.get("verify_fn_location") == arch.get("recovery_runs_location") == "DB-B")
    ck("sem/cdb_arch_no_plain_cross_db_query",
       arch.get("no_plain_pg_cross_db_query") is True
       and arch.get("cross_db_access_method") in
       ("controlled_fdw", "control_plane_worker",
        "controlled_fdw_or_control_plane_worker"))
    ck("sem/cdb_arch_initiator_named",
       arch.get("initiator") == "control_plane_worker")
    ck("sem/cdb_arch_network_fail_no_failopen",
       arch.get("network_failure_handling") == "pending_external_no_fail_open")

    # ================= 13. 核验协议字段 + 四者严格区分 =================
    fields = cdb.get("protocol_fields", [])
    ck("sem/cdb_proto_fields_complete", len(fields) == 15)
    fw = cdb.get("four_way_distinction", {})
    mechs = [fw.get("content_digest"), fw.get("hmac"),
             fw.get("asymmetric_signature"), fw.get("auth_identity")]
    ck("sem/cdb_proto_four_way_distinct", len(set(mechs)) == 4 and all(mechs))
    ck("sem/cdb_proto_key_id_version_present",
       cdb.get("key_id_version_required") is True
       and "key_id" in fields and "key_version" in fields)
    ck("sem/cdb_proto_binding_complete",
       "recovery_run_id" in cdb.get("binding_fields", [])
       and all(b in fields for b in cdb.get("binding_fields", [])))

    # ================= 14. 跨库核验 13 场景（未知态不自动成功） =================
    sc = cdb.get("scenarios_13", [])
    ck("sem/cdb_scenarios_13_count", len(sc) == 13)
    ck("sem/cdb_scenarios_unknown_stays_pending",
       cdb.get("unknown_stays_non_success") is True
       and all(s.get("expected_status") in
               ("verified", "pending_external", "unverifiable") for s in sc))
    ck("sem/cdb_scenarios_no_auto_success",
       sum(1 for s in sc if s.get("expected_status") == "verified") <= 2)

    # ================= 15. TRG-01 事务模型（行锁归属 / 串行化点） =================
    tr = S.get("trg01_concurrency_proof", {})
    tm = tr.get("transaction_model", {})
    rc = tr.get("read_committed_visibility", {})
    rl = tm.get("row_lock") or {}
    ck("sem/trg01_txn_model_row_lock_named",
       rl.get("table") == "r2_evidence_consumption"
       and "FOR UPDATE" in rl.get("by_sql", "")
       and rl.get("held_until") in
       ("commit_or_rollback", "COMMIT/ROLLBACK"))
    ck("sem/trg01_txn_model_serialization_point",
       bool(tm.get("serialization_point")))
    ck("sem/trg01_txn_model_not_serializable_dependent",
       tm.get("relies_on_serializable") is False
       and rc.get("depends_on_serializable") is False)

    # ================= 16. TRG-01 十并发时间线（字段完整 / 提交边界） =================
    tl = tr.get("ten_timelines", [])
    ck("sem/trg01_ten_timelines_count", len(tl) == 10)
    ck("sem/trg01_ten_timelines_each_has_fields",
       all(all(k in t for k in
               ("sql_order", "locks", "wait_graph", "visible_data",
                "commit_or_rollback", "final_state")) for t in tl))
    ck("sem/trg01_ten_timelines_commit_boundary",
       all(t.get("commit_or_rollback") in
           ("commit", "rollback", "commit_or_rollback") for t in tl))

    # ================= 17. SQL 草稿文本级跨库 + TRG-01 RC 复核（补 §10/§11） =====
    v3 = ctx.get("sql_v3", "")
    ck("sem/cdb_sql_no_plain_cross_db_query",
       "FROM audit_store" not in v3
       and "p_live_content_sha256" in v3
       and "控制平面 Worker" in v3)
    ck("sem/cdb_sql_arch_positions", "DB-A" in v3 and "DB-B" in v3)
    ck("sem/cdb_sql_proto_15_fields",
       all(f in v3 for f in (
           "manifest_content_sha256", "manifest_hmac", "manifest_signature",
           "key_id", "key_version", "algorithm", "backup_id", "recovery_run_id",
           "requested_target_lsn", "actual_stop_lsn", "timeline",
           "verification_status", "verified_at", "verification_error",
           "manifest_id")))
    ck("sem/cdb_sql_13_scenarios",
       all(f"场景 {i}" in v3 for i in range(1, 14)))
    ck("sem/trg01_sql_rc_visibility",
       "READ COMMITTED" in v3 and "FOR UPDATE" in v3 and "串行化点" in v3)
    ck("sem/trg01_sql_ten_timelines",
       all(f"时间线 {i}" in v3 for i in range(1, 11)))

    # ================= 18. WP-02 跨库唯一方案定案 + 完整协议 + TOCTOU/重放/密钥 (R8) =================
    cdb = S.get("wp02_cross_db_verification", {})
    tr = S.get("trg01_concurrency_proof", {})
    arch = cdb.get("arch", {})
    v3 = ctx.get("sql_v3", "")

    # 唯一方案：控制平面 Worker（删除二选一 / FDW 不作为跨库机制）
    ck("sem/cdb_arch_unique_worker",
       arch.get("cross_db_access_method") == "control_plane_worker")
    ck("sem/cdb_arch_no_fdw_option",
       arch.get("cross_db_access_method") not in
       ("controlled_fdw", "controlled_fdw_or_control_plane_worker"))
    ck("sem/cdb_arch_flags_present",
       arch.get("access_method_unique") is True
       and arch.get("fdw_not_used_as_cross_db_mechanism") is True)

    # 协议版本 + 请求绑定 + 身份认证独立
    ck("sem/cdb_proto_version_present", bool(cdb.get("protocol_version")))
    rb = cdb.get("request_binding", {})
    ck("sem/cdb_request_binding_required",
       rb.get("request_id_required") is True and rb.get("request_ts_required") is True)
    ai = cdb.get("auth_identity_independent", {})
    ck("sem/cdb_auth_identity_independent",
       ai.get("orthogonal_to_123") is True
       and ai.get("verified_by") == "verified_by")

    # 签名 / MAC 覆盖字段（至少 8 项）
    covered_8 = ["manifest_id", "backup_id", "recovery_run_id",
                 "requested_target_lsn", "actual_stop_lsn", "timeline",
                 "manifest_content_sha256", "protocol_version"]
    sc = cdb.get("signed_fields_covered", [])
    mc = cdb.get("mac_covered_fields", [])
    ck("sem/cdb_signed_fields_covered_8",
       isinstance(sc, list) and all(f in sc for f in covered_8))
    ck("sem/cdb_mac_fields_covered_8",
       isinstance(mc, list) and all(f in mc for f in covered_8))

    # HMAC 不得称签名；签名是非对称（四者区分补强）
    ck("sem/cdb_hmac_not_called_signature",
       cdb.get("manifest_signature_is_asymmetric") is True
       and fw.get("hmac") != fw.get("asymmetric_signature"))

    # 密钥轮换 + 历史密钥验证
    kr = cdb.get("key_rotation", {})
    ck("sem/cdb_key_rotation_complete",
       bool(kr.get("policy")) and kr.get("historical_key_validation") is True)

    # 重放防护 / 重试幂等
    rp = cdb.get("replay_protection", {})
    ck("sem/cdb_replay_protection",
       rp.get("request_unique_id_required") is True
       and rp.get("idempotent_on_retry") is True)

    # TOCTOU 防范（版本标识 + 内容摘要 + 核验时间 + 绑定不可变快照）
    tp = cdb.get("toctou_protection", {})
    ck("sem/cdb_toctou_protection",
       tp.get("immutable_snapshot_version") is True
       and tp.get("verify_time_bound") is True
       and tp.get("binding_immutable") is True)

    # 审计记录强制
    ck("sem/cdb_audit_log_required", cdb.get("audit_log_required") is True)

    # 故障语义 12 项；未知态不自动 success
    fs = cdb.get("fault_semantics_12", [])
    ck("sem/cdb_fault_semantics_12_count", len(fs) == 12)
    ck("sem/cdb_fault_semantics_unknown_no_success",
       len(fs) == 12 and all(f.get("never_auto_success") is True for f in fs))

    # ================= 19. TRG-01 SQL 级证明 + 10 锁路径 + 7 不变量 (R8) =================
    sp = tr.get("sql_level_proof", {})
    ck("sem/trg01_sql_proof_present",
       bool(sp.get("sql_a")) and bool(sp.get("sql_c")) and bool(sp.get("sql_d"))
       and bool(sp.get("sql_e")) and isinstance(sp.get("per_statement_notes"), list)
       and len(sp.get("per_statement_notes", [])) >= 5)
    lps = tr.get("lock_concurrency_paths_10", [])
    ck("sem/trg01_lock_paths_10",
       len(lps) == 10 and all(all(k in p for k in ("id", "path", "lock", "final_state"))
                               for p in lps))
    invs = tr.get("final_invariants_7", [])
    ck("sem/trg01_invariants_7",
       len(invs) == 7 and all("id" in i and "statement" in i for i in invs))

    # ================= 20. SQL 文本级：唯一方案已声明 + 无二选一/无 FDW 作为机制 (R8) =================
    ck("sem/cdb_sql_unique_worker_stated",
       "唯一方案：控制平面 Worker" in v3)
    ck("sem/cdb_sql_no_fdw_mechanism",
       "二选一" not in v3
       and "受控 FDW 或独立 Worker" not in v3
       and "不作为】跨库机制" in v3)
    ck("sem/cdb_sql_ten_dimension_compare",
       "十维度" in v3
       and "控制平面 Worker（推荐）" in v3
       and "受控 postgres_fdw（不采用）" in v3)

    return out


def build_ctx(data: dict) -> dict:
    def rt(p: Path) -> str:
        return p.read_text(encoding="utf-8") if p.exists() else ""
    fi_ids = {x["id"] for x in data.get("fault_injections_215", [])}
    alias_ids = {a["sub_id"] for a in data.get("fi_subitem_aliases", {}).get("aliases", [])}
    sub_ids = {s["id"] for s in data.get("semantic_audit", {})
               .get("wp04_fi_semantic_coverage", {}).get("new_subcases", [])}
    extra = {"AS-02", "DC-01", "FI-21", "FI-21a", "FI-21b"}
    return {
        "sql_v2": rt(SQL_DRAFT_V2), "sql_v3": rt(SQL_DRAFT_V3),
        "report_v2": rt(REPORT_V2), "report_v3": rt(REPORT_V3),
        "base_reg": json.loads(BASE_REG.read_text(encoding="utf-8")) if BASE_REG.exists() else {},
        "resolvable_ids": fi_ids | alias_ids | sub_ids | extra,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--list", action="store_true")
    args = ap.parse_args()

    if not REG_FILE.exists():
        print("FATAL: stage_evidence_registry.json 不存在")
        return 1
    data = json.loads(REG_FILE.read_text(encoding="utf-8"))

    legacy_specs = _load_legacy("verify_stage_specs")
    legacy_evidence = _load_legacy("verify_stage_evidence")
    ctx = build_ctx(data)
    sem = semantic_assertions(data, ctx)

    if args.list:
        for n, _, _ in sem:
            print(n)
        return 0

    groups = {
        "legacy_specs(66)": legacy_specs,
        "legacy_evidence(139)": legacy_evidence,
        "semantic(new)": sem,
    }
    allr = [(f"{g}/{n}", ok, d) for g, rows in groups.items() for n, ok, d in rows]
    passed = sum(1 for _, ok, _ in allr if ok)
    failed = [(n, d) for n, ok, d in allr if not ok]

    if args.json:
        print(json.dumps({
            "total": len(allr), "passed": passed,
            "groups": {g: {"total": len(r), "passed": sum(1 for _, ok, _ in r if ok)}
                       for g, r in groups.items()},
            "failed": [{"name": n, "detail": d} for n, d in failed],
        }, ensure_ascii=False, indent=2))
    else:
        for g, rows in groups.items():
            p = sum(1 for _, ok, _ in rows if ok)
            print(f"[{g}] {p}/{len(rows)} PASS")
            for n, ok, d in rows:
                if not ok:
                    print(f"  [FAIL] {n:52s} {d}")
        print("-" * 82)
        print(f"合计 {len(allr)} 项断言，通过 {passed}，失败 {len(failed)}")
        for n, d in failed:
            print(f"  FAIL {n}: {d}")
    return 0 if not failed else 1


if __name__ == "__main__":
    raise SystemExit(main())
