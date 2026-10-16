# -*- coding: utf-8 -*-
"""
阶段 5 补测 · 检索延迟 vs chunks 规模 曲线（只读，用于回答 Q3）

Q3 要求「chunks 数量阈值」必须依据 EXACT 延迟曲线 + HNSW 延迟曲线 + 编码延迟，不许凭经验。
但 Stage B.5 / B.6 跑的是同一份 58,332 chunks —— EXACT 只有一个规模点，一个点无法外推。

之前试过 TABLESAMPLE SYSTEM 抽样，**已废弃**：实测 75% 抽样 477ms > 100% 全量 262ms，
抽样引入了随机 I/O 偏差，不能当作「表变小」的代理（结论记在 _exact-latency-curve.json，作废）。

改用库内已有的**第二张同构真实表**做第二个规模点：
    discovered_book_chunks_exp   24,244 rows / 333 MB / 单均 13.7 KB   （自带 exp_hnsw_idx）
    discovered_book_chunks       58,332 rows / 808 MB / 单均 13.8 KB   （正式表）
单均行大小一致 → 结构同构，是真实的「规模减半」样本，不是抽样、不是合成。

全程只读：不建表、不写数据、不改正式表、不改 PG 参数（GUC 一律事务内 set_config）。

输出：.crawl-cache/_scale-latency-curve.json
用法：C:/Python314/python.exe -u src/scripts/scale-latency-curve.py --run
"""
from __future__ import annotations

import argparse
import json
import os
import statistics
import time
from pathlib import Path

SERVER_ROOT = Path(__file__).resolve().parents[2]
CACHE = SERVER_ROOT / ".crawl-cache"
OUT_JSON = CACHE / "_scale-latency-curve.json"
PROBE = CACHE / "_b6-probe-vector.json"

# (表名, 角色)。两个都是真实表，行数实测后写入结果。
TABLES = [
    ("discovered_book_chunks_exp", "小规模真实表"),
    ("discovered_book_chunks", "正式表"),
]
EF_VALUES = [40, 120, 800]
WARMUP = 3
REPEATS = 21


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


def percentile(sorted_vals: list[float], q: float) -> float:
    if not sorted_vals:
        return 0.0
    if len(sorted_vals) == 1:
        return sorted_vals[0]
    pos = (len(sorted_vals) - 1) * q
    lo = int(pos)
    hi = min(lo + 1, len(sorted_vals) - 1)
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (pos - lo)


def search_sql(table: str, filter_on: bool, top_k: int) -> str:
    """与 stage-b6-experiment.py 的 search_sql 同形状，只换表名。"""
    where = "c.embedding IS NOT NULL"
    if filter_on:
        where += " AND c.chapter_title IS NOT NULL"
    return (
        "SELECT b.id, b.title, c.chunk_index, c.chapter_title, "
        "1 - (c.embedding <=> %s::vector) AS similarity "
        f"FROM {table} c JOIN discovered_books b ON b.id = c.book_id "
        f"WHERE {where} ORDER BY c.embedding <=> %s::vector LIMIT {top_k}"
    )


def set_gucs(cur, mode: str, ef: int | None) -> None:
    """GUC 一律事务内 set_config(..., true)，commit 后自动失效，绝不污染连接池。"""
    if mode == "exact":
        cur.execute("SELECT set_config('enable_indexscan', 'off', true)")
        cur.execute("SELECT set_config('enable_bitmapscan', 'off', true)")
        cur.execute("SELECT set_config('enable_indexonlyscan', 'off', true)")
        cur.execute("SELECT set_config('enable_seqscan', 'on', true)")
    elif mode == "ann":
        cur.execute("SELECT set_config('hnsw.ef_search', %s, true)", (str(ef),))
        cur.execute("SELECT set_config('enable_seqscan', 'off', true)")
    cur.execute("SELECT set_config('hnsw.iterative_scan', 'relaxed_order', true)")


