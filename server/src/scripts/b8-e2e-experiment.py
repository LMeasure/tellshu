# -*- coding: utf-8 -*-
"""
B.8 · 任务 1：生产配置切换到 HNSW ef=800 + strict_order，并做端到端延迟分解。

这是整个项目第一个**真实预算锚点** —— B.6/B.7 的延迟都是外推，本轮直接测
    encode_ms   BGE-M3 单条 query 编码（batch=1，线上形态）
    retrieve_ms pgvector 检索（SQL 发出到结果返回）
    e2e_ms      = encode + retrieve（模拟未来 HTTP API 总延迟）

两条臂：
    hnsw800  连接执行 db-conn-init.sql（ef=800 + strict_order），会话级，之后不再设 GUC
    exact    独立连接，禁用索引（EXACT baseline）

全程只读；GUC 只在连接级设置，不改 postgresql.conf。

用法（PowerShell，torch 需要原生 PowerShell）：
  C:/Python314/python.exe -u src/scripts/b8-e2e-experiment.py --run --repeats 3
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import statistics
import sys
import time
from pathlib import Path

SERVER_ROOT = Path(__file__).resolve().parents[2]
CACHE = SERVER_ROOT / ".crawl-cache"
OUT_JSON = CACHE / "_b8-e2e.json"
DEFAULT_QUERIES = "../discover-query-set-v3.json"

WARMUP_ENCODES = 12
REPEATS = 3


def load_b6():
    path = Path(__file__).resolve().parent / "stage-b6-experiment.py"
    spec = importlib.util.spec_from_file_location("stage_b6", path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["stage_b6"] = mod
    if spec.loader is None:
        raise RuntimeError("无法载入 stage-b6-experiment.py")
    spec.loader.exec_module(mod)
    return mod


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


def init_sql_statements() -> list[str]:
    """从 db-conn-init.sql 里取出真正要执行的语句（跳过纯注释块）。"""
    raw = (SERVER_ROOT / "src/scripts/db-conn-init.sql").read_text(encoding="utf-8")
    out = []
    for chunk in raw.split(";"):
        # 去掉整行注释后再判断是否还有内容
        body = "\n".join(
            ln for ln in chunk.splitlines()
            if not ln.lstrip().startswith("--")
        ).strip()
        if body:
            out.append(body)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", action="store_true")
    ap.add_argument("--queries", default=DEFAULT_QUERIES)
    ap.add_argument("--top-k", type=int, default=10)
    ap.add_argument("--repeats", type=int, default=REPEATS)
    args = ap.parse_args()

    root = SERVER_ROOT
    os.chdir(root)
    url = b6.load_env(root)

    def log(m: str = "") -> None:
        print(m, flush=True)

    if not args.run:
        log("dry-run。加 --run 执行。")
        return 0

    import psycopg2

    # ---- 两条连接：一条走 init（生产配置），一条走 EXACT ----
    conn_h = psycopg2.connect(url)
    conn_h.autocommit = False
    cur_h = conn_h.cursor()
    for s in init_sql_statements():
        cur_h.execute(s)
    conn_h.commit()
    cur_h.execute("SELECT NULL::vector")
    cur_h.execute("SHOW hnsw.ef_search")
    ef_now = cur_h.fetchone()[0]
    cur_h.execute("SHOW hnsw.iterative_scan")
    iscan_now = cur_h.fetchone()[0]
    log(f"[HNSW 连接] 已执行 db-conn-init.sql → ef_search={ef_now} iterative_scan={iscan_now}")

    conn_e = psycopg2.connect(url)
    conn_e.autocommit = False
    cur_e = conn_e.cursor()
    for s in ("SET enable_indexscan = off", "SET enable_bitmapscan = off",
              "SET enable_indexonlyscan = off", "SET enable_seqscan = on"):
        cur_e.execute(s)
    conn_e.commit()
    log("[EXACT 连接] 已禁用索引扫描")

    qset = b6.load_query_set(Path(args.queries), root)
    avail = b6.chapter_availability(conn_h)
    blocked = {bid for bid, n in avail.items() if n == 0}
    sql = b6.search_sql(True, args.top_k)

    ev = b6.load_eval_module()
    log("加载本地 BGE-M3（离线）…")
    model = ev.load_model()
    for _ in range(WARMUP_ENCODES):       # warmup：丢弃，不计入统计
        ev.encode(model, "warmup")
    log(f"模型就绪，warmup {WARMUP_ENCODES} 次已丢弃")

    # ------------------------------------------------------------------
    # ⚠ 方法论修正（第一版踩的坑）：
    #   第一版是「每条 query 交错跑 encode + 3 次 EXACT 扫描」。EXACT 每次扫 808MB，
    #   会把 BGE-M3 的模型页挤出页缓存，导致 encode 从 ~91ms 劣化到 ~278ms，
    #   连 HNSW 检索也被拖慢。两组数字互相污染，不能当预算锚点。
    #   本版改为**隔离分段**：先一口气编码完（不碰库），再单独跑 HNSW 段、EXACT 段。
    #   第一版的交错结果保留在 _b8-e2e-interleaved.json，作为「交叉污染」对照证据。
    # ------------------------------------------------------------------
    items = []
    for row in qset["rows"]:
        if not row.get("counted", True):
            continue
        ids = [int(row["book_id"])] if row.get("book_id") else \
            b6.book_ids_for_title(conn_h, row["expected_book"])
        if ids and all(i in blocked for i in ids):
            continue
        items.append(row)
    log(f"计入分母的 query：{len(items)} 条")

    t_start = time.time()

    # ---- 段 0：编码（不碰库，纯净测量）----
    log("段 0/2：编码 100 条（不触碰数据库）…")
    for it in items:
        t0 = time.perf_counter()
        it["literal"] = ev.encode(model, it["query"])
        it["encode_ms"] = (time.perf_counter() - t0) * 1000
    log(f"  编码完成，用时 {time.time()-t_start:.0f}s")
    del model            # 立刻释放，避免后续检索段受模型内存挤压
    import gc
    gc.collect()

    # 向量缓存：给 regression-check.py 复用（它不该每次加载 2GB 模型）
    vec_cache = {it["query_id"]: it["literal"] for it in items}
    (CACHE / "_b8-query-vectors.json").write_text(
        json.dumps(vec_cache, ensure_ascii=False), encoding="utf-8")
    log(f"  向量缓存已写入 .crawl-cache/_b8-query-vectors.json（{len(vec_cache)} 条）")

    def hits(rs, expected):
        titles = [r[1] or "" for r in rs]
        return {
            "top1": any(expected in t.lower() for t in titles[:1]),
            "top3": any(expected in t.lower() for t in titles[:3]),
            "top10": any(expected in t.lower() for t in titles[:10]),
            "n": len(rs),
        }

    # ---- 段 1：HNSW（生产配置）----
    t1 = time.time()
    log("段 1/2：HNSW ef=800 + strict_order 检索…")
    for it in items:
        samples, rows_h = [], []
        for _ in range(args.repeats):
            t0 = time.perf_counter()
            cur_h.execute(sql, (it["literal"], it["literal"]))
            rows_h = cur_h.fetchall()
            conn_h.commit()
            samples.append((time.perf_counter() - t0) * 1000)
        it["retrieve_ms"] = statistics.median(samples)
        it["h"] = hits(rows_h, it["expected_book"].lower())
    log(f"  完成，用时 {time.time()-t1:.0f}s")

    # ---- 段 2：EXACT ----
    t2 = time.time()
    log("段 2/2：EXACT 检索（最慢的一段）…")
    for it in items:
        samples, rows_e = [], []
        for _ in range(args.repeats):
            t0 = time.perf_counter()
            cur_e.execute(sql, (it["literal"], it["literal"]))
            rows_e = cur_e.fetchall()
            conn_e.commit()
            samples.append((time.perf_counter() - t0) * 1000)
        it["exact_retrieve_ms"] = statistics.median(samples)
        it["e"] = hits(rows_e, it["expected_book"].lower())
    log(f"  完成，用时 {time.time()-t2:.0f}s")

    rows_out = []
    for it in items:
        rows_out.append({
            "query_id": it["query_id"],
            "category": it.get("category"),
            "query_chars": len(it["query"]),
            "encode_ms": round(it["encode_ms"], 2),
            "retrieve_ms": round(it["retrieve_ms"], 2),
            "e2e_ms": round(it["encode_ms"] + it["retrieve_ms"], 2),
            "exact_retrieve_ms": round(it["exact_retrieve_ms"], 2),
            "exact_e2e_ms": round(it["encode_ms"] + it["exact_retrieve_ms"], 2),
            "hit_top1": it["h"]["top1"], "hit_top3": it["h"]["top3"],
            "hit_top10": it["h"]["top10"], "rows_returned": it["h"]["n"],
            "exact_hit_top1": it["e"]["top1"], "exact_hit_top10": it["e"]["top10"],
            "exact_rows_returned": it["e"]["n"],
        })

    log(f"三段完成，总用时 {(time.time()-t_start)/60:.1f} 分钟")

    def agg(key: str) -> dict:
        v = [r[key] for r in rows_out]
        return {"p50": round(pct(v, 0.50), 2), "p95": round(pct(v, 0.95), 2),
                "p99": round(pct(v, 0.99), 2), "mean": round(statistics.fmean(v), 2),
                "max": round(max(v), 2), "min": round(min(v), 2)}

    denom = len(rows_out)
    payload = {
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "config": {
            "top_k": args.top_k,
            "repeats_per_retrieve": args.repeats,
            "retrieve_stat": "median",
            "warmup_encodes_discarded": WARMUP_ENCODES,
            "hnsw_arm": f"ef_search={ef_now}, iterative_scan={iscan_now}（连接级，来自 db-conn-init.sql）",
            "exact_arm": "enable_indexscan/bitmapscan/indexonlyscan = off",
            "filter": "chapter_title IS NOT NULL",
            "queries_file": args.queries,
            "methodology": (
                "隔离分段：段0 编码（不碰库）→ 段1 HNSW → 段2 EXACT。"
                "第一版交错测量已被废弃（EXACT 的 808MB 扫描会把模型挤出页缓存，"
                "encode 从 ~91ms 劣化到 ~278ms），保留在 _b8-e2e-interleaved.json 作对照。"
            ),
            "note": "编码段模型常驻；检索段已释放模型（gc.collect），避免内存挤压污染检索延迟",
        },
        "denominator": denom,
        "recall": {
            "top1": sum(1 for r in rows_out if r["hit_top1"]),
            "top3": sum(1 for r in rows_out if r["hit_top3"]),
            "top10": sum(1 for r in rows_out if r["hit_top10"]),
            "starved": sum(1 for r in rows_out if r["rows_returned"] == 0),
            "underfilled": sum(1 for r in rows_out if 0 < r["rows_returned"] < args.top_k),
            "exact_top1": sum(1 for r in rows_out if r["exact_hit_top1"]),
            "exact_top10": sum(1 for r in rows_out if r["exact_hit_top10"]),
        },
        "latency": {
            "encode_ms": agg("encode_ms"),
            "retrieve_ms": agg("retrieve_ms"),
            "e2e_ms": agg("e2e_ms"),
            "exact_retrieve_ms": agg("exact_retrieve_ms"),
            "exact_e2e_ms": agg("exact_e2e_ms"),
        },
        "per_query": rows_out,
    }
    CACHE.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    L = payload["latency"]
    log("")
    log(f"{'':<18}{'P50':>10}{'P95':>10}{'P99':>10}")
    for k in ("encode_ms", "retrieve_ms", "e2e_ms", "exact_retrieve_ms", "exact_e2e_ms"):
        a = L[k]
        log(f"{k:<18}{a['p50']:>10}{a['p95']:>10}{a['p99']:>10}")
    log("")
    log(f"Recall(ef800): Top1 {payload['recall']['top1']}/{denom}  "
        f"Top10 {payload['recall']['top10']}/{denom}  "
        f"0行 {payload['recall']['starved']}  不足 {payload['recall']['underfilled']}")
    log(f"Recall(EXACT): Top1 {payload['recall']['exact_top1']}/{denom}  "
        f"Top10 {payload['recall']['exact_top10']}/{denom}")
    log(f"\n写入 {OUT_JSON}")

    cur_h.close(); conn_h.close(); cur_e.close(); conn_e.close()
    return 0


if __name__ == "__main__":
    b6 = load_b6()
    raise SystemExit(main())
