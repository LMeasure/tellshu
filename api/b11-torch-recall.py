#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
b11-torch-recall.py —— B.11：torch（现有生产后端）的召回**配对基线**

为什么必须现跑一遍基线，而不是直接引用 B.6/B.8 的 49/100：
    McNemar 是**配对检验**，需要逐条 query 的命中/未命中结果一一对应。
    只比较两个总数（49 vs 47）做不出显著性判断 —— 可能 49→47 是同一批 query 翻了 2 条，
    也可能是翻了 10 条又捞回 8 条，后者风险大得多。所以基线与实验组必须同一批 query、
    同一条检索 SQL、同一套 GUC，只是编码引擎不同。

必须在**原生 PowerShell** 里跑（Git Bash/MSYS 下 import torch 会 SIGSEGV/139）。

用法：
    C:/Python314/python.exe api/b11-torch-recall.py
    C:/Python314/python.exe api/b11-torch-recall.py --limit 100
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from b11_common import (  # noqa: E402
    CACHE,
    hit,
    load_counted_queries,
    mem_snapshot,
    pct,
    search_once,
    to_literal,
)

MODEL_NAME = os.environ.get("EMBED_MODEL", "BAAI/bge-m3")


def log(msg: str) -> None:
    print(f"[ .. ] {msg}", flush=True)


def main() -> int:
    ap = argparse.ArgumentParser(description="B.11 torch 召回配对基线")
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--explain-every", type=int, default=10)
    args = ap.parse_args()

    import numpy as np
    from sentence_transformers import SentenceTransformer

    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    log(f"起始内存：{mem_snapshot()}")
    t0 = time.perf_counter()
    model = SentenceTransformer(MODEL_NAME, local_files_only=True)
    load_ms = (time.perf_counter() - t0) * 1000
    log(f"torch 模型已加载：{load_ms:.0f} ms  内存={mem_snapshot()}")

    rows = load_counted_queries(args.limit)
    from b11_common import connect

    conn = connect()
    log(f"数据库连接已建立；召回条数={len(rows)}")

    # 预热（不计入）
    _ = np.asarray(model.encode([rows[0]["query"]], normalize_embeddings=True, convert_to_numpy=True))[0]

    per: list[dict[str, Any]] = []
    enc_lat: list[float] = []
    ret_lat: list[float] = []
    for i, row in enumerate(rows, start=1):
        expected = row["expected_book"]
        t1 = time.perf_counter()
        vec = np.asarray(
            model.encode([row["query"]], normalize_embeddings=True, convert_to_numpy=True)
        )[0]
        enc_ms = (time.perf_counter() - t1) * 1000
        enc_lat.append(enc_ms)
        qrows, wall_ms, plan = search_once(
            conn, to_literal(vec), 10, explain=(i % args.explain_every == 1)
        )
        ret_lat.append(wall_ms)
        titles = [r[2] for r in qrows]
        per.append({
            "query_id": row["query_id"],
            "query": row["query"],
            "expected": expected,
            "top1": titles[0] if titles else None,
            "top1_score": round(float(qrows[0][7]), 4) if qrows else None,
            "hit_top1": hit(expected, titles[0]) if titles else False,
            "hit_top10": any(hit(expected, t) for t in titles),
            "rows_returned": len(qrows),
            "encode_ms": round(enc_ms, 2),
            "retrieve_ms": round(wall_ms, 2),
            "plan_path": plan["path"],
            "plan_index": plan["index"],
            "shared_read": plan["shared_read"],
            "shared_hit": plan["shared_hit"],
        })
        if i % 10 == 0:
            log(
                f"  {i}/{len(rows)}  累计 Top1={sum(1 for p in per if p['hit_top1'])}  "
                f"retrieve P50={pct(ret_lat, 0.5):.1f} ms  可用={mem_snapshot()['avail_gb']} GB"
            )
    conn.close()

    denom = len(per)
    h1 = sum(1 for p in per if p["hit_top1"])
    h10 = sum(1 for p in per if p["hit_top10"])
    paths: dict[str, int] = {}
    for p in per:
        paths[p["plan_path"] or "?"] = paths.get(p["plan_path"] or "?", 0) + 1
    out = {
        "stage": "recall",
        "engine": "torch",
        "backend": "torch(sentence-transformers) FP32 —— 现有生产口径",
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "denominator": denom,
        "top_k": 10,
        "retrieval": "HNSW ef=800 + iterative_scan=strict_order + 排除 front matter",
        "model_load_ms": round(load_ms, 1),
        "top1_hits": h1,
        "top10_hits": h10,
        "starved": sum(1 for p in per if p["rows_returned"] == 0),
        "underfilled": sum(1 for p in per if 0 < p["rows_returned"] < 10),
        "encode_ms": {"p50": round(pct(enc_lat, 0.5), 2), "p95": round(pct(enc_lat, 0.95), 2)},
        "retrieve_ms": {
            "p50": round(pct(ret_lat, 0.5), 2),
            "p95": round(pct(ret_lat, 0.95), 2),
            "mean": round(sum(ret_lat) / len(ret_lat), 2),
            "max": round(max(ret_lat), 2),
        },
        "plan_paths": paths,
        "memory_end": mem_snapshot(),
        "per_query": per,
    }
    dst = CACHE / "_b11-recall-torch.json"
    dst.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    log(f"[torch] Top1={h1}/{denom}  Top10={h10}/{denom}  计划分布={paths}")
    log(f"[torch] encode P50={out['encode_ms']['p50']} ms  retrieve P50={out['retrieve_ms']['p50']} ms")
    log(f"[torch] 结束内存：{out['memory_end']}")
    log(f"已存：{dst}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
