#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
search-discover.py —— Stage 1 / 1.5 检索验收工具（只读，不提供任何 HTTP 服务）

用途：用与 ingest 完全相同的模型与归一化方式，把自然语言查询编码成 1024 维向量，
      在 pgvector 里做余弦检索，打印 query / book / chapter / chunk_index / score。

为什么要单独一个脚本：Stage 2 才会写后端 API，Stage 1 只需要用真实数据验证
「中文 → 英文正文」与「英文 → 英文正文」两类检索是否真的可用。

用法：
    cd server
    python src/scripts/search-discover.py --query "关于爱情与阶级的英文小说"
    python src/scripts/search-discover.py --query "detective solves a murder" --top-k 3
    python src/scripts/search-discover.py --file queries.txt --top-k 3   # 每行一条查询
    python src/scripts/search-discover.py --query "..." --include-front-matter  # 放开无章节块

score 口径：similarity = 1 - (embedding <=> query)，即余弦相似度，越大越相关。

query-time filter（Stage 1.5 起默认开启）：
    默认排除 chapter_title IS NULL 的块 —— 这类块绝大多数是版权声明 / 转录说明 /
    前言 / 插图说明 / 目录等 front matter，以及章节号本身错乱、无法可靠归属的正文。
    注意这只是「检索时过滤」：数据库里这些 chunk 一条都没删，正文与 embedding 全保留。
    需要放开时用 --include-front-matter。
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from typing import Any, Final, Sequence

MODEL_NAME: Final[str] = os.environ.get("EMBED_MODEL", "BAAI/bge-m3")
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


def load_model(offline: bool = True) -> Any:
    from sentence_transformers import SentenceTransformer

    if not offline:
        try:
            model = SentenceTransformer(MODEL_NAME)
            print(f"[ .. ] 模型加载模式 = online，标识 = {model[0].auto_model.name_or_path}")
            return model
        except Exception as exc:  # noqa: BLE001
            print(f"[WARN] 在线加载失败（{exc}），改用本地缓存", file=sys.stderr)
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    model = SentenceTransformer(MODEL_NAME, local_files_only=True)
    print(f"[ .. ] 模型加载模式 = offline(本地缓存)，标识 = {model[0].auto_model.name_or_path}")
    return model


def encode_query(model: Any, query: str) -> list[float]:
    import numpy as np

    vector = model.encode([query], normalize_embeddings=True, convert_to_numpy=True)
    array = np.asarray(vector)
    if array.shape != (1, EXPECTED_DIM):
        raise RuntimeError(f"查询向量形状异常：{array.shape}，期望 (1, {EXPECTED_DIM})")
    if int(np.isnan(array).sum()) or int(np.isinf(array).sum()):
        raise RuntimeError("查询向量含 NaN/Inf")
    return [float(value) for value in array[0]]


def to_vector_literal(vector: Sequence[float]) -> str:
    return "[" + ",".join(f"{value:.6f}" for value in vector) + "]"


