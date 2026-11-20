"""
Stage C · ingest runner（只读包装层，不改 ingest 逻辑）

为什么需要它：ingest-books.py 只输出每本的 chunk 数，没有耗时与内存数据。
本脚本以子进程方式原样调用 ingest-books.py，只在外层做三件事：
  1. 给每行输出加时间戳 → 可反推每本书的耗时；
  2. 每 2 秒采样一次子进程 RSS → 得到内存峰值；
  3. 把上述结果写成 JSON，供 Stage C 报告引用。

不做：不改切块、不改 embedding、不碰数据库、不建索引。
"""

from __future__ import annotations

import ctypes
import json
import os
import subprocess
import sys
import threading
import time
from datetime import datetime
from pathlib import Path

SERVER_ROOT = Path(__file__).resolve().parents[2]
# 标签化输出：默认 _stage-c-ingest，设 RUN_INGEST_TAG 可换名（避免覆盖上一轮日志）
_TAG = os.environ.get("RUN_INGEST_TAG", "stage-c-ingest").strip() or "stage-c-ingest"
LOG_PATH = SERVER_ROOT / ".crawl-cache" / f"_{_TAG}.log"
JSON_PATH = SERVER_ROOT / ".crawl-cache" / f"_{_TAG}.json"

# ---- Windows 进程内存读取（与 probe-stage-c-bench.py 同款实现） -------------
_kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
_psapi = ctypes.WinDLL("psapi", use_last_error=True)

_kernel32.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32]
_kernel32.OpenProcess.restype = ctypes.c_void_p
_kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
_kernel32.CloseHandle.restype = ctypes.c_int
_psapi.GetProcessMemoryInfo.argtypes = [
    ctypes.c_void_p, ctypes.c_char_p, ctypes.c_uint32
]
_psapi.GetProcessMemoryInfo.restype = ctypes.c_int

PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
PROCESS_VM_READ = 0x0010


class PROCESS_MEMORY_COUNTERS(ctypes.Structure):
    _fields_ = [
        ("cb", ctypes.c_uint32),
        ("PageFaultCount", ctypes.c_uint32),
        ("PeakWorkingSetSize", ctypes.c_size_t),
        ("WorkingSetSize", ctypes.c_size_t),
        ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
        ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
        ("PagefileUsage", ctypes.c_size_t),
        ("PeakPagefileUsage", ctypes.c_size_t),
    ]


def read_rss(pid: int) -> tuple[int, int]:
    """返回 (当前工作集字节, 峰值工作集字节)。读不到返回 (0, 0)。"""
    handle = _kernel32.OpenProcess(
        PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, False, pid
    )
    if not handle:
        return (0, 0)
    try:
        counters = PROCESS_MEMORY_COUNTERS()
        counters.cb = ctypes.sizeof(counters)
        raw = ctypes.string_at(ctypes.byref(counters), ctypes.sizeof(counters))
        ok = _psapi.GetProcessMemoryInfo(
            ctypes.c_void_p(handle), raw, ctypes.sizeof(counters)
        )
        if not ok:
            return (0, 0)
        parsed = PROCESS_MEMORY_COUNTERS.from_buffer_copy(raw)
        return (parsed.WorkingSetSize, parsed.PeakWorkingSetSize)
    finally:
        _kernel32.CloseHandle(ctypes.c_void_p(handle))


def main(argv: list[str]) -> int:
    env = dict(os.environ)
    env["HF_HUB_OFFLINE"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"

    cmd = [
        sys.executable,
        "-u",
        str(SERVER_ROOT / "src" / "scripts" / "ingest-books.py"),
        *argv,
    ]
    print("运行命令:", " ".join(cmd[1:]), flush=True)

    started = time.time()
    proc = subprocess.Popen(
        cmd,
        cwd=str(SERVER_ROOT),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
    )
    assert proc.stdout is not None

    samples: list[int] = []
    peak_working_set = 0
    stop = threading.Event()

    def sampler() -> None:
        nonlocal peak_working_set
        while not stop.is_set():
            current, peak = read_rss(proc.pid)
            if current:
                samples.append(current)
            peak_working_set = max(peak_working_set, peak)
            stop.wait(2.0)

    thread = threading.Thread(target=sampler, daemon=True)
    thread.start()

    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    book_lines: list[dict[str, object]] = []
    with LOG_PATH.open("w", encoding="utf-8") as log:
        for line in proc.stdout:
            stamp = datetime.now().strftime("%H:%M:%S")
            text = line.rstrip("\n")
            log.write(f"[{stamp}] {text}\n")
            log.flush()
            print(f"[{stamp}] {text}", flush=True)
            if "chunk=" in text and "recipe=" in text:
                book_lines.append({"ts": stamp, "line": text})
        code = proc.wait()

    stop.set()
    thread.join(timeout=5)

    elapsed = time.time() - started
    summary = {
        "command": " ".join(cmd[1:]),
        "exit_code": code,
        "wall_seconds": round(elapsed, 1),
        "rss_samples": len(samples),
        "rss_max_mb": round(max(samples) / 1048576, 1) if samples else 0,
        "rss_peak_workingset_mb": round(peak_working_set / 1048576, 1),
        "book_lines": book_lines,
    }
    JSON_PATH.write_text(
        json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print()
    print("=" * 60)
    print(f"退出码={code}  总耗时={elapsed/60:.1f} 分钟  "
          f"RSS 采样峰值={summary['rss_max_mb']} MB  "
          f"生命周期峰值={summary['rss_peak_workingset_mb']} MB")
    print(f"日志={LOG_PATH}")
    print(f"指标={JSON_PATH}")
    print("=" * 60)
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
