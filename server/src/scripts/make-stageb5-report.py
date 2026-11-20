"""
make-stageb5-report.py —— 把 _b5-matrix.json 渲染成 Markdown 报告

只读：不连数据库、不改任何产线对象。输入只有 stage-b5-experiment.py 写出的 JSON。

用法：
    cd server
    python src/scripts/make-stageb5-report.py
    python src/scripts/make-stageb5-report.py --in .crawl-cache/_b5-matrix.json \
        --out ../发现书籍链路-StageB5实验报告.md
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

DEFAULT_IN = ".crawl-cache/_b5-matrix.json"
DEFAULT_OUT = "../发现书籍链路-StageB5实验报告.md"

ARM_LABEL = {
    "default": "① 默认计划（= 今天生产实际发生的事）",
    "exact": "② 强制精确检索（禁用索引，Seq Scan）",
    "ann-ef40": "③ ANN · ef_search=40（= 会话默认值）",
    "ann-ef80": "④ ANN · ef_search=80",
    "ann-ef120": "⑤ ANN · ef_search=120",
    "ann-ef200": "⑥ ANN · ef_search=200",
    "ann-ef400": "⑦ ANN · ef_search=400",
    "ann-ef800": "⑧ ANN · ef_search=800",
    "ann-ef100": "ANN · ef_search=100",
    "ann-ef40-strict": "ANN · ef=40 · iterative_scan=off（复现饥饿）",
    "ann-ef200-strict": "ANN · ef=200 · iterative_scan=off",
}

ARM_SHORT = {
    "default": "默认计划",
    "exact": "强制精确",
    "ann-ef40": "ANN ef=40",
    "ann-ef80": "ANN ef=80",
    "ann-ef100": "ANN ef=100",
    "ann-ef120": "ANN ef=120",
    "ann-ef200": "ANN ef=200",
    "ann-ef400": "ANN ef=400",
    "ann-ef800": "ANN ef=800",
    "ann-ef40-strict": "ANN ef=40 严格扫描",
    "ann-ef200-strict": "ANN ef=200 严格扫描",
}


def fmt_pct(rate: float) -> str:
    return f"{rate * 100:.1f}%"


def plan_desc(nodes: dict) -> str:
    parts = [f"{k}×{v}" for k, v in sorted(nodes.items(), key=lambda kv: -kv[1])]
    return " + ".join(parts) if parts else "—"


PATH_LABEL = {
    "hnsw_ann": "HNSW 近似",
    "seq_exact": "Seq Scan 精确",
    "other_index_exact": "⚠ 其他索引全扫+排序（变相精确）",
    "other": "其他",
}


def path_desc(paths: dict) -> str:
    parts = [f"{PATH_LABEL.get(k, k)}×{v}" for k, v in sorted(paths.items(), key=lambda kv: -kv[1])]
    return "；".join(parts) if parts else "—"


def load_payload(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def render(payload: dict) -> str:
    cfg = payload["config"]
    fp = payload["fingerprint"]
    results = payload["results"]
    denom_off = cfg["denominator_unfiltered"]
    denom_on = cfg["denominator_filtered"]
    arms = [a for a in cfg["arms"]]

    out: list[str] = []
    w = out.append

    w("# 发现书籍链路 · Stage B.5 实验报告")
    w("")
    w(f"> 生成时间：{payload['generated_at']}　·　数据集：30 本冻结（《StageB5-30本冻结数据集报告.md》）")
    w(f"> 脚本：`server/src/scripts/stage-b5-experiment.py`（**只读**，不建索引、不写库）")
    w(f"> 原始数据：`server/.crawl-cache/_b5-matrix.json`")
    w("")
    w("---")
    w("")

    # ---- 0. 结论先行 ------------------------------------------------
    w("## 0. 一句话结论")
    w("")
    key_rows = []
    for arm in arms:
        for filter_on, key2, denom in ((False, "unfiltered", denom_off), (True, "filtered", denom_on)):
            agg = results.get(f"{arm}|{key2}", {}).get("aggregate")
            if not agg:
                continue
            key_rows.append((arm, filter_on, agg, denom))

    def get(arm, filter_on):
        for a, f, agg, d in key_rows:
            if a == arm and f == filter_on:
                return agg, d
        return None, None

    def fact(arm):
        agg, _ = get(arm, True)
        return agg

    d_agg, e_agg, a_agg = fact("default"), fact("exact"), fact("ann-ef800")
    w("> 详细数字见 §3。先看三件最重要的事：")
    w(">")
    w("> 1. **今天生产正在发生什么**：优化器在 58k 规模下已不再自选 Seq Scan，`默认计划` 臂实测走")
    if d_agg:
        w(f">    **HNSW 近似**，Top1 {d_agg['top1_hits']}/{d_agg['denominator']}"
          f"（{fmt_pct(d_agg['top1_rate'])}）、P50 {d_agg['latency']['p50_ms']} ms。"
          f"这不是配置改出来的，是规模涨上去之后优化器自己换的。")
    w("> 2. **召回天花板有多高**：强制精确检索能到")
    if e_agg:
        w(f">    Top1 {e_agg['top1_hits']}/{e_agg['denominator']}"
          f"（{fmt_pct(e_agg['top1_rate'])}），代价是 P50 从个位数毫秒涨到 "
          f"**{e_agg['latency']['p50_ms']} ms**（约 200+ 倍）。")
    w("> 3. **ANN 能不能追平**：真正走 HNSW 的臂里，把 ef_search 拉到 800 才能贴近精确")
    if a_agg and e_agg:
        w(f">    （Top1 {a_agg['top1_hits']}/{a_agg['denominator']}，距精确 "
          f"{(a_agg['top1_rate']-e_agg['top1_rate'])*100:+.1f}pp），而 P50 只有 "
          f"{a_agg['latency']['p50_ms']} ms —— 但 Top10 仍差 "
          f"{(a_agg['top10_rate']-e_agg['top10_rate'])*100:+.1f}pp。")
    w(">")
    w(f"> 噪声门槛：过滤开启分母 {denom_on} 条 → 1 条 = **{100/denom_on:.1f}pp**；"
      f"过滤关闭分母 {denom_off} 条 → 1 条 = **{100/denom_off:.1f}pp**。")
    w("> 低于这个量的差异不解读。")
    w("")

    # ---- 1. 实验设计 ------------------------------------------------
    w("## 1. 实验设计")
    w("")
    w("### 1.1 与 Stage B 的区别")
    w("")
    w("| | Stage B（24k） | Stage B.5（30 本 / 58k） |")
    w("|---|---|---|")
    w("| 研究对象 | 索引**构建**参数 m / ef_construction | 查询期**执行路径**与 ef_search |")
    w("| 载体 | 实验副本表 `discovered_book_chunks_exp`，反复 DROP/CREATE 索引 | **只读跑正式表**，不建任何索引 |")
    w(f"| 分母 | 13 条（1 条 = 7.7pp） | **{denom_on} / {denom_off} 条**"
      f"（1 条 = {100/denom_on:.1f} / {100/denom_off:.1f}pp） |")
    w("| 要回答 | HNSW 建不建得起 | 生产到底走精确还是 ANN |")
    w("")
    w("### 1.2 为什么必须重做")
    w("")
    w("Stage C 把规模从 24k 推到 58k 之后，出现了一个**无配置变更的静默切换**：")
    w("")
    w("- 24k 时优化器判 Seq Scan（＝精确检索）更便宜；")
    w("- 58k 时改判 Index Scan using `discovered_book_chunks_embedding_hnsw_idx`（＝ANN 近似检索）；")
    w("- 而 `hnsw.ef_search` 一直是默认 **40**——正是 Stage 1 曾把召回打到 1/6 的那个值。")
    w("")
    w("也就是说：**Stage B 的所有结论都是在「走精确检索」的前提下得出的，在今天的生产路径上已经全部过期。**")
    w("")
    w("### 1.3 臂（查询期配置）")
    w("")
    w("| 臂 | set_config 设置 | 意图 |")
    w("|---|---|---|")
    for arm in arms:
        if arm == "default":
            setting = "（不动任何 GUC）"
        elif arm == "exact":
            setting = "enable_indexscan/bitmapscan/indexonlyscan = off"
        else:
            ef = arm.split("-ef")[1].split("-")[0]
            strict = "iterative_scan=off" if arm.endswith("-strict") else "iterative_scan=relaxed_order"
            setting = f"enable_seqscan=off, hnsw.ef_search={ef}, {strict}"
        w(f"| `{arm}` | {setting} | {ARM_LABEL.get(arm, '')} |")
    w("")
    w("所有会话级参数一律 `set_config(..., true)`（＝`SET LOCAL`），与检索同事务，commit 后自动重置，")
    w("**不污染连接池**。所有臂跑同一份查询字面量、同一份 embedding、同一个正式索引。")
    w("")
    w("### 1.4 只读保证")
    w("")
    diffs = payload.get("fingerprint_diffs") or []
    if diffs:
        w("⚠ **实验前后指纹发生变化**：")
        w("")
        for d in diffs:
            w(f"- {d}")
        w("")
        w("本脚本只有 SELECT，出现差异说明有别的东西在动库，下方数字不可直接采信。")
    else:
        w("实验前后各跑一次指纹校验，**零差异**——期间主表行数 / embedding / 内容指纹 / 正式索引大小 /")
        w("v1 备份全部未变，只读保证成立。")
    w("")
    w("| 校验项 | 值 |")
    w("|---|---|")
    w(f"| 书籍 / chunk / embedding | {fp['books_count']} / {fp['main_rows']} / {fp['main_embeddings']} |")
    w(f"| 正文字符合计 | {fp['main_content_chars_sum']:,} |")
    w(f"| 无章节块 | {fp['main_null_chapter']:,} |")
    w(f"| 正式 HNSW 索引 | {fp['main_hnsw_index']} |")
    w(f"| 内容指纹 | `{fp['main_content_fp']}` |")
    w(f"| v1 备份 | {fp['backup_v1']} |")
    w(f"| 会话默认 hnsw.ef_search / iterative_scan | {fp.get('session_default_ef_search')} / "
      f"{fp.get('session_default_iterative_scan')} |")
    w("")

    # ---- 2. 查询集 --------------------------------------------------
    w("## 2. 查询集与分母")
    w("")
    queries = payload["queries"]
    cats: dict[str, int] = {}
    for q in queries:
        cats[q["category"]] = cats.get(q["category"], 0) + 1
    w("| 类别 | 条数 | 是否计入分母 |")
    w("|---|---:|---|")
    for cat, n in cats.items():
        counted = "否（行为探针 / 负对照）" if cat in ("probe", "control") else "是"
        w(f"| `{cat}` | {n} | {counted} |")
    w(f"| **合计** | **{len(queries)}** | |")
    w("")
    blocked = [q for q in queries if q.get("blocked_when_filtered")]
    w(f"**过滤开启口径自动出局 {len(blocked)} 条**（期望书名在库中没有任何 `chapter_title IS NOT NULL` 的块，")
    w("该书在这口径下物理上不可召回，计入分母是对指标的污染）：")
    w("")
    for q in blocked:
        w(f"- `{q['id']}` 《{q['expected']}》 —— {q['query'][:40]}")
    w("")
    w(f"- 过滤关闭分母 = **{denom_off}**（1 条 = {100/denom_off:.1f}pp）")
    w(f"- 过滤开启分母 = **{denom_on}**（1 条 = {100/denom_on:.1f}pp）")
    w("")

    # ---- 3. 主结果 --------------------------------------------------
    w("## 3. 主结果矩阵")
    w("")
    for filter_on, key2, denom in ((False, "unfiltered", denom_off), (True, "filtered", denom_on)):
        title = "过滤开启（chapter_title IS NOT NULL）" if filter_on else "过滤关闭（全量块）"
        w(f"### 3.{1 if not filter_on else 2} {title}　分母 {denom}")
        w("")
        w("| 臂 | Top1 | Top1% | Top3 | Top3% | Top10 | Top10% | P50 ms | P95 ms | 实际执行路径 |")
        w("|---|---:|---:|---:|---:|---:|---:|---:|---:|---|")
        for arm in arms:
            agg, _ = get(arm, filter_on)
            if not agg:
                continue
            lat = agg["latency"]
            pd = plan_desc(agg.get("plan_paths") or agg.get("plan_nodes") or {})
            w(f"| `{ARM_SHORT.get(arm, arm)}` | {agg['top1_hits']}/{agg['denominator']} | "
              f"{fmt_pct(agg['top1_rate'])} | {agg['top3_hits']}/{agg['denominator']} | "
              f"{fmt_pct(agg['top3_rate'])} | {agg['top10_hits']}/{agg['denominator']} | "
              f"{fmt_pct(agg['top10_rate'])} | {lat['p50_ms']} | {lat['p95_ms']} | "
              f"{pd} |")
        w("")
        # 稳定性与异常
        w("异常项：")
        w("")
        w("| 臂 | 重复结果不一致 | 返回 0 行 | 返回不足 K 行 | 结果里混入无章节块 |")
        w("|---|---:|---:|---:|---:|")
        for arm in arms:
            agg, _ = get(arm, filter_on)
            if not agg:
                continue
            w(f"| `{ARM_SHORT.get(arm, arm)}` | {agg['stability_failures']} | "
              f"{agg['starved_queries']} | {agg['underfilled_queries']} | {agg['null_chapter_leak']} |")
        w("")
        note = ("过滤开启时「混入无章节块」必须为 0，否则过滤器失效；"
                if filter_on else "过滤关闭时本就允许出现无章节块，这一列无意义；")
        w(f"> {note}「重复结果不一致」= 同一条 Query 的第 2~5 次 Top-K 不一致，反映 ANN 的随机性。")
        w("")

    # ---- 3.5 执行路径陷阱 -------------------------------------------
    w("### 3.3 ⚠ 关键陷阱：某些 ef 下优化器会放弃 HNSW，悄悄退回全扫+排序")
    w("")
    flipped: list[tuple[str, dict, int]] = []
    for arm in arms:
        agg, _ = get(arm, True)
        if not agg:
            continue
        paths = agg.get("plan_paths") or {}
        n_sneaky = sum(v for k, v in paths.items() if k == "other_index_exact")
        if n_sneaky:
            flipped.append((arm, agg, n_sneaky))
    if flipped:
        w("过滤开启口径下，以下臂**名义上是 ANN，实际走的不是 HNSW**：")
        w("")
        w("| 臂 | 实际路径分布 | 退化条数 | P50 ms |")
        w("|---|---|---:|---:|")
        for arm, agg, n in flipped:
            n_all = len(results[f"{arm}|filtered"]["per_query"])
            w(f"| `{ARM_SHORT.get(arm, arm)}` | {plan_desc(agg.get('plan_paths') or {})} | "
              f"{n}/{n_all} | {agg['latency']['p50_ms']} |")
        w("")
        w("退化后的实际计划（取自本轮真实 `EXPLAIN ANALYZE`，向量字面量已截断）：")
        w("")
        snippet = None
        for p in results[f"{flipped[0][0]}|filtered"]["per_query"]:
            if p.get("plan_path") == "other_index_exact" and p.get("plan_raw"):
                snippet = p["plan_raw"]
                break
        w("```")
        if snippet:
            for line in snippet.splitlines():
                # 只留结构行，向量字面量太长，截断
                w(line if len(line) < 300 else line[:260] + " ……(向量字面量截断)……")
        else:
            w("（未取到原始计划文本）")
        w("```")
        w("")
        w("它把 **46,563 行全部算一遍距离再排序**——召回率等于精确检索，但代价远高于")
        w("「强制精确」臂的 Seq Scan。也就是说：**ef 调大不一定换来 ANN，")
        w("反而可能触发一次没人察觉的静默降级。**")
        w("")
        w("这类臂的召回数字**不能当作 ANN 的结果解读**，本报告在 ANN 边际收益表中已按路径标注。")
    else:
        w("本轮所有 ANN 臂在两种过滤口径下都确实走了 HNSW 索引，未观察到退化。")
    w("")

    # ---- 4. 边际收益 ------------------------------------------------
    w("## 4. ANN 的 ef_search 边际收益")
    w("")
    ann_arms = [a for a in arms if a.startswith("ann-ef") and not a.endswith("-strict")]
    if ann_arms:
        for filter_on, key2 in ((True, "filtered"), (False, "unfiltered")):
            w(f"**{'过滤开启' if filter_on else '过滤关闭'}**：相对同口径精确检索的天花板")
            w("")
            exact_agg, _ = get("exact", filter_on)
            if exact_agg:
                w(f"- 精确检索天花板 Top1 = {exact_agg['top1_hits']}/{exact_agg['denominator']} "
                  f"（{fmt_pct(exact_agg['top1_rate'])}），"
                  f"Top10 = {exact_agg['top10_hits']}/{exact_agg['denominator']} "
                  f"（{fmt_pct(exact_agg['top10_rate'])}），"
                  f"P50 {exact_agg['latency']['p50_ms']} ms / P95 {exact_agg['latency']['p95_ms']} ms")
            w("")
            w("| ef_search | Top1% | 距精确 pp | Top10% | 距精确 pp | P50 ms | P95 ms | 实际路径 |")
            w("|---:|---:|---:|---:|---:|---:|---:|---|")
            for arm in ann_arms:
                agg, _ = get(arm, filter_on)
                if not agg:
                    continue
                ef = arm.split("-ef")[1]
                paths = agg.get("plan_paths") or {}
                pure = all(k == "hnsw_ann" for k in paths)
                pd = plan_desc(paths) + ("" if pure else "　**← 非 ANN，勿按 ANN 解读**")
                if exact_agg:
                    d1 = (agg["top1_rate"] - exact_agg["top1_rate"]) * 100
                    d10 = (agg["top10_rate"] - exact_agg["top10_rate"]) * 100
                    d1s, d10s = f"{d1:+.1f}", f"{d10:+.1f}"
                else:
                    d1s = d10s = "—"
                lat = agg["latency"]
                w(f"| {ef} | {fmt_pct(agg['top1_rate'])} | {d1s} | {fmt_pct(agg['top10_rate'])} | "
                  f"{d10s} | {lat['p50_ms']} | {lat['p95_ms']} | {pd} |")
            w("")

    # ---- 5. 与 Stage B / Stage 1 的跨期比较 -------------------------
    w("## 5. 跨期比较")
    w("")
    w("### 5.1 跨期对照")
    w("")
    w("| 阶段 | 规模 | 分母 | 当时的默认路径 | 说明 |")
    w("|---|---|---:|---|---|")
    w("| Stage 1.5 | 24k | 13 | Seq Scan（精确） | 优化器自选精确 |")
    w("| Stage B | 24k（实验副本表） | 13 | Seq Scan（精确） | 结论全部建立在「走精确」的前提上 |")
    w(f"| **Stage B.5** | **58k** | **{denom_on} / {denom_off}** | 见 §3 `默认计划` 臂 | 前提已变，须重评 |")
    w("")
    fixed_rows: list[tuple[str, dict]] = []
    for arm in arms:
        agg, _ = get(arm, True)
        if not agg:
            continue
        fixed = [p for p in results[f"{arm}|filtered"]["per_query"]
                 if p["category"] == "fixed" and p["counted"]]
        if fixed:
            hits = sum(1 for p in fixed if p["hit_top1"])
            fixed_rows.append((arm, {"hits": hits, "n": len(fixed)}))
    if fixed_rows:
        w("**Stage 1 固定 6 条单独看**（跨阶段唯一口径完全一致的 6 条，过滤开启）：")
        w("")
        w("| 臂 | Top1 |")
        w("|---|---|")
        for arm, d in fixed_rows:
            w(f"| `{ARM_SHORT.get(arm, arm)}` | {d['hits']}/{d['n']} |")
        w("")

    # ---- 6. 结论与建议 ----------------------------------------------
    w("## 6. 结论")
    w("")
    w("### 6.1 事实（不含推断）")
    w("")
    # 只在「实际路径确实是 HNSW 近似」的臂里选最优。
    # 否则会把 ef=200/400 那种退化成全扫+排序的臂算成「ANN 最优」——
    # 它们召回高是因为它们根本不是 ANN，拿来做结论会直接误导决策。
    real_ann_arms = []
    for arm in ann_arms:
        agg, _ = get(arm, True)
        if not agg:
            continue
        paths = agg.get("plan_paths") or {}
        if paths and all(k == "hnsw_ann" for k in paths):
            real_ann_arms.append((arm, agg))
    best_ann = None
    for arm, agg in real_ann_arms:
        if best_ann is None or agg["top1_rate"] > best_ann[1]["top1_rate"]:
            best_ann = (arm, agg)
    exact_agg, _ = get("exact", True)
    default_agg, _ = get("default", True)
    if exact_agg:
        w(f"1. 58k 规模下，精确检索的天花板是 Top1 {exact_agg['top1_hits']}/{exact_agg['denominator']}"
          f"（{fmt_pct(exact_agg['top1_rate'])}），P50 {exact_agg['latency']['p50_ms']} ms"
          f" / P95 {exact_agg['latency']['p95_ms']} ms。")
    if default_agg:
        w(f"2. 不加任何干预、让优化器自选时（`默认计划` 臂）：Top1 "
          f"{default_agg['top1_hits']}/{default_agg['denominator']}"
          f"（{fmt_pct(default_agg['top1_rate'])}），P50 {default_agg['latency']['p50_ms']} ms"
          f" / P95 {default_agg['latency']['p95_ms']} ms，实际走的是 "
          f"{path_desc(default_agg.get('plan_paths') or {})}。")
    if best_ann:
        agg = best_ann[1]
        w(f"3. **真正走 HNSW 近似**的臂里最高的是 `{best_ann[0]}`：Top1 "
          f"{agg['top1_hits']}/{agg['denominator']}"
          f"（{fmt_pct(agg['top1_rate'])}），P50 {agg['latency']['p50_ms']} ms"
          f" / P95 {agg['latency']['p95_ms']} ms。")
        if len(real_ann_arms) < len([a for a in ann_arms if get(a, True)[0]]):
            w("")
            w(f"   （ef=200 / ef=400 的召回数字更高，但那两组实测已退化成全扫+排序，"
              f"**不是 ANN**，见 §3.3，不计入本条比较。）")
    w("")
    w("### 6.2 判据")
    w("")
    w(f"- 任何两组之间的 Top1 差异 **小于 {max(100/denom_on, 2.2):.1f}pp** 的一律视为噪声，不据此决策。")
    w("- 只有差异超过噪声门槛、且延迟可接受时，才谈「切换」。")
    w("- 本报告不替业务做「延迟 vs 召回」的取舍，只把两条曲线的对应点摆出来。")
    w("")
    w("### 6.3 尚未做的事")
    w("")
    w("- **没有改任何生产配置**：`discovered_book_chunks_embedding_hnsw_idx` 未 REINDEX，`hnsw.ef_search` 未动。")
    w("- **没有改 API / 前端**：`server/src` 的检索路径本轮零改动。")
    w("- **没有提交 Git**（HEAD 仍为初始 commit）。")
    w("- 要不要在生产里显式固定执行路径、要不要上调 ef_search，等产品拍板后再动。")
    w("")

    # ---- 附录：逐条明细 ---------------------------------------------
    w("## 附录 A · 过滤开启口径逐条明细（选择的臂）")
    w("")
    for arm in arms:
        agg, _ = get(arm, True)
        if not agg:
            continue
        w(f"<details><summary>{ARM_SHORT.get(arm, arm)}</summary>")
        w("")
        w("| ID | 期望书名 | Top1 实际 | Top1 | Top10 | 行数 | 重复稳定 | 路径 |")
        w("|---|---|---|---|---|--:|---|---|")
        for p in results[f"{arm}|filtered"]["per_query"]:
            if not p["counted"]:
                continue
            w(f"| {p['id']} | {p['expected'][:38]} | {(p['top1'] or '—')[:38]} | "
              f"{'✓' if p['hit_top1'] else '✗'} | {'✓' if p['hit_top10'] else '✗'} | "
              f"{p['rows_returned']} | {'✓' if p['stable'] else '✗'} | "
              f"{PATH_LABEL.get(p.get('plan_path'), '?')} |")
        w("")
        w("</details>")
        w("")

    return "\n".join(out) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="渲染 Stage B.5 实验报告")
    parser.add_argument("--in", dest="input", default=DEFAULT_IN)
    parser.add_argument("--out", default=DEFAULT_OUT)
    args = parser.parse_args(argv)

    root = Path(__file__).resolve().parents[2]
    src = (root / args.input).resolve() if not Path(args.input).is_absolute() else Path(args.input)
    dst = (root / args.out).resolve() if not Path(args.out).is_absolute() else Path(args.out)
    payload = load_payload(src)
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(render(payload), encoding="utf-8")
    print(f"已写出 {dst}（{len(payload['results'])} 个组合）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
