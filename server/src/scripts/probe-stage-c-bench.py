#!/usr/bin/env python3
"""Stage C 前置探针 · 切块 / 章节归属 / embedding benchmark（实验专用，不进正式数据链路）。

红线：
  - 只读 server/.probe-cache/ 下的探针产物，**不写任何数据库表**
  - 不 import 后调用任何 upsert_* / connect()；只用纯函数与 Embedder.encode
  - embedding 结果只留在内存用于计时，**不落库、不写正式表、不动正式索引**

复用的都是产线函数（import 自 ingest-books.py），不自造切块/章节/编码逻辑：
  split_with_overlap / build_chapter_anchors / find_chapter / build_embedding_text / Embedder
"""

from __future__ import annotations

import argparse
import ctypes
import ctypes.wintypes as wintypes
import importlib.util
import json
import os
import sys
import threading
import time
from pathlib import Path

SERVER_ROOT = Path(__file__).resolve().parents[2]
PROBE_DIR = SERVER_ROOT / ".probe-cache"
CANDIDATE_PLAN = SERVER_ROOT / ".candidate-plan.json"

os.environ.setdefault("HF_HUB_OFFLINE", "1")

# ---------------------------------------------------------------------------
# 内存峰值采样（Windows：psapi.GetProcessMemoryInfo，无需 psutil）
# ---------------------------------------------------------------------------


class PROCESS_MEMORY_COUNTERS(ctypes.Structure):
    _fields_ = [
        ("cb", wintypes.DWORD),
        ("PageFaultCount", wintypes.DWORD),
        ("PeakWorkingSetSize", ctypes.c_size_t),
        ("WorkingSetSize", ctypes.c_size_t),
        ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
        ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
        ("PagefileUsage", ctypes.c_size_t),
        ("PeakPagefileUsage", ctypes.c_size_t),
    ]


_psapi = ctypes.WinDLL("psapi")
_kernel32 = ctypes.WinDLL("kernel32")

# 必须显式声明 argtypes/restype：否则 64 位句柄会被按 c_int 截断，GetProcessMemoryInfo 直接失败返回 0
_kernel32.GetCurrentProcess.restype = wintypes.HANDLE
_kernel32.GetCurrentProcess.argtypes = []
_psapi.GetProcessMemoryInfo.argtypes = [
    wintypes.HANDLE,
    ctypes.POINTER(PROCESS_MEMORY_COUNTERS),
    wintypes.DWORD,
]
_psapi.GetProcessMemoryInfo.restype = wintypes.BOOL


def rss_bytes() -> int:
    counters = PROCESS_MEMORY_COUNTERS()
    counters.cb = ctypes.sizeof(counters)
    handle = _kernel32.GetCurrentProcess()
    if _psapi.GetProcessMemoryInfo(handle, ctypes.byref(counters), counters.cb):
        return int(counters.WorkingSetSize)
    return 0


def peak_rss_bytes() -> int:
    counters = PROCESS_MEMORY_COUNTERS()
    counters.cb = ctypes.sizeof(counters)
    handle = _kernel32.GetCurrentProcess()
    if _psapi.GetProcessMemoryInfo(handle, ctypes.byref(counters), counters.cb):
        return int(counters.PeakWorkingSetSize)
    return 0


class RssSampler:
    """后台线程按固定间隔采样 RSS，用于测内存峰值（进程生命周期内的最大值）。"""

    def __init__(self, interval: float = 0.1) -> None:
        self.interval = interval
        self.samples: list[int] = []
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def __enter__(self) -> "RssSampler":
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2)

    def _run(self) -> None:
        while not self._stop.is_set():
            self.samples.append(rss_bytes())
            time.sleep(self.interval)

    @property
    def max_rss(self) -> int:
        return max(self.samples) if self.samples else 0

    @property
    def min_rss(self) -> int:
        return min(self.samples) if self.samples else 0


# ---------------------------------------------------------------------------
# 复用产线脚本（按文件路径 import，文件名含连字符不能直接 import）
# ---------------------------------------------------------------------------


