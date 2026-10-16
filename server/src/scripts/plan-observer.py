# -*- coding: utf-8 -*-
"""
执行计划观测器（客户端版，零 schema 变更）

与 explain-plan-observer.sql 等价，但在客户端做 —— 不在正式库里建任何函数，
满足「只读优先、不触碰正式资产」。

用法：
  C:/Python314/python.exe -u src/scripts/plan-observer.py --run
  C:/Python314/python.exe -u src/scripts/plan-observer.py --run --efs 40 120 200 400 800 --runs 3

输出：.crawl-cache/_b7-plan-observations.json
"""
from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
from pathlib import Path

SERVER_ROOT = Path(__file__).resolve().parents[2]
CACHE = SERVER_ROOT / ".crawl-cache"
PROBE = CACHE / "_b6-probe-vector.json"
OUT_JSON = CACHE / "_b7-plan-observations.json"

HNSW_INDEX = "discovered_book_chunks_embedding_hnsw_idx"
DEFAULT_EFS = [40, 120, 200, 400, 800]
ISCAN_VALUES = ["off", "strict_order", "relaxed_order"]


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


def search_sql(filter_on: bool, top_k: int) -> str:
    """与 stage-b6-experiment.py 的 search_sql 逐字一致。"""
    where = "c.embedding IS NOT NULL"
    if filter_on:
        where += " AND c.chapter_title IS NOT NULL"
    return (
        "SELECT b.id, b.title, c.chunk_index, c.chapter_title, "
        "1 - (c.embedding <=> %s::vector) AS similarity "
        "FROM discovered_book_chunks c JOIN discovered_books b ON b.id = c.book_id "
        f"WHERE {where} ORDER BY c.embedding <=> %s::vector LIMIT {top_k}"
    )


def walk(node: dict):
    yield node
    for ch in node.get("Plans") or []:
        yield from walk(ch)


def observe(conn, literal: str, ef: int | None, iscan: str, top_k: int,
            filter_on: bool, runs: int) -> dict:
    sql = search_sql(filter_on, top_k)
    obs = []
    with conn.cursor() as cur:
        for _ in range(runs):
            cur.execute("BEGIN")
            if ef is None:                      # EXACT
                cur.execute("SELECT set_config('enable_indexscan','off',true)")
                cur.execute("SELECT set_config('enable_bitmapscan','off',true)")
                cur.execute("SELECT set_config('enable_indexonlyscan','off',true)")
                cur.execute("SELECT set_config('enable_seqscan','on',true)")
            else:
                cur.execute("SELECT set_config('hnsw.ef_search', %s, true)", (str(ef),))
                cur.execute("SELECT set_config('enable_seqscan','off',true)")
            cur.execute("SELECT set_config('hnsw.iterative_scan', %s, true)", (iscan,))
            cur.execute("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + sql, (literal, literal))
            plan = cur.fetchone()[0][0]
            conn.commit()

            idx = None
            scan = None
            hit = read = 0
            for n in walk(plan["Plan"]):
                if idx is None and n.get("Index Name"):
                    idx = n["Index Name"]
                if scan is None and "Scan" in (n.get("Node Type") or ""):
                    scan = n["Node Type"]
                hit += int(n.get("Shared Hit Blocks") or 0)
                read += int(n.get("Shared Read Blocks") or 0)

            if idx == HNSW_INDEX:
                ptype = "HNSW"
            elif idx is not None:
                ptype = "FALLBACK"
            elif scan == "Seq Scan":
                ptype = "EXACT"
            else:
                ptype = "UNKNOWN"

            obs.append({
                "plan_type": ptype,
                "scan_node": scan,
                "index_name": idx or "—（无索引）",
                "latency_ms": round(float(plan.get("Execution Time") or 0), 3),
                "rows_returned": int(plan["Plan"].get("Actual Rows") or 0),
                "shared_hit": hit,
                "shared_read": read,
                "buffer_hit_ratio": round(hit / (hit + read), 4) if (hit + read) else None,
            })

    lats = [o["latency_ms"] for o in obs]
    last = obs[-1]
    return {
        "ef": ef,
        "iterative_scan": iscan,
        "plan_type": last["plan_type"],
        "scan_node": last["scan_node"],
        "index_name": last["index_name"],
        "rows_returned": last["rows_returned"],
        "shared_hit": last["shared_hit"],
        "shared_read": last["shared_read"],
        "buffer_hit_ratio": last["buffer_hit_ratio"],
        "latency_ms_p50": round(statistics.median(lats), 3),
        "latency_ms_min": round(min(lats), 3),
        "latency_ms_max": round(max(lats), 3),
        "runs": runs,
        "types_seen": sorted({o["plan_type"] for o in obs}),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", action="store_true")
    ap.add_argument("--efs", nargs="*", type=int, default=DEFAULT_EFS)
    ap.add_argument("--iscans", nargs="*", default=["strict_order"])
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--top-k", type=int, default=10)
    ap.add_argument("--no-filter", action="store_true")
    args = ap.parse_args()

    if not PROBE.exists():
        raise SystemExit(f"缺少探针向量 {PROBE}")
    literal = json.loads(PROBE.read_text(encoding="utf-8"))["literal"]
    print(f"探针向量来源 {PROBE.name}，长度 {len(literal)}")

    if not args.run:
        print("dry-run。加 --run 执行。")
        return 0

    import psycopg2

    conn = psycopg2.connect(load_env(SERVER_ROOT))
    conn.autocommit = False
    filter_on = not args.no_filter
    rows = []
    try:
        rows.append(observe(conn, literal, None, "off", args.top_k, filter_on, args.runs))
        print(f"  EXACT                 -> {rows[-1]['plan_type']:<9} "
              f"{rows[-1]['latency_ms_p50']:>8.2f} ms  rows={rows[-1]['rows_returned']}  "
              f"idx={rows[-1]['index_name']}", flush=True)
        for ef in args.efs:
            for iscan in args.iscans:
                rows.append(observe(conn, literal, ef, iscan, args.top_k, filter_on, args.runs))
                r = rows[-1]
                print(f"  ef={ef:<4} {iscan:<14} -> {r['plan_type']:<9} "
                      f"{r['latency_ms_p50']:>8.2f} ms  rows={r['rows_returned']}  "
                      f"idx={r['index_name']}", flush=True)
    finally:
        conn.close()

    payload = {
        "generated_at": __import__("time").strftime("%Y-%m-%d %H:%M:%S"),
        "top_k": args.top_k,
        "filter": "chapter_title IS NOT NULL" if filter_on else "none",
        "runs_per_point": args.runs,
        "note": "客户端观测，未在建函数、未改任何 schema；GUC 全部事务内 set_config(..., true)",
        "observations": rows,
    }
    OUT_JSON.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n写入 {OUT_JSON}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