def measure(conn, sql: str, args: tuple, mode: str, ef: int | None) -> dict:
    samples: list[float] = []
    with conn.cursor() as cur:
        for i in range(WARMUP + REPEATS):
            t0 = time.perf_counter()
            cur.execute("BEGIN")
            set_gucs(cur, mode, ef)
            cur.execute(sql, args)
            cur.fetchall()
            conn.commit()
            dt = (time.perf_counter() - t0) * 1000
            if i >= WARMUP:
                samples.append(dt)
        # EXPLAIN 只跑一次，确认真的走对了路径（路径判据按索引名）
        cur.execute("BEGIN")
        set_gucs(cur, mode, ef)
        cur.execute("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + sql, args)
        plan = cur.fetchone()[0]
        conn.commit()
    samples.sort()
    tail = samples[1:] if len(samples) > 1 else samples  # 第 1 次为冷样本，不计入 P50
    idx, node = extract_plan(plan)
    return {
        "p50_ms": round(percentile(tail, 0.50), 2),
        "p95_ms": round(percentile(tail, 0.95), 2),
        "avg_ms": round(statistics.fmean(tail), 2),
        "cold_first_ms": round(samples[0], 2),
        "n": len(tail),
        "plan_index": idx,
        "plan_node": node,
    }


def extract_plan(plan_json) -> tuple[str | None, str | None]:
    """按索引名判路径，不认节点类型。返回 (索引名, 节点类型)。"""
    found: list[tuple[str | None, str | None]] = []

    def walk(node):
        nt = node.get("Node Type", "")
        ix = node.get("Index Name")
        if ix or nt in ("Seq Scan", "Index Scan", "Index Only Scan", "Bitmap Heap Scan"):
            found.append((ix, nt))
        for ch in node.get("Plans", []) or []:
            walk(ch)

    for entry in plan_json:
        walk(entry.get("Plan", entry))
    return (found[0] if found else (None, None))


def main() -> int:
    global REPEATS
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", action="store_true")
    ap.add_argument("--repeats", type=int, default=REPEATS)
    ap.add_argument("--top-k", type=int, default=10)
    args = ap.parse_args()

    if not PROBE.exists():
        raise SystemExit(f"缺少探针向量 {PROBE}")
    probe = json.loads(PROBE.read_text(encoding="utf-8"))
    literal = probe["literal"]
    print(f"探针向量 {probe['dim']} 维（{probe['model']}），literal 长度 {len(literal)}", flush=True)

    if not args.run:
        print("dry-run：未连接数据库。加 --run 执行。")
        return 0

    import psycopg2

    REPEATS = max(5, args.repeats)
    conn = psycopg2.connect(load_env(SERVER_ROOT))
    conn.autocommit = False
    t_start = time.time()
    points: list[dict] = []
    try:
        with conn.cursor() as cur:
            for table, role in TABLES:
                cur.execute(f"SELECT count(*) FROM {table} WHERE embedding IS NOT NULL")
                total = cur.fetchone()[0]
                cur.execute(
                    f"SELECT count(*) FROM {table} c JOIN discovered_books b ON b.id = c.book_id "
                    f"WHERE c.embedding IS NOT NULL AND c.chapter_title IS NOT NULL"
                )
                joinable = cur.fetchone()[0]
                cur.execute(
                    f"SELECT pg_total_relation_size(%s::regclass)", (table,)
                )
                size_b = cur.fetchone()[0]
                row = {
                    "table": table,
                    "role": role,
                    "rows_with_embedding": total,
                    "rows_after_join_and_filter": joinable,
                    "total_bytes": size_b,
                    "bytes_per_row": round(size_b / total, 1) if total else None,
                }
                sql = search_sql(table, True, args.top_k)

                m = measure(conn, sql, (literal, literal), "exact", None)
                row["exact"] = m
                print(f"[{table}] rows={total:,} join/filter={joinable:,} "
                      f"size={size_b/1024/1024:.0f}MB  EXACT P50={m['p50_ms']}ms "
                      f"node={m['plan_node']} idx={m['plan_index']}", flush=True)

                row["ann"] = {}
                for ef in EF_VALUES:
                    m = measure(conn, sql, (literal, literal), "ann", ef)
                    row["ann"][f"ef{ef}"] = m
                    print(f"[{table}]   HNSW ef={ef:<3} P50={m['p50_ms']}ms "
                          f"node={m['plan_node']} idx={m['plan_index']}", flush=True)

                # 扫描-only 基线（不做向量距离）：用于把 EXACT 拆成 I/O + 计算 两部分
                base_sql = f"SELECT sum(c.content_chars) FROM {table} c"
                m = measure(conn, base_sql, (), "exact", None)
                row["scan_only"] = m
                print(f"[{table}]   scan-only 基线 P50={m['p50_ms']}ms "
                      f"node={m['plan_node']}", flush=True)
                points.append(row)
    finally:
        conn.close()

    # 两点定线：斜率 / 截距（只有两个规模点，没有残差可算，明确标注）
    def fit(xs, ys):
        if len(xs) < 2 or xs[0] == xs[1]:
            return {}
        slope = (ys[1] - ys[0]) / (xs[1] - xs[0])
        intercept = ys[0] - slope * xs[0]
        return {
            "slope_ms_per_1k_chunks": round(slope * 1000, 4),
            "intercept_ms": round(intercept, 2),
        }

    xs = [p["rows_with_embedding"] for p in points]
    fits = {
        "exact": fit(xs, [p["exact"]["p50_ms"] for p in points]),
        "scan_only": fit(xs, [p["scan_only"]["p50_ms"] for p in points]),
    }
    for ef in EF_VALUES:
        fits[f"ann_ef{ef}"] = fit(xs, [p["ann"][f"ef{ef}"]["p50_ms"] for p in points])

    payload = {
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "elapsed_seconds": round(time.time() - t_start, 1),
        "warmup_discarded": WARMUP,
        "repeats_timed": REPEATS,
        "top_k": args.top_k,
        "filter": "chapter_title IS NOT NULL（与生产一致）",
        "note": (
            "两个规模点都来自库内真实表，未抽样、未合成、未新建数据。"
            "TABLESAMPLE 抽样方案已废弃（75% 抽样比 100% 全量更慢，随机 I/O 有偏）。"
            "GUC 全部事务内 set_config(..., true)，未改 postgresql.conf，未改 ef_search 默认值。"
        ),
        "points": points,
        "fits": fits,
    }
    CACHE.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n写入 {OUT_JSON}")
    for k, v in fits.items():
        print(f"  {k}: {v}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
