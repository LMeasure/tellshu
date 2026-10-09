#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ingest-books.py —— 发现书籍链路 Stage 1：raw JSON → PostgreSQL + pgvector

链路位置：
    crawl-books.ts → raw JSON（server/.crawl-cache） → 【本脚本】 → chunk → BGE-M3 → pgvector

职责：
    1. 读取 crawler 产出的原始 JSON
    2. 校验字段（缺字段即记失败，不补默认值冒充真实数据）
    3. upsert discovered_books（唯一键 source_site + source_id）
    4. 切块（自实现的 RecursiveCharacterTextSplitter 同款逻辑，不引 langchain）
    5. BGE-M3 1024 维 embedding（本地模型，离线优先；不调用任何云端 API）
    6. upsert discovered_book_chunks（唯一键 book_id + chunk_index）
    7. 任何失败都记录，最终输出成功/失败统计与失败清单

幂等性：重复执行不会产生重复书籍或重复 chunk；embedding 会按 source_sha256 判断是否需要重算。

用法：
    cd server
    python src/scripts/ingest-books.py --in .crawl-cache
    python src/scripts/ingest-books.py --in .crawl-cache --batch 8 --limit 2
    python src/scripts/ingest-books.py --in .crawl-cache --skip-existing-embeddings
    python src/scripts/ingest-books.py --in .crawl-cache --dry-run   # 只切块不写库不加载模型

环境变量：
    DATABASE_URL      必填（从 server/.env 读取）
    EMBED_MODEL       可选，默认 BAAI/bge-m3
    EMBED_OFFLINE     可选，默认 1（强制本地缓存加载，避免 HF Hub 走代理 502）
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import traceback
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Final, Iterable, Sequence

# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------

MODEL_NAME: Final[str] = os.environ.get("EMBED_MODEL", "BAAI/bge-m3")
EXPECTED_DIM: Final[int] = 1024
VECTOR_LITERAL_DIM: Final[int] = 1024

# ---------------------------------------------------------------------------
# embedding 输入格式版本（recipe）
#
# v1-book-chapter          Stage 1 旧格式： "Book: <title>\nChapter: <chapter>\n\n<正文>"
# v2-title-author-chapter  Stage 1.5 新格式："Title: <title>\nAuthor: <author>\nChapter: <chapter>\n<正文>"
#
# 为什么要记版本：改了输入格式就必须重算全部向量，且必须能证明「库里没有新旧混用」。
# 旧向量在重算前会备份到 discovered_book_chunks_emb_v1，不静默丢弃。
# ---------------------------------------------------------------------------
EMBED_RECIPE_V1: Final[str] = "v1-book-chapter"
EMBED_RECIPE_V2: Final[str] = "v2-title-author-chapter"
CURRENT_RECIPE: Final[str] = os.environ.get("EMBED_RECIPE", EMBED_RECIPE_V2)
BACKUP_TABLE: Final[str] = "discovered_book_chunks_emb_v1"

# 切块：与 RecursiveCharacterTextSplitter 同款的递归分隔逻辑
# 分隔符优先级来自任务约定（先段落，再换行，再中英句末标点，最后退到字符）
SEPARATORS: Final[list[str]] = ["\n\n", "\n", "。", "！", "？", ".", "!", "?", " "]
DEFAULT_CHUNK_SIZE: Final[int] = 500
DEFAULT_CHUNK_OVERLAP: Final[int] = 80
MIN_CHUNK_CHARS: Final[int] = 40  # 过短的残块并入前一块，避免出现无意义碎片


# ---------------------------------------------------------------------------
# 输出辅助
# ---------------------------------------------------------------------------


def ok(message: str) -> None:
    print(f"[ OK ] {message}")


def info(message: str) -> None:
    print(f"[ .. ] {message}")


def warn(message: str) -> None:
    print(f"[WARN] {message}", file=sys.stderr)


def fail(message: str) -> None:
    print(f"[FAIL] {message}", file=sys.stderr)


# ---------------------------------------------------------------------------
# 切块器（自实现，不引 langchain）
# ---------------------------------------------------------------------------


def _split_text_with_separator(text: str, separator: str) -> list[str]:
    """按 separator 切分，并把 separator 保留在前一段末尾，尽量不破坏句子完整性。"""
    if separator == "":
        return list(text)
    parts = text.split(separator)
    if len(parts) == 1:
        return parts
    result: list[str] = []
    for index, part in enumerate(parts[:-1]):
        result.append(part + separator)
    last = parts[-1]
    if last:
        result.append(last)
    return result


