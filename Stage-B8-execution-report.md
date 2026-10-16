# Stage B.8 — 切换 HNSW + 端到端预算实测

生成时间：2026-10-17 06:03:14　|　分母 100 条　|　top_k=10　|　每条检索重复 3 次取中位

**这是本项目第一个真实预算锚点** —— B.6/B.7 的延迟都是外推，本轮直接测 `encode_ms` / `retrieve_ms` / `e2e_ms`。

---

## §0 结论速览

| 项 | 结果 |
|---|---|
| **生产配置** | `ef_search=800` + `iterative_scan=strict_order`（连接级） |
| **检索 P50** | **12.09 ms**（目标 ≤15ms → ✅） |
| **端到端 P50** | **168.19 ms**（目标 ≤120ms → ❌ 超 48ms） |
| **EXACT 对照** | 检索 475.32 ms / 端到端 623.84 ms |
| **加速比** | 检索 39×、端到端 3.7× |
| **召回** | Top1 49/100、Top10 70/100、0 行 0、不足 0 |
| **回归状态** | **ALERT**（58,332 行 / 400ms 长 query 阈值 46,128 行） |

> ⚠ **立即上报**：EXACT 检索 P50 实测 **475.32 ms** （> 350ms 红线）。落在「EXACT 已不可用，立即切 HNSW + 排查额外负载因素」分支。

## §1 生产配置切换

连接初始化 SQL：`server/src/scripts/db-conn-init.sql`

```sql
SELECT NULL::vector;                        -- 必须先加载 pgvector，否则 GUC 不存在
SET hnsw.ef_search = 800;
SET hnsw.iterative_scan = strict_order;
```

| 检查 | 期望 | 实测 | 判定 |
|---|---|---|---|
| init 会话 `hnsw.ef_search` | 800 | **800** | ✅ PASS |
| init 会话 `hnsw.iterative_scan` | strict_order | **strict_order** | ✅ PASS |
| 裸会话 `hnsw.ef_search`（R1） | 40 | **40** | ✅ PASS |
| 裸会话 `hnsw.iterative_scan`（R5） | off | **off** | ✅ PASS |

### §1.1 一个容易踩的坑（已验证）

`SET hnsw.ef_search` 在 pgvector 未加载时**不会报错** —— PostgreSQL 会把它当成 namespaced placeholder，`SET` / `SHOW` 都正常返回，但**可能没真正作用到 pgvector**。
功能性验证（`iterative_scan=off` 时过滤查询只返回 2 行，`strict_order` 生效应返回 10 行）：

| 写法 | SHOW 结果 | 实际返回行数 |
|---|---|---:|
| 先 `SELECT NULL::vector` 再 SET | 800 / strict_order | **10** |
| 不预载直接 SET | 800 / strict_order | **10** |
| 裸会话（不 SET） | — / off | **2**（饥饿基线） |

结论：本库上 placeholder 会被后加载的扩展接管，两种写法都生效；但 `SELECT NULL::vector` 仍然保留在文件里 —— 它保证 `SHOW` / `current_setting()` 在任何时候都能读到值，不依赖 placeholder 交接语义。

## §2 端到端延迟分解（100 条，隔离分段）

| 统计量 | encode_ms | retrieve_ms (ef=800) | **e2e_ms** | EXACT retrieve_ms | EXACT e2e_ms |
|---|---:|---:|---:|---:|---:|
| P50 | **154.74** | **12.09** | **168.19** | 475.32 | 623.84 |
| P95 | 199.67 | 35.68 | 228.2 | 591.37 | 758.02 |
| P99 | 228.54 | 45.43 | 249.33 | 688.47 | 817.87 |
| MEAN | 157.97 | 15.37 | 173.33 | 462.54 | 620.51 |
| MAX | 280.95 | 51.15 | 310.71 | 766.38 | 919.19 |

**端到端 P50 = 168.19 ms**（编码 154.74 + 检索 12.09），对比 EXACT 的 623.84 ms —— **快 3.7×**。

### §2.1 方法论：第一版数据作废，原因记录在此

第一版是「每条 query 交错跑 encode + 3 次 EXACT 扫描」。EXACT 每次要扫 808 MB，会把 BGE-M3 的模型页挤出页缓存 —— **encode 从 ~91ms 劣化到 278ms，连 HNSW 检索也被拖慢**。两组数字互相污染，不能当预算锚点。本版改成隔离分段：段0 编码（不碰库）→ 段1 HNSW → 段2 EXACT。

