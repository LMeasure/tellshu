# -*- coding: utf-8 -*-
"""
b10-isolation-experiment.py —— B.10 任务 1：三臂隔离实验

要回答的问题很简单但很关键：
    189 ms 的 retrieve 里，有多少是「可以消掉的共置污染」，有多少是「检索本身的真实冷态开销」。

三臂：
    A 共置   编码在 API 进程内（BGE-M3 2GB 常驻），即 B.9 的形态
    B 隔离   编码在独立进程 embed_server(:8001)，API 进程只做 HTTP 调用
    C 预热   同 B，但每条 query 前先用缓存向量跑一次 retrieve-only，
             把 PG 页缓存人工热起来，模拟「PG 不被编码污染时的生产态」
    D 共置+预热（B.10 中途追加的定案臂）
             同 A（编码在 API 进程内），但每条 query 前也预热。
             作用：若 D 的 retrieve 也回到 ~9ms，就说明「慢」来自页缓存冷缺失，
             与编码在哪个进程无关 —— 直接证伪共置污染假设。
             反过来若只有 C 快、D 仍慢，则共置污染成立。

顺序效应（B.9 翻过的车）：
    同一进程内先跑的臂会吸收冷启动代价。本次改为**两轮交替**：
        轮 1: A → B → C
        轮 2: B → A → C
    每臂开始前都有 8 条 warmup（丢弃），尽量标准化起始状态。
    ⚠ 仍无法重置 OS page cache（需要重启 PG 或专门工具），残余影响按保守理解。

用法：
    cd <root>
    C:/Python314/python.exe -u api/b10-isolation-experiment.py --arm A --base http://127.0.0.1:8000 --round 1
    C:/Python314/python.exe -u api/b10-isolation-experiment.py --arm B --base http://127.0.0.1:8002 --round 1
    C:/Python314/python.exe -u api/b10-isolation-experiment.py --arm C --base http://127.0.0.1:8002 --round 1 --prewarm
"""
from __future__ import annotations

import argparse
import ctypes
import json
import statistics
import time
import urllib.request
from ctypes import wintypes
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "server" / ".crawl-cache"
QUERIES = ROOT / "discover-query-set-v3.json"
VECTORS = CACHE / "_b8-query-vectors.json"
INIT_SQL = ROOT / "server" / "src" / "scripts" / "db-conn-init.sql"

N_DEFAULT = 40
WARMUP_DEFAULT = 8


# --------------------------------------------------------------------------- 内存
class MEMORYSTATUSEX(ctypes.Structure):
    _fields_ = [
        ("dwLength", wintypes.DWORD),
        ("dwMemoryLoad", wintypes.DWORD),
        ("ullTotalPhys", ctypes.c_ulonglong),
        ("ullAvailPhys", ctypes.c_ulonglong),
        ("ullTotalPageFile", ctypes.c_ulonglong),
        ("ullAvailPageFile", ctypes.c_ulonglong),
        ("ullTotalVirtual", ctypes.c_ulonglong),
        ("ullAvailVirtual", ctypes.c_ulonglong),
        ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
    ]


def mem_snapshot() -> dict[str, Any]:
    """采样物理内存（Windows）。每臂前后各采一次，确认各臂的内存起点可比。"""
    st = MEMORYSTATUSEX()
    st.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
    ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(st))
    return {
        "load_pct": int(st.dwMemoryLoad),
        "avail_mb": round(st.ullAvailPhys / 1024 / 1024),
        "total_mb": round(st.ullTotalPhys / 1024 / 1024),
    }


# --------------------------------------------------------------------------- 统计
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


def agg(vals: list[float]) -> dict[str, float]:
    return {
        "p50": round(pct(vals, 0.50), 2),
        "p95": round(pct(vals, 0.95), 2),
        "p99": round(pct(vals, 0.99), 2),
        "mean": round(statistics.fmean(vals), 2) if vals else 0.0,
        "max": round(max(vals), 2) if vals else 0.0,
    }


# --------------------------------------------------------------------------- HTTP
def post(base: str, path: str, payload: dict) -> tuple[dict, float]:
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        base.rstrip("/") + path, data=data,
        headers={"Content-Type": "application/json"}, method="POST",
    )
    t0 = time.perf_counter()
    with urllib.request.urlopen(req, timeout=120) as resp:
        body = json.loads(resp.read().decode("utf-8"))
    return body, (time.perf_counter() - t0) * 1000


# --------------------------------------------------------------------------- 预热（臂 C）
class Prewarmer:
    """臂 C：用缓存向量直连 PG 跑一次检索，把页缓存热起来。

    不走 HTTP，因为预热的目标就是 PG 侧的页缓存，多一层 HTTP 没有意义。
    用**独立连接**（执行 db-conn-init.sql），不碰 API 的连接池。
    """

    def __init__(self, dsn: str, top_k: int):
        import psycopg2

        self.conn = psycopg2.connect(dsn)
        self.conn.autocommit = False
        cur = self.conn.cursor()
        raw = INIT_SQL.read_text(encoding="utf-8")
        for chunk in raw.split(";"):
            body = "\n".join(
                ln for ln in chunk.splitlines() if not ln.lstrip().startswith("--")
            ).strip()
            if body:
                cur.execute(body)
        self.conn.commit()
        self.sql = (
            "SELECT c.id, b.title, c.chunk_index, c.chapter_title, "
            "1 - (c.embedding <=> %s::vector) AS similarity "
            "FROM discovered_book_chunks c JOIN discovered_books b ON b.id = c.book_id "
            "WHERE c.embedding IS NOT NULL AND c.chapter_title IS NOT NULL "
            "ORDER BY c.embedding <=> %s::vector LIMIT %s"
        )
        self.top_k = top_k

    def warm(self, literal: str) -> float:
        cur = self.conn.cursor()
        t0 = time.perf_counter()
        cur.execute(self.sql, (literal, literal, self.top_k))
        cur.fetchall()
        self.conn.commit()
        cur.close()
        return (time.perf_counter() - t0) * 1000

    def close(self) -> None:
        self.conn.close()


