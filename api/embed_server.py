# -*- coding: utf-8 -*-
"""
embed_server.py —— 独立编码进程（**B.10 实验工具，不是产品**）

为什么要有它：
    B.9 抓到一个现象：同一个检索 SQL，在「刚跑完一次 torch 编码」的进程里要 190ms，
    在独立只读进程里只要 35ms。怀疑是 2GB 模型常驻 + torch 满载 CPU 把 PG 的页缓存
    和 CPU 抢走了（共置污染）。要验证就得把编码搬出 API 进程 —— 于是有了这个服务。

它刻意做得很薄：加载模型 → 收文本 → 返回向量。
**没有鉴权、没有重试、没有限流、没有优雅停机** —— 别拿它上生产，它是对照组。

启动：
    cd api && C:/Python314/python.exe -m uvicorn embed_server:app --host 127.0.0.1 --port 8001

接口：
    POST /embed   {"text": "..."}  →  {"vector": [1024 floats], "encode_ms": 12.3}
    GET  /                          →  服务信息（模型 / 维度 / 加载耗时）
"""
from __future__ import annotations

import logging
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from fastapi import FastAPI
from pydantic import BaseModel, Field

import config as cfgmod
from embed import LocalBackend

log = logging.getLogger("embed_server")


class EmbedRequest(BaseModel):
    text: str = Field(min_length=1)


class State:
    backend: LocalBackend | None = None


state = State()


def setup_logging() -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(logging.INFO)


@asynccontextmanager
async def lifespan(app: FastAPI):
    setup_logging()
    cfg = cfgmod.load()
    log.info("独立编码服务启动：model=%s dim=%d", cfg.embed_model, cfg.embed_dim)
    state.backend = LocalBackend(cfg.embed_model, cfg.embed_dim)
    log.info("模型常驻完成，准备接收请求")
    yield
    log.info("编码服务退出")


app = FastAPI(title="述树 · BGE-M3 编码服务（B.10 实验用）", version="B.10", lifespan=lifespan)


@app.get("/")
async def root():
    b = state.backend
    return {
        "service": "BGE-M3 编码服务（B.10 实验工具，非产品）",
        "backend": "local",
        "model": b.model_id if b else None,
        "dim": b.dim if b else None,
        "load_ms": round(b.load_ms, 1) if b else None,
        "ready": b is not None,
    }


@app.post("/embed")
async def embed(req: EmbedRequest):
    if state.backend is None:
        return {"error": {"code": "service_unavailable", "message": "模型尚未就绪"}}
    t0 = time.perf_counter()
    vec = state.backend.encode_sync(req.text)
    encode_ms = (time.perf_counter() - t0) * 1000
    return {"vector": vec, "encode_ms": round(encode_ms, 3), "dim": len(vec)}


if __name__ == "__main__":
    import uvicorn

    c = cfgmod.load()
    setup_logging()
    uvicorn.run(app, host="127.0.0.1", port=int(sys.argv[sys.argv.index("--port") + 1])
                if "--port" in sys.argv else 8001)