| 指标 | 交错测量（作废） | **隔离分段（采用）** | 污染幅度 |
|---|---:|---:|---:|
| encode_ms P50 | 278.26 ms | **154.74 ms** | 1.80× |
| retrieve_ms P50 | 19.93 ms | **12.09 ms** | 1.65× |
| exact_retrieve_ms P50 | 632.85 ms | **475.32 ms** | 1.33× |

（交错数据保留在 `.crawl-cache/_b8-e2e-interleaved.json`，作为污染幅度的证据。）

> 副产品发现：这条污染不是纯测量误差 —— **如果生产上继续用 EXACT，808MB 的全表扫描确实会挤压同机部署的编码服务**。这是切 HNSW 的又一个理由。

### §2.2 编码延迟为什么比阶段 2 高

| query 长度 | 条数 | encode P50 | e2e P50 |
|---|---:|---:|---:|
| 0–20 字 | 7 | 131.7 ms | 147.9 ms |
| 20–40 字 | 78 | 155.9 ms | 168.5 ms |
| 40–60 字 | 8 | 173.2 ms | 181.8 ms |
| 60+ 字 | 7 | 199.3 ms | 212.6 ms |

阶段 2 的 91.15 ms 是 **13 字短句**测出来的；本轮 query 集中位长度 28 字，编码自然更慢。另外本机内存负载已达 83%（可用 2.5 GB），整体上比阶段 2 测量时慢。

## §3 Recall 确认

| 臂 | Top1 | Top10 | 0 行 | 不足 |
|---|---:|---:|---:|---:|
| **ef=800 + strict_order（生产配置）** | **49/100** | 70/100 | **0** | 0 |
| EXACT（天花板） | 51/100 | 79/100 | — | — |

相对天花板：Top1 96.1%（49/51）、Top10 88.6%（70/79）。

> ⚠ **验收口径要澄清**：任务书写「Top1 recall ≥ 95/100（B.7 为 96/100）」，但**绝对召回的天花板就是 51/100**（EXACT 也只有这么多）—— 95/100 在物理上不可达。B.7 的「96」应为**相对天花板的比例**（49/51 = 96.1%），本轮实测 96.1%，符合。

### §3.1 验收

| 验收项 | 期望 | 实测 | 判定 |
|---|---|---:|---|
| retrieve_ms P50 | ≤ 15 ms | 12.09 | ✅ PASS |
| e2e_ms P50 | ≤ 120 ms | 168.19 | ❌ FAIL |
| 返回 0 行的 query | 0 | 0 | ✅ PASS |
| Top1 相对天花板 | ≥ 95% | 96.1% | ✅ PASS |

**e2e 超标的 48 ms 全部来自编码**（实测 154.74 ms，预算假设 ~100 ms）；检索只用了 12.09 ms，比 15 ms 的额度还省 2.9 ms。

## §4 预算修正

| 指标 | B.6 测量 | B.7 复测 | **B.8 实测** | 采用 |
|---|---:|---:|---:|---|
| EXACT 检索 P50 (ms) | 220.7 | 276.9 | **475.32** | 见下方说明（波动大） |
| 斜率 (ms/1k rows) | 4.4438 | 5.5756 | **4.928** | 4.928（回归脚本两点拟合） |
| 截距 (ms) | −38.02 | -48.31 | **-5.28** | -5.28 |
| ef=800 检索 P50 (ms) | 6.3 | 8.4 / 11.3 | **12.09** | 12.09 |
| 编码 P50 (ms) | 91.15（13字） | 91.15（13字） | **154.74**（中位 28 字） | 154.74 |
| 端到端 P50 (ms) | — | — | **168.19** | 168.19 |
| N* @400ms（长 query） | 78k（短） | 48.5k | **46,128** | 46,128 |
| N* @500ms（长 query） | 100.6k（短） | 66.4k | **66,420** | 66,420 |

### §4.1 分支判定

| 分支 | 条件 | 是否满足 |
|---|---|---|
| ① | B.8 实测 EXACT P50 ≤ 250ms → 短期可继续 | ❌（实测 475.32 ms） |
| ② | 250–300ms → 悬崖线上，立即切 | ❌ |
| ③ | **>300ms → 已不可用，立即切 + 排查负载** | ✅ 命中 |

**命中分支 ③。结论：EXACT 已不可用，立即切 HNSW，并排查额外负载因素。**

### §4.2 额外负载因素排查

EXACT 检索 P50 在**同一小时内**的几次测量：

| 场景 | EXACT P50 |
|---|---:|
| B.6 当天 | 220.7 ms |
| B.7 复测（无模型） | 276.9 ms |
| B.8 前（无模型） | 364.3 ms |
| B.8 回归脚本（20 条抽样，无模型） | 282.2 ms |
| **B.8 段2（100 条，已释放模型）** | **475.32 ms** |
| B.8 交错版（模型常驻） | 632.85 ms |

