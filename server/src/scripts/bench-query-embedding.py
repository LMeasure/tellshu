# -*- coding: utf-8 -*-
"""
阶段 2 · 单条 query embedding 延迟实测

纪律：
  - 只测「线上单条 query」的编码延迟，warmup >= 10 次丢弃，正式 >= 100 次计时。
  - 绝不用 batch / ingest 的吞吐速度代替，二者常量开销被摊薄，不代表单 query。
  - 模型加载失败时：记录错误原文 + 内存状态 + 退出码，禁止估算。

用法：
  C:/Python314/python.exe -u src/scripts/bench-query-embedding.py [--repeats 120] [--warmup 12]

输出：
  server/.crawl-cache/_query-embedding-latency.json   （成功或失败都会写）
"""
from __future__ import annotations

import argparse
import ctypes
from ctypes import wintypes
import json
import os
import platform
import sys
import time
import traceback
from datetime import datetime
from pathlib import Path

SERVER_ROOT = Path(__file__).resolve().parents[2]
OUT_PATH = SERVER_ROOT / ".crawl-cache" / "_query-embedding-latency.json"
LOG_PATH = SERVER_ROOT / ".crawl-cache" / "_query-embedding-latency.log"

_MODEL_DIR = "BAAI/bge-m3"


# ---------------------------------------------------------------- 内存测量
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


class PROCESS_MEMORY_COUNTERS(ctypes.Structure):
    _fields_ = [
        ("cb", ctypes.c_ulong),
        ("PageFaultCount", ctypes.c_ulong),
        ("PeakWorkingSetSize", ctypes.c_size_t),
        ("WorkingSetSize", ctypes.c_size_t),
        ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
        ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
        ("PagefileUsage", ctypes.c_size_t),
        ("PeakPagefileUsage", ctypes.c_size_t),
    ]


def sys_mem() -> dict:
    m = MEMORYSTATUSEX()
    m.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
    ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m))
    return {
        "total_phys_mb": round(m.ullTotalPhys / 2**20),
        "avail_phys_mb": round(m.ullAvailPhys / 2**20),
        "memory_load_pct": m.dwMemoryLoad,
        "total_pagefile_mb": round(m.ullTotalPageFile / 2**20),
        "avail_pagefile_mb": round(m.ullAvailPageFile / 2**20),
    }


def rss_mb() -> tuple[float, float]:
    """返回 (当前 RSS MB, 峰值 RSS MB)。必须声明 argtypes/restype，否则读到 0。"""
    c = PROCESS_MEMORY_COUNTERS()
    c.cb = ctypes.sizeof(PROCESS_MEMORY_COUNTERS)
    psapi = ctypes.WinDLL("psapi")
    psapi.GetProcessMemoryInfo.argtypes = [
        wintypes.HANDLE, ctypes.POINTER(PROCESS_MEMORY_COUNTERS), ctypes.c_ulong,
    ]
    psapi.GetProcessMemoryInfo.restype = wintypes.BOOL
    ok = psapi.GetProcessMemoryInfo(
        ctypes.windll.kernel32.GetCurrentProcess(), ctypes.byref(c), c.cb
    )
    if not ok:
        return -1.0, -1.0
    return round(c.WorkingSetSize / 2**20, 1), round(c.PeakWorkingSetSize / 2**20, 1)


def log(msg: str) -> None:
    line = f"[{datetime.now().strftime('%H:%M:%S')}] {msg}"
    print(line, flush=True)
    with LOG_PATH.open("a", encoding="utf-8") as fh:
        fh.write(line + "\n")


def percentile(sorted_vals: list[float], q: float) -> float:
    """线性插值分位数，q ∈ [0,1]。"""
    n = len(sorted_vals)
    if n == 0:
        return -1.0
    pos = q * (n - 1)
    lo = int(pos)
    hi = min(lo + 1, n - 1)
    frac = pos - lo
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * frac


