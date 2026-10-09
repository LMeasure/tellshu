# -*- coding: utf-8 -*-
"""
BGE-M3 本地 embedding 环境预检查（Stage 0.6）
=====================================================================
在写任何 crawler / ingest 之前必须先跑通本脚本。任何一项不通过即以非 0 退出码停止，
调用方不得继续后续阶段。

检查项：
  1. sentence-transformers 是否安装
  2. 模型能否加载（本地缓存优先，不依赖云端 embedding API）
  3. 模型名是否为 BAAI/bge-m3
  4. 生成一条测试 embedding
  5. shape 必须为 (1, 1024)
  6. 不得出现 NaN / Inf
  7. 必须使用 normalize_embeddings=True
  8. 向量范数必须接近 1
  9. 输出实际 dimension
 10. 输出模型加载成功 / 失败原因

用法：
    cd server
    python src/scripts/check-embedding.py              # 在线优先，失败自动退回本地缓存
    python src/scripts/check-embedding.py --offline    # 只用本地缓存，完全不联网

说明：huggingface.co 在本机走代理可能 502，而权重通常已在本地缓存里，
      因此加载失败时会自动以 local_files_only=True 重试一次，并把所用模式打印出来。

退出码：0 = 全部通过；1 = 存在不通过项；2 = 环境缺失（依赖未装）
"""

from __future__ import annotations

import math
import os
import sys
import traceback
from typing import Final

MODEL_NAME: Final[str] = "BAAI/bge-m3"
EXPECTED_DIM: Final[int] = 1024
NORM_TOLERANCE: Final[float] = 1e-3

# 中英混排测试句：本项目要同时支持「中文查询 → 英文正文」与「英文 → 英文」
TEST_SENTENCES: Final[list[str]] = [
    "关于爱情与阶级的英文小说",
    "It is a truth universally acknowledged that a single man in possession of a good fortune must be in want of a wife.",
]


def fail(reason: str) -> None:
    """打印失败原因并立即停止（不 swallow、不降级）。"""
    print(f"[FAIL] {reason}", file=sys.stderr)
    sys.exit(1)


def ok(message: str) -> None:
    print(f"[ OK ] {message}")


def resolve_model_name(model: object) -> str:
    """从 SentenceTransformer 里取真实模型标识（不同版本属性位置不一样）。"""
    for attr in ("model_name_or_path", "model_name"):
        value = getattr(model, attr, None)
        if isinstance(value, str) and value != "":
            return value
    # sentence-transformers 6.x：标识挂在第一个 Transformer 模块里
    try:
        first_module = model[0]  # type: ignore[index]
        name = getattr(first_module.auto_model, "name_or_path", None)
        if isinstance(name, str) and name != "":
            return name
    except Exception:  # noqa: BLE001 - 结构不同就继续退化
        pass
    return ""


def load_model(offline_only: bool) -> tuple[object, str]:
    """返回 (model, 加载模式)。在线失败自动退回本地缓存，绝不静默成功。"""
    from sentence_transformers import SentenceTransformer

    if offline_only:
        os.environ.setdefault("HF_HUB_OFFLINE", "1")
        return SentenceTransformer(MODEL_NAME, local_files_only=True), "offline(本地缓存)"

    try:
        return SentenceTransformer(MODEL_NAME), "online(HuggingFace Hub)"
    except Exception as exc:  # noqa: BLE001 - 真实原因要打到 stderr
        print(f"[WARN] 在线加载失败，改用本地缓存重试：{type(exc).__name__}: {exc}", file=sys.stderr)
        try:
            os.environ.setdefault("HF_HUB_OFFLINE", "1")
            return SentenceTransformer(MODEL_NAME, local_files_only=True), "offline(本地缓存)"
        except Exception:  # noqa: BLE001
            print(f"[FAIL] 模型加载失败：{MODEL_NAME}", file=sys.stderr)
            traceback.print_exc()
            raise


