# -*- coding: utf-8 -*-
"""
b11-common.py —— B.11 各阶段共用的小工具（只读数据库 / 池化判定 / 内存快照 / McNemar）

⚠ 红线：
    - 检索 SQL 从 api/retrieve.py 的 SEARCH_SQL **逐字复制**，不重写。
    - GUC 一律 set_config(..., true)（事务内），与查询同事务；裸 SET 污染连接池，禁用。
    - 本文件不写任何业务表。
"""
from __future__ import annotations

import json
import math
import os
import re
import time
from pathlib import Path
from typing import Any, Sequence

ROOT = Path(__file__).resolve().parent.parent
SERVER = ROOT / "server"
INIT_SQL = SERVER / "src" / "scripts" / "db-conn-init.sql"
QUERY_SET = ROOT / "discover-query-set-v3.json"
CACHE = SERVER / ".crawl-cache"

HNSW_INDEX = "discovered_book_chunks_embedding_hnsw_idx"
MAIN_TABLE = "discovered_book_chunks"

# ---- 与 api/retrieve.py 逐字一致（只用于召回对照，投影列不影响执行计划）----
SEARCH_SQL = """
            SELECT c.id                             AS chunk_id,
                   b.id                             AS book_id,
                   b.title                          AS title,
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


def log(msg: str) -> None:
    print(f"[ .. ] {msg}", flush=True)


def load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if not s or s.startswith("#") or "=" not in s:
            continue
        k, _, v = s.partition("=")
        os.environ.setdefault(k.strip(), v.strip().strip("'\""))


def init_statements() -> list[str]:
    """连接初始化语句（与 api/db.py 的 _connect 同款做法）。"""
    if not INIT_SQL.exists():
        raise RuntimeError(f"缺少 {INIT_SQL}")
    stmts: list[str] = []
    for chunk in INIT_SQL.read_text(encoding="utf-8").split(";"):
        body = "\n".join(
            ln for ln in chunk.splitlines() if not ln.lstrip().startswith("--")
        ).strip()
        if body:
            stmts.append(body)
    return stmts


def connect() -> Any:
    """建一条连接并执行初始化语句（SELECT NULL::vector 不能省）。"""
    import psycopg2

    load_dotenv(SERVER / ".env")
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError("缺少 DATABASE_URL（检查 server/.env）")
    conn = psycopg2.connect(url)
    conn.autocommit = False
    with conn.cursor() as cur:
        for stmt in init_statements():
            cur.execute(stmt)
    conn.commit()
    return conn


def to_literal(vec: Sequence[float]) -> str:
    """与 eval-discover.py / api/embed.py 完全一致的 6 位小数字面量。"""
    return "[" + ",".join(f"{float(v):.6f}" for v in vec) + "]"


def parse_plan(plan: list[str] | None) -> dict[str, Any]:
    """按**索引名**判路径（B.6 的教训：只看有没有 Index Scan 会误判）。"""
    if not plan:
        return {"node": None, "index": None, "path": None,
                "shared_hit": None, "shared_read": None, "execution_time_ms": None}
    raw = "\n".join(plan)
    node = "Seq Scan" if "Seq Scan" in raw else ("Index Scan" if "Index Scan" in raw else "other")
    idx_names = re.findall(r"Index Scan using (\S+)", raw)
    if HNSW_INDEX in idx_names:
        index, path = HNSW_INDEX, "hnsw_ann"
    elif node == "Seq Scan":
        index, path = None, "seq_exact"
    elif idx_names:
        index, path = ",".join(sorted(set(idx_names))), "other_index_exact"
    else:
        index, path = None, "other"
    hit = read = None
    exec_ms = None
    for line in plan:
        s = line.strip()
        if s.startswith("Buffers:"):
            m1 = re.search(r"shared\s+hit=(\d+)", s)
            m2 = re.search(r"(?:shared\s+)?read=(\d+)", s)
            if m1:
                hit = int(m1.group(1))
            if m2:
                read = int(m2.group(1))
        if "Execution Time:" in s:
            try:
                exec_ms = float(s.split("Execution Time:")[1].strip().split(" ")[0])
            except Exception:  # noqa: BLE001
                pass
    return {"node": node, "index": index, "path": path,
            "shared_hit": hit, "shared_read": read, "execution_time_ms": exec_ms}


def search_once(conn, literal: str, top_k: int, explain: bool) -> tuple[list, float, dict]:
    """一次检索。GUC 用事务内 set_config(..., true)，commit 后自动重置。"""
    with conn.cursor() as cur:
        cur.execute("SELECT set_config('hnsw.ef_search', '800', true)")
        cur.execute("SELECT set_config('hnsw.iterative_scan', 'strict_order', true)")
        plan = None
        if explain:
            cur.execute("EXPLAIN (ANALYZE, BUFFERS) " + SEARCH_SQL, (literal, False, literal, top_k))
            plan = [row[0] for row in cur.fetchall()]
        t0 = time.perf_counter()
        cur.execute(SEARCH_SQL, (literal, False, literal, top_k))
        rows = cur.fetchall()
        wall_ms = (time.perf_counter() - t0) * 1000
        conn.commit()
    return rows, wall_ms, parse_plan(plan)


def hit(expected: str, title: str) -> bool:
    """期望书名以子串方式出现在命中书名里即算命中（B.6/eval-discover 同口径）。"""
    if not expected:
        return False
    return expected.lower() in (title or "").lower()


def load_counted_queries(n: int | None = None) -> list[dict[str, Any]]:
    data = json.loads(QUERY_SET.read_text(encoding="utf-8"))
    rows = [r for r in data.get("queries", []) if r.get("counted")]
    return rows[:n] if n else rows


def mem_snapshot() -> dict[str, float]:
    import ctypes

    class MEMORYSTATUSEX(ctypes.Structure):
        _fields_ = [
            ("dwLength", ctypes.c_ulong),
            ("dwMemoryLoad", ctypes.c_ulong),
            ("ullTotalPhys", ctypes.c_ulonglong),
            ("ullAvailPhys", ctypes.c_ulonglong),
            ("ullTotalPageFile", ctypes.c_ulonglong),
            ("ullAvailPageFile", ctypes.c_ulonglong),
            ("ullTotalVirtual", ctypes.c_ulonglong),
            ("ullAvailVirtual", ctypes.c_ulonglong),
            ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
        ]

    stat = MEMORYSTATUSEX()
    stat.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
    ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat))
    out = {
        "load_pct": float(stat.dwMemoryLoad),
        "avail_gb": round(stat.ullAvailPhys / 1024**3, 2),
        "rss_gb": 0.0,
    }
    try:
        import psutil  # type: ignore[import-untyped]

        out["rss_gb"] = round(psutil.Process().memory_info().rss / 1024**3, 2)
        return out
    except Exception:  # noqa: BLE001
        pass
    # psutil 不在（本机 PyPI 502 装不上）→ 用 GetProcessMemoryInfo 拿 WorkingSetSize
    try:

        class PROCESS_MEMORY_COUNTERS_EX(ctypes.Structure):
            _fields_ = [
                ("cb", ctypes.c_ulong), ("PageFaultCount", ctypes.c_ulong),
                ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t),
                ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t), ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t),
                ("PrivateUsage", ctypes.c_size_t),
            ]

        # 两个坑：① GetProcessMemoryInfo 在 psapi.dll 不在 kernel32；
        #        ② GetCurrentProcess 必须显式声明 restype=c_void_p，
        #           否则句柄被截断成 32 位，调用静默返回 0（实测踩过）。
        pmc = PROCESS_MEMORY_COUNTERS_EX()
        pmc.cb = ctypes.sizeof(PROCESS_MEMORY_COUNTERS_EX)
        kernel32 = ctypes.windll.kernel32
        kernel32.GetCurrentProcess.restype = ctypes.c_void_p
        psapi = ctypes.windll.psapi
        psapi.GetProcessMemoryInfo.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_ulong]
        ok = psapi.GetProcessMemoryInfo(
            kernel32.GetCurrentProcess(), ctypes.byref(pmc), pmc.cb
        )
        if ok:
            out["rss_gb"] = round(pmc.WorkingSetSize / 1024**3, 2)
            out["private_gb"] = round(pmc.PrivateUsage / 1024**3, 2)
    except Exception:  # noqa: BLE001
        pass
    return out


def pct(values: list[float], q: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    idx = min(len(ordered) - 1, max(0, int(round((len(ordered) - 1) * q))))
    return ordered[idx]


def mcnemar_exact(b: int, c: int) -> dict[str, Any]:
    """精确 McNemar（配对二择）。b = A 中 B 不中，c = A 不中 B 中。

    用二项分布精确计算（不靠 statsmodels，避免为一次比对装依赖）：
        p = 2 * Σ_{k=0..min(b,c)} C(n,k) * 0.5^n   （n = b + c，双尾）
    """
    n = b + c
    if n == 0:
        return {"b": b, "c": c, "n": 0, "p_value": 1.0, "note": "无不一致对"}
    tail = sum(math.comb(n, k) for k in range(min(b, c) + 1))
    p = min(1.0, 2.0 * tail / (2**n))
    return {"b": b, "c": c, "n": n, "p_value": round(p, 6),
            "note": "p<0.05 视为显著差异"}
