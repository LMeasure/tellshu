# -*- coding: utf-8 -*-
"""
阶段 5 补测 · EXACT 延迟 vs chunks 规模 曲线（只读）

背景：Q3 要求「chunks 数量阈值」必须依据 EXACT latency 曲线，而 stage-b5 / stage-b6
跑的是同一份 58,332 chunks，EXACT 只有一个规模点，一个点无法外推。

办法：用 TABLESAMPLE SYSTEM (%) 让 Seq Scan 只扫描随机页 —— 等价于「表只有这么大」。
  - 纯 SELECT，不改表、不建表、不写任何数据
  - 只取延迟，不取召回（抽样后本来就缺行，召回无意义）
  - 与 B.6 的 EXACT 同样的禁索引手法：事务内 set_config(..., true)

输出：.crawl-cache/_exact-latency-curve.json
用法：C:/Python314/python.exe -u src/scripts/exact-latency-curve.py --run
"""
from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

SERVER_ROOT = Path(__file__).resolve().parents[2]
CACHE = SERVER_ROOT / ".crawl-cache"
OUT_JSON = CACHE / "_exact-latency-curve.json"
PROBE = CACHE / "_b6-probe-vector.json"

# SYSTEM 抽样比例（百分点）。5% ≈ 2.9k chunks，100% = 全量 58,332
SAMPLE_PCTS = [3, 5, 10, 20, 35, 50, 75, 100]
WARMUP = 3
REPEATS = 21


def load_env(root: Path) -> str:
    """与 stage-b6-experiment.py 完全一致：只读 server/.env 的 DATABASE_URL。"""
    for line in (root / ".env").read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if s and not s.startswith("#") and "=" in s:
            k, _, v = s.partition("=")
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError("缺少 DATABASE_URL（检查 server/.env）")
    return url


def percentile(sorted_vals: list[float], q: float) -> float:
    """线性插值分位数。"""
    if not sorted_vals:
        return 0.0
    if len(sorted_vals) == 1:
        return sorted_vals[0]
    pos = (len(sorted_vals) - 1) * q
    lo = int(pos)
    hi = min(lo + 1, len(sorted_vals) - 1)
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (pos - lo)


def sql_body(pct: int) -> str:
    """逐字对齐生产检索的形状（ORDER BY 距离 + LIMIT），只多一个 TABLESAMPLE。"""
    if pct >= 100:
        src = "discovered_book_chunks c"
    else:
        # pct 由本脚本内部常量生成，非外部输入，不做参数化（TABLESAMPLE 也不接受占位符）
        src = f"discovered_book_chunks c TABLESAMPLE SYSTEM ({pct})"
    return (
        "SELECT c.id, c.book_id, c.chunk_index, c.chapter_title, c.content, "
        "1 - (c.embedding <=> %s::vector) AS score "
        f"FROM {src} "
        "WHERE c.embedding IS NOT NULL "
        "AND (%s::text IS NULL OR c.embedding_model = %s) "
        "ORDER BY c.embedding <=> %s::vector "
        "LIMIT 10"
    )


def run(conn, vec_literal: str, model: str | None) -> dict:
    out_points: list[dict] = []
    cur = conn.cursor()

    total = None
    cur.execute("SELECT count(*) FROM discovered_book_chunks WHERE embedding IS NOT NULL")
    total = cur.fetchone()[0]

    for pct in SAMPLE_PCTS:
        sql = sql_body(pct)

        # 1) 用 EXPLAIN 取真实扫描行数（抽样后实际参与距离计算的行）
        plan_sql = "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + sql
        cur.execute("BEGIN")
        cur.execute("SELECT set_config('enable_indexscan','off',true)")
        cur.execute("SELECT set_config('enable_bitmapscan','off',true)")
        cur.execute("SELECT set_config('enable_seqscan','on',true)")
        cur.execute(plan_sql, (vec_literal, model, model, vec_literal))
        plan = cur.fetchone()[0]
        conn.commit()
        rows_scanned = None
        exec_ms = None

        def walk(node):
            nonlocal rows_scanned, exec_ms
            if rows_scanned is None and node.get("Node Type", "").startswith("Seq Scan"):
                rows_scanned = node.get("Actual Rows")
            if exec_ms is None and "Actual Total Time" in node:
                exec_ms = node.get("Actual Total Time")
            for ch in node.get("Plans", []) or []:
                walk(ch)

        for entry in plan:
            walk(entry.get("Plan", entry))

        # 2) 正式计时：warmup 丢弃，第 1 次为冷样本不计入 P50
        samples: list[float] = []
        for i in range(WARMUP + REPEATS):
            t0 = time.perf_counter()
            cur.execute("BEGIN")
            cur.execute("SELECT set_config('enable_indexscan','off',true)")
            cur.execute("SELECT set_config('enable_bitmapscan','off',true)")
            cur.execute("SELECT set_config('enable_seqscan','on',true)")
            cur.execute(sql, (vec_literal, model, model, vec_literal))
            cur.fetchall()
            conn.commit()
            dt = (time.perf_counter() - t0) * 1000
            if i >= WARMUP:
                samples.append(dt)
        samples.sort()

        warm_first = samples[0]
        tail = samples[1:] if len(samples) > 1 else samples
        point = {
            "sample_pct": pct,
            "rows_scanned": rows_scanned,
            "p50_ms": round(percentile(tail, 0.50), 2),
            "p95_ms": round(percentile(tail, 0.95), 2),
            "avg_ms": round(statistics.fmean(tail), 2),
            "cold_first_ms": round(warm_first, 2),
            "explain_exec_ms": round(exec_ms, 2) if exec_ms is not None else None,
            "n": len(tail),
        }
        out_points.append(point)
        print(
            f"  pct={pct:>3}%  rows={rows_scanned}  P50={point['p50_ms']} ms  "
            f"P95={point['p95_ms']} ms  (n={len(tail)})",
            flush=True,
        )

    cur.close()
    return {"total_rows_with_embedding": total, "points": out_points}