def search(
    connection,
    model: Any,
    query: str,
    top_k: int,
    model_filter: str | None,
    include_front_matter: bool = False,
) -> list[dict[str, Any]]:  # type: ignore[no-untyped-def]
    """
    include_front_matter=False（默认）时加 `chapter_title IS NOT NULL` 条件。
    这只是检索期过滤：数据库里的 chunk 与 embedding 一条都不会被删。
    """
    vector = encode_query(model, query)
    literal = to_vector_literal(vector)
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT b.id                                   AS book_id,
                   b.title                                AS title,
                   b.author_display                       AS author,
                   b.language                             AS language,
                   b.rights                               AS rights,
                   c.chunk_index                          AS chunk_index,
                   c.chapter_title                        AS chapter_title,
                   c.content                              AS content,
                   1 - (c.embedding <=> %s::vector)       AS similarity
            FROM discovered_book_chunks c
            JOIN discovered_books b ON b.id = c.book_id
            WHERE c.embedding IS NOT NULL
              AND (%s::text IS NULL OR c.embedding_model = %s)
              AND (%s OR c.chapter_title IS NOT NULL)
            ORDER BY c.embedding <=> %s::vector
            LIMIT %s
            """,
            (literal, model_filter, model_filter, include_front_matter, literal, top_k),
        )
        columns = [description[0] for description in cursor.description]
        rows = cursor.fetchall()
    return [dict(zip(columns, row)) for row in rows]


def snippet(text: str, limit: int = 160) -> str:
    collapsed = " ".join(text.split())
    return collapsed if len(collapsed) <= limit else collapsed[:limit] + "…"


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="discover 语义检索验收")
    parser.add_argument("--query", action="append", default=[], help="查询文本，可重复传入多条")
    parser.add_argument("--file", default=None, help="每行一条查询的文本文件")
    parser.add_argument("--top-k", type=int, default=3)
    parser.add_argument("--model-filter", default=MODEL_NAME, help="只检索该 embedding_model 的块，传空字符串表示不过滤")
    parser.add_argument("--online", action="store_true", help="允许在线加载模型")
    parser.add_argument(
        "--include-front-matter",
        action="store_true",
        help="放开 chapter_title IS NULL 的块（默认排除；仅影响检索，不删数据）",
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    root = Path(__file__).resolve().parents[2]
    load_dotenv(root)

    queries: list[str] = list(args.query)
    if args.file:
        path = Path(args.file)
        if not path.exists():
            print(f"[FAIL] 查询文件不存在：{path}", file=sys.stderr)
            return 2
        queries.extend(line.strip() for line in path.read_text(encoding="utf-8").splitlines() if line.strip())
    if not queries:
        queries = [
            "关于爱情与阶级的英文小说",  # 中文 → 英文
            "a detective investigates a mysterious crime",  # 英文 → 英文
        ]
        print("[ .. ] 未指定查询，使用默认的两条验收查询")

    model_filter = args.model_filter or None
    mode = "含 front matter" if args.include_front_matter else "已排除 chapter_title IS NULL"
    print(f"[ .. ] 检索模式：{mode}")
    try:
        model = load_model(offline=not args.online)
    except Exception as exc:  # noqa: BLE001
        print(f"[FAIL] 模型加载失败：{exc}", file=sys.stderr)
        return 2

    try:
        import psycopg2

        url = os.environ.get("DATABASE_URL")
        if not url:
            print("[FAIL] 缺少环境变量 DATABASE_URL", file=sys.stderr)
            return 2
        connection = psycopg2.connect(url)
    except Exception as exc:  # noqa: BLE001
        print(f"[FAIL] 数据库连接失败：{exc}", file=sys.stderr)
        return 2

    exit_code = 0
    try:
        for index, query in enumerate(queries, start=1):
            print()
            print("=" * 78)
            print(f"Query {index}: {query}")
            print("=" * 78)
            try:
                hits = search(connection, model, query, args.top_k, model_filter)
            except Exception as exc:  # noqa: BLE001
                print(f"[FAIL] 检索失败：{exc}")
                exit_code = 1
                continue
            if not hits:
                print("  （无结果：库中没有 embedding 的 chunk，或不匹配 model 过滤条件）")
                exit_code = 1
                continue
            for rank, hit in enumerate(hits, start=1):
                chapter = hit.get("chapter_title") or "(无章节信息)"
                print(
                    f"  {rank}. score={hit['similarity']:.4f}  "
                    f"book={hit['title']}  author={hit['author'] or 'null'}"
                )
                print(
                    f"     book_id={hit['book_id']} chunk_index={hit['chunk_index']} chapter={chapter} lang={hit['language']}"
                )
                print(f"     rights={hit['rights']}")
                print(f"     snippet: {snippet(hit['content'])}")
    finally:
        connection.close()

    return exit_code


if __name__ == "__main__":
    sys.exit(main())