def load_ingest_module():
    path = SERVER_ROOT / "src" / "scripts" / "ingest-books.py"
    spec = importlib.util.spec_from_file_location("ingest_books_probe", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"无法加载 {path}")
    module = importlib.util.module_from_spec(spec)
    # dataclass 解析注解时需要 sys.modules[cls.__module__] 存在，必须先注册再 exec
    sys.modules[spec.name] = module
    try:
        spec.loader.exec_module(module)
    except Exception:
        sys.modules.pop(spec.name, None)
        raise
    return module


def main() -> int:
    parser = argparse.ArgumentParser(description="Stage C 探针：切块 / 章节 / embedding benchmark")
    parser.add_argument("--ids", default="1661,564", help="探针书籍 ID（逗号分隔）")
    parser.add_argument("--batch", type=int, default=16, help="embedding 批大小（产线默认 16）")
    parser.add_argument("--limit-chunks", type=int, default=0, help="只跑前 N 块（0=全部），用于冒烟")
    parser.add_argument("--embed", action="store_true", help="执行 embedding benchmark")
    args = parser.parse_args()

    ing = load_ingest_module()
    plan = json.loads(CANDIDATE_PLAN.read_text(encoding="utf-8"))
    ev_by_id = {str(e["id"]): e for e in plan["evaluations"]}

    ids = [x.strip() for x in args.ids.split(",") if x.strip()]
    books: list[dict] = []

    print("=" * 78)
    print("Stage C 前置探针 · 切块与章节归属（不写库）")
    print("=" * 78)

    for book_id in ids:
        record = json.loads((PROBE_DIR / f"{book_id}.json").read_text(encoding="utf-8"))
        text = record["text"]
        chapters = record.get("chapters")
        meta = ev_by_id.get(book_id, {})
        title = meta.get("title") or record.get("title")
        author = "; ".join(a["name"] for a in meta.get("authors", [])) or None

        t0 = time.perf_counter()
        chunks = ing.split_with_overlap(
            text, chunk_size=ing.DEFAULT_CHUNK_SIZE, chunk_overlap=ing.DEFAULT_CHUNK_OVERLAP
        )
        chunk_ms = (time.perf_counter() - t0) * 1000

        anchors = ing.build_chapter_anchors(text, chapters)
        positions: list[int] = []
        cursor = 0
        for chunk in chunks:
            index = text.find(chunk, cursor)
            if index < 0:
                index = cursor
            positions.append(index)
            cursor = index + len(chunk)

        assigned = [ing.find_chapter(anchors, positions[i]) for i in range(len(chunks))]
        covered = sum(1 for t, _n in assigned if t)
        coverage = covered / len(chunks) if chunks else 0.0

        payloads = [
            ing.build_embedding_text(title, author, assigned[i][0], chunks[i]) for i in range(len(chunks))
        ]

        books.append(
            {
                "source_id": book_id,
                "title": title,
                "author": author,
                "body_chars": len(text),
                "chapter_anchors": len(anchors),
                "chunks": len(chunks),
                "chunk_ms": round(chunk_ms, 1),
                "chapter_covered": covered,
                "chapter_coverage": round(coverage, 4),
                "payloads": payloads,
            }
        )

        print(
            f"  {book_id:<6} 正文 {len(text):>8,} 字符   章节锚点 {len(anchors):>3}   "
            f"chunk {len(chunks):>5}   chapter_title 覆盖 {covered}/{len(chunks)} = {coverage:.1%}   "
            f"切块耗时 {chunk_ms:.0f} ms"
        )

    total_chunks = sum(b["chunks"] for b in books)
    total_covered = sum(b["chapter_covered"] for b in books)
    print(f"\n合计 chunk = {total_chunks:,}，chapter_title 覆盖 {total_covered:,}/{total_chunks:,} "
          f"= {total_covered / total_chunks:.1%}")

    result: dict = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "chunk_size": ing.DEFAULT_CHUNK_SIZE,
        "chunk_overlap": ing.DEFAULT_CHUNK_OVERLAP,
        "recipe": ing.CURRENT_RECIPE,
        "books": [{k: v for k, v in b.items() if k != "payloads"} for b in books],
        "totals": {
            "chunks": total_chunks,
            "chapter_covered": total_covered,
            "chapter_coverage": round(total_covered / total_chunks, 4),
        },
    }

    if not args.embed:
        (PROBE_DIR / "_probe-bench.json").write_text(
            json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        print("\n（未执行 embedding：加 --embed 才跑）")
        return 0

    # ---------------- embedding benchmark ----------------
    print("\n" + "=" * 78)
    print(f"embedding benchmark  batch={args.batch}  chunk_size={ing.DEFAULT_CHUNK_SIZE}")
    print("=" * 78)

    embedder = ing.Embedder(offline=True)
    t_load = time.perf_counter()
    embedder.load()
    load_s = time.perf_counter() - t_load
    print(f"模型加载：{load_s:.1f} s（模式={embedder.mode}，标识={embedder.model_name}，"
          f"max_seq_length={embedder.max_seq_length}）")

    all_payloads: list[str] = []
    for b in books:
        payloads = b["payloads"]
        if args.limit_chunks and len(payloads) > args.limit_chunks:
            payloads = payloads[: args.limit_chunks]
        all_payloads.extend(payloads)

    print(f"待编码 {len(all_payloads):,} 条")

    cpu_before = time.process_time()
    wall_before = time.perf_counter()
    with RssSampler(interval=0.1) as sampler:
        for start in range(0, len(all_payloads), args.batch):
            batch = all_payloads[start : start + args.batch]
            matrix = embedder.encode(batch, batch_size=args.batch)
            done = start + len(batch)
            if done % (args.batch * 20) == 0 or done == len(all_payloads):
                elapsed = time.perf_counter() - wall_before
                rate = done / elapsed if elapsed > 0 else 0
                print(f"    {done:>6,}/{len(all_payloads):,}  用时 {elapsed:7.1f} s  "
                      f"瞬时速率 {rate:6.2f} 条/s  RSS {rss_bytes() / 1048576:7.1f} MB")
    wall_s = time.perf_counter() - wall_before
    cpu_s = time.process_time() - cpu_before

    n = len(all_payloads)
    result["embedding"] = {
        "model": embedder.model_name,
        "mode": embedder.mode,
        "max_seq_length": embedder.max_seq_length,
        "batch_size": args.batch,
        "load_seconds": round(load_s, 2),
        "count": n,
        "wall_seconds": round(wall_s, 2),
        "cpu_seconds": round(cpu_s, 2),
        "avg_ms_per_item": round(wall_s * 1000 / n, 2) if n else None,
        "items_per_second": round(n / wall_s, 2) if wall_s > 0 else None,
        "cpu_cores_equivalent": round(cpu_s / wall_s, 2) if wall_s > 0 else None,
        "rss_min_mb": round(sampler.min_rss / 1048576, 1),
        "rss_max_mb": round(sampler.max_rss / 1048576, 1),
        "peak_rss_mb": round(peak_rss_bytes() / 1048576, 1),
        "cpu_count": os.cpu_count(),
    }

    # 向量正确性抽查（不落库，只校验维度与范数）
    import numpy as np

    norms = np.linalg.norm(matrix, axis=1)
    result["embedding"]["vector_dim"] = int(matrix.shape[1])
    result["embedding"]["norm_min"] = round(float(norms.min()), 4)
    result["embedding"]["norm_max"] = round(float(norms.max()), 4)

    print(f"\n向量抽查：dim={matrix.shape[1]}，范数范围 [{norms.min():.4f}, {norms.max():.4f}]")
    print(f"总计：{n:,} 条 / 墙钟 {wall_s:.1f} s / CPU {cpu_s:.1f} s / "
          f"平均 {wall_s * 1000 / n:.2f} ms 每条")
    print(f"内存：采样峰值 RSS {sampler.max_rss / 1048576:.1f} MB，"
          f"进程生命周期峰值 {peak_rss_bytes() / 1048576:.1f} MB")
    print(f"CPU：{cpu_s / wall_s:.2f} 核等价（共 {os.cpu_count()} 逻辑核）")

    (PROBE_DIR / "_probe-bench.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"\n已写入 {PROBE_DIR / '_probe-bench.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
