#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
verify-discover.py —— 发现书籍链路库内状态硬校验（只读）

用途：每次 ingest / 重跑 embedding 之后，用真实 SQL 回答这些问题：
    - discovered_books / discovered_book_chunks 各有多少行？有没有重复？
    - chunk 数与 embedding 数是否一致？
    - 维度是否全是 1024？有没有 NaN / Inf？
    - 单位范数是否成立（自点积 ≈ 1）？
    - HNSW cosine 索引在不在、多大？
    - chapter_title 为 NULL 的块有多少（query-time filter 的排除面）？
    - embedding_recipe 分布（v1 旧格式 / v2 新格式各多少）？

本脚本不做任何推断或补全，查不到就如实打印。

用法：
    cd server
    python src/scripts/verify-discover.py
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any, Final

EXPECTED_DIM: Final[int] = 1024


def load_dotenv(root: Path) -> None:
    env_file = root / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, _, value = stripped.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip("'\""))


def scalar(cursor: Any, sql: str, params: tuple[Any, ...] = ()) -> Any:
    cursor.execute(sql, params)
    row = cursor.fetchone()
    return None if row is None else row[0]


def rows(cursor: Any, sql: str, params: tuple[Any, ...] = ()) -> list[tuple[Any, ...]]:
    cursor.execute(sql, params)
    return cursor.fetchall()


