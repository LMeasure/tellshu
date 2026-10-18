# B.9 执行报告 —— HTTP API 实现 + 编码优化调研

生成时间：2026-10-19 01:01:39　|　分母 20 条　|　top_k=10　|　后端 BGE-M3 本地常驻　|　commit 8ee7658

---

## §1 本轮目标与红线

| # | 目标 | 结果 |
|---|---|---|
| 任务 1 | 实现可运行的 FastAPI 检索 API（连接池按 `db-conn-init.sql` 初始化） | ✅ 已实现并跑通 |
| 任务 2 | BGE-M3 ONNX INT8 量化调研（**不实现**） | ✅ 调研完成，见 §7 |
| 任务 3 | 回归检查做成 HTTP 端点（含 `?quick=true`） | ✅ 已实现并跑通，见 §8 |
| 任务 4 | 提交 `api/` + `requirements-api.txt` + 本报告 | ⏳ 见 §10 |

红线（本轮严格遵守）：

- 只读：API 全程只有 SELECT，不写任何业务表。
- 检索 SQL **从现有脚本复制**（`eval-discover.py` 的 main 分支），不重写；只补两列投影以满足 §9.1 契约，FROM/JOIN/WHERE/ORDER BY/LIMIT 一字未动。
- 连接初始化的 `SELECT NULL::vector` 不能省，且必须做**功能性验证**（返回 10 行，不是 2 行或 0 行）。
- 没测过的数字不填：ONNX 全部标「预期」，未实现的能力明确报 `not_implemented` 而不是假装支持。

## §2 交付物

| 文件 | 作用 |
|---|---|
| `api/main.py` | FastAPI 应用：路由、结构化日志、错误模型、启动时序 |
| `api/config.py` | 集中配置 + 启动校验（fail fast）；GUC 期望值从 `db-conn-init.sql` 解析 |
| `api/db.py` | 连接池（重写 `_connect()` 在建连后执行 init SQL）+ 同步查询的线程卸载 |
| `api/embed.py` | 编码后端：local（BGE-M3 常驻）/ remote（`EMBEDDING_SERVICE_URL`）/ onnx（预留，未实现） |
| `api/retrieve.py` | 检索 SQL（复制自 `eval-discover.py`）+ EXPLAIN 递归解析 + 1% 抽样监控 |
| `api/init.py` | 启动自检：GUC 实测 + 返回行数功能验证 + 执行计划验证 |
| `api/regression.py` | 回归端点逻辑（**直接复用** `regression-check.py` 的函数，不重写算法） |
| `api/b9-http-benchmark.py` | HTTP 端验收压测（warmup 后测 20 条，分离 HTTP 开销） |
| `api/requirements-api.txt` | 依赖清单（本机实测版本锁定） |
| `server/src/scripts/b9-retrieve-cost-probe.py` | 归因探针：content 列代价 / 冷态热态口径差（AB+BA 抵消顺序效应） |
| `server/src/scripts/make-b9-execution-report.py` | 本报告生成器 |

## §3 任务 1：API 实现

### §3.1 启动时序

```
配置校验 → 加载 BGE-M3（一次性，常驻）→ 建连接池（每连接执行 db-conn-init.sql）
        → 启动自检（GUC + 返回行数 + 执行计划）→ 自检失败直接拒绝启动
```

启动命令：

```bash
cd api
C:/Python314/python.exe -m uvicorn main:app --host 127.0.0.1 --port 8000
```

### §3.2 连接初始化：不只是执行，还要验证生效

`db.py` 重写了 `ThreadedConnectionPool._connect()`，每条新连接建好后立刻执行：

```sql
SELECT NULL::vector;                  -- 少了这行，下面两条 SET 会静默变成不生效的占位符
SET hnsw.ef_search = 800;
SET hnsw.iterative_scan = strict_order;
```

**实测（5 条池连接逐条 SHOW，不是抽查一条）：**