def recursive_split(text: str, chunk_size: int, separators: Sequence[str]) -> list[str]:
    """递归切分：能用大分隔符就先用，剩下的块再用更细的分隔符继续拆。"""
    if len(text) <= chunk_size:
        return [text] if text.strip() else []

    for index, separator in enumerate(separators):
        if separator == "":
            break
        pieces = _split_text_with_separator(text, separator)
        if len(pieces) == 1:
            continue
        child_separators = separators[index + 1 :]
        result: list[str] = []
        for piece in pieces:
            if len(piece) <= chunk_size:
                result.append(piece)
            else:
                result.extend(recursive_split(piece, chunk_size, child_separators))
        return [piece for piece in result if piece]

    # 所有分隔符都用尽（例如整段无标点）→ 只能硬切
    return [text[i : i + chunk_size] for i in range(0, len(text), chunk_size)]


def merge_short_pieces(pieces: list[str], min_chars: int) -> list[str]:
    """把过短的碎片并入前一块，避免出现「。」这种无意义 chunk。"""
    merged: list[str] = []
    for piece in pieces:
        if merged and len(piece.strip()) < min_chars:
            merged[-1] = merged[-1] + piece
        else:
            merged.append(piece)
    return merged


def split_with_overlap(
    text: str,
    chunk_size: int = DEFAULT_CHUNK_SIZE,
    chunk_overlap: int = DEFAULT_CHUNK_OVERLAP,
    separators: Sequence[str] = SEPARATORS,
    min_chars: int = MIN_CHUNK_CHARS,
) -> list[str]:
    """
    RecursiveCharacterTextSplitter 同款思路：
      ① 按分隔符优先级递归切到 ≤chunk_size
      ② 相邻碎块按 chunk_overlap 做重叠拼接（保留上下文，避免生硬切断句子）
    """
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    pieces = merge_short_pieces(recursive_split(normalized, chunk_size, separators), min_chars)
    if not pieces:
        return []

    chunks: list[str] = []
    buffer = ""
    for piece in pieces:
        candidate = buffer + piece if buffer else piece
        if len(candidate) <= chunk_size:
            buffer = candidate
            continue
        # 先把当前 buffer 出块
        if buffer:
            chunks.append(buffer)
            overlap_tail = buffer[-chunk_overlap:] if chunk_overlap > 0 else ""
        else:
            overlap_tail = ""
        # piece 自身仍超限 → 硬切成 chunk_size 的窗口（带 overlap）
        if len(piece) > chunk_size:
            step = max(1, chunk_size - chunk_overlap)
            start = 0
            while start < len(piece):
                window = piece[start : start + chunk_size]
                if overlap_tail and start == 0:
                    window = overlap_tail + window
                chunks.append(window)
                if start + chunk_size >= len(piece):
                    break
                start += step
            buffer = ""
        else:
            buffer = overlap_tail + piece
    if buffer.strip():
        chunks.append(buffer)

    # 去掉因 overlap 拼接产生的全空白块
    return [chunk for chunk in chunks if chunk.strip()]


# ---------------------------------------------------------------------------
# 数据结构
# ---------------------------------------------------------------------------


@dataclass
class Failure:
    book_source_id: str | None
    book_title: str | None
    stage: str  # load | validate | upsert_book | chunk | embed | upsert_chunk
    error_type: str
    message: str
    chunk_index: int | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "book_source_id": self.book_source_id,
            "book_title": self.book_title,
            "stage": self.stage,
            "error_type": self.error_type,
            "message": self.message,
            "chunk_index": self.chunk_index,
        }


@dataclass
class Stats:
    files_found: int = 0
    books_upserted: int = 0
    books_skipped_invalid: int = 0
    chunks_written: int = 0
    chunks_updated: int = 0
    chunks_skipped_unchanged: int = 0
    embeddings_computed: int = 0
    books_rolled_back: int = 0
    failures: list[Failure] = field(default_factory=list)

    def add_failure(self, failure: Failure) -> None:
        self.failures.append(failure)


# ---------------------------------------------------------------------------
# raw JSON 读取与校验
# ---------------------------------------------------------------------------

REQUIRED_FIELDS: Final[tuple[str, ...]] = ("source_id", "source_site", "source_url", "text")


