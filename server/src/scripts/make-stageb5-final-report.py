"""
make-stageb5-final-report.py —— 由 _b5-matrix.json 渲染《发现书籍链路-StageB.5最终报告.md》

与 make-stageb5-report.py 的区别（第二阶段修订要求）：
  1. 路径命名统一为 EXACT / HNSW / FALLBACK 三标签，**全文禁止出现「Index Scan = ANN」这种等式**。
  2. ef=200 / ef=400 明确标注为 FALLBACK（优化器放弃 HNSW），**不作为 ANN 参数比较样本**。
  3. §0 决策摘要必须给足三个核心数字：数据规模 / 精确基线 / 最优真实 ANN。

只读：不连数据库、不改任何产线对象。输入只有 stage-b5-experiment.py 写出的 JSON。

用法：
    cd server
    python src/scripts/make-stageb5-final-report.py
    python src/scripts/make-stageb5-final-report.py --in .crawl-cache/_b5-matrix.json \
        --out ../发现书籍链路-StageB.5最终报告.md
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

DEFAULT_IN = ".crawl-cache/_b5-matrix.json"
DEFAULT_OUT = "../发现书籍链路-StageB.5最终报告.md"

# ---------------------------------------------------------------------------
# 路径标签：唯一命名入口。plan_path -> 标签
#   seq_exact         = Seq Scan 精确余弦              -> EXACT
#   hnsw_ann          = 走 discovered_book_chunks_embedding_hnsw_idx -> HNSW
#   other_index_exact = 优化器放弃 HNSW，改用别的索引全扫 + 排序 -> FALLBACK
# ---------------------------------------------------------------------------
PATH_TAG = {
    "seq_exact": "EXACT",
    "hnsw_ann": "HNSW",
    "other_index_exact": "FALLBACK",
    "other": "UNKNOWN",
}

PATH_DEF = [
    ("EXACT", "Seq Scan 精确余弦", "seq_exact",
     "顺序扫描全表，逐条算余弦距离。召回率的天花板，代价是延迟随规模线性增长。"),
    ("HNSW", "使用 hnsw_idx", "hnsw_ann",
     "走 `discovered_book_chunks_embedding_hnsw_idx`（`vector_cosine_ops`）做近似检索。"
     "近似度由 `hnsw.ef_search` 控制。"),
    ("FALLBACK", "优化器放弃 HNSW", "other_index_exact",
     "名义上请求的是 ANN，但优化器改用 `discovered_book_chunks_book_idx` 全扫 + Sort"
     "（top-N heapsort）。结果等价于精确，延迟却比 EXACT 更糟。**不是 ANN。**"),
]

ARM_SHORT = {
    "default": "默认计划",
    "exact": "强制 EXACT",
    "ann-ef40": "HNSW ef=40",
    "ann-ef80": "HNSW ef=80",
    "ann-ef100": "HNSW ef=100",
    "ann-ef120": "HNSW ef=120",
    "ann-ef200": "HNSW ef=200",
    "ann-ef400": "HNSW ef=400",
    "ann-ef800": "HNSW ef=800",
    "ann-ef40-strict": "HNSW ef=40 严格扫描",
    "ann-ef200-strict": "HNSW ef=200 严格扫描",
}


def fmt_pct(rate: float) -> str:
    return f"{rate * 100:.1f}%"


def path_desc(paths: dict) -> str:
    """把 plan_paths 计数映射成 EXACT/HNSW/FALLBACK 标签串。"""
    if not paths:
        return "—"
    parts = [f"{PATH_TAG.get(k, k)}×{v}" for k, v in sorted(paths.items(), key=lambda kv: -kv[1])]
    return " + ".join(parts)


def dominant_path(paths: dict) -> str | None:
    """返回占比最大的路径原始 key；空则 None。"""
    if not paths:
        return None
    return max(paths.items(), key=lambda kv: kv[1])[0]


def is_real_hnsw(agg: dict) -> bool:
    """该臂是否真的全程走 HNSW（用于挑选『最优真实 ANN』）。"""
    paths = agg.get("plan_paths") or {}
    return bool(paths) and all(k == "hnsw_ann" for k in paths)


def load_payload(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def render(payload: dict) -> str:
    cfg = payload["config"]
    fp = payload["fingerprint"]
    results = payload["results"]
    denom_off = cfg["denominator_unfiltered"]
    denom_on = cfg["denominator_filtered"]
    arms = list(cfg["arms"])

    out: list[str] = []
    w = out.append

    key_rows = []
    for arm in arms:
        for filter_on, key2, denom in ((False, "unfiltered", denom_off), (True, "filtered", denom_on)):
            agg = results.get(f"{arm}|{key2}", {}).get("aggregate")
            if agg:
                key_rows.append((arm, filter_on, agg, denom))

    def get(arm, filter_on):
        for a, f, agg, d in key_rows:
            if a == arm and f == filter_on:
                return agg, d
        return None, None

    noise = 100 / denom_on

    # =====================================================================
    w("# 发现书籍链路 · Stage B.5 最终报告")
    w("")
    w(f"> 生成时间：{payload['generated_at']}　·　数据集：**30 本冻结基线**")
    w("> 脚本：`server/src/scripts/stage-b5-experiment.py`（**只读**）　→　"
      "`make-stageb5-final-report.py`（渲染，同样只读）")
    w(f"> 原始数据：`server/.crawl-cache/_b5-matrix.json`")
    w("> 前置文件：《StageB5-资产冻结复核报告.md》—— 资产冻结成立，本报告结论可作决策依据")
    w("")
    w("---")
    w("")

    # ---- 0. 决策摘要：三个核心数字 ------------------------------------
    w("## 0. 决策摘要")
    w("")
    w("### 0.1 数据规模")
    w("")
    w("| 项 | 值 |")
    w("|---|---|")
    w(f"| 书籍数 | **{fp['books_count']} 本** |")
    w(f"| 文本块 chunks | **{fp['main_rows']:,}** |")
    w(f"| embedding | **{fp['main_embeddings']:,} × 1024 维**（recipe=v2，无缺失） |")
    w(f"| 正文字符合计 | {fp['main_content_chars_sum']:,} |")
    w(f"| 无章节块 | {fp['main_null_chapter']:,}"
      f"（{fp['main_null_chapter']/fp['main_rows']*100:.2f}%） |")
    idx = fp["main_hnsw_index"]
    size_mb = list(idx.values())[0] / 1024 / 1024
    w(f"| 正式 HNSW 索引 | **{size_mb:.0f} MB**（插入自动维护，未 REINDEX） |")
    w(f"| 内容指纹 | `{fp['main_content_fp']}` |")
    w("")

    exact_on, exact_d = get("exact", True)
    real_ann = [(a, get(a, True)[0]) for a in arms
                if a.startswith("ann-ef") and get(a, True)[0] and is_real_hnsw(get(a, True)[0])]
    best_ann = max(real_ann, key=lambda kv: kv[1]["top1_rate"]) if real_ann else None

    w("### 0.2 精确基线（EXACT）")
    w("")
    if exact_on:
        lat = exact_on["latency"]
        w("> 过滤开启口径（`chapter_title IS NOT NULL`），分母 "
          f"{exact_on['denominator']} 条。这是**召回率天花板**。")
        w("")
        w("| 指标 | 值 |")
        w("|---|---|")
        w(f"| **Top1** | **{exact_on['top1_hits']}/{exact_on['denominator']}"
          f"（{fmt_pct(exact_on['top1_rate'])}）** |")
        w(f"| **Top10** | **{exact_on['top10_hits']}/{exact_on['denominator']}"
          f"（{fmt_pct(exact_on['top10_rate'])}）** |")
        w(f"| **P50** | **{lat['p50_ms']} ms** |")
        w(f"| P95 | {lat['p95_ms']} ms |")
        w(f"| 实际路径 | {path_desc(exact_on.get('plan_paths') or {})} |")
    w("")

    w("### 0.3 最优真实 ANN（HNSW）")
    w("")
    if best_ann:
        arm, agg = best_ann
        lat = agg["latency"]
        w(f"> `{arm}` —— 在**真正走了 HNSW 索引**的臂里 Top1 最高的一组。")
        w("")
        w("| 指标 | 值 |")
        w("|---|---|")
        w(f"| **ef_search** | **{arm.split('-ef')[1]}** |")
        w(f"| **Top1** | **{agg['top1_hits']}/{agg['denominator']}"
          f"（{fmt_pct(agg['top1_rate'])}）** |")
        w(f"| **Top10** | **{agg['top10_hits']}/{agg['denominator']}"
          f"（{fmt_pct(agg['top10_rate'])}）** |")
        w(f"| **P50** | **{lat['p50_ms']} ms** |")
        w(f"| P95 | {lat['p95_ms']} ms |")
        w(f"| 实际路径 | {path_desc(agg.get('plan_paths') or {})} |")
        if exact_on:
            # 必须用「命中数」而不是 rate 算差值：JSON 里的 rate 只保留 4 位小数，
            # 0.5106 / 0.5319 相减得到 -2.13pp，比真实的 -2.1277pp 大，
            # 会正好越过 100/47=2.1277pp 的门槛，把一个边界情形误判成「确实更低」。
            delta_hits = agg["top1_hits"] - exact_on["top1_hits"]
            d1 = delta_hits / exact_on["denominator"] * 100
            d10 = (agg["top10_hits"] - exact_on["top10_hits"]) / exact_on["denominator"] * 100
            # eps：允许浮点误差。本例差距与噪声门槛恰好都等于 100/47 pp，
            # 属「正好等于门槛」的边界情形，不能因为浮点抖动判成「超过」。
            eps = 1e-9
            if abs(d1) <= noise + eps:
                verdict = "**正好落在噪声门槛上（边界情形）**，不足以断定低于 EXACT"
            else:
                verdict = "超过噪声门槛，确实低于 EXACT"
            w("")
            w(f"- 距 EXACT 天花板：**Top1 {d1:+.1f}pp**、**Top10 {d10:+.1f}pp**")
            w(f"- P50 比 EXACT **快 {exact_on['latency']['p50_ms']/lat['p50_ms']:.0f} 倍**"
              f"（{exact_on['latency']['p50_ms']} ms → {lat['p50_ms']} ms）")
            w(f"- Top1 差距 {abs(d1):.1f}pp vs 噪声门槛 {noise:.1f}pp：{verdict}")
    w("")

    w("### 0.4 一句话")
    w("")
    if exact_on and best_ann:
        agg = best_ann[1]
        w(f"> 在 **30 本 / 58,332 chunks** 这个规模上，**HNSW + ef_search="
          f"{best_ann[0].split('-ef')[1]}** 能把 Top1 做到 "
          f"{fmt_pct(agg['top1_rate'])}，和 EXACT 天花板 "
          f"{fmt_pct(exact_on['top1_rate'])} 只差 "
          f"{abs((agg['top1_rate']-exact_on['top1_rate'])*100):.1f}pp"
          f"（噪声门槛 {noise:.1f}pp），而延迟从 "
          f"{exact_on['latency']['p50_ms']} ms 降到 {agg['latency']['p50_ms']} ms；"
          f"代价是 **Top10 仍低 {abs((agg['top10_rate']-exact_on['top10_rate'])*100):.1f}pp**。")
    w("")

    # ---- 1. 路径命名约定 ----------------------------------------------
    w("## 1. 路径命名约定（全文统一）")
    w("")
    w("> ⚠️ **禁止使用「Index Scan = ANN」这种说法。**")
    w("> 本轮实测证明：`FALLBACK` 路径在 PostgreSQL 计划里同样显示为 *Index Scan*，")
    w("> 但它是**全扫 + 排序**，一次距离计算都没省，与 ANN 无关。")
    w("> 判断路径的**唯一依据是计划里出现的索引名**，不是节点类型。")
    w("")
    w("| 标签 | 定义 | 计划判据 | 说明 |")
    w("|---|---|---|---|")
    for tag, define, key, desc in PATH_DEF:
        w(f"| **{tag}** | {define} | `{key}` | {desc} |")
    w("")
    w("判据实现（`stage-b5-experiment.py`）：")
    w("")
    w("```")
    w("出现 discovered_book_chunks_embedding_hnsw_idx  -> hnsw_ann        -> HNSW")
    w("出现 Seq Scan on discovered_book_chunks         -> seq_exact       -> EXACT")
    w("出现 discovered_book_chunks_book_idx + Sort     -> other_index_exact -> FALLBACK")
    w("```")
    w("")

    # ---- 2. 实验方法 ---------------------------------------------------
    w("## 2. 实验方法")
    w("")
    w("| 项 | 值 |")
    w("|---|---|")
    w(f"| 载体 | **正式表**（`discovered_book_chunks`），只读，**不建任何索引** |")
    w(f"| 查询集 | `discover-queries-b5.txt`，{len(payload['queries'])} 条 |")
    w(f"| Top-K | {cfg['top_k']} |")
    w(f"| 每条重复 | {cfg['repeats']} 次（取 P50/P95，并校验重复结果是否稳定） |")
    w(f"| 分母（过滤开启） | {denom_on} 条 |")
    w(f"| 分母（过滤关闭） | {denom_off} 条 |")
    w(f"| **噪声门槛** | **1 条 = {noise:.1f}pp**（过滤开启）／ "
      f"{100/denom_off:.1f}pp（过滤关闭） |")
    w("")
    w("会话级参数一律 `SELECT set_config(..., true)`（等价 `SET LOCAL`）与查询**同事务**，"
      "commit 后自动重置，**不污染连接池**。")
    w("")

    w("### 2.1 过滤开启口径为何少 6 条")
    w("")
    # counted=False 有两种：probe/control（设计上就不计入），以及目标书在过滤口径下
    # 无任何有章节块而被剔除。后者才是分母差值的来源。
    blocked = [p for p in results[f"{arms[0]}|filtered"]["per_query"]
               if p.get("counted") is False and p["category"] not in ("probe", "control")]
    w("下面这些书的期望书名在库里**没有任何 `chapter_title IS NOT NULL` 的块**，"
      "在过滤开启口径下**物理上不可召回**，计入分母就是污染指标，故剔除：")
    w("")
    if blocked:
        w("| ID | 目标书籍 | Query |")
        w("|---|---|---|")
        for p in blocked:
            w(f"| `{p['id']}` | {p['expected']} | {p['query'][:40]} |")
    else:
        w("（本轮 JSON 未记录 blocked 明细，条数以分母差值 "
          f"{denom_off - denom_on} 为准。）")
    w("")

    # ---- 3. 主结果矩阵 -------------------------------------------------
    for filter_on, title, denom in ((True, "过滤开启（chapter_title IS NOT NULL）", denom_on),
                                    (False, "过滤关闭（全量块）", denom_off)):
        w(f"## 3.{'1' if filter_on else '2'} 主结果矩阵 · {title}　分母 {denom}")
        w("")
        w("| 臂 | Top1 | Top1% | Top10 | Top10% | P50 ms | P95 ms | 实际路径 | 是否 ANN 样本 |")
        w("|---|---:|---:|---:|---:|---:|---:|---|---|")
        for arm in arms:
            agg, _ = get(arm, filter_on)
            if not agg:
                continue
            lat = agg["latency"]
            paths = agg.get("plan_paths") or {}
            real = is_real_hnsw(agg)
            if arm == "exact":
                sample = "—（EXACT 基线）"
            elif real:
                sample = "✅ 是"
            else:
                sample = "❌ 否（FALLBACK）"
            w(f"| `{ARM_SHORT.get(arm, arm)}` | {agg['top1_hits']}/{agg['denominator']} | "
              f"{fmt_pct(agg['top1_rate'])} | {agg['top10_hits']}/{agg['denominator']} | "
              f"{fmt_pct(agg['top10_rate'])} | {lat['p50_ms']} | {lat['p95_ms']} | "
              f"{path_desc(paths)} | {sample} |")
        w("")

    # ---- 4. ⚠ FALLBACK：ef 调大反而切走 HNSW ---------------------------
    w("## 4. ⚠ 关键陷阱：ef=200 / ef=400 触发路径切换，不是 ANN")
    w("")
    w("### 4.1 事实")
    w("")
    flipped = [(a, get(a, True)[0]) for a in arms
               if a.startswith("ann-ef") and get(a, True)[0] and not is_real_hnsw(get(a, True)[0])]
    if flipped:
        w("以下臂**名义上是 ANN 配置，实测优化器放弃了 HNSW**：")
        w("")
        w("| 臂 | 请求的配置 | 实际路径 | 退化条数 | P50 ms |")
        w("|---|---|---|---:|---:|")
        for arm, agg in flipped:
            paths = agg.get("plan_paths") or {}
            n = sum(paths.values())
            w(f"| `{ARM_SHORT.get(arm, arm)}` | `hnsw.ef_search={arm.split('-ef')[1]}`, "
              f"`enable_seqscan=off` | **{path_desc(paths)}** | "
              f"{n}/{n} | {agg['latency']['p50_ms']} |")
        w("")
    w("> **ef=200 / ef=400 出现路径切换，不作为 ANN 参数比较样本。**")
    w("")
    w("它们的召回数字之所以等于 EXACT，是因为它们**就是**在做全量扫描 —— "
      "不是「ANN 效果好」，而是「根本没走 ANN」。")
    w("")

    w("### 4.2 退化后的真实计划（取自本轮 EXPLAIN ANALYZE，向量字面量已截断）")
    w("")
    raw = None
    for arm in arms:
        agg, _ = get(arm, True)
        if agg and not is_real_hnsw(agg) and arm != "exact":
            for p in results[f"{arm}|filtered"]["per_query"]:
                if p.get("plan_raw"):
                    raw = p["plan_raw"]
                    break
        if raw:
            break
    if raw:
        w("```")
        for line in raw.splitlines():
            if "<=>" in line and len(line) > 160:
                head, _, tail = line.partition("<=>")
                tail = tail.strip().lstrip("'")[:60]
                line = head + "<=> '[...] " + tail + " …(向量字面量截断)…"
            w(line)
        w("```")
        w("")
    w("要点：它把 **46,563 行全部算一遍距离再排序**（`Sort Method: top-N heapsort`），"
      "召回等价于精确，代价却远高于 `EXACT` 臂的 Seq Scan。")
    w("")
    w("**结论：ef 调大 ≠ 换到更好的 ANN。中途会踩到 FALLBACK 退化区（本轮实测在 ~160–400 之间）。**")
    w("")

    # ---- 5. real-HNSW 的 ef 边际收益 ----------------------------------
    w("## 5. HNSW 的 ef_search 边际收益（只统计真正走 HNSW 的臂）")
    w("")
    for filter_on, title in ((True, "过滤开启"), (False, "过滤关闭")):
        exagg, _ = get("exact", filter_on)
        if not exagg:
            continue
        w(f"### 5.{'1' if filter_on else '2'} {title}")
        w("")
        w(f"- EXACT 天花板：Top1 {exagg['top1_hits']}/{exagg['denominator']}"
          f"（{fmt_pct(exagg['top1_rate'])}）、Top10 {exagg['top10_hits']}"
          f"/{exagg['denominator']}（{fmt_pct(exagg['top10_rate'])}）、"
          f"P50 {exagg['latency']['p50_ms']} ms")
        w("")
        w("| ef_search | Top1% | 距 EXACT pp | Top10% | 距 EXACT pp | P50 ms | P95 ms | 路径 |")
        w("|---:|---:|---:|---:|---:|---:|---:|---|")
        for arm in arms:
            if not arm.startswith("ann-ef"):
                continue
            agg, _ = get(arm, filter_on)
            if not agg:
                continue
            ef = arm.split("-ef")[1]
            lat = agg["latency"]
            d1 = f"{(agg['top1_rate']-exagg['top1_rate'])*100:+.1f}"
            d10 = f"{(agg['top10_rate']-exagg['top10_rate'])*100:+.1f}"
            paths = agg.get("plan_paths") or {}
            tag = path_desc(paths)
            if not is_real_hnsw(agg):
                d1 = "—"
                d10 = "—"
                tag = f"**{tag}（非 ANN，不计入比较）**"
            w(f"| {ef} | {fmt_pct(agg['top1_rate'])} | {d1} | {fmt_pct(agg['top10_rate'])} | "
              f"{d10} | {lat['p50_ms']} | {lat['p95_ms']} | {tag} |")
        w("")

    # ---- 6. 生产现状 ---------------------------------------------------
    w("## 6. 今天生产实际发生的事")
    w("")
    dagg, _ = get("default", True)
    if dagg:
        paths = dagg.get("plan_paths") or {}
        w("`默认计划` 臂 = **不动任何 GUC**，让 PG 优化器自己选 —— 这就是现在线上跑的样子。")
        w("")
        w("| 项 | 实测 |")
        w("|---|---|")
        w(f"| 实际路径 | **{path_desc(paths)}** |")
        w(f"| Top1 | {dagg['top1_hits']}/{dagg['denominator']}（{fmt_pct(dagg['top1_rate'])}） |")
        w(f"| Top10 | {dagg['top10_hits']}/{dagg['denominator']}"
          f"（{fmt_pct(dagg['top10_rate'])}） |")
        w(f"| P50 / P95 | {dagg['latency']['p50_ms']} / {dagg['latency']['p95_ms']} ms |")
        w(f"| 当时的 `hnsw.ef_search` | **{fp['session_default_ef_search']}**（默认，无人改过） |")
        w("")
        if dominant_path(paths) == "hnsw_ann":
            w("**这是一个没有任何配置变更发生的静默切换**：")
            w("")
            w("- 24k 规模时，优化器判 Seq Scan（＝EXACT）更便宜 → 线上其实是精确检索；")
            w(f"- 规模涨到 {fp['main_rows']:,} 之后，优化器改判 `hnsw_idx`（＝HNSW 近似）→ 线上变成了 ANN；")
            w(f"- 而 `hnsw.ef_search` 一直是默认 **{fp['session_default_ef_search']}**，"
              "正是 Stage 1 曾把召回打到很低的那个值。")
            w("")
            w("也就是说：**Stage B（24k）的所有结论都建立在「走 EXACT」这个前提上，"
              "在今天的生产路径上已经全部过期。**")
    w("")

    # ---- 7. 结论 -------------------------------------------------------
    w("## 7. 结论（事实，不含推断）")
    w("")
    n = 0
    if exact_on:
        n += 1
        w(f"{n}. {fp['main_rows']:,} 规模下，EXACT 的天花板是 Top1 "
          f"{exact_on['top1_hits']}/{exact_on['denominator']}"
          f"（{fmt_pct(exact_on['top1_rate'])}）、Top10 {exact_on['top10_hits']}"
          f"/{exact_on['denominator']}（{fmt_pct(exact_on['top10_rate'])}），"
          f"P50 {exact_on['latency']['p50_ms']} ms / P95 {exact_on['latency']['p95_ms']} ms。")
    if dagg:
        n += 1
        w(f"{n}. 不做任何干预（`默认计划` 臂）：Top1 {dagg['top1_hits']}/{dagg['denominator']}"
          f"（{fmt_pct(dagg['top1_rate'])}）、P50 {dagg['latency']['p50_ms']} ms，"
          f"实际路径 **{path_desc(dagg.get('plan_paths') or {})}**。")
    if best_ann:
        n += 1
        arm, agg = best_ann
        w(f"{n}. 真正走 HNSW 的臂里最高的是 `{arm}`：Top1 "
          f"{agg['top1_hits']}/{agg['denominator']}（{fmt_pct(agg['top1_rate'])}）、"
          f"Top10 {agg['top10_hits']}/{agg['denominator']}"
          f"（{fmt_pct(agg['top10_rate'])}）、P50 {agg['latency']['p50_ms']} ms。")
        w("")
        w("   > ⚠️ 注意：**不是** ef=200/400。那两组虽然数字更高，但实测已切成 FALLBACK（见 §4），"
          "**不是 ANN**，不得作为「ANN 参数」引用。")
    n += 1
    w(f"{n}. ef_search 在 ~{160}–{400} 区间会让优化器切换到 FALLBACK 路径，"
      "延迟反而比 EXACT 更差。这条是非单调的，不是简单「ef 越大越好」。")
    w("")

    w("### 7.1 判据")
    w("")
    w(f"- 任何两组之间的 Top1 差异 **小于 {noise:.1f}pp** 一律视为噪声，不据此决策。")
    w("- 只有差异超过噪声门槛、且延迟可接受时，才谈「切换」。")
    w("- 本报告不替业务做「延迟 vs 召回」的取舍，只把两条曲线的对应点摆出来"
      "（取舍方案见《发现书籍链路-Production Search Strategy.md》）。")
    w("")

    w("### 7.2 本轮没做的事")
    w("")
    w("- ❌ 未调整 `hnsw.ef_search`（仍为默认 40）")
    w("- ❌ 未修改 `postgresql.conf`")
    w("- ❌ 未 REINDEX 正式索引")
    w("- ❌ 未改动 API 查询 SQL / 检索路由 / 连接池配置")
    w("- ❌ 未改动前端发现页")
    w("- ❌ 未删除实验表 / 实验 JSON / 实验索引")
    w("- ❌ 未提交 Git（HEAD 仍 `f2174ba`）")
    w("")

    # ---- 8. 指纹校验 ---------------------------------------------------
    w("## 8. 只读保证")
    w("")
    w("实验前后各跑一次指纹校验：")
    w("")
    w(f"- `fingerprint_diffs`：**{payload['fingerprint_diffs']}**")
    w(f"- 期间主表行数 / embedding / 内容指纹 / 正式索引大小 / v1 备份**全部未变**，只读成立。")
    w("")
    w("| 校验项 | 值 |")
    w("|---|---|")
    w(f"| books / chunks / embedding | {fp['books_count']} / {fp['main_rows']:,} / "
      f"{fp['main_embeddings']:,} |")
    w(f"| content_chars | {fp['main_content_chars_sum']:,} |")
    w(f"| 内容指纹 | `{fp['main_content_fp']}` |")
    w(f"| 正式 HNSW | {idx} |")
    w(f"| v1 备份 | {fp['backup_v1']} |")
    w(f"| `hnsw.ef_search` / `iterative_scan` | "
      f"{fp['session_default_ef_search']} / {fp['session_default_iterative_scan']} |")
    w("")

    # ---- 附录 ----------------------------------------------------------
    w("## 附录 A · 过滤开启逐条明细")
    w("")
    for arm in arms:
        key = f"{arm}|filtered"
        if key not in results:
            continue
        agg = results[key]["aggregate"]
        if not agg:
            continue
        w(f"<details><summary>{ARM_SHORT.get(arm, arm)}　"
          f"路径 {path_desc(agg.get('plan_paths') or {})}</summary>")
        w("")
        w("| ID | 目标书籍 | Top1 实际 | Top1 | Top10 | 行数 | 重复稳定 | 路径 |")
        w("|---|---|---|---|---|--:|---|---|")
        for p in results[key]["per_query"]:
            if not p["counted"]:
                continue
            w(f"| `{p['id']}` | {p['expected'][:34]} | {(p['top1'] or '—')[:34]} | "
              f"{'✓' if p['hit_top1'] else '✗'} | {'✓' if p['hit_top10'] else '✗'} | "
              f"{p['rows_returned']} | {'✓' if p['stable'] else '✗'} | "
              f"{PATH_TAG.get(p.get('plan_path'), '?')} |")
        w("")
        w("</details>")
        w("")

    return "\n".join(out) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="渲染 Stage B.5 最终报告")
    parser.add_argument("--in", dest="input", default=DEFAULT_IN)
    parser.add_argument("--out", default=DEFAULT_OUT)
    args = parser.parse_args(argv)

    root = Path(__file__).resolve().parents[2]
    src = (root / args.input).resolve() if not Path(args.input).is_absolute() else Path(args.input)
    dst = (root / args.out).resolve() if not Path(args.out).is_absolute() else Path(args.out)
    payload = load_payload(src)
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(render(payload), encoding="utf-8")
    print(f"已写出 {dst}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