```
conn#0..#4: ef_search=800 iterative_scan=strict_order   （5/5 全部生效）
startup_check.ok = True
  guc  : 800 / strict_order，与 db-conn-init.sql 期望值一致
  rows : top_k=10 → 返回 10 行（不是 2 行、不是 0 行）
  plan : HNSW，索引 discovered_book_chunks_embedding_hnsw_idx
```

### §3.3 端点契约

```
POST /api/discover
  Request : { query, top_k=10, include_front_matter=false, ef_search?, book_filter?, chapter_filter? }
  Response: { results[{chunk_id, book_id, title, author, chapter_title, chunk_index, content, score}],
              latency{encode_ms, retrieve_ms, e2e_ms}, meta{...} }

GET  /api/discover/health
  → status / database{ef_search, iterative_scan, guc_match} / plan{type, index, rows_returned} / pool

GET  /api/discover/regression?quick=&sample=&top_k=&repeats=&budget=&seed=
  → HNSW/EXACT P50·P95、两点拟合斜率、N*、占用率、OK/WARN/ALERT

GET  /
  → 服务信息与端点清单
```

错误结构沿用 `server/src/http/errors.ts`：`{ "error": { code, message, details? } }`，不回传堆栈。

**诚实边界（明确报错，不假装支持）：**

- `book_filter` / `chapter_filter`：返回 `400 not_implemented`。加过滤条件会改变执行计划路径，必须先单独做一轮路径验证，不给没验过的行为。
- `ef_search`：只放行 B.6 矩阵实测过的 `40/80/120/200/400/800`。未测过的 ef 可能落进退化区（B.7：160~400 会让优化器改用 `book_idx` 全扫 + Sort），那不是慢一点，是换路径。
- `EMBEDDING_BACKEND=onnx`：启动时直接拒绝。B.9 只做了调研，没实现，不静默退化成 torch 冒充量化。

## §4 任务 1 实测：HTTP 端跑 20 条 v3 query

warmup 8 次已丢弃（首次请求含模型分页 + 线程池初始化，不丢掉拿到的不是稳态）。

| 指标 | P50 | P95 | P99 | max |
|---|---:|---:|---:|---:|
| client_ms | 341.06 | 577.66 | 645.9 | 662.96 |
| encode_ms | 140.66 | 162.16 | 179.83 | 184.25 |
| retrieve_ms | 189.66 | 407.43 | 494.31 | 516.03 |
| e2e_ms | 333.33 | 552.09 | 638.27 | 659.81 |
| http_overhead_ms | 4.77 | 26.92 | 29.48 | 30.12 |

| 对照项 | B.8 基线（进程内，无 HTTP） | 本轮（HTTP） |
|---|---:|---:|
| encode P50 | 154.74 ms | 140.66 ms |
| retrieve P50 | 12.09 ms | 189.66 ms |
| e2e P50 | 168.19 ms | 333.33 ms |
| e2e P95 | 228.20 ms | 552.09 ms |

**HTTP 开销 P50 = 4.77 ms**（客户端往返 − 服务端自报 e2e），达标（<10 ms）。编码这一段也与 B.8 吻合（140.66 vs 154.74 ms，本机负载下略快）。

**但 retrieve 是 189.66 ms，B.8 是 12.09 ms —— 差 15.7 倍。这是本轮最重要的异常，下一节专门归因。**

## §5 归因：retrieve 为什么不是 12 ms

三个嫌疑，逐个排除。探针用**零编码成本**的缓存向量跑（不加载模型），同一条连接、同一组 20 条 query。

### S1 · SQL 里多了 `c.content`（回表代价）

| 口径 | B.8 同款 SQL（无 content） | API 同款 SQL（有 content） | 差值 |
|---|---:|---:|---:|
| 热态 P50（同一条连跑 3 次取中位） | 8.04 ms | 8.82 ms | 0.78 ms |
| 冷态 P50（每条首次，线上形态） | 30.37 ms | 35.64 ms | 5.27 ms |

