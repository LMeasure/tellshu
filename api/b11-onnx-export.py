#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
b11-onnx-export.py —— B.11 任务 1：BGE-M3 → ONNX（FP32）导出 + torch 参考向量留样

为什么要分开跑（不一个进程干到底）：
    本机可用物理内存常年在 1~2GB（B.10 实测：负载 91~95%、可用 0.6~1.4GB）。
    torch 版 BGE-M3 常驻 ~2.2GB，ONNX FP32 会话又是 ~2.2GB，FP32→INT8 量化过程中
    onnx.load 会把 2.27GB 权重整体读进内存（protobuf 有额外开销）。
    三者同时驻留必炸，所以每个阶段一个进程、跑完即释放。

本脚本只做两件事（都在 torch 进程里，避免重复加载 2.2GB 模型）：
    1. 把 XLMRobertaModel（BGE-M3 的骨干）导出成 FP32 ONNX
    2. 用 sentence-transformers 原路径对 v3 query set 前 N 条算**参考向量**存 JSON，
       供后面无 torch 的进程做一致性比对

⚠ 红线：
    - 只读业务库，本脚本**不连数据库**。
    - tokenizer 必须与训练/生产同源：用 AutoTokenizer 从**同一个本地快照**加载，
      与 sentence-transformers 内部用的是同一份 tokenizer.json（见 §一致性口径）。
    - 不修改任何既有资产；产物只落在 bge-m3-onnx/（已 gitignore）。

用法（必须在原生 PowerShell 里跑 —— Git Bash/MSYS 下 import torch 会 SIGSEGV/139）：
    C:/Python314/python.exe api/b11-onnx-export.py --stage export
    C:/Python314/python.exe api/b11-onnx-export.py --stage export --opset 14 --queries 20
    C:/Python314/python.exe api/b11-onnx-export.py --stage ref --queries 20
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Final

ROOT = Path(__file__).resolve().parent.parent          # 项目根
# ⚠ 导出目录必须是 **纯 ASCII 路径**：项目根含中文（述树交付包），
# legacy TorchScript 导出器在写外置权重文件时由 C++ 侧拼路径，实测会把中文截断：
#   RuntimeError: Could not open file or directory: .../述树交付包/bge-m3-onnx/Constant_755_attr__value
# 所以默认落在 ASCII 缓存目录，导出完再整体搬到 ROOT/bge-m3-onnx（同盘 rename，瞬时）。
OUT_DIR = Path(os.environ.get("B11_ONNX_DIR") or r"C:/Users/lagom/.cache/bge-m3-onnx")
QUERY_SET = ROOT / "discover-query-set-v3.json"

MODEL_NAME: Final[str] = os.environ.get("EMBED_MODEL", "BAAI/bge-m3")
EXPECTED_DIM: Final[int] = 1024


def log(msg: str) -> None:
    print(f"[ .. ] {msg}", flush=True)


def mem_snapshot() -> dict[str, float]:
    """系统可用内存（GB）+ 本进程 RSS（GB）。psutil 不在就用 ctypes 兜底。"""
    import ctypes

    class MEMORYSTATUSEX(ctypes.Structure):
        _fields_ = [
            ("dwLength", ctypes.c_ulong),
            ("dwMemoryLoad", ctypes.c_ulong),
            ("ullTotalPhys", ctypes.c_ulonglong),
            ("ullAvailPhys", ctypes.c_ulonglong),
            ("ullTotalPageFile", ctypes.c_ulonglong),
            ("ullAvailPageFile", ctypes.c_ulonglong),
            ("ullTotalVirtual", ctypes.c_ulonglong),
            ("ullAvailVirtual", ctypes.c_ulonglong),
            ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
        ]

    stat = MEMORYSTATUSEX()
    stat.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
    ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat))
    out = {
        "load_pct": float(stat.dwMemoryLoad),
        "avail_gb": round(stat.ullAvailPhys / 1024**3, 2),
        "total_gb": round(stat.ullTotalPhys / 1024**3, 2),
        "rss_gb": 0.0,
    }
    try:
        import psutil  # type: ignore[import-untyped]

        out["rss_gb"] = round(psutil.Process().memory_info().rss / 1024**3, 2)
    except Exception:  # noqa: BLE001
        pass
    return out


def load_counted_queries(n: int | None) -> list[dict[str, Any]]:
    data = json.loads(QUERY_SET.read_text(encoding="utf-8"))
    rows = [r for r in data.get("queries", []) if r.get("counted")]
    if n is not None:
        rows = rows[:n]
    return rows


def load_st_model() -> Any:
    """加载 sentence-transformers 版 BGE-M3（与 eval-discover.py 完全同口径）。"""
    from sentence_transformers import SentenceTransformer

    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    t0 = time.perf_counter()
    model = SentenceTransformer(MODEL_NAME, local_files_only=True)
    load_ms = (time.perf_counter() - t0) * 1000
    log(f"模型已加载：{MODEL_NAME}  用时 {load_ms:.0f} ms  内存={mem_snapshot()}")
    return model, load_ms


