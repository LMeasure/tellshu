# -*- coding: utf-8 -*-
"""
B.9 · 归因探针：API 的检索延迟为什么比 B.8 基线高一个数量级？

背景（本轮实测到的异常）：
    B.8 基线（b8-e2e-experiment.py，隔离分段）  retrieve P50 =  12.09 ms
    B.9 HTTP API（b9-http-benchmark.py）        retrieve P50 = 189.66 ms
    同样 ef=800 + strict_order，同样 top_k=10，同样过滤器 —— 差 15.7 倍。
    encode 反而基本一致（140.66 vs 154.74），所以问题在检索这一段。

两个候选嫌疑，必须分开测：
    S1  【SQL 不同】B.8 用的是 stage-b6 的 search_sql，SELECT 列表里**没有 content**；
        API 用的是 eval-discover 的 SQL，多了 c.content（每块 ~500 字符）。
        取 content 会让 HNSW index scan 之后**必须回表取 heap 页**（58k 行 / 808MB），
        这在 buffer 命中率不够时是随机 IO，代价可能远超 5KB 文本本身。
    S2  【内存环境不同】B.8 那轮可用内存更充裕；本轮服务常驻 2GB 模型 + 94% 内存负载。
        本探针不直接验证 S2（它不受控），但会记录 shared_hit / shared_read，
        如果命中率明显偏低，就是 S2 的指纹。

做法：同一条连接（执行 db-conn-init.sql）、同一组 20 条 query、每臂 3 次取中位，
     两臂交替跑（避免把顺序效应算进某一臂）。

用法（PowerShell，torch 不需要，Git Bash 也行）：
  C:/Python314/python.exe -u src/scripts/b9-retrieve-cost-probe.py --run
"""
from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
from pathlib import Path

SERVER_ROOT = Path(__file__).resolve().parents[2]
CACHE = SERVER_ROOT / ".crawl-cache"
VECTORS = CACHE / "_b8-query-vectors.json"
QUERIES = SERVER_ROOT.parent / "discover-query-set-v3.json"
OUT_JSON = CACHE / "_b9-retrieve-cost.json"

REPEATS = 3
WARMUP = 3


def init_statements() -> list[str]:
    raw = (SERVER_ROOT / "src/scripts/db-conn-init.sql").read_text(encoding="utf-8")
    out = []
    for chunk in raw.split(";"):
        body = "\n".join(ln for ln in chunk.splitlines()
                         if not ln.lstrip().startswith("--")).strip()
        if body:
            out.append(body)
    return out


# 臂 B：B.8 用的 SQL（stage-b6-experiment.py 的 search_sql，逐字）
SQL_B8_NO_CONTENT = (
    "SELECT b.id, b.title, c.chunk_index, c.chapter_title, "
    "1 - (c.embedding <=> %s::vector) AS similarity "
    "FROM discovered_book_chunks c JOIN discovered_books b ON b.id = c.book_id "
    "WHERE c.embedding IS NOT NULL AND c.chapter_title IS NOT NULL "
    "ORDER BY c.embedding <=> %s::vector LIMIT %s"
)

# 臂 A：API 用的 SQL（api/retrieve.py 的 SEARCH_SQL，逐字）
SQL_API_WITH_CONTENT = """
            SELECT c.id                             AS chunk_id,
                   b.id                             AS book_id,
                   b.title                          AS title,
                   b.author_display                 AS author,
                   c.chunk_index                    AS chunk_index,
                   c.chapter_title                  AS chapter_title,
                   c.content                        AS content,
                   1 - (c.embedding <=> %s::vector) AS similarity
            FROM discovered_book_chunks c
            JOIN discovered_books b ON b.id = c.book_id
            WHERE c.embedding IS NOT NULL
              AND (%s OR c.chapter_title IS NOT NULL)
            ORDER BY c.embedding <=> %s::vector
            LIMIT %s
        """

ARMS = [
    ("b8_no_content", SQL_B8_NO_CONTENT, "B.8 同款：不含 content"),
    ("api_with_content", SQL_API_WITH_CONTENT, "API 同款：含 content"),
]


