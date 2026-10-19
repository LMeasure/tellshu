#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
b11-onnx-eval.py —— B.11 任务 1：ONNX FP32/INT8 的一致性、延迟、内存与召回实测

四个阶段（每个阶段一个进程，跑完即释放 —— 本机可用内存常年 1~2GB）：

    verify   --engine fp32|int8
        与 torch 参考向量（_b11-torch-ref.json）算余弦；同时报 CLS / mean 两种池化，
        用来确认「torch 参考到底用的哪种池化」（pipeline.json 已实测是 cls，这里是交叉验证）。

    quantize
        FP32 ONNX → INT8 动态量化（只量化权重，不量化激活）；量化完立刻验一致性。

    recall   --engine fp32|int8 [--limit N]
        用该引擎编码 v3 query set 的 counted 100 条，走**生产口径**检索
        （ef=800 + strict_order + 排除 front matter + top_k=10），
        逐条记录 hit_top1 / hit_top10 / 延迟 / 执行计划。

    compare  --a <recall json> --b <recall json>
        配对 McNemar 精确检验（项目既定口径），并给出逐条翻转清单。

⚠ 红线：
    - 检索 SQL 与 GUC 口径与 api/retrieve.py / db-conn-init.sql 完全一致，不另起一套。
    - 只读业务表；产物只写 server/.crawl-cache/_b11-*.json。
    - 不编造：余弦不达标就如实报不达标，召回下降就如实报下降。

用法：
    C:/Python314/python.exe api/b11-onnx-eval.py --stage verify  --engine fp32
    C:/Python314/python.exe api/b11-onnx-eval.py --stage quantize
    C:/Python314/python.exe api/b11-onnx-eval.py --stage verify  --engine int8
    C:/Python314/python.exe api/b11-onnx-eval.py --stage recall  --engine int8
    C:/Python314/python.exe api/b11-onnx-eval.py --stage compare --a A.json --b B.json
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
    ROOT,
    hit,
    load_counted_queries,
    mcnemar_exact,
    mem_snapshot,
    pct,
    search_once,
    to_literal,
)

# 与 b11-onnx-export.py 同一个开关：默认 ASCII 缓存目录（中文路径会踩导出器的坑）
OUT_DIR = Path(os.environ.get("B11_ONNX_DIR") or r"C:/Users/lagom/.cache/bge-m3-onnx")
MODEL_NAME = "BAAI/bge-m3"
REF_FILE = CACHE / "_b11-torch-ref.json"


def log(msg: str) -> None:
    print(f"[ .. ] {msg}", flush=True)


# ---------------------------------------------------------------------------
# ONNX 编码器
# ---------------------------------------------------------------------------

class OnnxEmbedder:
    """ONNX Runtime 编码器：骨干出 last_hidden_state，池化 + L2 归一化在外面做。

    tokenizer 必须与训练/生产同源 —— 直接用 AutoTokenizer 从同一个本地快照加载
    （与 sentence-transformers 内部用的是同一份 tokenizer.json）。
    ONNX 模型本身不带 tokenizer，预处理一旦不一致，产出的向量就与库里 58,332 条不同源，
    已有召回结论全部作废。这一点是 B.11 的红线。
    """

    def __init__(self, model_path: Path, threads: int = 4) -> None:
        import numpy as np
        import onnxruntime as ort
        from transformers import AutoTokenizer

        self.np = np
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = threads
        opts.inter_op_num_threads = 1
        t0 = time.perf_counter()
        self.session = ort.InferenceSession(
            str(model_path), opts, providers=["CPUExecutionProvider"]
        )
        self.load_ms = (time.perf_counter() - t0) * 1000
        self.tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME, local_files_only=True)
        self.input_names = [i.name for i in self.session.get_inputs()]
        self.output_names = [o.name for o in self.session.get_outputs()]
        self.warm_done = False

    def encode(self, text: str, pooling: str = "cls") -> Any:
        np = self.np
        tok = self.tokenizer([text], return_tensors="np", padding=True, truncation=True)
        feed = {
            "input_ids": tok["input_ids"].astype(np.int64),
            "attention_mask": tok["attention_mask"].astype(np.int64),
        }
        feed = {k: v for k, v in feed.items() if k in self.input_names}
        hidden = self.session.run(None, feed)[0]          # [1, T, 1024]
        if pooling == "cls":
            vec = hidden[:, 0, :]
        else:                                              # 掩码均值（仅作诊断对照）
            mask = feed["attention_mask"].astype(np.float32)[:, :, None]
            vec = (hidden * mask).sum(axis=1) / mask.sum(axis=1)
        vec = vec / (np.linalg.norm(vec, axis=-1, keepdims=True) + 1e-12)
        return vec[0]


