#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
test_m4_discover.py —— M4 书籍 HNSW 检索用例 · 三层验收脚本

背景：B.8~B.12 把检索链路（BGE-M3 编码 + pgvector HNSW ef=800/strict_order）
从「直连 DB 实验」推进到「HTTP API 只读服务」，并在 B.12 把 shared_buffers
调到 2GB 后拿到稳态 retrieve P50 ≈ 8.5ms。M4 要回答的问题只剩一个：

    **这条链路以公开 HTTP 契约对外交付时，行为与延迟是否仍然成立？**

三层结构（Layer A 任一断言失败即停止正式验收，不带着坏环境往下跑）：

    Layer A  环境前置
             A1 query set 结构（106 行 / 100 counted，与文件自述一致）
             A2 根端点 / 服务信息
             A3 /api/discover/health：HTTP 200 + status=ok + GUC 实测匹配 +
                执行计划实测 HNSW + 编码后端就绪
             A4 数据基线：直连 PG 只读计数，对齐 query set 里的 frozen_baseline
                （books/chunks/embeddings），并确认 HNSW 索引在位。
                数值级健康（NaN/范数）由 verify-discover.py 负责，本脚本不重复。

    Layer B  HTTP 契约与检索正确性
             B1 100 条 counted query 的响应契约：200 + results/latency/meta 三键 +
                results 每项 8 字段 + score∈[-1,1] + meta.returned==len(results) +
                meta.ef_search=800 / iterative_scan=strict_order /
                include_front_matter=False + latency 三项非负
             B2 每个响应都带 X-Request-Id（结构化日志贯通）
             B3 检索正确性（recall）：B.8 hits 口径（expected_book 子串匹配
                results 的 title），与 B.11 各量化变体产物逐 query 对比，
                给出 flip 明细与 rank-1 书名一致性
             B4 400 行为矩阵：缺字段 / 空 query / top_k 越界 / 未实测 ef_search /
                book_filter|chapter_filter 未实现 / query 超长 / 非法 JSON，
                断言状态码 + error.code + 不回传堆栈
             B5 边界与空结果：top_k=1 / top_k=50 / ef_search=400 /
                include_front_matter=true 正向边界；「空结果分支在当前冻结
                数据集下不可达」作为结构事实记录，并靠 B1 的
                meta.returned==len(results) 全量不变量兜底 —— 不伪造触发

    Layer C  延迟画像
             C0 冷启动/首触样本：本次运行的第一个 /api/discover 请求，
                单独列示，永远不进热态统计
             C1 100 条 × 3 次连发，每条取后 2 次（热态口径，与回归端点同口径）
             C2 encode / retrieve / e2e（服务端口径）+ client_ms（客户端墙钟）
                的 P50/P95/P99/mean/max
             C3 判定：retrieve P50 ≤ 15ms（阈值出处 b12-verify-after-tuning.py:50）

口径铁律（B.10/B.12 的教训，混口径就会算错预算）：
    · Layer C 是「每条 3 次取后 2 次」热态口径；B.12 的 HTTP 压测是
      「首次触碰」口径，两者不可互相替代，所以 C0 与 C1 的数字分开呈现。
    · 冷启动/首触样本单独列，不混入热态统计。

红线：
    · 只读：除把本脚本自己的产物写进 server/.crawl-cache/_m4-acceptance.json
      外，不写任何文件、不改任何数据 / 检索 SQL / PG 参数。
    · 不编造：召回与延迟基线全部从 .crawl-cache 里的 B.8/B.11/B.12 原始产物
      在运行时读取，脚本里不硬编码基线数字。唯一硬编码的是 15ms 目标阈值，
      与 b12-verify-after-tuning.py 保持一致。
    · urllib 必须绕过本机 http_proxy（否则 127.0.0.1 也走代理 → 502）。

用法（API 已在 127.0.0.1:8000 跑起来之后）：
    C:/Python314/python.exe -u api/test_m4_discover.py
    C:/Python314/python.exe -u api/test_m4_discover.py --base http://127.0.0.1:8000
    C:/Python314/python.exe -u api/test_m4_discover.py --n 5     # 冒烟（只跑前 5 条）
