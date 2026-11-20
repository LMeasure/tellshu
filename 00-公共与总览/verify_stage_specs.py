#!/usr/bin/env python3
"""
阶段推进资产静态一致性校验器（只读，零外部依赖）
==================================================================
作用范围（严格限定，不得扩大解释）：
  * 校验 stage_spec_registry.json 的结构、计数、编号、依赖图、独立性、安全不变量
  * 校验 16 条「已采纳规范锚点」在磁盘真实文件中存在、行范围覆盖、关键词命中
  * 校验 O-4A / O-4B / O-4C 三项授权在 DAG 中两两互不可达（无捆绑、无相互推导）
  * 校验本轮未创建 V1.2.31、未修改任何上游设计文档

本脚本【不】做且【不声称】做以下事情：
  * 不连接 PostgreSQL，不执行任何 SQL / DDL / DML / 迁移
  * 不连接 Cloudflare R2，不调用任何 R2 API
  * 不验证任何数据库运行时行为、锁等待、三值逻辑收口或触发器实际语义
  * 不验证产品代码、不运行构建、不改动任何既有文件

因此本脚本通过只能记为「静态一致性自动化测试通过」，
绝不等于「PG 实际验证通过」「R2 实际验证通过」或「阶段准入通过」。

用法：python verify_stage_specs.py [--json]
退出码：0 = 全部通过；1 = 存在失败项
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from collections import defaultdict, deque
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REGISTRY = ROOT / "stage_spec_registry.json"

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, bool(ok), detail))


def main() -> int:
    if not REGISTRY.exists():
        print("FATAL: stage_spec_registry.json 不存在")
        return 1
    reg = json.loads(REGISTRY.read_text(encoding="utf-8"))

    # ---------- 1. 元信息与成熟度标签 ----------
    m = reg.get("maturity_levels", {})
    check("maturity/design_complete", m.get("design_complete") is True, "设计完成")
    check("maturity/pg_not_claimed", m.get("pg_verified") is False, "PG 验证未宣称")
    check("maturity/r2_not_claimed", m.get("r2_verified") is False, "R2 验证未宣称")
    check("maturity/admission_not_claimed", m.get("stage_admission_passed") is False, "准入未宣称")
    check("maturity/code_scoped", m.get("code_implementation_complete") == "partial", "代码仅限定为校验资产")
    check("maturity/test_scoped", m.get("automated_test_passed") == "scoped", "自动化测试限定范围")
    check("baseline_commit", reg.get("baseline_commit") == "760e999f785797e8b008943aca1809964686cc15", "基线 commit 固定")

    # ---------- 2. 16 条规范锚点：文件 / 行范围 / 关键词 ----------
    norms = reg.get("adopted_norms", [])
    check("norms/count", len(norms) == 16, f"实际 {len(norms)}")
    ids = [n["id"] for n in norms]
    check("norms/ids_unique", len(set(ids)) == 16 and ids == [f"AN-{i:02d}" for i in range(1, 17)], "AN-01..AN-16")
    anchor_ok = 0
    for n in norms:
        p = ROOT / n["anchor_file"]
        if not p.exists():
            check(f"anchor/{n['id']}", False, f"文件缺失 {n['anchor_file']}")
            continue
        lines = p.read_text(encoding="utf-8").split("\n")
        a, b = n["line_start"], n["line_end"]
        if not (1 <= a <= b <= len(lines)):
            check(f"anchor/{n['id']}", False, f"行范围越界 {a}-{b}/{len(lines)}")
            continue
        seg = "\n".join(lines[a - 1:b])
        miss = [k for k in n["keywords"] if k not in seg]
        if miss:
            check(f"anchor/{n['id']}", False, f"关键词缺失 {miss}")
            continue
        check(f"anchor/{n['id']}", True, f"{n['anchor_file'][:26]} L{a}-{b} / {len(n['keywords'])} 关键词")
        anchor_ok += 1
    check("anchors/all_verifiable", anchor_ok == 16, f"{anchor_ok}/16 条可机械复核")

    # ---------- 3. 16 项设计问题 → 锚点映射 ----------
    issues = reg.get("design_issues_16", [])
    check("issues/count", len(issues) == 16, f"实际 {len(issues)}")
    check("issues/ids", [i["id"] for i in issues] == [f"S-{k:02d}" for k in range(1, 17)], "S-01..S-16")
    check("issues/anchors_resolve", all(i["anchor"] in set(ids) for i in issues), "每项都有有效锚点")

    # ---------- 4. 25 项阻断：逐项保留、删除 0 ----------
    bl = reg.get("blockers_25", [])
    check("blockers/count", len(bl) == 25, f"实际 {len(bl)}")
    check("blockers/ids", [b["id"] for b in bl] == [f"B-{k:02d}" for k in range(1, 26)], "B-01..B-25 无缺号")
    check("blockers/no_deletion", all(b.get("prior") and b.get("current") and b.get("autonomous_followup") for b in bl),
          "每项含原状态/现状态/自主后续工作")
    allowed = {"design_done", "prep_done", "frozen_specific", "derived"}
    check("blockers/status_values", all(b["status"] in allowed for b in bl), "状态枚举合法")

    # ---------- 5. 20 项决策主口径 ----------
    d = reg.get("decisions_20_main_category", {})
    check("decisions/sum", d.get("first_agent_autonomous", 0) + d.get("second_derived_from_premise", 0)
          + d.get("third_frozen_with_alternative", 0) + d.get("fourth_owner_decision", 0) == 20, "14+2+2+2=20")
    cat_ids = d.get("first_ids", []) + d.get("second_ids", []) + d.get("third_ids", []) + d.get("fourth_ids", [])
    check("decisions/ids_complete", sorted(cat_ids) == [f"D-{k:02d}" for k in range(1, 21)], "D-01..D-20 无缺无重")

    # ---------- 6. 215 项故障注入，历史零删除 ----------
    fi = reg.get("fault_injections", {})
    total = fi.get("preserved_from_v1220_to_v1229", 0) + fi.get("added_v1230", 0) + len(fi.get("added_this_round", []))
    check("fi/sum", total == 215, f"{total} = 193+18+4")
    check("fi/total_field", fi.get("total") == 215, "total 字段一致")
    check("fi/no_deletion", fi.get("deleted") == 0, "删除 0 项")
    check("fi/new_ids", fi.get("added_this_round") == ["FI-19", "FI-20", "FI-21", "FI-22"], "FI-19..FI-22")

    # ---------- 7. 6 个任务包 ----------
    wp = reg.get("work_packages_6", [])
    check("wp/count", len(wp) == 6, f"实际 {len(wp)}")
    check("wp/ids", [w["id"] for w in wp] == [f"WP-{k:02d}" for k in range(1, 7)], "WP-01..WP-06")
    done = [w["id"] for w in wp if w["status"] == "completed" and w["requires_authorization"] is False]
    check("wp/three_noauth_done", sorted(done) == ["WP-01", "WP-05", "WP-06"], "3 个无需授权包已完成")
    prep = [w["id"] for w in wp if w["status"] == "preparation_complete_not_executed"]
    check("wp/three_prep_only", sorted(prep) == ["WP-02", "WP-03", "WP-04"], "3 个仅完成执行准备、未执行")

    # ---------- 8. 6 项负责人事项 + O-4 三项独立 ----------
    ow = reg.get("owner_items_6", [])
    check("owner/count", len(ow) == 6, f"实际 {len(ow)}")
    check("owner/ids", [o["id"] for o in ow] == ["O-1", "O-2", "O-3", "O-4A", "O-4B", "O-4C"], "含 O-4 三项拆分")
    check("owner/all_independent", all(o["independent"] is True for o in ow), "全部独立")
    check("owner/safe_defaults", all(o.get("safe_default") for o in ow), "每项有安全默认")
    check("owner/evidence_packages", all(o.get("evidence_package") for o in ow), "每项有独立证据包")
    check("owner/o4_distinct_evidence",
          len({o["evidence_package"] for o in ow if o["id"].startswith("O-4")}) == 3, "O-4A/B/C 证据包互异")
    check("owner/o4_non_derivation_rule", "不得捆绑" in reg.get("o4_non_derivation", {}).get("rule", ""), "非推导规则存在")
    check("informed_only/present", len(reg.get("informed_only_not_blocking", [])) >= 5, "知情与决策已分离")

    # ---------- 9. DAG 实算 ----------
    dag = reg.get("dag", {})
    edges = [tuple(e) for e in dag.get("edge_list", [])]
    nodeset = {x for e in edges for x in e} | set(dag.get("roots", []))
    check("dag/edge_count", len(edges) == dag.get("edges") == 47, f"实际 {len(edges)}")
    check("dag/node_count", len(nodeset) == dag.get("nodes") == 30, f"实际 {len(nodeset)}")
    indeg = defaultdict(int)
    adj = defaultdict(list)
    for a, b in edges:
        adj[a].append(b)
        indeg[b] += 1
        indeg.setdefault(a, 0)
    for n in nodeset:
        indeg.setdefault(n, 0)
    q = deque([n for n in nodeset if indeg[n] == 0])
    topo = []
    while q:
        x = q.popleft()
        topo.append(x)
        for y in adj[x]:
            indeg[y] -= 1
            if indeg[y] == 0:
                q.append(y)
    check("dag/acyclic", len(topo) == len(nodeset), "Kahn 拓扑排序无环")
    check("dag/roots", sorted(n for n in nodeset if all(n != b for _, b in edges)) == sorted(dag.get("roots", [])),
          "6 个入度 0 根节点一致")

    pred = defaultdict(list)
    for a, b in edges:
        pred[b].append(a)
    memo: dict[str, int] = {}

    def depth(n: str) -> int:
        if n not in memo:
            memo[n] = 1 + max((depth(p) for p in pred[n]), default=0)
        return memo[n]

    check("dag/longest_chain", depth("T4") == dag.get("longest_chain_nodes") == 7, f"T4 深度 {depth('T4')}")

    def all_longest(n: str) -> list[list[str]]:
        if not pred[n]:
            return [[n]]
        cand = [(p, depth(p)) for p in pred[n]]
        mx = max(v for _, v in cand)
        out = []
        for p, v in cand:
            if v == mx:
                out += [pre + [n] for pre in all_longest(p)]
        return out

    chains = all_longest("T4")
    check("dag/equal_chains", len(chains) == dag.get("equal_longest_chains") == 5, f"等长链 {len(chains)} 条")

    def reachable(s: str) -> set[str]:
        seen, st = set(), [s]
        while st:
            x = st.pop()
            for y in adj[x]:
                if y not in seen:
                    seen.add(y)
                    st.append(y)
        return seen

    triples = ["AUTH_PG", "AUTH_R2", "AUTH_U5"]
    pairs_ok = all(b not in reachable(a) for a in triples for b in triples if a != b)
    check("o4/authorization_nodes_independent", pairs_ok, "三项授权节点两两互不可达")
    check("o4/no_shared_edge", not any((a in triples and b in triples) for a, b in edges), "三项之间无边")

    # ---------- 10. 准入与安全不变量 ----------
    adm = reg.get("admission", {})
    check("admission/no_upgrade", adm.get("upgraded_this_round") is False, "四档未升级")
    check("admission/pg_ne_r2", adm.get("pg_pass_implies_r2_pass") is False, "PG 通过 != R2 通过")
    check("admission/r2_ne_t4", adm.get("r2_pass_implies_tier4_pass") is False, "R2 通过 != 1B 通过")
    check("admission/design_ne_t1", adm.get("design_done_implies_tier1_pass") is False, "设计完成 != 设计验收通过")
    inv = reg.get("safety_invariants", [])
    needed = {"manual_adjudication_is_never_terminality_evidence", "t_requeue_permanently_closed_until_real_evidence",
              "terminal_proven_unreachable", "authentic_false_when_capability_absent", "silent_barrier_abort",
              "unresolved_request_stays_true", "no_fabricated_u4_measurements", "no_auto_upgrade_of_admission",
              "no_modification_of_upstream_documents", "no_v1231_created"}
    check("safety/invariants", needed.issubset(set(inv)) and len(inv) >= 10, f"{len(inv)} 条不变量")

    # ---------- 11. 无 V1.2.31 / 上游文档未被修改 ----------
    check("repo/no_v1231", not list(ROOT.glob("V1.2.31*")), "未创建 V1.2.31")
    try:
        out = subprocess.check_output(["git", "status", "--porcelain=v1", "--", "V1.2.*.md"],
                                      cwd=ROOT, text=True, stderr=subprocess.DEVNULL)
        bad = [ln for ln in out.splitlines() if ln[:2].strip() not in ("?", "??")]
        bad = [ln for ln in bad if not ln.startswith("??")]
        check("repo/upstream_docs_untouched", len(bad) == 0, f"非 ?? 上游文档变更 {len(bad)} 条")
    except Exception as exc:  # pragma: no cover
        check("repo/upstream_docs_untouched", False, f"git 调用失败 {exc}")

    # ---------- 输出 ----------
    passed = sum(1 for _, ok, _ in results if ok)
    failed = [(n, d) for n, ok, d in results if not ok]
    if "--json" in sys.argv:
        print(json.dumps({"passed": passed, "total": len(results),
                          "failed": [{"name": n, "detail": d} for n, d in failed]}, ensure_ascii=False, indent=2))
    else:
        for name, ok, detail in results:
            print(f"  [{'PASS' if ok else 'FAIL'}] {name:44s} {detail}")
        print("-" * 78)
        print(f"合计 {len(results)} 项断言，通过 {passed}，失败 {len(failed)}")
        if failed:
            for n, d in failed:
                print(f"  FAIL {n}: {d}")
    return 0 if not failed else 1


if __name__ == "__main__":
    raise SystemExit(main())
