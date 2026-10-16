# -*- coding: utf-8 -*-
"""
阶段 3 · 重新验证「真实生产 SQL」的执行路径（只读）

要回答的问题：真实生产 SQL 里那个 embedding_model 过滤谓词，会不会让优化器改变执行计划？

做法（禁止只看「有没有 Index Scan」，必须按索引名判路径）：
    arm A = EXACT   : enable_indexscan=off; enable_bitmapscan=off
    arm B = DEFAULT : 不动任何 GUC，看优化器自己选什么
    两条 SQL 形态：
      PROD_MODEL : search-discover.py 原文（带 embedding_model 谓词）
      PROD_NULL  : 同一条 SQL，但 model_filter 传 NULL（谓词短路）

路径标签（唯一判据是索引名，不是节点类型）：
    hnsw_idx 出现在计划里        -> HNSW
    没有任何索引、只有 Seq Scan  -> EXACT
    用了其它索引（如 book_idx）  -> FALLBACK

用法：
    C:/Python314/python.exe -u src/scripts/verify-prod-plan.py --repeat 9 --top-k 10
"""
from __future__ import annotations

import argparse
import json
import re
import statistics
import sys
from datetime import datetime
from pathlib import Path

SERVER_ROOT = Path(__file__).resolve().parents[2]
CACHE = SERVER_ROOT / ".crawl-cache"
VEC_FILE = CACHE / "_b6-probe-vector.json"
OUT = CACHE / "_prod-plan-check.json"

# search-discover.py 里的原文（逐字搬运，不做任何改写）
SQL_PROD = """
SELECT b.id                                   AS book_id,
       b.title                                AS title,
       b.author_display                       AS author,
       b.language                             AS language,
       b.rights                               AS rights,
       c.chunk_index                          AS chunk_index,
       c.chapter_title                        AS chapter_title,
       c.content                              AS content,
       1 - (c.embedding <=> %s::vector)       AS similarity
FROM discovered_book_chunks c
JOIN discovered_books b ON b.id = c.book_id
WHERE c.embedding IS NOT NULL
  AND (%s::text IS NULL OR c.embedding_model = %s)
  AND (%s OR c.chapter_title IS NOT NULL)
ORDER BY c.embedding <=> %s::vector
LIMIT %s
"""

SQL_EXPERIMENT = """
SELECT b.id, b.title, c.chunk_index, c.chapter_title, 1 - (c.embedding <=> %s::vector)
FROM discovered_book_chunks c
JOIN discovered_books b ON b.id = c.book_id
WHERE c.embedding IS NOT NULL AND c.chapter_title IS NOT NULL
ORDER BY c.embedding <=> %s::vector
LIMIT %s
"""

ARMS = {
    # 顺序很重要：set_config 必须在同一个事务里、与查询同事务才生效
    "EXACT": [("enable_indexscan", "off"), ("enable_bitmapscan", "off")],
    "DEFAULT": [],
    # 唯一多出来的一个 GUC：把迭代扫描改成 relaxed_order。
    # 这不是调召回参数，而是修复「带 WHERE 过滤时 ANN 提前收手、返回行数不足 top_k」的饥饿问题。
    "DEFAULT_RELAXED": [("hnsw.iterative_scan", "relaxed_order")],
}

SQL_FORMS = {
    "PROD_MODEL": (SQL_PROD, lambda v, k: (v, "BAAI/bge-m3", "BAAI/bge-m3", False, v, k)),
    "PROD_NULL": (SQL_PROD, lambda v, k: (v, None, None, False, v, k)),
    "EXPERIMENT": (SQL_EXPERIMENT, lambda v, k: (v, v, k)),
}


def load_db_url() -> str:
    for line in (SERVER_ROOT / ".env").read_text(encoding="utf-8").splitlines():
        if line.startswith("DATABASE_URL="):
            return line.split("=", 1)[1].strip()
    raise SystemExit("server/.env 缺少 DATABASE_URL")