def load_books(input_dir: Path, limit: int | None) -> tuple[list[dict[str, Any]], list[Failure]]:
    books: list[dict[str, Any]] = []
    failures: list[Failure] = []
    files = sorted(p for p in input_dir.glob("*.json") if p.name != "_manifest.json")
    for path in files:
        try:
            with path.open("r", encoding="utf-8") as handle:
                payload = json.load(handle)
        except Exception as exc:  # noqa: BLE001 - 失败原因必须完整可见
            failures.append(
                Failure(None, None, "load", type(exc).__name__, f"{path.name}: {exc}")
            )
            continue
        if not isinstance(payload, dict):
            failures.append(
                Failure(None, None, "load", "schema", f"{path.name}: 顶层不是 object")
            )
            continue
        missing = [name for name in REQUIRED_FIELDS if not payload.get(name)]
        if missing:
            failures.append(
                Failure(
                    payload.get("source_id"),
                    payload.get("title"),
                    "validate",
                    "missing_field",
                    f"{path.name}: 缺少必填字段 {', '.join(missing)}",
                )
            )
            continue
        copyright_info = payload.get("copyright") or {}
        if copyright_info.get("decision") != "include":
            failures.append(
                Failure(
                    payload.get("source_id"),
                    payload.get("title"),
                    "validate",
                    "copyright_not_cleared",
                    f"{path.name}: copyright.decision={copyright_info.get('decision')}（非 include，拒绝入库）",
                )
            )
            continue
        books.append(payload)
        if limit is not None and len(books) >= limit:
            break
    return books, failures


# ---------------------------------------------------------------------------
# 章节归属：把每个 chunk 映射到它所属章节（无可靠章节则为 None）
# ---------------------------------------------------------------------------


@dataclass
class ChapterAnchor:
    start: int
    title: str | None
    number: int | None


def build_chapter_anchors(
    text: str, chapters: list[dict[str, Any]] | None
) -> list[ChapterAnchor]:
    """
    crawler 给的是「行数」，这里换算成「字符偏移」。
    章节信息为 null（无法可靠识别）时返回空列表 —— 不猜测章节归属。
    """
    anchors: list[ChapterAnchor] = []
    if not chapters:
        return anchors
    offsets: list[int] = [0]
    for line in text.split("\n"):
        offsets.append(offsets[-1] + len(line) + 1)
    for entry in chapters:
        line_no = entry.get("source_line")
        title = entry.get("title")
        number = entry.get("number")
        if not isinstance(line_no, int) or line_no < 0 or line_no >= len(offsets):
            continue
        anchors.append(
            ChapterAnchor(
                start=offsets[line_no],
                title=title if isinstance(title, str) and title else None,
                number=number if isinstance(number, int) else None,
            )
        )
    anchors.sort(key=lambda anchor: anchor.start)
    return anchors


def find_chapter(anchors: list[ChapterAnchor], position: int) -> tuple[str | None, int | None]:
    current: tuple[str | None, int | None] = (None, None)
    for anchor in anchors:
        if anchor.start <= position:
            current = (anchor.title, anchor.number)
        else:
            break
    return current


# ---------------------------------------------------------------------------
# Embedding
# ---------------------------------------------------------------------------


class Embedder:
    """sentence-transformers + BGE-M3。在线优先，失败退回本地缓存；加载成功即打印所用模式。"""

    def __init__(self, offline: bool = True) -> None:
        self.offline = offline
        self.mode: str = "未加载"
        self.model_name: str = MODEL_NAME
        self.max_seq_length: int | None = None
        self._model: Any = None

    def load(self) -> None:
        try:
            from sentence_transformers import SentenceTransformer  # 延迟导入，报错可读
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(f"sentence-transformers 未安装或不可用：{exc}") from exc

        last_error: Exception | None = None
        if not self.offline:
            try:
                self._model = SentenceTransformer(MODEL_NAME)
                self.mode = "online"
            except Exception as exc:  # noqa: BLE001 - HF Hub 走代理会 502，需退到本地
                last_error = exc
                warn(f"在线加载 {MODEL_NAME} 失败（{exc}），改用本地缓存重试")
        if self._model is None:
            os.environ.setdefault("HF_HUB_OFFLINE", "1")
            try:
                self._model = SentenceTransformer(MODEL_NAME, local_files_only=True)
                self.mode = "offline(本地缓存)"
            except Exception as exc:  # noqa: BLE001
                detail = f"{exc}" + (f"；在线尝试亦失败：{last_error}" if last_error else "")
                raise RuntimeError(detail) from exc

        try:
            identifier = self._model[0].auto_model.name_or_path
        except Exception:  # noqa: BLE001 - sentence-transformers 6.x 没有顶层 model_name_or_path
            identifier = MODEL_NAME
        self.model_name = str(identifier)
        if MODEL_NAME not in self.model_name:
            raise RuntimeError(f"加载到的模型不是 {MODEL_NAME}（实际 {self.model_name}）")
        try:
            self.max_seq_length = int(self._model.max_seq_length)
        except Exception:  # noqa: BLE001
            self.max_seq_length = None
        ok(f"模型已加载（模式 = {self.mode}，标识 = {self.model_name}，max_seq_length = {self.max_seq_length}）")

    def encode(self, texts: list[str], batch_size: int) -> Any:
        if self._model is None:
            raise RuntimeError("模型未加载")
        return self._model.encode(
            texts,
            batch_size=batch_size,
            normalize_embeddings=True,
            show_progress_bar=False,
            convert_to_numpy=True,
        )


