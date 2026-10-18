# -*- coding: utf-8 -*-
"""
main.py —— 发现书籍检索 HTTP API（B.9 任务 1）

启动：
    cd api
    C:/Python314/python.exe -m uvicorn main:app --host 127.0.0.1 --port 8000

端点：
    GET  /                          服务信息 / 端点清单
    POST /api/discover              检索（B.8 §9.1 契约）
    GET  /api/discover/health       健康自检（GUC 实测 + 执行计划实测）
    GET  /api/discover/regression   回归检查（?quick=true 跳过 EXACT 扫描）

启动时序（lifespan）：
    配置校验 → 加载 BGE-M3（一次性，常驻）→ 建连接池（每连接执行 db-conn-init.sql）
    → 启动自检（GUC + 返回行数 + 执行计划）→ 自检失败直接拒绝启动
"""
from __future__ import annotations

import json
import logging
import random
import sys
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))   # 平铺导入 compat

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

import config as cfgmod
import regression as regression_mod
from config import ALLOWED_EF_SEARCH, Config
from db import create_pool, pool_stats, run_scalar
from embed import Embedder, build_embedder, describe, to_literal
from init import startup_check
from retrieve import explain_once, report_degradation, search

log = logging.getLogger("discover.api")


# ---------------------------------------------------------------------------
# 结构化日志（一行一 JSON，带 request_id）
# ---------------------------------------------------------------------------

class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(record.created)),
            "level": record.levelname.lower(),
            "logger": record.name,
            "msg": record.getMessage(),
        }
        rid = getattr(record, "request_id", None)
        if rid:
            payload["request_id"] = rid
        return json.dumps(payload, ensure_ascii=False)


def setup_logging() -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(logging.INFO)


# ---------------------------------------------------------------------------
# 错误模型（对齐 server/src/http/errors.ts：{error:{code,message,details?}}）
# ---------------------------------------------------------------------------

class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, details: Any = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.details = details


def error_body(code: str, message: str, details: Any = None) -> dict[str, Any]:
    body: dict[str, Any] = {"error": {"code": code, "message": message}}
    if details is not None:
        body["error"]["details"] = details
    return body


# ---------------------------------------------------------------------------
# 请求 / 响应模型
# ---------------------------------------------------------------------------

class DiscoverRequest(BaseModel):
    query: str = Field(min_length=1)
    top_k: int = Field(default=10, ge=1, le=50)
    include_front_matter: bool = False      # False = 排除 front matter（B.6~B.8 生产口径）
    ef_search: int | None = None            # 省略则用连接池会话级 800
    book_filter: list[str] | None = None    # ⚠ 未实现（见下方校验）
    chapter_filter: list[str] | None = None  # ⚠ 未实现


class DiscoverResponse(BaseModel):
    results: list[dict[str, Any]]
    latency: dict[str, float]
    meta: dict[str, Any]


# ---------------------------------------------------------------------------
# 应用状态
# ---------------------------------------------------------------------------

class State:
    def __init__(self) -> None:
        self.cfg: Config | None = None
        self.embedder: Embedder | None = None
        self.pool = None
        self.check = None
        self.started_at = time.time()
        self.requests = 0
        self.rng = random.Random()


state = State()


@asynccontextmanager
async def lifespan(app: FastAPI):
    setup_logging()
    log.info("=" * 60)
    log.info("发现书籍检索 API 启动中")
    cfg = cfgmod.load()
    log.info("配置就绪：backend=%s model=%s pool=%d~%d 期望 ef=%s/%s",
             cfg.embed_backend, cfg.embed_model, cfg.pool_min, cfg.pool_max,
             cfg.expected_ef_search, cfg.expected_iterative_scan)

    embedder = build_embedder(cfg)          # local 后端在这里加载 2GB 模型，只此一次
    pool = create_pool(cfg)
    check = await startup_check(cfg, pool, embedder, top_k=cfg.top_k_default)
    if not check.ok:
        pool.closeall()
        raise RuntimeError("启动自检失败，拒绝提供服务：" + " | ".join(check.errors))

    state.cfg, state.embedder, state.pool, state.check = cfg, embedder, pool, check
    log.info("启动完成，服务就绪")
    log.info("=" * 60)
    try:
        yield
    finally:
        if state.pool:
            state.pool.closeall()
            log.info("连接池已关闭")


app = FastAPI(
    title="述树 · 发现书籍检索 API",
    version="B.9",
    description="BGE-M3 编码 + pgvector HNSW(ef=800/strict_order) 检索。只读，不写业务表。",
    lifespan=lifespan,
)


