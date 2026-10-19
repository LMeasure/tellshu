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

API_ROOT = Path(__file__).resolve().parent
PROJECT_ROOT = API_ROOT.parent
SERVER_CACHE = PROJECT_ROOT / "server" / ".crawl-cache"

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
        # B.10 任务 2：最近一次压测的延迟画像。health 每次都跑压测太贵，
        # 改成启动时从 .crawl-cache 读最近一次结果缓存在内存里。
        self.latency_profile: dict[str, Any] | None = None


state = State()


# ---------------------------------------------------------------------------
# 延迟画像（B.10 任务 2）
# ---------------------------------------------------------------------------

PROFILE_SOURCES = ("_b10-arm-A-r*.json", "_b10-arm-B-r*.json", "_b10-arm-C-r*.json",
                   "_b9-http-bench.json",
                   "_b11-http-bench-onnx.json", "_b11-http-bench-torch.json")

# 压测文件 → 它属于哪种部署形态。混着读会把「共置的 190ms」当成「隔离的 190ms」，
# 那正是 B.10 要消灭的错误，所以这里必须按形态匹配，匹配不上就明确标 mismatch。
#
# B.11 补了两个共置压测（torch 与 onnx 同机同批 query 的 A/B）。两者都是共置，
# 但**编码后端不同**——torch 的 115ms 与 onnx 的 21ms 不能混用，所以按 backend 再分一层。
PROFILE_MODE_PREFIX = {
    "colocated": ("_b10-arm-A-", "_b9-http-bench", "_b11-http-bench-"),
    "isolated": ("_b10-arm-B-", "_b10-arm-C-"),
}

# 共置压测文件 → 它用的是哪个编码后端（B.11）。
# onnx 的产物名字里没有后端信息，靠这里显式声明，不靠猜文件名。
PROFILE_ENGINE_OF_FILE = {
    "_b10-arm-A-": "torch",
    "_b9-http-bench": "torch",
    "_b11-http-bench-onnx": "onnx",
    "_b11-http-bench-torch": "torch",
}


def _engine_of(name: str) -> str:
    for prefix, eng in PROFILE_ENGINE_OF_FILE.items():
        if name.startswith(prefix):
            return eng
    return "unknown"


def load_latency_profile(cfg: Config | None = None) -> dict[str, Any] | None:
    """取最近一次压测的 encode/retrieve/e2e P50，优先选**与当前部署形态一致**的那次。

    不自己跑压测（那是 b9-http-benchmark.py / b10-isolation-experiment.py 的活）。
    两种形态都跑过之后，切换配置时各自拿各自的数字。
    确实拿不到同形态数据时才回退到最近一次，并用 `mode_match=false` 标出来 —— 不假装匹配。
    """
    cache = SERVER_CACHE
    if not cache.exists():
        return None
    mode = cfg.embed_mode if cfg else None

    def newest(prefixes: tuple[str, ...], engine: str | None = None) -> Path | None:
        cands: list[tuple[float, Path]] = []
        for pat in PROFILE_SOURCES:
            for p in cache.glob(pat):
                if prefixes and not p.name.startswith(prefixes):
                    continue
                # 共置压测还要匹配编码后端：torch 的 encode 115ms 与 onnx 的 21ms
                # 是两个世界，拿错了会把预算算错一个数量级。
                if engine and _engine_of(p.name) != engine:
                    continue
                cands.append((p.stat().st_mtime, p))
        if not cands:
            return None
        cands.sort(key=lambda t: t[0], reverse=True)
        return cands[0][1]

    # 后端：onnx / local(torch) / remote。remote 没有对应的共置压测，交给形态匹配兜底。
    engine = (cfg.embed_backend if cfg else None) if mode == "colocated" else None
    latest = newest(PROFILE_MODE_PREFIX.get(mode or "", ()), engine)
    if latest is None and engine:
        latest = newest(PROFILE_MODE_PREFIX.get(mode or "", ()))  # 退化到同形态任意后端
    matched = latest is not None
    if latest is None:
        latest = newest(())          # 回退：任何压测结果都行，但会标 mismatch
    if latest is None:
        return None

    try:
        data = json.loads(latest.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return None
    summary = data.get("summary") or {}
    if not summary:
        return None

    def p50(key: str) -> float | None:
        v = summary.get(key, {}).get("p50") if isinstance(summary.get(key), dict) else None
        return v

    file_engine = _engine_of(latest.name)
    return {
        "mode": mode,
        "source": latest.name,
        "mode_match": matched,
        "engine": file_engine,
        "engine_match": (file_engine == engine) if engine else None,
        "generated_at": data.get("generated_at"),
        "encode_p50_ms": p50("encode_ms"),
        "retrieve_p50_ms": p50("retrieve_ms"),
        "e2e_p50_ms": p50("e2e_ms"),
        "note": ("来自最近一次压测（缓存在内存，health 不实时跑压测）。"
                 "colocated 与 isolated 的 retrieve 相差数倍，"
                 "mode_match=false 表示这次数据与当前部署形态不一致，别直接拿去做预算。"
                 "⚠ B.11 实测：换 ONNX 只改变 encode（torch 115ms → onnx 21ms），"
                 "retrieve 两臂同量级（31.6 vs 30.8 ms）——别指望换后端能改善 retrieve。"),
    }


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
    state.latency_profile = load_latency_profile(cfg)
    log.info("启动完成，服务就绪（编码模式 %s）", cfg.embed_mode)
    if state.latency_profile is None:
        log.warning("未在 .crawl-cache 找到压测结果，latency_profile 将为 null（不编造数字）")
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


async def build_health() -> tuple[dict[str, Any], int]:
    """health 的实际逻辑。抽出成函数，供 /health 与 /status 共用（B.10 任务 4）。"""
    cfg = state.cfg
    if cfg is None:
        return {"status": "starting", "detail": "服务尚未就绪"}, 503

    check = state.check
    # GUC 每次都实测（不读配置，只读连接真实状态）
    try:
        ef_now = str(await run_scalar(state.pool, "SHOW hnsw.ef_search"))
        iscan_now = str(await run_scalar(state.pool, "SHOW hnsw.iterative_scan"))
    except Exception as exc:  # noqa: BLE001
        return {"status": "error", "database": {"status": "error", "detail": str(exc)}}, 503

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
        # B.10 任务 2：延迟画像，标明当前是共置还是隔离 —— 两者的 retrieve 差好几倍，
        # 不标清楚的话很容易拿错口径去做预算。
        "latency_profile": state.latency_profile,
        "pool": pool_stats(state.pool),
        "startup_check": {
            "ok": check.ok if check else None,
            "errors": check.errors if check else None,
        },
        "uptime_seconds": round(time.time() - state.started_at, 1),
    }
    return body, (200 if db_ok else 503)


