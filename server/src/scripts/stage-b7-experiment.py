# -*- coding: utf-8 -*-
"""
Stage B.7 · 决策落地与验证（只读，不改正式资产）

与 B.6 的关系：完全复用 B.6 的评估逻辑（load_query_set / measure / parse_plan / fingerprint），
**不修改 B.6 文件本身**，只用 monkey-patch 把 iterative_scan 从「二态」扩成「三态」：
    off            = 今天生产的默认（会饥饿）
    strict_order   = 迭代扫描 + 严格保持距离顺序
    relaxed_order  = 迭代扫描 + 允许轻微乱序（B.6 非 strict 臂用的就是这个）

矩阵：ef ∈ {40, 120, 200, 400, 800} × iscan ∈ {off, strict_order, relaxed_order} + EXACT 基准
     过滤口径固定为「开」（chapter_title IS NOT NULL），与生产一致。

全程只读：GUC 一律事务内 set_config(..., true)；不改 postgresql.conf、不改 ef_search 默认值。
输出：.crawl-cache/_b7-matrix.json
用法（必须在原生 PowerShell 下跑，Git Bash 下 import torch 会 SIGSEGV）：
    C:/Python314/python.exe -u src/scripts/stage-b7-experiment.py --run --repeats 5 --top-k 10 --resume
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
import time
from pathlib import Path

SERVER_ROOT = Path(__file__).resolve().parents[2]
CACHE = SERVER_ROOT / ".crawl-cache"
OUT_JSON = CACHE / "_b7-matrix.json"
DEFAULT_QUERIES = "../discover-query-set-v3.json"

EF_VALUES = [40, 120, 200, 400, 800]
ISCAN_VALUES = ["off", "strict_order", "relaxed_order"]


def load_b6():
    """把 stage-b6-experiment.py 当模块载入，复用它的全部评估逻辑。"""
    path = Path(__file__).resolve().parent / "stage-b6-experiment.py"
    spec = importlib.util.spec_from_file_location("stage_b6", path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["stage_b6"] = mod
    if spec.loader is None:
        raise RuntimeError("无法载入 stage-b6-experiment.py")
    spec.loader.exec_module(mod)
    return mod


def patch_run_once(b6):
    """三态 iterative_scan 版 run_once，替换 B.6 的二态版本。

    注意：B.6 的 measure() 在自己的模块命名空间里调用全局 run_once，
    所以只要替换 b6.run_once，measure 里所有调用都会走到新版本。
    """

    def run_once(conn, literal: str, top_k: int, arm: dict, filter_on: bool, explain: bool):
        sql = b6.search_sql(filter_on, top_k)
        with conn.cursor() as cur:
            if arm["mode"] == "ann":
                cur.execute("SELECT set_config('hnsw.ef_search', %s, true)", (str(arm["ef"]),))
                cur.execute("SELECT set_config('enable_seqscan', 'off', true)")
            elif arm["mode"] == "exact":
                cur.execute("SELECT set_config('enable_indexscan', 'off', true)")
                cur.execute("SELECT set_config('enable_bitmapscan', 'off', true)")
                cur.execute("SELECT set_config('enable_indexonlyscan', 'off', true)")
            # 三态：off / strict_order / relaxed_order，全部事务内，commit 后自动失效
            cur.execute(
                "SELECT set_config('hnsw.iterative_scan', %s, true)",
                (arm.get("iscan", "relaxed_order"),),
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

    b6.run_once = run_once


def build_arms() -> list[dict]:
    arms: list[dict] = [{"name": "exact", "mode": "exact", "ef": None, "iscan": "off"}]
    for ef in EF_VALUES:
        for iscan in ISCAN_VALUES:
            arms.append({
                "name": f"ef{ef}-{iscan}",
                "mode": "ann",
                "ef": ef,
                "iscan": iscan,
            })
    return arms


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Stage B.7：iterative_scan 修复验证 + ef 重验")
    ap.add_argument("--run", action="store_true")
    ap.add_argument("--queries", default=DEFAULT_QUERIES)
    ap.add_argument("--top-k", type=int, default=10)
    ap.add_argument("--repeats", type=int, default=5)
    ap.add_argument("--out", default=str(OUT_JSON))
    ap.add_argument("--resume", action="store_true")
    ap.add_argument("--efs", nargs="*", type=int, default=EF_VALUES)
    args = ap.parse_args(argv)

    root = SERVER_ROOT
    os.chdir(root)
    url = b6.load_env(root)
    out_path = root / args.out
    out_path.parent.mkdir(parents=True, exist_ok=True)

    def log(msg: str = "") -> None:
        print(msg, flush=True)

    conn = psycopg2.connect(url)
    conn.autocommit = False
    try:
        fp_before = b6.fingerprint(conn)
        log("=" * 78)
        log("Stage B.7 · iterative_scan 修复验证 + ef 重验（只读）")
        log("=" * 78)
        log(f"主表 {fp_before['main_rows']} 行 / embedding {fp_before['main_embeddings']}")
        log(f"会话默认 hnsw.ef_search={fp_before['session_default_ef_search']} "
            f"iterative_scan={fp_before['session_default_iterative_scan']}")
        log("")

        qset = b6.load_query_set(Path(args.queries), root)
        log(f"查询集：{len(qset['rows'])} 条（计入分母 {qset['counted_total']}）")

        if not args.run:
            log("未指定 --run，什么都不做。")
            return 0

        arms = [a for a in build_arms()
                if a["mode"] == "exact" or a["ef"] in args.efs]
        avail = b6.chapter_availability(conn)
        blocked_books = {bid for bid, n in avail.items() if n == 0}
        log(f"无任何有章节块的书：{len(blocked_books)} 本")

        ev = b6.load_eval_module()
        log("加载本地 BGE-M3 模型（离线 HF_HUB_OFFLINE=1）…")
        model = ev.load_model()

        items: list[dict] = []
        for row in qset["rows"]:
            expected = row["expected_book"]
            ids = [int(row["book_id"])] if row.get("book_id") else b6.book_ids_for_title(conn, expected)
            blocked = bool(ids) and all(i in blocked_books for i in ids)
            items.append({
                "id": row["query_id"],
                "query": row["query"],
                "expected": expected,
                "category": row["category"],
                "anchor": row.get("anchor"),
                "counted_base": bool(row.get("counted", True)),
                "blocked_when_filtered": blocked and bool(row.get("counted", True)),
                "literal": ev.encode(model, row["query"]),
            })
        # B.6 的 measure() 读的是 item["counted"]（按当前过滤口径现算）。
        # B.7 过滤恒为「开」，所以直接：基础分母 且 未被章节块过滤挡掉。
        for it in items:
            it["counted"] = it["counted_base"] and not it["blocked_when_filtered"]

        n_base = sum(1 for it in items if it["counted_base"])
        n_blocked = sum(1 for it in items if it["blocked_when_filtered"])
        log(f"编码完成：{len(items)} 条；过滤开启分母 = {n_base - n_blocked}")
        log("")

        results: dict[str, dict] = {}
        if args.resume and out_path.exists():
            try:
                prev = json.loads(out_path.read_text(encoding="utf-8"))
                results = dict(prev.get("results", {}))
                log(f"断点续跑：已载入 {len(results)} 段，重复的段会跳过")
            except Exception as exc:  # noqa: BLE001
                log(f"（无法读取已有结果，从头跑：{exc}）")
        started = time.time()

        def checkpoint() -> None:
            payload = {
                "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
                "fingerprint_before": fp_before,
                "fingerprint_after": b6.fingerprint(conn),
                "config": {
                    "top_k": args.top_k,
                    "repeats": args.repeats,
                    "arms": [a["name"] for a in arms],
                    "ef_values": args.efs,
                    "iscan_values": ISCAN_VALUES,
                    "queries_file": args.queries,
                    "filter": "on（chapter_title IS NOT NULL，与生产一致）",
                    "denominator_filtered": n_base - n_blocked,
                },
                "results": results,
            }
            out_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

        for arm in arms:
            key = arm["name"]
            if key in results:
                log(f"  [{key:>22}] 已有结果，跳过")
                continue
            t0 = time.time()
            seg = b6.measure(conn, items, arm, True, args.top_k, args.repeats, log)
            seg["segment_seconds"] = round(time.time() - t0, 1)
            results[key] = seg
            checkpoint()
            agg = seg["aggregate"]
            log(f"  [{key:>22}] starved={agg['starved_queries']} "
                f"underfilled={agg['underfilled_queries']} path={agg['plan_paths']}")
        log("")
        log(f"矩阵完成，用时 {(time.time()-started)/60:.1f} 分钟")

        payload = {
            "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "elapsed_seconds": round(time.time() - started, 1),
            "fingerprint_before": fp_before,
            "fingerprint_after": b6.fingerprint(conn),
            "fingerprint_diffs": b6.diff_fingerprint(fp_before, b6.fingerprint(conn)),
            "config": {
                "top_k": args.top_k,
                "repeats": args.repeats,
                "arms": [a["name"] for a in arms],
                "ef_values": args.efs,
                "iscan_values": ISCAN_VALUES,
                "queries_file": args.queries,
                "filter": "on（chapter_title IS NOT NULL，与生产一致）",
                "denominator_filtered": n_base - n_blocked,
            },
            "results": results,
        }
        out_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        log(f"写入 {out_path}")
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    import psycopg2

    b6 = load_b6()
    patch_run_once(b6)
    raise SystemExit(main())