"""
from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from b11_common import CACHE, QUERY_SET, connect, hit, pct  # noqa: E402

TOP_K = 10
REPEATS = 3                      # 每条 query 连发 3 次，取后 2 次（热态口径）
TARGET_RETRIEVE_MS = 15.0        # 阈值出处：b12-verify-after-tuning.py:50
TIMEOUT_S = 60
LATENCY_KEYS = ("encode_ms", "retrieve_ms", "e2e_ms")
RESULT_FIELDS = ("chunk_id", "book_id", "title", "author",
                 "chapter_title", "chunk_index", "content", "score")

# 本机环境设有 http_proxy，urllib 默认会把 127.0.0.1 也走代理 → 502。
# 显式建一个「无代理」opener，所有请求都从它出。
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


# ---------------------------------------------------------------------------
# 基础设施：HTTP / JSON / 报告
# ---------------------------------------------------------------------------

def http(method: str, url: str, payload: Any = None, *,
         raw: bytes | None = None) -> tuple[int, Any, str]:
    """发一次请求，返回 (status, headers, body_text)。4xx/5xx 不抛异常，由调用方判定。"""
    data = None
    headers = {"Accept": "application/json"}
    if raw is not None:
        data = raw
        headers["Content-Type"] = "application/json"
    elif payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with OPENER.open(req, timeout=TIMEOUT_S) as resp:
            return resp.status, resp.headers, resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.headers, exc.read().decode("utf-8")
    except urllib.error.URLError as exc:
        return -1, None, f"连接失败：{exc}"


def json_or_none(text: str) -> Any:
    try:
        return json.loads(text)
    except Exception:  # noqa: BLE001
        return None


def read_json(path: Path) -> Any:
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return None


class Report:
    """收集 PASS/WARN/FAIL/INFO 四态检查结果，最后统一出总结。"""

    def __init__(self) -> None:
        self.rows: list[dict[str, str]] = []

    def add(self, layer: str, name: str, status: str, detail: str = "") -> None:
        self.rows.append({"layer": layer, "name": name, "status": status, "detail": detail})
        icon = {"PASS": "✅", "WARN": "⚠️", "FAIL": "❌", "INFO": "ℹ️"}[status]
        line = f"  [{layer}] {icon} {name}"
        if detail:
            line += f" —— {detail}"
        print(line, flush=True)

    def check(self, layer: str, name: str, ok: bool, detail: str = "") -> bool:
        self.add(layer, name, "PASS" if ok else "FAIL", detail)
        return bool(ok)

    def warn(self, layer: str, name: str, detail: str = "") -> None:
        self.add(layer, name, "WARN", detail)

    def info(self, layer: str, name: str, detail: str = "") -> None:
        self.add(layer, name, "INFO", detail)

    def fail(self, layer: str, name: str, detail: str = "") -> None:
        self.add(layer, name, "FAIL", detail)

    def counts(self) -> dict[str, int]:
        c = {"PASS": 0, "WARN": 0, "FAIL": 0, "INFO": 0}
        for r in self.rows:
            c[r["status"]] += 1
        return c


def stats(xs: list[float]) -> dict[str, float]:
    """汇总口径与 B 系压测产物一致（pct 用 b11_common 的 nearest-rank）。"""
    if not xs:
        return {}
    return {
        "n": len(xs),
        "p50": round(pct(xs, 0.50), 2),
        "p95": round(pct(xs, 0.95), 2),
        "p99": round(pct(xs, 0.99), 2),
        "mean": round(statistics.fmean(xs), 2),
        "max": round(max(xs), 2),
        "min": round(min(xs), 2),
    }


# ---------------------------------------------------------------------------
# Layer A · 环境前置
# ---------------------------------------------------------------------------

def layer_a(base: str, report: Report) -> dict[str, Any]:
    print("\n── Layer A · 环境前置 ──", flush=True)
    env: dict[str, Any] = {}

    # A1 query set 结构
    qset = json_or_none(QUERY_SET.read_text(encoding="utf-8"))
    if not isinstance(qset, dict):
        report.fail("A1", "query set 读取失败", str(QUERY_SET))
        return env
    counted = [q for q in qset.get("queries", []) if q.get("counted")]
    self_reported = (qset.get("summary") or {}).get("counted")
    report.check("A1", "query set counted 数与文件自述一致",
                 len(counted) == self_reported and len(counted) > 0,
                 f"实际 counted={len(counted)}，文件自述={self_reported}")
    frozen = (qset.get("meta") or {}).get("frozen_baseline") or {}
    env["query_set"] = {"file": str(QUERY_SET), "rows_total": len(qset.get("queries", [])),
                        "counted": len(counted), "frozen_baseline": frozen}

    # A2 根端点
    status, _, text = http("GET", base + "/")
    body = json_or_none(text)
    ok = status == 200 and isinstance(body, dict) and "述树" in str(body.get("service", ""))
    report.check("A2", "GET / 服务信息", ok, f"HTTP {status}")

    # A3 health：GUC 实测 + 执行计划实测 + 编码后端就绪
    status, _, text = http("GET", base + "/api/discover/health")
    h = json_or_none(text) or {}
    report.check("A3a", "health HTTP 200 + status=ok",
                 status == 200 and h.get("status") == "ok",
                 f"HTTP {status} status={h.get('status')}")
    db = h.get("database") or {}
    report.check("A3b", "GUC 实测匹配（ef_search=800 / iterative_scan=strict_order）",
                 db.get("guc_match") is True,
                 f"ef={db.get('ef_search')} iscan={db.get('iterative_scan')}")
    plan = h.get("plan") or {}
    report.check("A3c", "执行计划实测 = HNSW",
                 plan.get("type") == "HNSW" and plan.get("ok") is True,
                 f"type={plan.get('type')} index={plan.get('index')} "
                 f"rows={plan.get('rows_returned')}")
    emb = h.get("embedding") or {}
    report.check("A3d", "编码后端就绪", emb.get("ready") is True,
                 f"backend={emb.get('backend')} dim={emb.get('dim')}")
    env["health"] = {"ef_search": db.get("ef_search"),
                     "iterative_scan": db.get("iterative_scan"),
                     "plan_type": plan.get("type"), "index": plan.get("index"),
                     "backend": emb.get("backend"), "model": emb.get("model"),
                     "uptime_seconds": h.get("uptime_seconds")}

    # A4 数据基线：直连 PG 只读计数，与 frozen_baseline 对齐。
    # 数值级健康（NaN/范数）由 verify-discover.py 负责，这里只做行数 + 索引复核。
    try:
        conn = connect()
        try:
            cur = conn.cursor()
            cur.execute("SELECT count(*) FROM discovered_books")
            books = int(cur.fetchone()[0])
            cur.execute("SELECT count(*) FROM discovered_book_chunks")
            chunks = int(cur.fetchone()[0])
            cur.execute("SELECT count(*) FROM discovered_book_chunks WHERE embedding IS NULL")
            no_emb = int(cur.fetchone()[0])
            cur.execute("SELECT count(*) FROM discovered_book_chunks "
                        "WHERE chapter_title IS NOT NULL")
            chaptered = int(cur.fetchone()[0])
            cur.execute("SELECT indexname FROM pg_indexes "
                        "WHERE tablename = 'discovered_book_chunks'")
            idx = {r[0] for r in cur.fetchall()}
            conn.commit()
        finally:
            conn.close()
    except Exception as exc:  # noqa: BLE001
        report.fail("A4", "数据基线查询失败（PG 不可达或凭据缺失）", str(exc))
        return env

    env["db_baseline"] = {"books": books, "chunks": chunks,
                          "with_embedding": chunks - no_emb,
                          "chaptered_chunks": chaptered,
                          "hnsw_index_present":
                              "discovered_book_chunks_embedding_hnsw_idx" in idx}
    ok = (frozen.get("books") == books and frozen.get("chunks") == chunks
          and frozen.get("embeddings") == chunks - no_emb)
    report.check("A4a", "数据基线与 frozen_baseline 一致（只读计数）", ok,
                 f"books={books} chunks={chunks} 有向量={chunks - no_emb}"
                 f"（期望 {frozen.get('books')}/{frozen.get('chunks')}/"
                 f"{frozen.get('embeddings')}）")
    report.check("A4b", "HNSW 索引在位",
                 "discovered_book_chunks_embedding_hnsw_idx" in idx,
                 f"章节块(排除 front matter)={chaptered}")
    return env


# ---------------------------------------------------------------------------
# Layer B · HTTP 契约与检索正确性
# ---------------------------------------------------------------------------

def layer_b(base: str, counted: list[dict[str, Any]], report: Report,
            chaptered: int | None, *, partial: bool = False) -> dict[str, Any]:
    print(f"\n── Layer B · HTTP 契约与检索正确性（{len(counted)} 条 counted）──",
          flush=True)
    b: dict[str, Any] = {"per_query": []}
    top1 = top3 = top10 = 0
    starved = underfilled = 0
    contract_bad: list[str] = []
    rid_bad: list[str] = []

    for q in counted:
        status, headers, text = http("POST", base + "/api/discover",
                                     {"query": q["query"], "top_k": TOP_K})
        body = json_or_none(text)
        problems: list[str] = []
        if status != 200:
            problems.append(f"HTTP {status}")
        if not isinstance(body, dict):
            problems.append("响应不是 JSON 对象")
            body = {}
        results = body.get("results")
        if not isinstance(results, list):
            problems.append("缺 results 数组")
            results = []
        meta = body.get("meta") if isinstance(body.get("meta"), dict) else {}
        lat = body.get("latency") if isinstance(body.get("latency"), dict) else {}
        if not all(k in body for k in ("results", "latency", "meta")):
            problems.append("缺 results/latency/meta 之一")
        if meta.get("returned") != len(results):
            problems.append(f"meta.returned={meta.get('returned')} != "
                            f"len(results)={len(results)}")
        if str(meta.get("ef_search")) != "800":
            problems.append(f"meta.ef_search={meta.get('ef_search')!r}")
        if meta.get("iterative_scan") != "strict_order":
            problems.append(f"meta.iterative_scan={meta.get('iterative_scan')!r}")
        if meta.get("include_front_matter") is not False:
            problems.append(f"meta.include_front_matter={meta.get('include_front_matter')!r}")
        for k in LATENCY_KEYS:
            v = lat.get(k)
            if not isinstance(v, (int, float)) or isinstance(v, bool) or v < 0:
                problems.append(f"latency.{k}={v!r}")
        for i, item in enumerate(results):
            if not isinstance(item, dict):
                problems.append(f"results[{i}] 不是对象")
                continue
            missing = [f for f in RESULT_FIELDS if f not in item]
            if missing:
                problems.append(f"results[{i}] 缺字段 {missing}")
            s = item.get("score")
            if isinstance(s, (int, float)) and not (-1.0 <= float(s) <= 1.0):
                problems.append(f"results[{i}].score={s} 越界")
        if not headers or not headers.get("X-Request-Id"):
            rid_bad.append(q["query_id"])
        if problems:
            contract_bad.append(f"{q['query_id']}: {'; '.join(problems[:3])}")

        titles = [str(r.get("title") or "") for r in results]
        h1 = any(hit(q["expected_book"], t) for t in titles[:1])
        h3 = any(hit(q["expected_book"], t) for t in titles[:3])
        h10 = any(hit(q["expected_book"], t) for t in titles[:TOP_K])
        top1 += h1
        top3 += h3
        top10 += h10
        if len(results) == 0:
            starved += 1
        elif len(results) < TOP_K:
            underfilled += 1
        b["per_query"].append({
            "query_id": q["query_id"], "expected": q["expected_book"],
            "top1_title": titles[0] if titles else "",
            "hit_top1": h1, "hit_top3": h3, "hit_top10": h10,
            "rows": len(results),
        })

    n = len(counted)
    report.check("B1", f"响应契约（{n} 条全量）", not contract_bad,
                 "全部通过" if not contract_bad else
                 f"{len(contract_bad)} 条违规：{contract_bad[:5]}")
    report.check("B2", "每个响应都带 X-Request-Id", not rid_bad,
                 "全部通过" if not rid_bad else f"缺失：{rid_bad[:5]}")

    # ---- B3 recall：基线全部从原始产物运行时读取，不硬编码 ----
    baselines: dict[str, Any] = {}
    for name, fname, kind in (
        ("b8_direct_torch", "_b8-e2e.json", "b8"),
        ("torch", "_b11-recall-torch.json", "b11"),
        ("fp32", "_b11-recall-fp32.json", "b11"),
        ("int8_per_tensor", "_b11-recall-int8.json", "b11"),
        ("int8_per_channel_prod", "_b11-recall-int8pc.json", "b11"),
    ):
        d = read_json(CACHE / fname)
        if not d:
            continue
        if kind == "b8":
            r = d.get("recall") or {}
            baselines[name] = {"top1": r.get("top1"), "top3": r.get("top3"),
                               "top10": r.get("top10"), "starved": r.get("starved"),
                               "underfilled": r.get("underfilled"),
                               "denominator": d.get("denominator"),
                               "file": fname}
        else:
            baselines[name] = {"top1": d.get("top1_hits"), "top10": d.get("top10_hits"),
                               "starved": d.get("starved"),
                               "underfilled": d.get("underfilled"),
                               "denominator": d.get("denominator"),
                               "per_query": d.get("per_query"), "file": fname}
    b["baselines"] = {k: {kk: vv for kk, vv in v.items() if kk != "per_query"}
                      for k, v in baselines.items()}
    b["recall"] = {"top1": top1, "top3": top3, "top10": top10,
                   "starved": starved, "underfilled": underfilled, "denominator": n}

    prod = baselines.get("int8_per_channel_prod")
    per_tensor = baselines.get("int8_per_tensor")
    onnx_variants = [v for v in (per_tensor, prod) if v]
    if partial:
        # 冒烟运行（--n < 全量）：基线是 100 条口径，部分样本没有可比性，
        # 只报数不判定 —— 拿 3 条的结果去对 47/69 的基线是自欺。
        report.warn("B3", "冒烟运行（部分样本），recall 判定跳过",
                    f"本次 {n} 条 vs 基线分母 {n if not prod else prod.get('denominator')}；"
                    f"本次 top1={top1} top10={top10}。全量运行请去掉 --n")
    elif prod is None or not onnx_variants:
        report.warn("B3", "召回基线产物缺失，只报数不判定",
                    f"top1={top1} top3={top3} top10={top10}（/{n}）")
    else:
        floor_top1 = min(v["top1"] for v in onnx_variants)
        floor_top10 = min(v["top10"] for v in onnx_variants)
        exact = top1 == prod["top1"] and top10 == prod["top10"]
        floor_ok = top1 >= floor_top1 and top10 >= floor_top10
        # 逐 query flip 明细：与生产口径（int8 逐通道）的 per_query 对比
        base_pq = {r["query_id"]: r for r in (prod.get("per_query") or [])}
        flips: list[str] = []
        rank1_diff: list[str] = []
        for r in b["per_query"]:
            bp = base_pq.get(r["query_id"])
            if not bp:
                continue
            if bool(r["hit_top1"]) != bool(bp.get("hit_top1")):
                flips.append(f"{r['query_id']}(top1 {bp.get('hit_top1')}→{r['hit_top1']})")
            if bool(r["hit_top10"]) != bool(bp.get("hit_top10")):
                flips.append(f"{r['query_id']}(top10 {bp.get('hit_top10')}→{r['hit_top10']})")
            bt = str(bp.get("top1") or "").strip().lower()
            if bt and r["top1_title"].strip().lower() != bt:
                rank1_diff.append(f"{r['query_id']}({bt}→{r['top1_title'].strip().lower()})")
        b["flips_vs_prod"] = flips
        b["rank1_title_diffs"] = rank1_diff
        detail = (f"top1={top1}/{n} top3={top3}/{n} top10={top10}/{n}；"
                  f"生产口径基线 top1={prod['top1']} top10={prod['top10']}"
                  f"（{prod['file']}）；量化下限 top1≥{floor_top1} top10≥{floor_top10}")
        if exact and not flips:
            report.check("B3", "召回复现生产量化口径（ONNX int8 逐通道）", True,
                         detail + f"；rank-1 书名一致 {n - len(rank1_diff)}/{n}")
        elif floor_ok:
            report.warn("B3", "召回与生产口径有差异，但仍在已验证量化区间",
                        detail + f"；flips={flips[:6]}；rank-1 差异={len(rank1_diff)} 条")
        else:
            report.fail("B3", "召回低于已验证量化区间",
                        detail + f"；flips={flips[:6]}")
    report.check("B3b", "starved==0 且 underfilled==0（B.8/B.11 口径）",
                 starved == 0 and underfilled == 0,
                 f"starved={starved} underfilled={underfilled}")

    # ---- B4 400 行为矩阵 ----
    bad_cases: list[tuple[str, Any, str]] = [
        ("缺 query 字段", {"top_k": TOP_K}, "bad_request"),
        ("query 为空串", {"query": "", "top_k": TOP_K}, "bad_request"),
        ("top_k=0（下界外）", {"query": "a test query", "top_k": 0}, "bad_request"),
        ("top_k=51（上界外）", {"query": "a test query", "top_k": 51}, "bad_request"),
        ("ef_search=300（未经实测）", {"query": "a test query", "ef_search": 300},
         "bad_request"),
        ("book_filter 非空", {"query": "a test query",
                              "book_filter": ["Crime and Punishment"]},
         "not_implemented"),
        ("chapter_filter 非空", {"query": "a test query",
                                 "chapter_filter": ["Chapter 1"]},
         "not_implemented"),
        (f"query 超长（501 字符，上限 500）", {"query": "x" * 501}, "bad_request"),
    ]
    for name, payload, expect_code in bad_cases:
        status, _, text = http("POST", base + "/api/discover", payload)
        body = json_or_none(text) or {}
        code = ((body.get("error") or {}).get("code")) if isinstance(body, dict) else None
        ok = (status == 400 and code == expect_code
              and "Traceback" not in text and "traceback" not in text.lower())
        report.check("B4", f"400 行为：{name}", ok,
                     f"HTTP {status} code={code}（期望 {expect_code}）")
    # 非法 JSON body
    status, _, text = http("POST", base + "/api/discover", None,
                           raw=b'{"query": "broken"')
    body = json_or_none(text) or {}
    code = ((body.get("error") or {}).get("code")) if isinstance(body, dict) else None
    report.check("B4", "400 行为：非法 JSON body",
                 status == 400 and bool(code) and "Traceback" not in text,
                 f"HTTP {status} code={code}")

    # ---- B5 正向边界 + 空结果结构事实 ----
    probe_q = counted[0]["query"] if counted else "a test query"
    pos_cases: list[tuple[str, Any, Any]] = [
        ("top_k=1（下界）", {"query": probe_q, "top_k": 1},
         lambda b, m: len(b.get("results", [])) == 1 and m.get("returned") == 1),
        ("top_k=50（上界）", {"query": probe_q, "top_k": 50},
         lambda b, m: len(b.get("results", [])) == 50 and m.get("returned") == 50),
        ("ef_search=400（合法实测值）", {"query": probe_q, "ef_search": 400},
         lambda b, m: str(m.get("ef_search")) == "400"),
        ("include_front_matter=true", {"query": probe_q, "include_front_matter": True},
         lambda b, m: m.get("include_front_matter") is True
         and len(b.get("results", [])) > 0),
    ]
    for name, payload, judge in pos_cases:
        status, _, text = http("POST", base + "/api/discover", payload)
        body = json_or_none(text)
        ok = status == 200 and isinstance(body, dict) and judge(body, body.get("meta") or {})
        report.check("B5", f"正向边界：{name}", ok, f"HTTP {status}")
    # 空结果分支：当前冻结库下不可达，作为结构事实记录，不伪造触发
    report.info("B5", "空结果分支可达性",
                f"章节块={chaptered} 条 ≫ top_k 上限 50，任何合法 query 必然返回 "
                f"min(top_k, {chaptered}) 行 —— results=[] 分支在公开 HTTP 契约 + "
                f"当前数据集下不可达；其安全性由 B1 全量覆盖的 "
                f"meta.returned==len(results) 不变量兜底（本脚本不伪造触发）")
    return b


# ---------------------------------------------------------------------------
# Layer C · 延迟画像
# ---------------------------------------------------------------------------

def cold_probe(base: str, first_query: dict[str, Any]) -> dict[str, Any]:
    """本次验收运行的第一个 /api/discover 请求（首触样本，单独列示）。

    注意：API 进程往往已先于本脚本运行过（health/自检已把模型与连接池预热），
    所以这个样本不等于「重启后的严格冷启动」；严格冷启动要重启 API（+PG），
    本脚本刻意不重启 —— 重启属于环境动作，不属于验收动作。最接近的实测冷启动
    参考是 B.12 的 _b12-run0-cold.json（Layer C 会并列展示）。
    """
    t0 = time.perf_counter()
    status, _, text = http("POST", base + "/api/discover",
                           {"query": first_query["query"], "top_k": TOP_K})
    client_ms = (time.perf_counter() - t0) * 1000
    body = json_or_none(text) or {}
    lat = body.get("latency") or {}
    return {"query_id": first_query["query_id"], "status": status,
            "client_ms": round(client_ms, 2),
            "encode_ms": lat.get("encode_ms"), "retrieve_ms": lat.get("retrieve_ms"),
            "e2e_ms": lat.get("e2e_ms"), "rows": len(body.get("results") or [])}


def layer_c(base: str, counted: list[dict[str, Any]], report: Report,
            cold: dict[str, Any]) -> dict[str, Any]:
    print(f"\n── Layer C · 延迟画像（{len(counted)} 条 × {REPEATS} 次，取后 2 次）──",
          flush=True)
    c: dict[str, Any] = {"cold_first_touch": cold, "per_query": []}
    enc: list[float] = []
    ret: list[float] = []
    e2e: list[float] = []
    client: list[float] = []
    http_bad: list[str] = []

    for q in counted:
        samples: list[dict[str, Any]] = []
        for _ in range(REPEATS):
            t0 = time.perf_counter()
            status, _, text = http("POST", base + "/api/discover",
                                   {"query": q["query"], "top_k": TOP_K})
            cms = (time.perf_counter() - t0) * 1000
            body = json_or_none(text) or {}
            lat = body.get("latency") or {}
            samples.append({"status": status, "client_ms": cms,
                            "encode_ms": lat.get("encode_ms"),
                            "retrieve_ms": lat.get("retrieve_ms"),
                            "e2e_ms": lat.get("e2e_ms")})
        if any(s["status"] != 200 for s in samples):
            http_bad.append(q["query_id"])
        keep = samples[1:]        # 热态口径：3 次取后 2 次，第 1 次视为首触丢弃
        c["per_query"].append({
            "query_id": q["query_id"],
            "retrieve_ms": [round(float(s["retrieve_ms"]), 2) for s in keep],
            "e2e_ms": [round(float(s["e2e_ms"]), 2) for s in keep],
        })
        for s in keep:
            if any(s[k] is None for k in LATENCY_KEYS):
                http_bad.append(q["query_id"])
                continue
            enc.append(float(s["encode_ms"]))
            ret.append(float(s["retrieve_ms"]))
            e2e.append(float(s["e2e_ms"]))
            client.append(s["client_ms"])

    report.check("C1", f"热态测量请求全部 200（{len(counted) * REPEATS} 次）",
                 not http_bad, "全部通过" if not http_bad else f"异常：{http_bad[:5]}")

    now = {"encode_ms": stats(enc), "retrieve_ms": stats(ret),
           "e2e_ms": stats(e2e), "client_ms": stats(client)}
    c["hot"] = now

    # C3 判定：retrieve P50 ≤ 15ms
    r50 = now["retrieve_ms"]["p50"]
    report.check("C3", f"retrieve P50 ≤ {TARGET_RETRIEVE_MS}ms（热态口径）",
                 r50 <= TARGET_RETRIEVE_MS,
                 f"P50={r50} P95={now['retrieve_ms']['p95']} "
                 f"P99={now['retrieve_ms']['p99']} max={now['retrieve_ms']['max']}")

    # ---- 与原始产物基线并列（只读 .crawl-cache，不硬编码）----
    warm_run = (read_json(CACHE / "_b12-run1-warm.json") or {}).get("summary") or {}
    bench = (read_json(CACHE / "_b12-http-bench-after-tuning.json") or {}).get("summary") or {}
    cold_run = (read_json(CACHE / "_b12-run0-cold.json") or {}).get("summary") or {}
    c["baselines"] = {"b12_run1_warm": warm_run, "b12_http_bench": bench,
                      "b12_run0_cold": cold_run}

    print("\n  ── 冷启动/首触样本（单独列，不进热态统计）──", flush=True)
    print(f"    首触请求 {cold['query_id']}：HTTP {cold['status']} "
          f"client={cold['client_ms']}ms encode={cold['encode_ms']}ms "
          f"retrieve={cold['retrieve_ms']}ms e2e={cold['e2e_ms']}ms", flush=True)
    if cold_run:
        cr = cold_run.get("retrieve_ms") or {}
        print(f"    B.12 冷启动参考（_b12-run0-cold.json）：retrieve P50="
              f"{cr.get('p50')}ms P95={cr.get('p95')}ms max={cr.get('max')}ms",
              flush=True)
    print("    ⚠ 口径：首触样本 ≠ 重启后的严格冷启动（API 未重启，模型/连接池已热）；"
          "严格冷启动需重启 API，本脚本不做环境动作。", flush=True)

    print("\n  ── 热态对照（P50, ms）──", flush=True)
    header = f"    {'指标':<14}{'本次(热态)':>12}{'B.12 warm':>12}{'B.12 bench':>12}{'Δ vs warm':>12}"
    print(header, flush=True)
    for k in ("encode_ms", "retrieve_ms", "e2e_ms", "client_ms"):
        a = now[k]["p50"]
        bw = (warm_run.get(k) or {}).get("p50")
        bb = (bench.get(k) or {}).get("p50")
        delta = f"{(a - bw) / bw * 100:+.1f}%" if isinstance(bw, (int, float)) else "—"
        bw_s = f"{bw:.2f}" if isinstance(bw, (int, float)) else "—"
        bb_s = f"{bb:.2f}" if isinstance(bb, (int, float)) else "—"
        print(f"    {k:<14}{a:>12.2f}{bw_s:>12}{bb_s:>12}{delta:>12}", flush=True)
    print("    ⚠ 口径：本次为「每条 3 次取后 2 次」热态口径；B.12 HTTP 压测是"
          "「首次触碰」口径，两者不可互相替代。", flush=True)
    return c


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(description="M4 书籍 HNSW 检索三层验收")
    ap.add_argument("--base", default="http://127.0.0.1:8000")
    ap.add_argument("--n", type=int, default=0,
                    help="只跑前 N 条 counted query（0=全部，默认全部 100 条）")
    args = ap.parse_args()

    report = Report()
    print("=" * 72, flush=True)
    print("M4 书籍 HNSW 检索 · 三层验收", flush=True)
    print(f"base={args.base}  top_k={TOP_K}  repeats={REPEATS}（取后 2 次）", flush=True)
    print("=" * 72, flush=True)

    # ---- Layer A：环境前置。任一 FAIL 即停止正式验收。----
    env = layer_a(args.base, report)
    if report.counts()["FAIL"] > 0:
        print("\n❌ Layer A 环境前置存在失败项，停止正式验收（不修改任何数据/参数）。",
              flush=True)
        _write_artifact(args, report, env, None, None)
        _summary(report)
        return 1

    counted = [q for q in (json_or_none(QUERY_SET.read_text(encoding="utf-8"))
                           or {}).get("queries", []) if q.get("counted")]
    partial = bool(args.n) and args.n < len(counted)
    if args.n:
        counted = counted[: args.n]

    # ---- 冷启动/首触探针必须早于任何 /api/discover 流量 ----
    # （Layer B/C 的正常检索会消耗「首个请求」，所以探针排在 B 前面执行，
    #   展示时归入 Layer C 的冷启动段。）
    cold = cold_probe(args.base, counted[0])

    # ---- Layer B：HTTP 契约与检索正确性 ----
    chaptered = (env.get("db_baseline") or {}).get("chaptered_chunks")
    b = layer_b(args.base, counted, report, chaptered, partial=partial)

    # ---- Layer C：延迟画像 ----
    c = layer_c(args.base, counted, report, cold)

    _write_artifact(args, report, env, b, c)
    _summary(report)
    return 0 if report.counts()["FAIL"] == 0 else 1


def _write_artifact(args: argparse.Namespace, report: Report,
                    env: dict[str, Any], b: dict[str, Any] | None,
                    c: dict[str, Any] | None) -> None:
    out = {
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "stage": "m4-acceptance",
        "base": args.base,
        "config": {"top_k": TOP_K, "repeats": REPEATS,
                   "hot_state_rule": "每条 3 次取后 2 次",
                   "target_retrieve_ms": TARGET_RETRIEVE_MS,
                   "target_source": "b12-verify-after-tuning.py:50"},
        "environment": env,
        "layer_b": b,
        "layer_c": c,
        "checks": report.rows,
        "counts": report.counts(),
    }
    dst = CACHE / "_m4-acceptance.json"
    dst.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n产物已写入：{dst}", flush=True)


def _summary(report: Report) -> None:
    c = report.counts()
    print("\n" + "=" * 72, flush=True)
    print(f"总结：PASS {c['PASS']}  WARN {c['WARN']}  FAIL {c['FAIL']}  INFO {c['INFO']}",
          flush=True)
    if c["FAIL"]:
        print("总体判定：❌ 未通过（见上方 FAIL 项）", flush=True)
    elif c["WARN"]:
        print("总体判定：⚠️ 通过（有 WARN 项，见上方）", flush=True)
    else:
        print("总体判定：✅ 全部通过", flush=True)
    print("=" * 72, flush=True)


if __name__ == "__main__":
    sys.exit(main())