def describe_pipeline(model: Any) -> dict[str, Any]:
    """把 sentence-transformers 的流水线结构如实打出来（池化方式必须确认，不能猜）。"""
    info: dict[str, Any] = {"modules": []}
    for idx, module in enumerate(model):
        name = type(module).__name__
        entry: dict[str, Any] = {"idx": idx, "type": name}
        try:
            cfg = module.get_config_dict()
            entry["config"] = {k: v for k, v in cfg.items() if k != "__version__"}
        except Exception as exc:  # noqa: BLE001
            entry["config"] = f"<不可读: {exc}>"
        info["modules"].append(entry)
    try:
        info["transformer_model"] = type(model[0].auto_model).__name__
        info["transformer_path"] = str(model[0].auto_model.name_or_path)
    except Exception as exc:  # noqa: BLE001
        info["transformer_model"] = f"<不可读: {exc}>"
    try:
        info["max_seq_length"] = model.max_seq_length
    except Exception:  # noqa: BLE001
        info["max_seq_length"] = None
    return info


def make_wrapper(backbone: Any) -> Any:
    """只导出骨干（XLMRobertaModel），池化/归一化放到 ONNX 外面用 numpy 做。

    为什么不用 trust_remote_code 的 BGEM3Model 直出 sentence_embedding：
        本地快照 config.json 的 architectures = ["XLMRobertaModel"]，就是个纯骨干，
        没有自定义 forward（已由 describe_pipeline 实测确认）。导出骨干是最小面、
        最不容易被 tracing 坑的做法；池化只有一句话（CLS = last_hidden_state[:, 0]，
        已由 pipeline.json 的 pooling_mode=cls 确认），放外面更好验、更好改。

    必须是 torch.nn.Module 子类：legacy TorchScript 导出器会调 model.modules()。
    """
    import torch

    class BackboneWrapper(torch.nn.Module):
        def __init__(self, inner: Any) -> None:
            super().__init__()
            self.backbone = inner

        def forward(self, input_ids, attention_mask):  # noqa: ANN001, ANN204
            out = self.backbone(
                input_ids=input_ids, attention_mask=attention_mask, use_cache=False
            )
            return out.last_hidden_state

    return BackboneWrapper(backbone)


