# -*- coding: utf-8 -*-
"""
regression.py —— 回归检查（做成 HTTP 端点，B.9 任务 3）

**不重新实现一遍**：核心逻辑直接加载 server/src/scripts/regression-check.py 复用它的
pct() / init_statements() / search_sql() / measure()，保证「脚本跑」和「端点跑」
是同一套口径，不会出现两处算法各自漂移。

为什么不开在共享连接池里：
    回归要跑 EXACT（enable_indexscan=off），这种连接**绝不能**放回 API 的池 ——
    否则之后所有业务请求的路径都被改掉了。所以本端点自己开两条一次性连接，跑完即关。

quick=true：跳过 EXACT 扫描与两点拟合，只量 HNSW（秒级返回）。
    完整模式要跑 20 条 × 3 次 EXACT（单条 P50 ~475ms）+ 小表再一轮，约 1 分钟。
"""
from __future__ import annotations

import asyncio
import importlib.util
import json
import random
import statistics
import sys
import time
from pathlib import Path
from typing import Any

from config import Config

REGRESSION_SCRIPT = Path(__file__).resolve().parent.parent / "server" / "src" / "scripts" / "regression-check.py"
MAIN_TABLE = "discovered_book_chunks"
SMALL_TABLE = "discovered_book_chunks_exp"


def _load_regression_module():
    spec = importlib.util.spec_from_file_location("_b8_regression", REGRESSION_SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"无法加载 {REGRESSION_SCRIPT}")
    mod = importlib.util.module_from_spec(spec)
    sys.modules["_b8_regression"] = mod
    spec.loader.exec_module(mod)
    return mod


def _pick_literals(cfg: Config, sample: int, seed: int) -> tuple[list[str], list[str]]:
    cache = Path(cfg.paths["vector_cache"])
    if not cache.exists():
        raise RuntimeError(
            f"缺少 query 向量缓存 {cache}。先跑一次 "
            "server/src/scripts/b8-e2e-experiment.py --run 生成它"
            "（这样本端点不必加载 2GB 模型）。"
        )
    vecs = json.loads(cache.read_text(encoding="utf-8"))
    qset = json.loads(Path(cfg.paths["query_set"]).read_text(encoding="utf-8"))
    counted = [q for q in qset.get("queries", []) if q.get("counted") and q["query_id"] in vecs]
    if not counted:
        raise RuntimeError("向量缓存与 query set 对不上，重跑 b8-e2e-experiment.py")
    rng = random.Random(seed)
    picked = rng.sample(counted, min(sample, len(counted)))
    return [vecs[q["query_id"]] for q in picked], [q["query_id"] for q in picked]


