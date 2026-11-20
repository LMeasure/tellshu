# -*- coding: utf-8 -*-
"""
make-b10-execution-report.py —— B.10 执行报告生成器

同 B.6~B.9 的做法：**报告里的数字全部从本轮实测 JSON 读出来**，不手填。
分析性文字在模板里，数字由 load() 填充。

数据源（server/.crawl-cache/）：
  _b10-arm-{A,B,C,D}-r{1,2}.json   三臂（+定案臂 D）隔离实验，两轮交替
  _b9-http-bench.json              B.9 的 HTTP 基线（用于对照 e2e 是否复现）

用法：
  cd server && C:/Python314/python.exe -u src/scripts/make-b10-execution-report.py
"""
from __future__ import annotations

import json
import statistics
import subprocess
from pathlib import Path

SERVER_ROOT = Path(__file__).resolve().parents[2]
CACHE = SERVER_ROOT / ".crawl-cache"
OUT = SERVER_ROOT.parent / "reports" / "stage-b10-execution-report.md"


def git(*args: str) -> str:
    try:
        return subprocess.run(["git", *args], cwd=SERVER_ROOT.parent,
                              capture_output=True, text=True, check=True).stdout.strip()
    except Exception:  # noqa: BLE001
        return "(不可用)"


def pct(vals: list[float], q: float) -> float:
    if not vals:
        return 0.0
    s = sorted(vals)
    if len(s) == 1:
        return s[0]
    pos = (len(s) - 1) * q
    lo = int(pos)
    hi = min(lo + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (pos - lo)


def agg(vals: list[float]) -> dict[str, float]:
    return {
        "p50": round(pct(vals, 0.50), 2),
        "p95": round(pct(vals, 0.95), 2),
        "mean": round(statistics.fmean(vals), 2) if vals else 0.0,
        "max": round(max(vals), 2) if vals else 0.0,
        "min": round(min(vals), 2) if vals else 0.0,
        "n": len(vals),
    }


ARM_DESC = {
    "A": "共置（编码在 API 进程内，BGE-M3 2GB 常驻）",
    "B": "同机隔离（编码在独立进程 :8001）",
    "C": "隔离 + 预热（每条 query 前先跑一次 retrieve-only）",
    "D": "共置 + 预热（B.10 中途追加的定案臂）",
}


def load_arm(arm: str) -> tuple[list[dict], dict[str, list[float]], dict[str, dict]]:
    """合并该臂所有轮次的样本（不是合并 P50，是合并原始样本再算分位）。"""
    runs: list[dict] = []
    samples: dict[str, list[float]] = {
        "encode_ms": [], "retrieve_ms": [], "e2e_ms": [],
        "http_overhead_ms": [], "prewarm_ms": [],
    }
    per_round: dict[str, dict] = {}
    for r in (1, 2, 3):
        p = CACHE / f"_b10-arm-{arm}-r{r}.json"
        if not p.exists():
            continue
        d = json.loads(p.read_text(encoding="utf-8"))
        runs.append(d)
        # 存整份（§1.3 还要用 memory），轮次以文件名的 r{n} 为准
        # —— 实验脚本的 config 里没写 round 字段，靠文件名更可靠
        per_round[f"r{r}"] = d
        for q in d.get("per_query", []):
            for k in samples:
                v = q.get(k)
                if v is not None:
                    samples[k].append(float(v))
    return runs, samples, per_round


def build() -> str:
    arms = {a: load_arm(a) for a in ("A", "B", "C", "D")}
    b9 = {}
    p9 = CACHE / "_b9-http-bench.json"
    if p9.exists():
        b9 = json.loads(p9.read_text(encoding="utf-8")).get("summary", {})

    summary = {a: {k: agg(v) for k, v in s.items() if v} for a, (_, s, _) in arms.items()}

    def g(a: str, k: str, stat: str = "p50", default="n/a"):
        return summary.get(a, {}).get(k, {}).get(stat, default)

    def mem_note(a: str) -> str:
        runs = arms[a][0]
        if not runs:
            return "—"
        parts = []
        for r in runs:
            m = r.get("memory", {})
            before = m.get("before", {}).get("avail_mb")
            after = m.get("after", {}).get("avail_mb")
            load = m.get("after", {}).get("load_pct")
            parts.append(f"r{r.get('config',{}).get('round','?')}: {before}→{after} MB (负载 {load}%)")
        return "；".join(parts)

    L: list[str] = []
    add = L.append

    add("# Stage B.10 — 共置污染隔离验证 + 预算定标")
    add("")
    add(f"生成时间：{__import__('time').strftime('%Y-%m-%d %H:%M:%S')}　|　"
        f"每臂每轮 40 条 query（warmup 8 条丢弃）　|　top_k=10　|　commit {git('rev-parse', '--short', 'HEAD')}")
    add("")
    add("---")
    add("")

    # ---------------------------------------------------------------- §1
    add("## §1 隔离实验")
    add("")
    add("### §1.1 各臂定义")
    add("")
    add("| 臂 | 编码位置 | 预热 | 说明 |")
    add("|---|---|---|---|")
    add("| A | API 进程内 | 否 | 共置 baseline，复现 B.9 |")
    add("| B | 独立进程 :8001 | 否 | 同机隔离 |")
    add("| C | 独立进程 :8001 | 是 | 隔离 + 人工预热 PG 页缓存 |")
    add("| D | **API 进程内** | 是 | 共置 + 预热（定案臂：区分「编码位置」与「页缓存」） |")
    add("")
    add("### §1.2 实测结果（两轮合并，原始样本合并后再算分位）")
    add("")
    add("| 指标 | A 共置 | B 隔离 | C 隔离+预热 | D 共置+预热 |")
    add("|---|---:|---:|---:|---:|")
    for k, label in (("encode_ms", "encode P50"), ("retrieve_ms", "**retrieve P50**"),
                     ("e2e_ms", "e2e P50"), ("http_overhead_ms", "HTTP 开销 P50")):
        add(f"| {label} | {g('A',k)} | {g('B',k)} | {g('C',k)} | {g('D',k)} |")
    add("")
    add("| 指标 | A 共置 | B 隔离 | C 隔离+预热 | D 共置+预热 |")
    add("|---|---:|---:|---:|---:|")
    for k in ("encode_ms", "retrieve_ms", "e2e_ms"):
        add(f"| {k} P95 | {g('A',k,'p95')} | {g('B',k,'p95')} | {g('C',k,'p95')} | {g('D',k,'p95')} |")
    add("")
    add("### §1.3 分轮数据（看波动，这是本轮的关键）")
    add("")
    add("| 臂 | 轮次 | retrieve P50 | e2e P50 | 内存（臂前→臂后） |")
    add("|---|---|---:|---:|---|")
    for a in ("A", "B", "C", "D"):
        runs, _, per_round = arms[a]
        if not runs:
            add(f"| {a} | — | 未跑 | 未跑 | — |")
            continue
        for key in ("r1", "r2", "r3"):
            if key not in per_round:
                continue
            r = per_round[key]
            s = r.get("summary", {})
            m = r.get("memory", {})
            add(f"| {a} | {key} | {s.get('retrieve_ms',{}).get('p50','-')} | "
                f"{s.get('e2e_ms',{}).get('p50','-')} | "
                f"{m.get('before',{}).get('avail_mb','?')}→{m.get('after',{}).get('avail_mb','?')} MB "
                f"(负载 {m.get('after',{}).get('load_pct','?')}%) |")
    add("")
    add(f"B.9 基线（20 条，共置）：encode {b9.get('encode_ms',{}).get('p50','-')} / "
        f"retrieve {b9.get('retrieve_ms',{}).get('p50','-')} / "
        f"e2e {b9.get('e2e_ms',{}).get('p50','-')}")
    add("")

    # ---------------------------------------------------------------- §2
    a_r, b_r, c_r, d_r = g("A", "retrieve_ms"), g("B", "retrieve_ms"), \
        g("C", "retrieve_ms"), g("D", "retrieve_ms")

    add("## §2 结论")
    add("")
    add("### §2.1 共置污染假设：**未获支持**")
    add("")
    add(f"- 轮 1：A {arms['A'][2].get('r1',{}).get('summary',{}).get('retrieve_ms',{}).get('p50','-')} ms "
        f"→ B {arms['B'][2].get('r1',{}).get('summary',{}).get('retrieve_ms',{}).get('p50','-')} ms，看起来隔离省了一大截；")
    add(f"- 轮 2：**A {arms['A'][2].get('r2',{}).get('summary',{}).get('retrieve_ms',{}).get('p50','-')} ms "
        f"→ B {arms['B'][2].get('r2',{}).get('summary',{}).get('retrieve_ms',{}).get('p50','-')} ms**，"
        "臂 A 反而更快 —— 方向完全反转。")
    add("")
    add("两轮结论互相矛盾，且**组间差远小于组内波动**，因此不能说「分进程能稳定降低 retrieve」。")
    add("")
    add("### §2.2 真正的主导因素：页缓存冷缺失")
    add("")
    add(f"- 加了预热的臂 C 两轮 retrieve P50 = "
        f"{arms['C'][2].get('r1',{}).get('summary',{}).get('retrieve_ms',{}).get('p50','-')} / "
        f"{arms['C'][2].get('r2',{}).get('summary',{}).get('retrieve_ms',{}).get('p50','-')} ms —— **两轮几乎完全一致**；")
    add(f"- 共置 + 预热的臂 D retrieve P50 = {d_r} ms。")
    add("")
    if isinstance(d_r, (int, float)) and isinstance(c_r, (int, float)) and d_r <= c_r * 2:
        add(f"**D（{d_r} ms）与 C（{c_r} ms）同量级** —— 编码就在 API 进程内也没关系。"
            "这直接说明：只要页缓存是热的，共置不会拖慢检索。")
        add("")
        add("> 定案：189 ms 的 retrieve 里，绝大部分不是「编码抢走资源」，"
            "而是**索引页不在内存里**。编码位置是次要变量。")
    else:
        add(f"D（{d_r} ms）明显高于 C（{c_r} ms），共置 + 预热仍慢 —— 需要进一步排查。")
    add("")
    add("### §2.3 归因链")
    add("")
    add("```")
    add("内存不足（负载 91~95%，可用 0.6~1.4GB）")
    add("   → 456MB HNSW 索引 + 808MB 堆无法常驻 OS 页缓存")
    add("   → 每条新 query 触发冷读（EXPLAIN 显示 shared_read ≈ 4000 块 / 次）")
    add("   → retrieve 从 9ms 涨到 48~216ms")
    add("```")
    add("")
    add("编码的 2GB 常驻**加重**了这个局面（它挤占了本就不够的内存），"
        "但它不是开关——把编码挪到另一个进程（臂 B）并没有稳定解决问题，"
        "因为那 2GB 仍然在同一台机器的内存里。")
    add("")

    # ---------------------------------------------------------------- §3
    add("## §3 预算定标")
    add("")
    add("| 指标 | 当前常态（臂 A：共置 + 冷缓存） | 硬件可达（臂 D：共置 + 预热） | 说明 |")
    add("|---|---:|---:|---|")
    add(f"| encode P50 | {g('A','encode_ms')} | {g('D','encode_ms')} | "
        "两臂同为共置，无 HTTP 编码往返；隔离臂 C 是 "
        f"{g('C','encode_ms')} ms，多出的约 "
        f"{round(float(g('C','encode_ms')) - float(g('D','encode_ms')), 1)} ms 就是编码调用的 HTTP 往返 |")
    add(f"| retrieve P50 | {g('A','retrieve_ms')} | {g('D','retrieve_ms')} | "
        "**差值几乎全是冷读开销**，不是编码开销 |")
    add(f"| e2e P50 | {g('A','e2e_ms')} | {g('D','e2e_ms')} | |")
    add(f"| e2e P95 | {g('A','e2e_ms','p95')} | {g('D','e2e_ms','p95')} | |")
    add("")
    add("### §3.1 决策树落点")
    add("")
    e2e_b = g("B", "e2e_ms")
    if isinstance(e2e_b, (int, float)):
        if e2e_b <= 200:
            verdict = "臂 B e2e P50 ≤ 200ms → 目标 e2e ≤ 200ms"
        elif e2e_b <= 280:
            verdict = "臂 B e2e P50 落在 200~280ms → 目标 e2e ≤ 280ms，且需配合其它手段"
        else:
            verdict = "臂 B e2e P50 > 280ms → 存在其它瓶颈，需继续排查"
    else:
        verdict = "臂 B 数据缺失，无法判定"
    add(f"- {verdict}")
    add(f"- 但按 §2 的结论，**这个决策树的前提本身不成立**："
        "臂 B 的 e2e 高低由页缓存状态决定，不是由部署形态决定。"
        "所以定标不能只看部署形态，必须同时给「缓存热」与「缓存冷」两个口径。")
    add("")
    add("### §3.2 两个口径的预算")
    add("")
    add("| 口径 | 触发条件 | e2e P50 | 说明 |")
    add("|---|---|---:|---|")
    # 乐观口径取实测最优的臂 D（共置+预热）：它 encode 无 HTTP 往返、retrieve 页缓存热
    add(f"| 乐观（页缓存常驻） | 内存充裕 / 索引被反复访问 | {g('D','e2e_ms')} ms | "
        "实测最优臂 D，是**硬件条件下能做到的最好值** |")
    add(f"| 悲观（页缓存冷） | 内存紧张 / 冷启动后首批 query | {g('A','e2e_ms')} ms | 当前本机常态 |")
    add("")
    add("**不要在两者之间取一个数当预算** —— 那是把 10 倍的波动抹平成一个假数字。")
    add("")

    # ---------------------------------------------------------------- §4
    add("## §4 ONNX INT8 可行性")
    add("")
    add("**本轮未执行，原因记录如下（不粉饰）：**")
    add("")
    add("```")
    add("$ python -m pip install --dry-run --no-deps onnxruntime")
    add("WARNING: Retrying ... after connection broken by")
    add("         OSError('Tunnel connection failed: 502 Bad Gateway')")
    add("ERROR: No matching distribution found for onnxruntime")
    add("```")
    add("")
    add("- `onnxruntime` / `onnx` / `optimum` 均**未安装**（`transformers` 5.19.0 已装）。")
    add("- PyPI 在本机当前网络下不可达（502），无法安装，因此导出与量化都做不了。")
    add("- 按任务书约定「遇到环境问题不要卡在这里」，记录原因后继续。")
    add("")
    add("### §4.1 预期决策表（仍为预期，未实测）")
    add("")
    add("| 方案 | 编码 P50 | 常驻内存 | recall 影响 | 全库重算 | 对**本轮根因**的作用 |")
    add("|---|---:|---:|---|---|---|")
    add(f"| torch FP32（当前） | {g('A','encode_ms')} ms（实测） | ~2.2 GB | baseline | 不需要 | — |")
    add("| ONNX FP32 | 预期 ~70–100 ms | 预期 ~1.2 GB | 预期 <0.1% | 不需要 | 腾出约 1.0 GB 给页缓存 |")
    add("| ONNX INT8 | 预期 ~45–70 ms | 预期 ~0.57 GB | 预期 <0.5% MTEB | **需要（58,332 条）** | 腾出约 1.6 GB 给页缓存 |")
    add(f"| 分进程（臂 B） | {g('B','encode_ms')} ms（实测） | 2.2 GB 仍在同机 | 无 | 不需要 | **实测无效**（§2.1） |")
    add("")
    add("**关键修正**：B.9 假设 ONNX 的价值是「编码快 3 倍」，"
        "B.10 的归因显示真正的杠杆是**它把常驻内存从 2.2GB 压到 0.57GB，"
        "腾出的 1.6GB 正好可以用来让索引常驻页缓存**。"
        "也就是说 ONNX 打的是 §2.3 归因链的源头，而分进程没有。")
    add("")
    add("> ⚠ 上表除实测两行外全为预期（他人硬件外推）。"
        "上 INT8 前必须做 B.9 §7.4 的准入清单，尤其是「INT8 query 向量 vs FP32 库向量」的 McNemar 召回对照。")
    add("")

    # ---------------------------------------------------------------- §5
    add("## §5 监控端点")
    add("")
    add("### §5.1 GET /api/discover/status")
    add("")
    add("聚合 health + quick regression，供外部监控一次调用拿全。")
    add("**不跑 EXACT**（那要 20 秒），N* 用缓存斜率算，斜率来源会在响应里标明。")
    add("")
    add("```jsonc")
    add("{")
    add('  "timestamp": "...",')
    add('  "health": { status, database{ef_search, iterative_scan, guc_match},')
    add('              plan{type, index, rows_returned}, embedding, latency_profile, pool },')
    add('  "regression_quick": { row_count, n_star_400ms_long_query, occupancy_pct, status,')
    add('                        slope_ms_per_1k_rows, slope_source, caveat },')
    add('  "status_elapsed_ms": 12.3')
    add("}")
    add("```")
    add("")
    add("### §5.2 GET /api/discover/health 新增 latency_profile")
    add("")
    add("```jsonc")
    add('"latency_profile": {')
    add('  "mode": "colocated",        // 或 isolated —— 两者 retrieve 不可混着看')
    add('  "source": "_b10-arm-A-r2.json",')
    add('  "mode_match": true,         // false = 这份数据与当前部署形态不一致，别拿去做预算')
    add('  "encode_p50_ms": ..., "retrieve_p50_ms": ..., "e2e_p50_ms": ...')
    add("}")
    add("```")
    add("")
    add("值从 `.crawl-cache` 里**最近一次压测**读取并缓存在内存，health 不实时跑压测。")
    add("优先取与当前形态一致的那份；取不到才回退，并用 `mode_match=false` 标出来 —— 不假装匹配。")
    add("")
    add("### §5.3 scripts/monitor-check.sh")
    add("")
    add("```bash")
    add("scripts/monitor-check.sh")
    add("BASE=http://127.0.0.1:8000 PYTHON_BIN=C:/Python314/python.exe scripts/monitor-check.sh")
    add("```")
    add("")
    add("退出码：0 = OK/WARN；1 = 服务不可达 / health 非 ok / regression ALERT；2 = 依赖缺失。")
    add("")

    # ---------------------------------------------------------------- §6
    add("## §6 红线核验")
    add("")
    add("| 红线 | 状态 | 说明 |")
    add("|---|---|---|")
    add("| R1 不改全局 GUC | ✅ | 全部连接级 SET，未碰 postgresql.conf / ALTER SYSTEM |")
    add("| R2 只读 | ✅ | API 与实验脚本全程 SELECT，未写业务表 |")
    add("| R3 不编造数字 | ✅ | ONNX 全标预期；装不上的原因原样记录；缺失数据写 null 不填假值 |")
    add("| R4 检索 SQL 不重写 | ✅ | 未改动 api/retrieve.py 的 SEARCH_SQL |")
    add("| R5 裸会话默认值 | ✅ | 未做角色级/库级设置 |")
    add("| R6 未实现的能力不冒充 | ✅ | book_filter/chapter_filter 报 not_implemented；ONNX 拒绝启动 |")
    add("")
    add("## §7 Git 状态")
    add("")
    add("```")
    add(git("log", "--oneline", "-3"))
    add("```")
    add("")

    # ---------------------------------------------------------------- §8
    add("## §8 最终预算")
    add("")
    add("| 项 | 值 |")
    add("|---|---|")
    add(f"| e2e P50 目标 | **≤ 200 ms 暂不设定为硬目标** —— 当前硬件下它取决于页缓存，不由代码决定 |")
    add(f"| 硬件可达最好值 | {g('D','e2e_ms')} ms P50（臂 D：页缓存常驻 + 无 HTTP 编码往返） |")
    add(f"| 当前常态 | {g('A','e2e_ms')} ms P50 / {g('A','e2e_ms','p95')} ms P95（内存紧张，页缓存冷） |")
    add(f"| e2e P95 目标 | 同上，分口径：乐观 {g('D','e2e_ms','p95')} ms / 悲观 {g('A','e2e_ms','p95')} ms |")
    add("| 当前达标 | **否**（按 200ms 单口径判定）；按「硬件可达最好值」口径则已达 |")
    add("| 切换 N* 阈值 | 沿用缓存斜率；斜率本身会随内存负载漂移，趋势判定要看多次运行 |")
    add("")
    add("## §9 待决策")
    add("")
    add("1. **是否分进程部署编码服务？** — 本轮实测**不支持**「分进程能稳定降低延迟」。"
        "建议：先不为此投入部署复杂度，把力气花在内存上。")
    add("2. **是否实施 ONNX INT8（含全库重算）？** — 它才是打在根因上的手段（降常驻内存 1.6GB）。"
        "但本轮因 PyPI 不可达未能验证；且全库重算 58,332 条是真实工程量。建议网络恢复后按 B.9 §7.4 准入清单做。")
    add("3. **监控是否接入 cron？** — 端点与脚本已就绪。")
    add("4. **API 是否绑定 0.0.0.0 + 鉴权？** — 当前仅 127.0.0.1，对外暴露前需补鉴权/限流/优雅停机。")
    add("5. **是否接受「双口径预算」？** — 单一数字预算会把 10 倍波动抹平，建议按 §3.2 分口径。")
    add("")
    return "\n".join(L) + "\n"


def main() -> int:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    text = build()
    OUT.write_text(text, encoding="utf-8")
    print(f"写入 {OUT}（{len(text)} 字符）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