**判定：不是主因。** 热态差值在噪声内（<1 ms），冷态 +5 ms 量级 —— content 确实有代价，但解释不了 180 ms。

> 顺带一个方法论坑：第一版探针没做顺序抵消，先跑的臂吸收了 456 MB HNSW 索引的全部冷启动代价，得出「不含 content 反而慢 4 倍」的反常结论。改成 **AB + BA 两轮取平均**后才拿到可用数字。

### S2 · 冷态 / 热态口径差

- 热态（B.8 的口径：同一条 query 连跑 3 次取中位）：8.82 ms
- 冷态（线上真实形态：每条 query 都是新的）：35.64 ms

**判定：是因素之一，但也不够。** B.8 的 12.09 ms 是**热态乐观值** —— 线上每条 query 都是新 query，索引页不可能总是热的。以后做预算必须区分这两个口径。

### S3 · 编码与检索共置（剩余 ~150 ms）

| 场景 | retrieve P50 |
|---|---:|
| 独立进程（只读，不编码）· 热态 | 8.82 ms |
| 独立进程（只读，不编码）· 冷态 | 35.64 ms |
| API 进程内（编码刚跑完，2 GB 模型常驻） | 189.66 ms |

**判定：这是主要差额，但归因是推断，未做隔离验证。** 现象是：
同一台机器、同一条 SQL、同一个池配置，只在「同一进程里刚做完一次 torch 编码」这个条件下，retrieve 就从 ~35 ms 变成 ~190 ms。方向与 B.8 已经抓到过的共置污染一致 —— 只不过那次是 EXACT 扫描把模型挤出页缓存（encode 91→278 ms），这次反过来是编码把 PG 的页缓存和 CPU 抢走（retrieve 35→190 ms）。

⚠ 这条直接量化了 B.8 §10.1 拍板第 3 条「编码服务与 PG 不分机」的代价。当时选不分机、以监控兜底，代价此前没有数字，现在有了：**retrieve 段劣化约 5 倍，e2e P50 333.33 ms，超出 200 ms 目标。**

验证方案（未做，留给下一轮）：起一个只做编码的独立进程，把 `EMBEDDING_SERVICE_URL` 指向它，再跑一次 `b9-http-benchmark.py`。若 retrieve 回落到 ~35 ms，S3 即从推断变成结论。

## §6 验收对照

| 验收项 | 要求 | 实测 | 结论 |
|---|---|---|---|
| top_k=10 返回条数 | ≥ 8 | 20/20 条全部返回 10 行 | ✅ |
| 空结果 | 0 条 | 0 | ✅ |
| health | 返回 ok / HNSW / 800 / strict_order | ok，plan_type=HNSW，ef=800，strict_order，rows=10/10 | ✅ |
| HTTP 开销 | < 10 ms | 4.77 ms | ✅ |
| e2e P50 | ≤ 200 ms | 333.33 ms | ❌ **未达标** |
| Top1 命中（20 条子集） | 参考 | 12/20 | — |

**唯一未达标项是 e2e P50**，且缺口全在 retrieve 段（见 §5）。编码段 140.66 ms 与 B.8 一致，HTTP 层只占 4.77 ms。

## §7 BGE-M3 ONNX INT8 量化调研（任务 2，**全部为预期值，本机未实测**）

> ⚠ 本节所有数字来自公开资料在**他人硬件**（多为 Xeon 8 核 / GPU）上的结果，或由本机实测值按比例外推，**均非本机实测**。不做任何「实测加速 X 倍」的表述。

### §7.1 预期收益

