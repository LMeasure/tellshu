# -*- coding: utf-8 -*-
"""
embed.py —— query 编码后端

三种后端：
  local   （默认）进程内常驻 BGE-M3，应用启动时加载一次，之后一直复用。
  remote  EMBEDDING_SERVICE_URL 指向外部编码服务，HTTP POST 拿向量。
          —— 这是 B.8 §10.1 拍板第 3 条预留的「将来分机部署」接口，本轮共置不启用。
  onnx    ONNX Runtime 跑量化模型（B.11 实现）。B.10 定位到 retrieve 慢的真因是
          **页缓存冷缺失**（456MB HNSW 索引 + 808MB 堆挤不进内存），而 BGE-M3 torch
          常驻 ~2.2GB 是最大的可压缩项。ONNX INT8 把常驻压到 ~1.3GB，腾出的内存
          让索引能留在页缓存里 —— 这是 ONNX 的真正价值，不是「编码快 3 倍」。

对外接口（B.9 约定）：
  async def embed(text: str) -> list[float]
  async def embed_timed(text: str) -> tuple[list[float], float]   # 附带编码耗时 ms

为什么 embed 必须是 async：BGE-M3 单条编码 P50 155ms（torch）/ ~20ms（ONNX INT8），
同步调用会把 event loop 顶死，其它请求全部排队。内部统一用 asyncio.to_thread 卸载。
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Protocol

from config import Config

log = logging.getLogger("discover.embed")


class Backend(Protocol):
    name: str

    def encode_sync(self, text: str) -> list[float]: ...


class LocalBackend:
    """进程内 sentence-transformers / BGE-M3。加载逻辑与 eval-discover.py 一致。"""

    name = "local"

    def __init__(self, model_name: str, dim: int):
        # 离线加载：本机模型已在缓存里，禁止联网（联网失败会变成另一种报错）
        os.environ.setdefault("HF_HUB_OFFLINE", "1")
        os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
        from sentence_transformers import SentenceTransformer  # 延迟导入：remote 后端不需要它

        self.dim = dim
        t0 = time.perf_counter()
        self.model = SentenceTransformer(model_name, local_files_only=True)
        self.load_ms = (time.perf_counter() - t0) * 1000
        try:
            self.model_id = str(self.model[0].auto_model.name_or_path)
        except Exception:  # noqa: BLE001
            self.model_id = model_name
        log.info("BGE-M3 已加载：%s（%.0f ms）", self.model_id, self.load_ms)

    def encode_sync(self, text: str) -> list[float]:
        import numpy as np

        arr = self.model.encode([text], normalize_embeddings=True, convert_to_numpy=True)
        vec = [float(v) for v in arr[0]]
        if len(vec) != self.dim:
            raise RuntimeError(f"向量维度异常：期望 {self.dim}，实得 {len(vec)}")
        return vec


class RemoteBackend:
    """HTTP 编码服务（B.8 §10.1 预留的分离部署形态，本轮默认不启用）。"""

    name = "remote"

    def __init__(self, base_url: str, dim: int, timeout: float = 30.0):
        self.base_url = base_url.rstrip("/")
        self.dim = dim
        self.timeout = timeout
        self.load_ms = 0.0
        self.model_id = f"remote:{self.base_url}"
        # 服务端自报的编码耗时（不含网络），用于区分「编码慢」和「调用慢」
        self.last_server_encode_ms: float | None = None

    def encode_sync(self, text: str) -> list[float]:
        payload = json.dumps({"text": text}).encode("utf-8")
        req = urllib.request.Request(
            self.base_url + "/embed",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                body = json.loads(resp.read().decode("utf-8"))
        except urllib.error.URLError as exc:
            raise RuntimeError(f"远程编码服务不可用：{exc}") from exc
        # 优先读 vector（embed_server.py 的契约），兼容 embedding 别名
        vec = body.get("vector")
        if vec is None:
            vec = body.get("embedding")
        if not isinstance(vec, list) or len(vec) != self.dim:
            raise RuntimeError(
                f"远程编码返回异常：维度 {len(vec) if isinstance(vec, list) else '?'}，期望 {self.dim}"
            )
        self.last_server_encode_ms = body.get("encode_ms")
        return [float(v) for v in vec]


class OnnxBackend:
    """ONNX Runtime 编码（B.11 实现）。

    三件事必须做对，否则产出的向量与库里 58,332 条不同源，已有召回结论全部作废：

    1. **tokenizer 必须同源**。ONNX 模型本身不含 tokenizer，所以用 AutoTokenizer
       从**同一个本地快照**加载（BAAI/bge-m3），与 sentence-transformers 内部用的
       是同一份 tokenizer.json。导出脚本里也是这么取的。
    2. **池化必须是 CLS**。不是猜的：导出时实测 sentence-transformers 的流水线配置
       是 {"pooling_mode": "cls"}；一致性验证里 mean 池化对照只有 0.738~0.832，
       而 CLS 是 1.000000 —— 两个数字一起把池化方式钉死了。
    3. **必须 L2 归一化**。库里的向量是 normalize_embeddings=True 存的，
       不归一化就是另一个度量空间。

    B.11 实测（20 条真实 query，v3 前 20 条）：
        余弦 vs torch：INT8 逐通道 min 0.986855 / mean 0.989805
        编码延迟 P50：torch 119.9ms → FP32 ONNX 58.4ms → INT8 逐通道 23.1ms
        进程 RSS：    torch 1.95GB → FP32 ONNX 1.90GB → INT8 逐通道 1.31GB
        召回（100 条 counted，ef=800+strict_order）：
                     torch 49/100 → INT8 逐通道 47/100（McNemar 4/2, p=0.69，不显著）
    """

    name = "onnx"

    def __init__(self, model_path: str, model_name: str, dim: int, threads: int = 4):
        os.environ.setdefault("HF_HUB_OFFLINE", "1")
        os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

        path = Path(model_path)
        if not path.exists():
            raise RuntimeError(
                f"ONNX 模型文件不存在：{path}\n"
                "先用 api/b11-onnx-export.py 导出 FP32，再用 "
                "api/b11-onnx-eval.py --stage quantize --per-channel 量化成 INT8，"
                "把产物放到该路径（或用 ONNX_MODEL_PATH 指定别的路径）。"
            )

        import numpy as np
        import onnxruntime as ort
        from transformers import AutoTokenizer

        self.dim = dim
        self.np = np
        self.threads = threads
        self.model_path = str(path)

        opts = ort.SessionOptions()
        opts.intra_op_num_threads = threads
        opts.inter_op_num_threads = 1
        t0 = time.perf_counter()
        self.session = ort.InferenceSession(
            str(path), opts, providers=["CPUExecutionProvider"]
        )
        # 同一个本地快照取 tokenizer —— 与 torch 后端、与导出脚本同源
        self.tokenizer = AutoTokenizer.from_pretrained(model_name, local_files_only=True)
        self.load_ms = (time.perf_counter() - t0) * 1000

        self.input_names = [i.name for i in self.session.get_inputs()]
        self.model_id = f"onnx:{path.name} (tokenizer={model_name})"
        log.info(
            "ONNX 模型已加载：%s  输入=%s  线程=%d（%.0f ms）",
            path.name, self.input_names, threads, self.load_ms,
        )

    def encode_sync(self, text: str) -> list[float]:
        np = self.np
        tok = self.tokenizer([text], return_tensors="np", padding=True, truncation=True)
        feed = {
            "input_ids": tok["input_ids"].astype(np.int64),
            "attention_mask": tok["attention_mask"].astype(np.int64),
        }
        # 只喂模型真正声明了输入的键（不同导出器可能多/少一个 token_type_ids）
        feed = {k: v for k, v in feed.items() if k in self.input_names}
        hidden = self.session.run(None, feed)[0]        # [1, T, 1024] = last_hidden_state
        vec = hidden[:, 0, :]                            # CLS：已由一致性实测钉死
        vec = vec / (np.linalg.norm(vec, axis=-1, keepdims=True) + 1e-12)
        out = [float(v) for v in vec[0]]
        if len(out) != self.dim:
            raise RuntimeError(f"向量维度异常：期望 {self.dim}，实得 {len(out)}")
        return out


class Embedder:
    """对外门面：async 接口 + 编码计时。"""

    def __init__(self, backend: Backend):
        self.backend = backend

    @property
    def name(self) -> str:
        return self.backend.name

    @property
    def model_id(self) -> str:
        return getattr(self.backend, "model_id", self.backend.name)

    async def embed(self, text: str) -> list[float]:
        """B.9 约定的签名：进文本，出 1024 维向量。"""
        vec, _ = await self.embed_timed(text)
        return vec

    async def embed_timed(self, text: str) -> tuple[list[float], float]:
        t0 = time.perf_counter()
        vec = await asyncio.to_thread(self.backend.encode_sync, text)
        return vec, (time.perf_counter() - t0) * 1000


def to_literal(vec: list[float]) -> str:
    """转成 pgvector 的 '[v1,v2,...]' 字面量。

    与 eval-discover.py 的 encode() 完全同款（6 位小数），保证同一条 query
    在脚本里和 API 里得到**逐位相同**的向量，两边的召回数字才对得上。
    """
    return "[" + ",".join(f"{v:.6f}" for v in vec) + "]"


def build_embedder(cfg: Config) -> Embedder:
    if cfg.embed_backend == "local":
        return Embedder(LocalBackend(cfg.embed_model, cfg.embed_dim))
    if cfg.embed_backend == "remote":
        return Embedder(RemoteBackend(cfg.embedding_service_url, cfg.embed_dim))
    if cfg.embed_backend == "onnx":
        return Embedder(
            OnnxBackend(cfg.onnx_model_path, cfg.embed_model, cfg.embed_dim, cfg.onnx_threads)
        )
    raise RuntimeError(f"未实现的编码后端：{cfg.embed_backend}")


def describe(embedder: Embedder) -> dict[str, Any]:
    info: dict[str, Any] = {
        "backend": embedder.name,
        "model": embedder.model_id,
        "dim": getattr(embedder.backend, "dim", None),
        "load_ms": round(getattr(embedder.backend, "load_ms", 0.0), 1),
        "ready": True,
    }
    if embedder.name == "onnx":
        info["onnx_model_path"] = getattr(embedder.backend, "model_path", None)
        info["threads"] = getattr(embedder.backend, "threads", None)
    return info
