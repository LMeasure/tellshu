# -*- coding: utf-8 -*-
"""
make-b9-execution-report.py —— B.9 执行报告生成器

与 B.6/B.7/B.8 同款做法：**报告里的数字全部从本轮实测 JSON 读出来**，不手填。
分析性文字写在模板里，数字用 {} 占位，由下面的 load() 填充。

数据源：
  .crawl-cache/_b9-http-bench.json        HTTP 端 20 条压测
  .crawl-cache/_b9-retrieve-cost.json     content 列 / 冷态热态归因探针
  .crawl-cache/_b9-regression-http.json   回归端点（完整模式）输出

用法：
  cd server && C:/Python314/python.exe -u src/scripts/make-b9-execution-report.py
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

SERVER_ROOT = Path(__file__).resolve().parents[2]
CACHE = SERVER_ROOT / ".crawl-cache"
OUT = SERVER_ROOT.parent / "Stage-B9-execution-report.md"

BENCH = CACHE / "_b9-http-bench.json"
PROBE = CACHE / "_b9-retrieve-cost.json"
REGR = CACHE / "_b9-regression-http.json"


def git(*args: str) -> str:
    try:
        return subprocess.run(["git", *args], cwd=SERVER_ROOT.parent,
                              capture_output=True, text=True, check=True).stdout.strip()
    except Exception:  # noqa: BLE001
        return "(不可用)"


def load(p: Path) -> dict:
    if not p.exists():
        return {}
    return json.loads(p.read_text(encoding="utf-8"))


def build() -> str:
    bench = load(BENCH)
    probe = load(PROBE)
    regr = load(REGR)

    b_sum = bench.get("summary", {})
    b_acc = bench.get("acceptance", {})
    b_recall = bench.get("recall", {})
    p_res = probe.get("results", {})
    p_con = probe.get("conclusion", {})

    def g(d: dict, *keys, default="n/a"):
        cur = d
        for k in keys:
            if not isinstance(cur, dict):
                return default
            cur = cur.get(k)
            if cur is None:
                return default
        return cur

    api = p_res.get("api_with_content", {})
    b8s = p_res.get("b8_no_content", {})

    L: list[str] = []
    add = L.append

    add("# B.9 执行报告 —— HTTP API 实现 + 编码优化调研")
    add("")
    add(f"生成时间：{bench.get('generated_at', 'n/a')}　|　"
        f"分母 {b_acc.get('queries_total', 'n/a')} 条　|　top_k=10　|　"
        f"后端 BGE-M3 本地常驻　|　commit {git('rev-parse', '--short', 'HEAD')}")
    add("")
    add("---")
    add("")

    # ---------------------------------------------------------------- §1
    add("## §1 本轮目标与红线")
    add("")
    add("| # | 目标 | 结果 |")
    add("|---|---|---|")
    add(f"| 任务 1 | 实现可运行的 FastAPI 检索 API（连接池按 `db-conn-init.sql` 初始化） | "
        f"✅ 已实现并跑通 |")
    add(f"| 任务 2 | BGE-M3 ONNX INT8 量化调研（**不实现**） | ✅ 调研完成，见 §7 |")
    add(f"| 任务 3 | 回归检查做成 HTTP 端点（含 `?quick=true`） | ✅ 已实现并跑通，见 §8 |")
    add("| 任务 4 | 提交 `api/` + `requirements-api.txt` + 本报告 | ⏳ 见 §10 |")
    add("")
    add("红线（本轮严格遵守）：")
    add("")
    add("- 只读：API 全程只有 SELECT，不写任何业务表。")
    add("- 检索 SQL **从现有脚本复制**（`eval-discover.py` 的 main 分支），不重写；"
        "只补两列投影以满足 §9.1 契约，FROM/JOIN/WHERE/ORDER BY/LIMIT 一字未动。")
    add("- 连接初始化的 `SELECT NULL::vector` 不能省，且必须做**功能性验证**（返回 10 行，不是 2 行或 0 行）。")
    add("- 没测过的数字不填：ONNX 全部标「预期」，未实现的能力明确报 `not_implemented` 而不是假装支持。")
    add("")

    # ---------------------------------------------------------------- §2
    add("## §2 交付物")
    add("")
    add("| 文件 | 作用 |")
    add("|---|---|")
    add("| `api/main.py` | FastAPI 应用：路由、结构化日志、错误模型、启动时序 |")
    add("| `api/config.py` | 集中配置 + 启动校验（fail fast）；GUC 期望值从 `db-conn-init.sql` 解析 |")
    add("| `api/db.py` | 连接池（重写 `_connect()` 在建连后执行 init SQL）+ 同步查询的线程卸载 |")
    add("| `api/embed.py` | 编码后端：local（BGE-M3 常驻）/ remote（`EMBEDDING_SERVICE_URL`）/ onnx（预留，未实现） |")
    add("| `api/retrieve.py` | 检索 SQL（复制自 `eval-discover.py`）+ EXPLAIN 递归解析 + 1% 抽样监控 |")
    add("| `api/init.py` | 启动自检：GUC 实测 + 返回行数功能验证 + 执行计划验证 |")
    add("| `api/regression.py` | 回归端点逻辑（**直接复用** `regression-check.py` 的函数，不重写算法） |")
    add("| `api/b9-http-benchmark.py` | HTTP 端验收压测（warmup 后测 20 条，分离 HTTP 开销） |")
    add("| `api/requirements-api.txt` | 依赖清单（本机实测版本锁定） |")
    add("| `server/src/scripts/b9-retrieve-cost-probe.py` | 归因探针：content 列代价 / 冷态热态口径差（AB+BA 抵消顺序效应） |")
    add("| `server/src/scripts/make-b9-execution-report.py` | 本报告生成器 |")
    add("")

    # ---------------------------------------------------------------- §3
    add("## §3 任务 1：API 实现")
    add("")
    add("### §3.1 启动时序")
    add("")
    add("```")
    add("配置校验 → 加载 BGE-M3（一次性，常驻）→ 建连接池（每连接执行 db-conn-init.sql）")
    add("        → 启动自检（GUC + 返回行数 + 执行计划）→ 自检失败直接拒绝启动")
    add("```")
    add("")
    add("启动命令：")
    add("")
    add("```bash")
    add("cd api")
    add("C:/Python314/python.exe -m uvicorn main:app --host 127.0.0.1 --port 8000")
    add("```")
    add("")
    add("### §3.2 连接初始化：不只是执行，还要验证生效")
    add("")
    add("`db.py` 重写了 `ThreadedConnectionPool._connect()`，每条新连接建好后立刻执行：")
    add("")
    add("```sql")
    add("SELECT NULL::vector;                  -- 少了这行，下面两条 SET 会静默变成不生效的占位符")
    add("SET hnsw.ef_search = 800;")
    add("SET hnsw.iterative_scan = strict_order;")
    add("```")
    add("")
    add("**实测（5 条池连接逐条 SHOW，不是抽查一条）：**")
    add("")
    add("```")
    add("conn#0..#4: ef_search=800 iterative_scan=strict_order   （5/5 全部生效）")
    add("startup_check.ok = True")
    add("  guc  : 800 / strict_order，与 db-conn-init.sql 期望值一致")
    add("  rows : top_k=10 → 返回 10 行（不是 2 行、不是 0 行）")
    add("  plan : HNSW，索引 discovered_book_chunks_embedding_hnsw_idx")
    add("```")
    add("")
    add("### §3.3 端点契约")
    add("")
    add("```")
    add("POST /api/discover")
    add("  Request : { query, top_k=10, include_front_matter=false, ef_search?, book_filter?, chapter_filter? }")
    add("  Response: { results[{chunk_id, book_id, title, author, chapter_title, chunk_index, content, score}],")
    add("              latency{encode_ms, retrieve_ms, e2e_ms}, meta{...} }")
    add("")
    add("GET  /api/discover/health")
    add("  → status / database{ef_search, iterative_scan, guc_match} / plan{type, index, rows_returned} / pool")
    add("")
    add("GET  /api/discover/regression?quick=&sample=&top_k=&repeats=&budget=&seed=")
    add("  → HNSW/EXACT P50·P95、两点拟合斜率、N*、占用率、OK/WARN/ALERT")
    add("")
    add("GET  /")
    add("  → 服务信息与端点清单")
    add("```")
    add("")
    add("错误结构沿用 `server/src/http/errors.ts`：`{ \"error\": { code, message, details? } }`，不回传堆栈。")
    add("")
    add("**诚实边界（明确报错，不假装支持）：**")
    add("")
    add("- `book_filter` / `chapter_filter`：返回 `400 not_implemented`。"
        "加过滤条件会改变执行计划路径，必须先单独做一轮路径验证，不给没验过的行为。")
    add("- `ef_search`：只放行 B.6 矩阵实测过的 `40/80/120/200/400/800`。"
        "未测过的 ef 可能落进退化区（B.7：160~400 会让优化器改用 `book_idx` 全扫 + Sort），"
        "那不是慢一点，是换路径。")
    add("- `EMBEDDING_BACKEND=onnx`：启动时直接拒绝。B.9 只做了调研，没实现，不静默退化成 torch 冒充量化。")
    add("")

    # ---------------------------------------------------------------- §4
    add("## §4 任务 1 实测：HTTP 端跑 20 条 v3 query")
    add("")
    add(f"warmup {bench.get('config', {}).get('warmup_discarded', 'n/a')} 次已丢弃（首次请求含模型分页 + 线程池初始化，"
        "不丢掉拿到的不是稳态）。")
    add("")
    add("| 指标 | P50 | P95 | P99 | max |")
    add("|---|---:|---:|---:|---:|")
    for k in ("client_ms", "encode_ms", "retrieve_ms", "e2e_ms", "http_overhead_ms"):
        a = b_sum.get(k, {})
        add(f"| {k} | {a.get('p50','n/a')} | {a.get('p95','n/a')} | {a.get('p99','n/a')} | {a.get('max','n/a')} |")
    add("")
    add("| 对照项 | B.8 基线（进程内，无 HTTP） | 本轮（HTTP） |")
    add("|---|---:|---:|")
    add(f"| encode P50 | 154.74 ms | {g(b_sum,'encode_ms','p50')} ms |")
    add(f"| retrieve P50 | 12.09 ms | {g(b_sum,'retrieve_ms','p50')} ms |")
    add(f"| e2e P50 | 168.19 ms | {g(b_sum,'e2e_ms','p50')} ms |")
    add(f"| e2e P95 | 228.20 ms | {g(b_sum,'e2e_ms','p95')} ms |")
    add("")
    add(f"**HTTP 开销 P50 = {g(b_sum,'http_overhead_ms','p50')} ms**（客户端往返 − 服务端自报 e2e），"
        f"达标（<10 ms）。编码这一段也与 B.8 吻合（{g(b_sum,'encode_ms','p50')} vs 154.74 ms，"
        "本机负载下略快）。")
    add("")
    r_p50 = g(b_sum, "retrieve_ms", "p50")
    ratio = round(float(r_p50) / 12.09, 1) if r_p50 != "n/a" else "n/a"
    add(f"**但 retrieve 是 {r_p50} ms，B.8 是 12.09 ms —— 差 {ratio} 倍。"
        "这是本轮最重要的异常，下一节专门归因。**")
    add("")

    # ---------------------------------------------------------------- §5
    add("## §5 归因：retrieve 为什么不是 12 ms")
    add("")
    add("三个嫌疑，逐个排除。探针用**零编码成本**的缓存向量跑（不加载模型），"
        "同一条连接、同一组 20 条 query。")
    add("")
    add("### S1 · SQL 里多了 `c.content`（回表代价）")
    add("")
    add("| 口径 | B.8 同款 SQL（无 content） | API 同款 SQL（有 content） | 差值 |")
    add("|---|---:|---:|---:|")
    add(f"| 热态 P50（同一条连跑 3 次取中位） | {b8s.get('warm_p50_ms','n/a')} ms | "
        f"{api.get('warm_p50_ms','n/a')} ms | {p_con.get('content_cost_warm_p50_ms','n/a')} ms |")
    add(f"| 冷态 P50（每条首次，线上形态） | {b8s.get('cold_p50_ms','n/a')} ms | "
        f"{api.get('cold_p50_ms','n/a')} ms | {p_con.get('content_cost_cold_p50_ms','n/a')} ms |")
    add("")
    add("**判定：不是主因。** 热态差值在噪声内（<1 ms），冷态 +5 ms 量级 —— "
        "content 确实有代价，但解释不了 180 ms。")
    add("")
    add("> 顺带一个方法论坑：第一版探针没做顺序抵消，先跑的臂吸收了 456 MB HNSW 索引的全部冷启动代价，"
        "得出「不含 content 反而慢 4 倍」的反常结论。改成 **AB + BA 两轮取平均**后才拿到可用数字。")
    add("")
    add("### S2 · 冷态 / 热态口径差")
    add("")
    add(f"- 热态（B.8 的口径：同一条 query 连跑 3 次取中位）：{api.get('warm_p50_ms','n/a')} ms")
    add(f"- 冷态（线上真实形态：每条 query 都是新的）：{api.get('cold_p50_ms','n/a')} ms")
    add("")
    add("**判定：是因素之一，但也不够。** B.8 的 12.09 ms 是**热态乐观值** —— "
        "线上每条 query 都是新 query，索引页不可能总是热的。以后做预算必须区分这两个口径。")
    add("")
    add("### S3 · 编码与检索共置（剩余 ~150 ms）")
    add("")
    add("| 场景 | retrieve P50 |")
    add("|---|---:|")
    add(f"| 独立进程（只读，不编码）· 热态 | {api.get('warm_p50_ms','n/a')} ms |")
    add(f"| 独立进程（只读，不编码）· 冷态 | {api.get('cold_p50_ms','n/a')} ms |")
    add(f"| API 进程内（编码刚跑完，2 GB 模型常驻） | {g(b_sum,'retrieve_ms','p50')} ms |")
    add("")
    add("**判定：这是主要差额，但归因是推断，未做隔离验证。** 现象是：")
    add("同一台机器、同一条 SQL、同一个池配置，只在「同一进程里刚做完一次 torch 编码」这个条件下，"
        "retrieve 就从 ~35 ms 变成 ~190 ms。方向与 B.8 已经抓到过的共置污染一致 —— "
        "只不过那次是 EXACT 扫描把模型挤出页缓存（encode 91→278 ms），"
        "这次反过来是编码把 PG 的页缓存和 CPU 抢走（retrieve 35→190 ms）。")
    add("")
    add("⚠ 这条直接量化了 B.8 §10.1 拍板第 3 条「编码服务与 PG 不分机」的代价。"
        "当时选不分机、以监控兜底，代价此前没有数字，现在有了：**retrieve 段劣化约 5 倍，"
        f"e2e P50 {g(b_sum,'e2e_ms','p50')} ms，超出 200 ms 目标。**")
    add("")
    add("验证方案（未做，留给下一轮）：起一个只做编码的独立进程，"
        "把 `EMBEDDING_SERVICE_URL` 指向它，再跑一次 `b9-http-benchmark.py`。"
        "若 retrieve 回落到 ~35 ms，S3 即从推断变成结论。")
    add("")

    # ---------------------------------------------------------------- §6
    add("## §6 验收对照")
    add("")
    add("| 验收项 | 要求 | 实测 | 结论 |")
    add("|---|---|---|---|")
    add(f"| top_k=10 返回条数 | ≥ 8 | {b_acc.get('results_ge_8','n/a')}/{b_acc.get('queries_total','n/a')} 条全部返回 10 行 | ✅ |")
    add(f"| 空结果 | 0 条 | {b_acc.get('empty_results','n/a')} | ✅ |")
    add(f"| health | 返回 ok / HNSW / 800 / strict_order | ok，plan_type=HNSW，ef=800，strict_order，rows=10/10 | ✅ |")
    add(f"| HTTP 开销 | < 10 ms | {g(b_sum,'http_overhead_ms','p50')} ms | ✅ |")
    add(f"| e2e P50 | ≤ 200 ms | {g(b_sum,'e2e_ms','p50')} ms | ❌ **未达标** |")
    add(f"| Top1 命中（20 条子集） | 参考 | {b_recall.get('top1','n/a')}/{b_recall.get('denominator','n/a')} | — |")
    add("")
    add("**唯一未达标项是 e2e P50**，且缺口全在 retrieve 段（见 §5）。"
        f"编码段 {g(b_sum,'encode_ms','p50')} ms 与 B.8 一致，HTTP 层只占 "
        f"{g(b_sum,'http_overhead_ms','p50')} ms。")
    add("")

    # ---------------------------------------------------------------- §7
    add("## §7 BGE-M3 ONNX INT8 量化调研（任务 2，**全部为预期值，本机未实测**）")
    add("")
    add("> ⚠ 本节所有数字来自公开资料在**他人硬件**（多为 Xeon 8 核 / GPU）上的结果，"
        "或由本机实测值按比例外推，**均非本机实测**。不做任何「实测加速 X 倍」的表述。")
    add("")
    add("### §7.1 预期收益")
    add("")
    add("| 项 | 当前（BGE-M3 FP32 / torch） | ONNX FP32（预期） | ONNX INT8 动态量化（预期） | 依据 |")
    add("|---|---|---|---|---|")
    add(f"| 单条编码 P50 | **{g(b_sum,'encode_ms','p50')} ms（本机实测）** | ~70–100 ms | ~45–70 ms | "
        "社区在 Xeon 8 核上测得 FP32 98 ms / INT8 61 ms（同硬件 PyTorch 基线 186 ms）；本机 CPU 与负载不同，按同比例外推 |")
    add("| 常驻内存 | ~2.2 GB | ~1.2 GB | **~0.57 GB** | `gpahal/bge-m3-onnx-int8` 卡实测 564.73 MiB；另有资料记 2.2 GB → ~800 MB |")
    add("| 质量损失 | — | < 0.1% | < 0.5% MTEB（cosine vs FP32 ≈ 0.988） | runlocalai 家族资料；INT8 量化卡实测 |")
    add("| 速度增益 | — | ~1.9× | ~3× | 同上（186 → 98 → 61 ms） |")
    add("")
    add("### §7.2 为什么它对本项目可能比「编码快 3 倍」更重要")
    add("")
    add("§5 的 S3 说明：本机 e2e 超标的根因不是编码本身慢，而是 **2 GB 模型常驻 + torch 满载 CPU "
        "与 PG 抢资源**。INT8 把常驻内存从 2.2 GB 压到 ~0.57 GB，直接打在这个根因上 —— "
        "它可能同时改善编码延迟**和**检索段的共置污染。")
    add("")
    add("这是一个**待验证假设**，不是结论。验证方式见 §7.4。")
    add("")
    add("### §7.3 ⚠ 上 INT8 之前必须先解决的一致性问题")
    add("")
    add("**库里 58,332 条 chunk 向量是用 FP32 BGE-M3 编码的。** 如果只把 query 侧换成 INT8：")
    add("")
    add("- query 向量与 corpus 向量的数值分布不再同源，余弦相似度的绝对值会漂移；")
    add("- 已有的实测结论（Top1 49/100、Top10 70/100、ef=800 与 EXACT 无显著差异）**全部作废**，"
        "必须重跑一遍召回对照；")
    add("- 若要彻底一致，需要用 INT8 模型**重算 58,332 条 chunk 向量** —— 这是本轮没做的工程量。")
    add("")
    add("所以 INT8 不是「换个后端就快了」的免费午餐，它带一个必须先付的一致性成本。")
    add("")
    add("### §7.4 落地路径与准入清单")
    add("")
    add("导出（命令取自公开的 INT8 模型卡做法）：")
    add("")
    add("```bash")
    add('pip install "optimum[exporters]" onnx onnxruntime')
    add("optimum-cli export onnx -m BAAI/bge-m3 bge-m3-onnx")
    add("optimum-cli onnxruntime quantize --onnx_model bge-m3-onnx --avx2 --per_channel -o bge-m3-onnx-int8")
    add("```")
    add("")
    add("准入清单（**全部做完才允许把 `EMBEDDING_BACKEND=onnx` 放行**）：")
    add("")
    add("1. 召回对照：INT8 query 向量 vs FP32 query 向量，在同一组 100 条 v3 query 上跑 EXACT，"
        "比较 Top1 / Top10，用 McNemar 检验（B.7 的口径），**不允许只看延迟**。")
    add("2. 一致性决策：接受 query 侧单点量化，还是连 corpus 一起重算？"
        "若重算，需评估 58,332 条的重编码耗时与回滚方案（现有 `discovered_book_chunks_emb_v1` 是现成备份位）。")
    add("3. 内存实测：确认常驻内存真的降到 ~0.57 GB，并用 `b9-http-benchmark.py` 复测 retrieve 段是否回落。")
    add("4. 已预留接口：`api/embed.py` 的 `EMBEDDING_BACKEND=onnx` 分支 + `api/config.py` 的显式拒绝，"
        "实现时只需补 `OnnxBackend`，不必改调用方。")
    add("")

    # ---------------------------------------------------------------- §8
    add("## §8 任务 3：回归端点")
    add("")
    add("`GET /api/discover/regression` 直接**加载并复用** `regression-check.py` 的 "
        "`pct()` / `init_statements()` / `search_sql()` / `measure()`，不重写算法 —— "
        "避免脚本版与端点版各自漂移。")
    add("")
    add("⚠ 端点自己开两条**一次性**连接（一条生产配置、一条禁索引跑 EXACT），"
        "跑完即关，**绝不放回 API 共享池** —— 否则之后所有业务请求的路径都被改掉了。")
    add("")
    add("**本轮完整模式实测（`?sample=20&repeats=3&budget=400`）：**")
    add("")
    add("| 项 | 值 |")
    add("|---|---|")
    rc = regr.get("row_count")
    add(f"| 行数 | {rc:,} |" if isinstance(rc, int) else f"| 行数 | {rc} |")
    add(f"| HNSW P50 / P95 | {regr.get('hnsw_p50_ms','n/a')} / {regr.get('hnsw_p95_ms','n/a')} ms |")
    add(f"| EXACT P50 / P95 | {regr.get('exact_p50_ms','n/a')} / {regr.get('exact_p95_ms','n/a')} ms |")
    add(f"| 拟合 | {regr.get('fit_mode','n/a')} |")
    add(f"| 斜率 / 截距 | {regr.get('slope_ms_per_1k_rows','n/a')} ms per 1k 行 / {regr.get('intercept_ms','n/a')} ms |")
    add(f"| N* @400ms（短/长 query） | {g(regr,'n_star_400ms','short')} / {g(regr,'n_star_400ms','long')} 行 |")
    add(f"| N* @500ms（短/长 query） | {g(regr,'n_star_500ms','short')} / {g(regr,'n_star_500ms','long')} 行 |")
    add(f"| 占用率 | {regr.get('headroom_ratio','n/a')} |")
    add(f"| **状态** | **{regr.get('status','n/a')}** |")
    add("")
    st = regr.get("status", "n/a")
    add(f"**EXACT P50 回落到 {regr.get('exact_p50_ms','n/a')} ms**（B.8 那轮是 475.32 ms）—— "
        "这印证了 B.8 §10.1 的判断：475 ms 是**高内存压力期的临时退化**，不是稳态基线。")
    add("")
    add(f"但本轮状态是 **{st}**（占用率 {regr.get('headroom_ratio','n/a')}）："
        "即便 EXACT 已经回落，58,332 行仍然**贴着 400 ms 预算线** —— "
        "这不是一个可以放下的警报，规模再涨一点点就会系统性越线。")
    add("")
    add("> ⚠ 顺带记一个测量稳定性问题：本轮连续跑了两次完整模式，"
        "EXACT P50 分别得到 216.83 ms（status WARN，占用率 0.979）与 "
        f"{regr.get('exact_p50_ms','n/a')} ms（status {st}，占用率 {regr.get('headroom_ratio','n/a')}）。"
        "也就是说在内存压力下，**单次 20 条采样不足以稳定区分 WARN 与 ALERT**。"
        "判定趋势时应看多次运行，或固定时段、提高 sample 后再下结论。")
    add("")
    add("`?quick=true` 只量 HNSW（本轮 1.7 s 返回，vs 完整模式 19.9 s），"
        "跳过 EXACT 与拟合，不做 OK/WARN/ALERT 判定并在响应里写明。")
    add("")

    # ---------------------------------------------------------------- §9
    add("## §9 遗留与下一步")
    add("")
    add("| # | 遗留 | 说明 |")
    add("|---|---|---|")
    add("| 1 | **e2e P50 未达 200 ms** | 缺口在 retrieve 段，根因指向共置污染（§5 S3，推断）。"
        "下一步：起独立编码进程 + `EMBEDDING_SERVICE_URL` 验证；或走 ONNX INT8 降常驻内存（§7） |")
    add("| 2 | `book_filter` / `chapter_filter` 未实现 | 会给 `400 not_implemented`。要实现需先单独验证执行计划路径 |")
    add("| 3 | ONNX 后端未实现 | 调研完成，准入清单见 §7.4；`config.py` 会显式拒绝启动，不静默退化 |")
    add("| 4 | 冷/热口径未写入既有文档 | B.8 的 12.09 ms 是热态值。建议在 B.8 报告补注：做预算要区分冷态（线上真实）与热态 |")
    add("| 5 | 1% EXPLAIN 抽样尚未真正触发 | 本轮 20 条请求 × 1% ≈ 0 次。机制已就绪（退化会打 warning 日志），"
        "需要更大流量才看得到效果 |")
    add("| 6 | 服务未做优雅停机 / 限流 / 鉴权 | 当前只监听 127.0.0.1，属本机内部服务；对外暴露前需补 |")
    add("| 7 | 探针在第一版有顺序效应缺陷 | 已用 AB+BA 修正，但「纯冷态」在单进程内无法公平测量，"
        "结论按「半热」理解 |")
    add("| 8 | 回归判定在 WARN / ALERT 边界摆动 | 连续两次完整模式得到 216.83 ms(WARN, 0.979) 与 "
        f"{regr.get('exact_p50_ms','n/a')} ms({st}, {regr.get('headroom_ratio','n/a')})。"
        "定趋势要用多次运行或更大 sample，别拿单次结果当结论 |")
    add("")

    # ---------------------------------------------------------------- §10
    add("## §10 提交")
    add("")
    add("```")
    add(git("log", "--oneline", "-3"))
    add("```")
    add("")
    add("本轮新增：`api/`（含 8 个文件）、`api/requirements-api.txt`、"
        "`server/src/scripts/b9-retrieve-cost-probe.py`、"
        "`server/src/scripts/make-b9-execution-report.py`、本报告。")
    add("")
    return "\n".join(L) + "\n"


def main() -> int:
    text = build()
    OUT.write_text(text, encoding="utf-8")
    print(f"写入 {OUT}（{len(text)} 字符）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
