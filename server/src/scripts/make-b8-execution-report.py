# -*- coding: utf-8 -*-
"""
B.8 · 渲染 Stage-B8-execution-report.md（纯渲染，只读所有中间产物）

用法：C:/Python314/python.exe -u src/scripts/make-b8-execution-report.py
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import subprocess
import sys
from pathlib import Path

SERVER_ROOT = Path(__file__).resolve().parents[2]
ROOT = SERVER_ROOT.parent
CACHE = SERVER_ROOT / ".crawl-cache"

E2E = CACHE / "_b8-e2e.json"
INTER = CACHE / "_b8-e2e-interleaved.json"
REG = CACHE / "_b8-regression.json"
SCALE = CACHE / "_scale-latency-curve.json"
LAT = CACHE / "_query-embedding-latency.json"
V3 = ROOT / "discover-query-set-v3.json"
OUT = ROOT / "Stage-B8-execution-report.md"


def jload(p: Path):
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


def db_scalar(sql: str):
    import psycopg2
    for line in (SERVER_ROOT / ".env").read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if s and not s.startswith("#") and "=" in s:
            k, _, v = s.partition("=")
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    c = psycopg2.connect(os.environ["DATABASE_URL"])
    c.autocommit = True
    cur = c.cursor()
    cur.execute("SELECT NULL::vector")   # pgvector GUC 要等扩展在本会话加载
    cur.execute(sql)
    row = cur.fetchone()
    c.close()
    return row[0] if row and len(row) == 1 else row


def git_out(args: list[str]) -> str:
    r = subprocess.run(["git", *args], cwd=str(ROOT), capture_output=True,
                       text=True, encoding="utf-8", errors="replace")
    return r.stdout if r.returncode == 0 else f"（git {args[0]} 失败）"


def main() -> int:
    e2e, inter, reg, scale = jload(E2E), jload(INTER), jload(REG), jload(SCALE)
    for n, v in (("_b8-e2e.json", e2e), ("_b8-regression.json", reg)):
        if v is None:
            raise SystemExit(f"缺少中间产物：{n}")

    L = e2e["latency"]
    R = e2e["recall"]
    denom = e2e["denominator"]
    cfg = e2e["config"]

    lines: list[str] = []
    w = lines.append

    w("# Stage B.8 — 切换 HNSW + 端到端预算实测")
    w("")
    w(f"生成时间：{e2e['generated_at']}　|　分母 {denom} 条　|　top_k={cfg['top_k']}　|　"
      f"每条检索重复 {cfg['repeats_per_retrieve']} 次取中位")
    w("")
    w("**这是本项目第一个真实预算锚点** —— B.6/B.7 的延迟都是外推，本轮直接测 "
      "`encode_ms` / `retrieve_ms` / `e2e_ms`。")
    w("")
    w("---")
    w("")
    w("## §0 结论速览")
    w("")
    w("| 项 | 结果 |")
    w("|---|---|")
    w(f"| **生产配置** | `ef_search=800` + `iterative_scan=strict_order`（连接级） |")
    w(f"| **检索 P50** | **{L['retrieve_ms']['p50']} ms**（目标 ≤15ms → ✅） |")
    w(f"| **端到端 P50** | **{L['e2e_ms']['p50']} ms**（目标 ≤120ms → ❌ 超 {L['e2e_ms']['p50']-120:.0f}ms） |")
    w(f"| **EXACT 对照** | 检索 {L['exact_retrieve_ms']['p50']} ms / 端到端 {L['exact_e2e_ms']['p50']} ms |")
    w(f"| **加速比** | 检索 {L['exact_retrieve_ms']['p50']/L['retrieve_ms']['p50']:.0f}×、"
      f"端到端 {L['exact_e2e_ms']['p50']/L['e2e_ms']['p50']:.1f}× |")
    w(f"| **召回** | Top1 {R['top1']}/{denom}、Top10 {R['top10']}/{denom}、"
      f"0 行 {R['starved']}、不足 {R['underfilled']} |")
    w(f"| **回归状态** | **{reg['status']}**（{reg['row_count']:,} 行 / "
      f"400ms 长 query 阈值 {reg['n_star_400ms']['long']:,} 行） |")
    w("")
    w(f"> ⚠ **立即上报**：EXACT 检索 P50 实测 **{L['exact_retrieve_ms']['p50']} ms** "
      f"（> 350ms 红线）。落在「EXACT 已不可用，立即切 HNSW + 排查额外负载因素」分支。")
    w("")

    # §1
    w("## §1 生产配置切换")
    w("")
    w("连接初始化 SQL：`server/src/scripts/db-conn-init.sql`")
    w("")
    w("```sql")
    w("SELECT NULL::vector;                        -- 必须先加载 pgvector，否则 GUC 不存在")
    w("SET hnsw.ef_search = 800;")
    w("SET hnsw.iterative_scan = strict_order;")
    w("```")
    w("")
    try:
        ef_bare = db_scalar("SHOW hnsw.ef_search")
        isc_bare = db_scalar("SHOW hnsw.iterative_scan")
    except Exception as exc:  # noqa: BLE001
        ef_bare = isc_bare = f"（查询失败：{exc}）"
    w("| 检查 | 期望 | 实测 | 判定 |")
    w("|---|---|---|---|")
    w(f"| init 会话 `hnsw.ef_search` | 800 | **{cfg['hnsw_arm'].split('ef_search=')[1].split(',')[0]}** | "
      f"{'✅ PASS' if '800' in cfg['hnsw_arm'] else '❌ FAIL'} |")
    w(f"| init 会话 `hnsw.iterative_scan` | strict_order | "
      f"**{cfg['hnsw_arm'].split('iterative_scan=')[1].split('（')[0]}** | "
      f"{'✅ PASS' if 'strict_order' in cfg['hnsw_arm'] else '❌ FAIL'} |")
    w(f"| 裸会话 `hnsw.ef_search`（R1） | 40 | **{ef_bare}** | "
      f"{'✅ PASS' if str(ef_bare) == '40' else '❌ FAIL'} |")
    w(f"| 裸会话 `hnsw.iterative_scan`（R5） | off | **{isc_bare}** | "
      f"{'✅ PASS' if str(isc_bare) == 'off' else '❌ FAIL'} |")
    w("")
    w("### §1.1 一个容易踩的坑（已验证）")
    w("")
    w("`SET hnsw.ef_search` 在 pgvector 未加载时**不会报错** —— PostgreSQL 会把它当成 "
      "namespaced placeholder，`SET` / `SHOW` 都正常返回，但**可能没真正作用到 pgvector**。")
    w("功能性验证（`iterative_scan=off` 时过滤查询只返回 2 行，`strict_order` 生效应返回 10 行）：")
    w("")
    w("| 写法 | SHOW 结果 | 实际返回行数 |")
    w("|---|---|---:|")
    w("| 先 `SELECT NULL::vector` 再 SET | 800 / strict_order | **10** |")
    w("| 不预载直接 SET | 800 / strict_order | **10** |")
    w("| 裸会话（不 SET） | — / off | **2**（饥饿基线） |")
    w("")
    w("结论：本库上 placeholder 会被后加载的扩展接管，两种写法都生效；"
      "但 `SELECT NULL::vector` 仍然保留在文件里 —— 它保证 `SHOW` / `current_setting()` "
      "在任何时候都能读到值，不依赖 placeholder 交接语义。")
    w("")
    w("复核补证（2026-10-17 当日，独立复跑）：用饥饿 query `Q024`"
      "（裸配置下仅返回 2 行）重测三种写法 —— 预栽+SET = 10 行、不预载直接 SET = 10 行、"
      "裸会话 = 2 行，与本表一致。")
    w("")

    # §2
    w("## §2 端到端延迟分解（100 条，隔离分段）")
    w("")
    w("| 统计量 | encode_ms | retrieve_ms (ef=800) | **e2e_ms** | EXACT retrieve_ms | EXACT e2e_ms |")
    w("|---|---:|---:|---:|---:|---:|")
    for k in ("p50", "p95", "p99", "mean", "max"):
        keys = ("encode_ms", "retrieve_ms", "e2e_ms", "exact_retrieve_ms", "exact_e2e_ms")
        row = [L[c][k] for c in keys]
        bold = "**" if k == "p50" else ""
        w(f"| {k.upper()} | {bold}{row[0]}{bold} | {bold}{row[1]}{bold} | "
          f"{bold}{row[2]}{bold} | {row[3]} | {row[4]} |")
    w("")
    w(f"**端到端 P50 = {L['e2e_ms']['p50']} ms**（编码 {L['encode_ms']['p50']} + "
      f"检索 {L['retrieve_ms']['p50']}），对比 EXACT 的 {L['exact_e2e_ms']['p50']} ms —— "
      f"**快 {L['exact_e2e_ms']['p50']/L['e2e_ms']['p50']:.1f}×**。")
    w("")
    w("### §2.1 方法论：第一版数据作废，原因记录在此")
    w("")
    w("第一版是「每条 query 交错跑 encode + 3 次 EXACT 扫描」。EXACT 每次要扫 808 MB，"
      "会把 BGE-M3 的模型页挤出页缓存 —— **encode 从 ~91ms 劣化到 278ms，连 HNSW 检索也被拖慢**。"
      "两组数字互相污染，不能当预算锚点。本版改成隔离分段：段0 编码（不碰库）→ 段1 HNSW → 段2 EXACT。")
    w("")
    if inter:
        IL = inter["latency"]
        w("| 指标 | 交错测量（作废） | **隔离分段（采用）** | 污染幅度 |")
        w("|---|---:|---:|---:|")
        pairs = [("encode_ms", "encode_ms"), ("retrieve_ms", "retrieve_ms"),
                 ("exact_retrieve_ms", "exact_retrieve_ms")]
        for a, b in pairs:
            x, y = IL[a]["p50"], L[b]["p50"]
            w(f"| {b} P50 | {x} ms | **{y} ms** | {x/y:.2f}× |")
        w("")
        w("（交错数据保留在 `.crawl-cache/_b8-e2e-interleaved.json`，作为污染幅度的证据。）")
        w("")
        w("> 副产品发现：这条污染不是纯测量误差 —— **如果生产上继续用 EXACT，"
          "808MB 的全表扫描确实会挤压同机部署的编码服务**。这是切 HNSW 的又一个理由。")
    w("")
    w("### §2.2 编码延迟为什么比阶段 2 高")
    w("")
    w("| query 长度 | 条数 | encode P50 | e2e P50 |")
    w("|---|---:|---:|---:|")
    pq = e2e["per_query"]
    for lo, hi, label in ((0, 20, "0–20 字"), (20, 40, "20–40 字"),
                          (40, 60, "40–60 字"), (60, 999, "60+ 字")):
        g = [r["encode_ms"] for r in pq if lo <= r["query_chars"] < hi]
        g2 = [r["e2e_ms"] for r in pq if lo <= r["query_chars"] < hi]
        if g:
            med = sorted(g)[len(g)//2]
            med2 = sorted(g2)[len(g2)//2]
            w(f"| {label} | {len(g)} | {med:.1f} ms | {med2:.1f} ms |")
    w("")
    w(f"阶段 2 的 91.15 ms 是 **13 字短句**测出来的；本轮 query 集中位长度 "
      f"{sorted(r['query_chars'] for r in pq)[len(pq)//2]} 字，编码自然更慢。"
      "另外运行时段内存压力大（可用约 2.5 GB / 15.2 GB，观察值未随 JSON 产物留档），"
      "整体上比阶段 2 测量时慢。")
    w("")

    # §3
    w("## §3 Recall 确认")
    w("")
    w("| 臂 | Top1 | Top10 | 0 行 | 不足 |")
    w("|---|---:|---:|---:|---:|")
    w(f"| **ef=800 + strict_order（生产配置）** | **{R['top1']}/{denom}** | "
      f"{R['top10']}/{denom} | **{R['starved']}** | {R['underfilled']} |")
    w(f"| EXACT（天花板） | {R['exact_top1']}/{denom} | {R['exact_top10']}/{denom} | — | — |")
    w("")
    rel = R["top1"] / R["exact_top1"] * 100 if R["exact_top1"] else 0
    w(f"相对天花板：Top1 {rel:.1f}%（{R['top1']}/{R['exact_top1']}）、"
      f"Top10 {R['top10']/R['exact_top10']*100:.1f}%（{R['top10']}/{R['exact_top10']}）。")
    w("")
    w("> ⚠ **验收口径要澄清**：任务书写「Top1 recall ≥ 95/100（B.7 为 96/100）」，"
      f"但**绝对召回的天花板就是 {R['exact_top1']}/100**（EXACT 也只有这么多）—— "
      "95/100 在物理上不可达。B.7 的「96」应为**相对天花板的比例**（49/51 = 96.1%），"
      f"本轮实测 {rel:.1f}%，符合。")
    w("")
    w("### §3.1 验收")
    w("")
    ok1 = L["retrieve_ms"]["p50"] <= 15
    ok2 = L["e2e_ms"]["p50"] <= 120
    ok3 = R["starved"] == 0
    ok4 = rel >= 95
    w("| 验收项 | 期望 | 实测 | 判定 |")
    w("|---|---|---:|---|")
    w(f"| retrieve_ms P50 | ≤ 15 ms | {L['retrieve_ms']['p50']} | {'✅ PASS' if ok1 else '❌ FAIL'} |")
    w(f"| e2e_ms P50 | ≤ 120 ms | {L['e2e_ms']['p50']} | {'✅ PASS' if ok2 else '❌ FAIL'} |")
    w(f"| 返回 0 行的 query | 0 | {R['starved']} | {'✅ PASS' if ok3 else '❌ FAIL'} |")
    w(f"| Top1 相对天花板 | ≥ 95% | {rel:.1f}% | {'✅ PASS' if ok4 else '❌ FAIL'} |")
    w("")
    w(f"**e2e 超标的 {L['e2e_ms']['p50']-120:.0f} ms 全部来自编码**（实测 "
      f"{L['encode_ms']['p50']} ms，预算假设 ~100 ms）；检索只用了 "
      f"{L['retrieve_ms']['p50']} ms，比 15 ms 的额度还省 "
      f"{15-L['retrieve_ms']['p50']:.1f} ms。")
    w("")

    # §4
    w("## §4 预算修正")
    w("")
    w("| 指标 | B.6 测量 | B.7 复测 | **B.8 实测** | 采用 |")
    w("|---|---:|---:|---:|---|")
    # B.7 报告里发布的拟合值（写死，不从 _scale-latency-curve.json 读 ——
    # 那个文件在 B.8 期间被重跑覆盖过，读出来会是 B.8 口径，标成 B.7 就错了）
    B7_SLOPE, B7_INTERCEPT = 5.5756, -48.31
    s7 = {"slope_ms_per_1k_chunks": B7_SLOPE, "intercept_ms": B7_INTERCEPT}
    w(f"| EXACT 检索 P50 (ms) | 220.7 | 276.9 | **{L['exact_retrieve_ms']['p50']}** | "
      f"见下方说明（波动大） |")
    w(f"| 斜率 (ms/1k rows) | 4.4438 | {s7.get('slope_ms_per_1k_chunks', '—')} | "
      f"**{reg['slope_ms_per_1k_rows']}** | {reg['slope_ms_per_1k_rows']}（回归脚本两点拟合） |")
    w(f"| 截距 (ms) | −38.02 | {s7.get('intercept_ms', '—')} | **{reg['intercept_ms']}** | "
      f"{reg['intercept_ms']} |")
    w(f"| ef=800 检索 P50 (ms) | 6.3 | 8.4 / 11.3 | **{L['retrieve_ms']['p50']}** | "
      f"{L['retrieve_ms']['p50']} |")
    w(f"| 编码 P50 (ms) | 91.15（13字） | 91.15（13字） | **{L['encode_ms']['p50']}**"
      f"（中位 {sorted(r['query_chars'] for r in pq)[len(pq)//2]} 字） | "
      f"{L['encode_ms']['p50']} |")
    w(f"| 端到端 P50 (ms) | — | — | **{L['e2e_ms']['p50']}** | {L['e2e_ms']['p50']} |")
    w(f"| N* @400ms（长 query） | 78k（短） | 48.5k | **{reg['n_star_400ms']['long']:,}** | "
      f"{reg['n_star_400ms']['long']:,} |")
    w(f"| N* @500ms（长 query） | 100.6k（短） | 66.4k | **{reg['n_star_500ms']['long']:,}** | "
      f"{reg['n_star_500ms']['long']:,} |")
    w("")
    w("### §4.1 分支判定")
    w("")
    w("| 分支 | 条件 | 是否满足 |")
    w("|---|---|---|")
    w(f"| ① | B.8 实测 EXACT P50 ≤ 250ms → 短期可继续 | "
      f"{'✅' if L['exact_retrieve_ms']['p50'] <= 250 else '❌'}（实测 {L['exact_retrieve_ms']['p50']} ms） |")
    w(f"| ② | 250–300ms → 悬崖线上，立即切 | "
      f"{'✅' if 250 < L['exact_retrieve_ms']['p50'] <= 300 else '❌'} |")
    w(f"| ③ | **>300ms → 已不可用，立即切 + 排查负载** | "
      f"{'✅ 命中' if L['exact_retrieve_ms']['p50'] > 300 else '❌'} |")
    w("")
    w(f"**命中分支 ③。结论：EXACT 已不可用，立即切 HNSW，并排查额外负载因素。**")
    w("")
    w("### §4.2 额外负载因素排查")
    w("")
    w("EXACT 检索 P50 在**同一小时内**的几次测量：")
    w("")
    w("| 场景 | EXACT P50 |")
    w("|---|---:|")
    w("| B.6 当天 | 220.7 ms |")
    w("| B.7 复测（无模型） | 276.9 ms |")
    w("| B.8 前（无模型） | 364.3 ms |")
    w("| B.8 回归脚本（20 条抽样，无模型） | 282.2 ms |")
    w(f"| **B.8 段2（100 条，已释放模型）** | **{L['exact_retrieve_ms']['p50']} ms** |")
    w(f"| B.8 交错版（模型常驻） | {inter['latency']['exact_retrieve_ms']['p50'] if inter else '—'} ms |")
    w("")
    w("嫌疑（按可能性排序）：")
    w("")
    w("1. **系统内存压力** —— 运行时段观察值：内存负载约 83%、可用物理内存约 2.5 GB / 15.2 GB"
      "（观察值，未随 JSON 产物留档；同日复核时可用内存仍在 0.5–2.5 GB 区间波动）。"
      "EXACT 每次扫 808 MB，页缓存根本放不下，重复读盘。")
    w("2. **与编码服务争内存带宽** —— 模型常驻时 EXACT 从 ~364ms 涨到 ~633ms（1.7×）。")
    w("3. 数据本身没变（内容指纹未变、行数未变、SQL 逐字一致），**可以排除数据因素**。")
    w("")
    w("**处置建议**：①立即切 HNSW（不依赖大扫描，受内存压力影响小得多）；"
      "②编码服务与 PostgreSQL **分机部署**，或至少保证编码服务有独立内存；"
      "③若要继续用 EXACT 做对照，先把 `shared_buffers` 调到能装下主表（≥1 GB）。")
    w("")

    # §5
    w("## §5 回归验证脚本")
    w("")
    w("脚本：`server/src/scripts/regression-check.py`")
    w("")
    w("```bash")
    w("C:/Python314/python.exe -u src/scripts/regression-check.py --run --sample 20 --budget 400")
    w("```")
    w("")
    w("设计要点：")
    w("")
    w("- **不加载 BGE-M3**（RSS ~2GB，不适合定时跑）→ 复用缓存的 query 向量 "
      "`.crawl-cache/_b8-query-vectors.json`（由 `b8-e2e-experiment.py` 产出）")
    w(f"- **斜率每次重算**，不硬编码：本库有第二张同构真实表 `{reg['small_table']['name']}`"
      f"（{reg['small_table']['rows']:,} 行），直接两点拟合；拿不到才退化为单点斜率 + 固定截距")
    w("- 连接执行 `db-conn-init.sql`（生产配置），全程只读")
    w("")
    w("当前输出：")
    w("")
    w("```json")
    w(json.dumps({k: reg[k] for k in ("timestamp", "row_count", "sample_size",
                                      "exact_p50_ms", "exact_p95_ms",
                                      "hnsw_p50_ms", "hnsw_p95_ms",
                                      "slope_ms_per_1k_rows", "intercept_ms",
                                      "fit_mode", "n_star_400ms", "n_star_500ms",
                                      "headroom_ratio", "status")},
                 ensure_ascii=False, indent=2))
    w("```")
    w("")
    w(f"**当前状态：`{reg['status']}`** —— {reg['row_count']:,} 行，"
      f"已达 400ms 长 query 阈值（{reg['n_star_400ms']['long']:,} 行）的 "
      f"{reg['headroom_ratio']*100:.1f}%。")
    w("")
    w("status 逻辑：`OK` 行数 < N*×0.8｜`WARN` ≥ N*×0.8 且 < N*｜`ALERT` ≥ N*"
      "（N* 取长 query 的保守值）")
    w("")
    w("**建议频率**：每周一次，或每次大批量导入新书籍后立即跑。")
    w("")

    # §6
    w("## §6 红线核验")
    w("")
    idx_mb = db_scalar("SELECT round(pg_relation_size('discovered_book_chunks_embedding_hnsw_idx')/1024.0/1024)")
    rows = db_scalar("SELECT count(*) FROM discovered_book_chunks")
    cfp = db_scalar("SELECT md5(string_agg(chunk_index||':'||content_chars||':'||"
                    "coalesce(chapter_title,'<null>'),'|' ORDER BY id)) FROM discovered_book_chunks")
    idfp = db_scalar("SELECT md5(string_agg(id::text, ',' ORDER BY id)) FROM discovered_book_chunks")
    expr = db_scalar("SELECT count(*) FROM discovered_book_chunks_exp")
    qmd5 = hashlib.md5(V3.read_bytes()).hexdigest() if V3.exists() else "（缺失）"
    checks = [
        ("R1", "裸会话 hnsw.ef_search", "40", str(ef_bare)),
        ("R2", "HNSW 索引大小", "≈456 MB", f"{idx_mb} MB"),
        ("R3", "正式表行数", "58,332", f"{rows:,}"),
        ("R3", "内容指纹", "770e7c8bbaca404c8418087418d1c632", str(cfp)),
        ("R3", "id 序列 md5（B.7 新基线）", "4a6336c4de7ab7ce2c9565f5d37147d5", str(idfp)),
        ("R4", "_exp 备份表行数", "24,244", f"{expr:,}"),
        ("R5", "裸会话 iterative_scan", "off", str(isc_bare)),
        ("R6", "discover-query-set-v3.json md5", "ed407071ea89a3ca31b508daf00493f5", qmd5),
    ]
    w("| # | 检查项 | 期望 | 实际 | PASS/FAIL |")
    w("|---|---|---|---|---|")
    for rid, item, exp_, act in checks:
        if rid == "R2":
            v = "PASS" if str(act).split()[0].isdigit() and 440 <= int(str(act).split()[0]) <= 470 else "FAIL"
        else:
            v = "PASS" if str(act).replace(",", "") == str(exp_).replace(",", "") else "FAIL"
        w(f"| {rid} | {item} | {exp_} | {act} | {v} |")
    w("")
    w("补充说明：")
    w("")
    w("- 本轮所有 GUC 一律在**连接级**设置（`SET` / `set_config`），"
      "没有 `ALTER SYSTEM` / `ALTER ROLE` / `ALTER DATABASE`，没有编辑 `postgresql.conf`。")
    w("- 未 REINDEX、未改正式表、未建任何函数（`explain-plan-observer.sql` 仍未安装）。")
    w("")

    # §7
    w("## §7 Git 状态")
    w("")
    head = git_out(["rev-parse", "--short", "HEAD"]).strip()
    w(f"- 提交前 HEAD：`8d90d8f`（B.7 基线）")
    w(f"- 提交后 HEAD：**`{head}`**")
    w("")
    w("```")
    w(git_out(["log", "--oneline", "-5"]).rstrip())
    w("```")
    w("")
    w("**本轮新增文件**：")
    w("")
    w("- `Stage-B8-execution-report.md`（本报告）")
    w("- `server/src/scripts/db-conn-init.sql` —— 生产连接初始化（ef=800 + strict_order）")
    w("- `server/src/scripts/regression-check.py` —— 可定期跑的回归告警脚本")
    w("- `server/src/scripts/b8-e2e-experiment.py` —— 端到端延迟分解实测")
    w("- `server/src/scripts/make-b8-execution-report.py` —— 本报告生成器")
    w("")

    # §9
    w("## §9 HTTP API 方案（更新版，**本轮仍不实现**）")
    w("")
    w("### §9.1 端点与契约")
    w("")
    w("```")
    w("POST /api/discover")
    w("```")
    w("")
    w("```jsonc")
    w("// Request")
    w("{")
    w('  "query": "一位富家小姐拒绝了门当户对的求婚",')
    w('  "top_k": 10,')
    w('  "book_filter": ["12", "7"],        // optional, null/缺省 = 全部书')
    w('  "chapter_filter": ["Chapter 3"],   // optional')
    w('  "ef_search": 800                   // optional, default 800')
    w("}")
    w("")
    w("// Response 200")
    w("{")
    w('  "results": [')
    w("    {")
    w('      "chunk_id": 12345,')
    w('      "book_id": "12",')
    w('      "chapter_title": "Chapter 3",')
    w('      "content": "…",')
    w('      "score": 0.92')
    w("    }")
    w("  ],")
    w('  "latency": { "encode_ms": ..., "retrieve_ms": ..., "e2e_ms": ... }')
    w("}")
    w("```")
    w("")
    w("错误响应沿用 `server/src/http/errors.ts` 的规范化结构，不返回堆栈："
      "`400`（query 空/超长、top_k 越界）、`503`（编码服务不可用）、`500`（检索失败）。")
    w("")
    w("### §9.2 延迟预算（用 B.8 实测值更新）")
    w("")
    w("| 阶段 | B.7 估算 | **B.8 实测** |")
    w("|---|---|---|")
    w(f"| BGE-M3 编码 | ~90 ms | **{L['encode_ms']['p50']} ms**（P95 {L['encode_ms']['p95']}） |")
    w(f"| pgvector 检索 (ef=800) | ~6 ms | **{L['retrieve_ms']['p50']} ms**"
      f"（P95 {L['retrieve_ms']['p95']}） |")
    w("| JSON 序列化 | 未实测 | **仍标未实测**（没测过就不填数字） |")
    w(f"| **端到端 P50** | ~120 ms | **{L['e2e_ms']['p50']} ms**"
      f"（P95 {L['e2e_ms']['p95']}） |")
    w("")
    w("> B.7 的 ~120 ms 估算**低估了 48 ms**，低估部分全在编码："
      "阶段 2 的 91 ms 是 13 字短句，真实 query 中位 28 字 → 155 ms。"
      "**以后做预算请以本轮的中位长度口径为准。**")
    w("")
    w("### §9.3 内部流程")
    w("")
    w("```")
    w("query → [BGE-M3 常驻服务] → 1024 维向量")
    w("      → [连接池：db-conn-init.sql → ef=800 + strict_order]")
    w("      → [pgvector：ORDER BY embedding <=> $1 LIMIT top_k]")
    w("      → 序列化 → 响应")
    w("```")
    w("")
    w("### §9.4 就绪度")
    w("")
    w("| 组件 | 状态 |")
    w("|---|---|")
    w("| 连接初始化 SQL | ✅ 已就绪 `db-conn-init.sql`（已验证 800/strict_order） |")
    w("| 检索 SQL | ✅ 已验证（100 条 × 召回 / 延迟 / 执行计划全部实测） |")
    w("| 编码服务 | ⚠️ 目前是脚本内调用，需要抽成常驻服务 |")
    w("| HTTP handler | ❌ 未实现（纯工程任务：Express handler + 上述已验证 SQL） |")
    w("| 回归告警 | ✅ 已就绪 `regression-check.py` |")
    w("")

    # §10
    w("## §10 最终决策")
    w("")
    w("| 项 | 结论 |")
    w("|---|---|")
    w("| **切换决策** | **HNSW `ef_search=800` + `iterative_scan=strict_order`** —— **CONFIRMED** |")
    w("| **紧急程度** | **立即**。EXACT 检索 P50 "
      f"{L['exact_retrieve_ms']['p50']} ms 已越过 350ms 红线，"
      f"回归脚本状态 `{reg['status']}`（占用率 {reg['headroom_ratio']*100:.0f}%） |")
    w("| **已知代价** | Top10 Δ −9pp（p=0.0117），且不被 iterative_scan 修复改善；"
      f"Top1 相对天花板 {rel:.1f}%，无显著差异 |")
    w("| **端到端预期** | P50 "
      f"{L['e2e_ms']['p50']} ms / P95 {L['e2e_ms']['p95']} ms（不含序列化，未实测） |")
    w("| **下一步** | ①API 实现排期 ②编码服务与 PG 分机部署 ③每周跑回归脚本 |")
    w("")
    w("### §10.1 待你拍板")
    w("")
    w("1. **API 实现**：现在开始 / 排期？（连接初始化与检索 SQL 都已验证，是纯工程任务）")
    w("2. **e2e 120ms 目标**：实测 168ms。是调整目标（承认编码 155ms），"
      "还是优化编码（换更小模型 / 量化 / GPU）？")
    w("3. **部署形态**：编码服务与 PG 是否分机？本机 83% 内存负载下 EXACT 会额外慢 1.7×。")
    w("4. **ef=800 的退化风险**：紧邻退化区（ef=400 = FALLBACK），"
      "是否现在就把执行计划观测接进监控？")
    w("")

    OUT.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"written -> {OUT} ({len(lines)} lines)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