@app.middleware("http")
async def request_id_middleware(request: Request, call_next):
    rid = request.headers.get("X-Request-Id") or uuid.uuid4().hex[:16]
    start = time.perf_counter()
    state.requests += 1
    try:
        response = await call_next(request)
    except Exception as exc:  # noqa: BLE001
        ms = (time.perf_counter() - start) * 1000
        log.error("请求异常 %s %s -> %s（%.0f ms）",
                  request.method, request.url.path, type(exc).__name__, ms,
                  extra={"request_id": rid})
        raise
    ms = (time.perf_counter() - start) * 1000
    log.info("%s %s -> %d（%.0f ms）", request.method, request.url.path,
             response.status_code, ms, extra={"request_id": rid})
    response.headers["X-Request-Id"] = rid
    return response


@app.exception_handler(ApiError)
async def api_error_handler(request: Request, exc: ApiError):
    return JSONResponse(status_code=exc.status, content=error_body(exc.code, exc.message, exc.details))


@app.exception_handler(RequestValidationError)
async def validation_handler(request: Request, exc: RequestValidationError):
    return JSONResponse(
        status_code=400,
        content=error_body("bad_request", "请求参数校验失败", exc.errors()),
    )


@app.exception_handler(Exception)
async def unhandled_handler(request: Request, exc: Exception):
    # 不回传堆栈 / 内部细节
    log.error("未处理异常：%s", type(exc).__name__, exc_info=True)
    return JSONResponse(status_code=500, content=error_body("internal_error", "服务器内部错误"))


# ---------------------------------------------------------------------------
# 路由
# ---------------------------------------------------------------------------

@app.get("/")
async def root():
    cfg = state.cfg
    return {
        "service": "述树 · 发现书籍检索 API",
        "version": "B.9",
        "endpoints": ["POST /api/discover", "GET /api/discover/health",
                      "GET /api/discover/regression"],
        "retrieval": {
            "table": "discovered_book_chunks",
            "index": "discovered_book_chunks_embedding_hnsw_idx",
            "ef_search": cfg.expected_ef_search if cfg else None,
            "iterative_scan": cfg.expected_iterative_scan if cfg else None,
            "filter": "chapter_title IS NOT NULL（默认排除 front matter）",
        },
        "embedding": describe(state.embedder) if state.embedder else {"ready": False},
        "uptime_seconds": round(time.time() - state.started_at, 1),
        "requests_served": state.requests,
    }


@app.post("/api/discover")
async def discover(payload: DiscoverRequest):
    cfg = state.cfg
    if cfg is None:
        raise ApiError(503, "service_unavailable", "服务尚未就绪")

    if len(payload.query) > cfg.max_query_chars:
        raise ApiError(400, "bad_request",
                       f"query 过长：{len(payload.query)} 字符，上限 {cfg.max_query_chars}",
                       {"max_query_chars": cfg.max_query_chars})
    if payload.top_k > cfg.top_k_max:
        raise ApiError(400, "bad_request", f"top_k 越界：{payload.top_k}，上限 {cfg.top_k_max}")
    if payload.ef_search is not None and payload.ef_search not in ALLOWED_EF_SEARCH:
        # 只放行 B.6 矩阵实测过的取值 —— 未测过的 ef 可能落进「退化区」，
        # 那不是慢一点，是执行计划换路径（改用 book_idx 全扫 + Sort）。
        raise ApiError(400, "bad_request",
                       f"ef_search={payload.ef_search} 未经实测；可用值 {list(ALLOWED_EF_SEARCH)}",
                       {"allowed": list(ALLOWED_EF_SEARCH)})
    for name, value in (("book_filter", payload.book_filter),
                        ("chapter_filter", payload.chapter_filter)):
        if value:
            # 诚实边界：检索 SQL 必须与已验证脚本逐字一致，加过滤条件会改变执行计划，
            # 需要先单独做一轮路径验证。宁可明确报错，也不给一个没验过的行为。
            raise ApiError(400, "not_implemented",
                           f"{name} 尚未实现：检索 SQL 需与已验证脚本逐字一致，"
                           "新增过滤条件会改变执行计划路径，须先单独验证")

    t_total = time.perf_counter()
    try:
        vec, encode_ms = await state.embedder.embed_timed(payload.query)
    except Exception as exc:  # noqa: BLE001
        raise ApiError(503, "service_unavailable", f"编码服务不可用：{exc}") from exc
    literal = to_literal(vec)

    t_db = time.perf_counter()
    try:
        rows = await search(state.pool, literal, payload.top_k,
                            include_front_matter=payload.include_front_matter,
                            ef_search=payload.ef_search)
    except Exception as exc:  # noqa: BLE001
        raise ApiError(500, "internal_error", f"检索失败：{exc}") from exc
    retrieve_ms = (time.perf_counter() - t_db) * 1000
    e2e_ms = (time.perf_counter() - t_total) * 1000

    # §10.1 拍板第 4 条：1% EXPLAIN ANALYZE 抽样，退化即告警。
    # 抽样开销不计入对外的 retrieve_ms（它属于监控，不属于用户体验）。
    sampled = state.rng.random() < cfg.explain_sample_rate
    sampled_plan = None
    if sampled:
        try:
            parsed = await explain_once(state.pool, literal, payload.top_k,
                                        include_front_matter=payload.include_front_matter)
            sampled_plan = parsed.get("plan_type")
            report_degradation(parsed, f"sample ef={payload.ef_search or cfg.expected_ef_search}")
        except Exception as exc:  # noqa: BLE001  监控不能影响主流程
            log.warning("抽样 EXPLAIN 失败（忽略）：%s", exc)

    results = [{
        "chunk_id": r["chunk_id"],
        "book_id": str(r["book_id"]),
        "title": r["title"],
        "author": r["author"],
        "chapter_title": r["chapter_title"],
        "chunk_index": r["chunk_index"],
        "content": r["content"],
        "score": round(float(r["similarity"]), 6),
    } for r in rows]

    return {
        "results": results,
        "latency": {
            "encode_ms": round(encode_ms, 2),
            "retrieve_ms": round(retrieve_ms, 2),
            "e2e_ms": round(e2e_ms, 2),
        },
        "meta": {
            "top_k": payload.top_k,
            "returned": len(results),
            "ef_search": payload.ef_search if payload.ef_search is not None else cfg.expected_ef_search,
            "iterative_scan": cfg.expected_iterative_scan,
            "include_front_matter": payload.include_front_matter,
            "explain_sampled": sampled,
            "sampled_plan_type": sampled_plan,
        },
    }