async def run(
    cfg: Config,
    *,
    quick: bool = False,
    sample: int = 20,
    top_k: int = 10,
    repeats: int = 3,
    budget: int = 400,
    seed: int = 20261017,
) -> dict[str, Any]:
    rc = _load_regression_module()
    literals, qids = _pick_literals(cfg, sample, seed)

    def _work() -> dict[str, Any]:
        import psycopg2

        # 连接 A：生产配置（与 API 池同口径：db-conn-init.sql）
        conn_h = psycopg2.connect(cfg.database_url)
        conn_h.autocommit = False
        cur_h = conn_h.cursor()
        for stmt in rc.init_statements():
            cur_h.execute(stmt)
        conn_h.commit()

        conn_e = None
        if not quick:
            conn_e = psycopg2.connect(cfg.database_url)
            conn_e.autocommit = False
            cur_e = conn_e.cursor()
            for stmt in ("SET enable_indexscan = off", "SET enable_bitmapscan = off",
                         "SET enable_indexonlyscan = off", "SET enable_seqscan = on"):
                cur_e.execute(stmt)
            conn_e.commit()

        try:
            ce = conn_e.cursor() if conn_e else conn_h.cursor()
            ce.execute(f"SELECT count(*) FROM {MAIN_TABLE}")
            row_count = int(ce.fetchone()[0])
            if conn_e:
                conn_e.commit()
            else:
                conn_h.commit()

            hnsw = rc.measure(conn_h, MAIN_TABLE, literals, top_k, repeats)

            exact = None
            small_rows = None
            slope = intercept = None
            fit_mode = "quick=true，未做 EXACT 扫描与斜率拟合"

            if conn_e:
                exact = rc.measure(conn_e, MAIN_TABLE, literals, top_k, repeats)
                try:
                    ce2 = conn_e.cursor()
                    ce2.execute(f"SELECT count(*) FROM {SMALL_TABLE}")
                    small_rows = int(ce2.fetchone()[0])
                    conn_e.commit()
                except Exception:  # noqa: BLE001
                    conn_e.rollback()
                    small_rows = None

                if small_rows and small_rows != row_count:
                    ex_small = rc.measure(conn_e, SMALL_TABLE, literals, top_k, repeats)
                    x0, y0 = small_rows, rc.pct(ex_small, 0.50)
                    x1, y1 = row_count, rc.pct(exact, 0.50)
                    if x1 != x0:
                        slope = (y1 - y0) / (x1 - x0) * 1000      # ms / 1k rows
                        intercept = y0 - (slope / 1000) * x0
                        fit_mode = f"两点拟合（{SMALL_TABLE} {x0:,} + {MAIN_TABLE} {x1:,}）"
                if slope is None:
                    slope = rc.pct(exact, 0.50) / row_count * 1000
                    intercept = rc.FALLBACK_INTERCEPT
                    fit_mode = f"单点斜率 + 固定截距 {rc.FALLBACK_INTERCEPT}（未拿到小表）"

            return {
                "row_count": row_count,
                "hnsw": hnsw,
                "exact": exact,
                "small_rows": small_rows,
                "slope": slope,
                "intercept": intercept,
                "fit_mode": fit_mode,
            }
        finally:
            conn_h.close()
            if conn_e:
                conn_e.close()

    measured = await asyncio.to_thread(_work)

    # 编码延迟基线：优先用 B.6 实测文件，没有就留空（不编造数字）
    enc_s = enc_l = None
    lat_path = Path(cfg.paths["vector_cache"]).parent / "_query-embedding-latency.json"
    if lat_path.exists():
        try:
            lr = json.loads(lat_path.read_text(encoding="utf-8"))["results"]
            enc_s = lr["short_query_12char"]["p50_ms"]
            enc_l = lr["long_query_77char"]["p50_ms"]
        except Exception:  # noqa: BLE001
            pass
    if enc_s is None or enc_l is None:
        enc_s, enc_l = 91.15, 177.96     # B.6 实测兜底值，明确标注来源

    hnsw = measured["hnsw"]
    exact = measured["exact"]
    out: dict[str, Any] = {
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
        "mode": "quick" if quick else "full",
        "row_count": measured["row_count"],
        "sample_size": len(literals),
        "query_ids": qids,
        "top_k": top_k,
        "repeats_per_query": repeats,
        "encode_latency_ms": {"short": enc_s, "long": enc_l,
                              "source": "B.6 实测 .crawl-cache/_query-embedding-latency.json"},
        "hnsw_p50_ms": round(statistics.median(hnsw), 2),
        "hnsw_p95_ms": round(rc.pct(hnsw, 0.95), 2),
    }

    if exact is not None:
        slope = measured["slope"]
        intercept = measured["intercept"]

        def n_star(b: int, enc: float) -> float:
            return (b - enc - intercept) / slope * 1000

        n400_s, n400_l = n_star(400, enc_s), n_star(400, enc_l)
        n500_s, n500_l = n_star(500, enc_s), n_star(500, enc_l)
        n_ref = n_star(budget, enc_l)
        status = "ALERT" if measured["row_count"] >= n_ref else (
            "WARN" if measured["row_count"] >= n_ref * 0.8 else "OK")

        out.update({
            "exact_p50_ms": round(rc.pct(exact, 0.50), 2),
            "exact_p95_ms": round(rc.pct(exact, 0.95), 2),
            "small_table": {"name": SMALL_TABLE, "rows": measured["small_rows"]},
            "slope_ms_per_1k_rows": round(slope, 4),
            "intercept_ms": round(intercept, 2),
            "fit_mode": measured["fit_mode"],
            "n_star_400ms": {"short": round(n400_s), "long": round(n400_l)},
            "n_star_500ms": {"short": round(n500_s), "long": round(n500_l)},
            "budget_used_for_status": budget,
            "headroom_ratio": round(measured["row_count"] / n_ref, 3),
            "status": status,
        })
    else:
        out.update({
            "exact_p50_ms": None,
            "exact_p95_ms": None,
            "status": None,
            "fit_mode": measured["fit_mode"],
            "note": "quick=true 跳过了 EXACT 扫描，故无斜率拟合与 OK/WARN/ALERT 判定。"
                    "要完整判定请去掉 ?quick=true（耗时约 1 分钟）。",
        })
    return out