def engine_path(engine: str) -> Path:
    """model_<engine>.onnx。engine: fp32 / int8 / int8pc（逐通道量化的 INT8）。"""
    p = OUT_DIR / f"model_{engine}.onnx"
    if not p.exists():
        raise SystemExit(f"模型文件不存在：{p}（先跑 --stage export / --stage quantize）")
    return p


# ---------------------------------------------------------------------------
# 一致性 + 延迟 + 内存
# ---------------------------------------------------------------------------

def stage_verify(engine: str, threads: int) -> int:
    import numpy as np

    if not REF_FILE.exists():
        raise SystemExit(f"缺少 torch 参考向量：{REF_FILE}（先跑 b11-onnx-export.py）")
    ref = json.loads(REF_FILE.read_text(encoding="utf-8"))
    refs = ref["refs"]
    log(f"torch 参考：{len(refs)} 条，生成于 {ref.get('generated_at')}")

    before = mem_snapshot()
    emb = OnnxEmbedder(engine_path(engine), threads=threads)
    after = mem_snapshot()
    log(
        f"[{engine}] 会话已建立：{emb.load_ms:.0f} ms  输入={emb.input_names} "
        f"输出={emb.output_names}"
    )
    log(f"[{engine}] 载入前后内存：{before} → {after}")

    # 预热（不计入统计）
    _ = emb.encode(refs[0]["query"])
    warm_mem = mem_snapshot()

    cos_cls: list[float] = []
    cos_mean: list[float] = []
    lat: list[float] = []
    for row in refs:
        t0 = time.perf_counter()
        vec = emb.encode(row["query"])
        lat.append((time.perf_counter() - t0) * 1000)
        ref_vec = np.asarray(row["vec"], dtype=np.float32)
        cos_cls.append(float(np.dot(vec, ref_vec)))
        mean_vec = emb.encode(row["query"], pooling="mean")
        cos_mean.append(float(np.dot(mean_vec, ref_vec)))

    def stat(xs: list[float]) -> dict[str, float]:
        arr = np.asarray(xs, dtype=np.float64)
        return {
            "min": round(float(arr.min()), 6),
            "p05": round(float(np.percentile(arr, 5)), 6),
            "mean": round(float(arr.mean()), 6),
            "max": round(float(arr.max()), 6),
        }

    out = {
        "stage": "verify",
        "engine": engine,
        "model_file": engine_path(engine).name,
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "torch_ref_count": len(refs),
        "session_load_ms": round(emb.load_ms, 1),
        "cosine_vs_torch": {"cls": stat(cos_cls), "mean_diagnostic": stat(cos_mean)},
        "encode_latency_ms": {
            "n": len(lat),
            "p50": round(pct(lat, 0.50), 2),
            "p95": round(pct(lat, 0.95), 2),
            "min": round(min(lat), 2),
            "max": round(max(lat), 2),
        },
        "memory": {"before_load": before, "after_load": after, "after_warmup": warm_mem},
        "per_query": [
            {"query_id": r["query_id"], "cos_cls": round(cos_cls[i], 6),
             "cos_mean": round(cos_mean[i], 6), "encode_ms": round(lat[i], 2)}
            for i, r in enumerate(refs)
        ],
    }
    dst = CACHE / f"_b11-verify-{engine}.json"
    dst.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    log(f"[{engine}] 余弦 vs torch（CLS）：{out['cosine_vs_torch']['cls']}")
    log(f"[{engine}] 余弦 vs torch（mean 诊断）：{out['cosine_vs_torch']['mean_diagnostic']}")
    log(f"[{engine}] 编码延迟：{out['encode_latency_ms']}")
    log(f"[{engine}] 内存：{out['memory']}")
    log(f"已存：{dst}")
    return 0


