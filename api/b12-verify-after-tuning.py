#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
b12-verify-after-tuning.py —— 调完 shared_buffers 重启后，**一条命令**拿前后对照

为什么单独一个脚本：调优这件事的正确顺序是「改配置 → 重启 → 立刻量」。
重启后如果还要现去找压测脚本、现翻 B.11 报告里的基线数字，中间的时间差会让
「OS 页缓存也跟着热了」这种干扰混进来。这个脚本把三件事合成一次调用：
    1. 直接查 PG 的 shared_buffers（确认改动真的生效了）
    2. 跑一次 HTTP 压测（同口径：8 次 warmup + 20 条 counted query）
    3. 与 B.11 基线并列打印，并给出「retrieve 是否 ≤15ms」的判定

只读：不改任何配置、不写业务表，产物只落在 server/.crawl-cache/。

用法（API 已在 127.0.0.1:8000 跑起来之后）：
    C:/Python314/python.exe -u api/b12-verify-after-tuning.py
    C:/Python314/python.exe -u api/b12-verify-after-tuning.py --with-regression   # 附带全量回归（+90s）
    C:/Python314/python.exe -u api/b12-verify-after-tuning.py --base http://127.0.0.1:8000
"""
from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from b11_common import CACHE, ROOT, connect, pct  # noqa: E402

QUERIES = ROOT / "discover-query-set-v3.json"
BASELINE_FILE = CACHE / "_b11-http-bench-onnx.json"
WARMUP_QUERIES = [
    "warmup",
    "a young man inherits a fortune",
    "两个人之间的爱情故事",
    "a shipwreck on a desert island",
    "a detective investigates a murder",
    "一个关于成长与失去的故事",
    "two families feud in a small town",
    "a journey across a strange land",
]

# B.11 最终配置的实测值（ONNX 逐通道 + shared_buffers=128MB）
B11_BASELINE = {"encode_ms": 21.01, "retrieve_ms": 30.80, "e2e_ms": 52.02}
TARGET_RETRIEVE_MS = 15.0


def log(msg: str) -> None:
    print(msg, flush=True)


def post(base: str, text: str, top_k: int) -> tuple[dict, float]:
    payload = json.dumps({"query": text, "top_k": top_k}).encode("utf-8")
    req = urllib.request.Request(
        base + "/api/discover", data=payload,
        headers={"Content-Type": "application/json"}, method="POST",
    )
    t0 = time.perf_counter()
    with urllib.request.urlopen(req, timeout=60) as resp:
        body = json.loads(resp.read().decode("utf-8"))
    return body, (time.perf_counter() - t0) * 1000


def show_pg_settings() -> None:
    """用 SHOW 直接拿人类可读值。

    别用 pg_settings.setting 自己换算 —— 它给的 unit 是 '8kB'，还要乘；
    也别用 pg_settings_get_value_bytes()，本机 PG 18.6 里没有这个函数（实测报
    UndefinedFunction）。SHOW 返回的就是 '128MB' / '2GB' 这种，够用且不会算错。
    """
    conn = connect()
    cur = conn.cursor()
    log("── PG 当前设置 ──")
    for name in ("shared_buffers", "effective_cache_size"):
        cur.execute(f"SHOW {name};")
        log(f"  {name:<22} = {cur.fetchone()[0]}")
    conn.close()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:8000")
    ap.add_argument("--n", type=int, default=20)
    ap.add_argument("--warmup", type=int, default=8)
    ap.add_argument("--top-k", type=int, default=10)
    ap.add_argument("--with-regression", action="store_true")
    args = ap.parse_args()

    show_pg_settings()

    qset = json.loads(QUERIES.read_text(encoding="utf-8"))
    picked = [q for q in qset.get("queries", []) if q.get("counted")][: args.n]

    log(f"\n── warmup {args.warmup} 次（丢弃）──")
    for i in range(args.warmup):
        _, ms = post(args.base, WARMUP_QUERIES[i % len(WARMUP_QUERIES)], args.top_k)
        log(f"   warmup {i + 1}/{args.warmup}: {ms:.0f} ms")

    log(f"\n── 正式测量 {len(picked)} 条 ──")
    enc, ret, e2e, client = [], [], [], []
    empty = 0
    ge8 = 0
    for q in picked:
        body, cms = post(args.base, q["query"], args.top_k)
        lat = body.get("latency", {})
        client.append(cms)
        enc.append(lat.get("encode_ms") or 0)
        ret.append(lat.get("retrieve_ms") or 0)
        e2e.append(lat.get("e2e_ms") or 0)
        n = len(body.get("results", []))
        if n == 0:
            empty += 1
        if n >= 8:
            ge8 += 1

    def s(xs: list[float]) -> dict[str, float]:
        return {
            "p50": round(pct(xs, 0.50), 2),
            "p95": round(pct(xs, 0.95), 2),
            "mean": round(statistics.fmean(xs), 2),
            "max": round(max(xs), 2),
        }

    now = {"encode_ms": s(enc), "retrieve_ms": s(ret), "e2e_ms": s(e2e), "client_ms": s(client)}
    base = B11_BASELINE
    if BASELINE_FILE.exists():
        b = json.loads(BASELINE_FILE.read_text(encoding="utf-8")).get("summary", {})
        base = {k: (b.get(k, {}) or {}).get("p50") for k in ("encode_ms", "retrieve_ms", "e2e_ms")}
        base = {k: v for k, v in base.items() if v is not None} or B11_BASELINE

    log("\n── 前后对照（P50, ms）──")
    log(f"  {'指标':<14}{'B.11(128MB)':>13}{'现在':>11}{'变化':>12}")
    for k in ("encode_ms", "retrieve_ms", "e2e_ms", "client_ms"):
        b = base.get(k)
        a = now[k]["p50"]
        if b is None:
            log(f"  {k:<14}{'—':>13}{a:>11.2f}{'—':>12}")
        else:
            delta = f"{(a - b) / b * 100:+.1f}%"
            log(f"  {k:<14}{b:>13.2f}{a:>11.2f}{delta:>12}")

    log(f"\n  返回 ≥8 行 {ge8}/{len(picked)}，空结果 {empty}")
    r50 = now["retrieve_ms"]["p50"]
    verdict = "✅ 达标" if r50 <= TARGET_RETRIEVE_MS else f"❌ 未达标（目标 ≤{TARGET_RETRIEVE_MS}ms）"
    log(f"\n  判定：retrieve P50 = {r50:.2f} ms  {verdict}")
    log("  ⚠ 口径：这是「首次触碰」口径；回归端点的 HNSW 是「每条 3 次取后 2 次」热态口径，别互相替代。")

    out = {
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "stage": "b12-after-tuning",
        "summary": now,
        "baseline_b11": base,
        "target_retrieve_ms": TARGET_RETRIEVE_MS,
        "retrieve_target_hit": r50 <= TARGET_RETRIEVE_MS,
        "results_ge_8": ge8,
        "empty_results": empty,
        "sample": len(picked),
    }
    dst = CACHE / "_b12-http-bench-after-tuning.json"
    dst.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    log(f"\n已存：{dst}")

    if args.with_regression:
        log("\n── 全量回归（约 90 秒）──")
        with urllib.request.urlopen(
            args.base + "/api/discover/regression?sample=100", timeout=900
        ) as resp:
            reg = json.loads(resp.read().decode("utf-8"))
        (CACHE / "_b12-regression-after-tuning.json").write_text(
            json.dumps(reg, ensure_ascii=False, indent=1), encoding="utf-8"
        )
        log(f"  HNSW P50 = {reg.get('hnsw_p50_ms')} ms（热态口径）  "
            f"EXACT P50 = {reg.get('exact_p50_ms')} ms  状态 = {reg.get('status')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
