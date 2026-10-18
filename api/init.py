# -*- coding: utf-8 -*-
"""
init.py —— 应用启动自检（fail fast）

为什么必须有这个文件：
    B.8 证明了「SET hnsw.ef_search = 800」如果前面少了 SELECT NULL::vector，
    会变成一个**看起来成功、SHOW 也能查到、但实际不生效**的占位符。
    只检查「SQL 没报错」是不够的，必须做**功能性验证**：

        拿一条真实 query（带章节过滤）去池里查 top_k=10，
        返回 10 行才算通过；2 行或 0 行 = GUC 没生效 = 拒绝启动。

    宁可启动失败让人来修，也不要带一个静默退化的服务上线。

自检三步：
    ① GUC 实测值 == db-conn-init.sql 里的期望值（800 / strict_order）
    ② 真实 query 返回行数 == top_k（功能验证）
    ③ EXPLAIN 实测 plan_type == HNSW（路径验证）

另外顺便把探针向量（probe literal）缓存下来 —— health 端点每次都重新编码 155ms 太浪费，
这里存一条，之后 health 直接用。
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from config import Config
from db import DiscoverPool, run_scalar
from embed import Embedder, to_literal
from retrieve import explain_once, search

log = logging.getLogger("discover.init")


@dataclass
class StartupCheck:
    ok: bool
    guc: dict[str, Any]
    rows: dict[str, Any]
    plan: dict[str, Any]
    probe: dict[str, Any]
    errors: list[str]


def _pick_probe_query(cfg: Config) -> tuple[str, str] | None:
    """优先复用 B.8 缓存的 query 向量（零成本，且保证与 B.8 同一条口径）。"""
    cache = Path(cfg.paths["vector_cache"])
    qset = Path(cfg.paths["query_set"])
    if not cache.exists() or not qset.exists():
        return None
    try:
        vecs = json.loads(cache.read_text(encoding="utf-8"))
        queries = json.loads(qset.read_text(encoding="utf-8")).get("queries", [])
        for q in queries:
            if q.get("counted") and q["query_id"] in vecs:
                return vecs[q["query_id"]], q["query"]
    except Exception as exc:  # noqa: BLE001
        log.warning("读取 probe 缓存失败（%s），改用现场编码", exc)
    return None


async def startup_check(
    cfg: Config,
    pool: DiscoverPool,
    embedder: Embedder,
    top_k: int = 10,
) -> StartupCheck:
    errors: list[str] = []

    # ---- ① GUC 实测 ----
    # 池里每条连接建连时都执行过 db-conn-init.sql（含 SELECT NULL::vector），
    # 所以这里直接 SHOW 就能拿到真实值；拿不到就是初始化没生效，正是要抓的情况。
    ef_now = str(await run_scalar(pool, "SHOW hnsw.ef_search"))
    iscan_now = str(await run_scalar(pool, "SHOW hnsw.iterative_scan"))
    guc = {
        "ef_search": ef_now,
        "iterative_scan": iscan_now,
        "expected_ef_search": cfg.expected_ef_search,
        "expected_iterative_scan": cfg.expected_iterative_scan,
        "match": ef_now == cfg.expected_ef_search and iscan_now == cfg.expected_iterative_scan,
    }
    if not guc["match"]:
        errors.append(
            f"GUC 未生效：实测 ef_search={ef_now} iterative_scan={iscan_now}，"
            f"期望 {cfg.expected_ef_search}/{cfg.expected_iterative_scan}"
        )

    # ---- ② 功能性验证：真实 query 返回 top_k 行 ----
    cached = _pick_probe_query(cfg)
    if cached:
        literal, probe_text = cached
        probe_source = "向量缓存 _b8-query-vectors.json"
        encode_ms = 0.0
    else:
        probe_text = "一位富家小姐拒绝了门当户对的求婚"
        vec, encode_ms = await embedder.embed_timed(probe_text)
        literal = to_literal(vec)
        probe_source = "启动现场编码"
        log.info("未找到向量缓存，probe 现场编码（%.0f ms）", encode_ms)

    rows = await search(pool, literal, top_k)
    rows_info = {
        "query": probe_text,
        "top_k": top_k,
        "returned": len(rows),
        "passed": len(rows) == top_k,
    }
    if len(rows) != top_k:
        errors.append(
            f"功能验证失败：top_k={top_k} 实际返回 {len(rows)} 行。"
            "（返回 2 行或 0 行 = hnsw.ef_search / iterative_scan 没生效，"
            "典型原因是连接初始化少了 SELECT NULL::vector）"
        )

    # ---- ③ 路径验证 ----
    plan = await explain_once(pool, literal, top_k)
    plan_ok = plan.get("plan_type") == "HNSW"
    if not plan_ok:
        errors.append(
            f"路径验证失败：plan_type={plan.get('plan_type')} "
            f"index={plan.get('index_name')} scan={plan.get('scan_node')}"
        )

    probe = {"source": probe_source, "literal": literal, "encode_ms": round(encode_ms, 2),
             "query": probe_text}

    ok = not errors
    if ok:
        log.info(
            "启动自检通过：ef_search=%s iterative_scan=%s rows=%d/%d plan=%s(%s)",
            ef_now, iscan_now, len(rows), top_k,
            plan.get("plan_type"), plan.get("index_name"),
        )
    else:
        for e in errors:
            log.error("启动自检失败：%s", e)

    return StartupCheck(ok=ok, guc=guc, rows=rows_info, plan=plan, probe=probe, errors=errors)