def validate_vectors(matrix: Any, expected_rows: int) -> list[list[float]]:
    import numpy as np

    array = np.asarray(matrix)
    if array.ndim != 2:
        raise ValueError(f"embedding 输出不是二维矩阵：shape={array.shape}")
    if array.shape[0] != expected_rows:
        raise ValueError(f"embedding 行数不符：{array.shape[0]} != {expected_rows}")
    if array.shape[1] != EXPECTED_DIM:
        raise ValueError(f"维度不符：{array.shape[1]} != {EXPECTED_DIM}")
    nan_count = int(np.isnan(array).sum())
    inf_count = int(np.isinf(array).sum())
    if nan_count or inf_count:
        raise ValueError(f"embedding 含非法值：NaN={nan_count}, Inf={inf_count}")
    norms = np.linalg.norm(array, axis=1)
    if float(norms.min()) < 0.99 or float(norms.max()) > 1.01:
        raise ValueError(
            f"normalize_embeddings 未生效：范数范围 [{float(norms.min()):.4f}, {float(norms.max()):.4f}]"
        )
    return [[float(value) for value in row] for row in array]


def to_vector_literal(vector: Sequence[float]) -> str:
    return "[" + ",".join(f"{value:.6f}" for value in vector) + "]"


# ---------------------------------------------------------------------------
# 数据库
# ---------------------------------------------------------------------------


def connect():  # type: ignore[no-untyped-def]
    import psycopg2

    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError("缺少环境变量 DATABASE_URL")
    return psycopg2.connect(url)