| 项 | 当前（BGE-M3 FP32 / torch） | ONNX FP32（预期） | ONNX INT8 动态量化（预期） | 依据 |
|---|---|---|---|---|
| 单条编码 P50 | **140.66 ms（本机实测）** | ~70–100 ms | ~45–70 ms | 社区在 Xeon 8 核上测得 FP32 98 ms / INT8 61 ms（同硬件 PyTorch 基线 186 ms）；本机 CPU 与负载不同，按同比例外推 |
| 常驻内存 | ~2.2 GB | ~1.2 GB | **~0.57 GB** | `gpahal/bge-m3-onnx-int8` 卡实测 564.73 MiB；另有资料记 2.2 GB → ~800 MB |
| 质量损失 | — | < 0.1% | < 0.5% MTEB（cosine vs FP32 ≈ 0.988） | runlocalai 家族资料；INT8 量化卡实测 |
| 速度增益 | — | ~1.9× | ~3× | 同上（186 → 98 → 61 ms） |

### §7.2 为什么它对本项目可能比「编码快 3 倍」更重要

§5 的 S3 说明：本机 e2e 超标的根因不是编码本身慢，而是 **2 GB 模型常驻 + torch 满载 CPU 与 PG 抢资源**。INT8 把常驻内存从 2.2 GB 压到 ~0.57 GB，直接打在这个根因上 —— 它可能同时改善编码延迟**和**检索段的共置污染。

这是一个**待验证假设**，不是结论。验证方式见 §7.4。

### §7.3 ⚠ 上 INT8 之前必须先解决的一致性问题

**库里 58,332 条 chunk 向量是用 FP32 BGE-M3 编码的。** 如果只把 query 侧换成 INT8：

- query 向量与 corpus 向量的数值分布不再同源，余弦相似度的绝对值会漂移；
- 已有的实测结论（Top1 49/100、Top10 70/100、ef=800 与 EXACT 无显著差异）**全部作废**，必须重跑一遍召回对照；
- 若要彻底一致，需要用 INT8 模型**重算 58,332 条 chunk 向量** —— 这是本轮没做的工程量。

所以 INT8 不是「换个后端就快了」的免费午餐，它带一个必须先付的一致性成本。

### §7.4 落地路径与准入清单

导出（命令取自公开的 INT8 模型卡做法）：

```bash
pip install "optimum[exporters]" onnx onnxruntime
optimum-cli export onnx -m BAAI/bge-m3 bge-m3-onnx
optimum-cli onnxruntime quantize --onnx_model bge-m3-onnx --avx2 --per_channel -o bge-m3-onnx-int8
```

准入清单（**全部做完才允许把 `EMBEDDING_BACKEND=onnx` 放行**）：

1. 召回对照：INT8 query 向量 vs FP32 query 向量，在同一组 100 条 v3 query 上跑 EXACT，比较 Top1 / Top10，用 McNemar 检验（B.7 的口径），**不允许只看延迟**。
2. 一致性决策：接受 query 侧单点量化，还是连 corpus 一起重算？若重算，需评估 58,332 条的重编码耗时与回滚方案（现有 `discovered_book_chunks_emb_v1` 是现成备份位）。
3. 内存实测：确认常驻内存真的降到 ~0.57 GB，并用 `b9-http-benchmark.py` 复测 retrieve 段是否回落。
4. 已预留接口：`api/embed.py` 的 `EMBEDDING_BACKEND=onnx` 分支 + `api/config.py` 的显式拒绝，实现时只需补 `OnnxBackend`，不必改调用方。

## §8 任务 3：回归端点

`GET /api/discover/regression` 直接**加载并复用** `regression-check.py` 的 `pct()` / `init_statements()` / `search_sql()` / `measure()`，不重写算法 —— 避免脚本版与端点版各自漂移。

⚠ 端点自己开两条**一次性**连接（一条生产配置、一条禁索引跑 EXACT），跑完即关，**绝不放回 API 共享池** —— 否则之后所有业务请求的路径都被改掉了。

**本轮完整模式实测（`?sample=20&repeats=3&budget=400`）：**