嫌疑（按可能性排序）：

1. **系统内存压力** —— 实测内存负载 83%、可用物理内存仅 2.5 GB / 15.2 GB。EXACT 每次扫 808 MB，页缓存根本放不下，重复读盘。
2. **与编码服务争内存带宽** —— 模型常驻时 EXACT 从 ~364ms 涨到 ~633ms（1.7×）。
3. 数据本身没变（内容指纹未变、行数未变、SQL 逐字一致），**可以排除数据因素**。

**处置建议**：①立即切 HNSW（不依赖大扫描，受内存压力影响小得多）；②编码服务与 PostgreSQL **分机部署**，或至少保证编码服务有独立内存；③若要继续用 EXACT 做对照，先把 `shared_buffers` 调到能装下主表（≥1 GB）。

## §5 回归验证脚本

脚本：`server/src/scripts/regression-check.py`

```bash
C:/Python314/python.exe -u src/scripts/regression-check.py --run --sample 20 --budget 400
```

设计要点：

- **不加载 BGE-M3**（RSS ~2GB，不适合定时跑）→ 复用缓存的 query 向量 `.crawl-cache/_b8-query-vectors.json`（由 `b8-e2e-experiment.py` 产出）
- **斜率每次重算**，不硬编码：本库有第二张同构真实表 `discovered_book_chunks_exp`（24,244 行），直接两点拟合；拿不到才退化为单点斜率 + 固定截距
- 连接执行 `db-conn-init.sql`（生产配置），全程只读

当前输出：

```json
{
  "timestamp": "2026-10-17 06:04:58",
  "row_count": 58332,
  "sample_size": 20,
  "exact_p50_ms": 282.18,
  "exact_p95_ms": 304.39,
  "hnsw_p50_ms": 16.69,
  "hnsw_p95_ms": 37.84,
  "slope_ms_per_1k_rows": 4.928,
  "intercept_ms": -5.28,
  "fit_mode": "两点拟合（discovered_book_chunks_exp 24,244 + discovered_book_chunks 58,332）",
  "n_star_400ms": {
    "short": 63744,
    "long": 46128
  },
  "n_star_500ms": {
    "short": 84036,
    "long": 66420
  },
  "headroom_ratio": 1.265,
  "status": "ALERT"
}
```

**当前状态：`ALERT`** —— 58,332 行，已达 400ms 长 query 阈值（46,128 行）的 126.5%。

status 逻辑：`OK` 行数 < N*×0.8｜`WARN` ≥ N*×0.8 且 < N*｜`ALERT` ≥ N*（N* 取长 query 的保守值）

**建议频率**：每周一次，或每次大批量导入新书籍后立即跑。

## §6 红线核验

| # | 检查项 | 期望 | 实际 | PASS/FAIL |
|---|---|---|---|---|
| R1 | 裸会话 hnsw.ef_search | 40 | 40 | PASS |
| R2 | HNSW 索引大小 | ≈456 MB | 456 MB | PASS |
| R3 | 正式表行数 | 58,332 | 58,332 | PASS |
| R3 | 内容指纹 | 770e7c8bbaca404c8418087418d1c632 | 770e7c8bbaca404c8418087418d1c632 | PASS |
| R3 | id 序列 md5（B.7 新基线） | 4a6336c4de7ab7ce2c9565f5d37147d5 | 4a6336c4de7ab7ce2c9565f5d37147d5 | PASS |
| R4 | _exp 备份表行数 | 24,244 | 24,244 | PASS |
| R5 | 裸会话 iterative_scan | off | off | PASS |
| R6 | discover-query-set-v3.json md5 | ed407071ea89a3ca31b508daf00493f5 | ed407071ea89a3ca31b508daf00493f5 | PASS |

补充说明：

- 本轮所有 GUC 一律在**连接级**设置（`SET` / `set_config`），没有 `ALTER SYSTEM` / `ALTER ROLE` / `ALTER DATABASE`，没有编辑 `postgresql.conf`。
- 未 REINDEX、未改正式表、未建任何函数（`explain-plan-observer.sql` 仍未安装）。

## §7 Git 状态

- 提交前 HEAD：`8d90d8f`（B.7 基线）
- 提交后 HEAD：**`8d90d8f`**