def upsert_book(connection, book: dict[str, Any]) -> int:  # type: ignore[no-untyped-def]
    copyright_info = book.get("copyright") or {}
    issued = book.get("issued")
    issued_value = issued if isinstance(issued, str) and issued.strip() else None

    with connection.cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO discovered_books (
                source_site, source_id, source_url, title, alternative_title, author_display,
                description, description_source, rights, license_raw, license_url, language,
                issued, cover_url, toc_from_rdf, subjects_lcsh, bookshelves, reading_ease,
                rank_in_top_list, copyright_policy, copyright_reason_code, max_author_death_year,
                authors, contributors, text_url, text_sha256, crawl_time
            ) VALUES (
                %(source_site)s, %(source_id)s, %(source_url)s, %(title)s, %(alternative_title)s, %(author_display)s,
                %(description)s, %(description_source)s, %(rights)s, %(license_raw)s, %(license_url)s, %(language)s,
                %(issued)s, %(cover_url)s, %(toc_from_rdf)s, %(subjects_lcsh)s, %(bookshelves)s, %(reading_ease)s,
                %(rank_in_top_list)s, %(copyright_policy)s, %(copyright_reason_code)s, %(max_author_death_year)s,
                %(authors)s::jsonb, %(contributors)s::jsonb, %(text_url)s, %(text_sha256)s, %(crawl_time)s
            )
            ON CONFLICT (source_site, source_id) DO UPDATE SET
                source_url = EXCLUDED.source_url,
                title = EXCLUDED.title,
                alternative_title = EXCLUDED.alternative_title,
                author_display = EXCLUDED.author_display,
                description = EXCLUDED.description,
                description_source = EXCLUDED.description_source,
                rights = EXCLUDED.rights,
                license_raw = EXCLUDED.license_raw,
                license_url = EXCLUDED.license_url,
                language = EXCLUDED.language,
                issued = EXCLUDED.issued,
                cover_url = EXCLUDED.cover_url,
                toc_from_rdf = EXCLUDED.toc_from_rdf,
                subjects_lcsh = EXCLUDED.subjects_lcsh,
                bookshelves = EXCLUDED.bookshelves,
                reading_ease = EXCLUDED.reading_ease,
                rank_in_top_list = EXCLUDED.rank_in_top_list,
                copyright_policy = EXCLUDED.copyright_policy,
                copyright_reason_code = EXCLUDED.copyright_reason_code,
                max_author_death_year = EXCLUDED.max_author_death_year,
                authors = EXCLUDED.authors,
                contributors = EXCLUDED.contributors,
                text_url = EXCLUDED.text_url,
                text_sha256 = EXCLUDED.text_sha256,
                crawl_time = EXCLUDED.crawl_time,
                updated_at = now()
            RETURNING id
            """,
            {
                "source_site": book.get("source_site"),
                "source_id": book.get("source_id"),
                "source_url": book.get("source_url"),
                "title": book.get("title"),
                "alternative_title": book.get("alternative_title"),
                "author_display": book.get("author_display"),
                "description": book.get("description"),
                "description_source": book.get("description_source"),
                "rights": book.get("rights"),
                "license_raw": book.get("license_raw"),
                "license_url": book.get("license_url"),
                "language": book.get("language"),
                "issued": issued_value,
                "cover_url": book.get("cover_url"),
                "toc_from_rdf": book.get("toc_from_rdf"),
                "subjects_lcsh": book.get("subjects_lcsh") or [],
                "bookshelves": book.get("bookshelves") or [],
                "reading_ease": book.get("reading_ease"),
                "rank_in_top_list": book.get("rank_in_top_list"),
                "copyright_policy": copyright_info.get("policy", "A"),
                "copyright_reason_code": copyright_info.get("reason_code"),
                "max_author_death_year": copyright_info.get("max_author_death_year"),
                "authors": json.dumps(book.get("authors") or [], ensure_ascii=False),
                "contributors": json.dumps(book.get("contributors") or [], ensure_ascii=False),
                "text_url": book.get("text_url"),
                "text_sha256": book.get("text_sha256"),
                "crawl_time": book.get("crawl_time"),
            },
        )
        row = cursor.fetchone()
    if row is None:
        raise RuntimeError("upsert discovered_books 未返回 id")
    return int(row[0])


def existing_embedding_signature(connection, book_id: int) -> dict[int, tuple[str, str]]:  # type: ignore[no-untyped-def]
    """
    返回 {chunk_index: (内容哈希, embedding_recipe)}。
    带 recipe 是为了区分「内容没变但 embedding 格式变了」这种情况 —— 后者必须重算。
    """
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT chunk_index, source_sha256, embedding_recipe FROM discovered_book_chunks WHERE book_id = %s",
            (book_id,),
        )
        return {
            int(index): (signature or "", recipe or EMBED_RECIPE_V1)
            for index, signature, recipe in cursor.fetchall()
        }


def backup_embeddings(connection, table: str = BACKUP_TABLE) -> str:  # type: ignore[no-untyped-def]
    """
    重算 embedding 之前把旧向量整表备份一次 —— 这是「不静默丢弃旧 embedding」的兜底。
    备份表已存在时不覆盖（重跑安全）。表名是模块常量，不接受外部输入。
    """
    with connection.cursor() as cursor:
        cursor.execute("SELECT to_regclass(%s)", (table,))
        if cursor.fetchone()[0] is not None:
            cursor.execute(f"SELECT count(*) FROM {table}")
            return f"备份表 {table} 已存在（{cursor.fetchone()[0]} 行），本次不覆盖"
        cursor.execute(
            f"CREATE TABLE {table} AS "
            "SELECT book_id, chunk_index, embedding, embedding_model, embedding_dim, embedding_recipe "
            "FROM discovered_book_chunks WHERE embedding IS NOT NULL"
        )
        cursor.execute(f"CREATE INDEX {table}_bk_idx ON {table} (book_id, chunk_index)")
        cursor.execute(f"SELECT count(*) FROM {table}")
        count = cursor.fetchone()[0]
    connection.commit()
    return f"已创建备份表 {table}（{count} 行，旧 embedding 完整保留）"


def upsert_chunk(
    connection,  # type: ignore[no-untyped-def]
    book_id: int,
    chunk_index: int,
    chapter_title: str | None,
    chapter_number: int | None,
    content: str,
    source_sha256: str,
    embedding: Sequence[float] | None,
    model_name: str,
    recipe: str,
) -> None:
    with connection.cursor() as cursor:
        if embedding is None:
            # 只更新元数据、不动 embedding：embedding_recipe 也必须保持原值，
            # 否则会把「还没重算的旧向量」误标成新格式。
            cursor.execute(
                """
                INSERT INTO discovered_book_chunks (
                    book_id, chunk_index, chapter_title, chapter_number, content, content_chars,
                    embedding_model, embedding_dim, embedding_recipe, source_sha256
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (book_id, chunk_index) DO UPDATE SET
                    chapter_title = EXCLUDED.chapter_title,
                    chapter_number = EXCLUDED.chapter_number,
                    content = EXCLUDED.content,
                    content_chars = EXCLUDED.content_chars,
                    source_sha256 = EXCLUDED.source_sha256,
                    updated_at = now()
                """,
                (
                    book_id,
                    chunk_index,
                    chapter_title,
                    chapter_number,
                    content,
                    len(content),
                    model_name,
                    VECTOR_LITERAL_DIM,
                    recipe,
                    source_sha256,
                ),
            )
            cursor.execute(
                """
                INSERT INTO discovered_book_chunks (
                    book_id, chunk_index, chapter_title, chapter_number, content, content_chars,
                    embedding_model, embedding_dim, source_sha256
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (book_id, chunk_index) DO UPDATE SET
                    chapter_title = EXCLUDED.chapter_title,
                    chapter_number = EXCLUDED.chapter_number,
                    content = EXCLUDED.content,
                    content_chars = EXCLUDED.content_chars,
                    source_sha256 = EXCLUDED.source_sha256,
                    updated_at = now()
                """,
                (
                    book_id,
                    chunk_index,
                    chapter_title,
                    chapter_number,
                    content,
                    len(content),
                    model_name,
                    VECTOR_LITERAL_DIM,
                    source_sha256,
                ),
            )
        else:
            cursor.execute(
                """
                INSERT INTO discovered_book_chunks (
                    book_id, chunk_index, chapter_title, chapter_number, content, content_chars,
                    embedding, embedding_model, embedding_dim, embedding_recipe, source_sha256
                ) VALUES (%s, %s, %s, %s, %s, %s, %s::vector, %s, %s, %s, %s)
                ON CONFLICT (book_id, chunk_index) DO UPDATE SET
                    chapter_title = EXCLUDED.chapter_title,
                    chapter_number = EXCLUDED.chapter_number,
                    content = EXCLUDED.content,
                    content_chars = EXCLUDED.content_chars,
                    embedding = EXCLUDED.embedding,
                    embedding_model = EXCLUDED.embedding_model,
                    embedding_dim = EXCLUDED.embedding_dim,
                    embedding_recipe = EXCLUDED.embedding_recipe,
                    source_sha256 = EXCLUDED.source_sha256,
                    updated_at = now()
                """,
                (
                    book_id,
                    chunk_index,
                    chapter_title,
                    chapter_number,
                    content,
                    len(content),
                    to_vector_literal(embedding),
                    model_name,
                    VECTOR_LITERAL_DIM,
                    recipe,
                    source_sha256,
                ),
            )


def delete_stale_chunks(connection, book_id: int, keep_upto: int) -> int:  # type: ignore[no-untyped-def]
    with connection.cursor() as cursor:
        cursor.execute(
            "DELETE FROM discovered_book_chunks WHERE book_id = %s AND chunk_index >= %s",
            (book_id, keep_upto),
        )
        return int(cursor.rowcount)


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------


def build_embedding_text(
    title: str | None,
    author: str | None,
    chapter_title: str | None,
    content: str,
) -> str:
    """
    Stage 1.5 新格式（任务指定）：真实 metadata + 正文。

        Title: <真实书名>
        Author: <真实作者>
        Chapter: <真实章节名>
        <正文>

    红线：任何一项在原始数据里不存在就整行省略 —— 不补默认值、不用 "Unknown" 占位、
    不伪造章节名。chapter_title 为 null 时只保留真实存在的 title / author + 正文。
    """
    lines: list[str] = []
    for label, value in (("Title", title), ("Author", author), ("Chapter", chapter_title)):
        text = str(value).strip() if value is not None else ""
        if text:
            lines.append(f"{label}: {text}")
    if not lines:
        return content
    return "\n".join(lines) + "\n" + content


def process_book(
    connection,  # type: ignore[no-untyped-def]
    embedder: Embedder | None,
    book: dict[str, Any],
    args: argparse.Namespace,
    stats: Stats,
) -> None:
    source_id = str(book.get("source_id"))
    title = book.get("title")
    text = str(book.get("text") or "")

    if args.dry_run:
        # dry-run 必须完全不碰数据库：只做切块与章节归属的预演
        chunks = split_with_overlap(
            text,
            chunk_size=args.chunk_size,
            chunk_overlap=args.chunk_overlap,
        )
        anchors = build_chapter_anchors(text, book.get("chapters"))
        info(
            f"  {source_id} {str(title)[:40]}: {len(chunks)} 块（dry-run，不写库、不算 embedding；"
            f"章节 {len(anchors)} 个）"
        )
        stats.chunks_written += len(chunks)
        return

    if not text.strip():
        stats.add_failure(
            Failure(source_id, title, "validate", "empty_text", "正文为空，拒绝入库")
        )
        return

    # 整本一个事务：upsert 书籍 + 写 chunk + 写 embedding 要么一起成，要么一起回滚。
    # 中途任何一步失败 → rollback，这本书保持改动前的状态（旧 embedding 仍在），
    # 下次带 --skip-existing-embeddings 重跑即可续上。
    book_id = upsert_book(connection, book)
    stats.books_upserted += 1

    # --- 切块 ---
    try:
        chunks = split_with_overlap(
            text,
            chunk_size=args.chunk_size,
            chunk_overlap=args.chunk_overlap,
        )
    except Exception as exc:  # noqa: BLE001
        stats.add_failure(
            Failure(source_id, title, "chunk", type(exc).__name__, str(exc))
        )
        connection.rollback()
        return


    if not chunks:
        stats.add_failure(
            Failure(source_id, title, "chunk", "no_chunks", "切块结果为空")
        )
        return

    anchors = build_chapter_anchors(text, book.get("chapters"))
    # 计算每块在正文中的起始字符位置，用于推断章节归属
    positions: list[int] = []
    cursor_pos = 0
    for chunk in chunks:
        index = text.find(chunk, cursor_pos)
        if index < 0:
            index = cursor_pos
        positions.append(index)
        cursor_pos = index + len(chunk)

    signatures = {
        index: hashlib.sha256(chunk.encode("utf-8")).hexdigest()
        for index, chunk in enumerate(chunks)
    }
    existing = existing_embedding_signature(connection, book_id)
    author = book.get("author_display")

    # --- 判断哪些块需要重算 embedding ---
    # 跳过条件必须同时满足：内容哈希未变 + recipe 与本次格式一致。
    # 只满足前者（例如 v1 行遇到 v2 重算）必须重算，否则会留下新旧混用的向量。
    pending: list[int] = []
    for index in range(len(chunks)):
        cached = existing.get(index)
        unchanged = (
            args.skip_existing_embeddings
            and cached is not None
            and cached[0] == signatures[index]
            and cached[1] == CURRENT_RECIPE
        )
        if unchanged:
            stats.chunks_skipped_unchanged += 1
        else:
            pending.append(index)

    if embedder is None:
        stats.add_failure(
            Failure(source_id, title, "embed", "no_model", "未加载模型却要求写入 embedding")
        )
        connection.rollback()
        return

    # --- 整本一个事务：任何一步抛错都整本回滚，旧 embedding 原样保留 ---
    removed = 0
    try:
        if not pending:
            # 元数据（章节等）可能变化，仍更新一次；embedding 与 recipe 保持原值
            for index, chunk in enumerate(chunks):
                chapter_title, chapter_number = find_chapter(anchors, positions[index])
                upsert_chunk(
                    connection,
                    book_id,
                    index,
                    chapter_title,
                    chapter_number,
                    chunk,
                    signatures[index],
                    None,
                    MODEL_NAME,
                    CURRENT_RECIPE,
                )
                stats.chunks_updated += 1
        else:
            batch_size = max(1, args.batch)
            for start in range(0, len(pending), batch_size):
                batch_indexes = pending[start : start + batch_size]
                payloads = []
                for index in batch_indexes:
                    chapter_title, _ = find_chapter(anchors, positions[index])
                    payloads.append(
                        build_embedding_text(title, author, chapter_title, chunks[index])
                    )
                matrix = embedder.encode(payloads, batch_size=batch_size)
                vectors = validate_vectors(matrix, len(payloads))
                for position, index in enumerate(batch_indexes):
                    chapter_title, chapter_number = find_chapter(anchors, positions[index])
                    upsert_chunk(
                        connection,
                        book_id,
                        index,
                        chapter_title,
                        chapter_number,
                        chunks[index],
                        signatures[index],
                        vectors[position],
                        MODEL_NAME,
                        CURRENT_RECIPE,
                    )
                    stats.chunks_written += 1
                    stats.embeddings_computed += 1
        removed = delete_stale_chunks(connection, book_id, len(chunks))
        connection.commit()
    except Exception as exc:  # noqa: BLE001 - 禁止静默跳过，失败必须进清单
        stats.add_failure(
            Failure(
                source_id,
                title,
                "embed",
                type(exc).__name__,
                f"{exc}（整本已回滚，旧 embedding 原样保留，可用 --skip-existing-embeddings 续跑）",
            )
        )
        connection.rollback()
        stats.books_rolled_back += 1
        return

    if removed:
        info(f"  {source_id}: 清理了 {removed} 个残留 chunk（本次切块数变少）")
    info(
        f"  {source_id} {str(title)[:44]}: chunk={len(chunks)}  "
        f"重算={len(pending)}  跳过={len(chunks) - len(pending)}  recipe={CURRENT_RECIPE}"
    )


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="发现书籍链路：raw JSON → PostgreSQL + pgvector")
    parser.add_argument("--in", dest="input_dir", default=".crawl-cache", help="crawler 输出目录")
    parser.add_argument("--batch", type=int, default=16, help="embedding 批大小（默认 16）")
    parser.add_argument("--limit", type=int, default=None, help="只处理前 N 本书")
    parser.add_argument("--chunk-size", type=int, default=DEFAULT_CHUNK_SIZE)
    parser.add_argument("--chunk-overlap", type=int, default=DEFAULT_CHUNK_OVERLAP)
    parser.add_argument(
        "--skip-existing-embeddings",
        action="store_true",
        help="若某 chunk 的内容哈希未变，则不重算 embedding（默认重算）",
    )
    parser.add_argument("--dry-run", action="store_true", help="只切块与校验，不写 embedding、不改库")
    parser.add_argument(
        "--backup-embeddings",
        action="store_true",
        help=f"重算前把当前 embedding 整表备份到 {BACKUP_TABLE}（已存在则不覆盖）",
    )
    parser.add_argument(
        "--online",
        action="store_true",
        help="允许先尝试在线加载模型（默认强制走本地缓存离线加载）",
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)

    # 让 server/.env 里的 DATABASE_URL 生效
    env_file = Path(__file__).resolve().parents[2] / ".env"
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or "=" not in stripped:
                continue
            key, _, value = stripped.partition("=")
            os.environ.setdefault(key.strip(), value.strip().strip("'\""))

    print("=" * 72)
    print(f"发现书籍 ingest   模型={MODEL_NAME}   维度={EXPECTED_DIM}")
    print(f"embedding 格式版本 recipe={CURRENT_RECIPE}")
    print(f"输入={args.input_dir}  batch={args.batch}  chunk={args.chunk_size}/{args.chunk_overlap}")
    print(f"dry-run={args.dry_run}  skip_existing_embeddings={args.skip_existing_embeddings}")
    print("=" * 72)

    input_dir = Path(args.input_dir)
    if not input_dir.is_dir():
        fail(f"输入目录不存在：{input_dir}")
        return 2

    stats = Stats()
    books, failures = load_books(input_dir, args.limit)
    for failure in failures:
        stats.add_failure(failure)
    stats.files_found = len(books)
    ok(f"读取到可用于入库的书籍 {len(books)} 本（读取阶段失败 {len(failures)} 条）")
    if not books:
        print_summary(stats)
        return 1 if stats.failures else 0

    embedder: Embedder | None = None
    if not args.dry_run:
        embedder = Embedder(offline=not args.online)
        try:
            embedder.load()
        except Exception as exc:  # noqa: BLE001
            fail(f"embedding 环境不可用：{exc}")
            traceback.print_exc()
            return 2

    try:
        connection = connect()
    except Exception as exc:  # noqa: BLE001
        fail(f"数据库连接失败：{exc}")
        return 2

    try:
        if args.backup_embeddings:
            ok(backup_embeddings(connection))
        for book in books:
            try:
                process_book(connection, embedder, book, args, stats)
            except Exception as exc:  # noqa: BLE001 - 单本失败不得中断整批
                stats.add_failure(
                    Failure(
                        str(book.get("source_id")),
                        book.get("title"),
                        "upsert_book",
                        type(exc).__name__,
                        str(exc),
                    )
                )
                try:
                    connection.rollback()
                except Exception:  # noqa: BLE001
                    pass
                # 单本失败后不能直接 continue —— 需要先把统计记清楚（已记），继续下一本
    finally:
        connection.close()

    print_summary(stats)
    return 1 if stats.failures else 0


def print_summary(stats: Stats) -> None:
    print()
    print("=" * 72)
    print("ingest 统计")
    print("=" * 72)
    print(f"  读取文件（通过校验） : {stats.files_found}")
    print(f"  upsert 书籍          : {stats.books_upserted}")
    print(f"  写入/更新 chunk      : {stats.chunks_written + stats.chunks_updated}")
    print(f"  其中跳过重算         : {stats.chunks_skipped_unchanged}")
    print(f"  新生成 embedding     : {stats.embeddings_computed}")
    print(f"  整本回滚的书         : {stats.books_rolled_back}")
    print(f"  失败条目             : {len(stats.failures)}")
    if stats.failures:
        print()
        print("  失败清单：")
        for failure in stats.failures:
            location = failure.chunk_index if failure.chunk_index is not None else "-"
            print(
                f"    - [{failure.stage}/{failure.error_type}] "
                f"book={failure.book_source_id} chunk={location} :: {failure.message}"
            )
    print("=" * 72)


if __name__ == "__main__":
    sys.exit(main())