def load_dsn() -> str:
    for line in (ROOT / "server" / ".env").read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if s.startswith("DATABASE_URL="):
            return s.partition("=")[2].strip().strip("'\"")
    raise RuntimeError("server/.env 里没有 DATABASE_URL")


# --------------------------------------------------------------------------- 主流程
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--arm", required=True, choices=["A", "B", "C", "D"])
    ap.add_argument("--base", required=True, help="API 基址，如 http://127.0.0.1:8000")
    ap.add_argument("--n", type=int, default=N_DEFAULT)
    ap.add_argument("--top-k", type=int, default=10)
    ap.add_argument("--warmup", type=int, default=WARMUP_DEFAULT)
    ap.add_argument("--round", type=int, default=1)
    ap.add_argument("--prewarm", action="store_true", help="臂 C：每条 query 前先预热 PG 页缓存")
    args = ap.parse_args()

    if args.arm in ("C", "D") and not args.prewarm:
        print(f"⚠ 臂 {args.arm} 必须带 --prewarm，否则 C 与 B、D 与 A 无差别。")
        return 2

    qset = json.loads(QUERIES.read_text(encoding="utf-8"))
    counted = [q for q in qset.get("queries", []) if q.get("counted")]
    picked = counted[: args.n]
    vecs = json.loads(VECTORS.read_text(encoding="utf-8")) if VECTORS.exists() else {}
    print(f"臂 {args.arm}（轮 {args.round}）· base={args.base} · {len(picked)} 条 query · "
          f"warmup {args.warmup} 丢弃 · prewarm={args.prewarm}")

    warmer = None
    if args.prewarm:
        warmer = Prewarmer(load_dsn(), args.top_k)
        print("预热器已就绪（直连 PG，独立连接）")

    mem_before = mem_snapshot()
    print(f"内存（臂前）：可用 {mem_before['avail_mb']} MB / 负载 {mem_before['load_pct']}%")

    # ---- warmup（丢弃）----
    for i in range(args.warmup):
        q = picked[i % len(picked)]
        if warmer and q["query_id"] in vecs:
            warmer.warm(vecs[q["query_id"]])
        post(args.base, "/api/discover", {"query": q["query"], "top_k": args.top_k})
    print(f"warmup {args.warmup} 条已丢弃")

    # ---- 正式测量 ----
    rows: list[dict[str, Any]] = []
    for q in picked:
        prewarm_ms = None
        if warmer and q["query_id"] in vecs:
            prewarm_ms = round(warmer.warm(vecs[q["query_id"]]), 2)
        body, client_ms = post(args.base, "/api/discover",
                               {"query": q["query"], "top_k": args.top_k})
        lat = body.get("latency", {})
        results = body.get("results", [])
        rows.append({
            "query_id": q["query_id"],
            "expected_book": q.get("expected_book"),
            "top1": results[0]["title"] if results else None,
            "returned": len(results),
            "prewarm_ms": prewarm_ms,
            "client_ms": round(client_ms, 2),
            "encode_ms": lat.get("encode_ms"),
            "retrieve_ms": lat.get("retrieve_ms"),
            "e2e_ms": lat.get("e2e_ms"),
            "http_overhead_ms": round(client_ms - lat.get("e2e_ms", 0), 2),
        })
        print(f"   {q['query_id']} {rows[-1]['returned']:>2}行 "
              f"client={client_ms:>7.1f} enc={lat.get('encode_ms',0):>7.1f} "
              f"ret={lat.get('retrieve_ms',0):>7.1f} "
              f"pre={prewarm_ms if prewarm_ms is not None else 0:>7.1f}", flush=True)

    mem_after = mem_snapshot()
    if warmer:
        warmer.close()

    def col(k: str) -> list[float]:
        return [r[k] for r in rows if r[k] is not None]

    summary = {k: agg(col(k)) for k in
               ("client_ms", "encode_ms", "retrieve_ms", "e2e_ms", "http_overhead_ms")}
    if warmer:
        summary["prewarm_ms"] = agg(col("prewarm_ms"))

    out = {
        "arm": args.arm,
        "round": args.round,
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "config": {"base": args.base, "n": len(rows), "top_k": args.top_k,
                   "warmup_discarded": args.warmup, "prewarm": bool(warmer)},
        "memory": {"before": mem_before, "after": mem_after},
        "summary": summary,
        "recall": {"top1": sum(1 for r in rows if r["top1"] and
                               r["expected_book"].lower() in r["top1"].lower()),
                   "denominator": len(rows)},
        "empty_results": sum(1 for r in rows if r["returned"] == 0),
        "per_query": rows,
    }
    name = f"_b10-arm-{args.arm}-r{args.round}.json"
    CACHE.mkdir(parents=True, exist_ok=True)
    (CACHE / name).write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")

    print()
    print(f"{'':<18}{'P50':>10}{'P95':>10}{'max':>10}")
    for k in ("encode_ms", "retrieve_ms", "e2e_ms", "http_overhead_ms"):
        a = summary.get(k, {})
        print(f"{k:<18}{a.get('p50','-'):>10}{a.get('p95','-'):>10}{a.get('max','-'):>10}")
    print(f"\n内存（臂后）：可用 {mem_after['avail_mb']} MB / 负载 {mem_after['load_pct']}%")
    print(f"空结果 {out['empty_results']} · Top1 {out['recall']['top1']}/{out['recall']['denominator']}")
    print(f"写入 {CACHE / name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