| 项 | 值 |
|---|---|
| 行数 | 58,332 |
| HNSW P50 / P95 | 8.79 / 29.06 ms |
| EXACT P50 / P95 | 232.5 / 252.33 ms |
| 拟合 | 两点拟合（discovered_book_chunks_exp 24,244 + discovered_book_chunks 58,332） |
| 斜率 / 截距 | 4.3974 ms per 1k 行 / -24.0 ms |
| N* @400ms（短/长 query） | 75694 / 55953 行 |
| N* @500ms（短/长 query） | 98435 / 78694 行 |
| 占用率 | 1.043 |
| **状态** | **ALERT** |

**EXACT P50 回落到 232.5 ms**（B.8 那轮是 475.32 ms）—— 这印证了 B.8 §10.1 的判断：475 ms 是**高内存压力期的临时退化**，不是稳态基线。

但本轮状态是 **ALERT**（占用率 1.043）：即便 EXACT 已经回落，58,332 行仍然**贴着 400 ms 预算线** —— 这不是一个可以放下的警报，规模再涨一点点就会系统性越线。

> ⚠ 顺带记一个测量稳定性问题：本轮连续跑了两次完整模式，EXACT P50 分别得到 216.83 ms（status WARN，占用率 0.979）与 232.5 ms（status ALERT，占用率 1.043）。也就是说在内存压力下，**单次 20 条采样不足以稳定区分 WARN 与 ALERT**。判定趋势时应看多次运行，或固定时段、提高 sample 后再下结论。

`?quick=true` 只量 HNSW（本轮 1.7 s 返回，vs 完整模式 19.9 s），跳过 EXACT 与拟合，不做 OK/WARN/ALERT 判定并在响应里写明。

## §9 遗留与下一步

| # | 遗留 | 说明 |
|---|---|---|
| 1 | **e2e P50 未达 200 ms** | 缺口在 retrieve 段，根因指向共置污染（§5 S3，推断）。下一步：起独立编码进程 + `EMBEDDING_SERVICE_URL` 验证；或走 ONNX INT8 降常驻内存（§7） |
| 2 | `book_filter` / `chapter_filter` 未实现 | 会给 `400 not_implemented`。要实现需先单独验证执行计划路径 |
| 3 | ONNX 后端未实现 | 调研完成，准入清单见 §7.4；`config.py` 会显式拒绝启动，不静默退化 |
| 4 | 冷/热口径未写入既有文档 | B.8 的 12.09 ms 是热态值。建议在 B.8 报告补注：做预算要区分冷态（线上真实）与热态 |
| 5 | 1% EXPLAIN 抽样尚未真正触发 | 本轮 20 条请求 × 1% ≈ 0 次。机制已就绪（退化会打 warning 日志），需要更大流量才看得到效果 |
| 6 | 服务未做优雅停机 / 限流 / 鉴权 | 当前只监听 127.0.0.1，属本机内部服务；对外暴露前需补 |
| 7 | 探针在第一版有顺序效应缺陷 | 已用 AB+BA 修正，但「纯冷态」在单进程内无法公平测量，结论按「半热」理解 |
| 8 | 回归判定在 WARN / ALERT 边界摆动 | 连续两次完整模式得到 216.83 ms(WARN, 0.979) 与 232.5 ms(ALERT, 1.043)。定趋势要用多次运行或更大 sample，别拿单次结果当结论 |

## §10 提交

```
8ee7658 docs(convert): 更正 V2.2 文档中 tencent.ts 报错陈述
338108b docs(convert): 格式转换 V2.2 文档入库（结果文件 TTL 自动清理）
1f6652c docs(asr): Phase 1.5 ASR 本地自建交付文档入库
```

本轮新增：`api/`（含 8 个文件）、`api/requirements-api.txt`、`server/src/scripts/b9-retrieve-cost-probe.py`、`server/src/scripts/make-b9-execution-report.py`、本报告。