def pct(vals: list[float], q: float) -> float:
    if not vals:
        return 0.0
    s = sorted(vals)
    pos = (len(s) - 1) * q
    lo = int(pos)
    hi = min(lo + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (pos - lo)


def params_for(name: str, literal: str, top_k: int) -> tuple:
    if name == "b8_no_content":
        return (literal, literal, top_k)
    return (literal, False, literal, top_k)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", action="store_true")
    ap.add_argument("--n", type=int, default=20)
    ap.add_argument("--top-k", type=int, default=10)
    ap.add_argument("--repeats", type=int, default=REPEATS)
    args = ap.parse_args()
    if not args.run:
        print("dry-run。加 --run 执行。")
        return 0

    if not VECTORS.exists():
        raise SystemExit(f"缺少向量缓存 {VECTORS}")
    vecs = json.loads(VECTORS.read_text(encoding="utf-8"))
    qset = json.loads(QUERIES.read_text(encoding="utf-8"))
    picked = [q for q in qset["queries"] if q.get("counted")][: args.n]
    literals = [vecs[q["query_id"]] for q in picked if q["query_id"] in vecs]
    print(f"query 数：{len(literals)}（来自 _b8-query-vectors.json，零编码成本）")

    import psycopg2

    url = None
    for line in (SERVER_ROOT / ".env").read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if s.startswith("DATABASE_URL="):
            url = s.partition("=")[2].strip().strip("'\"")
    if not url:
        raise SystemExit("server/.env 里没有 DATABASE_URL")

    conn = psycopg2.connect(url)
    conn.autocommit = False
    cur = conn.cursor()
    for s in init_statements():
        cur.execute(s)
    conn.commit()
    cur.execute("SHOW hnsw.ef_search")
    print("连接 ef_search =", cur.fetchone()[0])
    conn.commit()

    results = {}
    try:
        # warmup（只预热连接与执行计划，不指望它预热 456MB 索引）
        for i in range(WARMUP):
            for name, sql, _ in ARMS:
                cur.execute(sql, params_for(name, literals[i % len(literals)], args.top_k))
                cur.fetchall()
                conn.commit()
        print(f"warmup {WARMUP} 轮已丢弃")

        # ⚠ 冷态测量有**顺序效应**：先跑的臂会把 456MB HNSW 索引的页读进 page cache，
        #   后跑的臂直接受益。第一版就是这么翻车的（B.8 臂先跑拿到 132ms，
        #   API 臂后跑只有 33ms —— 差值不是 SQL 造成的，是顺序造成的）。
        #   修正：跑 AB 与 BA 两轮，每臂取两轮的平均。
        cold_samples: dict[str, list[list[float]]] = {name: [] for name, _, _ in ARMS}
        for rnd, order in enumerate((ARMS, list(reversed(ARMS))), start=1):
            print(f"\n冷态轮 {rnd}（顺序 {' → '.join(a[0] for a in order)}）…", flush=True)
            for name, sql, _ in order:
                samples = []
                for lit in literals:
                    t0 = time.perf_counter()
                    cur.execute(sql, params_for(name, lit, args.top_k))
                    cur.fetchall()
                    conn.commit()
                    samples.append((time.perf_counter() - t0) * 1000)
                cold_samples[name].append(samples)
                print(f"    {name:<18} 本轮 P50 {pct(samples,0.50):>7.2f} ms", flush=True)

        for name, sql, desc in ARMS:
            print(f"\n臂 {name}（{desc}）热态 …", flush=True)
            per_query = []
            for lit in literals:
                samples, rows = [], 0
                for _ in range(args.repeats):
                    t0 = time.perf_counter()
                    cur.execute(sql, params_for(name, lit, args.top_k))
                    r = cur.fetchall()
                    conn.commit()
                    samples.append((time.perf_counter() - t0) * 1000)
                    rows = len(r)
                per_query.append({
                    # cold_ms = 这条 query 在两轮冷态里的平均（已抵消顺序效应）
                    "cold_ms": round(statistics.fmean(
                        [cold_samples[name][0][literals.index(lit)],
                         cold_samples[name][1][literals.index(lit)]]), 2),
                    # median_ms = 3 次取中位：B.8 用的口径（同一条连跑，索引页已热）
                    "median_ms": round(statistics.median(samples), 2),
                    "rows": rows,
                })
            # 一条 EXPLAIN 看 buffer 命中
            cur.execute("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + sql,
                        params_for(name, literals[0], args.top_k))
            plan = cur.fetchone()[0][0]
            conn.commit()

            def walk(n):
                yield n
                for c in n.get("Plans") or []:
                    yield from walk(c)
            hit = read = 0
            idx = None
            for n in walk(plan["Plan"]):
                hit += int(n.get("Shared Hit Blocks") or 0)
                read += int(n.get("Shared Read Blocks") or 0)
                if idx is None and n.get("Index Name"):
                    idx = n["Index Name"]

            meds = [q["median_ms"] for q in per_query]
            colds = [q["cold_ms"] for q in per_query]
            results[name] = {
                "description": desc,
                "warm_p50_ms": round(pct(meds, 0.50), 2),
                "warm_p95_ms": round(pct(meds, 0.95), 2),
                "cold_p50_ms": round(pct(colds, 0.50), 2),
                "cold_p95_ms": round(pct(colds, 0.95), 2),
                "cold_mean_ms": round(statistics.fmean(colds), 2),
                "p50_ms": round(pct(meds, 0.50), 2),
                "p95_ms": round(pct(meds, 0.95), 2),
                "mean_ms": round(statistics.fmean(meds), 2),
                "max_ms": round(max(meds), 2),
                "rows_all": sorted({q["rows"] for q in per_query}),
                "explain": {"index": idx, "shared_hit": hit, "shared_read": read,
                            "hit_ratio": round(hit / (hit + read), 4) if (hit + read) else None,
                            "execution_time_ms": round(float(plan.get("Execution Time") or 0), 3)},
                "per_query": per_query,
            }
            r = results[name]
            print(f"   热态（3次取中位，B.8 口径）P50 {r['warm_p50_ms']:>7.2f} ms  P95 {r['warm_p95_ms']:>7.2f} ms")
            print(f"   冷态（每条首次，线上形态）P50 {r['cold_p50_ms']:>7.2f} ms  "
                  f"P95 {r['cold_p95_ms']:>7.2f} ms  mean {r['cold_mean_ms']:>7.2f} ms")
            print(f"   rows={r['rows_all']}  hit={hit} read={read} ratio={r['explain']['hit_ratio']}")

    finally:
        conn.close()

    a = results["api_with_content"]
    b = results["b8_no_content"]
    warm_delta = a["warm_p50_ms"] - b["warm_p50_ms"]
    cold_delta = a["cold_p50_ms"] - b["cold_p50_ms"]
    payload = {
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "config": {"n": len(literals), "top_k": args.top_k, "repeats": args.repeats,
                   "warmup_discarded": WARMUP, "guc": "db-conn-init.sql（ef=800 + strict_order）",
                   "cold_definition": (
                       "每条 query 只跑一次（线上真实形态：用户每条 query 都是新的）；"
                       "跑 AB 与 BA 两轮取平均以抵消顺序效应 —— 第一版没做抵消，"
                       "先跑的臂吸收了 456MB 索引的全部冷启动代价，得出反常结论"),
                   "warm_definition": "同一条 query 连跑 3 次取中位（B.8 用的口径，索引页已热）"},
        "results": results,
        "conclusion": {
            "content_cost_warm_p50_ms": round(warm_delta, 2),
            "content_cost_cold_p50_ms": round(cold_delta, 2),
            "warm_p50": {"b8_sql": b["warm_p50_ms"], "api_sql": a["warm_p50_ms"]},
            "cold_p50": {"b8_sql": b["cold_p50_ms"], "api_sql": a["cold_p50_ms"]},
            "note": (
                "S1（content 回表）判定看 content_cost_* 两行：接近 0 即排除。"
                "S3（冷/热口径差）判定看 warm_p50 vs cold_p50：若冷态远高于热态，"
                "说明 B.8 的 12.09ms 是热态乐观值，线上的真实形态要按冷态算。"
            ),
        },
    }
    CACHE.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\ncontent 代价：热态 {warm_delta:+.2f} ms，冷态 {cold_delta:+.2f} ms  → S1 判定")
    print(f"热态 P50：B.8 SQL {b['warm_p50_ms']} ms / API SQL {a['warm_p50_ms']} ms")
    print(f"冷态 P50：B.8 SQL {b['cold_p50_ms']} ms / API SQL {a['cold_p50_ms']} ms  → S3 判定")
    print(f"写入 {OUT_JSON}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
