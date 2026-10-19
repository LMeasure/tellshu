#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
b12-buffer-probe.py —— 调完 shared_buffers 后，量「每次检索到底摸了多少块、多少块在池里」

为什么需要它：
    B.11 的结论是「单次检索工作集 ~7000 块（56MB），而 shared_buffers 只有 128MB，
    一次查询就吃掉半个缓冲池」。那个数字来自单次 EXPLAIN 的 hit=3625 + read=3407。
    调优后必须拿同一个指标对账，否则「retrieve 变快了」只是个没有解释的数字。

    如果调优真的对症，应当看到：read 大幅下降、hit 接近总块数、且**多次探针之间
    数值稳定**（说明工作集留在池里，没有每条查询重新灌一遍）。

探针向量怎么来的（必须说清楚）：
    本脚本**不加载模型**（再起一个 570MB 的 ONNX session 会挤内存、污染测量），
    改为从库里取 3 条真实 embedding 求平均再归一化，得到一个「不在库内的通用点」。
    它不是真实 query 向量，但维度和分布同域，用于量**缓冲区行为**足够；
    绝对延迟值不要拿去做预算，预算看 b12-verify-after-tuning.py。

只读：不写任何表、不改任何 GUC 的持久值（全部 set_config(..., true) 事务内）。

用法：
    C:/Python314/python.exe -u api/b12-buffer-probe.py
    C:/Python314/python.exe -u api/b12-buffer-probe.py --probes 15
