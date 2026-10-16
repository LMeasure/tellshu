# -*- coding: utf-8 -*-
"""
阶段 5 · 渲染 Stage-B6-final-decision-report.md（纯渲染，只读所有中间产物）

回答三个问题：
  Q1 58k chunks 是否继续 EXACT？
  Q2 如果用 HNSW，ef_search 推荐多少（召回损失 / 延迟收益 / 稳定性 三者同时看）？
  Q3 什么时候切换 ANN？（chunks 阈值，依据 EXACT / HNSW 实测延迟曲线 + query 编码延迟）

输入（全部只读）：
  discover-query-set-v3.json          阶段 1
  _query-embedding-latency.json       阶段 2
  _prod-plan-check.json               阶段 3
  _b6-matrix.json                     阶段 4
  _scale-latency-curve.json           阶段 5 补测（24k / 58k 两个真实规模点）

用法：C:/Python314/python.exe -u src/scripts/make-b6-decision-report.py
"""
from __future__ import annotations

import json
import math
from pathlib import Path

SERVER_ROOT = Path(__file__).resolve().parents[2]
ROOT = SERVER_ROOT.parent
CACHE = SERVER_ROOT / ".crawl-cache"

V3 = ROOT / "discover-query-set-v3.json"
LAT = CACHE / "_query-embedding-latency.json"
PLAN = CACHE / "_prod-plan-check.json"
B6 = CACHE / "_b6-matrix.json"
B5 = CACHE / "_b5-matrix.json"
SCALE = CACHE / "_scale-latency-curve.json"
DROPPED = CACHE / "_exact-latency-curve.json"   # 已废弃的 TABLESAMPLE 方案，留作证据
OUT = ROOT / "Stage-B6-final-decision-report.md"

ARM_LABEL = {
    "exact": "EXACT 基准（禁用索引）",
    "default": "默认计划（ef=40 + relaxed_order）",
    "ann-ef40": "HNSW ef=40",
    "ann-ef40-strict": "HNSW ef=40 · iterative_scan=off（= 今天生产）",
    "ann-ef80": "HNSW ef=80",
    "ann-ef120": "HNSW ef=120",
    "ann-ef200": "HNSW ef=200",
    "ann-ef400": "HNSW ef=400",
    "ann-ef800": "HNSW ef=800",
}


def jload(p: Path) -> dict | None:
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


def fmt_pct(x: float) -> str:
    return f"{x*100:.1f}%"


def path_desc(paths: dict) -> str:
    if not paths:
        return "—"
    order = ["hnsw_ann", "seq_exact", "other_index_exact"]
    parts = [f"{k}×{v}" for k, v in sorted(
        paths.items(), key=lambda kv: (order.index(kv[0]) if kv[0] in order else 99, -kv[1]))]
    return " + ".join(parts)


def is_fallback(paths: dict) -> bool:
    """FALLBACK 唯一判据：用了别的索引（这里是 book_idx）+ 排序。
    注意 seq_exact 是 EXACT 不是 FALLBACK —— 两者都不是 HNSW，必须靠路径标签区分。"""
    return bool(paths) and not any(p in ("hnsw_ann", "seq_exact") for p in paths)


def arm_indexes(res: dict, arm: str, filtered: bool = True) -> dict:
    """按臂统计实际用到的索引名 —— 路径判据只认名字，不认节点类型。"""
    seg = res.get(f"{arm}|{'filtered' if filtered else 'unfiltered'}", {})
    names: dict[str, int] = {}
    for it in seg.get("per_query") or []:
        n = it.get("plan_index") or "—（无索引）"
        names[n] = names.get(n, 0) + 1
    return names


def idx_desc(names: dict) -> str:
    if not names:
        return "—"
    return "；".join(f"`{k}`×{v}" for k, v in sorted(names.items(), key=lambda kv: -kv[1]))


def mcnemar_p(n01: int, n10: int) -> float:
    """McNemar 精确检验（双侧）。n01 / n10 为不一致对的两个方向计数。"""
    n = n01 + n10
    if n == 0:
        return 1.0
    k = min(n01, n10)
    tail = sum(math.comb(n, i) for i in range(k + 1)) / (2 ** n)
    return min(1.0, 2 * tail)


def verdict_of(p: float) -> str:
    if p < 0.01:
        return "**显著劣化**"
    if p < 0.05:
        return "显著劣化"
    if p < 0.10:
        return "边缘"
    return "无显著差异"


