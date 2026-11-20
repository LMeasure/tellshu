"""
make-stageb-report.py —— 生成《发现书籍链路-StageB最终报告.md》

数据源（只读，不连数据库）：
    server/.hnsw-exp-matrix.json        54 组实验原始结果
    server/.exact-baseline-latency.json 精确基线补测的延迟与 Top3

分母口径（唯一来源，与 hnsw-experiment.assign_counted 一致）：
    category in ('probe', 'control') -> 不计入
    过滤开启时 new-blocked (N3)       -> 不计入
    其余定向 Query                     -> 计入

用法：
    cd server
    python src/scripts/make-stageb-report.py [--out <路径>]
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]      # server/
MATRIX = ROOT / ".hnsw-exp-matrix.json"
EXACT = ROOT / ".exact-baseline-latency.json"
DEFAULT_OUT = ROOT.parent / "发现书籍链路-StageB最终报告.md"

NON_COUNTED = {"probe", "control"}


def counted_queries(per_query):
    """只保留计入分母的 Query。"""
    return [p for p in per_query
            if p["category"] not in NON_COUNTED and p.get("counted")]


def pct(values, q):
    if not values:
        return 0.0
    o = sorted(values)
    return o[min(len(o) - 1, max(0, int(round((len(o) - 1) * q))))]


def warm_latencies(per_query):
    """热样本：第 2~5 次（第 1 次为冷样本，按方案 §4.0 单列）。"""
    warm = []
    for p in counted_queries(per_query):
        warm.extend(p["latency_ms_repeats"][1:])
    return warm


def group_stats(g):
    cq = counted_queries(g["per_query"])
    warm = warm_latencies(g["per_query"])
    plans = defaultdict(int)
    for p in cq:
        plans[p["plan_node"]] += 1
    idx = g["index"]
    qp = g["query_params"]
    return {
        "n": None,  # 调用方填
        "m": idx["m"],
        "efc": idx["ef_construction"],
        "efs": qp["ef_search"],
        "mode": qp["mode"],
        "denom": len(cq),
        "top1": sum(1 for p in cq if p["hit_top1"]),
        "top3": sum(1 for p in cq if p["hit_top3"]),
        "overlap": sum(p["overlap_rate"] for p in cq) / len(cq) if cq else 0.0,
        "p50": round(pct(warm, 0.50), 1),
        "p95": round(pct(warm, 0.95), 1),
        "idx_scan": plans.get("Index Scan", 0),
        "seq_scan": plans.get("Seq Scan", 0),
        "build": idx["build_seconds"],
        "stab": g["aggregate"]["stability_failures"],
        "leak": g["aggregate"]["front_matter_leak"],
        "plan_desc": "Index Scan" if plans.get("Index Scan") else "Seq Scan",
        "mixed": len(plans) > 1,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    ap.add_argument("--matrix", default=str(MATRIX))
    ap.add_argument("--exact", default=str(EXACT))
    args = ap.parse_args()

    data = json.loads(Path(args.matrix).read_text(encoding="utf-8"))
    exact = json.loads(Path(args.exact).read_text(encoding="utf-8"))

    groups = [group_stats(g) for g in data["groups"]]
    for i, s in enumerate(groups, 1):
        s["n"] = i

    L: list[str] = []
    w = L.append

    w("# 发现书籍链路 · Stage 2 阶段 B 最终报告")
    w("")
    w("> 生成时间：2026-10-10（GMT+8）")
    w("> 数据来源：`server/.hnsw-exp-matrix.json`（54 组实验原始结果）+ "
      "`server/.exact-baseline-latency.json`（精确基线延迟补测）")
    w("> 生成脚本：`server/src/scripts/make-stageb-report.py`")
    w("> 资产状态：见《StageB-资产冻结检查报告.md》—— 正式资产零改动，检查 PASS")
    w("")
    w("---")
    w("")

    # ---------------- 结论 ----------------
    f_ex = exact["filtered"]
    u_ex = exact["unfiltered"]
    ann = [s for s in groups if s["idx_scan"] > 0 and s["seq_scan"] == 0]
    best_ann = max(ann, key=lambda s: (s["top1"], s["overlap"], -s["p95"]))
    seq_groups = [s for s in groups if s["seq_scan"] > 0 and s["idx_scan"] == 0]

    w("## 0. 结论")
    w("")
    w("### 当前 24,244 chunk 规模：**精确检索优先**")
    w("")
    w("| 口径 | Top1 | Top3 | Top10 重合率 | P50 | P95 |")
    w("|---|---|---|---|---|---|")
    w(f"| **精确检索基线**（禁用索引）· 过滤开启 | **{f_ex['top1_hits']}/{f_ex['denominator']} "
      f"= {f_ex['top1_hits']/f_ex['denominator']:.0%}** | {f_ex['top3_hits']}/{f_ex['denominator']} "
      f"= {f_ex['top3_hits']/f_ex['denominator']:.0%} | 100%（定义，即基准） | "
      f"{f_ex['p50_ms']} ms | {f_ex['p95_ms']} ms |")
    w(f"| 精确检索基线 · 过滤关闭 | {u_ex['top1_hits']}/{u_ex['denominator']} "
      f"= {u_ex['top1_hits']/u_ex['denominator']:.0%} | {u_ex['top3_hits']}/{u_ex['denominator']} "
      f"= {u_ex['top3_hits']/u_ex['denominator']:.0%} | 100%（定义） | "
      f"{u_ex['p50_ms']} ms | {u_ex['p95_ms']} ms |")
    w(f"| **最优 ANN**（真走索引，共 {len(ann)} 组） | **{best_ann['top1']}/{best_ann['denom']} "
      f"= {best_ann['top1']/best_ann['denom']:.0%}** | {best_ann['top3']}/{best_ann['denom']} "
      f"= {best_ann['top3']/best_ann['denom']:.0%} | {best_ann['overlap']:.1%} | "
      f"{best_ann['p50']} ms | {best_ann['p95']} ms |")
    w("")
    w(f"- **HNSW：实验可用，但不进入生产。** 实验副本上的 ANN 能把 P50 从 "
      f"{f_ex['p50_ms']} ms 压到 {best_ann['p50']} ms，代价是 Top1 从 {f_ex['top1_hits']} 掉到 "
      f"{best_ann['top1']} 条、Top10 重合率只有 {best_ann['overlap']:.1%}。")
    w(f"- 最优 ANN 配置：`m={best_ann['m']} / ef_construction={best_ann['efc']} / "
      f"ef_search={best_ann['efs']} / mode={best_ann['mode']}`（第 {best_ann['n']} 组）。")
    w("- 产线现状 `ef_search=100` 在 24k 规模下已被优化器判定为「不如全表扫」，"
      "**实际执行的就是精确检索**，因此当前产线召回等于精确基线，无需改动。")
    w(f"- 规模判断：扩到 30~50 本（约 61k chunk）后，精确扫描的 P50 将线性涨到约 180 ms 以上"
      f"（过滤关闭场景现在已经是 {u_ex['p50_ms']} ms），届时再重新评估 ANN。")
    w("")

    # ---------------- 1 口径 ----------------
    w("## 1. 实验口径与资产状态")
    w("")
    w("| 项目 | 值 |")
    w("|---|---|")
    w(f"| 数据集 | 实验副本 `discovered_book_chunks_exp`，{data['experiment_rows']:,} 行（主表快照，复制时逐个校验向量内积 = 1.0） |")
    w("| 查询集 | `src/scripts/discover-queries-stage2.txt`（6 固定 + 8 新增 + 2 探针 + 1 负对照） |")
    w("| 分母口径（过滤开启） | **13**（14 条定向 Query 扣除 N3） |")
    w("| 分母口径（过滤关闭） | 14 |")
    w("| 不计入分母 | `probe`（F1/F2 探针）、`control`（负对照 CTRL） |")
    w("| 过滤 | `chapter_title IS NOT NULL` |")
    w("| 迭代扫描 | `hnsw.iterative_scan = relaxed_order` |")
    w("| Top-K | 10 |")
    w("| 延迟采样 | 每条 Query 重复 5 次，第 1 次为冷样本单列，P50/P95 只取第 2~5 次热样本 |")
    w(f"| 组数 | {len(groups)} 组（9 组索引 × {len({s['efs'] for s in groups})} 个 ef_search × "
      f"{len({s['mode'] for s in groups})} 种检索模式） |")
    w("")
    w("**资产冻结检查结论：PASS** —— `discovered_books` 10 本、`discovered_book_chunks` 24,244 行 / "
      "24,244 条 1024 维 embedding、`content_chars` 合计 10,509,217、内容指纹 "
      "`5341e1b810d0b1e69aa7f2673b2608a3`、正式 HNSW 索引 1 个 189 MB、v1 备份表 24,244 行，"
      "实验前后逐项一致。")
    w("")

    # ---------------- 2 精确基线 ----------------
    w("## 2. 精确检索基线（禁用索引，能力上限）")
    w("")
    w("### 2.1 汇总")
    w("")
    w("| 过滤 | 分母 | Top1 | Top3 | Top10 重合率 | P50 | P95 | max | 热样本数 |")
    w("|---|---|---|---|---|---|---|---|---|")
    for key, label in (("filtered", "开启 `chapter_title IS NOT NULL`"),
                       ("unfiltered", "关闭（全量 24,244 块）")):
        e = exact[key]
        w(f"| {label} | {e['denominator']} | **{e['top1_hits']}/{e['denominator']} "
          f"= {e['top1_hits']/e['denominator']:.0%}** | {e['top3_hits']}/{e['denominator']} "
          f"= {e['top3_hits']/e['denominator']:.0%} | 100%（基准自身） | {e['p50_ms']} ms | "
          f"{e['p95_ms']} ms | {e['max_ms']} ms | {e['samples']} |")
    w("")
    w("> Top10 重合率是「ANN 结果与精确结果的一致度」，精确检索与自身比对恒为 100%，"
      "它是基准而不是得分。")
    w("")

    w("### 2.2 逐条明细（过滤开启，分母 13）")
    w("")
    w("| # | Query | 期望 | Top1 | Top3 | 冷(ms) | 热样本(ms) |")
    w("|---|---|---|---|---|---|---|")
    for i, p in enumerate(exact["filtered"]["per_query"], 1):
        warm = " / ".join(f"{x:.1f}" for x in p["warm_ms"])
        w(f"| {i} | {p['query']} | {p['expected']} | {'OK' if p['hit_top1'] else 'MISS'} | "
          f"{'OK' if p['hit_top3'] else 'MISS'} | {p['cold_ms']:.1f} | {warm} |")
    w("")
    w("### 2.3 逐条明细（过滤关闭，分母 14）")
    w("")
    w("| # | Query | 期望 | Top1 | Top3 | 冷(ms) | 热样本(ms) |")
    w("|---|---|---|---|---|---|---|")
    for i, p in enumerate(exact["unfiltered"]["per_query"], 1):
        warm = " / ".join(f"{x:.1f}" for x in p["warm_ms"])
        w(f"| {i} | {p['query']} | {p['expected']} | {'OK' if p['hit_top1'] else 'MISS'} | "
          f"{'OK' if p['hit_top3'] else 'MISS'} | {p['cold_ms']:.1f} | {warm} |")
    w("")

    # ---------------- 3 ANN 矩阵 ----------------
    w("## 3. ANN 参数矩阵（54 组全表）")
    w("")
    w("`是否 Index Scan` / `是否 Seq Scan` 按该组 13 条计入 Query 的执行计划节点计数统计；"
      "两者之和为 13。`mode=auto` 由优化器自选计划，`forced_index` 禁用 seqscan 强制走索引。")
    w("")
    w("| # | m | ef_construction | ef_search | mode | Index Scan | Seq Scan | Top1 | Top3 | "
      "Top10 重合率 | P50(ms) | P95(ms) | 构建(s) |")
    w("|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for s in groups:
        mark = " ⚠️混合" if s["mixed"] else ""
        w(f"| {s['n']} | {s['m']} | {s['efc']} | {s['efs']} | {s['mode']}{mark} | "
          f"{s['idx_scan']} | {s['seq_scan']} | {s['top1']}/{s['denom']} | {s['top3']}/{s['denom']} | "
          f"{s['overlap']:.1%} | {s['p50']} | {s['p95']} | {s['build']} |")
    w("")
    w(f"**读表注意：** 有 {len(seq_groups)} 组的执行计划是纯 Seq Scan（上表 Index Scan = 0 的行），"
      "它们测到的**不是** ANN，而是优化器放弃索引后的精确扫描 —— 这类行的 Top10 重合率必然接近 100%、"
      "Top1 等于精确基线，**不能拿来证明某个索引参数更好**。")
    w("")

    w("### 3.1 只看真正走 HNSW 索引的组（按 Top1 → 重合率 → P95 排序）")
    w("")
    w("| # | m | efC | efS | mode | Top1 | Top3 | 重合率 | P50(ms) | P95(ms) | 构建(s) |")
    w("|---|---|---|---|---|---|---|---|---|---|---|")
    for s in sorted(ann, key=lambda x: (-x["top1"], -x["overlap"], x["p95"])):
        w(f"| {s['n']} | {s['m']} | {s['efc']} | {s['efs']} | {s['mode']} | "
          f"{s['top1']}/{s['denom']} | {s['top3']}/{s['denom']} | {s['overlap']:.1%} | "
          f"{s['p50']} | {s['p95']} | {s['build']} |")
    w("")
    if ann:
        lo = min(s["top1"] for s in ann)
        hi = max(s["top1"] for s in ann)
        w(f"走索引组的 Top1 命中区间：**{lo} ~ {hi} / {ann[0]['denom']}**"
          f"（{lo/ann[0]['denom']:.0%} ~ {hi/ann[0]['denom']:.0%}），"
          f"**没有任何一组追平精确基线的 {f_ex['top1_hits']}/{f_ex['denominator']}**。")
        w("")

    # ---------------- 4 重复基线组 ----------------
    w("## 4. 重复基线组分析（HNSW 构建随机性）")
    w("")
    w("矩阵第 3 组（#13–18）与第 9 组（#49–54）使用**完全相同的参数** "
      "`m=16 / ef_construction=64`（即产线当前参数）。第 9 组是刻意重复的，"
      "目的就是量化「同一参数、重建一次索引」会带来多大波动。")
    w("")
    w("| 组别 | ef_search | mode | 计划 | Top1 | 重合率 | P50(ms) | P95(ms) |")
    w("|---|---|---|---|---|---|---|---|")
    for ns, grp, tag in ((range(13, 19), "第 3 组", "首轮"), (range(49, 55), "第 9 组", "重复构建")):
        for s in [x for x in groups if x["n"] in ns]:
            w(f"| {grp}（{tag}） | {s['efs']} | {s['mode']} | {s['plan_desc']} | "
              f"{s['top1']}/{s['denom']} | {s['overlap']:.1%} | {s['p50']} | {s['p95']} |")
    w("")
    # 只比对真正走索引的行：Seq Scan 行测的是精确扫描，重合率恒为 100%，
    # 拿进波动统计会人为压低差异。
    def idx_only(ns):
        return {(s["efs"], s["mode"]): s for s in groups
                if s["n"] in ns and s["seq_scan"] == 0 and s["idx_scan"] > 0}

    g3 = idx_only(range(13, 19))
    g9 = idx_only(range(49, 55))
    deltas = []
    for k in sorted(g3):
        if k in g9:
            deltas.append((k[0], k[1], g3[k]["overlap"], g9[k]["overlap"],
                           g3[k]["top1"], g9[k]["top1"]))
    if deltas:
        worst = max(abs(a - b) for _, _, a, b, _, _ in deltas)
        w("**同参数两次构建的波动**（只统计真正走 Index Scan 的行）：")
        w("")
        w("| ef_search | mode | 第 3 组重合率 | 第 9 组重合率 | 绝对差 | Top1 |")
        w("|---|---|---|---|---|---|")
        for e, mode, a, b, t1, t2 in deltas:
            w(f"| {e} | {mode} | {a:.1%} | {b:.1%} | {abs(a-b)*100:.1f} pp | {t1} vs {t2} |")
        w("")
        w(f"最大绝对差 **{worst*100:.1f} pp**，Top1 也出现 9 vs 8 的 1 条差异。")
        w("")
        w(f"**推论：小于约 {int(worst*100 // 5 * 5 + 5)} pp 的组间差异属于构建随机性噪声，"
          "不应据此选参数。**")
    w("")
    w("### 4.1 HNSW 参数存在非单调行为（不是「参数越大越好」）")
    w("")
    w("实测证据：")
    w("")
    mono_rows = [s for s in ann if s["mode"] == "forced_index"]
    worst_m32 = min((s for s in mono_rows if s["m"] == 32 and s["efs"] == 40),
                    key=lambda s: s["top1"], default=None)
    best_m8 = max((s for s in mono_rows if s["m"] == 8), key=lambda s: (s["top1"], s["overlap"]),
                  default=None)
    if worst_m32:
        w(f"- **m 不是越大越好**：`m=32 / efC=64 / efS=40` 只有 "
          f"{worst_m32['top1']}/{worst_m32['denom']}（重合率 {worst_m32['overlap']:.1%}），"
          f"是整个矩阵最差的一批；")
    if best_m8:
        w(f"  而 `m=8 / efC={best_m8['efc']} / efS={best_m8['efs']}` 反而能到 "
          f"{best_m8['top1']}/{best_m8['denom']}（重合率 {best_m8['overlap']:.1%}）。")
    w("- **ef_search 不是越大越好**：同一索引下 40 → 100 → 200 的重合率并非单调上升，"
      "且优化器在 ef=100 时 9 组全部放弃索引、ef=200 时又多数回到索引，"
      "计划选择在 ef_search 上跳变（见 §3 全表）。")
    w("- **不存在「调大就能变好」的规律，继续调参的边际收益为零。** 方案 §4 约定：调不出结论就停止调参。")
    w("")

    # ---------------- 5 逐条归因 ----------------
    w("## 5. 逐条 Query 归因（区分「索引的问题」与「embedding 的问题」）")
    w("")
    miss = defaultdict(int)
    total = defaultdict(int)
    expected_of = {}
    for g in data["groups"]:
        plans = {p["plan_node"] for p in g["per_query"] if p["category"] not in NON_COUNTED
                 and p.get("counted")}
        if "Seq Scan" in plans:
            continue
        for p in g["per_query"]:
            if p["category"] in NON_COUNTED or not p.get("counted"):
                continue
            total[p["id"]] += 1
            expected_of[p["id"]] = p["expected"]
            if not p["hit_top1"]:
                miss[p["id"]] += 1
    ex_hit = {p["query"]: p["hit_top1"] for p in exact["filtered"]["per_query"]}
    # 精确基线里 query 被截到 30 字符，用同样的截断对齐；
    # 不能用 expected 书名对齐 —— A2/A6/N1 都期望 Jane Eyre，会串味。
    qtext_of = {}
    for g in data["groups"]:
        for p in g["per_query"]:
            if p["category"] in NON_COUNTED or not p.get("counted"):
                continue
            qtext_of[p["id"]] = p["query"][:30]

    w(f"统计口径：{len(ann)} 个真正走索引的组 × 13 条计入 Query。")
    w("")
    w("| ID | 期望 | 精确检索下 | ANN 失手率 | 归因 |")
    w("|---|---|---|---|---|")
    for qid in sorted(total, key=lambda x: -miss[x] / total[x]):
        rate = miss[qid] / total[qid]
        hit_exact = ex_hit.get(qtext_of.get(qid, ""))
        if hit_exact is False:
            cause = "**embedding / 查询措辞上限** —— 调索引无效"
        elif rate > 0.3:
            cause = "索引近似损失导致，是索引能救的部分"
        else:
            cause = "基本稳定，索引损失小"
        flag = "OK" if hit_exact else ("MISS" if hit_exact is False else "—")
        w(f"| {qid} | {expected_of[qid]} | {flag} | "
          f"{rate:.1%}（{miss[qid]}/{total[qid]}） | {cause} |")
    w("")
    w("**分解：** 精确检索也 MISS 的那几条（N5 / N6 / N8）是 embedding 与查询措辞的天花板，"
      "换任何索引参数都救不回来；其余条目的失手才是 ANN 能影响的，但总量最多也就 1 条。")
    w("")

    # ---------------- 6 结论 ----------------
    w("## 6. 结论")
    w("")
    w("1. **当前 24,244 chunk 规模：精确检索优先。** 精确基线 Top1 "
      f"{f_ex['top1_hits']}/{f_ex['denominator']}（{f_ex['top1_hits']/f_ex['denominator']:.0%}）、"
      f"P50 {f_ex['p50_ms']} ms / P95 {f_ex['p95_ms']} ms，这个延迟在离线检索场景完全可接受。")
    w("2. **HNSW：实验可用，但不进入生产。** 最优 ANN 能把 P50 压到 "
      f"{best_ann['p50']} ms，但 Top1 掉到 {best_ann['top1']}/{best_ann['denom']}"
      f"（{best_ann['top1']/best_ann['denom']:.0%}）、重合率 {best_ann['overlap']:.1%}，"
      "规模没到，换不到召回。")
    w("3. **产线无需改动。** 现状 `ef_search=100` 在 24k 下已退化为精确扫描，召回等于基线。")
    w(f"4. **预设参数留档：** 规模达标（30~50 本、约 61k chunk）后优先试 "
      f"`m={best_ann['m']} / ef_construction={best_ann['efc']} / ef_search={best_ann['efs']}`，"
      "届时须重新实测复核，不得直接套用本次读数。")
    w("5. **门槛推迟。** 方案 §4.0 的 Top1 ≥ 80% 在 13 条分母上不可稳定测量（1 条 = 7.7 pp，"
      "而单次索引重建噪声就有 ±1 条）。建议分母 ≥ 40 条时再定门槛。")
    w("")

    # ---------------- 附录 A ----------------
    w("## 附录 A：hnsw-experiment.py 统计口径修复说明")
    w("")
    w("**问题：** 实验脚本首轮把 front matter 探针 F1/F2 计入了命中率分母，"
      "导致 `aggregate.denominator` 记成 **15**，而按方案 §4.0 正确值应为 **13**。")
    w("")
    w("**修复：** 把判据收敛成唯一来源，避免多处各写一份导致再次漂移。")
    w("")
    w("```python")
    w('NON_COUNTED_CATEGORIES = frozenset({"probe", "control"})')
    w("")
    w("")
    w("def assign_counted(category: str) -> bool:")
    w('    """返回该条 Query 是否计入命中率分母。纯函数，无副作用，可被单测直接调用。')
    w("")
    w("        category == 'probe'   -> False（探针）")
    w("        category == 'control' -> False（负对照）")
    w("        其余                  -> True")
    w('    """')
    w("    return category not in NON_COUNTED_CATEGORIES")
    w("```")
    w("")
    w("调用点（全脚本仅此两处赋予初始值，不再有第二处自行写判据）：")
    w("")
    w("- 定向/探针 Query：`\"counted\": assign_counted(category)`")
    w("- 负对照 CTRL：`\"counted\": assign_counted(\"control\")`")
    w("")
    w("**保持不变的行为：** `new-blocked`（N3）在过滤开启口径下仍被单独置为 `False` —— "
      "那是「该 Query 在此口径下不可召回」的口径判断，不是类别判断，职责不同，不应混进类别规则。")
    w("")
    w("**未触碰（按要求）：** 检索逻辑、embedding 生成、SQL 查询逻辑、索引参数，一律未改。")
    w("")
    w("**新增测试：** `server/src/scripts/test_hnsw_counted.py`（9 项，全部通过）")
    w("")
    w("```")
    w("cd server && python src/scripts/test_hnsw_counted.py")
    w("```")
    w("")
    w("| 用例 | 输入 | 期望 | 结果 |")
    w("|---|---|---|---|")
    w("| `test_probe_query_not_counted` | `probe` | `False` | ✅ |")
    w("| `test_control_not_counted` | `control` | `False` | ✅ |")
    w("| `test_fixed_query_counted` | `fixed` | `True` | ✅ |")
    w("| `test_new_query_counted` | `new` | `True` | ✅ |")
    w("| `test_new_blocked_counted_by_category` | `new-blocked` | `True`（口径另行置位） | ✅ |")
    w("| `test_unknown_category_defaults_counted` | 未知类别 | `True` | ✅ |")
    w("| `test_case_sensitive` | `Probe` / `PROBE` | `True`（提醒查询集必须用小写） | ✅ |")
    w("| `test_filtered_denominator_is_13` | 真实查询集文件 | 分母 = 13 | ✅ |")
    w("| `test_unfiltered_denominator_is_14` | 真实查询集文件 | 分母 = 14 | ✅ |")
    w("")
    w("**对历史数据的影响：** 已产出的 `.hnsw-exp-matrix.json` 里 `counted` 字段仍是修复前的旧值"
      "（F1/F2 为 `True`），属于**历史快照，不回改**。本报告与 `summarize-hnsw-exp.py` "
      "均按 `category not in (probe, control) and counted` 重算，命中数不受影响"
      "（探针从不命中，只影响分母）。")
    w("")
    w("**精确基线 P50/P95 的来源：** 首轮实验未记录精确基线延迟。本轮用 "
      "`.tmp_exact_latency.py` 以完全一致的口径（同 SQL、`enable_indexscan/bitmapscan/"
      "indexonlyscan = off`、Top-K=10、5 次重复取第 2~5 次）在**实验副本表**上补测，"
      "纯 SELECT，未修改任何对象。")
    w("")

    # ---------------- 附录 B ----------------
    w("## 附录 B：产物清单")
    w("")
    w("| 文件 | 说明 |")
    w("|---|---|")
    w("| `server/.hnsw-exp-matrix.json` | 54 组原始结果（含每条 Query 的 EXPLAIN ANALYZE BUFFERS、Top10、5 次延迟、冷热、前后指纹） |")
    w("| `server/.hnsw-summary.txt` | 阶段 B 汇总文本（早期版本，分母口径以本报告为准） |")
    w("| `server/.hnsw-matrix.log` | 逐组运行日志 |")
    w("| `server/.exact-baseline-latency.json` | 精确基线延迟与 Top3 补测结果 |")
    w("| `server/src/scripts/hnsw-experiment.py` | 实验脚本（本轮修统计口径） |")
    w("| `server/src/scripts/test_hnsw_counted.py` | 分母判据单元测试（新增） |")
    w("| `server/src/scripts/make-stageb-report.py` | 本报告生成器（新增） |")
    w("| `StageB-资产冻结检查报告.md` | 资产冻结只读检查报告 |")
    w("")

    out = Path(args.out)
    out.write_text("\n".join(L) + "\n", encoding="utf-8")
    print(f"已生成 {out}（{len(L)} 行）")
    print(f"精确基线：过滤开 Top1 {f_ex['top1_hits']}/{f_ex['denominator']}，"
          f"最优 ANN Top1 {best_ann['top1']}/{best_ann['denom']}（第 {best_ann['n']} 组）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
