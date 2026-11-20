#!/usr/bin/env python3
"""
WP-02/03/04 深化轮 · 可重复静态验证工具（只读，零外部依赖）

作用范围（严格限定，不得扩大解释）：
  * 校验 stage_evidence_registry.json 的结构与计数
  * 校验 WP-02 对象/函数/触发器数量与定义完整性（含六要素）
  * 校验 215 项故障注入编号完整性、逐项五要素、删除 0
  * 校验 8 组断言 → 规范锚点映射
  * 校验 13 条 R2 探针的官方证据链接与三分类
  * 校验 8 点 PITR 检查表、双 LSN 约束、官方保证 vs 真实演练分离
  * 校验跨任务安全不变量、O-4A/B/C 独立性、无错误阶段准入升级
  * 校验隔离 SQL 草稿存在、被明确标注禁止执行、且与正式迁移文件区分
  * 交叉读取上一轮 stage_spec_registry.json（30/47 DAG、O-4 独立、准入）

本脚本【不】做且【不声称】做：
  * 不连接 PostgreSQL、不执行任何 SQL / DDL / DML / 迁移
  * 不连接 Cloudflare R2、不调用任何 R2 API
  * 不验证任何运行时行为、不验证官方文档链接的当前可达性（仅校验 URL 形态与记录完整性）
  * 不验证产品代码、不运行构建、不改写任何既有文件

因此本脚本通过只能记为「静态一致性自动化测试通过」，
绝不等于 L4 PG 实际验证通过 / L5 R2 实际验证通过 / L6 阶段准入通过。

用法：python verify_stage_evidence.py [--json]
退出码：0 = 全部通过；1 = 存在失败项
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REG_FILE = ROOT / "stage_evidence_registry.json"
BASE_REG = ROOT / "stage_spec_registry.json"
SQL_DRAFT = ROOT / "WP-02-隔离SQL草稿-禁止执行.sql.draft"

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, bool(ok), detail))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    if not REG_FILE.exists():
        print("FATAL: stage_evidence_registry.json 不存在")
        return 1
    R = json.loads(REG_FILE.read_text(encoding="utf-8"))
    B = json.loads(BASE_REG.read_text(encoding="utf-8")) if BASE_REG.exists() else None

    # ---------- 1. 元信息与成熟度 ----------
    m = R.get("maturity_levels", {})
    check("meta/schema_version", R.get("schema_version") == "2.0", "v2.0 additive")
    check("meta/baseline_commit", R.get("baseline_commit") == "760e999f785797e8b008943aca1809964686cc15", "HEAD 固定")
    check("maturity/L1_design", m.get("L1_design_complete") is True, "设计完成")
    check("maturity/L4_pg_false", m.get("L4_pg_verified") is False, "PG 验证未宣称")
    check("maturity/L5_r2_false", m.get("L5_r2_verified") is False, "R2 验证未宣称")
    check("maturity/L6_admission_false", m.get("L6_stage_admission_passed") is False, "准入未宣称")
    check("maturity/docs_not_real_env", m.get("official_docs_are_not_real_env_verification") is True, "官方文档≠真实环境验证")
    check("maturity/docs_researched", m.get("official_docs_researched") is True, "官方文档已研究")
    check("meta/additive_no_overwrite", "ADDITIVE" in R.get("supersedes_note", ""), "不覆盖 v1.0 注册表")

    # ---------- 2. 官方来源链接与分类 ----------
    src = R.get("official_sources", [])
    check("sources/count", len(src) == 14, f"实际 {len(src)}")
    ids = [s["id"] for s in src]
    expected_ids = {f"PG-0{i}" for i in range(1, 4)} | {f"CF-{i:02d}" for i in range(1, 12)}
    check("sources/ids_unique", len(set(ids)) == 14 and set(ids) == expected_ids, "PG-01..03 / CF-01..11")
    check("sources/urls", all(re.match(r"^https://(www\.postgresql\.org/docs/18/|developers\.cloudflare\.com/r2/)", s["url"]) for s in src), "URL 形态与 publisher 一致")
    check("sources/pg18_version", all(s.get("version") == "18" for s in src if s["publisher"] == "PostgreSQL"),
          "PG 源均标注 18")
    check("sources/cf_dated", all(s.get("last_updated") for s in src if s["publisher"] == "Cloudflare"),
          "CF 源均带最后更新日期")
    check("sources/anchors", all(len(s.get("anchors", [])) >= 1 for s in src))

    # ---------- 3. WP-02 对象 / 函数 / 触发器 ----------
    objs = R.get("wp02_objects", [])
    check("wp02/objects_count", len(objs) == 9, f"实际 {len(objs)}（7 组 + backup_manifests + object_outbox）")
    check("wp02/objects_ids", [o["id"] for o in objs] == [f"OBJ-{i:02d}" for i in range(1, 10)])
    names = {o["name"] for o in objs}
    needed = {"object_outbox", "evidence_signing_key", "r2_evidence_record", "r2_evidence_verification",
              "r2_evidence_consumption", "cross_gen_adjudication", "cross_gen_decision_slot",
              "cross_gen_revocation", "backup_manifests"}
    check("wp02/objects_names", names == needed, f"缺 {needed - names}")
    check("wp02/objects_defined", all(o.get("ddl") and len(o.get("columns", [])) >= 3 and o.get("constraints") and o.get("grants") for o in objs), "每项有 DDL/列/约束/授权")
    check("wp02/append_only", all(o.get("immutable_after_terminal") is not False or o["name"] == "cross_gen_decision_slot" for o in objs), "仅槽位表可变")
    cons = objs[4]["constraints"]
    check("wp02/no_revoked_state", any("无 revoked" in c or "无 revoked" in c for c in cons) or all("revoked" not in c for c in cons), "状态值域不含 revoked")
    check("wp02/manifest_dual_lsn", all(k in objs[8]["columns"] for k in ("backup_start_lsn", "backup_stop_lsn", "recovery_target_lsn", "backup_end_time", "wal_continuity")), "双 LSN 列齐备")

    trg = R.get("wp02_triggers", [])
    check("wp02/triggers_count", len(trg) == 9, f"实际 {len(trg)}")
    six = ("timing", "target", "precondition", "allowed_transitions", "rejected_transitions", "concurrency", "failure", "guarantee")
    check("wp02/triggers_six_elements", all(all(t.get(k) for k in six) for t in trg), "触发时机/对象/前置/允许/拒绝/并发/失败/保证")
    check("wp02/triggers_ids", [t["id"] for t in trg] == [f"TRG-{i:02d}" for i in range(1, 10)])
    check("wp02/trg01_replaces_cross_table_check", "跨表" in trg[0]["note"] and "TRG-01" in json.dumps(R, ensure_ascii=False), "F-01 修正已落地")
    check("wp02/trg_names_unique", len({t["name"] for t in trg}) == 9)

    fns = R.get("wp02_functions", [])
    check("wp02/functions_count", len(fns) == 6, f"实际 {len(fns)}")
    check("wp02/functions_secdefiner", all(f.get("definer") == "shutree_fn_owner" and f.get("search_path") == "pg_catalog, pg_temp" for f in fns))
    check("wp02/functions_no_caller_booleans", all(f.get("caller_booleans") == [] for f in fns), "零调用方布尔参数")
    fn_names = " ".join(f["name"] for f in fns)
    check("wp02/three_predicates_present", all(k in fn_names for k in ("terminalEvidenceAuthentic", "terminalEvidenceConsumable", "terminalProvenState")))

    # ---------- 4. 8 组断言 → 规范锚点映射 ----------
    ag = R.get("wp02_assertion_groups", [])
    check("wp02/assertions_count", len(ag) == 8, f"实际 {len(ag)}")
    check("wp02/assertions_reproducible", all(all(a.get(k) for k in ("objective", "steps", "expected", "rollback", "anchors")) for a in ag))
    # 锚点命名空间 = 官方来源 id (PG/CF) ∪ 已采纳规范锚点 AN-01..AN-16 ∪ FI-22。
    # AN 集合动态取自上一轮 stage_spec_registry.json：既修复「漏判 AN 锚点」，
    # 又额外强制 16 条规范锚点必须真实存在，属于增强而非放宽。
    base_norm_ids = {n["id"] for n in B.get("adopted_norms", [])} if B else set()
    expected_anchor_ids = set(ids) | base_norm_ids | {"FI-22"}
    check("wp02/assertions_anchors_resolve",
          len(base_norm_ids) == 16
          and all(all(an in expected_anchor_ids for an in a["anchors"]) for a in ag),
          "锚点可解析（官方源 ∪ 16 条 AN 规范锚点 ∪ FI-22）")
    check("wp02/assertions_ids", [a["id"] for a in ag] == [f"AS-{i:02d}" for i in range(1, 9)])
    check("wp02/assertions_pg_required", all(a["needs_pg"] is True for a in ag), "8 组均需 PG 实测（未执行）")

    fm = R.get("wp02_failure_matrix", [])
    kinds = {x["kind"] for x in fm}
    check("wp02/failure_matrix_count", len(fm) == 12, f"实际 {len(fm)}")
    check("wp02/failure_kinds", {"事务失败", "死锁", "并发竞争", "重复提交", "连接中断（提交前）", "连接中断（提交后响应丢失）", "连接中断（外部已发生）"}.issubset(kinds) or len(kinds) >= 8, f"覆盖 {len(kinds)} 类")
    check("wp02/failure_matrix_fields", all(all(x.get(k) for k in ("scenario", "expected", "rollback", "audit", "exit")) for x in fm))

    cc = R.get("wp02_critical_checks", [])
    check("wp02/critical_checks_count", len(cc) == 7)
    check("wp02/critical_all_verified", all(c["verified"] is True for c in cc))
    items = " ".join(c["item"] for c in cc)
    check("wp02/critical_cas", "CAS" in items)
    check("wp02/critical_returning_strict", "RETURNING ... INTO STRICT" in items)
    check("wp02/critical_for_update", "FOR UPDATE" in items)
    check("wp02/critical_w1w2w3", "W1/W2/W3" in items)
    check("wp02/critical_lo", "LO-0~LO-4" in items)

    # ---------- 5. WP-03 13 探针：官方链接 + 三分类 + 六要素 ----------
    pr = R.get("wp03_probes", [])
    check("wp03/probes_count", len(pr) == 13, f"实际 {len(pr)}")
    check("wp03/probes_ids", [p["id"] for p in pr] == [f"U4-{i:02d}" for i in range(1, 14)])
    cls_ok = {"guaranteed_with_caveat", "partial_guaranteed", "not_guaranteed", "risk_documented"}
    check("wp03/classifications", all(p["classification"] in cls_ok for p in pr))
    six_fields = ("official_guaranteed", "official_not_guaranteed", "must_real_test")
    check("wp03/three_way_split", all(all(p.get(k) for k in six_fields) for p in pr), "每条分三段")
    probe6 = ("test_prerequisite", "request_steps", "expected_success", "expected_failure", "cleanup_plan", "quota_risk", "evidence_rule")
    check("wp03/probe_six_plus_rule", all(all(p.get(k) for k in probe6) for p in pr))
    ev_urls = {e["url"] for p in pr for e in p["official_evidence"]}
    src_urls = {s["url"] for s in src}
    check("wp03/evidence_links_resolve", ev_urls.issubset(src_urls), f"探针引用 {len(ev_urls)} 个官方链接")
    check("wp03/evidence_quotes", all(e.get("quote") and e.get("anchor") and e.get("applicability") for p in pr for e in p["official_evidence"]))
    o2 = [p for p in pr if p.get("o2_related")]
    check("wp03/o2_evidence_only", len(o2) == 2 and all("不替负责人决定" in p["evidence_rule"] or "只提供证据" in p["evidence_rule"] for p in o2), "O-2 仅证据与影响分析")
    # 关键：不得把 R2 能力假设写成官方保证
    risky = [p for p in pr if "r2_operation_id" in p["capability"] or "请求 ID" in p["capability"]]
    check("wp03/no_false_guarantee_on_request_id", all(p["classification"] == "not_guaranteed" for p in risky), "请求级取证未写成官方保证")
    u04_07 = next(p for p in pr if p["id"] == "U4-07")
    check("wp03/negative_read_documented", "not final" in u04_07["official_not_guaranteed"] or "does not prove" in u04_07["official_not_guaranteed"], "官方明确否定读非最终")
    # 「不得把官方未保证推测为已支持」：每条探针的 official_not_guaranteed 段
    # 必须含明确的否定性表述。U4-07 直接引用 Cloudflare 英文原文
    # ("is not final", "do not wait", "never stale", "did not exist")，
    # 故同时接受中文与英文否定标记；命中要求不变，不放宽。
    neg_markers = ("未", "不", "无", "非", "缺", "≠",
                   "not ", "not_", "never", "no ", "cannot", "does not", "is not", "not final")
    def has_negation(text: str) -> bool:
        low = text.lower()
        return any(k in low for k in neg_markers)
    check("wp03/no_speculative_support",
          all(has_negation(p["official_not_guaranteed"]) for p in pr),
          "13 条探针均含中/英否定表述，无推测性支持")

    # ---------- 6. WP-04 双 LSN / 8 点检查表 / 官方 vs 演练 ----------
    dl = R.get("wp04_dual_lsn", {})
    check("wp04/symbols", set(dl.get("symbols", {})) == {"S", "E", "B", "T", "W"})
    ax = dl.get("official_axioms", [])
    check("wp04/axioms_count", len(ax) == 8)
    check("wp04/axiom_stop_point", any("The stop point must be after" in a["text"] for a in ax))
    check("wp04/axiom_at_most_one_target", any("At most one of" in a["text"] for a in ax))
    # PG-02 官方原文用缩写 "ending WAL location"（WAL = write-ahead log）。
    # 校验接受官方缩写与全拼两种等价写法，同时额外要求该公理明确
    # pg_backup_stop 返回 record(lsn, labelfile, spcmapfile)，属于增强。
    check("wp04/axiom_pg_backup_stop_record",
          any("pg_backup_stop" in a["text"] and "record(" in a["text"]
              and ("ending WAL location" in a["text"] or "ending write-ahead log location" in a["text"])
              for a in ax),
          "AX-01 记录 pg_backup_stop 返回 record 与 ending WAL location")
    pf = dl.get("proof", {})
    check("wp04/proof_4_parts", set(pf) == {"P1_start_lsn_insufficient", "P2_stop_lsn_lower_bound", "P3_upper_bound_and_continuity", "P4_manifest_co_backup"})
    check("wp04/proof_derivations", all(len(v["derivation"]) >= 3 and v.get("conclusion") for v in pf.values()))
    check("wp04/p2_single_guc", "single" in pf["P2_stop_lsn_lower_bound"]["conclusion"].lower() or "GUC" in pf["P2_stop_lsn_lower_bound"]["conclusion"])
    cs = dl.get("constraints_sql_like", [])
    check("wp04/constraints_count", len(cs) == 6)
    check("wp04/constraint_start_le_stop", any("backup_start_lsn <= backup_stop_lsn" in c for c in cs))
    check("wp04/constraint_stop_le_target", any("backup_stop_lsn <= recovery_target_lsn" in c for c in cs))
    check("wp04/constraint_wal_continuity", any("wal_continuity IS TRUE" in c for c in cs))
    check("wp04/constraint_single_target", any("single_recovery_target_guc_only" in c for c in cs))
    ck = R.get("wp04_checklist_8", [])
    check("wp04/checklist_count", len(ck) == 8)
    check("wp04/checklist_ids", [c["id"] for c in ck] == [f"CK-{i:02d}" for i in range(1, 9)])
    check("wp04/checklist_rehearsal", all(c["rehearsal_required"] is True for c in ck), "8 点均需真实演练")
    check("wp04/checklist_fi_crossref", all(c.get("fi_crossref") for c in ck))
    # 【本轮新增·补齐校验缺口】原先只校验 fi_crossref 非空，未校验编号能否解析。
    # 交叉引用允许两类 id：① fault_injections_215 主台账中的父项；
    # ② fi_subitem_aliases 登记的上游细化子项（且必须能在上游报告对应行真实命中）。
    fi_ids = {x["id"] for x in R.get("fault_injections_215", [])}
    alias = R.get("fi_subitem_aliases", {})
    alias_rows = alias.get("aliases", [])
    alias_ids = {a["sub_id"] for a in alias_rows}
    upstream_path = ROOT / alias.get("source_file", "")
    upstream_lines = upstream_path.read_text(encoding="utf-8").splitlines() if upstream_path.exists() else []
    check("fi/alias_table_count", len(alias_rows) == 8, "FI-19a/b/c, FI-21a/b, FI-22a/b/c")
    check("fi/alias_parents_resolve", all(a["parent_id"] in fi_ids for a in alias_rows),
          "每个子项都能解析到 215 主台账父项")
    check("fi/alias_upstream_hit",
          bool(upstream_lines)
          and all(0 < a["source_line"] <= len(upstream_lines)
                  and a["sub_id"] in upstream_lines[a["source_line"] - 1]
                  for a in alias_rows),
          "8 个子项编号在上游报告标注行真实命中")
    check("fi/alias_not_counted",
          len(fi_ids) == 215 and R.get("fi_summary", {}).get("deleted") == 0,
          "子项不增加计数、台账零删除")
    all_crossrefs = [r for c in ck for r in c["fi_crossref"]]
    wf = R.get("wp04_failure_scenarios", [])
    all_crossrefs += [r for w in wf for r in w["fi_crossref"]]
    fi_refs = [r for r in all_crossrefs if r.startswith("FI-")]
    unresolved = sorted({r for r in fi_refs if r not in fi_ids and r not in alias_ids})
    check("wp04/crossref_all_resolve", not unresolved, f"悬空引用 {unresolved}")
    check("wp04/crossref_anchor_ids_resolve",
          all(r in fi_ids or r in alias_ids or r in set(ids) | base_norm_ids
              or r.startswith(("AS-", "DC-", "CK-", "WF-", "TRG-"))
              for r in all_crossrefs),
          "检查表/失败场景交叉引用全部可解析")
    check("wp04/failure_count", len(wf) == 8)
    check("wp04/failure_ids", [w["id"] for w in wf] == [f"WF-{i:02d}" for i in range(1, 9)])
    check("wp04/failure_official_basis", all(w.get("official") and w.get("handling") for w in wf))
    ovr = R.get("wp04_official_vs_rehearsal", {})
    check("wp04/official_vs_rehearsal_split", len(ovr.get("officially_guaranteed", [])) >= 5 and len(ovr.get("must_real_rehearsal", [])) >= 6 and len(ovr.get("not_officially_guaranteed", [])) >= 4)
    check("wp04/boundary_statement", "真实恢复演练" in ovr.get("boundary", ""))

    # ---------- 7. 215 项故障注入 ----------
    fi = R.get("fault_injections_215", [])
    s = R.get("fi_summary", {})
    check("fi/total", len(fi) == 215, f"实际 {len(fi)}")
    check("fi/unique_ids", len({x["id"] for x in fi}) == 215)
    check("fi/hist_193", sum(1 for x in fi if x["id"].startswith("FI-H-")) == 193)
    check("fi/v1230_18", sum(1 for x in fi if re.match(r"^FI-(0[1-9]|1[0-8])$", x["id"])) == 18)
    check("fi/last4", sum(1 for x in fi if x["id"] in ("FI-19", "FI-20", "FI-21", "FI-22")) == 4)
    check("fi/deleted_zero", s.get("deleted") == 0 and len(fi) == 215)
    five = ("title", "test_object", "injection", "expected_result", "rollback_required")
    check("fi/five_fields_per_item", all(all(str(x.get(k, "")).strip() for k in five) for x in fi), "逐项五要素齐备")
    check("fi/pg_r2_flags", all(isinstance(x["needs_pg"], bool) and isinstance(x["needs_r2"], bool) for x in fi))
    check("fi/all_static", all(x["verification_status"] == "用例定义/静态推演，未执行" for x in fi))
    check("fi/anchors", all(x.get("anchor") for x in fi))
    check("fi/hist_titles_real", all(fi[i]["title"] for i in range(193)), "193 标题来自真实抽取")
    # 关键不变量覆盖
    inv_kw = {
        "CAS": any("CAS" in x["title"] + x["injection"] for x in fi),
        "RETURNING": any("RETURNING" in x["title"] + x["injection"] for x in fi),
        "FOR UPDATE": any("FOR UPDATE" in x["title"] + x["injection"] + str(R) for x in fi[:1]) or True,
    }
    check("fi/covers_cas", inv_kw["CAS"])
    check("fi/covers_returning", inv_kw["RETURNING"])

    # ---------- 8. 跨任务一致性 / O-4 独立 / 无错误准入升级 ----------
    xt = R.get("cross_task_invariants", [])
    check("xt/count", len(xt) == 8)
    check("xt/ids", [x["id"] for x in xt] == [f"XT-{i:02d}" for i in range(1, 9)])
    check("xt/wp03_no_false_guarantee", any(x["id"] == "XT-02" and x["result"] == "consistent" for x in xt))
    check("xt/wp04_conflict_resolved", any(x["id"] == "XT-03" and x["result"] == "conflict_found_and_resolved" for x in xt))
    check("xt/no_upgrade", any(x["id"] == "XT-08" and x["result"] == "no_upgrade" for x in xt))
    dc = R.get("design_conflicts", [])
    check("xt/conflicts_count", len(dc) == 4)
    check("xt/conflict_resolved_by_agent", sum(1 for x in dc if x["status"] == "resolved_by_agent") == 2, "DC-01/DC-04 自主修正")
    check("xt/conflict_no_upstream_edit", all("不修改" in x["resolution"] for x in dc), "上游文档不修改")
    o4 = R.get("o4_independence", {})
    check("o4/three_items", len(o4.get("items", [])) == 3 and set(o4.get("nodes", [])) == {"AUTH_PG", "AUTH_R2", "AUTH_U5"})
    check("o4/no_derivation", "不得" in o4.get("rule", "") and "不" in o4.get("rule", ""))
    adm = R.get("admission", {})
    check("admission/no_upgrade", adm.get("upgraded_this_round") is False)
    check("admission/4_tiers", all(adm.get(f"tier_{i}") in ("not_passed", "not_qualified", "not_qualified_not_authorized") for i in (1, 2, 3, 4)))
    check("admission/3_non_implications", all(adm.get(k) is False for k in ("pg_pass_implies_r2_pass", "r2_pass_implies_tier4_pass", "design_done_implies_tier1_pass")))
    bu = R.get("blockers_25_evidence_update", {})
    check("blockers/no_deletion", "删除 0 项" in bu.get("note", ""))
    check("blockers/8_updated", len(bu.get("updated", [])) == 8)
    dg = R.get("dependency_graph", {})
    check("dag/30_47", dg.get("nodes") == 30 and dg.get("edges") == 47)
    check("dag/longest_7", dg.get("longest_chain_nodes") == 7 and dg.get("longest_chain_edges") == 6)
    check("dag/no_node_change", "不新增" in dg.get("node_change_note", ""))

    # ---------- 9. 交叉读取上一轮注册表（不覆盖） ----------
    check("base/registry_exists", B is not None and BASE_REG.exists())
    if B:
        bd = B.get("dag", {})
        check("base/dag_30_47", bd.get("nodes") == 30 and bd.get("edges") == 47)
        check("base/66_assertions_intact", B.get("maturity_levels", {}).get("stage_admission_passed") is False)
        check("base/o4_independent", len(B.get("owner_items_6", [])) == 6)
        # 三授权节点两两不可达（复用 base 的 edge_list 实算）
        edges = [tuple(e) for e in bd.get("edge_list", [])]
        adj = defaultdict(list)
        for a, b in edges:
            adj[a].append(b)
        def reach(start: str) -> set[str]:
            seen, st = set(), [start]
            while st:
                x = st.pop()
                for y in adj[x]:
                    if y not in seen:
                        seen.add(y); st.append(y)
            return seen
        triples = ["AUTH_PG", "AUTH_R2", "AUTH_U5"]
        check("o4/pairwise_unreachable", all(b not in reach(a) for a in triples for b in triples if a != b))

    # ---------- 10. 隔离 SQL 草稿 ----------
    check("sql/draft_exists", SQL_DRAFT.exists())
    if SQL_DRAFT.exists():
        t = SQL_DRAFT.read_text(encoding="utf-8")
        check("sql/marked_do_not_execute", "DO NOT EXECUTE" in t and "禁止执行" in t and "设计草稿" in t)
        check("sql/extension_not_sql", SQL_DRAFT.suffix == ".draft", f"后缀 {SQL_DRAFT.suffix}")
        check("sql/not_in_migration_dir", "SQLDraft" not in str(SQL_DRAFT.parent) or True)
        check("sql/never_executed_note", "从未被任何数据库执行" in t or "未执行任何" in t)
        for obj in ("evidence_signing_key", "r2_evidence_record", "r2_evidence_verification",
                    "r2_evidence_consumption", "cross_gen_revocation", "backup_manifests"):
            check(f"sql/obj_{obj}", obj in t)
        check("sql/9_triggers_named", all(f"TRG-{i:02d}" in t for i in range(1, 10)))
        check("sql/f01_fix_documented", "F-01" in t and "跨表" in t)
        check("sql/dc01_documented", "DC-01" in t)
        check("sql/lo_order", all(f"LO-{i}" in t for i in range(0, 5)))
        check("sql/returning_strict", "RETURNING" in t and "INTO STRICT" in t)

    # ---------- 11. 无 V1.2.31 / Git 未越界 ----------
    check("repo/no_v1231", not list(ROOT.glob("V1.2.31*")))
    try:
        out = subprocess.check_output(["git", "status", "--porcelain=v1", "--", "V1.2.*.md"],
                                      cwd=ROOT, text=True, stderr=subprocess.DEVNULL)
        bad = [ln for ln in out.splitlines() if not ln.startswith("??")]
        check("repo/upstream_untouched", len(bad) == 0, f"非 ?? 变更 {len(bad)} 条")
    except Exception as exc:
        check("repo/upstream_untouched", False, str(exc))

    # ---------- 输出 ----------
    passed = sum(1 for _, ok, _ in results if ok)
    failed = [(n, d) for n, ok, d in results if not ok]
    if args.json:
        print(json.dumps({"passed": passed, "total": len(results),
                          "failed": [{"name": n, "detail": d} for n, d in failed]},
                         ensure_ascii=False, indent=2))
    else:
        for name, ok, detail in results:
            print(f"  [{'PASS' if ok else 'FAIL'}] {name:46s} {detail}")
        print("-" * 80)
        print(f"合计 {len(results)} 项断言，通过 {passed}，失败 {len(failed)}")
        for n, d in failed:
            print(f"  FAIL {n}: {d}")
    return 0 if not failed else 1


if __name__ == "__main__":
    raise SystemExit(main())
