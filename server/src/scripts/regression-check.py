# -*- coding: utf-8 -*-
"""
B.8 · 任务 2：可定期跑的回归验证脚本

干什么：数据增长会让 EXACT 越来越慢。这个脚本每次跑都会
  1) 量当前 EXACT / HNSW 的检索延迟
  2) 用**本次实测**重新拟合「延迟 vs 规模」斜率（不硬编码）
  3) 算出当前规模离 400ms / 500ms 预算线还有多远
  4) 给出 OK / WARN / ALERT

建议频率：每周一次，或每次大批量导入新书籍后。

关键设计：
  · **不加载 BGE-M3 模型**（RSS ~2GB，不适合常驻/定时跑）。
    query 向量从缓存文件 `.crawl-cache/_b8-query-vectors.json` 读取，
    由 b8-e2e-experiment.py 产出。缓存缺失会明确报错并告诉你怎么补。
  · **斜率两点拟合**：库内有第二张同构真实表 `discovered_book_chunks_exp`，
    直接拿它当小规模点重新拟合，不依赖 B.6/B.7 的历史数字。
    拿不到小表时退化为「单点斜率 + 固定截距 -48.31」。
  · 全程只读；GUC 只在连接级设置。

用法：
  C:/Python314/python.exe -u src/scripts/regression-check.py --run
  C:/Python314/python.exe -u src/scripts/regression-check.py --run --sample 20 --budget 400
"""
from __future__ import annotations

import argparse
import json
import os
import random
import statistics
import sys
import time
from pathlib import Path

SERVER_ROOT = Path(__file__).resolve().parents[2]
CACHE = SERVER_ROOT / ".crawl-cache"
VECTORS = CACHE / "_b8-query-vectors.json"
LAT = CACHE / "_query-embedding-latency.json"
QUERIES = SERVER_ROOT.parent / "discover-query-set-v3.json"
OUT_JSON = CACHE / "_b8-regression.json"

MAIN_TABLE = "discovered_book_chunks"
SMALL_TABLE = "discovered_book_chunks_exp"
FALLBACK_INTERCEPT = -48.31   # B.7 两点拟合的截距；只在拿不到小表时兜底


def load_env(root: Path) -> str:
    for line in (root / ".env").read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if s and not s.startswith("#") and "=" in s:
            k, _, v = s.partition("=")
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError("缺少 DATABASE_URL（检查 server/.env）")
    return url


