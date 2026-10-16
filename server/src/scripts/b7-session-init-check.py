# -*- coding: utf-8 -*-
"""
B.7 · 验证「连接池 connect 钩子」这种真实部署姿势是否同样能修掉饥饿。

B.7 矩阵用的是事务级 set_config(..., true)（= SET LOCAL）。
但真正落到应用里更可能是连接池 connect 钩子：每条连接建立时设一次（false = 会话级），
之后该连接上的所有事务都继承。本脚本验证这条路也走得通，并且**不影响其它连接**（红线 R5）。

对照组：
  A 连接（已 init，strict_order，会话级）  —— 期望 0 饥饿
  B 连接（未 init，什么都不设）            —— 期望复现饥饿（off 默认）
  C 新连接（只查 SHOW）                    —— 期望 iterative_scan 仍是 off（R5）

用法（PowerShell）：
  C:/Python314/python.exe -u src/scripts/b7-session-init-check.py --run
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
OUT_JSON = CACHE / "_b7-session-init-check.json"
DEFAULT_QUERIES = "../discover-query-set-v3.json"


def load_b6():
    path = Path(__file__).resolve().parent / "stage-b6-experiment.py"
    spec = importlib.util.spec_from_file_location("stage_b6", path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["stage_b6"] = mod
    if spec.loader is None:
        raise RuntimeError("无法载入 stage-b6-experiment.py")
    spec.loader.exec_module(mod)
    return mod


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", action="store_true")
    ap.add_argument("--queries", default=DEFAULT_QUERIES)
    ap.add_argument("--top-k", type=int, default=10)
    ap.add_argument("--ef", type=int, default=40)
    args = ap.parse_args()

    root = SERVER_ROOT
    os.chdir(root)
    url = b6.load_env(root)

    def log(m: str = "") -> None:
        print(m, flush=True)

    if not args.run:
        log("dry-run。加 --run 执行。")
        return 0

    import psycopg2

    qset = b6.load_query_set(Path(args.queries), root)
    conn0 = psycopg2.connect(url)
    conn0.autocommit = False
    avail = b6.chapter_availability(conn0)
    blocked = {bid for bid, n in avail.items() if n == 0}
    conn0.close()

    ev = b6.load_eval_module()
    log("加载本地 BGE-M3（离线）…")
    model = ev.load_model()
    items = []
    for row in qset["rows"]:
        ids = [int(row["book_id"])] if row.get("book_id") else []
        is_blocked = bool(ids) and all(i in blocked for i in ids)
        counted = bool(row.get("counted", True)) and not is_blocked
        if not counted:
            continue
        items.append({"id": row["query_id"], "literal": ev.encode(model, row["query"])})
    log(f"编码完成：{len(items)} 条计入分母的 query")
    del model  # 尽快释放，避免挤压 OS 页缓存影响后续

    sql = b6.search_sql(True, args.top_k)

    def run_conn(label: str, init: list[tuple[str, str]] | None) -> dict:
        """init: [(guc, value)] 用 set_config(..., false) 在连接建立时设一次。"""
        c = psycopg2.connect(url)
        c.autocommit = False
        cur = c.cursor()
        if init:
            for guc, val in init:
                cur.execute("SELECT set_config(%s, %s, false)", (guc, val))
            c.commit()
        starved = under = 0
        rows_dist: dict[int, int] = {}
        t0 = time.time()
        for it in items:
            cur.execute("BEGIN")
            cur.execute(sql, (it["literal"], it["literal"]))
            rows = cur.fetchall()
            c.commit()
            n = len(rows)
            rows_dist[n] = rows_dist.get(n, 0) + 1
            if n == 0:
                starved += 1
            elif n < args.top_k:
                under += 1
        cur.close()
        c.close()
        out = {
            "label": label,
            "init": init or [],
            "starved": starved,
            "underfilled": under,
            "rows_distribution": {str(k): v for k, v in sorted(rows_dist.items())},
            "seconds": round(time.time() - t0, 1),
        }
        log(f"  {label:<34} starved={starved:<3} underfilled={under:<3} "
            f"rows分布={out['rows_distribution']}")
        return out

    log("")
    log(f"ef={args.ef}，top_k={args.top_k}，过滤=开")
    results = []
    results.append(run_conn("A 已init(strict_order, 会话级)",
                            [("hnsw.ef_search", str(args.ef)),
                             ("hnsw.iterative_scan", "strict_order"),
                             ("enable_seqscan", "off")]))
    results.append(run_conn("B 未init（复现今天生产）", None))
    results.append(run_conn("C 已init(relaxed_order, 会话级)",
                            [("hnsw.ef_search", str(args.ef)),
                             ("hnsw.iterative_scan", "relaxed_order"),
                             ("enable_seqscan", "off")]))

    # R5：全新连接必须仍然是 off
    c = psycopg2.connect(url)
    cur = c.cursor()
    cur.execute("SELECT NULL::vector")
    cur.execute("SHOW hnsw.iterative_scan")
    new_sess_iscan = cur.fetchone()[0]
    cur.execute("SHOW hnsw.ef_search")
    new_sess_ef = cur.fetchone()[0]
    cur.close()
    c.close()
    log("")
    log(f"  R5 新会话检查：iterative_scan={new_sess_iscan}（期望 off）、"
        f"ef_search={new_sess_ef}（期望 40）")

    payload = {
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "ef": args.ef,
        "top_k": args.top_k,
        "n_queries": len(items),
        "results": results,
        "new_session_iterative_scan": new_sess_iscan,
        "new_session_ef_search": new_sess_ef,
    }
    OUT_JSON.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    log(f"\n写入 {OUT_JSON}")
    return 0


if __name__ == "__main__":
    b6 = load_b6()
    raise SystemExit(main())
