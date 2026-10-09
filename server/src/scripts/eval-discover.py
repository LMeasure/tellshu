#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
eval-discover.py —— Stage 1.5 检索 A/B 验收器（只读，不写业务表）

为什么单独一个脚本：
    Stage 1.5 要回答「改 embedding 输入格式 + 检索时排除 front matter + 检索路径」
    到底有没有用。需要把同一组固定 Query 在多个配置下各跑一遍、存成 JSON，再横向比较。
    search-discover.py 是单条交互式查询工具，不适合做矩阵对比。

三个可变维度：
    1. embedding 版本   v1（旧格式，在备份表里）/ v2（新格式，在主表里）
    2. front matter     过滤（chapter_title IS NOT NULL）/ 不过滤
    3. 检索路径         exact（禁用索引，精确余弦）/ ann（HNSW，可指定 ef_search）

为什么必须区分检索路径（Stage 1.5 实测发现，见报告）：
    同一组 v1 向量，Q2「家庭教师/阴森大宅」在 HNSW ef_search=40 下 Top1 是
    A Room with a View(0.5071)，精确扫描下是 Jane Eyre(0.5573) —— Stage 1 报告里的
    「错书」有相当一部分是 ANN 近似召回不足，不是 embedding 表达不行。
    所以 A/B 必须以 exact 为主口径（确定性、可复现），ann 只作辅助对照。

用法：
    cd server
    python src/scripts/eval-discover.py --label v1 --source v1 --retrieval exact --out .eval-v1-exact.json
    python src/scripts/eval-discover.py --label v1 --source v1 --retrieval ann --ef-search 40 --out .eval-v1-ann40.json
    python src/scripts/eval-discover.py --label v2 --source main --retrieval exact --out .eval-v2-exact.json
    python src/scripts/eval-discover.py --label v2 --source main --retrieval ann --ef-search 40 --out .eval-v2-ann40.json
    python src/scripts/eval-discover.py --compare .eval-v1-exact.json .eval-v1-ann40.json \
        .eval-v2-exact.json .eval-v2-ann40.json --before v1+front+exact --after v2+filter+exact

说明：
    - v1 的向量保存在备份表 discovered_book_chunks_emb_v1，所以即使主表已换成 v2，
      仍可用 --source v1 复跑旧配置（这就是「不直接删除旧 embedding」的价值）。
    - 本脚本只读业务表；--out 只写一个 JSON 文件。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any, Final

MODEL_NAME: Final[str] = os.environ.get("EMBED_MODEL", "BAAI/bge-m3")
EXPECTED_DIM: Final[int] = 1024
DEFAULT_QUERIES_FILE: Final[str] = "src/scripts/discover-queries-stage1.txt"
BACKUP_TABLE: Final[str] = "discovered_book_chunks_emb_v1"


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


def load_model() -> Any:
    from sentence_transformers import SentenceTransformer

    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    model = SentenceTransformer(MODEL_NAME, local_files_only=True)
    try:
        identifier = model[0].auto_model.name_or_path
    except Exception:  # noqa: BLE001
        identifier = MODEL_NAME
    print(f"[ .. ] 模型已加载 = {identifier}（本地缓存离线）")
    return model


def encode(model: Any, text: str) -> str:
    import numpy as np

    array = np.asarray(model.encode([text], normalize_embeddings=True, convert_to_numpy=True))
    if array.shape != (1, EXPECTED_DIM):
        raise RuntimeError(f"向量形状异常：{array.shape}")
    return "[" + ",".join(f"{value:.6f}" for value in array[0]) + "]"