# ---------------------------------------------------------------------------
# INT8 动态量化
# ---------------------------------------------------------------------------

def stage_quantize(threads: int, per_channel: bool) -> int:
    """FP32 → INT8 动态量化。

    per_channel=True 时给**每个输出通道**单独算 scale（默认 per-channel=False 是整张
    权重共用一个 scale）。代价几乎为零（多一点点 scale 常量），但对量化误差的补偿通常
    很明显 —— 权重各通道量级差异大时，共用一个 scale 会被最大的那个通道绑架，
    小通道直接被压成 0。
    """
    from onnxruntime.quantization import QuantType, quantize_dynamic

    engine = "int8pc" if per_channel else "int8"
    src = OUT_DIR / "model_fp32.onnx"
    dst = OUT_DIR / f"model_{engine}.onnx"
    if not src.exists():
        raise SystemExit(f"缺少 FP32 ONNX：{src}")
    log(f"开始量化：{src.name} → {dst.name}  per_channel={per_channel}  内存={mem_snapshot()}")
    t0 = time.perf_counter()
    quantize_dynamic(
        model_input=str(src),
        model_output=str(dst),
        weight_type=QuantType.QInt8,
        per_channel=per_channel,
        extra_options={"EnableSubgraph": False},
    )
    q_ms = (time.perf_counter() - t0) * 1000
    log(f"量化完成：{q_ms:.0f} ms  内存={mem_snapshot()}")

    fp_total = sum(
        p.stat().st_size
        for p in OUT_DIR.iterdir()
        if p.name != "pipeline.json" and not p.name.startswith("model_int8")
    )
    info = {
        "stage": "quantize",
        "engine": engine,
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "quantize_ms": round(q_ms, 1),
        "per_channel": per_channel,
        "fp32_total_mb": round(fp_total / 1024**2, 1),
        "int8_total_mb": round(dst.stat().st_size / 1024**2, 1),
        "weight_type": "QInt8（动态量化：只量化权重，不量化激活）",
        "fp32_note": "FP32 是 172 个外置权重文件（legacy 导出器逐张量落盘），"
                     "model_fp32.onnx 本体只有 1.4MB —— 目录总大小才是真实体积",
    }
    (CACHE / f"_b11-quantize-{engine}.json").write_text(
        json.dumps(info, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    log(f"体积：FP32 {info['fp32_total_mb']} MB → {engine} {info['int8_total_mb']} MB")

    import gc

    gc.collect()
    log(f"转入 {engine} 一致性验证（同进程）")
    return stage_verify(engine, threads)


# ---------------------------------------------------------------------------
# 召回
# ---------------------------------------------------------------------------

def stage_recall(engine: str, limit: int | None, threads: int, explain_every: int) -> int:
    rows = load_counted_queries(limit)
    log(f"召回对照：引擎={engine}  条数={len(rows)}  内存={mem_snapshot()}")
    emb = OnnxEmbedder(engine_path(engine), threads=threads)
    log(f"[{engine}] 会话就绪 内存={mem_snapshot()}")

    from b11_common import connect

    conn = connect()
    log("数据库连接已建立（已执行 db-conn-init.sql）")
    _ = emb.encode(rows[0]["query"])     # 预热，不计入

    per: list[dict[str, Any]] = []
    enc_lat: list[float] = []
    ret_lat: list[float] = []
    for i, row in enumerate(rows, start=1):
        expected = row["expected_book"]
        t0 = time.perf_counter()
        vec = emb.encode(row["query"])
        enc_ms = (time.perf_counter() - t0) * 1000
        enc_lat.append(enc_ms)
        qrows, wall_ms, plan = search_once(
            conn, to_literal(vec), 10, explain=(i % explain_every == 1)
        )
        ret_lat.append(wall_ms)
        titles = [r[2] for r in qrows]           # (chunk_id, book_id, title, ...)
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
                f"retrieve P50={pct(ret_lat, 0.5):.1f} ms  内存={mem_snapshot()['avail_gb']} GB 可用"
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
        "engine": engine,
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "denominator": denom,
        "top_k": 10,
        "retrieval": "HNSW ef=800 + iterative_scan=strict_order + 排除 front matter",
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
        "per_query": per,
    }
    dst = CACHE / f"_b11-recall-{engine}.json"
    dst.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    log(f"[{engine}] Top1={h1}/{denom}  Top10={h10}/{denom}  计划分布={paths}")
    log(f"[{engine}] encode P50={out['encode_ms']['p50']} ms  retrieve P50={out['retrieve_ms']['p50']} ms")
    log(f"已存：{dst}")
    return 0


# ---------------------------------------------------------------------------
# 配对比较（McNemar）
# ---------------------------------------------------------------------------

def stage_compare(a_path: str, b_path: str) -> int:
    a = json.loads(Path(a_path).read_text(encoding="utf-8"))
    b = json.loads(Path(b_path).read_text(encoding="utf-8"))
    ma = {p["query_id"]: p for p in a["per_query"]}
    mb = {p["query_id"]: p for p in b["per_query"]}
    common = [q for q in ma if q in mb]
    log(f"配对样本：{len(common)}（A={a_path} B={b_path}）")

    def pair(key: str) -> dict[str, Any]:
        b_only = sum(1 for q in common if ma[q][key] and not mb[q][key])   # A 中 B 不中
        c_only = sum(1 for q in common if not ma[q][key] and mb[q][key])   # A 不中 B 中
        test = mcnemar_exact(b_only, c_only)
        flips = [
            {
                "query_id": q,
                "query": ma[q]["query"],
                "expected": ma[q]["expected"],
                "A_top1": ma[q]["top1"],
                "B_top1": mb[q]["top1"],
                "direction": "A中→B不中" if ma[q][key] else "A不中→B中",
            }
            for q in common
            if ma[q][key] != mb[q][key]
        ]
        return {
            "metric": key,
            "A_hits": sum(1 for q in common if ma[q][key]),
            "B_hits": sum(1 for q in common if mb[q][key]),
            "delta": sum(1 for q in common if mb[q][key]) - sum(1 for q in common if ma[q][key]),
            "mcnemar": test,
            "flips": flips,
        }

    out = {
        "stage": "compare",
        "A": {"file": a_path, "engine": a.get("engine"), "denominator": a.get("denominator")},
        "B": {"file": b_path, "engine": b.get("engine"), "denominator": b.get("denominator")},
        "paired": len(common),
        "results": [pair("hit_top1"), pair("hit_top10")],
    }
    dst = CACHE / "_b11-compare.json"
    dst.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    for r in out["results"]:
        m = r["mcnemar"]
        log(
            f"{r['metric']}: A={r['A_hits']} B={r['B_hits']} Δ={r['delta']}  "
            f"McNemar b={m['b']} c={m['c']} p={m['p_value']}"
        )
    log(f"已存：{dst}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="B.11 ONNX 一致性 / 量化 / 召回")
    ap.add_argument("--stage", choices=["verify", "quantize", "recall", "compare"], required=True)
    ap.add_argument("--engine", default="int8", help="fp32 / int8 / int8pc")
    ap.add_argument("--per-channel", action="store_true", help="量化时逐通道算 scale")
    ap.add_argument("--limit", type=int, default=None, help="召回条数（默认全部 counted）")
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--explain-every", type=int, default=10, help="每 N 条取一次 EXPLAIN")
    ap.add_argument("--a", dest="a", default=None)
    ap.add_argument("--b", dest="b", default=None)
    args = ap.parse_args()

    if args.stage == "verify":
        return stage_verify(args.engine, args.threads)
    if args.stage == "quantize":
        return stage_quantize(args.threads, args.per_channel)
    if args.stage == "recall":
        return stage_recall(args.engine, args.limit, args.threads, args.explain_every)
    if not (args.a and args.b):
        raise SystemExit("compare 需要 --a 和 --b")
    return stage_compare(args.a, args.b)


if __name__ == "__main__":
    sys.exit(main())