"""
from __future__ import annotations

import argparse
import json
import re
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from b11_common import (  # noqa: E402
    CACHE,
    HNSW_INDEX,
    MAIN_TABLE,
    SEARCH_SQL,
    connect,
    parse_plan,
    to_literal,
)

# B.11 单次 EXPLAIN 的实测值（shared_buffers=128MB）——对账基线
# 出处：reports/stage-b11-execution-report.md 里的原始执行计划，按节点归属取：
#   Limit(总)  hit=3720 read=3407 ／ HNSW 索引扫描节点 hit=3625 read=3387
#   Execution Time: 38.053 ms
# ⚠ 别用 _b11-recall-*.json 的 per_query.shared_hit：那份是 parse_plan 取的
#   「最后一个 Buffers 行」，归属错了（中位数只有 5），不是 HNSW 节点。
B11_SINGLE = {
    "hit": 3625, "read": 3387, "total": 7012,     # HNSW 节点
    "query_hit": 3720, "query_read": 3407,        # 整条查询（含 join）
    "exec_ms": 38.053,
}


def log(msg: str) -> None:
    print(msg, flush=True)


def parse_vec(raw: object) -> list[float]:
    """psycopg2 没注册 vector 类型，返回的是 '[0.1,0.2,...]' 这种字符串。"""
    if isinstance(raw, (list, tuple)):
        return [float(x) for x in raw]
    s = str(raw).strip()
    if s.startswith("[") and s.endswith("]"):
        s = s[1:-1]
    return [float(x) for x in s.split(",") if x.strip()]


def make_probe_vectors(conn, n: int) -> list[list[float]]:
    """取 3 条真实 embedding 求平均再归一化，造 n 个通用探针点。"""
    import random

    with conn.cursor() as cur:
        cur.execute(f"SELECT embedding FROM {MAIN_TABLE} WHERE embedding IS NOT NULL LIMIT 60")
        rows = [parse_vec(r[0]) for r in cur.fetchall()]
    conn.commit()
    if not rows:
        raise RuntimeError("库里没有 embedding，探不了")

    random.seed(20261019)
    vecs: list[list[float]] = []
    for _ in range(n):
        trio = random.sample(rows, 3)
        dim = len(trio[0])
        acc = [0.0] * dim
        for v in trio:
            for i, x in enumerate(v):
                acc[i] += float(x)
        norm = sum(x * x for x in acc) ** 0.5 or 1.0
        vecs.append([x / norm for x in acc])
    return vecs


def statio_snapshot(conn) -> dict[str, int]:
    """pg_statio 累计值（索引块命中/读取 + 表块）。

    必须先 pg_stat_clear_snapshot()：PG 的统计快照是按事务缓存的，不主动清就
    会拿到上一事务的旧值，前后增量恒为 0（实测踩过）。
    """
    with conn.cursor() as cur:
        try:
            cur.execute("SELECT pg_stat_clear_snapshot()")
        except Exception:  # noqa: BLE001
            conn.rollback()
        cur.execute(
            "SELECT idx_blks_read, idx_blks_hit FROM pg_statio_user_indexes "
            "WHERE indexrelname = %s",
            (HNSW_INDEX,),
        )
        r = cur.fetchone() or (0, 0)
        cur.execute(
            "SELECT heap_blks_read, heap_blks_hit FROM pg_statio_user_tables "
            "WHERE relname = %s",
            (MAIN_TABLE,),
        )
        t = cur.fetchone() or (0, 0)
    conn.commit()
    return {
        "idx_read": int(r[0]), "idx_hit": int(r[1]),
        "heap_read": int(t[0]), "heap_hit": int(t[1]),
    }


def parse_node_buffers(plan: list[str]) -> dict[str, object]:
    """按**节点归属**取 Buffers，不能用「最后一个 Buffers 行」。

    踩过的坑：计划里每个节点都有自己的 Buffers 行，末尾还有一段
    `Planning: / Buffers: shared hit=248`。若直接取最后一行，拿到的是
    discovered_books_pkey 的 hit=2 或 Planning 的 hit=248 —— 数字小两个数量级，
    还以为 HNSW 只摸了 8 个块。必须定位到「Index Scan using <HNSW 索引>」
    这一行，再取它下面那段缩进的 Buffers。
    """
    def grab(s: str) -> tuple[int | None, int | None]:
        m1 = re.search(r"hit=(\d+)", s)
        m2 = re.search(r"read=(\d+)", s)
        return (int(m1.group(1)) if m1 else None, int(m2.group(1)) if m2 else None)

    out: dict[str, object] = {
        "hnsw_hit": None, "hnsw_read": None,
        "total_hit": None, "total_read": None,
        "exec_ms": None, "index": None, "node": None,
    }
    in_planning = False
    pending_hnsw = False
    for line in plan:
        s = line.strip()
        if s.startswith("Planning:"):
            in_planning = True
            continue
        if in_planning:
            # Planning 段里只有缩进的 Buffers 要丢掉；PG18 的 Execution Time
            # 排在 Planning 段之后且在顶格，不能一并跳过（跳过就拿不到执行时间）。
            if line[:1] in (" ", "\t"):
                continue
            in_planning = False
        if "Index Scan" in s and HNSW_INDEX in s:
            out["index"] = HNSW_INDEX
            out["node"] = "Index Scan"
            pending_hnsw = True
            continue
        if s.startswith("Buffers:"):
            h, r = grab(s)
            if pending_hnsw:
                out["hnsw_hit"], out["hnsw_read"] = h, r
                pending_hnsw = False
            elif out["total_hit"] is None:
                # 最外层节点（Limit）的 Buffers = 整条查询的总账
                out["total_hit"], out["total_read"] = h, r
        if "Execution Time:" in s:
            try:
                out["exec_ms"] = float(s.split("Execution Time:")[1].strip().split(" ")[0])
            except Exception:  # noqa: BLE001
                pass
    if out["hnsw_read"] is None:
        out["hnsw_read"] = 0   # 计划里不写 read=0，缺省即 0
    return out


def probe_once(conn, literal: str, top_k: int) -> dict[str, object]:
    """一次 EXPLAIN(ANALYZE, BUFFERS)，拿 HNSW 节点专属的 hit/read/执行时间。"""
    with conn.cursor() as cur:
        cur.execute("SELECT set_config('hnsw.ef_search', '800', true)")
        cur.execute("SELECT set_config('hnsw.iterative_scan', 'strict_order', true)")
        cur.execute("EXPLAIN (ANALYZE, BUFFERS) " + SEARCH_SQL, (literal, False, literal, top_k))
        plan = [row[0] for row in cur.fetchall()]
    conn.commit()
    return parse_node_buffers(plan)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--probes", type=int, default=10)
    ap.add_argument("--top-k", type=int, default=10)
    args = ap.parse_args()

    conn = connect()
    vecs = make_probe_vectors(conn, args.probes)

    log("── PG 当前设置 ──")
    with conn.cursor() as cur:
        for name in ("shared_buffers", "effective_cache_size"):
            cur.execute(f"SHOW {name};")
            log(f"  {name:<22} = {cur.fetchone()[0]}")
    conn.commit()

    before = statio_snapshot(conn)
    log(f"\n── {args.probes} 次探针（EXPLAIN ANALYZE BUFFERS，top_k={args.top_k}）──")

    hits: list[int] = []
    reads: list[int] = []
    totals: list[int] = []
    execs: list[float] = []
    paths: set[str] = set()
    for i, v in enumerate(vecs, 1):
        r = probe_once(conn, to_literal(v), args.top_k)
        if r["hnsw_hit"] is None:
            log(f"  probe {i:>2}: 未取到 HNSW 节点 Buffers（index={r['index']} node={r['node']}）")
            continue
        hits.append(int(r["hnsw_hit"]))
        reads.append(int(r["hnsw_read"] or 0))
        totals.append(int(r["total_hit"] or 0))
        if r["exec_ms"] is not None:
            execs.append(float(r["exec_ms"]))
        paths.add(str(r["index"] or r["node"] or "?"))
        ex = r["exec_ms"]
        log(f"  probe {i:>2}: HNSW hit={r['hnsw_hit']:>6}  read={r['hnsw_read']:>4}  "
            f"查询总 hit={r['total_hit']:>6}  exec={('%.2f ms' % ex) if ex is not None else '—'}")

    after = statio_snapshot(conn)

    def med(xs: list[float]) -> float | None:
        return round(statistics.median(xs), 2) if xs else None

    tot_med = med([h + r for h, r in zip(hits, reads)]) if hits else None
    hit_rate = (round(statistics.median(hits) / tot_med * 100, 1)
                if hits and tot_med else None)

    log("\n── 与 B.11（shared_buffers=128MB）对账 ──")
    log(f"  {'':<20}{'B.11(128MB)':>12}{'现在(2GB)':>12}")
    log(f"  {'HNSW 节点 hit':<20}{B11_SINGLE['hit']:>12}{med(hits) if hits else '—':>12}")
    log(f"  {'HNSW 节点 read':<20}{B11_SINGLE['read']:>12}{med(reads) if reads else '—':>12}")
    log(f"  {'HNSW 节点总块数':<20}{B11_SINGLE['total']:>12}{tot_med if tot_med else '—':>12}")
    log(f"  {'缓冲区命中率':<20}{'51.7%':>12}{(str(hit_rate) + '%') if hit_rate else '—':>12}")
    log(f"  {'EXPLAIN exec ms':<20}{B11_SINGLE['exec_ms']:>12}{med(execs) if execs else '—':>12}")
    log(f"  查询总 hit（含 join）中位数 = {med(totals) if totals else '—'}")

    d = {k: after[k] - before[k] for k in before}
    log("\n── pg_statio 累计增量（本轮探针期间）──")
    log("  ⚠ 本机实测该增量恒为 0（统计快照按事务缓存 + 落盘滞后），即使已调")
    log("    pg_stat_clear_snapshot() 也拿不到——**这一项不可采信**，缓冲行为一律")
    log("    以上面 EXPLAIN 的逐节点 hit/read 为准。")
    log(f"  索引块  read={d['idx_read']:>7}  hit={d['idx_hit']:>8}")
    log(f"  表块    read={d['heap_read']:>7}  hit={d['heap_hit']:>8}")
    if d["idx_read"] + d["idx_hit"]:
        rr = d["idx_hit"] / (d["idx_read"] + d["idx_hit"]) * 100
        log(f"  索引块命中率 = {rr:.1f}%")

    log(f"\n  执行路径：{', '.join(sorted(paths))}")
    if HNSW_INDEX not in paths:
        log("  ⚠ 有探针没走 HNSW 索引——路径不纯，上面数字别直接对账。")

    out = {
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "stage": "b12-buffer-probe",
        "shared_buffers": "2GB",
        "probes": args.probes,
        "per_probe": {"hit": hits, "read": reads, "total_hit": totals, "exec_ms": execs},
        "median": {"hit": med(hits), "read": med(reads), "total": tot_med,
                   "total_hit": med(totals),
                   "exec_ms": med(execs), "hit_rate_pct": hit_rate},
        "b11_single": B11_SINGLE,
        "statio_delta": d,
        "indexes_seen": sorted(paths),
    }
    dst = CACHE / "_b12-buffer-probe.json"
    dst.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    log(f"\n已存：{dst}")
    conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