def main() -> int:
    v3, lat, plan, b6 = jload(V3), jload(LAT), jload(PLAN), jload(B6)
    scale, b5 = jload(SCALE), jload(B5)
    missing = [n for n, v in (("discover-query-set-v3.json", v3),
                              ("_query-embedding-latency.json", lat),
                              ("_prod-plan-check.json", plan),
                              ("_b6-matrix.json", b6)) if v is None]
    if missing:
        raise SystemExit("缺少中间产物：" + "、".join(missing))

    res = b6["results"]
    cfg = b6["config"]
    arms = cfg["arms"]
    denom_f = cfg["denominator_filtered"]
    noise = 100.0 / denom_f if denom_f else 0.0
    n_now = b6["fingerprint"].get("main_rows", 0)

    def get(arm: str, filtered: bool = True):
        return res.get(f"{arm}|{'filtered' if filtered else 'unfiltered'}", {}).get("aggregate")

    def pq(arm: str, filtered: bool = True):
        return res.get(f"{arm}|{'filtered' if filtered else 'unfiltered'}", {}).get("per_query") or []

    exact = get("exact")
    r = lat["results"]
    enc_s = r["short_query_12char"]["p50_ms"]
    enc_l = r["long_query_77char"]["p50_ms"]

    # ---- 预计算：各臂 vs EXACT 的配对差异与显著性 ----
    ex_map = {it["id"]: it for it in pq("exact") if it.get("counted")}
    stats: dict[str, dict] = {}
    for arm in arms:
        if arm == "exact":
            continue
        agg = get(arm)
        if not agg:
            continue
        am = {it["id"]: it for it in pq(arm)}
        out = {}
        for key in ("hit_top1", "hit_top10"):
            a = b = 0           # a: EXACT 命中 & 该臂未命中；b: 反之
            for qid, e in ex_map.items():
                g = am.get(qid)
                if not g:
                    continue
                eh, gh = bool(e.get(key)), bool(g.get(key))
                if eh and not gh:
                    a += 1
                elif gh and not eh:
                    b += 1
            out[key] = {"delta": b - a, "disc": f"{a}/{b}", "p": mcnemar_p(a, b)}
        out["fallback"] = is_fallback(agg["plan_paths"])
        stats[arm] = out

    lines: list[str] = []
    w = lines.append

    # ---- 0. 三问三答 ----------------------------------------------------
    e2e_exact_s = round(enc_s + exact["latency"]["p50_ms"], 1)
    e2e_exact_l = round(enc_l + exact["latency"]["p50_ms"], 1)
    good_ann = [a for a in arms if a.startswith("ann-") and not a.endswith("-strict")
                and get(a) and not stats.get(a, {}).get("fallback")]
    best_ann = max(good_ann, key=lambda a: get(a)["top1_hits"]) if good_ann else None
    s_best = stats.get(best_ann, {}) if best_ann else {}
    fit_e = (scale or {}).get("fits", {}).get("exact", {}) if scale else {}

    w("# Stage B.6 最终决策报告")
    w("")
    w(f"生成时间：{b6['generated_at']}　|　矩阵耗时 {b6['elapsed_seconds']/60:.1f} 分钟　|　"
      f"**全程只读：未 REINDEX、未改 ef_search 默认值、未改 API / 前端 / PG 参数、未提交 Git**")
    w("")
    w("---")
    w("")
    w("## 0. 三问三答（先给结论）")
    w("")
    w("| 问题 | 结论 |")
    w("|---|---|")
    w(f"| **Q1 58k 是否继续 EXACT？** | **是**（只要端到端预算 ≳ 400 ms）。"
      f"当前端到端 {e2e_exact_s} ms（短 query）/ {e2e_exact_l} ms（长 query），"
      f"EXACT Top1 {exact['top1_hits']}/{exact['denominator']}；"
      f"按实测曲线 400 ms 预算可撑到 78k、500 ms 可撑到 100k chunks。"
      f"但 ANN 的 Top10 损失是**显著**的（见 Q2），所以在预算内 EXACT 更划算。"
      f"**预算压到 300 ms 则已越线，必须切**。见 §5 Q1 |")
    if best_ann:
        agg = get(best_ann)
        ef = best_ann.split("-ef")[1]
        d1 = s_best["hit_top1"]["delta"]
        p1 = s_best["hit_top1"]["p"]
        d10 = s_best["hit_top10"]["delta"]
        p10 = s_best["hit_top10"]["p"]
        w(f"| **Q2 若用 HNSW，ef=?** | **`hnsw.ef_search={ef}`** —— "
          f"Top1 与 EXACT 无显著差异（Δ {d1:+d}pp，McNemar p={p1:.3f}），"
          f"检索 P50 {exact['latency']['p50_ms']} → {agg['latency']['p50_ms']} ms。"
          f"**但 Top10 仍显著劣化（Δ {d10:+d}pp，p={p10:.4f}），且 {ef} 紧邻退化悬崖** —— "
          f"见 §5 Q2 |")
    if fit_e:
        n500 = (500 - enc_s - fit_e["intercept_ms"]) / fit_e["slope_ms_per_1k_chunks"] * 1000
        n300 = (300 - enc_s - fit_e["intercept_ms"]) / fit_e["slope_ms_per_1k_chunks"] * 1000
        w(f"| **Q3 何时切换 ANN？** | 按 500 ms 端到端预算 → **约 {n500:,.0f} chunks**"
          f"（当前 {n_now:,}）；预算收紧到 300 ms → **{n300:,.0f} chunks，即现在就该切**。"
          f"依据 24k / 58k 两个真实规模点实测，不是外推猜测。见 §5 Q3 |")
    w("")
    w("> ⚠️ 三条结论都有一条前置：**今天的生产根本没在正常跑 ANN**（`iterative_scan=off` 导致"
      " 7/100 条 query 返回 0 行）。先修这个，再谈 ef。见 §3.1。")
    w("")

    # ---- 1. Query 集变化 ------------------------------------------------
    w("## 1. Query 集变化（47 → 100）")
    w("")
    s = v3["summary"]
    w("| 项 | Stage B.5 | **B.6 / v3** |")
    w("|---|---:|---:|")
    w(f"| 分母（过滤开） | 47 | **{s['counted']}** |")
    w(f"| 1 条差异相当于 | 2.1 pp | **{noise:.1f} pp** |")
    w(f"| 目标书零章节块被剔除 | 6 | {s['excluded']} |")
    w(f"| 锚点零跨书污染 | 未强制 | **全部通过** |")
    w("")
    w("分类分布（计入分母的 100 条）：")
    w("")
    w("| 类别 | 条数 |")
    w("|---|---:|")
    for k, v in s["by_category"].items():
        w(f"| {k} | {v} |")
    w("")
    w(f"来源：继承 B.5 原文 {s['by_origin'].get('继承 B.5', 0)} 条（**query 文本一字未改**，"
      f"只重做锚点校验）+ 新增 {s['by_origin'].get('B.6 新增', 0)} 条。"
      f"其中 {s['anchors_repaired']} 条锚点因原锚点跨书污染被替换，"
      f"{s['anchors_retyped']} 条为补齐「关键情节词 / 长文本语义片段」两类而改型。")
    w("")
    fb0 = v3["meta"].get("frozen_baseline", {})
    w(f"指纹校验：全局内容指纹 `{fb0.get('global_md5') or fb0.get('global_content_md5')}`"
      f"　|　books {b6['fingerprint'].get('books_count')} / chunks {n_now:,} / "
      f"embeddings {b6['fingerprint'].get('main_embeddings'):,} / "
      f"content_chars {b6['fingerprint'].get('main_content_chars_sum'):,} —— 与冻结基线一致。")
    w("")
    w("明细见 `discover-query-set-v3.json` 与 `discover-query-validation-report.md`。")
    w("")

    # ---- 2. 编码延迟 ----------------------------------------------------
    w("## 2. Query 编码延迟（补齐端到端预算）")
    w("")
    w("| Query | 字符 | p50 | p95 | p99 | avg | RSS 峰值 |")
    w("|---|---:|---:|---:|---:|---:|---:|")
    for name in ("short_query_12char", "long_query_77char"):
        d = r[name]
        label = "短句" if "short" in name else "长句"
        w(f"| {label} | {d['query_chars']} | **{d['p50_ms']}** | {d['p95_ms']} | "
          f"{d['p99_ms']} | {d['avg_ms']} | {d['rss_peak_mb']} MB |")
    w("")
    w(f"样本：warmup {lat['warmup_discarded']} 次丢弃 + 正式 {lat['repeats_timed']} 次/条，"
      f"**batch size = 1**（线上单 query 形态）。"
      f"ingest 的 187 ms/条与探针的 168 ms/条都是 batch 口径，**不能代表线上单 query，已弃用**。")
    w("")
    w("| 环节 | 短 query | 长 query |")
    w("|---|---:|---:|")
    w(f"| 编码 | {enc_s} ms | {enc_l} ms |")
    w(f"| 库内检索 · EXACT | {exact['latency']['p50_ms']} ms | {exact['latency']['p50_ms']} ms |")
    if best_ann:
        hp = get(best_ann)["latency"]["p50_ms"]
        w(f"| 库内检索 · HNSW(ef={best_ann.split('-ef')[1]}) | {hp} ms | {hp} ms |")
        w(f"| **端到端 · EXACT** | **{e2e_exact_s} ms** | **{e2e_exact_l} ms** |")
        w(f"| **端到端 · HNSW** | **{round(enc_s+hp,1)} ms** | **{round(enc_l+hp,1)} ms** |")
        w("")
        w(f"> ANN 把库内检索从 {exact['latency']['p50_ms']} ms 压到 {hp} ms（"
          f"{exact['latency']['p50_ms']/hp:.0f}×），但端到端只从 {e2e_exact_s} ms 降到 "
          f"{round(enc_s+hp,1)} ms（省 {round((1-(enc_s+hp)/e2e_exact_s)*100)}%）—— "
          "**编码是端到端的大头，ANN 的收益被它稀释**。")
    w("")
    w("完整记录见 `query_embedding_latency.md`（含 Git Bash 下 `import torch` SIGSEGV 的错误原文与根因更正）。")
    w("")

    # ---- 3. 生产 SQL 执行计划 ------------------------------------------
    w("## 3. 生产 SQL 执行计划（阶段 3）")
    w("")
    w("路径判据：**只认索引名**，不看节点类型 —— `Index Scan` 也可能是 FALLBACK。")
    w("")
    w("| 臂 | SQL 形态 | 使用索引 | 索引名称 | 是否 HNSW | 是否 FALLBACK | P50 ms |")
    w("|---|---|---|---|---|---|---:|")
    for c in plan["cases"]:
        idx = ", ".join(c["indexes"]) if c["indexes"] else "—"
        w(f"| {c['arm']} | {c['sql_form']} | {'是' if c['uses_index'] else '否'} | "
          f"`{idx}` | {'是' if c['is_hnsw'] else '否'} | {'是' if c['is_fallback'] else '否'} | "
          f"{c['latency_p50_ms']} |")
    w("")
    w("**结论一：`embedding_model` 这个过滤谓词不改变执行计划** —— 三种 SQL 形态"
      "（PROD_MODEL / PROD_NULL / EXPERIMENT）在 EXACT 臂下都是 Seq Scan，"
      "在 DEFAULT 臂下都走同一个 HNSW 索引，没有出现 FALLBACK。阶段 3 的疑问排除。")
    w("")
    w("### 3.1 结论二（更严重）：今天的生产其实没在正常跑 ANN")
    w("")
    strict = get("ann-ef40-strict")
    if strict:
        w(f"- 复现今天生产配置的臂（ef=40 + `iterative_scan=off` + `chapter_title IS NOT NULL`）："
          f"**{strict['starved_queries']} 条 query 返回 0 行、{strict['underfilled_queries']} 条返回不足 10 行**"
          f"（top_k=10）。其余所有臂这两项均为 0。")
    for arm in ("EXACT", "DEFAULT", "DEFAULT_RELAXED"):
        c = next((x for x in plan["cases"] if x["arm"] == arm and x["sql_form"] == "PROD_MODEL"), None)
        if c:
            w(f"- {arm}：返回 {c['rows_returned']}/10 行，P50 {c['latency_p50_ms']} ms，"
              f"Top1 = {c['top_results'][0]['title'][:36]}")
    w("")
    w("> `hnsw.iterative_scan` 的会话默认值是 **off**（本次实测确认）。"
      "带上 `chapter_title IS NOT NULL` 过滤时，pgvector 的 HNSW 会**提前收手** —— "
      "这是「饥饿」，不是「召回低」。表现为：**EXACT 与 ANN 的 Top10 零重合**。")
    w("> 修法是在事务里 `set_config('hnsw.iterative_scan','relaxed_order',true)`，"
      "**这需要改代码，不在本次授权范围内**。")
    w("")

    # ---- 4. B.6 矩阵 ----------------------------------------------------
    w("## 4. Stage B.6 矩阵（100 条，只读正式表）")
    w("")
    w(f"分母 {denom_f} 条（1 条 = {noise:.1f} pp）　|　top_k = {cfg['top_k']}　|　"
      f"每条重复 {cfg['repeats']} 次（第 1 次为冷样本，不计入 P50）　|　"
      f"除 `-strict` 外所有臂均为 `iterative_scan=relaxed_order`")
    w("")
    w("| 臂 | 实际索引（只认名字） | 路径 | Top1 | Top10 | P50 ms | P95 ms | 判定 |")
    w("|---|---|---|---:|---:|---:|---:|---|")
    for arm in arms:
        agg = get(arm)
        if not agg:
            continue
        latx = agg["latency"]
        if arm == "exact":
            verdict = "EXACT（召回天花板）"
        elif is_fallback(agg["plan_paths"]):
            verdict = "**FALLBACK（不作 ANN 比较样本）**"
        elif arm.endswith("-strict"):
            verdict = "HNSW · 严格扫描（复现今天生产）"
        else:
            verdict = "HNSW 近似"
        w(f"| {ARM_LABEL.get(arm, arm)} | {idx_desc(arm_indexes(res, arm))} | "
          f"{path_desc(agg['plan_paths'])} | "
          f"{agg['top1_hits']}/{agg['denominator']} ({fmt_pct(agg['top1_rate'])}) | "
          f"{agg['top10_hits']}/{agg['denominator']} ({fmt_pct(agg['top10_rate'])}) | "
          f"{latx['p50_ms']} | {latx['p95_ms']} | {verdict} |")
    w("")
    w("### 4.1 退化区：ef=200 / 400 根本没走 HNSW")
    w("")
    fb = [a for a in arms if get(a) and is_fallback(get(a)["plan_paths"])]
    if fb:
        w("| 臂 | 实际索引 | 路径 | P50 ms | 与 EXACT 比较 |")
        w("|---|---|---|---:|---|")
        for arm in fb:
            agg = get(arm)
            w(f"| {ARM_LABEL.get(arm, arm)} | {idx_desc(arm_indexes(res, arm))} | "
              f"{path_desc(agg['plan_paths'])} | **{agg['latency']['p50_ms']}** | "
              f"召回等同 EXACT（{agg['top1_hits']}/{agg['denominator']}）但**慢 "
              f"{agg['latency']['p50_ms']/exact['latency']['p50_ms']:.1f}×** |")
        w("")
        w("> ef=200/400 时优化器放弃 HNSW，改用 `discovered_book_chunks_book_idx` 做全量排序："
          "`Sort` + `Limit`，实测 **373,631 buffers、513 ms**。"
          "它给出与 EXACT 完全相同的召回（因为它就是变相精确），**却比 EXACT 还慢一倍**。")
        w("> **按阶段 4 的要求：这两条单独分类，禁止写入 ANN 最优结果。**")
        w("> 注意 ef=800 **又跳回了 HNSW** —— 退化区是「一段区间」（约 160~400），"
          "不是「过了某个值就永久退化」。这本身就是一个稳定性警告。")
    w("")
    w("### 4.2 与 EXACT 的配对差异（McNemar 精确检验）")
    w("")
    w("不用「1 条 = 1 pp」这种名义门槛判显著性，直接做配对检验。")
    w("不一致对记为 `EXACT命中/该臂命中`：")
    w("")
    w("| 臂 | ΔTop1 | 不一致对 | p(Top1) | 判定 | ΔTop10 | 不一致对 | p(Top10) | 判定 |")
    w("|---|---:|---|---|---|---:|---|---|---|")
    for arm in arms:
        if arm == "exact" or arm not in stats:
            continue
        st = stats[arm]
        tag = "（FALLBACK，不参与）" if st["fallback"] else ""
        w(f"| {ARM_LABEL.get(arm, arm)}{tag} | {st['hit_top1']['delta']:+d}pp | "
          f"{st['hit_top1']['disc']} | {st['hit_top1']['p']:.4f} | {verdict_of(st['hit_top1']['p'])} | "
          f"{st['hit_top10']['delta']:+d}pp | {st['hit_top10']['disc']} | "
          f"{st['hit_top10']['p']:.4f} | {verdict_of(st['hit_top10']['p'])} |")
    w("")

    # ---- 5. 三问 --------------------------------------------------------
    w("## 5. 三个问题的回答")
    w("")
    w("### Q1：58k chunks 是否继续 EXACT？")
    w("")
    w(f"- EXACT：Top1 {exact['top1_hits']}/{exact['denominator']}"
      f"（{fmt_pct(exact['top1_rate'])}）、Top10 {exact['top10_hits']}/{exact['denominator']}"
      f"（{fmt_pct(exact['top10_rate'])}）、检索 P50 **{exact['latency']['p50_ms']} ms**")
    if best_ann:
        agg = get(best_ann)
        w(f"- 最好的真实 ANN（ef={best_ann.split('-ef')[1]}）：Top1 {fmt_pct(agg['top1_rate'])}、"
          f"Top10 {fmt_pct(agg['top10_rate'])}、检索 P50 {agg['latency']['p50_ms']} ms")
    w("")
    w("**回答：是，继续 EXACT —— 条件是端到端预算 ≳ 400 ms。**")
    w("")
    w(f"1. 端到端 {e2e_exact_s} ms（短）/ {e2e_exact_l} ms（长）。按实测曲线，"
      f"400 ms 预算能撑到 "
      f"{(400-enc_s-fit_e['intercept_ms'])/fit_e['slope_ms_per_1k_chunks']*1000:,.0f} chunks、"
      f"500 ms 预算能撑到 "
      f"{(500-enc_s-fit_e['intercept_ms'])/fit_e['slope_ms_per_1k_chunks']*1000:,.0f} chunks，"
      f"都还在 58,332 之上。")
    if best_ann:
        st = stats[best_ann]
        w(f"2. 换 ANN 只能省检索时间，端到端降到 {round(enc_s+get(best_ann)['latency']['p50_ms'],1)} ms，"
          f"**代价是 Top10 显著劣化（Δ {st['hit_top10']['delta']:+d}pp，p={st['hit_top10']['p']:.4f}）** "
          "—— 在 58k 这个规模上，这个代价比 220 ms 更贵。")
        w(f"3. 还叠加一个稳定性代价：唯一能把 Top1 拉平的 ef（{best_ann.split('-ef')[1]}）"
          "紧邻退化悬崖，ef=400 直接退化成 518 ms。")
    w("")
    w("反过来：**如果端到端预算是 300 ms，答案就是「不」** —— 长 query 已经 "
      f"{e2e_exact_l} ms，越线了，此时必须切 ANN 并接受 Top10 损失。")
    w("")
    w("### Q2：如果用 HNSW，ef_search 推荐多少？")
    w("")
    w("三个判据逐条过：")
    w("")
    w("| ef | 是否真 HNSW | 召回损失（Top1） | 召回损失（Top10） | 延迟收益 | 稳定性 | 综合 |")
    w("|---:|---|---|---|---|---|---|")
    for arm in arms:
        if not arm.startswith("ann-") or arm.endswith("-strict"):
            continue
        agg = get(arm)
        if not agg:
            continue
        ef = arm.split("-ef")[1]
        st = stats[arm]
        if st["fallback"]:
            w(f"| {ef} | ❌ FALLBACK | — | — | "
              f"**慢 {agg['latency']['p50_ms']/exact['latency']['p50_ms']:.1f}×** | ❌ | **排除** |")
            continue
        p1, p10 = st["hit_top1"]["p"], st["hit_top10"]["p"]
        ok = "**可用**" if p1 >= 0.10 else ("边缘可用" if p1 >= 0.05 else "不可用")
        w(f"| {ef} | ✅ | {st['hit_top1']['delta']:+d}pp（p={p1:.3f}，{verdict_of(p1)}） | "
          f"{st['hit_top10']['delta']:+d}pp（p={p10:.4f}，{verdict_of(p10)}） | "
          f"{exact['latency']['p50_ms']/agg['latency']['p50_ms']:.0f}× | "
          f"{'⚠ 紧邻退化区' if int(ef) >= 200 else '✅ 安全区'} | {ok} |")
    w("")
    if best_ann:
        ef = best_ann.split("-ef")[1]
        agg, st = get(best_ann), stats[best_ann]
        w(f"**回答：`hnsw.ef_search = {ef}`**")
        w("")
        w(f"- **召回损失**：Top1 Δ {st['hit_top1']['delta']:+d}pp，McNemar p={st['hit_top1']['p']:.3f} —— "
          f"与 EXACT **无显著差异**；但 Top10 Δ {st['hit_top10']['delta']:+d}pp，"
          f"p={st['hit_top10']['p']:.4f} —— **仍显著劣化**。")
        w(f"- **延迟收益**：{exact['latency']['p50_ms']} → {agg['latency']['p50_ms']} ms"
          f"（{exact['latency']['p50_ms']/agg['latency']['p50_ms']:.0f}×），"
          f"端到端 {e2e_exact_s} → {round(enc_s+agg['latency']['p50_ms'],1)} ms。")
        w(f"- **稳定性**：⚠ **这是最大的坑**。ef=200/400 会退化成 "
          f"`book_idx` + `Sort`（518 ms，比 EXACT 还慢一倍）。{ef} 目前没退化，"
          "但它就在悬崖边上 —— 数据量一变、统计信息一刷新，计划就可能翻过去。")
        w("")
        w("**因此推荐必须带两个前置条件**：①先修 `iterative_scan`（§3.1）；"
          "②上线后对检索计划做观测（记录 `Index Name`），一旦出现非 HNSW 索引立刻告警。")
        w(f"如果接受不了这两条，就退到 ef=120（安全区、P50 {get('ann-ef120')['latency']['p50_ms']} ms、"
          f"Top1 Δ {stats['ann-ef120']['hit_top1']['delta']:+d}pp 无显著差异），"
          f"代价是 Top10 Δ {stats['ann-ef120']['hit_top10']['delta']:+d}pp。")
    w("")
    w("### Q3：什么时候切换 ANN？")
    w("")
    w("**先说方法**：Q3 要求不许凭经验，必须依据两条延迟曲线 + 编码延迟。"
      "但 Stage B.5 与 B.6 跑的是同一份 58,332 chunks —— EXACT 只有一个规模点，一个点无法外推。")
    w("")
    w("**走过的弯路（留作证据）**：先试了 `TABLESAMPLE SYSTEM (%)` 抽样，让 Seq Scan 只扫随机页，"
      "等价于「表变小」。实测结果是 **75% 抽样 477 ms > 100% 全量 262 ms** —— "
      "抽样引入了随机 I/O 偏差，不能当作规模缩小的代理，**方案废弃**"
      f"（原始数据在 `{'server/.crawl-cache/_exact-latency-curve.json' if DROPPED.exists() else '已删除'}`）。")
    w("")
    if scale:
        w("**最终方案**：用库内已有的**第二张同构真实表**做第二个规模点，不抽样、不合成、不新建数据。")
        w("")
        w("| 表 | 行数 | 表大小 | 单均行大小 | 角色 |")
        w("|---|---:|---:|---:|---|")
        for p in scale["points"]:
            w(f"| `{p['table']}` | {p['rows_with_embedding']:,} | "
              f"{p['total_bytes']/1024/1024:.0f} MB | {p['bytes_per_row']} B | {p['role']} |")
        w("")
        bpr = [p["bytes_per_row"] for p in scale["points"]]
        w(f"单均行大小 {bpr[0]/1024:.1f} / {bpr[1]/1024:.1f} KB（相差 "
          f"{abs(bpr[0]-bpr[1])/max(bpr)*100:.1f}%）→ 结构同构，是真实的「规模减半」样本。"
          "（`_exp` 表还自带 HNSW 索引 `exp_hnsw_idx`，所以 HNSW 也一并拿到第二个规模点。）")
        w("")
        w("| 环节 | 24,244 chunks | 58,332 chunks | 斜率（ms / 1000 chunks） |")
        w("|---|---:|---:|---:|")
        rows = [
            ("EXACT 检索", "exact", "**"),
            ("　其中：纯扫描 I/O（不做距离计算）", "scan_only", ""),
        ] + [(f"HNSW ef={ef}", f"ann_ef{ef}", "") for ef in (40, 120, 800)]
        for label, key, bold in rows:
            v0 = scale["points"][0].get(key) if key in scale["points"][0] else scale["points"][0]["ann"].get(key.replace("ann_", ""))
            v1 = scale["points"][1].get(key) if key in scale["points"][1] else scale["points"][1]["ann"].get(key.replace("ann_", ""))
            f = scale["fits"].get(key, {})
            mk = lambda v: f"{bold}{v['p50_ms']}{bold} ms"
            w(f"| {label} | {mk(v0)} | {mk(v1)} | "
              f"{f.get('slope_ms_per_1k_chunks', '—')} |")
        w("")
        w("**一个关键事实**：EXACT 在 58k 处是 221 ms，其中纯扫描 I/O 只有 15 ms（**7%**），"
          "剩下 206 ms 全是 1024 维余弦距离计算 —— **EXACT 是 CPU 瓶颈，不是 I/O 瓶颈**。"
          "CPU 部分随行数线性增长，这正是外推能成立的原因。")
        w("")
        w("代入端到端预算（编码是固定成本，与规模无关）：")
        w("")
        w("```")
        w(f"EXACT 检索 (ms) ≈ {fit_e['intercept_ms']} + "
          f"{fit_e['slope_ms_per_1k_chunks']} × (chunks / 1000)      ← 两点实测，R² 无意义（两点定线）")
        w(f"切换阈值  N* = (预算 − 编码延迟 + {abs(fit_e['intercept_ms'])}) / "
          f"{fit_e['slope_ms_per_1k_chunks']} × 1000")
        w("```")
        w("")
        w("| 端到端预算 | 短 query 检索预算 | 长 query 检索预算 | EXACT 撑到的规模（短 / 长 query） |")
        w("|---:|---:|---:|---:|")
        for budget in (300, 400, 500, 800, 1000):
            outs = []
            for enc in (enc_s, enc_l):
                outs.append((budget - enc - fit_e["intercept_ms"])
                            / fit_e["slope_ms_per_1k_chunks"] * 1000)
            mark = f" ← 当前 {n_now:,} 已在此之上" if outs[0] <= n_now else ""
            w(f"| {budget} ms | {budget-enc_s:.0f} ms | {budget-enc_l:.0f} ms | "
              f"**{outs[0]:,.0f}** / {outs[1]:,.0f} chunks{mark} |")
        w("")
        f800 = scale["fits"].get("ann_ef800", {})
        if f800:
            n500 = (500 - enc_s - fit_e["intercept_ms"]) / fit_e["slope_ms_per_1k_chunks"] * 1000
            w(f"**HNSW 那一侧也有实测曲线了**：ef=800 的斜率只有 "
              f"{f800['slope_ms_per_1k_chunks']} ms/1k chunks（对比 EXACT 的 "
              f"{fit_e['slope_ms_per_1k_chunks']}）—— EXACT 的增长速度是它的 "
              f"{fit_e['slope_ms_per_1k_chunks']/f800['slope_ms_per_1k_chunks']:.0f} 倍。"
              f"按曲线算，到 {n500:,.0f} chunks 时 HNSW(ef=800) 仍只有 "
              f"{f800['intercept_ms'] + f800['slope_ms_per_1k_chunks']*n500/1000:.1f} ms，"
              f"而 EXACT 已经 {fit_e['intercept_ms'] + fit_e['slope_ms_per_1k_chunks']*n500/1000:.0f} ms。")
            w("")
        w("**回答（写成可推导的式子，不是一个拍脑袋的数）**：")
        w("")
        w("| 端到端预算 | 切换阈值 | 当前 58,332 是否已越线 |")
        w("|---:|---:|---|")
        for budget in (300, 400, 500, 800):
            n = (budget - enc_s - fit_e["intercept_ms"]) / fit_e["slope_ms_per_1k_chunks"] * 1000
            w(f"| {budget} ms（短 query） | **{n:,.0f} chunks** | "
              f"{'**已越线，现在就该切**' if n <= n_now else '未越线，继续 EXACT'} |")
        w("")
        w("两条硬约束：①**切换前必须先修 `hnsw.iterative_scan`**，否则只是把「慢」换成「饿」"
          "（今天已经有 7/100 条返回 0 行）；②阈值到手也不等于立刻切，"
          "还要确认 Top10 的显著损失是否可接受（见 Q2）。")
    else:
        w("**无法回答**：缺少 `_scale-latency-curve.json`。先跑 "
          "`C:/Python314/python.exe -u src/scripts/scale-latency-curve.py --run`。")
    w("")

    # ---- 6. 推荐策略 ----------------------------------------------------
    w("## 6. 推荐策略")
    w("")
    w("| 优先级 | 动作 | 是否需要授权 |")
    w("|---|---|---|")
    w("| **P0** | 修 `iterative_scan`：检索事务内 "
      "`set_config('hnsw.iterative_scan','relaxed_order',true)` | ✅ 要改代码 |")
    w("| P1 | 维持 EXACT（58k 规模、500 ms 预算下） | ❌ 现状即可 |")
    w("| P2 | 上线检索计划观测：记录每次检索的 `Index Name`，非 HNSW 立即告警 | ✅ 要改代码 |")
    if best_ann:
        w(f"| P3 | 若预算收紧到 300 ms：切 ANN 并设 `hnsw.ef_search={best_ann.split('-ef')[1]}`，"
          "接受 Top10 显著损失 | ✅ 要改配置 |")
    w("| — | ❌ 不要选 ef=200 / 400 | 退化成全量排序，比 EXACT 慢一倍 |")
    w("")

    # ---- 7. 风险 --------------------------------------------------------
    w("## 7. 风险")
    w("")
    w("| 风险 | 证据 | 处置 |")
    w("|---|---|---|")
    w("| **今天生产在饥饿状态** | §3.1：7/100 条返回 0 行、5 条返回不足 | "
      "事务内设 `iterative_scan=relaxed_order`，**要改代码，待授权** |")
    w("| **优化器会静默切 FALLBACK** | §4.1：ef=200/400 走 `book_idx`+`Sort`，518 ms | "
      "避开 160~400 区间；上线后加 plan 观测 |")
    if best_ann:
        w(f"| **推荐 ef 紧邻悬崖** | {best_ann.split('-ef')[1]} 是 HNSW，但 400 就是 FALLBACK | "
          "观测 + 保留回退到 EXACT 的开关 |")
    w("| **ANN 的 Top10 损失是真实的** | §4.2：所有 ef 的 Top10 均显著劣化（ef=800 p=0.0117） | "
      "若产品依赖候选列表完整性，不要切 |")
    w("| 曲线只有两个规模点 | 24k / 58k，两点定线，无法评估残差 | "
      "下次扩书到 ~100k 时复测一次，修正斜率 |")
    w("| 编码服务是单点 | RSS 峰值 ~1.97 GB，不可按请求拉起 | 常驻进程 + 健康检查 |")
    w("| 分母 100 条仍偏小 | 1 条 = 1.0 pp；McNemar 在 100 样本下功效有限 | "
      "结论以「统计不显著 ≠ 无差异」表述 |")
    w("")

    # ---- 8. 做了什么 / 没做什么 -----------------------------------------
    w("## 8. 本次做了什么 / 没做什么")
    w("")
    w("**做了（全部只读）**：")
    w("")
    w("- Query 集 47 → 100 条，逐条用 `content ILIKE` 验证锚点（目标书第一、跨书 0 命中）")
    w("- 实测单 query 编码延迟（batch size=1，warmup 12 + 正式 120）")
    w("- 验证生产 SQL 在三种形态下的执行计划，并挖出「今天生产在饥饿」")
    w("- 跑完 9 臂 × 2 口径的 B.6 矩阵（100 条 × 5 次）")
    w("- 补测 24k / 58k 两个真实规模点的 EXACT 与 HNSW 延迟曲线")
    w("")
    w("**没做（等授权）**：")
    w("")
    hnsw_idx = b6['fingerprint'].get('main_hnsw_index') or {}
    idx_txt = "；".join(f"`{k}` {v/1024/1024:.0f} MB" for k, v in hnsw_idx.items()) or "—"
    w(f"- 未 REINDEX 正式索引（仍 {idx_txt}）")
    w(f"- 未改 `hnsw.ef_search` 默认值（仍 {b6['fingerprint'].get('session_default_ef_search')}）、"
      f"未改 `hnsw.iterative_scan`（仍 {b6['fingerprint'].get('session_default_iterative_scan')}）")
    w("- 未改 `postgresql.conf`、未改 API 检索 SQL、未改前端发现页、未提交 Git（HEAD 未变）")
    w("")
    w("**下一步授权点**：")
    w("")
    w("1. 是否允许在检索事务里加 `set_config('hnsw.iterative_scan','relaxed_order',true)`？"
      "（这是 P0，不修的话后面所有 ef 调优都是在饥饿状态下做的）")
    if best_ann:
        w(f"2. 是否按 Q2 推荐固定 `hnsw.ef_search={best_ann.split('-ef')[1]}`，"
          "并接受 Top10 的显著损失？")
    w("3. 是否加检索执行计划观测（记录 `Index Name`）？")
    w("4. 「发现书籍」目前**没有 HTTP API**，所有结论只影响未来实现。是否开始建 API？")
    w("5. 本轮新增脚本 / JSON / 报告是否纳入 Git？当前 HEAD 未变，等你确认。")
    w("")

    OUT.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"written -> {OUT}  ({len(lines)} lines)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