@app.get("/api/discover/health")
async def health():
    cfg = state.cfg
    if cfg is None:
        return JSONResponse(status_code=503,
                            content={"status": "starting", "detail": "服务尚未就绪"})

    check = state.check
    # GUC 每次都实测（不读配置，只读连接真实状态）
    try:
        ef_now = str(await run_scalar(state.pool, "SHOW hnsw.ef_search"))
        iscan_now = str(await run_scalar(state.pool, "SHOW hnsw.iterative_scan"))
    except Exception as exc:  # noqa: BLE001
        return JSONResponse(status_code=503, content={
            "status": "error",
            "database": {"status": "error", "detail": str(exc)},
        })

    guc_ok = ef_now == cfg.expected_ef_search and iscan_now == cfg.expected_iterative_scan

    # 执行计划每次实测：用启动时缓存的探针向量，避免每次 health 都花 155ms 编码
    plan = None
    rows_n = None
    if check and check.probe.get("literal"):
        try:
            plan = await explain_once(state.pool, check.probe["literal"], cfg.top_k_default)
            rows_n = plan.get("rows_returned")
        except Exception as exc:  # noqa: BLE001
            plan = {"plan_type": "ERROR", "detail": str(exc)}

    plan_ok = bool(plan) and plan.get("plan_type") == "HNSW"
    rows_ok = rows_n == cfg.top_k_default
    db_ok = guc_ok and plan_ok and rows_ok
    status = "ok" if db_ok else "degraded"

    body = {
        "status": status,
        "database": {
            "status": "ok" if db_ok else "degraded",
            "ef_search": ef_now,
            "iterative_scan": iscan_now,
            "expected": {"ef_search": cfg.expected_ef_search,
                         "iterative_scan": cfg.expected_iterative_scan},
            "guc_match": guc_ok,
        },
        "plan": {
            "type": (plan or {}).get("plan_type"),
            "index": (plan or {}).get("index_name"),
            "scan_node": (plan or {}).get("scan_node"),
            "rows_returned": rows_n,
            "expected_rows": cfg.top_k_default,
            "execution_time_ms": (plan or {}).get("execution_time_ms"),
            "ok": plan_ok and rows_ok,
        },
        "embedding": describe(state.embedder),
        "pool": pool_stats(state.pool),
        "startup_check": {
            "ok": check.ok if check else None,
            "errors": check.errors if check else None,
        },
        "uptime_seconds": round(time.time() - state.started_at, 1),
    }
    return JSONResponse(status_code=200 if db_ok else 503, content=body)


@app.get("/api/discover/regression")
async def regression(quick: bool = False, sample: int = 20, top_k: int = 10,
                     repeats: int = 3, budget: int = 400, seed: int = 20261017):
    cfg = state.cfg
    if cfg is None:
        raise ApiError(503, "service_unavailable", "服务尚未就绪")
    if not (1 <= sample <= 100):
        raise ApiError(400, "bad_request", f"sample 越界：{sample}（1~100）")
    if not (1 <= repeats <= 10):
        raise ApiError(400, "bad_request", f"repeats 越界：{repeats}（1~10）")
    try:
        return await regression_mod.run(
            cfg, quick=quick, sample=sample, top_k=top_k,
            repeats=repeats, budget=budget, seed=seed,
        )
    except RuntimeError as exc:
        raise ApiError(400, "bad_request", str(exc)) from exc


if __name__ == "__main__":
    import uvicorn

    c = cfgmod.load()
    setup_logging()
    uvicorn.run(app, host=c.host, port=c.port)
