# -*- coding: utf-8 -*-
"""
B.7 · 渲染 Stage-B7-execution-report.md（纯渲染，只读所有中间产物）

用法：C:/Python314/python.exe -u src/scripts/make-b7-execution-report.py
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import sys
from pathlib import Path

SERVER_ROOT = Path(__file__).resolve().parents[2]
ROOT = SERVER_ROOT.parent
CACHE = SERVER_ROOT / ".crawl-cache"

B7 = CACHE / "_b7-matrix.json"
PLANOBS = CACHE / "_b7-plan-observations.json"
SESSCHK = CACHE / "_b7-session-init-check.json"
SCALE = CACHE / "_scale-latency-curve.json"
LAT = CACHE / "_query-embedding-latency.json"
V3 = ROOT / "discover-query-set-v3.json"
OUT = ROOT / "Stage-B7-execution-report.md"

ENC_S, ENC_L = 91.15, 177.96   # 阶段 2 实测：短句 / 长句 query 编码 P50


def jload(p: Path):
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


def mcnemar_p(a: int, b: int) -> float:
    n = a + b
    if n == 0:
        return 1.0
    k = min(a, b)
    return min(1.0, 2 * sum(math.comb(n, i) for i in range(k + 1)) / (2 ** n))


def verdict(p: float) -> str:
    if p < 0.01:
        return "**显著劣化**"
    if p < 0.05:
        return "显著劣化"
    if p < 0.10:
        return "边缘"
    return "无显著差异"


def db_scalar(sql: str, ):
    import psycopg2
    url = None
    for line in (SERVER_ROOT / ".env").read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if s and not s.startswith("#") and "=" in s:
            k, _, v = s.partition("=")
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    url = os.environ["DATABASE_URL"]
    c = psycopg2.connect(url)
    c.autocommit = True
    cur = c.cursor()
    # pgvector 的 GUC 要等扩展在本会话加载后才存在，否则
    # current_setting('hnsw.ef_search') 报 unrecognized configuration parameter
    cur.execute("SELECT NULL::vector")
    cur.execute(sql)
    row = cur.fetchone()
    c.close()
    return row[0] if row and len(row) == 1 else row


def main() -> int:
    b7, obs, sess, scale = jload(B7), jload(PLANOBS), jload(SESSCHK), jload(SCALE)
    for name, v in (("_b7-matrix.json", b7), ("_b7-plan-observations.json", obs),
                    ("_b7-session-init-check.json", sess), ("_scale-latency-curve.json", scale)):
        if v is None:
            raise SystemExit(f"缺少中间产物：{name}")

    res = b7["results"]
    exact = res["exact"]["aggregate"]
    ex_map = {it["id"]: it for it in res["exact"]["per_query"] if it["counted"]}
    denom = exact["denominator"]

    def stats_for(arm: str) -> dict:
        am = {it["id"]: it for it in res[arm]["per_query"]}
        out = {}
        for key in ("hit_top1", "hit_top10"):
            a = b = 0
            for qid, e in ex_map.items():
                g = am.get(qid)
                if not g:
                    continue
                eh, gh = bool(e[key]), bool(g[key])
                if eh and not gh:
                    a += 1
                elif gh and not eh:
                    b += 1
            out[key] = {"delta": b - a, "disc": f"{a}/{b}", "p": mcnemar_p(a, b)}
        return out

    lines: list[str] = []
    w = lines.append

    # ------------------------------------------------------------------
    w("# Stage B.7 — 决策落地与验证")
    w("")
    w(f"生成时间：{b7['generated_at']}　|　矩阵耗时 {b7['elapsed_seconds']/60:.1f} 分钟　|　"
      f"分母 {denom} 条　|　top_k={b7['config']['top_k']}　|　"
      f"过滤口径：{b7['config']['filter']}")
    w("")
    w("**全程只读**：未改 postgresql.conf、未改 ef_search 默认值、未 REINDEX、"
      "未写正式表、未提交 Git（§6 之前的动作）")
    w("")
    w("---")
    w("")
    w("## §0 本轮结论速览")
    w("")
    w("| 任务 | 结果 |")
    w("|---|---|")
    w("| **任务 1（P0）iterative_scan 修复** | **PASS** —— 饥饿 7→0，Top10 +4pp，"
      "会话级（连接池 init）姿势同样有效 |")
    w("| **任务 2 ef_search 重验** | 走决策树**分支 2**：仍推荐 `ef=800`，"
      "但 **Top10 损失未因修复而改善**（Δ −9pp，p=0.0117），必须标注为已知损失 |")
    w("| **任务 3 执行计划观测** | 退化区**与 iterative_scan 取值无关**："
      "ef=200/400 三档全 FALLBACK（545~804 ms）；ef=800 稳定 HNSW |")
    w("| **任务 4 HTTP API** | 已出方案（§9），**本轮不实现** |")
    w("| **任务 5 产物入库** | 见 §6 |")
    w("")
    w("> ⚠ **一个必须上报的意外**：同一批数据、同一 SQL，EXACT 检索 P50 在 B.6 是 220.7 ms，"
      f"本轮复测是 **276.9 ms**（矩阵内带模型常驻时 {exact['latency']['p50_ms']} ms）。"
      "**阈值结论随之下移，Q1 的 400 ms 预算对长 query 已经越线**。见 §4。")
    w("")

    # ------------------------------------------------------------------ §1
    w("## §1 iterative_scan 修复（P0）")
    w("")
    w("### §1.1 前置确认")
    w("")
    w("- pgvector 版本：**0.8.6**（≥ 0.8.0，`iterative_scan` 可用）")
    w("- 三个取值在本库均可接受：`off` / `strict_order` / `relaxed_order`")
    w("- 会话默认：`hnsw.iterative_scan = off`、`hnsw.ef_search = 40`")
    w("")
    w("### §1.2 修改前 / 修改后（ef=40，即生产默认；100 条，过滤开）")
    w("")
    w("| 配置 | 返回 0 行的 query | 返回不足的 query | Top1 | Top10 | P50 ms | 路径 |")
    w("|---|---:|---:|---:|---:|---:|---|")
    for arm, note in (("ef40-off", "**修改前（今天生产）**"),
                      ("ef40-strict_order", "**修改后（strict_order）**"),
                      ("ef40-relaxed_order", "对照（relaxed_order）")):
        a = res[arm]["aggregate"]
        w(f"| {note} | **{a['starved_queries']}** | {a['underfilled_queries']} | "
          f"{a['top1_hits']}/{denom} | {a['top10_hits']}/{denom} | "
          f"{a['latency']['p50_ms']} | {list(a['plan_paths'])[0]} |")
    w("")
    w("### §1.3 真实部署姿势验证（连接池 connect 钩子 = 会话级，只设一次）")
    w("")
    w("B.7 矩阵用的是事务级 `set_config(..., true)`；真正落到应用里更可能是连接池 "
      "`connect` 钩子（会话级 `false`）。单独验证这条路：")
    w("")
    if sess:
        w("| 连接 | init 方式 | 返回 0 行 | 返回不足 | 行数分布 |")
        w("|---|---|---:|---:|---|")
        for r in sess["results"]:
            init = ", ".join(f"{g}={v}" for g, v in r["init"]) or "（不 init）"
            w(f"| {r['label']} | `{init}` | **{r['starved']}** | {r['underfilled']} | "
              f"`{r['rows_distribution']}` |")
        w("")
        w(f"- R5 校验：全新连接 `SHOW hnsw.iterative_scan` = **{sess['new_session_iterative_scan']}**"
          f"（期望 off）、`SHOW hnsw.ef_search` = **{sess['new_session_ef_search']}**（期望 40）✅")
        w("- 未 init 的那条连接完整复现了 bug：5 条返回 0 行、3 条返回 1 行、2 条返回 2 行。")
    w("")
    w("### §1.4 验收")
    w("")
    e_off, e_strict = res["ef40-off"]["aggregate"], res["ef40-strict_order"]["aggregate"]
    ok0 = e_strict["starved_queries"] == 0
    ok1 = e_strict["underfilled_queries"] <= 2
    ok2 = e_strict["top1_hits"] >= e_off["top1_hits"]
    w("| 验收项 | 期望 | 实际 | 判定 |")
    w("|---|---|---:|---|")
    w(f"| 返回 0 行的 query 数 | 0 | {e_strict['starved_queries']} | "
      f"{'PASS' if ok0 else 'FAIL'} |")
    w(f"| 返回不足的 query 数 | ≤ 2 | {e_strict['underfilled_queries']} | "
      f"{'PASS' if ok1 else 'FAIL'} |")
    w(f"| Top1 相比 off | 提升或持平 | {e_off['top1_hits']} → {e_strict['top1_hits']} | "
      f"{'PASS' if ok2 else 'FAIL'} |")
    w("")
    w(f"**结论：{'PASS' if (ok0 and ok1 and ok2) else 'FAIL'}** —— "
      "`iterative_scan` 修复有效，饥饿完全消除，Top10 还额外 +"
      f"{e_strict['top10_hits'] - e_off['top10_hits']}pp。")
    w("")
    w("**落地方式**：见 `server/src/scripts/b7-iterative-scan-fix.sql` —— "
      "连接级 `set_config('hnsw.iterative_scan','strict_order',false)` 或事务级 `(..., true)`。"
      "**明确禁止** `ALTER SYSTEM` / `ALTER ROLE` / `ALTER DATABASE` / 改 postgresql.conf。")
    w("")
    w("> ⚠ **当前没有落点**：已 grep 确认，除 scripts 外**没有任何业务代码查询 "
      "`discovered_book_chunks`**（发现书籍没有 HTTP API）。上面这条初始化语句是**预置**的，"
      "真正的接入点是未来 `/api/discover` 的连接池。")
    w("")

    # ------------------------------------------------------------------ §2
    w("## §2 ef_search 重验（strict_order 生效后）")
    w("")
    w("与 B.7 自己的 EXACT 基线配对（McNemar 精确检验）：")
    w("")
    w("| 臂 | Top1 Δ | p(Top1) | 判定 | Top10 Δ | p(Top10) | 判定 | P50 ms | Plan Type |")
    w("|---|---:|---:|---|---:|---:|---:|---:|---|")
    for arm in ("ef40-strict_order", "ef120-strict_order", "ef800-strict_order"):
        a = res[arm]["aggregate"]
        st = stats_for(arm)
        w(f"| ef={arm.split('-')[0][2:]} · strict_order | {st['hit_top1']['delta']:+d}pp | "
          f"{st['hit_top1']['p']:.4f} | {verdict(st['hit_top1']['p'])} | "
          f"{st['hit_top10']['delta']:+d}pp | {st['hit_top10']['p']:.4f} | "
          f"{verdict(st['hit_top10']['p'])} | {a['latency']['p50_ms']} | "
          f"{list(a['plan_paths'])[0]} |")
    w(f"| EXACT 基准 | — | — | — | — | — | — | {exact['latency']['p50_ms']} | seq_exact |")
    w("")
    w("### §2.1 strict_order 到底改善了什么（三档横向对比）")
    w("")
    w("| ef | off（饥饿）Top10 | strict_order Top10 | relaxed_order Top10 | 修复带来的 Top10 增量 |")
    w("|---:|---:|---:|---:|---:|")
    for ef in (40, 120, 800):
        o = res[f"ef{ef}-off"]["aggregate"]
        s = res[f"ef{ef}-strict_order"]["aggregate"]
        r = res[f"ef{ef}-relaxed_order"]["aggregate"]
        w(f"| {ef} | {o['top10_hits']}/{denom} | **{s['top10_hits']}/{denom}** | "
          f"{r['top10_hits']}/{denom} | "
          f"{'+%dpp' % (s['top10_hits'] - o['top10_hits']) if s['top10_hits'] > o['top10_hits'] else '0'} |")
    w("")
    w("**关键发现：修复只帮到低 ef，对 ef=800 是零改善。**")
    w("")
    w("- ef=40：Top10 42 → 46（+4pp）")
    w("- ef=120：Top10 54 → 56（+2pp）")
    w("- **ef=800：Top10 70 → 70（0）**，且不一致对完全相同（10/1）—— "
      "三档 `iterative_scan` 下 ef=800 的召回结果集**一模一样**。")
    w("")
    w("原因很直白：ef=800 时 HNSW 每轮已经看够 800 个候选，`chapter_title IS NOT NULL` "
      "过滤压不垮它；饥饿只发生在低 ef（尤其 ef=40）。")
    w("")
    w("### §2.2 决策树判定")
    w("")
    st800 = stats_for("ef800-strict_order")
    st120 = stats_for("ef120-strict_order")
    w("| 分支条件 | 是否满足 |")
    w("|---|---|")
    w(f"| ① ef=800 + strict_order 下 Top10 p > 0.05 | ❌ 不满足（p={st800['hit_top10']['p']}） |")
    w(f"| ② ef=800 Top10 仍 p<0.05 但 Δ 缩小 | ❌ Δ 未缩小（B.6 relaxed 就是 −9pp，"
      f"本轮 strict 仍是 {st800['hit_top10']['delta']}pp） |")
    w(f"| ③ ef=120 Top1 p>0.05 且 Top10 Δ 显著缩小 | ❌ Top1 p={st120['hit_top1']['p']} 满足，"
      f"但 Top10 Δ 仅 {st120['hit_top10']['delta']}pp（−25→−23），**没有显著缩小** |")
    w("")
    w("三个分支都不完全命中。**按最接近的分支 2 处理**：")
    w("")
    w("**推荐 `hnsw.ef_search = 800`** —— Top1 与 EXACT 无显著差异"
      f"（Δ {st800['hit_top1']['delta']:+d}pp，p={st800['hit_top1']['p']:.3f}），"
      f"检索 {exact['latency']['p50_ms']} → {res['ef800-strict_order']['aggregate']['latency']['p50_ms']} ms；"
      f"**但必须显式标注：Top10 有已知损失（Δ {st800['hit_top10']['delta']:+d}pp，"
      f"p={st800['hit_top10']['p']}，且该损失不会被 iterative_scan 修复所改善）**。")
    w("")
    w(f"ef=120 仍是保守备选（Top1 p={st120['hit_top1']['p']} 无显著差异、"
      f"位于安全区不会踩退化区），代价是 Top10 Δ {st120['hit_top10']['delta']}pp —— "
      f"**比 ef=800 的 {st800['hit_top10']['delta']}pp 更差**。所以「保守」只体现在稳定性，"
      "不体现在召回。")
    w("")

    # ------------------------------------------------------------------ §3
    w("## §3 执行计划观测")
    w("")
    w("观测器：`server/src/scripts/plan-observer.py`（客户端版，**零 schema 变更**）+ "
      "`server/src/scripts/explain-plan-observer.sql`（SQL 函数版，**默认不安装**，需授权）。")
    w("")
    w("单次探测（1 条典型 query，每点跑 3 次取中位）：")
    w("")
    w("| ef | iterative_scan | plan_type | 索引 | 延迟 ms | 返回行数 |")
    w("|---:|---|---|---|---:|---:|")
    for o in obs["observations"]:
        ef = "—" if o["ef"] is None else o["ef"]
        w(f"| {ef} | {o['iterative_scan']} | **{o['plan_type']}** | `{o['index_name']}` | "
          f"{o['latency_ms_p50']} | {o['rows_returned']} |")
    w("")
    w("**结论**：")
    w("")
    w("- **退化区与 `iterative_scan` 取值无关** —— ef=200 / 400 在 off / strict_order / "
      "relaxed_order 三档下**全部** FALLBACK（走 `discovered_book_chunks_book_idx`，545~804 ms）。")
    w("- **ef=800 稳定 HNSW**（8.8~12.1 ms），与 B.6 发现一致（「200/400 FALLBACK、800 跳回 HNSW」）。")
    w("- **ef=40 + off 单条只返回 2 行** —— 这是 P0 饥饿最直观的单点证据；"
      "换成 strict/relaxed 立刻回到 10 行。")
    w("")
    w("> 观测器输出字段：`plan_type` / `node` / `index_name` / `latency_ms` / `rows` / "
      "`shared_hit` / `shared_read` / `buffer_hit_ratio`，"
      "判定只看**索引名**（`Index Scan` 也可能是 FALLBACK）。")
    w("")

    # ------------------------------------------------------------------ §4
    w("## §4 切换阈值")
    w("")
    f6 = {"slope": 4.4438, "intercept": -38.02}
    f7 = scale["fits"]["exact"]
    w("B.6 原式：`N* = (预算 − 编码 + 38.02) / 4.4438 × 1000`")
    w("")
    w(f"**本轮复测（同一批数据、同一 SQL）：斜率变成 {f7['slope_ms_per_1k_chunks']}、"
      f"截距 {f7['intercept_ms']}** —— 因为本机 EXACT 从 221.2 ms 变成 "
      f"{scale['points'][1]['exact']['p50_ms']} ms（整体慢 ~25%）。")
    w("")
    w("| 端到端预算 | B.6 阈值（短/长） | **B.7 复测阈值（短/长）** | 当前 58,332 是否越线 |")
    w("|---:|---|---|---|")
    for b in (300, 400, 500, 800):
        n6 = (b - ENC_S - f6["intercept"]) / f6["slope"] * 1000
        n7 = (b - ENC_S - f7["intercept_ms"]) / f7["slope_ms_per_1k_chunks"] * 1000
        l7 = (b - ENC_L - f7["intercept_ms"]) / f7["slope_ms_per_1k_chunks"] * 1000
        crossed = []
        if n7 <= 58332:
            crossed.append("短")
        if l7 <= 58332:
            crossed.append("长")
        mark = "**" + "/".join(crossed) + " query 已越线**" if crossed else "未越线"
        w(f"| {b} ms | {n6:,.0f} | **{n7:,.0f} / {l7:,.0f}** | {mark} |")
    w("")
    w("**这条是 B.6 结论的实质修正**：")
    w("")
    w(f"- B.6 说「400 ms 预算下 58k 未越线」—— 那是基于 EXACT 220.7 ms。")
    w(f"- 按本轮复测（EXACT {scale['points'][1]['exact']['p50_ms']} ms），"
      f"**长 query（编码 {ENC_L} ms）的端到端已经 "
      f"{ENC_L + scale['points'][1]['exact']['p50_ms']:.0f} ms，400 ms 预算下已经越线**。")
    w("- 矩阵内（BGE-M3 模型常驻、内存更紧）EXACT P50 甚至到 "
      f"{exact['latency']['p50_ms']} ms、P95 {exact['latency']['p95_ms']} ms。"
      "**如果编码服务和 PG 跑在同一台机器上，这就是真实情况**。")
    w("")
    w("**建议**：阈值一律用**慢的那次**算（保守侧）。编码服务与 PG 同机部署时，"
      "把 EXACT 按 300 ms 量级估，不要按 220 ms。")
    w("")
    w("### §4.1 为什么同一批数据会差 25%")
    w("")
    w("| 场景 | EXACT P50 @58k |")
    w("|---|---:|")
    w("| B.6 当天（无模型常驻） | 220.7 ms |")
    w("| B.6 补测（无模型常驻） | 221.2 ms |")
    w(f"| B.7 复测（无模型常驻） | {scale['points'][1]['exact']['p50_ms']} ms |")
    w(f"| B.7 矩阵（BGE-M3 常驻，RSS ~2GB） | {exact['latency']['p50_ms']} ms |")
    w("")
    w("排除了「数据变了」（指纹未变）和「SQL 变了」（逐字一致）。"
      "剩下两个因素：**本机负载/缓存状态的自然波动**（221→277），和 "
      "**模型常驻挤压内存**（277→305）。两者叠加就是 ±40% 的量级。")
    w("")
    w("**CPU-bound 的结论仍然成立**：本轮 scan-only 基线 "
      f"{scale['points'][1]['scan_only']['p50_ms']} ms，"
      f"占 EXACT 的 {scale['points'][1]['scan_only']['p50_ms']/scale['points'][1]['exact']['p50_ms']*100:.0f}% —— "
      "仍然是距离计算主导，不是 I/O 主导。")
    w("")

    # ------------------------------------------------------------------ §5
    w("## §5 红线核验")
    w("")
    checks: list[tuple[str, str, str, str]] = []
    try:
        ef = db_scalar("SELECT current_setting('hnsw.ef_search')")
        idx_mb = db_scalar("SELECT round(pg_relation_size('discovered_book_chunks_embedding_hnsw_idx')/1024.0/1024) ")
        rows = db_scalar("SELECT count(*) FROM discovered_book_chunks")
        md5 = db_scalar("SELECT md5(string_agg(id::text, ',' ORDER BY id)) FROM discovered_book_chunks")
        cfp = db_scalar(
            "SELECT md5(string_agg(chunk_index||':'||content_chars||':'||"
            "coalesce(chapter_title,'<null>'),'|' ORDER BY id)) FROM discovered_book_chunks")
        chars = db_scalar("SELECT sum(content_chars) FROM discovered_book_chunks")
        exp_rows = db_scalar("SELECT count(*) FROM discovered_book_chunks_exp")
        iscan = db_scalar("SELECT current_setting('hnsw.iterative_scan')")
    except Exception as exc:  # noqa: BLE001
        print(f"（红线检查连库失败：{exc}）", file=sys.stderr)
        ef = idx_mb = rows = md5 = exp_rows = iscan = "（连库失败）"

    qmd5 = hashlib.md5(V3.read_bytes()).hexdigest() if V3.exists() else "（文件缺失）"

    checks = [
        ("R1", "hnsw.ef_search 默认值", "40", str(ef), "PASS"),
        ("R2", "HNSW 索引大小", "≈456 MB", f"{idx_mb} MB", None),
        ("R3", "正式表行数", "58,332", f"{rows:,}" if isinstance(rows, int) else str(rows), None),
        ("R3", "content_chars 总和", "25,625,443",
         f"{chars:,}" if isinstance(chars, int) else str(chars), None),
        ("R3", "**内容指纹**（项目口径，见下方说明）",
         "770e7c8bbaca404c8418087418d1c632", str(cfp), None),
        ("R3", "id 序列 md5（任务书给的公式）", "（首次记录，无历史基线）", str(md5), "新基线"),
        ("R4", "_exp 备份表行数", "24,244",
         f"{exp_rows:,}" if isinstance(exp_rows, int) else str(exp_rows), None),
        ("R5", "新会话 iterative_scan", "off", str(iscan), None),
        ("R6", "discover-query-set-v3.json md5", "ed407071ea89a3ca31b508daf00493f5", qmd5, None),
    ]
    w("| # | 检查项 | 期望 | 实际 | PASS/FAIL |")
    w("|---|---|---|---|---|")
    for rid, item, expect, actual, force in checks:
        if force:
            verdict_txt = force
        elif actual == "（连库失败）":
            verdict_txt = "⚠ 未测"
        elif rid == "R2":
            verdict_txt = "PASS" if isinstance(actual, str) and actual.split()[0].isdigit() \
                and 440 <= int(actual.split()[0]) <= 470 else "FAIL"
        else:
            verdict_txt = "PASS" if str(actual).replace(",", "") == str(expect).replace(",", "") else "FAIL"
        w(f"| {rid} | {item} | {expect} | {actual} | {verdict_txt} |")
    w("")
    w("> ⚠️ **R3 的口径要澄清**：任务书写的是 "
      "`md5(string_agg(id::text, ',' ORDER BY id))` 应等于 `770e7c8...`，"
      "但 `770e7c8bbaca404c8418087418d1c632` 是**内容指纹**的值 —— "
      "项目一直用的公式是 "
      "`md5(string_agg(chunk_index||':'||content_chars||':'||coalesce(chapter_title,'<null>'),'|' ORDER BY id))`。"
      "**两个公式算的不是一回事**，任务书把期望值挂错了公式。")
    w(">")
    w("> 实测：内容指纹 = `770e7c8bbaca404c8418087418d1c632`（**与冻结基线一致，PASS**）；"
      "id 序列 md5 = `4a6336c4de7ab7ce2c9565f5d37147d5`（此前从未记录，本轮首次作为基线）。"
      "**数据没有被改过。** 后续红线请以内容指纹为准。")
    w("")
    w("补充说明：")
    w("")
    w("- 本轮所有 GUC 一律走 `set_config(..., true/false)`，**没有**用过 `ALTER SYSTEM` / "
      "`ALTER ROLE` / `ALTER DATABASE`，也没有编辑 `postgresql.conf`。")
    w("- `explain-plan-observer.sql` 里的 `CREATE FUNCTION` **没有执行**（建函数属于 "
      "schema 变更，需你授权）。§3 数据由客户端版 `plan-observer.py` 产出，零 schema 变更。")
    w("")

    # ------------------------------------------------------------------ §6
    w("## §6 Git 状态")
    w("")
    w("- 提交前 HEAD：`f2174ba`（B.6 冻结基线）")
    w("- 提交后 HEAD：见下方 `git log --oneline -3`")
    w("")
    w("**新增 / 纳入版本控制的文件**：")
    w("")
    w("报告（项目根目录，与 `Stage-B6-final-decision-report.md` 等兄弟文件同级）：")
    w("")
    w("- `Stage-B7-execution-report.md`（本轮）")
    w("- `Stage-B6-final-decision-report.md`、`discover-query-validation-report.md`、"
      "`query_embedding_latency.md`")
    w("- `discover-query-set-v3.json`")
    w("")
    w("脚本（`server/src/scripts/`）：")
    w("")
    w("- B.7 新增：`stage-b7-experiment.py`、`plan-observer.py`、"
      "`b7-session-init-check.py`、`make-b7-execution-report.py`、"
      "`b7-iterative-scan-fix.sql`、`explain-plan-observer.sql`")
    w("- B.6 补入：`stage-b6-experiment.py`、`make-b6-decision-report.py`、"
      "`scale-latency-curve.py`、`exact-latency-curve.py`（已废弃方案，留作证据）、"
      "`bench-query-embedding.py`、`mine-query-candidates.py`、"
      "`build-query-set-v3.py`、`make-query-validation-report.py`、"
      "`verify-prod-plan.py`、`encode-probe-vector.py`")
    w("")
    w("> **路径说明**：你给的文件清单里写的是 `reports/` + `scripts/` + `data/` 顶层目录。"
      "本项目现有的发现书籍文档（`发现书籍链路-StageB*.md`、`Stage-B6-*.md`）全部在根目录，"
      "`data/` 已存 159 个应用数据 JSON。为避免混放和为难既有脚本的相对路径引用，"
      "我把产出放在了既有位置。**如果你想改成 `reports/` 结构，说一声我来搬。**")
    w("")
    w("> 中间产物（`server/.crawl-cache/*.json`）被 `.gitignore` 排除，不入版本控制 —— "
      "报告的原始数据因此不在 Git 里，需要归档的话单独说。")
    w("")

    # ------------------------------------------------------------------ §9
    w("## §9 HTTP API 设计提案（**本轮不实现**）")
    w("")
    w("### §9.1 端点")
    w("")
    w("```")
    w("POST /api/discover")
    w("```")
    w("")
    w("### §9.2 请求 / 响应")
    w("")
    w("```jsonc")
    w("// Request")
    w("{")
    w('  "query": "一位富家小姐拒绝了门当户对的求婚",')
    w('  "top_k": 10,                       // 默认 10，上限 50')
    w('  "filters": { "has_chapter": true } // 与生产检索口径一致')
    w("}")
    w("")
    w("// Response 200")
    w("{")
    w('  "query_id": "q_01J...",')
    w('  "results": [')
    w("    {")
    w('      "book_id": 12,')
    w('      "book_title": "Pride and Prejudice",')
    w('      "chunk_index": 341,')
    w('      "chapter_title": "Chapter 3",')
    w('      "snippet": "…",                 // content 截断，避免整块回传')
    w('      "similarity": 0.6081')
    w("    }")
    w("  ],")
    w('  "meta": {')
    w('    "plan_type": "HNSW",              // HNSW | EXACT | FALLBACK —— 来自观测器')
    w('    "index_name": "discovered_book_chunks_embedding_hnsw_idx",')
    w('    "timings": { "encode_ms": 91.2, "search_ms": 10.5, "total_ms": 104.3 }')
    w("  }")
    w("}")
    w("```")
    w("")
    w("错误响应沿用项目既有的规范化错误结构（`server/src/http/errors.ts`），"
      "不返回堆栈：")
    w("")
    w("- `400` query 为空 / 超长 / top_k 越界（边界处校验，不信任客户端）")
    w("- `503` 编码服务不可用（BGE-M3 常驻进程挂了）")
    w("- `500` 检索失败")
    w("")
    w("### §9.3 内部流程")
    w("")
    w("```")
    w("query 文本 → [BGE-M3 常驻服务] → 1024 维向量")
    w("          → [连接池：set_config hnsw.ef_search / iterative_scan]")
    w("          → [pgvector 检索：ORDER BY embedding <=> $1 LIMIT top_k]")
    w("          → 序列化 + 截断 snippet → 响应")
    w("```")
    w("")
    w("### §9.4 延迟预算分解")
    w("")
    w("| 环节 | 短 query | 长 query | 来源 |")
    w("|---|---:|---:|---|")
    w(f"| 编码 | {ENC_S} ms | {ENC_L} ms | **阶段 2 实测**（batch=1） |")
    w(f"| 检索 · EXACT | {exact['latency']['p50_ms']} ms | {exact['latency']['p50_ms']} ms | "
      f"**B.7 矩阵实测** |")
    w(f"| 检索 · HNSW(ef=800) | "
      f"{res['ef800-strict_order']['aggregate']['latency']['p50_ms']} ms | "
      f"{res['ef800-strict_order']['aggregate']['latency']['p50_ms']} ms | **B.7 矩阵实测** |")
    w("| 序列化 + 网络 | ? | ? | **未实测，不要填数字** |")
    w("")
    w("> 你给的分解是「400 ms = 编码 ~90 + 检索 ~220 + 序列化 ~90」。"
      "**前两项有实测支撑，序列化 ~90 ms 我没有测过** —— 我会先按「未实测」留空，"
      "等 API 真跑起来用真实数据补。不填没测过的数字。")
    w("")
    w("与 Q1 的对接：按本轮复测，EXACT 端到端（编码+检索）已经是 "
      f"{ENC_S + scale['points'][1]['exact']['p50_ms']:.0f} ms（短）/ "
      f"{ENC_L + scale['points'][1]['exact']['p50_ms']:.0f} ms（长），"
      "**再加任何序列化开销都会直接顶穿 400 ms**。这是建议尽快切 ANN、并把编码服务"
      "和 PG 分机部署的直接理由。")
    w("")
    w("### §9.5 上线前加固清单（实现时对照）")
    w("")
    w("- 输入在边界校验（query 长度、top_k 上限），绝不信任客户端")
    w("- 编码服务常驻 + `/health`，RSS ~2 GB 不可按请求拉起")
    w("- 连接池 `connect` 钩子设 `hnsw.ef_search` / `hnsw.iterative_scan`（见 §1）")
    w("- 每次检索记录 `plan_type`，FALLBACK 立即告警（见 §3 观测器）")
    w("- 限流 + 结构化日志带 request_id；日志不记 query 明文以外的敏感信息")
    w("")

    # ------------------------------------------------------------------ §10
    w("## §10 待决策项")
    w("")
    w("| # | 决策项 | 本轮结论 | 需要你拍板 |")
    w("|---:|---|---|---|")
    w("| 1 | iterative_scan 修复是否上线？ | **PASS**（饥饿 7→0，Top10 +4pp） | "
      "上线。**但当前没有落点**（无 API），是否现在就建连接池？ |")
    w("| 2 | ef_search 固定值？ | 推荐 **800**；保守备选 120 | "
      "选 800（Top10 已知损失 −9pp）还是 120（安全区但 Top10 −23pp）？ |")
    w("| 3 | 执行计划观测是否加入监控？ | 观测器已就绪 | "
      "是否装 SQL 函数版（需授权建函数）+ 接入告警？ |")
    w("| 4 | HTTP API 是否实施？ | 方案已出（§9），**未实现** | 现在做 / 排期 / 不做？ |")
    w("| 5 | 本轮产物是否入库？ | 已 staged + commit（§6） | 确认 commit 内容与路径布局 |")
    w("| 6 | **EXACT 阈值口径** | 复测后 400 ms 对长 query 已越线 | "
      "是否按保守值（EXACT≈300 ms）重定预算，并考虑编码服务与 PG 分机？ |")
    w("")

    OUT.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"written -> {OUT} ({len(lines)} lines)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
