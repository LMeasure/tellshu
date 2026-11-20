"""
summarize-hnsw-exp.py —— 汇总 hnsw-experiment.py 产出的矩阵 JSON

只读分析，不连数据库、不改任何表。把 54 组测量压成几张可读的表：
  1. 精确检索基线逐条结果（过滤开 / 过滤关）
  2. 9 组 × ef_search × mode 的命中矩阵
  3. 最优配置排名
  4. 逐 Query 在最优配置下的表现
  5. 探针 / 负对照结果
  6. 稳定性、空结果、冷热统计

用法：
    cd server && python src/scripts/summarize-hnsw-exp.py --in .hnsw-exp-matrix.json
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def recount(group: dict, exclude: tuple[str, ...] = ("probe", "control")) -> dict:
    """按方案 §4.0 重算聚合：命中率分母只含定向 Query，探针与负对照排除。

    为什么要在汇总阶段重算：实验脚本首轮把 probe 也计入了分母，重跑一次要 5 分钟，
    而 per_query 里已保存每条的命中标记与延迟样本，足以在此精确重算。
    """
    # 双重条件：类别不是探针/负对照，且该条在当前过滤口径下确实计入（N3 过滤开启时不计入）
    counted = [p for p in group["per_query"] if p["category"] not in exclude and p["counted"]]
    denom = len(counted)
    warm: list[float] = []
    for p in counted:
        warm.extend(p["latency_ms_repeats"][1:])

    def pct(values: list[float], q: float) -> float:
        if not values:
            return 0.0
        ordered = sorted(values)
        return ordered[min(len(ordered) - 1, max(0, int(round((len(ordered) - 1) * q))))]

    return {
        "denominator": denom,
        "top1_hits": sum(1 for p in counted if p["hit_top1"]),
        "top3_hits": sum(1 for p in counted if p["hit_top3"]),
        "top5_hits": sum(1 for p in counted if p["hit_top5"]),
        "top1_rate": round(sum(1 for p in counted if p["hit_top1"]) / denom, 4) if denom else 0.0,
        "top3_rate": round(sum(1 for p in counted if p["hit_top3"]) / denom, 4) if denom else 0.0,
        "top5_rate": round(sum(1 for p in counted if p["hit_top5"]) / denom, 4) if denom else 0.0,
        "mean_overlap_rate_at_10": round(
            sum(p["overlap_rate"] for p in counted) / denom, 4) if denom else 0.0,
        "latency": {
            "samples": len(warm),
            "p50_ms": round(pct(warm, 0.50), 1),
            "p95_ms": round(pct(warm, 0.95), 1),
            "max_ms": round(max(warm), 1) if warm else 0.0,
        },
        "plan_nodes": {p["plan_node"]: sum(1 for q in counted if q["plan_node"] == p["plan_node"])
                       for p in counted},
        "empty_verdicts": {v: sum(1 for p in counted if p["empty_verdict"] == v) for p in counted
                           for v in [p["empty_verdict"]]},
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--in", dest="src", default=".hnsw-exp-matrix.json")
    parser.add_argument("--out", dest="out", default=None)
    args = parser.parse_args()

    data = json.loads(Path(args.src).read_text(encoding="utf-8"))
    lines: list[str] = []

    def w(s: str = "") -> None:
        lines.append(s)
        print(s)

    groups = data["groups"]
    cfg = data["config"]

    w("=" * 96)
    w("阶段 B：HNSW 参数实验汇总")
    w("=" * 96)
    w(f"数据集     : 实验副本 {data['experiment_rows']} 行（主表快照，一致性已校验）")
    w(f"查询集     : {cfg['queries_file']}，分母 {cfg['denominator_filtered']} 条（过滤开启口径）")
    w(f"Top-K      : {cfg['top_k']}    重复 {cfg['repeats']} 次    迭代扫描 {cfg['iterative_scan']}")
    w(f"指纹       : 实验前后差异 {len(data['fingerprint_problems'])} 项"
      f"{'（一致）' if not data['fingerprint_problems'] else '（有变化！）'}")
    w()

    # ---- 1. 精确基线 ----
    w("## 1. 精确检索基线（禁用索引，代表 embedding + 语料的能力上限）")
    w("-" * 96)
    for key, label in (("filtered", "过滤开启 chapter_title IS NOT NULL"),
                       ("unfiltered", "过滤关闭（全量 24,244 块）")):
        blk = data["exact_baseline"][key]
        directed = [p for p in blk["entries"] if p["category"] not in ("probe", "control")]
        hits = sum(1 for p in directed if p["counted"] and p["hit_top1"])
        denom = sum(1 for p in directed if p["counted"])
        w(f"### {label} —— 定向 Query Top1 {hits}/{denom}"
          f"{'（= %.0f%%）' % (hits / denom * 100) if denom else ''}")
        w(f"{'ID':<5}{'类别':<13}{'Query':<36}{'期望':<24}{'Top1':<28}{'score':>7}  命中  计入")
        for p in directed:
            flag = "OK" if p["hit_top1"] else "MISS"
            w(f"{p['id']:<5}{p['category']:<13}{p['query'][:34]:<36}{p['expected'][:22]:<24}"
              f"{str(p['top1'])[:26]:<28}{p['top1_score']:>7.4f}  {flag:<5}"
              f"{'是' if p['counted'] else '否'}")
        w("    探针 / 负对照（不计入分母，只看行为）：")
        for p in blk["entries"]:
            if p["category"] in ("probe", "control"):
                w(f"    {p['id']:<5}{p['category']:<9}{p['query'][:38]:<40} → "
                  f"{str(p['top1'])[:28]} score={p['top1_score']}")
        w()

    # ---- 2. 矩阵 ----
    w("## 2. 命中矩阵（9 组索引 × ef_search × 检索模式）")
    w("-" * 96)
    aggs = [recount(g) for g in groups]
    w(f"{'#':<3}{'m':<4}{'efC':<5}{'efS':<5}{'mode':<14}{'计划':<12}"
      f"{'Top1':>6}{'Top3':>6}{'Top5':>6}{'重合率':>8}{'P50':>8}{'P95':>8}{'max':>8}{'构建s':>7}{'索引MB':>8}")
    for i, (g, a) in enumerate(zip(groups, aggs), start=1):
        idx = g["index"]
        qp = g["query_params"]
        lat = a["latency"]
        plan = ",".join(f"{k}×{v}" for k, v in a["plan_nodes"].items())
        w(f"{i:<3}{idx['m']:<4}{idx['ef_construction']:<5}{qp['ef_search']:<5}{qp['mode']:<14}{plan:<12}"
          f"{a['top1_hits']:>3}/{a['denominator']:<2}{a['top3_hits']:>4}{a['top5_hits']:>6}"
          f"{a['mean_overlap_rate_at_10']:>8.1%}{lat['p50_ms']:>8.1f}{lat['p95_ms']:>8.1f}"
          f"{lat['max_ms']:>8.1f}{idx['build_seconds']:>7.1f}{idx['index_bytes'] / 1048576:>8.0f}")
    w()

    # ---- 3. 排名 ----
    w("## 3. 排名（按 Top1 命中数 → 重合率 → P95 延迟）")
    w("-" * 96)
    order = sorted(
        range(len(groups)),
        key=lambda i: (-aggs[i]["top1_hits"], -aggs[i]["mean_overlap_rate_at_10"],
                       aggs[i]["latency"]["p95_ms"]),
    )
    ranked = [(groups[i], aggs[i]) for i in order]
    w(f"{'#':<3}{'m':<4}{'efC':<5}{'efS':<5}{'mode':<14}{'计划':<20}{'Top1':>8}{'重合率':>8}{'P50':>8}{'P95':>8}")
    for i, (g, a) in enumerate(ranked[:12], start=1):
        idx, qp = g["index"], g["query_params"]
        plan = ",".join(f"{k}×{v}" for k, v in a["plan_nodes"].items())
        w(f"{i:<3}{idx['m']:<4}{idx['ef_construction']:<5}{qp['ef_search']:<5}{qp['mode']:<14}{plan:<20}"
          f"{a['top1_hits']:>4}/{a['denominator']:<3}{a['mean_overlap_rate_at_10']:>8.1%}"
          f"{a['latency']['p50_ms']:>8.1f}{a['latency']['p95_ms']:>8.1f}")
    w()

    # ---- 4. 最优配置逐条 ----
    best, best_agg = ranked[0]
    w("## 4. 最优配置逐条明细")
    w("-" * 96)
    bi = best["index"]
    bq = best["query_params"]
    w(f"Top1 {best_agg['top1_hits']}/{best_agg['denominator']} ({best_agg['top1_rate']:.0%})   "
      f"重合率 {best_agg['mean_overlap_rate_at_10']:.1%}   "
      f"P50/P95 {best_agg['latency']['p50_ms']}/{best_agg['latency']['p95_ms']} ms")
    w(f"配置：m={bi['m']} ef_construction={bi['ef_construction']} "
      f"ef_search={bq['ef_search']} mode={bq['mode']}")
    w(f"{'ID':<5}{'类别':<13}{'Query':<34}{'期望':<24}{'Top1':<28}{'score':>7}{'重合':>6}{'行数':>5}  命中")
    for p in best["per_query"]:
        if p["category"] in ("probe", "control"):
            continue
        flag = "OK" if p["hit_top1"] else ("--" if not p["counted"] else "MISS")
        w(f"{p['id']:<5}{p['category']:<13}{p['query'][:32]:<34}{p['expected'][:22]:<24}"
          f"{str(p['top1'])[:26]:<28}{p['top1_score']:>7.4f}{p['overlap_rate']:>6.0%}"
          f"{p['rows_returned']:>5}  {flag}")
    w()

    # ---- 5. 探针与负对照 ----
    w("## 5. 探针与负对照")
    w("-" * 96)
    for p in best["per_query"]:
        if p["category"] not in ("probe", "control"):
            continue
        w(f"{p['id']:<5}{p['category']:<9} query={p['query'][:44]}")
        w(f"      返回行数 ANN={p['rows_returned']} 精确={p['exact_rows']} "
          f"判定={p['empty_verdict']} 含无章节块={p['has_null_chapter_in_topk']}")
        w(f"      Top1={str(p['top1'])[:44]}  score={p['top1_score']}")
    w()

    # ---- 6. 稳定性 / 空结果 / 冷热 ----
    w("## 6. 稳定性 / 空结果 / 冷热")
    w("-" * 96)
    unstable = [(i + 1, g["aggregate"]["stability_failures"]) for i, g in enumerate(groups)
                if g["aggregate"]["stability_failures"]]
    w(f"  不稳定组数        : {len(unstable)} / {len(groups)}"
      f"{'' if not unstable else '  ' + str(unstable)}")
    verdict_totals: dict[str, int] = {}
    for g in groups:
        for k, v in g["aggregate"]["empty_verdicts"].items():
            verdict_totals[k] = verdict_totals.get(k, 0) + v
    w(f"  空结果判定汇总    : {verdict_totals}")
    leaks = sum(g["aggregate"]["front_matter_leak"] for g in groups)
    w(f"  过滤泄漏次数      : {leaks}（应为 0）")
    cold = [g for g in groups if g["aggregate"]["cold_samples"]]
    w(f"  冷样本记录组数    : {len(cold)}")
    if cold:
        sample = cold[0]["aggregate"]["cold_samples"][0]
        w(f"  示例冷样本        : {sample}")
    reads = [g for g in groups
             if any(q["plan_shared_read"] for q in g["per_query"] if q["plan_shared_read"] is not None)]
    w(f"  含冷读(shared_read>0)的组数: {len(reads)} / {len(groups)}")
    w()

    # ---- 6b. 过滤关闭对照 ----
    ctrl = data.get("unfiltered_control", [])
    if ctrl:
        w("## 6b. 过滤关闭对照（索引 m=16 / ef_construction=64，用于验证 N3）")
        w("-" * 96)
        w(f"{'efS':<6}{'计划':<22}{'Top1':>9}{'Top3':>6}{'Top5':>6}{'重合率':>8}{'P50':>8}{'P95':>8}")
        for g in ctrl:
            a = recount(g)
            plan = ",".join(f"{k}×{v}" for k, v in a["plan_nodes"].items())
            w(f"{g['query_params']['ef_search']:<6}{plan:<22}{a['top1_hits']:>5}/{a['denominator']:<3}"
              f"{a['top3_hits']:>6}{a['top5_hits']:>6}{a['mean_overlap_rate_at_10']:>8.1%}"
              f"{a['latency']['p50_ms']:>8.1f}{a['latency']['p95_ms']:>8.1f}")
        for g in ctrl:
            p = next((x for x in g["per_query"] if x["id"] == "N3"), None)
            if p:
                w(f"  N3 在 ef={g['query_params']['ef_search']} 过滤关闭下：Top1={str(p['top1'])[:40]} "
                  f"score={p['top1_score']} 命中={p['hit_top1']} 返回行数={p['rows_returned']}")
        w()

    # ---- 7. 索引大小 ----
    w("## 7. 索引体积")
    w("-" * 96)
    sizes = {(g["index"]["m"], g["index"]["ef_construction"]): g["index"]["index_bytes"] for g in groups}
    for (m, efc), size in sorted(sizes.items()):
        w(f"  m={m:<3} ef_construction={efc:<4} → {size} 字节 ({size / 1048576:.0f} MB)")
    w(f"  不同体积取值数量: {len(set(sizes.values()))}（=1 表示 m 不影响本环境下的索引体积）")
    w()

    if args.out:
        Path(args.out).write_text("\n".join(lines), encoding="utf-8")
        print(f"\n汇总已写入：{args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