def main() -> int:
    root = Path(__file__).resolve().parents[2]
    load_dotenv(root)

    url = os.environ.get("DATABASE_URL")
    if not url:
        print("[FAIL] 缺少环境变量 DATABASE_URL", file=sys.stderr)
        return 2
    try:
        import psycopg2
    except Exception as exc:  # noqa: BLE001
        print(f"[FAIL] psycopg2 不可用：{exc}", file=sys.stderr)
        return 2

    problems: list[str] = []
    connection = psycopg2.connect(url)
    try:
        with connection.cursor() as cursor:
            print("=" * 74)
            print("discover 库内状态校验（只读）")
            print("=" * 74)

            ext = scalar(cursor, "SELECT extversion FROM pg_extension WHERE extname = 'vector'")
            print(f"  pgvector 版本        : {ext}")
            if ext is None:
                problems.append("pgvector 扩展不存在")

            books = scalar(cursor, "SELECT count(*) FROM discovered_books")
            books_u = scalar(
                cursor,
                "SELECT count(*) FROM (SELECT DISTINCT source_site, source_id FROM discovered_books) t",
            )
            print(f"  discovered_books     : {books} 行（去重 (source_site, source_id) = {books_u}）")
            if books != books_u:
                problems.append("discovered_books 出现重复 (source_site, source_id)")

            chunks = scalar(cursor, "SELECT count(*) FROM discovered_book_chunks")
            chunks_u = scalar(
                cursor,
                "SELECT count(*) FROM (SELECT DISTINCT book_id, chunk_index FROM discovered_book_chunks) t",
            )
            with_emb = scalar(cursor, "SELECT count(*) FROM discovered_book_chunks WHERE embedding IS NOT NULL")
            print(f"  chunks               : {chunks} 行（去重 (book_id, chunk_index) = {chunks_u}）")
            print(f"  带 embedding         : {with_emb}")
            if chunks != chunks_u:
                problems.append("discovered_book_chunks 出现重复 (book_id, chunk_index)")
            if chunks != with_emb:
                problems.append(f"chunk 数与 embedding 数不一致：{chunks} vs {with_emb}")

            print()
            print("  --- 维度 ---")
            for dim, count in rows(
                cursor,
                "SELECT vector_dims(embedding), count(*) FROM discovered_book_chunks "
                "WHERE embedding IS NOT NULL GROUP BY 1 ORDER BY 1",
            ):
                flag = "" if dim == EXPECTED_DIM else "   <== 异常"
                print(f"    dim={dim}: {count}{flag}")
                if dim != EXPECTED_DIM:
                    problems.append(f"存在非 {EXPECTED_DIM} 维 embedding：dim={dim} × {count}")

            print("  --- 数值健康 ---")
            # pgvector 的 <#> 是「负内积」，单位向量自乘 = -1，所以范数² = -(v <#> v)。
            # 向量里只要有 NaN 或 ±Inf，自内积必然不再是有限值 —— 用有限性判定即可，
            # 不需要（也无法）把 vector 强转成数组逐元素扫。
            nan_inf = scalar(
                cursor,
                "SELECT count(*) FROM discovered_book_chunks WHERE embedding IS NOT NULL "
                "AND NOT (-(embedding <#> embedding) BETWEEN '-1e30'::float8 AND '1e30'::float8)",
            )
            print(f"    非有限值向量       : {nan_inf}（NaN/Inf 会让自内积越界）")
            if nan_inf:
                problems.append(f"embedding 含 {nan_inf} 个 NaN/Inf 元素")

            norm_min, norm_max, norm_avg = rows(
                cursor,
                "SELECT min(x), max(x), avg(x) FROM ("
                "  SELECT sqrt(-(embedding <#> embedding)) AS x FROM discovered_book_chunks WHERE embedding IS NOT NULL"
                ") t",
            )[0]
            print(f"    范数 min/max/avg   : {float(norm_min):.6f} / {float(norm_max):.6f} / {float(norm_avg):.6f}")
            if float(norm_min) < 0.99 or float(norm_max) > 1.01:
                problems.append("范数偏离 1，normalize 未生效")

            print()
            print("  --- 章节归属 / front matter ---")
            null_ch = scalar(cursor, "SELECT count(*) FROM discovered_book_chunks WHERE chapter_title IS NULL")
            print(f"    chapter_title NULL : {null_ch}（query-time filter 默认排除这部分）")
            for title, count in rows(
                cursor,
                "SELECT COALESCE(b.title, '?'), count(*) FROM discovered_book_chunks c "
                "JOIN discovered_books b ON b.id = c.book_id WHERE c.chapter_title IS NULL "
                "GROUP BY 1 ORDER BY 2 DESC LIMIT 5",
            ):
                print(f"      {count:>6}  {title[:60]}")

            print()
            print("  --- embedding_recipe 分布 ---")
            has_recipe = scalar(
                cursor,
                "SELECT count(*) FROM information_schema.columns "
                "WHERE table_name = 'discovered_book_chunks' AND column_name = 'embedding_recipe'",
            )
            if has_recipe:
                for recipe, count in rows(
                    cursor,
                    "SELECT COALESCE(embedding_recipe, '(null)'), count(*) FROM discovered_book_chunks "
                    "GROUP BY 1 ORDER BY 1",
                ):
                    print(f"    {recipe}: {count}")
            else:
                print("    （表还没有 embedding_recipe 列，全部视为旧格式 v1）")

            print()
            print("  --- 索引 ---")
            for name, method, size in rows(
                cursor,
                "SELECT indexname, coalesce(indexdef, ''), pg_size_pretty(pg_relation_size(indexname::regclass)) "
                "FROM pg_indexes WHERE tablename = 'discovered_book_chunks' ORDER BY indexname",
            ):
                kind = "HNSW" if "hnsw" in method else ("btree" if "btree" in method else "其他")
                ops = "vector_cosine_ops" if "vector_cosine_ops" in method else "-"
                print(f"    {name}  [{kind} / {ops}]  {size}")

            hnsw = scalar(
                cursor,
                "SELECT count(*) FROM pg_indexes WHERE tablename = 'discovered_book_chunks' "
                "AND position('hnsw' in lower(indexdef)) > 0 "
                "AND position('vector_cosine_ops' in lower(indexdef)) > 0",
            )
            if not hnsw:
                problems.append("缺少 HNSW + vector_cosine_ops 索引")
    finally:
        connection.close()

    print()
    print("=" * 74)
    if problems:
        print("[FAIL] 发现问题：")
        for problem in problems:
            print(f"  - {problem}")
        print("=" * 74)
        return 1
    print("[ OK ] 全部校验通过")
    print("=" * 74)
    return 0


if __name__ == "__main__":
    sys.exit(main())
