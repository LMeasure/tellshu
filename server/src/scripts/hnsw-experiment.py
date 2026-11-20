"""
hnsw-experiment.py —— 阶段 B：HNSW 参数实验（实验副本，不碰正式索引）

为什么必须有实验副本：
    正式索引 discovered_book_chunks_embedding_hnsw_idx 是 Stage 1.5 验收过的产线对象。
    参数实验要反复 DROP/CREATE 索引，直接在主表上做会破坏产线状态，且一旦中途失败
    难以回到基线。本脚本所有检索都在独立实验表 discovered_book_chunks_exp 上进行：
      - 主表 discovered_book_chunks 只读（建表时 INSERT ... SELECT 复制一次），不 UPDATE / 不 DELETE
      - 正式索引不 DROP、不 REINDEX、不 ALTER
      - 不写 discovered_books
      - 不重新生成 embedding（直接复制现有 v2 向量）

口径来源：《发现书籍链路-Stage2前置召回实验方案.md》§4.0
    - Top-K 固定 10；命中率分母 = 计入的定向 Query 条数（过滤开启时为 13，关闭时为 14）
    - 每条 Query 重复 5 次，第 1 次带 EXPLAIN (ANALYZE, BUFFERS)（冷样本，单列不进 P50/P95）
    - 延迟只从计入分母的 Query 的第 2~5 次取（热样本）
    - 精确检索（禁用索引）作为召回率基准，按过滤开关各跑一次，与索引参数无关故复用
    - 会话级参数一律 set_config(..., true)（= SET LOCAL），与查询同事务，事务结束自动重置

三种模式：
    --run       正式跑 9 组索引参数矩阵（阶段 B）
    --cleanup   删除实验表及其索引，释放空间
    --verify    只做指纹核对，不跑实验

用法：
    cd server
    python src/scripts/hnsw-experiment.py --run
    python src/scripts/hnsw-experiment.py --run --ef 40 100 --repeats 5
    python src/scripts/hnsw-experiment.py --cleanup
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

EXP_TABLE = "discovered_book_chunks_exp"
EXP_INDEX = "exp_hnsw_idx"
MAIN_TABLE = "discovered_book_chunks"
MAIN_INDEX = "discovered_book_chunks_embedding_hnsw_idx"
BACKUP_TABLE = "discovered_book_chunks_emb_v1"

# 实验对象标记：表与索引都会打上，见 ensure_table() / build_index()
EXP_MARKER = "Stage B experiment only. Do not use in production API."

# 命中率分母的唯一判据（方案 §4.0）：
#   probe   —— front matter / 过滤行为探针，验的是「行为」不是「召回」，永不进分母
#   control —— 负对照（与语料无关的 Query），永不进分母
#   其余（fixed / new / new-blocked）—— 定向 Query，计入分母
# 注意：new-blocked（N3）在过滤开启口径下会被单独置为 False（锚点全部落在无章节块，
# 该书在该口径下不可召回），那是「口径」问题而不是「类别」问题，由调用方另行处理。
NON_COUNTED_CATEGORIES = frozenset({"probe", "control"})


def assign_counted(category: str) -> bool:
    """返回该条 Query 是否计入命中率分母。纯函数，无副作用，可被单测直接调用。

    规则（唯一来源，其他任何地方不得再自行写 counted 判据）：
        category == 'probe'   -> False（探针）
        category == 'control' -> False（负对照）
        其余                  -> True
    """
    return category not in NON_COUNTED_CATEGORIES

# 9 组索引参数矩阵（方案 §3 阶段 B）；最后一组是基线的重复项，用于测构建随机性
INDEX_MATRIX: list[tuple[int, int, str]] = [
    (8, 64, "最小图"),
    (8, 128, ""),
    (16, 64, "当前现状（基线）"),
    (16, 128, ""),
    (16, 256, ""),
    (32, 64, ""),
    (32, 128, ""),
    (32, 256, "最大图"),
    (16, 64, "基线重复项，测构建随机性"),
]

# 极窄 / 真实无匹配对照：不计入任何分母，只用于判定表「真实无匹配」一行是否有据
NEGATIVE_CONTROL = "量子计算与区块链在供应链金融中的应用"


def load_eval_module():
    """复用 eval-discover.py 的模型加载与向量编码，避免两处实现漂移。"""
    path = Path(__file__).resolve().parent / "eval-discover.py"
    spec = importlib.util.spec_from_file_location("eval_discover", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules["eval_discover"] = module
    if spec.loader is None:
        raise RuntimeError("无法加载 eval-discover.py")
    spec.loader.exec_module(module)
    return module


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


def load_queries(path: Path) -> list[tuple[str, str, str]]:
    """三列格式：<query>\\t<期望书名>\\t<类别 fixed|new|new-blocked|probe>。"""
    rows: list[tuple[str, str, str]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        parts = [p.strip() for p in stripped.split("\t")]
        while len(parts) < 3:
            parts.append("")
        rows.append((parts[0], parts[1], parts[2] or "new"))
    return rows


# ---------------------------------------------------------------------------
# 指纹：实验前后各跑一次，任何一项变化都必须停止并报告
# ---------------------------------------------------------------------------

def fingerprint(conn) -> dict:
    with conn.cursor() as cur:
        def one(sql: str):
            cur.execute(sql)
            row = cur.fetchone()
            return row[0] if row and len(row) == 1 else tuple(row) if row else None

        fp: dict = {}
        fp["books_count"] = one("SELECT count(*) FROM discovered_books")
        fp["main_rows"] = one(f"SELECT count(*) FROM {MAIN_TABLE}")
        fp["main_embeddings"] = one(f"SELECT count(embedding) FROM {MAIN_TABLE}")
        cur.execute(f"SELECT embedding_recipe, count(*) FROM {MAIN_TABLE} GROUP BY 1 ORDER BY 1")
        fp["main_recipe"] = {r[0]: r[1] for r in cur.fetchall()}
        cur.execute(
            f"SELECT count(*) FROM {MAIN_TABLE} WHERE chapter_title IS NULL"
        )
        fp["main_null_chapter"] = cur.fetchone()[0]
        # 向量校验和：单位向量自内积恒为 1，任何 embedding 变化都会让这个值偏移
        cur.execute(
            f"SELECT round(sum(-(embedding <#> embedding))::numeric, 4), "
            f"round(min(-(embedding <#> embedding))::numeric, 6), "
            f"round(max(-(embedding <#> embedding))::numeric, 6), "
            f"sum(content_chars) FROM {MAIN_TABLE} WHERE embedding IS NOT NULL"
        )
        r = cur.fetchone()
        fp["main_embedding_norm_sq_sum"] = float(r[0])
        fp["main_embedding_norm_sq_min"] = float(r[1])
        fp["main_embedding_norm_sq_max"] = float(r[2])
        fp["main_content_chars_sum"] = r[3]
        # 内容指纹：章节归属 + 正文长度，检测正文是否被改写
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
        fp["main_hnsw_index_count"] = len(rows)

        cur.execute(f"SELECT to_regclass(%s)", (BACKUP_TABLE,))
        if cur.fetchone()[0] is not None:
            cur.execute(f"SELECT count(*), count(embedding), count(DISTINCT vector_dims(embedding)) FROM {BACKUP_TABLE}")
            b = cur.fetchone()
            cur.execute(
                f"SELECT round(sum(-(embedding <#> embedding))::numeric, 4) FROM {BACKUP_TABLE} WHERE embedding IS NOT NULL"
            )
            fp["backup_v1"] = {"rows": b[0], "embeddings": b[1], "dims": b[2], "norm_sq_sum": float(cur.fetchone()[0])}
        else:
            fp["backup_v1"] = None
        return fp


def diff_fingerprint(a: dict, b: dict) -> list[str]:
    problems = []
    for key in a:
        if a[key] != b.get(key):
            problems.append(f"{key}: {a[key]} → {b.get(key)}")
    return problems


# ---------------------------------------------------------------------------
# 实验副本
# ---------------------------------------------------------------------------

def ensure_table(conn, log) -> int:
    with conn.cursor() as cur:
        cur.execute("SELECT to_regclass(%s)", (EXP_TABLE,))
        exists = cur.fetchone()[0] is not None
        if not exists:
            log(f"  建实验表 {EXP_TABLE}（结构复制自主表）")
            cur.execute(f"CREATE TABLE {EXP_TABLE} (LIKE {MAIN_TABLE} INCLUDING DEFAULTS)")
        cur.execute(f"SELECT count(*) FROM {EXP_TABLE}")
        rows = cur.fetchone()[0]
        cur.execute(f"SELECT count(*) FROM {MAIN_TABLE} WHERE embedding IS NOT NULL")
        main_rows = cur.fetchone()[0]
        if rows != main_rows:
            log(f"  实验表 {rows} 行 ≠ 主表 {main_rows} 行，重建快照…")
            cur.execute(f"TRUNCATE {EXP_TABLE}")
            t0 = time.time()
            cur.execute(
                f"INSERT INTO {EXP_TABLE} SELECT * FROM {MAIN_TABLE} WHERE embedding IS NOT NULL"
            )
            conn.commit()
            log(f"  复制完成，耗时 {time.time() - t0:.1f}s")
            cur.execute(f"SELECT count(*) FROM {EXP_TABLE}")
            rows = cur.fetchone()[0]
        else:
            log(f"  实验表已存在 {rows} 行，与主表行数一致")
        # 一致性校验：实验表必须是主表的忠实快照，否则召回率没有意义
        cur.execute(
            f"SELECT sum(content_chars), round(sum(-(embedding <#> embedding))::numeric, 4) FROM {EXP_TABLE}"
        )
        exp_sum, exp_norm = cur.fetchone()
        cur.execute(
            f"SELECT sum(content_chars), round(sum(-(embedding <#> embedding))::numeric, 4) "
            f"FROM {MAIN_TABLE} WHERE embedding IS NOT NULL"
        )
        main_sum, main_norm = cur.fetchone()
        if (exp_sum, str(exp_norm)) != (main_sum, str(main_norm)):
            raise RuntimeError(
                f"实验表与主表不一致：chars {exp_sum} vs {main_sum}，norm {exp_norm} vs {main_norm}。"
                f"已停止，请检查实验副本。"
            )
        log(f"  快照一致性校验通过（chars={exp_sum}，norm² 合计={exp_norm}）")
        # 实验对象必须自带「不可用于生产」标记，防止将来被 API 或前端误接
        cur.execute(f"COMMENT ON TABLE {EXP_TABLE} IS %s", (EXP_MARKER,))
        conn.commit()
        return rows


def build_index(conn, m: int, ef_construction: int, log) -> dict:
    with conn.cursor() as cur:
        cur.execute("SELECT to_regclass(%s)", (EXP_INDEX,))
        if cur.fetchone()[0] is not None:
            cur.execute(f"DROP INDEX {EXP_INDEX}")
            conn.commit()
        t0 = time.time()
        cur.execute(
            f"CREATE INDEX {EXP_INDEX} ON {EXP_TABLE} USING hnsw (embedding vector_cosine_ops) "
            f"WITH (m = {m}, ef_construction = {ef_construction})"
        )
        conn.commit()
        elapsed = time.time() - t0
        # 每次重建都重新打标记，避免实验对象被误当成产线资产
        cur.execute(f"COMMENT ON INDEX {EXP_INDEX} IS %s", (EXP_MARKER,))
        conn.commit()
        cur.execute(
            "SELECT pg_size_pretty(pg_relation_size(%s)), pg_relation_size(%s)", (EXP_INDEX, EXP_INDEX)
        )
        pretty, raw = cur.fetchone()
        log(f"  索引 m={m} ef_construction={ef_construction}: 耗时 {elapsed:.1f}s，大小 {pretty}")
        return {
            "m": m,
            "ef_construction": ef_construction,
            "build_seconds": round(elapsed, 1),
            "index_bytes": raw,
            "index_size_pretty": pretty,
        }


# ---------------------------------------------------------------------------
# 检索
# ---------------------------------------------------------------------------

def search_sql(filter_on: bool, top_k: int) -> str:
    where = "c.embedding IS NOT NULL"
    if filter_on:
        where += " AND c.chapter_title IS NOT NULL"
    return (
        "SELECT b.id, b.title, c.chunk_index, c.chapter_title, "
        f"1 - (c.embedding <=> %s::vector) AS similarity "
        f"FROM {EXP_TABLE} c JOIN discovered_books b ON b.id = c.book_id "
        f"WHERE {where} ORDER BY c.embedding <=> %s::vector LIMIT {top_k}"
    )


def run_once(conn, literal: str, top_k: int, ef_search: int, iterative: str,
             filter_on: bool, exact: bool, explain: bool, force_index: bool = False):
    """set_config(..., true) = SET LOCAL，与检索同事务，conn.commit() 后自动重置。

    force_index：禁用 seqscan，强制走 HNSW。
    为什么需要：24k 规模下 ef_search ≥ 100 时优化器会判定全表扫描更便宜而放弃索引，
    那样测到的其实是精确检索，索引参数实验就失去意义。故每组都补一次强制索引测量。
    """
    sql = search_sql(filter_on, top_k)
    with conn.cursor() as cur:
        cur.execute("SELECT set_config('hnsw.ef_search', %s, true)", (str(ef_search),))
        cur.execute("SELECT set_config('hnsw.iterative_scan', %s, true)", (iterative,))
        if exact:
            cur.execute("SELECT set_config('enable_indexscan', 'off', true)")
            cur.execute("SELECT set_config('enable_bitmapscan', 'off', true)")
            cur.execute("SELECT set_config('enable_indexonlyscan', 'off', true)")
        if force_index:
            cur.execute("SELECT set_config('enable_seqscan', 'off', true)")
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
    if not plan:
        return {"node": None, "buffers": None, "shared_hit": None, "shared_read": None,
                "execution_time_ms": None, "raw": None}
    raw = "\n".join(plan)
    node = "Seq Scan" if "Seq Scan" in raw else ("Index Scan" if "Index Scan" in raw else "other")
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
    return {"node": node, "buffers": raw.strip(), "shared_hit": hit, "shared_read": read,
            "execution_time_ms": exec_ms, "raw": raw}


def row_key(row) -> tuple:
    return (row[0], row[2])  # book_id, chunk_index


def measure(conn, items: list[dict], top_k: int, ef_search: int, iterative: str,
            filter_on: bool, repeats: int, exact_runs: dict, force_index: bool = False) -> dict:
    """items 含 query / expected / category / literal。exact_runs 为预先跑好的精确基准。"""
    per_query = []
    warm_all: list[float] = []
    cold_samples: list[dict] = []
    stability_failures = 0
    front_matter_leak = 0
    verdicts: dict[str, int] = {}

    for item in items:
        literal = item["literal"]
        timings: list[float] = []
        rows: list = []
        parsed: dict | None = None
        repeat_keys: list[list] = []
        for i in range(repeats):
            rows_i, wall_ms, plan = run_once(
                conn, literal, top_k, ef_search, iterative, filter_on,
                exact=False, explain=(i == 0), force_index=force_index,
            )
            timings.append(wall_ms)
            if i == 0:
                parsed = parse_plan(plan)
                cold_samples.append({"query": item["query"][:30], "ms": round(wall_ms, 1),
                                     "shared_read": parsed["shared_read"]})
            else:
                repeat_keys.append([row_key(r) for r in rows_i])
                warm_all.append(wall_ms)
            rows = rows_i

        # 稳定性：第 2~5 次的 Top-K（book_id + chunk_index）逐项一致
        stable = True
        if len(repeat_keys) > 1:
            for k in repeat_keys[1:]:
                if k != repeat_keys[0]:
                    stable = False
        if not stable:
            stability_failures += 1

        titles = [r[1] for r in rows]
        expected = item["expected"]
        hit_at = {k: any(expected.lower() in (t or "").lower() for t in titles[:k]) for k in (1, 3, 5)}

        # 精确基准对照（同过滤条件）
        exact_key = "filtered" if filter_on else "unfiltered"
        exact_rows = exact_runs[exact_key].get(item["query"], [])
        exact_keys = [row_key(r) for r in exact_rows]
        ann_keys = [row_key(r) for r in rows]
        inter = [k for k in ann_keys if k in exact_keys]
        denom = min(len(exact_keys), top_k) or 1
        overlap_rate = round(len(inter) / denom, 4)

        n_ann, n_exact = len(rows), len(exact_rows)
        if n_exact == 0 and n_ann == 0:
            verdict = "real_no_match"
        elif n_exact > 0 and n_ann == 0:
            verdict = "ann_filter_starvation"
        elif 0 < n_ann < top_k and n_exact >= top_k:
            verdict = "underfilled"
        else:
            verdict = "ok"
        verdicts[verdict] = verdicts.get(verdict, 0) + 1

        has_null_chapter = any(r[3] is None for r in rows)
        if filter_on and has_null_chapter:
            front_matter_leak += 1

        per_query.append({
            "id": item["id"],
            "category": item["category"],
            "counted": item["counted"],
            "query": item["query"],
            "expected": expected,
            "top1": titles[0] if titles else None,
            "top1_score": round(float(rows[0][4]), 4) if rows else None,
            "hit_top1": hit_at[1],
            "hit_top3": hit_at[3],
            "hit_top5": hit_at[5],
            "rows_returned": n_ann,
            "exact_rows": n_exact,
            "overlap_at_10": len(inter),
            "overlap_rate": overlap_rate,
            "empty_verdict": verdict,
            "stable": stable,
            "has_null_chapter_in_topk": has_null_chapter,
            "cold_ms": round(timings[0], 1),
            "latency_ms_repeats": [round(t, 1) for t in timings],
            "plan_node": parsed["node"] if parsed else None,
            "plan_shared_hit": parsed["shared_hit"] if parsed else None,
            "plan_shared_read": parsed["shared_read"] if parsed else None,
            "plan_execution_time_ms": parsed["execution_time_ms"] if parsed else None,
            "plan_raw": parsed["raw"] if parsed else None,
            "top10": [{"rank": i + 1, "title": r[1], "chunk_index": r[2],
                       "chapter": r[3], "score": round(float(r[4]), 4)} for i, r in enumerate(rows)],
        })

    def pct(values: list[float], q: float) -> float:
        if not values:
            return 0.0
        ordered = sorted(values)
        idx = min(len(ordered) - 1, max(0, int(round((len(ordered) - 1) * q))))
        return ordered[idx]

    counted = [p for p in per_query if p["counted"]]
    denominator = len(counted)
    top1 = sum(1 for p in counted if p["hit_top1"])
    top3 = sum(1 for p in counted if p["hit_top3"])
    top5 = sum(1 for p in counted if p["hit_top5"])

    return {
        "per_query": per_query,
        "aggregate": {
            "denominator": denominator,
            "top1_hits": top1,
            "top1_rate": round(top1 / denominator, 4) if denominator else 0.0,
            "top3_hits": top3,
            "top3_rate": round(top3 / denominator, 4) if denominator else 0.0,
            "top5_hits": top5,
            "top5_rate": round(top5 / denominator, 4) if denominator else 0.0,
            "mean_overlap_rate_at_10": round(
                sum(p["overlap_rate"] for p in counted) / denominator, 4) if denominator else 0.0,
            "latency": {
                "samples": len(warm_all),
                "p50_ms": round(pct(warm_all, 0.50), 1),
                "p95_ms": round(pct(warm_all, 0.95), 1),
                "max_ms": round(max(warm_all), 1) if warm_all else 0.0,
                "mean_ms": round(statistics.fmean(warm_all), 1) if warm_all else 0.0,
            },
            "cold_samples_count": len(cold_samples),
            "cold_samples": cold_samples,
            "stability_failures": stability_failures,
            "front_matter_leak": front_matter_leak,
            "empty_verdicts": verdicts,
            "plan_nodes": {p["plan_node"]: sum(1 for q in per_query if q["plan_node"] == p["plan_node"])
                           for p in per_query},
        },
    }


def build_exact_runs(conn, items: list[dict], top_k: int, log) -> dict:
    """精确检索基准：禁用索引下的 Top-K。与索引参数无关，故每种过滤条件只跑一次。"""
    runs: dict[str, dict[str, list]] = {}
    for filter_on in (True, False):
        key = "filtered" if filter_on else "unfiltered"
        runs[key] = {}
        for item in items:
            rows, _, _ = run_once(conn, item["literal"], top_k, 100, "off", filter_on,
                                  exact=True, explain=False)
            runs[key][item["query"]] = rows
        log(f"  精确基准 [{key}]：{len(items)} 条已完成")
    return runs


# ---------------------------------------------------------------------------

def run_matrix(conn, args, log) -> dict:
    log("=" * 78)
    log("阶段 B：9 组索引参数矩阵（实验副本，不碰正式索引 / 正式向量 / v1 备份）")
    log("=" * 78)

    fp_before = fingerprint(conn)
    log(f"实验前指纹：主表 {fp_before['main_rows']} 行 / {fp_before['main_embeddings']} embedding，"
        f"正式 HNSW 索引 {fp_before['main_hnsw_index']}")
    log(f"            v1 备份 {fp_before['backup_v1']}")
    log("")

    snapshot_rows = ensure_table(conn, log)

    ev = load_eval_module()
    log("加载本地 BGE-M3 模型（离线）…")
    model = ev.load_model()
    raw_queries = load_queries(Path(args.queries))

    items: list[dict] = []
    label_by_index = {}
    fixed_i = new_i = probe_i = 0
    for q, expected, category in raw_queries:
        if category == "fixed":
            fixed_i += 1
            label = f"A{fixed_i}"
        elif category in ("new", "new-blocked"):
            new_i += 1
            label = f"N{new_i}"
        else:
            probe_i += 1
            label = f"F{probe_i}"
        label_by_index[label] = category
        # 方案 §4.0：front matter 探针（F1/F2）验的是行为不是书籍，**不计入命中率分母**
        items.append({"id": label, "query": q, "expected": expected, "category": category,
                      "literal": ev.encode(model, q), "counted": assign_counted(category)})
    # 负对照：不计入任何分母
    items.append({"id": "CTRL", "query": NEGATIVE_CONTROL, "expected": "(负对照·不计入分母)",
                  "category": "control", "literal": ev.encode(model, NEGATIVE_CONTROL),
                  "counted": assign_counted("control")})

    log(f"查询集 {len(raw_queries)} 条（fixed {fixed_i} / new {new_i} / probe {probe_i}）+ 1 条负对照")

    # 过滤开启时，new-blocked 不计入分母（锚点在过滤口径下无效，见方案 §2.3）
    for it in items:
        if it["category"] == "new-blocked":
            it["counted"] = False
    counted_filtered = sum(1 for it in items if it["counted"])
    log(f"过滤开启口径分母 = {counted_filtered}（N3 因锚点全部落在无章节块而排除）")
    log("")

    log("建立精确检索基准（禁用索引，作为召回率参照）…")
    exact_runs = build_exact_runs(conn, items, args.top_k, log)

    # 精确基线逐条入库：这是「embedding + 语料的能力上限」，后续所有 ANN 结果都要与它比
    exact_baseline: dict[str, list[dict]] = {}
    for key in ("filtered", "unfiltered"):
        entries: list[dict] = []
        hits = 0
        denom = 0
        for it in items:
            if it["category"] == "control":
                continue
            counted_here = it["counted"] or (it["category"] == "new-blocked" and key == "unfiltered")
            rows = exact_runs[key].get(it["query"], [])
            hit = bool(rows) and it["expected"].lower() in (rows[0][1] or "").lower()
            if counted_here:
                denom += 1
                if hit:
                    hits += 1
            entries.append({
                "id": it["id"], "category": it["category"], "query": it["query"],
                "expected": it["expected"], "counted": counted_here,
                "top1": rows[0][1] if rows else None,
                "top1_score": round(float(rows[0][4]), 4) if rows else None,
                "hit_top1": hit, "rows_returned": len(rows),
                "top3": [r[1] for r in rows[:3]],
            })
        exact_baseline[key] = {"entries": entries, "top1_hits": hits, "denominator": denom}
        log(f"  精确检索 Top1 [{key}]：{hits}/{denom}")
    log("")

    payload: dict = {
        "fingerprint_before": fp_before,
        "experiment_rows": snapshot_rows,
        "exact_baseline": exact_baseline,
        "matrix": INDEX_MATRIX,
        "unfiltered_control": [],
        "config": {
            "top_k": args.top_k,
            "filter": "chapter_title IS NOT NULL",
            "iterative_scan": args.iterative,
            "repeats": args.repeats,
            "queries_file": args.queries,
            "denominator_filtered": counted_filtered,
        },
        "groups": [],
    }

    matrix = INDEX_MATRIX[: args.limit_groups] if args.limit_groups > 0 else INDEX_MATRIX
    payload["matrix"] = matrix
    modes: list[tuple[str, bool]] = [("auto", False)]
    if not args.no_forced:
        modes.append(("forced_index", True))
    total_groups = len(matrix) * len(args.ef) * len(modes)
    done = 0
    for idx, (m, ef_c, note) in enumerate(matrix, start=1):
        log(f"\n[{idx}/{len(matrix)}] m={m} ef_construction={ef_c} {note}")
        info = build_index(conn, m, ef_c, log)
        for ef_search in args.ef:
            for mode_name, force in modes:
                done += 1
                log(f"  ({done}/{total_groups}) ef_search={ef_search}  mode={mode_name}")
                res = measure(conn, items, args.top_k, ef_search, args.iterative,
                              True, args.repeats, exact_runs, force_index=force)
                res["index"] = info
                res["query_params"] = {"ef_search": ef_search, "iterative_scan": args.iterative,
                                       "mode": mode_name, "force_index": force}
                payload["groups"].append(res)
                agg = res["aggregate"]
                log(f"    命中 Top1 {agg['top1_hits']}/{agg['denominator']} ({agg['top1_rate']:.0%}) | "
                    f"Top3 {agg['top3_rate']:.0%} | Top5 {agg['top5_rate']:.0%} | "
                    f"重合率 {agg['mean_overlap_rate_at_10']:.1%} | "
                    f"P50={agg['latency']['p50_ms']}ms P95={agg['latency']['p95_ms']}ms | "
                    f"计划={agg['plan_nodes']} | 空判定={agg['empty_verdicts']} | "
                    f"不稳定 {agg['stability_failures']} | 泄漏 {agg['front_matter_leak']}")

    # 过滤关闭对照：N3 的锚点全部落在无章节块，只有放开过滤才能检验它
    # 使用矩阵最后一组留下的索引（m=16 / ef_construction=64，即当前产线参数）
    log("\n过滤关闭对照（索引沿用矩阵最后一组 m=16 / ef_construction=64）…")
    for it in items:
        if it["category"] == "new-blocked":
            it["counted"] = True
    for ef_search in args.ef:
        res = measure(conn, items, args.top_k, ef_search, args.iterative,
                      False, args.repeats, exact_runs)
        res["index"] = payload["groups"][-1]["index"]
        res["query_params"] = {"ef_search": ef_search, "iterative_scan": args.iterative,
                               "mode": "auto", "force_index": False}
        payload["unfiltered_control"].append(res)
        agg = res["aggregate"]
        log(f"  ef_search={ef_search}：Top1 {agg['top1_hits']}/{agg['denominator']} "
            f"({agg['top1_rate']:.0%}) | 重合率 {agg['mean_overlap_rate_at_10']:.1%} | "
            f"P50={agg['latency']['p50_ms']}ms P95={agg['latency']['p95_ms']}ms | "
            f"计划={agg['plan_nodes']} | 空判定={agg['empty_verdicts']}")
    for it in items:
        if it["category"] == "new-blocked":
            it["counted"] = False

    log("")
    log("实验后指纹核对…")
    fp_after = fingerprint(conn)
    payload["fingerprint_after"] = fp_after
    problems = diff_fingerprint(fp_before, fp_after)
    payload["fingerprint_problems"] = problems
    if problems:
        log("❌ 指纹发生变化，必须停止并报告：")
        for p in problems:
            log(f"   - {p}")
    else:
        log("✅ 主表 / 正式索引 / v1 备份表，实验前后指纹完全一致")

    out_path = Path(args.out)
    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    log(f"\n矩阵结果已写入：{out_path}")
    return payload


def cleanup(conn, log) -> None:
    with conn.cursor() as cur:
        cur.execute(f"DROP TABLE IF EXISTS {EXP_TABLE}")
        conn.commit()
    log(f"实验表 {EXP_TABLE} 及其索引已删除")
    with conn.cursor() as cur:
        cur.execute("SELECT pg_size_pretty(pg_relation_size(%s))", (MAIN_INDEX,))
        log(f"正式索引仍在，大小 {cur.fetchone()[0]}")


def main() -> int:
    parser = argparse.ArgumentParser(description="HNSW 参数实验（实验副本）")
    parser.add_argument("--run", action="store_true", help="跑完整 9 组矩阵")
    parser.add_argument("--cleanup", action="store_true", help="删除实验表")
    parser.add_argument("--verify", action="store_true", help="只做指纹核对")
    parser.add_argument("--ef", type=int, nargs="+", default=[40, 100], help="要测的 ef_search 列表")
    parser.add_argument("--iterative", default="relaxed_order", help="hnsw.iterative_scan 取值")
    parser.add_argument("--top-k", type=int, default=10)
    parser.add_argument("--repeats", type=int, default=5)
    parser.add_argument("--limit-groups", type=int, default=0, help="只跑前 N 组索引（>0 时为 smoke 测试）")
    parser.add_argument("--no-forced", action="store_true", help="不跑强制走索引的对照模式")
    parser.add_argument("--queries", default="src/scripts/discover-queries-stage2.txt")
    parser.add_argument("--out", default=".hnsw-exp-matrix.json")
    args = parser.parse_args()

    def log(line: str) -> None:
        print(line, flush=True)

    root = Path(__file__).resolve().parents[2]
    url = load_env(root)
    conn = psycopg2.connect(url)
    conn.autocommit = False
    try:
        if args.cleanup:
            cleanup(conn, log)
        elif args.verify:
            fp = fingerprint(conn)
            log(json.dumps(fp, ensure_ascii=False, indent=2, default=str))
        elif args.run:
            run_matrix(conn, args, log)
        else:
            log("请指定 --run / --cleanup / --verify")
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