def stage_export(opset: int, queries: int, fold: bool, optimize: bool, legacy: bool) -> int:
    import torch

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    model, load_ms = load_st_model()
    pipe = describe_pipeline(model)
    log(f"流水线结构：{json.dumps(pipe, ensure_ascii=False)}")
    (OUT_DIR / "pipeline.json").write_text(
        json.dumps(pipe, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    from transformers import AutoTokenizer

    tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME, local_files_only=True)
    log(f"tokenizer = {type(tokenizer).__name__}（与 ST 同源：本地同一份快照）")

    backbone = model[0].auto_model.eval()
    wrapper = make_wrapper(backbone)

    seq = 16
    dummy = tokenizer(["hello world"], return_tensors="pt", padding=True, truncation=True)
    ids = dummy["input_ids"]
    mask = dummy["attention_mask"]
    log(f"dummy 输入：input_ids={tuple(ids.shape)} attention_mask={tuple(mask.shape)}")

    fp32_path = OUT_DIR / "model_fp32.onnx"
    log(
        f"开始导出 FP32 ONNX：opset={opset} do_constant_folding={fold} "
        f"exporter={'legacy(TorchScript)' if legacy else 'dynamo'}  内存={mem_snapshot()}"
    )
    t0 = time.perf_counter()
    if legacy:
        # dynamo 导出器需要 onnxscript，本机 PyPI 502 装不上（B.10 同一个网络问题）。
        # legacy 导出器在模型 >2GB 时会**自动**切换外置权重（graph._export_onnx 内部判定，
        # 前提是把 f 传成字符串路径 —— 见 torch/onnx/_internal/torchscript_exporter/utils.py）。
        torch.onnx.export(
            wrapper,
            (ids, mask),
            str(fp32_path),
            input_names=["input_ids", "attention_mask"],
            output_names=["last_hidden_state"],
            opset_version=opset,
            do_constant_folding=fold,
            dynamo=False,
            dynamic_axes={
                "input_ids": {0: "batch", 1: "seq"},
                "attention_mask": {0: "batch", 1: "seq"},
                "last_hidden_state": {0: "batch", 1: "seq"},
            },
        )
    else:
        batch_dim = torch.export.Dim("batch", min=1, max=8)
        seq_dim = torch.export.Dim("seq", min=1, max=8192)
        dynamic_shapes = (
            {0: batch_dim, 1: seq_dim},
            {0: batch_dim, 1: seq_dim},
        )
        torch.onnx.export(
            wrapper,
            (ids, mask),
            str(fp32_path),
            input_names=["input_ids", "attention_mask"],
            output_names=["last_hidden_state"],
            opset_version=opset,
            do_constant_folding=fold,
            optimize=optimize,
            dynamo=True,          # torch 2.14 默认 dynamo；需 onnxscript
            external_data=True,   # 2.27GB > protobuf 2GB 硬上限，必须外置权重
            dynamic_shapes=dynamic_shapes,
        )
    export_ms = (time.perf_counter() - t0) * 1000
    log(f"导出完成：{export_ms:.0f} ms  内存={mem_snapshot()}")

    produced = sorted(p.name for p in OUT_DIR.iterdir())
    sizes = {p.name: round(p.stat().st_size / 1024**2, 1) for p in OUT_DIR.iterdir()}
    log(f"产物：{sizes}")

    # ---- torch 参考向量（同一进程内算，省一次 2.2GB 加载）----
    rows = load_counted_queries(queries)
    log(f"计算 torch 参考向量：{len(rows)} 条")
    import numpy as np

    refs: list[dict[str, Any]] = []
    lat: list[float] = []
    for row in rows:
        t1 = time.perf_counter()
        vec = np.asarray(
            model.encode([row["query"]], normalize_embeddings=True, convert_to_numpy=True)
        )[0]
        lat.append((time.perf_counter() - t1) * 1000)
        if vec.shape != (EXPECTED_DIM,):
            raise RuntimeError(f"向量形状异常：{vec.shape}")
        refs.append(
            {
                "query_id": row["query_id"],
                "query": row["query"],
                "expected_book_short": row.get("expected_book_short"),
                "vec": [round(float(v), 6) for v in vec],
            }
        )
    payload = {
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "model": MODEL_NAME,
        "backend": "torch(sentence-transformers)",
        "dim": EXPECTED_DIM,
        "count": len(refs),
        "pipeline": pipe,
        "model_load_ms": round(load_ms, 1),
        "export_ms": round(export_ms, 1),
        "encode_latency_ms": [round(x, 1) for x in lat],
        "files": sizes,
        "refs": refs,
    }
    out = ROOT / "server" / ".crawl-cache" / "_b11-torch-ref.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    log(f"参考向量已存：{out}  （{len(refs)} 条）")
    log(f"torch encode 延迟 P50={sorted(lat)[len(lat)//2]:.1f} ms")
    log(f"产物清单：{produced}")
    return 0


def stage_ref(queries: int) -> int:
    """只补算 torch 参考向量（导出已成功、只想重算参考时用）。"""
    model, load_ms = load_st_model()
    pipe = describe_pipeline(model)
    rows = load_counted_queries(queries)
    import numpy as np

    refs, lat = [], []
    for row in rows:
        t1 = time.perf_counter()
        vec = np.asarray(
            model.encode([row["query"]], normalize_embeddings=True, convert_to_numpy=True)
        )[0]
        lat.append((time.perf_counter() - t1) * 1000)
        refs.append(
            {
                "query_id": row["query_id"],
                "query": row["query"],
                "expected_book_short": row.get("expected_book_short"),
                "vec": [round(float(v), 6) for v in vec],
            }
        )
    out = ROOT / "server" / ".crawl-cache" / "_b11-torch-ref.json"
    payload = {
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "model": MODEL_NAME,
        "backend": "torch(sentence-transformers)",
        "dim": EXPECTED_DIM,
        "count": len(refs),
        "pipeline": pipe,
        "model_load_ms": round(load_ms, 1),
        "encode_latency_ms": [round(x, 1) for x in lat],
        "refs": refs,
    }
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    log(f"参考向量已存：{out}（{len(refs)} 条）")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="B.11 BGE-M3 ONNX 导出 + torch 参考向量")
    parser.add_argument("--stage", choices=["export", "ref"], default="export")
    parser.add_argument("--opset", type=int, default=14)
    parser.add_argument("--queries", type=int, default=20, help="参考向量条数（取 counted 前 N 条）")
    parser.add_argument("--no-fold", action="store_true", help="关闭 do_constant_folding")
    parser.add_argument("--no-optimize", action="store_true", help="关闭 ONNX 图优化（省内存，仅 dynamo）")
    parser.add_argument(
        "--legacy",
        action="store_true",
        help="用 legacy TorchScript 导出器（dynamo 需要 onnxscript，本机装不上）",
    )
    args = parser.parse_args()
    log(f"起始内存：{mem_snapshot()}")
    if args.stage == "export":
        return stage_export(
            args.opset, args.queries, not args.no_fold, not args.no_optimize, args.legacy
        )
    return stage_ref(args.queries)


if __name__ == "__main__":
    sys.exit(main())