def main() -> int:
    offline_only = "--offline" in sys.argv[1:]
    print("=" * 68)
    print(f"BGE-M3 embedding 环境预检查  模型={MODEL_NAME}  期望维度={EXPECTED_DIM}")
    print("=" * 68)

    # 1. 依赖检查
    try:
        import sentence_transformers  # noqa: F401  (仅探测是否安装)
    except Exception as exc:  # noqa: BLE001 - 必须把真实原因打出来
        print(f"[FAIL] sentence-transformers 未安装或无法导入：{exc}", file=sys.stderr)
        print("       安装：python -m pip install sentence-transformers", file=sys.stderr)
        return 2
    import numpy as np
    from sentence_transformers import SentenceTransformer

    ok(f"sentence-transformers 已安装（版本 {sentence_transformers.__version__}）")
    ok(f"numpy {np.__version__}")

    # 2 & 3. 加载模型
    try:
        model: object
        model, load_mode = load_model(offline_only)
    except Exception:  # noqa: BLE001 - 失败原因已在 load_model 里完整打印
        return 1

    ok(f"模型已加载（模式 = {load_mode}）")
    resolved_name = resolve_model_name(model)
    ok(f"模型标识 = {resolved_name or '(未知)'}")
    if MODEL_NAME not in resolved_name:
        fail(f"加载到的模型不是 {MODEL_NAME}（实际 {resolved_name or '未知'}）")

    max_seq = getattr(model, "max_seq_length", None)
    if max_seq is not None:
        ok(f"max_seq_length = {max_seq}")

    # 4. 生成 embedding（normalize_embeddings=True）
    vectors = model.encode(TEST_SENTENCES, normalize_embeddings=True, batch_size=len(TEST_SENTENCES))
    arr = np.asarray(vectors)

    # 5. shape
    ok(f"向量 shape = {arr.shape}")
    if arr.ndim != 2 or arr.shape[0] != len(TEST_SENTENCES):
        fail(f"shape 第一维应为样本数 {len(TEST_SENTENCES)}，实际 {arr.shape}")
    actual_dim = int(arr.shape[1])

    # 9. 实际 dimension
    ok(f"实际 dimension = {actual_dim}")
    if actual_dim != EXPECTED_DIM:
        fail(f"dimension 应为 {EXPECTED_DIM}，实际 {actual_dim}（VECTOR({EXPECTED_DIM}) 无法容纳）")

    # 6. NaN / Inf
    nan_count = int(np.isnan(arr).sum())
    inf_count = int(np.isinf(arr).sum())
    ok(f"NaN 数量 = {nan_count}，Inf 数量 = {inf_count}")
    if nan_count > 0 or inf_count > 0:
        fail(f"向量中存在非法数值（NaN={nan_count}, Inf={inf_count}）")

    # 7 & 8. 范数接近 1（normalize_embeddings=True 的直接证据）
    norms = np.linalg.norm(arr, axis=1)
    for idx, norm in enumerate(norms):
        value = float(norm)
        ok(f"第 {idx + 1} 条向量范数 = {value:.6f}")
        if not math.isclose(value, 1.0, abs_tol=NORM_TOLERANCE):
            fail(f"第 {idx + 1} 条向量范数 {value:.6f} 偏离 1 超过 {NORM_TOLERANCE}（normalize_embeddings 未生效？）")

    # 附带：跨语言相似度（中文 → 英文），只做打印不做门禁，供人工判断检索是否可用
    sim = float(np.dot(arr[0], arr[1]))
    ok(f"中文句 ↔ 英文句 余弦相似度 = {sim:.4f}（仅打印，不作为通过条件）")

    print("-" * 68)
    print(f"[PASS] {MODEL_NAME} 可用，dimension={actual_dim}，normalize_embeddings=True 已生效")
    return 0


if __name__ == "__main__":
    sys.exit(main())