def linear_fit(points: list[dict]) -> dict:
    """对 rows -> p50 做最小二乘拟合，返回 slope / intercept / r2。"""
    xs = [p["rows_scanned"] for p in points if p["rows_scanned"]]
    ys = [p["p50_ms"] for p in points if p["rows_scanned"]]
    n = len(xs)
    if n < 2:
        return {}
    mx, my = statistics.fmean(xs), statistics.fmean(ys)
    sxx = sum((x - mx) ** 2 for x in xs)
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    if sxx == 0:
        return {}
    slope = sxy / sxx
    intercept = my - slope * mx
    ss_tot = sum((y - my) ** 2 for y in ys)
    ss_res = sum((y - (intercept + slope * x)) ** 2 for x, y in zip(xs, ys))
    r2 = 1 - ss_res / ss_tot if ss_tot else 1.0
    return {
        "slope_ms_per_1k_chunks": round(slope * 1000, 4),
        "intercept_ms": round(intercept, 2),
        "r2": round(r2, 4),
        "n_points": n,
    }


def main() -> int:
    global REPEATS
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", action="store_true", help="真正执行（不加则只做 dry-run 自检）")
    ap.add_argument("--repeats", type=int, default=REPEATS)
    ap.add_argument("--model", default=None, help="embedding_model 过滤值，默认读库里出现最多的那个")
    args = ap.parse_args()

    if not PROBE.exists():
        raise SystemExit(f"缺少探针向量 {PROBE}，先跑 encode-probe-vector.py")
    probe = json.loads(PROBE.read_text(encoding="utf-8"))
    if isinstance(probe, dict) and "literal" in probe:
        vec_literal = probe["literal"]
        dim = probe.get("dim")
    else:
        vec = probe["vector"] if isinstance(probe, dict) else probe
        vec_literal = "[" + ",".join(f"{float(x):.6f}" for x in vec) + "]"
        dim = len(vec)
    print(f"探针向量：{dim} 维，literal 长度 {len(vec_literal)}，来源 {PROBE.name}", flush=True)

    if not args.run:
        print("dry-run：未连接数据库。加 --run 执行。")
        return 0

    import psycopg2

    conn = psycopg2.connect(load_env(SERVER_ROOT))
    conn.autocommit = False
    try:
        cur = conn.cursor()
        if args.model is None:
            cur.execute(
                "SELECT embedding_model FROM discovered_book_chunks "
                "WHERE embedding IS NOT NULL GROUP BY 1 ORDER BY count(*) DESC LIMIT 1"
            )
            row = cur.fetchone()
            args.model = row[0] if row else None
        print(f"embedding_model 过滤值 = {args.model!r}", flush=True)
        cur.close()

        REPEATS = max(3, args.repeats)
        t0 = time.time()
        payload = run(conn, vec_literal, args.model)
        payload["fit"] = linear_fit(payload["points"])
        payload["generated_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
        payload["elapsed_seconds"] = round(time.time() - t0, 1)
        payload["warmup_discarded"] = WARMUP
        payload["repeats_timed"] = REPEATS
        payload["note"] = (
            "TABLESAMPLE SYSTEM 抽样只用于测延迟，不用于测召回；"
            "全程只读 SELECT，未建表、未写数据、未改任何 PG 参数（set_config 全部事务内）"
        )
        CACHE.mkdir(parents=True, exist_ok=True)
        OUT_JSON.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"\n写入 {OUT_JSON}")
        print(f"拟合：{payload['fit']}")
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
