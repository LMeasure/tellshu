# -*- coding: utf-8 -*-
"""
b9-http-benchmark.py —— B.9 任务 1 的 HTTP 端验收脚本

干什么：
  1. 先打 warmup 请求（丢弃）—— 首次请求含模型权重分页、线程池初始化、连接预热，
     不丢掉的话拿到的不是稳态数字（B.8 的 e2e 实验同样丢弃了 12 次 warmup 编码）。
  2. 取 discover-query-set-v3.json 前 N=20 条 counted query，逐条 POST /api/discover。
  3. 同时记录：
       client_ms   客户端测到的 HTTP 往返总时间
       e2e_ms      服务端自报的 encode + retrieve
       ⇒ 两者相减 = HTTP 开销（传输 + JSON 序列化 + 路由分发）
  4. 输出 P50 / P95 / P99 / mean / max，并与 B.8 基线（e2e P50 168.19 / P95 228.20）对照。

用法（服务已在 127.0.0.1:8000 跑起来之后）：
  C:/Python314/python.exe -u api/b9-http-benchmark.py --run
  C:/Python314/python.exe -u api/b9-http-benchmark.py --run --n 20 --warmup 8 --base http://127.0.0.1:8000
"""
from __future__ import annotations

import argparse
import json
import statistics
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
QUERIES = ROOT / "discover-query-set-v3.json"
CACHE = ROOT / "server" / ".crawl-cache"
OUT_JSON = CACHE / "_b9-http-bench.json"

# B.8 实测基线（server/src/scripts/b8-e2e-experiment.py，隔离分段，100 条）
B8_BASELINE = {
    "encode_ms": {"p50": 154.74, "p95": 199.67},
    "retrieve_ms": {"p50": 12.09, "p95": 35.68},
    "e2e_ms": {"p50": 168.19, "p95": 228.20},
}

WARMUP_QUERIES = [
    "warmup",
    "a young man inherits a fortune",
    "两个人之间的爱情故事",
    "a shipwreck on a desert island",
    "谋杀案的调查过程",
]


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
        "min": round(min(vals), 2) if vals else 0.0,
    }


