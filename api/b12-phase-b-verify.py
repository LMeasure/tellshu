#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""b12-phase-b-verify.py —— B.12 Phase B'：PG 起稳后的**只读核验**

背景：这份 B.12 原本计划由我提权 Start-Service 拉起 PG。实际是环境里已有会话
在 2026-10-21 13:14:05 用**服务方式**把 PG 拉起来了（见报告 §14），所以 Phase B
从「启动」变成「核验」——确认运行实例真的吃到了调优后的配置。

只做 SELECT / SHOW，不写任何业务表，不改任何配置。产物落在 server/.crawl-cache/。

用法：
    python -u api/b12-phase-b-verify.py
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from b11_common import CACHE, connect  # noqa: E402

EXPECT = {"shared_buffers": "2GB", "effective_cache_size": "8GB"}


def log(msg: str) -> None:
    print(msg, flush=True)


def show(cur, name: str) -> str:
    cur.execute(f"SHOW {name};")
    return cur.fetchone()[0]


def main() -> int:
    conn = connect()
    cur = conn.cursor()

    out: dict = {"generated_at": time.strftime("%Y-%m-%d %H:%M:%S"), "stage": "b12-phase-b"}

    log("── 版本与实例 ──")
    cur.execute("SELECT version();")
    ver = cur.fetchone()[0]
    log(f"  {ver}")
    cur.execute("SELECT pg_postmaster_start_time(), now() - pg_postmaster_start_time();")
    started, uptime = cur.fetchone()
    log(f"  postmaster 启动于 {started}   已运行 {uptime}")
    out["started_at"] = str(started)
    out["uptime"] = str(uptime)

    log("\n── 关键参数（期望值来自 B.11 调优决策）──")
    settings = {}
    for name, want in EXPECT.items():
        got = show(cur, name)
        ok = got == want
        settings[name] = {"value": got, "expected": want, "ok": ok}
        log(f"  {name:<22} = {got:<8} 期望 {want:<8} {'OK' if ok else 'MISMATCH'}")
    for name in ("hnsw.ef_search", "hnsw.iterative_scan", "work_mem", "max_connections"):
        settings[name] = {"value": show(cur, name)}
        log(f"  {name:<22} = {settings[name]['value']}")
    out["settings"] = settings

    log("\n── pgvector 与 HNSW 索引 ──")
    cur.execute("SELECT extname, extversion FROM pg_extension WHERE extname = 'vector';")
    row = cur.fetchone()
    log(f"  vector 扩展：{row if row else '未安装'}")
    out["vector_ext"] = row

    cur.execute(
        """
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE tablename = 'discovered_book_chunks'
        ORDER BY indexname;
        """
    )
    idxs = cur.fetchall()
    out["indexes"] = idxs
    log(f"  discovered_book_chunks 上的索引（{len(idxs)} 个）：")
    hnsw_found = False
    for name, ddl in idxs:
        kind = "HNSW" if "hnsw" in ddl else ("ivfflat" if "ivfflat" in ddl else "other")
        if kind == "HNSW":
            hnsw_found = True
        log(f"    - {name}  [{kind}]")
    out["hnsw_present"] = hnsw_found

    log("\n── 数据量 ──")
    cur.execute("SELECT count(*) FROM discovered_book_chunks;")
    chunks = cur.fetchone()[0]
    cur.execute("SELECT count(*) FROM discovered_books;")
    books = cur.fetchone()[0]
    log(f"  chunks = {chunks}    books = {books}")
    out["chunks"] = chunks
    out["books"] = books

    # 索引用的是哪种算子族：必须是 vector_cosine_ops，否则延迟口径不可比
    cur.execute(
        """
        SELECT amname, opcname
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        JOIN pg_am am ON am.oid = c.relam
        JOIN pg_opclass op ON op.oid = ANY(i.indclass)
        WHERE c.relname = %s;
        """,
        ("discovered_book_chunks_embedding_hnsw_idx",),
    )
    rows = cur.fetchall()
    if rows:
        for amname, opcname in rows:
            log(f"  HNSW 索引: access method={amname}  opclass={opcname}")
    out["hnsw_index_meta"] = rows

    conn.close()

    ok = all(v.get("ok", True) for v in (settings[k] for k in EXPECT)) and hnsw_found
    out["verdict_ok"] = ok
    dst = CACHE / "_b12-phase-b-verify.json"
    dst.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    log(f"\n已存：{dst}")
    log(f"判定：{'OK —— 调优配置已生效，HNSW 索引在位' if ok else 'NOT OK —— 见上方 MISMATCH / 缺失项'}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
