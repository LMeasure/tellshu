# -*- coding: utf-8 -*-
"""
db.py —— 连接池（含连接初始化）+ 同步查询的线程卸载

两件事必须做对，否则线上会静默退化：

1. 每条新连接建立后都要执行 db-conn-init.sql：
       SELECT NULL::vector;                     ← 不能省
       SET hnsw.ef_search = 800;
       SET hnsw.iterative_scan = strict_order;
   省掉第一行，pgvector 的 GUC 在本会话还没注册，SET 会变成一个「带命名空间的占位符」
   —— 不报错、SHOW 也能查到，但**不生效**（B.8 实测：off 时 100 条里有 7 条返回 0 行）。
   所以这里除了执行，还要做**功能性验证**（见 init.py：返回 10 行，不是 2 行也不是 0 行）。

2. psycopg2 是同步阻塞的，而 FastAPI 路由是 async。直接在 async 路由里调
   cur.execute() 会把 155ms 的编码 + 检索串行塞进 event loop，整个服务卡住。
   这里统一用 asyncio.to_thread 卸载到线程池，配合 ThreadedConnectionPool
   （同一时刻一个连接只被一个线程持有）是安全的。
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Sequence

import psycopg2
from psycopg2.pool import ThreadedConnectionPool

# 启动方式是 `uvicorn main:app`（cwd = api/），所以模块间用平铺绝对导入，
# 不建 __init__.py —— 相对导入在顶层模块里会直接炸。
from config import Config

log = logging.getLogger("discover.db")


class DiscoverPool(ThreadedConnectionPool):
    """建连接后立刻执行初始化 SQL 的连接池。

    ThreadedConnectionPool 没有 connect 钩子，重写 _connect() 是最小侵入的做法：
    拿到 psycopg2 建好的连接 → 执行 init 语句 → commit → 返回。
    任何一步失败都关掉连接再抛，绝不把「没设上 GUC 的连接」放进池里。
    """

    def __init__(self, minconn: int, maxconn: int, dsn: str, init_statements: Sequence[str]):
        self._init_statements = tuple(init_statements)
        super().__init__(minconn, maxconn, dsn)

    def _connect(self, *args: Any, **kwargs: Any):  # type: ignore[override]
        conn = super()._connect(*args, **kwargs)
        try:
            conn.autocommit = False
            with conn.cursor() as cur:
                for stmt in self._init_statements:
                    cur.execute(stmt)
            conn.commit()
        except Exception:
            conn.close()
            raise
        return conn


def create_pool(cfg: Config) -> DiscoverPool:
    pool = DiscoverPool(cfg.pool_min, cfg.pool_max, cfg.database_url, cfg.init_statements)
    log.info(
        "连接池已建立 min=%d max=%d，每连接执行 %d 条初始化语句",
        cfg.pool_min, cfg.pool_max, len(cfg.init_statements),
    )
    return pool


async def run_query(
    pool: DiscoverPool,
    sql: str,
    params: tuple[Any, ...],
    *,
    ef_search: int | None = None,
    fetch: bool = True,
) -> list[dict[str, Any]]:
    """在线程里执行一条查询，返回 dict 列表。

    ef_search 非空时用事务内 set_config(..., true) 覆盖会话默认值 ——
    这是 B.6/B.7 验证过的唯一正确姿势（裸 SET 会污染连接池里的其它请求）。
    """
    def _run() -> list[dict[str, Any]]:
        conn = pool.getconn()
        try:
            with conn.cursor() as cur:
                if ef_search is not None:
                    cur.execute("SELECT set_config('hnsw.ef_search', %s, true)", (str(ef_search),))
                cur.execute(sql, params)
                if not fetch:
                    conn.commit()
                    return []
                cols = [d[0] for d in cur.description]
                rows = cur.fetchall()
            conn.commit()
            return [dict(zip(cols, r)) for r in rows]
        except Exception:
            conn.rollback()
            raise
        finally:
            pool.putconn(conn)

    return await asyncio.to_thread(_run)


async def run_scalar(pool: DiscoverPool, sql: str, params: tuple[Any, ...] = ()) -> Any:
    """取单行单列（SHOW / count(*) 之类）。"""
    def _run() -> Any:
        conn = pool.getconn()
        try:
            with conn.cursor() as cur:
                cur.execute(sql, params)
                row = cur.fetchone()
            conn.commit()
            return row[0] if row else None
        except Exception:
            conn.rollback()
            raise
        finally:
            pool.putconn(conn)

    return await asyncio.to_thread(_run)


def pool_stats(pool: DiscoverPool) -> dict[str, Any]:
    """连接池当前状态。字段来自 psycopg2 AbstractConnectionPool，取值稳健化。"""
    def _count(attr: str) -> int:
        try:
            return len(getattr(pool, attr))
        except Exception:  # noqa: BLE001
            return -1

    return {
        "minconn": getattr(pool, "minconn", None),
        "maxconn": getattr(pool, "maxconn", None),
        # ThreadedConnectionPool 用 _pool（list）存空闲连接，_used（dict）存已借出的
        "idle": _count("_pool"),
        "in_use": _count("_used"),
    }