def post(base: str, query: str, top_k: int) -> tuple[dict, float]:
    payload = json.dumps({"query": query, "top_k": top_k}).encode("utf-8")
    req = urllib.request.Request(
        base.rstrip("/") + "/api/discover",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    t0 = time.perf_counter()
    with urllib.request.urlopen(req, timeout=120) as resp:
        body = json.loads(resp.read().decode("utf-8"))
    return body, (time.perf_counter() - t0) * 1000


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", action="store_true")
    ap.add_argument("--base", default="http://127.0.0.1:8000")
    ap.add_argument("--n", type=int, default=20, help="取前 N 条 counted query")
    ap.add_argument("--top-k", type=int, default=10)
    ap.add_argument("--warmup", type=int, default=8, help="warmup 请求数（丢弃，不统计）")
    ap.add_argument(
        "--out",
        default=None,
        help="输出路径；默认 _b9-http-bench.json。"
             "B.11 用 --out server/.crawl-cache/_b11-http-bench-onnx.json，避免覆盖 B.9 基线",
    )
    args = ap.parse_args()

    if not args.run:
        print("dry-run。加 --run 执行。")
        return 0

    qset = json.loads(QUERIES.read_text(encoding="utf-8"))
    counted = [q for q in qset.get("queries", []) if q.get("counted")]
    picked = counted[: args.n]
    print(f"查询集：{len(picked)} 条（取自 discover-query-set-v3.json 前 {args.n} 条 counted）")

    # ---- warmup（丢弃）----
    print(f"warmup {args.warmup} 次（丢弃）…", flush=True)
    for i in range(args.warmup):
        _, ms = post(args.base, WARMUP_QUERIES[i % len(WARMUP_QUERIES)], args.top_k)
        print(f"   warmup {i+1}/{args.warmup}: {ms:.0f} ms", flush=True)

    # ---- 正式测量 ----
    print("正式测量…", flush=True)
    rows = []
    for q in picked:
        body, client_ms = post(args.base, q["query"], args.top_k)
        lat = body.get("latency", {})
        results = body.get("results", [])
        top1 = results[0]["title"] if results else None
        rows.append({
            "query_id": q["query_id"],
            "query": q["query"],
            "expected_book": q.get("expected_book"),
            "top1": top1,
            "hit_top1": bool(top1 and q.get("expected_book", "").lower() in top1.lower()),
            "returned": len(results),
            "client_ms": round(client_ms, 2),
            "encode_ms": lat.get("encode_ms"),
            "retrieve_ms": lat.get("retrieve_ms"),
            "e2e_ms": lat.get("e2e_ms"),
            "http_overhead_ms": round(client_ms - lat.get("e2e_ms", 0), 2),
        })
        print(f"   {q['query_id']} {rows[-1]['returned']:>2} 行  "
              f"client={client_ms:>7.1f} encode={lat.get('encode_ms',0):>7.1f} "
              f"retrieve={lat.get('retrieve_ms',0):>6.1f} overhead={rows[-1]['http_overhead_ms']:>6.1f}  "
              f"{'✅' if rows[-1]['hit_top1'] else '❌'} {top1}", flush=True)

    def col(k: str) -> list[float]:
        return [r[k] for r in rows if r[k] is not None]

    summary = {
        "client_ms": agg(col("client_ms")),
        "encode_ms": agg(col("encode_ms")),
        "retrieve_ms": agg(col("retrieve_ms")),
        "e2e_ms": agg(col("e2e_ms")),
        "http_overhead_ms": agg(col("http_overhead_ms")),
    }
    empty = [r for r in rows if r["returned"] == 0]
    under8 = [r for r in rows if r["returned"] < 8]

    out = {
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "config": {
            "base": args.base, "n": args.n, "top_k": args.top_k,
            "warmup_discarded": args.warmup,
        },
        "summary": summary,
        "b8_baseline": B8_BASELINE,
        "acceptance": {
            "results_ge_8": len(rows) - len(under8),
            "queries_total": len(rows),
            "empty_results": len(empty),
            "under_8_results": len(under8),
            "e2e_p50_ms": summary["e2e_ms"]["p50"],
            "e2e_p50_within_200ms": summary["e2e_ms"]["p50"] <= 200,
            "http_overhead_p50_ms": summary["http_overhead_ms"]["p50"],
            "http_overhead_within_10ms": summary["http_overhead_ms"]["p50"] < 10,
        },
        "recall": {"top1": sum(1 for r in rows if r["hit_top1"]), "denominator": len(rows)},
        "per_query": rows,
    }
    CACHE.mkdir(parents=True, exist_ok=True)
    out_path = Path(args.out) if args.out else OUT_JSON
    out_path.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")

    print()
    print(f"{'':<18}{'P50':>10}{'P95':>10}{'P99':>10}{'max':>10}")
    for k in ("client_ms", "encode_ms", "retrieve_ms", "e2e_ms", "http_overhead_ms"):
        a = summary[k]
        print(f"{k:<18}{a['p50']:>10}{a['p95']:>10}{a['p99']:>10}{a['max']:>10}")
    print()
    print(f"B.8 基线（进程内，无 HTTP）：e2e P50 {B8_BASELINE['e2e_ms']['p50']} / "
          f"P95 {B8_BASELINE['e2e_ms']['p95']}")
    print(f"本轮（HTTP）：              e2e P50 {summary['e2e_ms']['p50']} / "
          f"P95 {summary['e2e_ms']['p95']}")
    print(f"HTTP 开销 P50 = {summary['http_overhead_ms']['p50']} ms")
    print()
    print(f"验收：返回 ≥8 行 {out['acceptance']['results_ge_8']}/{len(rows)}，"
          f"空结果 {len(empty)}，Top1 命中 {out['recall']['top1']}/{len(rows)}")
    print(f"写入 {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