def pct(vals: list[float], q: float) -> float:
    if not vals:
        return 0.0
    s = sorted(vals)
    if len(s) == 1:
        return s[0]
    pos = (len(s) - 1) * q
    lo = int(pos)
    hi = min(lo + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (pos - lo)


def init_statements() -> list[str]:
    raw = (SERVER_ROOT / "src/scripts/db-conn-init.sql").read_text(encoding="utf-8")
    out = []
    for chunk in raw.split(";"):
        body = "\n".join(ln for ln in chunk.splitlines()
                         if not ln.lstrip().startswith("--")).strip()
        if body:
            out.append(body)
    return out


def search_sql(table: str, top_k: int) -> str:
    return (
        "SELECT b.id, b.title, c.chunk_index, c.chapter_title, "
        "1 - (c.embedding <=> %s::vector) AS similarity "
        f"FROM {table} c JOIN discovered_books b ON b.id = c.book_id "
        "WHERE c.embedding IS NOT NULL AND c.chapter_title IS NOT NULL "
        f"ORDER BY c.embedding <=> %s::vector LIMIT {top_k}"
    )


def measure(conn, table: str, literals: list[str], top_k: int, repeats: int) -> list[float]:
    """返回每个 literal 的检索延迟中位数（ms）。"""
    sql = search_sql(table, top_k)
    out = []
    with conn.cursor() as cur:
        for lit in literals:
            samples = []
            for _ in range(repeats):
                t0 = time.perf_counter()
                cur.execute(sql, (lit, lit))
                cur.fetchall()
                conn.commit()
                samples.append((time.perf_counter() - t0) * 1000)
            out.append(statistics.median(samples))
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", action="store_true")
    ap.add_argument("--sample", type=int, default=20, help="抽多少条 query")
    ap.add_argument("--top-k", type=int, default=10)
    ap.add_argument("--repeats", type=int, default=3)
    ap.add_argument("--budget", type=int, default=400, help="端到端预算 ms（用于 status 判定）")
    ap.add_argument("--seed", type=int, default=20261017)
    args = ap.parse_args()

    if not args.run:
        print("dry-run。加 --run 执行。")
        return 0

    if not VECTORS.exists():
        raise SystemExit(
            f"缺少 query 向量缓存 {VECTORS}\n"
            "  先跑一次：C:/Python314/python.exe -u src/scripts/b8-e2e-experiment.py --run\n"
            "  它会把 100 条 query 的向量缓存下来，供本脚本复用（避免每次加载 2GB 模型）。"
        )
    vecs = json.loads(VECTORS.read_text(encoding="utf-8"))
    qset = json.loads(QUERIES.read_text(encoding="utf-8"))
    # 直接用 discover-query-set-v3.json 的 queries 数组
    # （stage-b6 的 load_query_set() 会把它包装成 {"rows": [...]}，这里没走那条路）
    counted = [r for r in qset["queries"] if r.get("counted")]
    pool = [r for r in counted if r["query_id"] in vecs]
    if not pool:
        raise SystemExit("缓存里的向量与 query set 对不上，重跑 b8-e2e-experiment.py")

    rng = random.Random(args.seed)
    picked = rng.sample(pool, min(args.sample, len(pool)))
    literals = [vecs[r["query_id"]] for r in picked]

    enc_s = enc_l = None
    if LAT.exists():
        lr = json.loads(LAT.read_text(encoding="utf-8"))["results"]
        enc_s = lr["short_query_12char"]["p50_ms"]
        enc_l = lr["long_query_77char"]["p50_ms"]
    enc_s = enc_s or 91.15
    enc_l = enc_l or 177.96

    import psycopg2

    url = load_env(SERVER_ROOT)

    # 连接 A：生产配置（db-conn-init.sql）
    conn_h = psycopg2.connect(url)
    conn_h.autocommit = False
    ch = conn_h.cursor()
    for s in init_statements():
        ch.execute(s)
    conn_h.commit()

    # 连接 B：EXACT
    conn_e = psycopg2.connect(url)
    conn_e.autocommit = False
    ce = conn_e.cursor()
    for s in ("SET enable_indexscan = off", "SET enable_bitmapscan = off",
              "SET enable_indexonlyscan = off", "SET enable_seqscan = on"):
        ce.execute(s)
    conn_e.commit()

    try:
        ce.execute(f"SELECT count(*) FROM {MAIN_TABLE}")
        row_count = int(ce.fetchone()[0])
        conn_e.commit()

        small_rows = None
        try:
            ce.execute(f"SELECT count(*) FROM {SMALL_TABLE}")
            small_rows = int(ce.fetchone()[0])
            conn_e.commit()
        except Exception:  # noqa: BLE001
            conn_e.rollback()

        hnsw = measure(conn_h, MAIN_TABLE, literals, args.top_k, args.repeats)
        exact = measure(conn_e, MAIN_TABLE, literals, args.top_k, args.repeats)

        # ---- 斜率：优先两点拟合（小表 + 主表），退化则单点 + 固定截距 ----
        slope = intercept = None
        fit_mode = ""
        if small_rows and small_rows != row_count:
            ex_small = measure(conn_e, SMALL_TABLE, literals, args.top_k, args.repeats)
            x0, y0 = small_rows, pct(ex_small, 0.50)
            x1, y1 = row_count, pct(exact, 0.50)
            if x1 != x0:
                slope = (y1 - y0) / (x1 - x0) * 1000   # ms per 1k rows
                intercept = y0 - (slope / 1000) * x0
                fit_mode = f"两点拟合（{SMALL_TABLE} {x0:,} + {MAIN_TABLE} {x1:,}）"
        if slope is None:
            slope = pct(exact, 0.50) / row_count * 1000
            intercept = FALLBACK_INTERCEPT
            fit_mode = f"单点斜率 + 固定截距 {FALLBACK_INTERCEPT}（未拿到小表）"

        def n_star(budget: int, encode: float) -> float:
            return (budget - encode - intercept) / slope * 1000

        n400_s, n400_l = n_star(400, enc_s), n_star(400, enc_l)
        n500_s, n500_l = n_star(500, enc_s), n_star(500, enc_l)

        # status 用长 query（保守侧）+ 指定预算
        n_ref = n_star(args.budget, enc_l)
        if row_count >= n_ref:
            status = "ALERT"
        elif row_count >= n_ref * 0.8:
            status = "WARN"
        else:
            status = "OK"

        out = {
            "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
            "row_count": row_count,
            "sample_size": len(literals),
            "top_k": args.top_k,
            "repeats_per_query": args.repeats,
            "small_table": {"name": SMALL_TABLE, "rows": small_rows},
            "encode_latency_ms": {"short": enc_s, "long": enc_l},
            "exact_p50_ms": round(pct(exact, 0.50), 2),
            "exact_p95_ms": round(pct(exact, 0.95), 2),
            "hnsw_p50_ms": round(pct(hnsw, 0.50), 2),
            "hnsw_p95_ms": round(pct(hnsw, 0.95), 2),
            "slope_ms_per_1k_rows": round(slope, 4),
            "intercept_ms": round(intercept, 2),
            "fit_mode": fit_mode,
            "n_star_400ms": {"short": round(n400_s), "long": round(n400_l)},
            "n_star_500ms": {"short": round(n500_s), "long": round(n500_l)},
            "budget_used_for_status": args.budget,
            "headroom_ratio": round(row_count / n_ref, 3),
            "status": status,
        }
        CACHE.mkdir(parents=True, exist_ok=True)
        OUT_JSON.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(out, ensure_ascii=False, indent=2))
        print(f"\n状态：{status}（{row_count:,} 行 / {args.budget}ms 阈值 "
              f"{n_ref:,.0f} 行，占用率 {out['headroom_ratio']*100:.1f}%）")
        print(f"写入 {OUT_JSON}")
    finally:
        conn_h.close()
        conn_e.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