def load_queries(path: Path) -> list[tuple[str, str]]:
    queries: list[tuple[str, str]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if "\t" in stripped:
            query, expected = stripped.split("\t", 1)
        else:
            query, expected = stripped, ""
        queries.append((query, expected.strip()))
    return queries


def run_search(
    connection,
    model: Any,
    query: str,
    top_k: int,
    source: str,
    include_front_matter: bool,
    retrieval: str,
    ef_search: int,
) -> list[dict[str, Any]]:  # type: ignore[no-untyped-def]
    literal = encode(model, query)
    with connection.cursor() as cursor:
        # 检索路径：exact = 强制全表精确余弦（禁用索引扫描）；
        #           ann   = 走 HNSW，用 SET hnsw.ef_search 指定候选队列长度。
        if retrieval == "exact":
            cursor.execute(
                "SET LOCAL enable_indexscan=off; SET LOCAL enable_bitmapscan=off; "
                "SET LOCAL enable_indexonlyscan=off;"
            )
        else:
            cursor.execute("SET LOCAL hnsw.ef_search=%s;", (ef_search,))
    if source == "v1":
        # 从备份表取旧向量，章节/正文仍从主表 join（主表内容未变，只有 embedding 被替换）
        sql = f"""
            SELECT b.title                          AS title,
                   b.author_display                 AS author,
                   c.chunk_index                    AS chunk_index,
                   c.chapter_title                  AS chapter_title,
                   c.content                        AS content,
                   1 - (e.embedding <=> %s::vector) AS similarity
            FROM {BACKUP_TABLE} e
            JOIN discovered_book_chunks c
              ON c.book_id = e.book_id AND c.chunk_index = e.chunk_index
            JOIN discovered_books b ON b.id = c.book_id
            WHERE e.embedding IS NOT NULL
              AND (%s OR c.chapter_title IS NOT NULL)
            ORDER BY e.embedding <=> %s::vector
            LIMIT %s
        """
    else:
        sql = """
            SELECT b.title                          AS title,
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
    with connection.cursor() as cursor:
        cursor.execute(sql, (literal, include_front_matter, literal, top_k))
        columns = [description[0] for description in cursor.description]
        rows = cursor.fetchall()
    return [dict(zip(columns, row)) for row in rows]


def snippet(text: str, limit: int = 120) -> str:
    collapsed = " ".join(text.split())
    return collapsed if len(collapsed) <= limit else collapsed[:limit] + "…"


def hit(expected: str, title: str) -> bool:
    """期望书名以子串方式出现在命中书名里即算命中（不模糊匹配、不做语义推断）。"""
    if not expected:
        return False
    return expected.lower() in (title or "").lower()


def evaluate(connection, model: Any, queries: list[tuple[str, str]], top_k: int, source: str, label: str, include_front_matter: bool, retrieval: str, ef_search: int) -> list[dict[str, Any]]:  # type: ignore[no-untyped-def]
    results: list[dict[str, Any]] = []
    retrieval_tag = retrieval if retrieval == "exact" else f"ann{ef_search}"
    config_name = f"{label}{'+front' if include_front_matter else '+filter'}+{retrieval_tag}"
    print()
    print("=" * 78)
    print(
        f"配置：{config_name}    front_matter={include_front_matter}    "
        f"源表={source}    检索={retrieval}{'' if retrieval == 'exact' else f'(ef={ef_search})'}"
    )
    print("=" * 78)
    for index, (query, expected) in enumerate(queries, start=1):
        hits = run_search(connection, model, query, top_k, source, include_front_matter, retrieval, ef_search)
        top1 = hits[0] if hits else None
        hits_in_top = sum(1 for item in hits if hit(expected, item["title"]))
        record = {
            "index": index,
            "query": query,
            "expected": expected,
            "top1": top1["title"] if top1 else None,
            "top1_score": float(top1["similarity"]) if top1 else None,
            "top1_chapter": top1["chapter_title"] if top1 else None,
            "top1_chunk_index": top1["chunk_index"] if top1 else None,
            "hit_top1": hit(expected, top1["title"]) if top1 else False,
            "hit_in_top": hits_in_top,
            "top": [
                {
                    "rank": rank,
                    "score": float(item["similarity"]),
                    "title": item["title"],
                    "chapter": item["chapter_title"],
                    "chunk_index": item["chunk_index"],
                    "snippet": snippet(item["content"]),
                }
                for rank, item in enumerate(hits, start=1)
            ],
        }
        results.append(record)
        flag = "✅" if record["hit_top1"] else "❌"
        score_text = (
            f"{record['top1_score']:.4f}" if record["top1_score"] is not None else "n/a(空结果)"
        )
        print(
            f"  {flag} Q{index} Top1={short(record['top1'], 40)}  score={score_text}  "
            f"期望={expected or '(无)'}  top{top_k}命中={hits_in_top}/{len(hits)}"
        )
    return results


def collect(payloads: list[dict[str, Any]]) -> tuple[list[str], dict[str, dict[int, dict[str, Any]]], dict[int, str], dict[int, str]]:
    order: list[str] = []
    configs: dict[str, dict[int, dict[str, Any]]] = {}
    expected: dict[int, str] = {}
    queries: dict[int, str] = {}
    for payload in payloads:
        for config, items in payload.get("results", {}).items():
            if config not in configs:
                configs[config] = {}
                order.append(config)
            for item in items:
                configs[config][item["index"]] = item
                expected[item["index"]] = item["expected"]
                queries[item["index"]] = item["query"]
    return order, configs, expected, queries


def short(title: str | None, width: int = 24) -> str:
    return " ".join((title or "-").split())[:width]


def print_compare(payloads: list[dict[str, Any]], before_key: str | None, after_key: str | None) -> None:
    order, configs, expected, queries = collect(payloads)
    indices = sorted(expected)

    print()
    print("=" * 100)
    print("命中矩阵（Top1 是否命中期望书籍）")
    print("=" * 100)
    print(f"{'Q':<3} {'期望':<20}" + "".join(f"{c[:18]:<20}" for c in order))
    print("-" * 100)
    for index in indices:
        cells = []
        for config in order:
            item = configs[config].get(index)
            cells.append("✅" if item and item["hit_top1"] else ("❌" if item else "-"))
        print(f"{index:<3} {expected[index][:20]:<20}" + "".join(f"{c:<20}" for c in cells))

    print()
    print("Top1 score 矩阵")
    print("-" * 100)
    print(f"{'Q':<3} {'期望':<20}" + "".join(f"{c[:18]:<20}" for c in order))
    for index in indices:
        cells = []
        for config in order:
            item = configs[config].get(index)
            cells.append(f"{item['top1_score']:.4f}" if item and item["top1_score"] is not None else "-")
        print(f"{index:<3} {expected[index][:20]:<20}" + "".join(f"{c:<20}" for c in cells))

    if before_key and after_key and before_key in configs and after_key in configs:
        print()
        print("=" * 100)
        print(f"修复前 = {before_key}    修复后 = {after_key}")
        print("=" * 100)
        print(
            f"{'Q':<3} {'期望':<20} {'修复前Top1':<26} {'修复后Top1':<26} "
            f"{'前score':>8} {'后score':>8} {'Δ':>8}  命中"
        )
        print("-" * 100)
        for index in indices:
            b = configs[before_key][index]
            a = configs[after_key][index]
            delta = (a["top1_score"] or 0) - (b["top1_score"] or 0)
            print(
                f"{index:<3} {expected[index][:20]:<20} {short(b['top1'], 26):<26} {short(a['top1'], 26):<26} "
                f"{b['top1_score']:>8.4f} {a['top1_score']:>8.4f} {delta:>+8.4f}  "
                f"{'✅' if a['hit_top1'] else '❌'}"
            )

        print()
        print(f"修复后（{after_key}）Top3 明细")
        print("=" * 100)
        for index in indices:
            item = configs[after_key][index]
            print()
            print(f"Q{index}  {queries[index]}")
            print(f"     期望：{expected[index]}")
            for row in item["top"]:
                chapter = row["chapter"] or "(无章节归属)"
                print(
                    f"     {row['rank']}. score={row['score']:.4f}  {short(row['title'], 34)}  "
                    f"chunk={row['chunk_index']}  chapter={chapter}"
                )
                print(f"        {row['snippet']}")
    else:
        print()
        print("[ .. ] 未指定（或找不到）--before/--after 配置键，只输出矩阵。可用键：" + ", ".join(order))


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="discover 检索 A/B 验收")
    parser.add_argument("--queries", default=DEFAULT_QUERIES_FILE, help="固定 Query 文件（query<TAB>expected）")
    parser.add_argument("--top-k", type=int, default=3)
    parser.add_argument("--label", default="current", help="本轮标签，如 v1 / v2")
    parser.add_argument("--source", default="main", choices=["main", "v1"], help="向量来源表")
    parser.add_argument("--out", default=None, help="结果 JSON 输出路径")
    parser.add_argument(
        "--retrieval",
        choices=["exact", "ann"],
        default="exact",
        help="exact=禁用索引走精确余弦（A/B 主口径）；ann=走 HNSW 索引",
    )
    parser.add_argument("--ef-search", type=int, default=40, help="ann 模式下的 hnsw.ef_search（默认 40）")
    parser.add_argument("--compare", nargs="+", default=None, metavar="JSON", help="比较一个或多个 JSON")
    parser.add_argument("--before", default=None, help="对比表里的「修复前」配置键，如 v1+front+exact")
    parser.add_argument("--after", default=None, help="对比表里的「修复后」配置键，如 v2+filter+exact")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    root = Path(__file__).resolve().parents[2]
    load_dotenv(root)

    if args.compare:
        payloads = [json.loads(Path(item).read_text(encoding="utf-8")) for item in args.compare]
        print_compare(payloads, args.before, args.after)
        return 0

    queries_path = Path(args.queries)
    if not queries_path.exists():
        queries_path = root / args.queries
    if not queries_path.exists():
        print(f"[FAIL] Query 文件不存在：{args.queries}", file=sys.stderr)
        return 2
    queries = load_queries(queries_path)
    print(f"[ .. ] 固定 Query {len(queries)} 条，来自 {queries_path}")

    model = load_model()

    url = os.environ.get("DATABASE_URL")
    if not url:
        print("[FAIL] 缺少环境变量 DATABASE_URL", file=sys.stderr)
        return 2
    import psycopg2

    connection = psycopg2.connect(url)
    try:
        results: dict[str, list[dict[str, Any]]] = {}
        retrieval_tag = args.retrieval if args.retrieval == "exact" else f"ann{args.ef_search}"
        for include_front in (False, True):
            config = f"{args.label}{'+front' if include_front else '+filter'}+{retrieval_tag}"
            results[config] = evaluate(
                connection,
                model,
                queries,
                args.top_k,
                args.source,
                args.label,
                include_front,
                args.retrieval,
                args.ef_search,
            )
    finally:
        connection.close()

    payload = {"label": args.label, "source": args.source, "top_k": args.top_k, "results": results}
    if args.out:
        out_path = Path(args.out)
        out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"\n[ OK ] 结果已写入 {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
