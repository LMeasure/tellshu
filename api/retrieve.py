# -*- coding: utf-8 -*-
"""
retrieve.py —— 检索 SQL 与执行

⚠ 红线：检索 SQL **从现有脚本复制，不重写**。

本文件的 SEARCH_SQL 与 server/src/scripts/eval-discover.py 里 --source main 分支的 SQL
逐字一致，只多出两列投影：

    c.id AS chunk_id,
    b.id AS book_id,

加这两列是为了满足 B.8 §9.1 定下的响应契约（results[] 里有 chunk_id / book_id）。
FROM / JOIN / WHERE / ORDER BY / LIMIT 一字未动 —— 也就是说**检索路径、过滤口径、
排序方向、截断条数全部保持已验证状态**。加投影列不影响执行计划，这一点由
GET /api/discover/health 的实测 plan（plan_type=HNSW）持续兜底。

参数顺序（与 eval-discover.py 一致）：(literal, include_front_matter, literal, top_k)
    include_front_matter=False → WHERE 里的 (false OR c.chapter_title IS NOT NULL)
    即「排除 front matter」，这是 B.6/B.7/B.8 全部实测用的生产口径。
"""
from __future__ import annotations

import asyncio
import logging
import random
from typing import Any, Sequence

from config import Config
from db import DiscoverPool, run_query

log = logging.getLogger("discover.retrieve")

HNSW_INDEX = "discovered_book_chunks_embedding_hnsw_idx"

SEARCH_SQL = """
            SELECT c.id                             AS chunk_id,
                   b.id                             AS book_id,
                   b.title                          AS title,
                   b.author_display                 AS author,
                   c.chunk_index                    AS chunk_index,
                   c.chapter_title                  AS chapter_title,
                   c.content                        AS content,
                   1 - (c.embedding <=> %s::vector) AS similarity
            FROM discovered_book_chunks c
            JOIN discovered_books b ON b.id = c.book_id
            WHERE c.embedding IS NOT NULL
              AND (%s OR c.chapter_title IS NOT NULL)
            ORDER BY c.embedding <=> %s::vector
            LIMIT %s
        """

EXPLAIN_PREFIX = "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) "


def _walk(node: dict[str, Any]):
    """递归遍历 EXPLAIN JSON 的计划树（顶层是 [{"Plan": {...}}]，子计划在 "Plans" 里）。"""
    yield node
    for child in node.get("Plans") or []:
        yield from _walk(child)


def parse_plan_json(raw: Any) -> dict[str, Any]:
    """从 EXPLAIN (FORMAT JSON) 的结果里提取「到底走了哪条路」。

    判路径只能看**索引名**，不能看「有没有 Index Scan」——
    B.7 实测：ef 升高时优化器会改用 discovered_book_chunks_book_idx 扫全表 + Sort，
    那也是 Index Scan，但它是变相精确检索，比 Seq Scan 还慢。
    """
    plan = raw[0] if isinstance(raw, list) and raw else (raw if isinstance(raw, dict) else {})
    root = plan.get("Plan") if isinstance(plan, dict) else None
    if not isinstance(root, dict):
        return {"plan_type": "UNKNOWN", "index_name": None, "scan_node": None,
                "rows_returned": None, "execution_time_ms": None,
                "shared_hit": None, "shared_read": None}

    index_name: str | None = None
    scan_node: str | None = None
    hit = read = 0
    for node in _walk(root):
        if index_name is None and node.get("Index Name"):
            index_name = node["Index Name"]
        if scan_node is None and "Scan" in (node.get("Node Type") or ""):
            scan_node = node["Node Type"]
        hit += int(node.get("Shared Hit Blocks") or 0)
        read += int(node.get("Shared Read Blocks") or 0)

    if index_name == HNSW_INDEX:
        plan_type = "HNSW"
    elif index_name is not None:
        plan_type = "FALLBACK"
    elif scan_node == "Seq Scan":
        plan_type = "EXACT"
    else:
        plan_type = "UNKNOWN"

    return {
        "plan_type": plan_type,
        "index_name": index_name,
        "scan_node": scan_node,
        "rows_returned": int(root.get("Actual Rows") or 0),
        "execution_time_ms": round(float(plan.get("Execution Time") or 0), 3),
        "shared_hit": hit,
        "shared_read": read,
    }


async def search(
    pool: DiscoverPool,
    literal: str,
    top_k: int,
    *,
    include_front_matter: bool = False,
    ef_search: int | None = None,
) -> list[dict[str, Any]]:
    return await run_query(
        pool, SEARCH_SQL, (literal, include_front_matter, literal, top_k),
        ef_search=ef_search,
    )


async def explain_once(
    pool: DiscoverPool,
    literal: str,
    top_k: int,
    *,
    include_front_matter: bool = False,
) -> dict[str, Any]:
    """跑一次 EXPLAIN ANALYZE 并返回解析结果（用于 health 自检与抽样监控）。"""
    def _run() -> Any:
        conn = pool.getconn()
        try:
            with conn.cursor() as cur:
                cur.execute(EXPLAIN_PREFIX + SEARCH_SQL,
                            (literal, include_front_matter, literal, top_k))
                row = cur.fetchone()
            conn.commit()
            return row[0] if row else None
        except Exception:
            conn.rollback()
            raise
        finally:
            pool.putconn(conn)

    raw = await asyncio.to_thread(_run)
    return parse_plan_json(raw)


def maybe_watch_degradation(cfg: Config, rng: random.Random) -> bool:
    """§10.1 拍板第 4 条：1% 抽样。返回 True 表示本次请求要做 EXPLAIN。"""
    return rng.random() < cfg.explain_sample_rate


def report_degradation(parsed: dict[str, Any], context: str) -> None:
    """抽样发现路径退化时告警。退化 = 没走 HNSW（FALLBACK / EXACT / UNKNOWN）。"""
    if parsed.get("plan_type") != "HNSW":
        log.warning(
            "检索路径退化告警 | %s | plan_type=%s index=%s scan=%s exec_ms=%s rows=%s",
            context, parsed.get("plan_type"), parsed.get("index_name"),
            parsed.get("scan_node"), parsed.get("execution_time_ms"),
            parsed.get("rows_returned"),
        )