# ---------------------------------------------------------------- 主流程
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--warmup", type=int, default=12, help="预热次数，丢弃不计时（>=10）")
    ap.add_argument("--repeats", type=int, default=120, help="正式计时次数（>=100）")
    ap.add_argument("--model", default=_MODEL_DIR)
    args = ap.parse_args()

    if args.warmup < 10:
        ap.error("--warmup 必须 >= 10")
    if args.repeats < 100:
        ap.error("--repeats 必须 >= 100")

    LOG_PATH.write_text("", encoding="utf-8")  # 每次运行清空，避免多轮混淆

    result: dict = {
        "timestamp": datetime.now().isoformat(timespec="seconds"),
        "script": "src/scripts/bench-query-embedding.py",
        "model": args.model,
        "model_source": "local cache only (HF_HUB_OFFLINE=1, local_files_only=True)",
        "warmup_discarded": args.warmup,
        "repeats_timed": args.repeats,
        "python": sys.version.split()[0],
        "platform": platform.platform(),
        "env": {
            "HF_HUB_OFFLINE": os.environ.get("HF_HUB_OFFLINE", ""),
            "OMP_NUM_THREADS": os.environ.get("OMP_NUM_THREADS", ""),
        },
        "status": None,
        "mem_before_load": sys_mem(),
        "attempts": [],
    }

    log(f"run start; avail={result['mem_before_load']['avail_phys_mb']} MB, "
        f"warmup={args.warmup}, repeats={args.repeats}")

    attempt = {"stage": "import", "ok": False}
    try:
        t0 = time.perf_counter()
        import sentence_transformers  # noqa: F401
        attempt["import_s"] = round(time.perf_counter() - t0, 2)
        attempt["sentence_transformers_version"] = sentence_transformers.__version__
        attempt["ok"] = True
        log(f"import ok in {attempt['import_s']}s; version={attempt['sentence_transformers_version']}")
    except BaseException:  # noqa: BLE001
        attempt["error"] = traceback.format_exc()
        log("import FAILED")
    finally:
        result["attempts"].append(attempt)
        OUT_PATH.write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")

    if not attempt["ok"]:
        result["status"] = "FAILED_AT_IMPORT"
        result["mem_at_failure"] = sys_mem()
        OUT_PATH.write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
        log("status=FAILED_AT_IMPORT; see JSON for traceback")
        return 1

    load = {"stage": "model_load", "ok": False}
    try:
        from sentence_transformers import SentenceTransformer

        log(f"loading {args.model} ...")
        t0 = time.perf_counter()
        model = SentenceTransformer(args.model, local_files_only=True)
        load["load_s"] = round(time.perf_counter() - t0, 2)
        load["model_id"] = str(model[0].auto_model.name_or_path)
        load["max_seq_length"] = int(getattr(model, "max_seq_length", -1))
        load["ok"] = True
        rss_now, rss_peak = rss_mb()
        load["rss_after_load_mb"] = rss_now
        load["rss_peak_mb"] = rss_peak
        result["mem_after_load"] = sys_mem()
        log(f"model loaded in {load['load_s']}s; rss={rss_now} MB")
    except BaseException:  # noqa: BLE001
        load["error"] = traceback.format_exc()
        rss_now, rss_peak = rss_mb()
        load["rss_at_failure_mb"] = rss_now
        log(f"model load FAILED; rss={rss_now} MB")
        result["attempts"].append(load)
        result["status"] = "FAILED_AT_MODEL_LOAD"
        result["mem_at_failure"] = sys_mem()
        OUT_PATH.write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
        return 2
    result["attempts"].append(load)

    # ---- warmup（丢弃） ------------------------------------------------
    short = "一位侦探调查一桩离奇的命案"
    long_ = ("一位立志推行医疗改革的年轻医生娶了热心公益的富家小姐，婚后两人的理想都被一点点磨损，"
             "而彼此的家庭、亲戚和遗嘱的附加条款不断改变他们的处境")
    try:
        for i in range(args.warmup):
            model.encode([short], normalize_embeddings=True)
            model.encode([long_], normalize_embeddings=True)
        log(f"warmup done ({args.warmup} x 2, discarded)")
    except BaseException:  # noqa: BLE001
        result["attempts"].append({"stage": "warmup", "ok": False,
                                   "error": traceback.format_exc()})
        result["status"] = "FAILED_AT_WARMUP"
        result["mem_at_failure"] = sys_mem()
        OUT_PATH.write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
        log("warmup FAILED")
        return 3

    # ---- 正式计时 ------------------------------------------------------
    out: dict = {}
    for name, q in (("short_query_12char", short), ("long_query_77char", long_)):
        ts: list[float] = []
        peak = 0.0
        for _ in range(args.repeats):
            a = time.perf_counter()
            model.encode([q], normalize_embeddings=True)
            ts.append((time.perf_counter() - a) * 1000)
            _, pk = rss_mb()
            peak = max(peak, pk)
        ts.sort()
        out[name] = {
            "query_text": q,
            "query_chars": len(q),
            "repeats": args.repeats,
            "min_ms": round(ts[0], 2),
            "p50_ms": round(percentile(ts, 0.50), 2),
            "p95_ms": round(percentile(ts, 0.95), 2),
            "p99_ms": round(percentile(ts, 0.99), 2),
            "avg_ms": round(sum(ts) / len(ts), 2),
            "max_ms": round(ts[-1], 2),
            "rss_peak_mb": round(peak, 1),
        }
        log(f"  {name}: p50={out[name]['p50_ms']}ms p95={out[name]['p95_ms']}ms "
            f"p99={out[name]['p99_ms']}ms avg={out[name]['avg_ms']}ms rss_peak={peak}MB")

    result["results"] = out
    result["status"] = "OK"
    result["mem_after_run"] = sys_mem()
    OUT_PATH.write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
    log("status=OK")
    return 0


if __name__ == "__main__":
    code = main()
    sys.exit(code)
