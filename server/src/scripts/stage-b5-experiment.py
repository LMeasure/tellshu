"""
stage-b5-experiment.py —— Stage B.5：30 本冻结数据集上的「检索路径」实验

与阶段 B 的区别
--------------
阶段 B 在实验副本表上反复 DROP/CREATE HNSW 索引，回答的是「m / ef_construction 怎么选」。
Stage B.5 不建任何索引、不写任何一行数据，只在**正式表 discovered_book_chunks 上只读执行
SELECT**，回答的是另一个问题：

    Stage C 之后规模从 24k 涨到 ~58k，优化器已静默从 Seq Scan（精确）切到
    Index Scan（HNSW ANN），而 hnsw.ef_search 仍是默认 40。
    生产到底该走哪条路？

所以 B.5 的「臂」是**查询期配置**，不是索引参数：
    default        不动任何 GUC，让优化器自选（= 今天生产实际发生的事）
    exact          禁用 indexscan / bitmapscan / indexonlyscan → 精确余弦全表扫描
    ann-efN        禁用 seqscan 强制走 HNSW + 会话级 hnsw.ef_search = N
    ann-efN-strict 同上但 hnsw.iterative_scan = off（用于复现「过滤 + ANN 返回 0 行」）

只读保证
--------
本脚本对数据库**只有 SELECT**：不 INSERT / UPDATE / DELETE / CREATE / DROP / REINDEX，
不碰 discovered_book_chunks_embedding_hnsw_idx，不碰 v1 备份，不重建实验表。
实验前后的指纹若发生变化，说明有别的东西在动库，脚本会直接报错停止。

用法
----
    cd server
    python src/scripts/stage-b5-experiment.py --verify-anchors
    python src/scripts/stage-b5-experiment.py --run
    python src/scripts/stage-b5-experiment.py --run --arms default exact ann-ef200 --repeats 3
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import statistics
import sys
import time
from pathlib import Path

import psycopg2

MAIN_TABLE = "discovered_book_chunks"
MAIN_INDEX = "discovered_book_chunks_embedding_hnsw_idx"
BACKUP_TABLE = "discovered_book_chunks_emb_v1"
DEFAULT_QUERIES = "src/scripts/discover-queries-b5.txt"
OUT_JSON = ".crawl-cache/_b5-matrix.json"

# 不计入命中率分母的类别（与 hnsw-experiment.py 保持一致，唯一判据）
NON_COUNTED_CATEGORIES = frozenset({"probe", "control"})

# 查询 ID 前缀必须显式映射。category[:2].upper() 会撞车：b5 → "B5"，
# 再拼序号得到 "B59" / "B516"，会被读成「B5 第 9 / 第 16 条」以外意思的歧义串。
ID_PREFIX = {
    "fixed": "FIX",
    "stage2": "S2",
    "b5": "B5-",
    "probe": "PRB-",
    "control": "CTL-",
}

# 默认臂：查询期配置矩阵
DEFAULT_ARMS = [
    "default",
    "exact",
    "ann-ef40",
    "ann-ef80",
    "ann-ef120",
    "ann-ef200",
    "ann-ef400",
    "ann-ef800",
]

# 复现「过滤 + ANN 返回 0 行」的对照臂（只在 --run 时可选）
STRICT_ARMS = ["ann-ef40-strict", "ann-ef200-strict"]


def parse_arm(name: str) -> dict:
    """把臂名解析成查询期配置。mode ∈ {default, exact, ann}。"""
    strict = name.endswith("-strict")
    base = name[: -len("-strict")] if strict else name
    if base == "default":
        return {"name": name, "mode": "default", "ef": None, "strict": strict}
    if base == "exact":
        return {"name": name, "mode": "exact", "ef": None, "strict": strict}
    m = re.fullmatch(r"ann-ef(\d+)", base)
    if m:
        return {"name": name, "mode": "ann", "ef": int(m.group(1)), "strict": strict}
    raise ValueError(f"无法识别的臂名：{name}（可选：{', '.join(DEFAULT_ARMS + STRICT_ARMS)}）")


# ---------------------------------------------------------------------------
# 环境 / 依赖
# ---------------------------------------------------------------------------

def load_env(root: Path) -> str:
    for line in (root / ".env").read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if s and not s.startswith("#") and "=" in s:
            k, _, v = s.partition("=")
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError("缺少 DATABASE_URL（检查 server/.env）")
    return url


def load_eval_module():
    path = Path(__file__).resolve().parent / "eval-discover.py"
    spec = importlib.util.spec_from_file_location("eval_discover", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules["eval_discover"] = module
    if spec.loader is None:
        raise RuntimeError("无法加载 eval-discover.py")
    spec.loader.exec_module(module)
    return module


def load_queries(path: Path) -> list[tuple[str, str, str, str]]:
    """四列：<query>\\t<期望书名>\\t<类别>\\t<锚点>。锚点 '-' 表示不校验。"""
    rows: list[tuple[str, str, str, str]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        parts = [p.strip() for p in stripped.split("\t")]
        while len(parts) < 4:
            parts.append("")
        rows.append((parts[0], parts[1], parts[2] or "b5", parts[3] or "-"))
    return rows


# ---------------------------------------------------------------------------
# 指纹（只读）
# ---------------------------------------------------------------------------

def fingerprint(conn) -> dict:
    with conn.cursor() as cur:
        fp: dict = {}
        cur.execute("SELECT count(*) FROM discovered_books")
        fp["books_count"] = cur.fetchone()[0]
        cur.execute(f"SELECT count(*), count(embedding) FROM {MAIN_TABLE}")
        r = cur.fetchone()
        fp["main_rows"], fp["main_embeddings"] = r[0], r[1]
        cur.execute(f"SELECT count(*) FROM {MAIN_TABLE} WHERE chapter_title IS NULL")
        fp["main_null_chapter"] = cur.fetchone()[0]
        cur.execute(
            f"SELECT round(sum(-(embedding <#> embedding))::numeric, 4), sum(content_chars) "
            f"FROM {MAIN_TABLE} WHERE embedding IS NOT NULL"
        )
        r = cur.fetchone()
        fp["main_embedding_norm_sq_sum"] = float(r[0])
        fp["main_content_chars_sum"] = r[1]
        cur.execute(
            f"SELECT md5(string_agg(chunk_index::text || ':' || content_chars::text || ':' || "
            f"coalesce(chapter_title, '<null>'), '|' ORDER BY id)) FROM {MAIN_TABLE}"
        )
        fp["main_content_fp"] = cur.fetchone()[0]
        cur.execute(
            "SELECT indexrelname, pg_relation_size(indexrelid) FROM pg_stat_user_indexes "
            f"WHERE relname = %s AND indexrelname LIKE '%%hnsw%%'",
            (MAIN_TABLE,),
        )
        rows = cur.fetchall()
        fp["main_hnsw_index"] = {name: size for name, size in rows} if rows else None
        cur.execute("SELECT to_regclass(%s)", (BACKUP_TABLE,))
        if cur.fetchone()[0] is not None:
            cur.execute(f"SELECT count(*), count(embedding) FROM {BACKUP_TABLE}")
            b = cur.fetchone()
            fp["backup_v1"] = {"rows": b[0], "embeddings": b[1]}
        else:
            fp["backup_v1"] = None
        # 生产会话当前的 ef_search（不带任何覆盖时的默认值）
        cur.execute("SELECT '[1,2]'::vector")
        cur.execute("SHOW hnsw.ef_search")
        fp["session_default_ef_search"] = cur.fetchone()[0]
        cur.execute("SHOW hnsw.iterative_scan")
        fp["session_default_iterative_scan"] = cur.fetchone()[0]
        return fp


def diff_fingerprint(a: dict, b: dict) -> list[str]:
    ignore = {"session_default_ef_search", "session_default_iterative_scan"}
    return [f"{k}: {a[k]} → {b.get(k)}" for k in a
            if k not in ignore and a[k] != b.get(k)]


# ---------------------------------------------------------------------------
# 检索（只读）
# ---------------------------------------------------------------------------

def search_sql(filter_on: bool, top_k: int) -> str:
    where = "c.embedding IS NOT NULL"
    if filter_on:
        where += " AND c.chapter_title IS NOT NULL"
    return (
        "SELECT b.id, b.title, c.chunk_index, c.chapter_title, "
        f"1 - (c.embedding <=> %s::vector) AS similarity "
        f"FROM {MAIN_TABLE} c JOIN discovered_books b ON b.id = c.book_id "
        f"WHERE {where} ORDER BY c.embedding <=> %s::vector LIMIT {top_k}"
    )


def run_once(conn, literal: str, top_k: int, arm: dict, filter_on: bool, explain: bool):
    """所有 GUC 一律 set_config(..., true)（= SET LOCAL），与查询同事务，commit 后自动重置。"""
    sql = search_sql(filter_on, top_k)
    with conn.cursor() as cur:
        if arm["mode"] == "ann":
            cur.execute("SELECT set_config('hnsw.ef_search', %s, true)", (str(arm["ef"]),))
            cur.execute("SELECT set_config('enable_seqscan', 'off', true)")
        elif arm["mode"] == "exact":
            cur.execute("SELECT set_config('enable_indexscan', 'off', true)")
            cur.execute("SELECT set_config('enable_bitmapscan', 'off', true)")
            cur.execute("SELECT set_config('enable_indexonlyscan', 'off', true)")
        # strict 臂显式关掉迭代扫描；其余一律 relaxed_order（过滤场景的正确取值）
        cur.execute(
            "SELECT set_config('hnsw.iterative_scan', %s, true)",
            ("off" if arm["strict"] else "relaxed_order",),
        )
        plan = None
        if explain:
            cur.execute("EXPLAIN (ANALYZE, BUFFERS) " + sql, (literal, literal))
            plan = [row[0] for row in cur.fetchall()]
        t0 = time.time()
        cur.execute(sql, (literal, literal))
        rows = cur.fetchall()
        wall_ms = (time.time() - t0) * 1000
        conn.commit()
    return rows, wall_ms, plan


def parse_plan(plan: list[str] | None) -> dict:
    """提取执行计划关键信息，尤其是**到底用了哪个索引**。

    ⚠ 踩过的坑：只看「有没有 Index Scan」会得出错误结论。ef_search 升高时优化器会
    放弃 HNSW，改用 discovered_book_chunks_book_idx 扫全表 + Sort —— 那也是 Index Scan，
    但它是**变相精确检索**（46k 行全算距离后排序），延迟比 Seq Scan 精确还慢好几倍。
    所以必须按索引名区分。
    """
    if not plan:
        return {"node": None, "index": None, "path": None, "shared_hit": None,
                "shared_read": None, "execution_time_ms": None, "raw": None}
    raw = "\n".join(plan)
    node = "Seq Scan" if "Seq Scan" in raw else ("Index Scan" if "Index Scan" in raw else "other")
    idx_names = re.findall(r"Index Scan using (\S+)", raw)
    if MAIN_INDEX in idx_names:
        index, path = MAIN_INDEX, "hnsw_ann"
    elif node == "Seq Scan":
        index, path = None, "seq_exact"
    elif idx_names:
        # 走了别的索引（通常是 book_idx）+ Sort —— 变相精确，且通常比 Seq Scan 更慢
        index, path = ",".join(sorted(set(idx_names))), "other_index_exact"
    else:
        index, path = None, "other"
    hit = read = None
    exec_ms = None
    for line in plan:
        s = line.strip()
        if s.startswith("Buffers:"):
            hit_m = re.search(r"shared\s+hit=(\d+)", s)
            read_m = re.search(r"(?:shared\s+)?read=(\d+)", s)
            if hit_m:
                hit = int(hit_m.group(1))
            if read_m:
                read = int(read_m.group(1))
        if "Execution Time:" in s:
            try:
                exec_ms = float(s.split("Execution Time:")[1].strip().split(" ")[0])
            except Exception:  # noqa: BLE001
                pass
    return {"node": node, "index": index, "path": path, "shared_hit": hit, "shared_read": read,
            "execution_time_ms": exec_ms, "raw": raw}


def row_key(row) -> tuple:
    return (row[0], row[2])


# ---------------------------------------------------------------------------
# 分母判定：某本书在「有章节」口径下是否完全不可检索
# ---------------------------------------------------------------------------

def chapter_availability(conn) -> dict[int, int]:
    """book_id → 有章节块数量。

    注意：必须用 LEFT JOIN 把所有书都带出来。只用
    「WHERE chapter_title IS NOT NULL GROUP BY book_id」会把**一本都没有**的书漏掉，
    于是后面的 blocked_books 变成空集，过滤口径的分母就错了——这是个已经踩过的坑。
    """
    with conn.cursor() as cur:
        cur.execute(
            "SELECT b.id, count(c.id) FILTER (WHERE c.chapter_title IS NOT NULL) "
            "FROM discovered_books b LEFT JOIN discovered_book_chunks c ON c.book_id = b.id "
            "GROUP BY b.id"
        )
        return {int(r[0]): int(r[1]) for r in cur.fetchall()}


def book_ids_for_title(conn, title: str) -> list[int]:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id FROM discovered_books WHERE title ILIKE %s", (f"%{title}%",)
        )
        return [int(r[0]) for r in cur.fetchall()]


def pct(values: list[float], q: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    idx = min(len(ordered) - 1, max(0, int(round((len(ordered) - 1) * q))))
    return ordered[idx]


# ---------------------------------------------------------------------------
# 一个臂 × 一个过滤口径
# ---------------------------------------------------------------------------

def measure(conn, items: list[dict], arm: dict, filter_on: bool,
            top_k: int, repeats: int, log) -> dict:
    per_query: list[dict] = []
    warm_all: list[float] = []
    stability_failures = 0
    leak = 0
    starved = 0
    underfilled = 0

    for item in items:
        literal = item["literal"]
        timings: list[float] = []
        rows: list = []
        parsed: dict | None = None
        repeat_keys: list[list] = []
        for i in range(repeats):
            rows_i, wall_ms, plan = run_once(
                conn, literal, top_k, arm, filter_on, explain=(i == 0)
            )
            timings.append(wall_ms)
            if i == 0:
                parsed = parse_plan(plan)
            else:
                repeat_keys.append([row_key(r) for r in rows_i])
                warm_all.append(wall_ms)
            rows = rows_i

        stable = True
        if len(repeat_keys) > 1:
            for k in repeat_keys[1:]:
                if k != repeat_keys[0]:
                    stable = False
        if not stable:
            stability_failures += 1

        titles = [r[1] for r in rows]
        expected = item["expected"]
        lower = [t or "" for t in titles]
        hit_at = {k: any(expected.lower() in t.lower() for t in lower[:k]) for k in (1, 3, 10)}
        if len(rows) == 0:
            starved += 1
        elif len(rows) < top_k:
            underfilled += 1
        has_null_chapter = any(r[3] is None for r in rows)
        if filter_on and has_null_chapter:
            leak += 1

        per_query.append({
            "id": item["id"],
            "category": item["category"],
            "expected": expected,
            "query": item["query"],
            "counted": item["counted"],
            "top1": titles[0] if titles else None,
            "top1_score": round(float(rows[0][4]), 4) if rows else None,
            "hit_top1": hit_at[1],
            "hit_top3": hit_at[3],
            "hit_top10": hit_at[10],
            "rows_returned": len(rows),
            "stable": stable,
            "cold_ms": round(timings[0], 1),
            "latency_ms_repeats": [round(t, 1) for t in timings],
            "plan_node": parsed["node"] if parsed else None,
            "plan_index": parsed["index"] if parsed else None,
            "plan_path": parsed["path"] if parsed else None,
            "plan_execution_time_ms": parsed["execution_time_ms"] if parsed else None,
            "plan_shared_read": parsed["shared_read"] if parsed else None,
            "plan_raw": parsed["raw"] if parsed else None,
        })

    counted = [p for p in per_query if p["counted"]]
    denom = len(counted)
    h1 = sum(1 for p in counted if p["hit_top1"])
    h3 = sum(1 for p in counted if p["hit_top3"])
    h10 = sum(1 for p in counted if p["hit_top10"])
    nodes: dict[str, int] = {}
    paths: dict[str, int] = {}
    for p in per_query:
        nodes[p["plan_node"] or "?"] = nodes.get(p["plan_node"] or "?", 0) + 1
        paths[p["plan_path"] or "?"] = paths.get(p["plan_path"] or "?", 0) + 1

    agg = {
        "denominator": denom,
        "top1_hits": h1,
        "top1_rate": round(h1 / denom, 4) if denom else 0.0,
        "top3_hits": h3,
        "top3_rate": round(h3 / denom, 4) if denom else 0.0,
        "top10_hits": h10,
        "top10_rate": round(h10 / denom, 4) if denom else 0.0,
        "latency": {
            "samples": len(warm_all),
            "p50_ms": round(pct(warm_all, 0.50), 1),
            "p95_ms": round(pct(warm_all, 0.95), 1),
            "max_ms": round(max(warm_all), 1) if warm_all else 0.0,
            "mean_ms": round(statistics.fmean(warm_all), 1) if warm_all else 0.0,
        },
        "plan_nodes": nodes,
        "plan_paths": paths,
        "stability_failures": stability_failures,
        "starved_queries": starved,
        "underfilled_queries": underfilled,
        "null_chapter_leak": leak,
    }
    log(
        f"  [{arm['name']:>16}] filter={'on ' if filter_on else 'off'} "
        f"Top1 {h1}/{denom} ({agg['top1_rate']*100:.1f}%)  "
        f"Top10 {h10}/{denom} ({agg['top10_rate']*100:.1f}%)  "
        f"P50 {agg['latency']['p50_ms']}ms P95 {agg['latency']['p95_ms']}ms  path={paths}"
    )
    return {"aggregate": agg, "per_query": per_query}


# ---------------------------------------------------------------------------
# 锚点校验（只读）
# ---------------------------------------------------------------------------

def verify_anchors(conn, queries: list[tuple[str, str, str, str]], log) -> int:
    log("=" * 78)
    log("Stage B.5 锚点校验（content ILIKE 实测；不写库）")
    log("=" * 78)
    problems = 0
    for i, (query, expected, category, anchor) in enumerate(queries, start=1):
        if anchor == "-" or category in NON_COUNTED_CATEGORIES:
            continue
        with conn.cursor() as cur:
            cur.execute(
                "SELECT b.title, count(*) FROM discovered_book_chunks c "
                "JOIN discovered_books b ON b.id = c.book_id "
                "WHERE c.content ILIKE %s GROUP BY b.title ORDER BY count(*) DESC LIMIT 4",
                (f"%{anchor}%",),
            )
            rows = cur.fetchall()
        total = sum(r[1] for r in rows)
        if not rows:
            log(f"  ✗ #{i:>2} 锚点『{anchor}』在库中 0 命中 → 期望《{expected}》")
            problems += 1
            continue
        top_title, top_n = rows[0]
        ok = expected.lower() in (top_title or "").lower()
        share = top_n / total if total else 0
        flag = "✓" if ok else "✗"
        if not ok:
            problems += 1
        others = ", ".join(f"{t}({n})" for t, n in rows[1:]) or "—"
        log(f"  {flag} #{i:>2} 『{anchor}』总命中 {total}：{top_title}({top_n}, {share*100:.0f}%) "
            f"| 其余 {others} | 期望《{expected}》")
    log("")
    log(f"锚点校验完毕：{problems} 条需要复核。")
    return problems


# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Stage B.5：30 本冻结数据集检索路径实验（只读）")
    parser.add_argument("--run", action="store_true", help="跑矩阵")
    parser.add_argument("--verify-anchors", action="store_true", help="只做锚点校验，不跑矩阵")
    parser.add_argument("--queries", default=DEFAULT_QUERIES)
    parser.add_argument("--top-k", type=int, default=10)
    parser.add_argument("--repeats", type=int, default=5, help="每条 Query 重复次数（第 1 次为冷样本）")
    parser.add_argument("--arms", nargs="*", default=DEFAULT_ARMS)
    args = parser.parse_args(argv)

    root = Path(__file__).resolve().parents[2]
    os.chdir(root)
    url = load_env(root)

    def log(msg: str = "") -> None:
        print(msg, flush=True)

    conn = psycopg2.connect(url)
    conn.autocommit = False
    try:
        fp_before = fingerprint(conn)
        log("=" * 78)
        log("Stage B.5 · 30 本冻结数据集检索路径实验（只读，不建索引、不写库）")
        log("=" * 78)
        log(f"主表 {fp_before['main_rows']} 行 / {fp_before['main_embeddings']} embedding，"
            f"书籍 {fp_before['books_count']} 本，无章节块 {fp_before['main_null_chapter']}")
        log(f"正式 HNSW 索引 {fp_before['main_hnsw_index']}")
        log(f"会话默认 hnsw.ef_search={fp_before['session_default_ef_search']} "
            f"iterative_scan={fp_before['session_default_iterative_scan']}")
        log(f"v1 备份 {fp_before['backup_v1']}")
        log("")

        queries = load_queries(Path(args.queries))
        log(f"查询集 {len(queries)} 条")

        if args.verify_anchors:
            return 1 if verify_anchors(conn, queries, log) else 0

        if not args.run:
            log("未指定 --run / --verify-anchors，什么都不做。")
            return 0

        arms = [parse_arm(a) for a in args.arms]
        avail = chapter_availability(conn)
        blocked_books = {bid for bid, n in avail.items() if n == 0}
        log(f"无任何有章节块的书：{len(blocked_books)} 本（过滤开启口径下不可召回）")
        log("")

        ev = load_eval_module()
        log("加载本地 BGE-M3 模型（离线 HF_HUB_OFFLINE=1）…")
        model = ev.load_model()

        items: list[dict] = []
        counters: dict[str, int] = {}
        for query, expected, category, _anchor in queries:
            counters[category] = counters.get(category, 0) + 1
            # ID 前缀必须显式映射。若用 category[:2].upper()，b5 会变成 "B5"，
            #   再拼序号得到 "B59" / "B516"，读起来分不清是第几条。
            item = {
                "id": f"{ID_PREFIX.get(category, category.upper())}{counters[category]}",
                "query": query,
                "expected": expected,
                "category": category,
                "counted": category not in NON_COUNTED_CATEGORIES,
                "literal": ev.encode(model, query),
            }
            item["blocked_when_filtered"] = False
            if item["counted"]:
                ids = book_ids_for_title(conn, expected)
                if ids and all(bid in blocked_books for bid in ids):
                    item["blocked_when_filtered"] = True
            items.append(item)
        n_blocked = sum(1 for it in items if it["blocked_when_filtered"])
        n_counted = sum(1 for it in items if it["counted"])
        log(f"编码完成：{len(items)} 条（计入分母 {n_counted}，其中过滤口径下出局 {n_blocked}）")
        log(f"  过滤关闭分母 = {n_counted} ；过滤开启分母 = {n_counted - n_blocked}")
        log("")

        results: dict[str, dict] = {}
        started = time.time()
        for arm in arms:
            for filter_on in (True, False):
                for it in items:
                    it["counted"] = (it["category"] not in NON_COUNTED_CATEGORIES) and (
                        not (filter_on and it["blocked_when_filtered"])
                    )
                key = f"{arm['name']}|{'filtered' if filter_on else 'unfiltered'}"
                t0 = time.time()
                res = measure(conn, items, arm, filter_on, args.top_k, args.repeats, log)
                seg = time.time() - t0
                res["segment_seconds"] = round(seg, 1)
                res["segment_started_at"] = time.strftime("%H:%M:%S", time.localtime(t0))
                results[key] = res

        elapsed = time.time() - started
        fp_after = fingerprint(conn)
        diffs = diff_fingerprint(fp_before, fp_after)
        if diffs:
            log("\n⚠ 实验前后指纹发生变化（本脚本只读，说明有别的东西在动库）：")
            for d in diffs:
                log(f"   {d}")
        else:
            log("\n指纹校验通过：实验期间主表 / 索引 / 备份均未变化（只读保证成立）。")

        payload = {
            "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "fingerprint": fp_before,
            "fingerprint_after": fp_after,
            "fingerprint_diffs": diffs,
            "config": {
                "top_k": args.top_k,
                "repeats": args.repeats,
                "arms": [a["name"] for a in arms],
                "queries_file": args.queries,
                "denominator_unfiltered": n_counted,
                "denominator_filtered": n_counted - n_blocked,
            },
            "queries": [
                {"id": it["id"], "query": it["query"], "expected": it["expected"],
                 "category": it["category"], "blocked_when_filtered": it["blocked_when_filtered"]}
                for it in items
            ],
            "results": results,
            "elapsed_seconds": round(elapsed, 1),
        }
        out_path = root / OUT_JSON
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        log(f"\n总耗时 {elapsed/60:.1f} 分钟，结果写入 {out_path}")
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