```
8d90d8f docs(discover): B.7 报告格式修正（p 值精度 / 只读声明口径）
73c7107 docs(discover): B.7 报告补录 commit hash 与 git 统计
dbd1a5b feat(discover): B.6/B.7 — pgvector ANN tuning matrix, iterative_scan fix, scaling curve
f2174ba chore: 建立项目初始基线（述树 ShuShu 交付包）
```

**本轮新增文件**：

- `Stage-B8-execution-report.md`（本报告）
- `server/src/scripts/db-conn-init.sql` —— 生产连接初始化（ef=800 + strict_order）
- `server/src/scripts/regression-check.py` —— 可定期跑的回归告警脚本
- `server/src/scripts/b8-e2e-experiment.py` —— 端到端延迟分解实测
- `server/src/scripts/make-b8-execution-report.py` —— 本报告生成器

## §9 HTTP API 方案（更新版，**本轮仍不实现**）

### §9.1 端点与契约

```
POST /api/discover
```

```jsonc
// Request
{
  "query": "一位富家小姐拒绝了门当户对的求婚",
  "top_k": 10,
  "book_filter": ["12", "7"],        // optional, null/缺省 = 全部书
  "chapter_filter": ["Chapter 3"],   // optional
  "ef_search": 800                   // optional, default 800
}

// Response 200
{
  "results": [
    {
      "chunk_id": 12345,
      "book_id": "12",
      "chapter_title": "Chapter 3",
      "content": "…",
      "score": 0.92
    }
  ],
  "latency": { "encode_ms": ..., "retrieve_ms": ..., "e2e_ms": ... }
}
```

错误响应沿用 `server/src/http/errors.ts` 的规范化结构，不返回堆栈：`400`（query 空/超长、top_k 越界）、`503`（编码服务不可用）、`500`（检索失败）。

### §9.2 延迟预算（用 B.8 实测值更新）

| 阶段 | B.7 估算 | **B.8 实测** |
|---|---|---|
| BGE-M3 编码 | ~90 ms | **154.74 ms**（P95 199.67） |
| pgvector 检索 (ef=800) | ~6 ms | **12.09 ms**（P95 35.68） |
| JSON 序列化 | 未实测 | **仍标未实测**（没测过就不填数字） |
| **端到端 P50** | ~120 ms | **168.19 ms**（P95 228.2） |

> B.7 的 ~120 ms 估算**低估了 48 ms**，低估部分全在编码：阶段 2 的 91 ms 是 13 字短句，真实 query 中位 28 字 → 155 ms。**以后做预算请以本轮的中位长度口径为准。**

### §9.3 内部流程

```
query → [BGE-M3 常驻服务] → 1024 维向量
      → [连接池：db-conn-init.sql → ef=800 + strict_order]
      → [pgvector：ORDER BY embedding <=> $1 LIMIT top_k]
      → 序列化 → 响应
```

### §9.4 就绪度

| 组件 | 状态 |
|---|---|
| 连接初始化 SQL | ✅ 已就绪 `db-conn-init.sql`（已验证 800/strict_order） |
| 检索 SQL | ✅ 已验证（100 条 × 召回 / 延迟 / 执行计划全部实测） |
| 编码服务 | ⚠️ 目前是脚本内调用，需要抽成常驻服务 |
| HTTP handler | ❌ 未实现（纯工程任务：Express handler + 上述已验证 SQL） |
| 回归告警 | ✅ 已就绪 `regression-check.py` |

## §10 最终决策

| 项 | 结论 |
|---|---|
| **切换决策** | **HNSW `ef_search=800` + `iterative_scan=strict_order`** —— **CONFIRMED** |
| **紧急程度** | **立即**。EXACT 检索 P50 475.32 ms 已越过 350ms 红线，回归脚本状态 `ALERT`（占用率 126%） |
| **已知代价** | Top10 Δ −9pp（p=0.0117），且不被 iterative_scan 修复改善；Top1 相对天花板 96.1%，无显著差异 |
| **端到端预期** | P50 168.19 ms / P95 228.2 ms（不含序列化，未实测） |
| **下一步** | ①API 实现排期 ②编码服务与 PG 分机部署 ③每周跑回归脚本 |

### §10.1 待你拍板

1. **API 实现**：现在开始 / 排期？（连接初始化与检索 SQL 都已验证，是纯工程任务）
2. **e2e 120ms 目标**：实测 168ms。是调整目标（承认编码 155ms），还是优化编码（换更小模型 / 量化 / GPU）？
3. **部署形态**：编码服务与 PG 是否分机？本机 83% 内存负载下 EXACT 会额外慢 1.7×。
4. **ef=800 的退化风险**：紧邻退化区（ef=400 = FALLBACK），是否现在就把执行计划观测接进监控？