def classify(raw: str) -> tuple[str, list[str], bool, bool]:
    """返回 (路径标签, 计划里出现的索引名列表, uses_index, is_hnsw)。"""
    indexes = re.findall(r"using (\w+)", raw)
    unique = sorted(set(indexes))
    uses_index = len(unique) > 0
    is_hnsw = any("embedding_hnsw_idx" in i for i in unique)
    if is_hnsw:
        path = "HNSW"
    elif not uses_index and "Seq Scan" in raw:
        path = "EXACT"
    elif uses_index:
        path = "FALLBACK"
    else:
        path = "UNKNOWN"
    return path, unique, uses_index, is_hnsw


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repeat", type=int, default=9)
    ap.add_argument("--top-k", type=int, default=10)
    ap.add_argument("--vector-json", default=str(VEC_FILE))
    args = ap.parse_args()

    import psycopg2

    vec = json.loads(Path(args.vector_json).read_text(encoding="utf-8"))
    literal = vec["literal"]
    probe_query = vec.get("query", "")
    print(f"探针 query = {probe_query!r}  dim={vec.get('dim')}", flush=True)

    conn = psycopg2.connect(load_db_url())
    conn.autocommit = False
    result = {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "probe_query": probe_query,
        "top_k": args.top_k,
        "repeat": args.repeat,
        "arms": {k: dict(v) for k, v in ARMS.items() if False},  # placeholder replaced below
        "cases": [],
    }
    result["arms"] = {k: [list(g) for g in v] for k, v in ARMS.items()}

    cur = conn.cursor()
    # 预热一次，避免第一次计划分析被冷缓存污染（这一轮不计入任何统计）
    cur.execute("select set_config('enable_indexscan','on',true)")
    cur.execute("select 1")
    conn.rollback()

    print("\n%-10s %-13s %-9s %-22s %-9s %-9s %-10s" %
          ("arm", "sql", "使用索引", "索引名称", "是否HNSW", "路径", "P50 ms"))
    print("-" * 96)
    with conn.cursor() as cur:
        for arm, gucs in ARMS.items():
            for form, (sql, mkargs) in SQL_FORMS.items():
                sql_args = mkargs(literal, args.top_k)
                times, paths, idx_sets = [], [], []
                plan_raw = None
                buffers = None
                rows_out = None
                for _ in range(args.repeat):
                    for k, v in gucs:
                        cur.execute("select set_config(%s,%s,true)", (k, v))
                    cur.execute("EXPLAIN (ANALYZE, BUFFERS) " + sql, sql_args)
                    raw_lines = [r[0] for r in cur.fetchall()]
                    raw = "\n".join(raw_lines)
                    conn.rollback()
                    m = re.search(r"Execution Time: ([\d.]+)", raw)
                    times.append(float(m.group(1)) if m else -1.0)
                    b = re.search(r"Buffers: shared hit=(\d+) read=(\d+)", raw)
                    if b:
                        buffers = {"shared_hit": int(b.group(1)), "shared_read": int(b.group(2))}
                    plan_raw = raw if plan_raw is None else plan_raw
                    paths.append(classify(raw)[0])
                    idx_sets.append(classify(raw)[1])
                # 真实跑一次拿 top1 结果（验证 two arms 是否返回同一批内容）
                for k, v in gucs:
                    cur.execute("select set_config(%s,%s,true)", (k, v))
                cur.execute(sql, sql_args)
                rows = cur.fetchall()
                conn.rollback()
                # 列位必须按 SQL 形态取：生产 SQL 有 9 列，实验 SQL 只有 5 列。
                # 曾经一律取 (r[2], r[3]) 会把 author / language 当成 chunk_index，
                #   导致 Top10 去重后只剩 4 条，重合度被严重低估。
                if sql is SQL_PROD:
                    ci, cti, si = 5, 6, 8
                else:
                    ci, cti, si = 2, 3, 4
                rows_out = [
                    {"book_id": str(r[0]), "title": r[1], "chunk_index": r[ci],
                     "chapter_title": r[cti], "similarity": round(float(r[si]), 6)}
                    for r in rows
                ]
                p50 = round(statistics.median(times), 3)
                path_top = max(set(paths), key=paths.count)
                idx_union = sorted({i for s in idx_sets for i in s})
                case = {
                    "arm": arm, "sql_form": form, "path": path_top,
                    "path_all": sorted(set(paths)), "indexes": idx_union,
                    "uses_index": len(idx_union) > 0,
                    "is_hnsw": any("embedding_hnsw_idx" in i for i in idx_union),
                    "is_fallback": path_top == "FALLBACK",
                    "latency_ms_all": times, "latency_p50_ms": p50,
                    "latency_min_ms": round(min(times), 3), "latency_max_ms": round(max(times), 3),
                    "buffers": buffers, "plan_raw": plan_raw[:4000],
                    "top_results": rows_out[:10], "rows_returned": len(rows),
                }
                result["cases"].append(case)
                print("%-10s %-13s %-9s %-22s %-9s %-9s %-10s" %
                      (arm, form, "是" if case["uses_index"] else "否",
                       (",".join(idx_union) or "—")[:22],
                       "是" if case["is_hnsw"] else "否", path_top, p50))

    cur.close()
    conn.close()
    OUT.write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\nwritten -> {OUT}")

    # EXACT vs DEFAULT：Top10 内容是否一致（一致的计划 = 召回层面等价）
    print("\n== 返回行数 & 与 EXACT 的 Top10 重合度（同为 PROD_MODEL 形态）==")
    for arm in ("EXACT", "DEFAULT", "DEFAULT_RELAXED"):
        c = next(c for c in result["cases"] if c["arm"] == arm and c["sql_form"] == "PROD_MODEL")
        base = next(c for c in result["cases"]
                    if c["arm"] == "EXACT" and c["sql_form"] == "PROD_MODEL")
        bk = {(r["title"], r["chunk_index"]) for r in base["top_results"]}
        ck = {(r["title"], r["chunk_index"]) for r in c["top_results"]}
        line = (f"  {arm:<16} rows={c['rows_returned']:<3} 与 EXACT Top10 重合={len(bk & ck)}/{len(bk)}"
                f"  P50={c['latency_p50_ms']}ms  Top1={c['top_results'][0]['title'][:30]}")
        print(line)
    base = next(c for c in result["cases"] if c["arm"] == "EXACT" and c["sql_form"] == "PROD_MODEL")
    print(f"  EXACT Top10 首条 = {base['top_results'][0]['title'][:30]} "
          f"(score={base['top_results'][0]['similarity']})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