@app.get("/api/discover/health")
async def health():
    body, code = await build_health()
    return JSONResponse(status_code=code, content=body)


# ---------------------------------------------------------------------------
# B.10 任务 4：status —— health + quick regression 一次调用拿全
# ---------------------------------------------------------------------------

@app.get("/api/discover/status")
async def status():
    """给外部监控系统用的一次性状态端点。

    只做三件便宜的事：health 自检、查行数、用**缓存的斜率**算 N*。
    不跑 EXACT（那要 20 秒），所以响应时间能控制在 200ms 内。
    斜率来源会明确标注；缓存缺失时 N* 为 null —— 不拿假斜率算假数字。
    """
    t0 = time.perf_counter()
    cfg = state.cfg
    body, code = await build_health()

    reg: dict[str, Any] = {"available": False}
    if cfg is not None and state.pool is not None:
        try:
            row_count = int(await run_scalar(state.pool, "SELECT count(*) FROM discovered_book_chunks"))
            slope = intercept = None
            slope_src = None
            # 优先用最近一次完整回归的拟合结果
            for name in ("_b9-regression-http.json", "_b8-regression.json"):
                p = SERVER_CACHE / name
                if not p.exists():
                    continue
                try:
                    d = json.loads(p.read_text(encoding="utf-8"))
                    if d.get("slope_ms_per_1k_rows") is not None:
                        slope = float(d["slope_ms_per_1k_rows"])
                        intercept = float(d["intercept_ms"])
                        slope_src = f"{name}（{d.get('fit_mode', '拟合')}）"
                        break
                except Exception:  # noqa: BLE001
                    continue

            if slope and intercept is not None:
                enc_long = 177.96   # B.6 实测长 query 编码 P50
                n_star = (400 - enc_long - intercept) / slope * 1000
                occupancy = row_count / n_star
                st = "ALERT" if row_count >= n_star else ("WARN" if row_count >= n_star * 0.8 else "OK")
                reg = {
                    "available": True,
                    "row_count": row_count,
                    "n_star_400ms_long_query": round(n_star),
                    "occupancy_pct": round(occupancy * 100, 1),
                    "status": st,
                    "slope_ms_per_1k_rows": round(slope, 4),
                    "intercept_ms": round(intercept, 2),
                    "slope_source": slope_src,
                    "caveat": "N* 用缓存斜率算（不跑 EXACT）。斜率会随硬件负载变化，"
                              "要精确判定请跑 GET /api/discover/regression 完整模式。",
                }
            else:
                reg = {"available": True, "row_count": row_count,
                       "n_star_400ms_long_query": None, "occupancy_pct": None, "status": None,
                       "slope_source": None,
                       "caveat": "缺少缓存斜率（未跑过完整回归），N* 无法计算。"
                                 "先跑 GET /api/discover/regression 完整模式。"}
        except Exception as exc:  # noqa: BLE001
            reg = {"available": False, "detail": str(exc)}

    payload = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "health": body,
        "regression_quick": reg,
        "status_elapsed_ms": round((time.perf_counter() - t0) * 1000, 1),
    }
    return JSONResponse(status_code=code, content=payload)


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
