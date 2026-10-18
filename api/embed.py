# -*- coding: utf-8 -*-
"""
embed.py —— query 编码后端

三种后端：
  local   （默认）进程内常驻 BGE-M3，应用启动时加载一次，之后一直复用。
  remote  EMBEDDING_SERVICE_URL 指向外部编码服务，HTTP POST 拿向量。
          —— 这是 B.8 §10.1 拍板第 3 条预留的「将来分机部署」接口，本轮共置不启用。
  onnx    仅预留（B.9 任务 2 只做了 ONNX INT8 调研，没实现）。config.py 会直接拒绝启动。

对外接口（B.9 约定）：
  async def embed(text: str) -> list[float]
  async def embed_timed(text: str) -> tuple[list[float], float]   # 附带编码耗时 ms

为什么 embed 必须是 async：BGE-M3 单条编码 P50 155ms，同步调用会把 event loop 顶死，
其它请求全部排队。内部统一用 asyncio.to_thread 卸载。
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import urllib.error
import urllib.request
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

    def __init__(self, base_url: str, dim: int, timeout: float = 5.0):
        self.base_url = base_url.rstrip("/")
        self.dim = dim
        self.timeout = timeout
        self.load_ms = 0.0
        self.model_id = f"remote:{self.base_url}"

    def encode_sync(self, text: str) -> list[float]:
        payload = json.dumps({"text": text}).encode("utf-8")
        req = urllib.request.Request(
            self.base_url + "/encode",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                body = json.loads(resp.read().decode("utf-8"))
        except urllib.error.URLError as exc:
            raise RuntimeError(f"远程编码服务不可用：{exc}") from exc
        vec = body.get("embedding")
        if not isinstance(vec, list) or len(vec) != self.dim:
            raise RuntimeError(f"远程编码返回异常：维度 {len(vec) if isinstance(vec, list) else '?'}，期望 {self.dim}")
        return [float(v) for v in vec]


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
    # onnx 在 config.load() 已被拒绝，这里只是兜底
    raise RuntimeError(f"未实现的编码后端：{cfg.embed_backend}")


def describe(embedder: Embedder) -> dict[str, Any]:
    return {
        "backend": embedder.name,
        "model": embedder.model_id,
        "dim": getattr(embedder.backend, "dim", None),
        "load_ms": round(getattr(embedder.backend, "load_ms", 0.0), 1),
        "ready": True,
    }
