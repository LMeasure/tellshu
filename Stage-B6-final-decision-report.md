# Stage B.6 最终决策报告

生成时间：2026-10-12 23:49:52　|　矩阵耗时 25.6 分钟　|　**全程只读：未 REINDEX、未改 ef_search 默认值、未改 API / 前端 / PG 参数、未提交 Git**

---

## 0. 三问三答（先给结论）

| 问题 | 结论 |
|---|---|
| **Q1 58k 是否继续 EXACT？** | **是**（只要端到端预算 ≳ 400 ms）。当前端到端 311.9 ms（短 query）/ 398.7 ms（长 query），EXACT Top1 51/100；按实测曲线 400 ms 预算可撑到 78k、500 ms 可撑到 100k chunks。但 ANN 的 Top10 损失是**显著**的（见 Q2），所以在预算内 EXACT 更划算。**预算压到 300 ms 则已越线，必须切**。见 §5 Q1 |
| **Q2 若用 HNSW，ef=?** | **`hnsw.ef_search=800`** —— Top1 与 EXACT 无显著差异（Δ -2pp，McNemar p=0.727），检索 P50 220.7 → 6.3 ms。**但 Top10 仍显著劣化（Δ -9pp，p=0.0117），且 800 紧邻退化悬崖** —— 见 §5 Q2 |
| **Q3 何时切换 ANN？** | 按 500 ms 端到端预算 → **约 100,560 chunks**（当前 58,332）；预算收紧到 300 ms → **55,554 chunks，即现在就该切**。依据 24k / 58k 两个真实规模点实测，不是外推猜测。见 §5 Q3 |

> ⚠️ 三条结论都有一条前置：**今天的生产根本没在正常跑 ANN**（`iterative_scan=off` 导致 7/100 条 query 返回 0 行）。先修这个，再谈 ef。见 §3.1。

## 1. Query 集变化（47 → 100）

| 项 | Stage B.5 | **B.6 / v3** |
|---|---:|---:|
| 分母（过滤开） | 47 | **100** |
| 1 条差异相当于 | 2.1 pp | **1.0 pp** |
| 目标书零章节块被剔除 | 6 | 6 |
| 锚点零跨书污染 | 未强制 | **全部通过** |

分类分布（计入分母的 100 条）：

| 类别 | 条数 |
|---|---:|
| 人物名 | 55 |
| 地点名 | 16 |
| 专有名词 | 7 |
| 关键情节词 | 15 |
| 长文本语义片段 | 7 |

来源：继承 B.5 原文 47 条（**query 文本一字未改**，只重做锚点校验）+ 新增 53 条。其中 49 条锚点因原锚点跨书污染被替换，18 条为补齐「关键情节词 / 长文本语义片段」两类而改型。

指纹校验：全局内容指纹 `770e7c8bbaca404c8418087418d1c632`　|　books 30 / chunks 58,332 / embeddings 58,332 / content_chars 25,625,443 —— 与冻结基线一致。

明细见 `discover-query-set-v3.json` 与 `discover-query-validation-report.md`。

## 2. Query 编码延迟（补齐端到端预算）

| Query | 字符 | p50 | p95 | p99 | avg | RSS 峰值 |
|---|---:|---:|---:|---:|---:|---:|
| 短句 | 13 | **91.15** | 102.47 | 104.11 | 92.14 | 1974.2 MB |
| 长句 | 68 | **177.96** | 204.07 | 209.95 | 173.32 | 1974.8 MB |

样本：warmup 12 次丢弃 + 正式 120 次/条，**batch size = 1**（线上单 query 形态）。ingest 的 187 ms/条与探针的 168 ms/条都是 batch 口径，**不能代表线上单 query，已弃用**。

| 环节 | 短 query | 长 query |
|---|---:|---:|
| 编码 | 91.15 ms | 177.96 ms |
| 库内检索 · EXACT | 220.7 ms | 220.7 ms |
| 库内检索 · HNSW(ef=800) | 6.3 ms | 6.3 ms |
| **端到端 · EXACT** | **311.9 ms** | **398.7 ms** |
| **端到端 · HNSW** | **97.5 ms** | **184.3 ms** |

> ANN 把库内检索从 220.7 ms 压到 6.3 ms（35×），但端到端只从 311.9 ms 降到 97.5 ms（省 69%）—— **编码是端到端的大头，ANN 的收益被它稀释**。

完整记录见 `query_embedding_latency.md`（含 Git Bash 下 `import torch` SIGSEGV 的错误原文与根因更正）。

## 3. 生产 SQL 执行计划（阶段 3）

路径判据：**只认索引名**，不看节点类型 —— `Index Scan` 也可能是 FALLBACK。

| 臂 | SQL 形态 | 使用索引 | 索引名称 | 是否 HNSW | 是否 FALLBACK | P50 ms |
|---|---|---|---|---|---|---:|
| EXACT | PROD_MODEL | 否 | `—` | 否 | 否 | 186.572 |
| EXACT | PROD_NULL | 否 | `—` | 否 | 否 | 205.546 |
| EXACT | EXPERIMENT | 否 | `—` | 否 | 否 | 214.982 |
| DEFAULT | PROD_MODEL | 是 | `discovered_book_chunks_embedding_hnsw_idx, discovered_books_pkey` | 是 | 否 | 0.479 |
| DEFAULT | PROD_NULL | 是 | `discovered_book_chunks_embedding_hnsw_idx, discovered_books_pkey` | 是 | 否 | 0.235 |
| DEFAULT | EXPERIMENT | 是 | `discovered_book_chunks_embedding_hnsw_idx, discovered_books_pkey` | 是 | 否 | 0.233 |
| DEFAULT_RELAXED | PROD_MODEL | 是 | `discovered_book_chunks_embedding_hnsw_idx, discovered_books_pkey` | 是 | 否 | 1.037 |
| DEFAULT_RELAXED | PROD_NULL | 是 | `discovered_book_chunks_embedding_hnsw_idx, discovered_books_pkey` | 是 | 否 | 0.8 |
| DEFAULT_RELAXED | EXPERIMENT | 是 | `discovered_book_chunks_embedding_hnsw_idx, discovered_books_pkey` | 是 | 否 | 0.645 |

**结论一：`embedding_model` 这个过滤谓词不改变执行计划** —— 三种 SQL 形态（PROD_MODEL / PROD_NULL / EXPERIMENT）在 EXACT 臂下都是 Seq Scan，在 DEFAULT 臂下都走同一个 HNSW 索引，没有出现 FALLBACK。阶段 3 的疑问排除。

### 3.1 结论二（更严重）：今天的生产其实没在正常跑 ANN

- 复现今天生产配置的臂（ef=40 + `iterative_scan=off` + `chapter_title IS NOT NULL`）：**7 条 query 返回 0 行、5 条返回不足 10 行**（top_k=10）。其余所有臂这两项均为 0。
- EXACT：返回 10/10 行，P50 186.572 ms，Top1 = Pride and Prejudice
- DEFAULT：返回 2/10 行，P50 0.479 ms，Top1 = The Green Mummy
- DEFAULT_RELAXED：返回 10/10 行，P50 1.037 ms，Top1 = The Green Mummy

> `hnsw.iterative_scan` 的会话默认值是 **off**（本次实测确认）。带上 `chapter_title IS NOT NULL` 过滤时，pgvector 的 HNSW 会**提前收手** —— 这是「饥饿」，不是「召回低」。表现为：**EXACT 与 ANN 的 Top10 零重合**。
> 修法是在事务里 `set_config('hnsw.iterative_scan','relaxed_order',true)`，**这需要改代码，不在本次授权范围内**。

## 4. Stage B.6 矩阵（100 条，只读正式表）

分母 100 条（1 条 = 1.0 pp）　|　top_k = 10　|　每条重复 5 次（第 1 次为冷样本，不计入 P50）　|　除 `-strict` 外所有臂均为 `iterative_scan=relaxed_order`

| 臂 | 实际索引（只认名字） | 路径 | Top1 | Top10 | P50 ms | P95 ms | 判定 |
|---|---|---|---:|---:|---:|---:|---|
| EXACT 基准（禁用索引） | `—（无索引）`×106 | seq_exact×106 | 51/100 (51.0%) | 79/100 (79.0%) | 220.7 | 297.5 | EXACT（召回天花板） |
| 默认计划（ef=40 + relaxed_order） | `discovered_book_chunks_embedding_hnsw_idx`×106 | hnsw_ann×106 | 36/100 (36.0%) | 44/100 (44.0%) | 1.0 | 3.9 | HNSW 近似 |
| HNSW ef=40 | `discovered_book_chunks_embedding_hnsw_idx`×106 | hnsw_ann×106 | 36/100 (36.0%) | 44/100 (44.0%) | 0.8 | 3.6 | HNSW 近似 |
| HNSW ef=40 · iterative_scan=off（= 今天生产） | `discovered_book_chunks_embedding_hnsw_idx`×106 | hnsw_ann×106 | 35/100 (35.0%) | 42/100 (42.0%) | 0.7 | 1.4 | HNSW · 严格扫描（复现今天生产） |
| HNSW ef=80 | `discovered_book_chunks_embedding_hnsw_idx`×106 | hnsw_ann×106 | 40/100 (40.0%) | 49/100 (49.0%) | 1.1 | 3.8 | HNSW 近似 |
| HNSW ef=120 | `discovered_book_chunks_embedding_hnsw_idx`×106 | hnsw_ann×106 | 45/100 (45.0%) | 54/100 (54.0%) | 1.5 | 4.6 | HNSW 近似 |
| HNSW ef=200 | `discovered_book_chunks_book_idx,discovered_books_pkey`×106 | other_index_exact×106 | 51/100 (51.0%) | 79/100 (79.0%) | 518.1 | 545.4 | **FALLBACK（不作 ANN 比较样本）** |
| HNSW ef=400 | `discovered_book_chunks_book_idx,discovered_books_pkey`×106 | other_index_exact×106 | 51/100 (51.0%) | 79/100 (79.0%) | 515.0 | 531.1 | **FALLBACK（不作 ANN 比较样本）** |
| HNSW ef=800 | `discovered_book_chunks_embedding_hnsw_idx`×106 | hnsw_ann×106 | 49/100 (49.0%) | 70/100 (70.0%) | 6.3 | 9.3 | HNSW 近似 |

### 4.1 退化区：ef=200 / 400 根本没走 HNSW

| 臂 | 实际索引 | 路径 | P50 ms | 与 EXACT 比较 |
|---|---|---|---:|---|
| HNSW ef=200 | `discovered_book_chunks_book_idx,discovered_books_pkey`×106 | other_index_exact×106 | **518.1** | 召回等同 EXACT（51/100）但**慢 2.3×** |
| HNSW ef=400 | `discovered_book_chunks_book_idx,discovered_books_pkey`×106 | other_index_exact×106 | **515.0** | 召回等同 EXACT（51/100）但**慢 2.3×** |

> ef=200/400 时优化器放弃 HNSW，改用 `discovered_book_chunks_book_idx` 做全量排序：`Sort` + `Limit`，实测 **373,631 buffers、513 ms**。它给出与 EXACT 完全相同的召回（因为它就是变相精确），**却比 EXACT 还慢一倍**。
> **按阶段 4 的要求：这两条单独分类，禁止写入 ANN 最优结果。**
> 注意 ef=800 **又跳回了 HNSW** —— 退化区是「一段区间」（约 160~400），不是「过了某个值就永久退化」。这本身就是一个稳定性警告。

### 4.2 与 EXACT 的配对差异（McNemar 精确检验）

不用「1 条 = 1 pp」这种名义门槛判显著性，直接做配对检验。
不一致对记为 `EXACT命中/该臂命中`：

| 臂 | ΔTop1 | 不一致对 | p(Top1) | 判定 | ΔTop10 | 不一致对 | p(Top10) | 判定 |
|---|---:|---|---|---|---:|---|---|---|
| 默认计划（ef=40 + relaxed_order） | -15pp | 24/9 | 0.0135 | 显著劣化 | -35pp | 36/1 | 0.0000 | **显著劣化** |
| HNSW ef=40 | -15pp | 24/9 | 0.0135 | 显著劣化 | -35pp | 36/1 | 0.0000 | **显著劣化** |
| HNSW ef=40 · iterative_scan=off（= 今天生产） | -16pp | 24/8 | 0.0070 | **显著劣化** | -37pp | 37/0 | 0.0000 | **显著劣化** |
| HNSW ef=80 | -11pp | 19/8 | 0.0522 | 边缘 | -30pp | 32/2 | 0.0000 | **显著劣化** |
| HNSW ef=120 | -6pp | 14/8 | 0.2863 | 无显著差异 | -25pp | 26/1 | 0.0000 | **显著劣化** |
| HNSW ef=200（FALLBACK，不参与） | +0pp | 0/0 | 1.0000 | 无显著差异 | +0pp | 0/0 | 1.0000 | 无显著差异 |
| HNSW ef=400（FALLBACK，不参与） | +0pp | 0/0 | 1.0000 | 无显著差异 | +0pp | 0/0 | 1.0000 | 无显著差异 |
| HNSW ef=800 | -2pp | 5/3 | 0.7266 | 无显著差异 | -9pp | 10/1 | 0.0117 | 显著劣化 |

## 5. 三个问题的回答

### Q1：58k chunks 是否继续 EXACT？

- EXACT：Top1 51/100（51.0%）、Top10 79/100（79.0%）、检索 P50 **220.7 ms**
- 最好的真实 ANN（ef=800）：Top1 49.0%、Top10 70.0%、检索 P50 6.3 ms

**回答：是，继续 EXACT —— 条件是端到端预算 ≳ 400 ms。**

1. 端到端 311.9 ms（短）/ 398.7 ms（长）。按实测曲线，400 ms 预算能撑到 78,057 chunks、500 ms 预算能撑到 100,560 chunks，都还在 58,332 之上。
2. 换 ANN 只能省检索时间，端到端降到 97.5 ms，**代价是 Top10 显著劣化（Δ -9pp，p=0.0117）** —— 在 58k 这个规模上，这个代价比 220 ms 更贵。
3. 还叠加一个稳定性代价：唯一能把 Top1 拉平的 ef（800）紧邻退化悬崖，ef=400 直接退化成 518 ms。

反过来：**如果端到端预算是 300 ms，答案就是「不」** —— 长 query 已经 398.7 ms，越线了，此时必须切 ANN 并接受 Top10 损失。

### Q2：如果用 HNSW，ef_search 推荐多少？

三个判据逐条过：

| ef | 是否真 HNSW | 召回损失（Top1） | 召回损失（Top10） | 延迟收益 | 稳定性 | 综合 |
|---:|---|---|---|---|---|---|
| 40 | ✅ | -15pp（p=0.014，显著劣化） | -35pp（p=0.0000，**显著劣化**） | 276× | ✅ 安全区 | 不可用 |
| 80 | ✅ | -11pp（p=0.052，边缘） | -30pp（p=0.0000，**显著劣化**） | 201× | ✅ 安全区 | 边缘可用 |
| 120 | ✅ | -6pp（p=0.286，无显著差异） | -25pp（p=0.0000，**显著劣化**） | 147× | ✅ 安全区 | **可用** |
| 200 | ❌ FALLBACK | — | — | **慢 2.3×** | ❌ | **排除** |
| 400 | ❌ FALLBACK | — | — | **慢 2.3×** | ❌ | **排除** |
| 800 | ✅ | -2pp（p=0.727，无显著差异） | -9pp（p=0.0117，显著劣化） | 35× | ⚠ 紧邻退化区 | **可用** |

**回答：`hnsw.ef_search = 800`**

- **召回损失**：Top1 Δ -2pp，McNemar p=0.727 —— 与 EXACT **无显著差异**；但 Top10 Δ -9pp，p=0.0117 —— **仍显著劣化**。
- **延迟收益**：220.7 → 6.3 ms（35×），端到端 311.9 → 97.5 ms。
- **稳定性**：⚠ **这是最大的坑**。ef=200/400 会退化成 `book_idx` + `Sort`（518 ms，比 EXACT 还慢一倍）。800 目前没退化，但它就在悬崖边上 —— 数据量一变、统计信息一刷新，计划就可能翻过去。

**因此推荐必须带两个前置条件**：①先修 `iterative_scan`（§3.1）；②上线后对检索计划做观测（记录 `Index Name`），一旦出现非 HNSW 索引立刻告警。
如果接受不了这两条，就退到 ef=120（安全区、P50 1.5 ms、Top1 Δ -6pp 无显著差异），代价是 Top10 Δ -25pp。

### Q3：什么时候切换 ANN？

**先说方法**：Q3 要求不许凭经验，必须依据两条延迟曲线 + 编码延迟。但 Stage B.5 与 B.6 跑的是同一份 58,332 chunks —— EXACT 只有一个规模点，一个点无法外推。

**走过的弯路（留作证据）**：先试了 `TABLESAMPLE SYSTEM (%)` 抽样，让 Seq Scan 只扫随机页，等价于「表变小」。实测结果是 **75% 抽样 477 ms > 100% 全量 262 ms** —— 抽样引入了随机 I/O 偏差，不能当作规模缩小的代理，**方案废弃**（原始数据在 `server/.crawl-cache/_exact-latency-curve.json`）。

**最终方案**：用库内已有的**第二张同构真实表**做第二个规模点，不抽样、不合成、不新建数据。

| 表 | 行数 | 表大小 | 单均行大小 | 角色 |
|---|---:|---:|---:|---|
| `discovered_book_chunks_exp` | 24,244 | 333 MB | 14408.6 B | 小规模真实表 |
| `discovered_book_chunks` | 58,332 | 808 MB | 14531.9 B | 正式表 |

单均行大小 14.1 / 14.2 KB（相差 0.8%）→ 结构同构，是真实的「规模减半」样本。（`_exp` 表还自带 HNSW 索引 `exp_hnsw_idx`，所以 HNSW 也一并拿到第二个规模点。）

| 环节 | 24,244 chunks | 58,332 chunks | 斜率（ms / 1000 chunks） |
|---|---:|---:|---:|
| EXACT 检索 | **69.72** ms | **221.2** ms | 4.4438 |
| 　其中：纯扫描 I/O（不做距离计算） | 1.88 ms | 15.0 ms | 0.3849 |
| HNSW ef=40 | 0.92 ms | 1.55 ms | 0.0185 |
| HNSW ef=120 | 1.47 ms | 3.12 ms | 0.0484 |
| HNSW ef=800 | 5.51 ms | 8.44 ms | 0.086 |

**一个关键事实**：EXACT 在 58k 处是 221 ms，其中纯扫描 I/O 只有 15 ms（**7%**），剩下 206 ms 全是 1024 维余弦距离计算 —— **EXACT 是 CPU 瓶颈，不是 I/O 瓶颈**。CPU 部分随行数线性增长，这正是外推能成立的原因。

代入端到端预算（编码是固定成本，与规模无关）：

```
EXACT 检索 (ms) ≈ -38.02 + 4.4438 × (chunks / 1000)      ← 两点实测，R² 无意义（两点定线）
切换阈值  N* = (预算 − 编码延迟 + 38.02) / 4.4438 × 1000
```

| 端到端预算 | 短 query 检索预算 | 长 query 检索预算 | EXACT 撑到的规模（短 / 长 query） |
|---:|---:|---:|---:|
| 300 ms | 209 ms | 122 ms | **55,554** / 36,019 chunks ← 当前 58,332 已在此之上 |
| 400 ms | 309 ms | 222 ms | **78,057** / 58,522 chunks |
| 500 ms | 409 ms | 322 ms | **100,560** / 81,025 chunks |
| 800 ms | 709 ms | 622 ms | **168,070** / 148,535 chunks |
| 1000 ms | 909 ms | 822 ms | **213,077** / 193,542 chunks |

**HNSW 那一侧也有实测曲线了**：ef=800 的斜率只有 0.086 ms/1k chunks（对比 EXACT 的 4.4438）—— EXACT 的增长速度是它的 52 倍。按曲线算，到 100,560 chunks 时 HNSW(ef=800) 仍只有 12.1 ms，而 EXACT 已经 409 ms。

**回答（写成可推导的式子，不是一个拍脑袋的数）**：

| 端到端预算 | 切换阈值 | 当前 58,332 是否已越线 |
|---:|---:|---|
| 300 ms（短 query） | **55,554 chunks** | **已越线，现在就该切** |
| 400 ms（短 query） | **78,057 chunks** | 未越线，继续 EXACT |
| 500 ms（短 query） | **100,560 chunks** | 未越线，继续 EXACT |
| 800 ms（短 query） | **168,070 chunks** | 未越线，继续 EXACT |

两条硬约束：①**切换前必须先修 `hnsw.iterative_scan`**，否则只是把「慢」换成「饿」（今天已经有 7/100 条返回 0 行）；②阈值到手也不等于立刻切，还要确认 Top10 的显著损失是否可接受（见 Q2）。

## 6. 推荐策略

| 优先级 | 动作 | 是否需要授权 |
|---|---|---|
| **P0** | 修 `iterative_scan`：检索事务内 `set_config('hnsw.iterative_scan','relaxed_order',true)` | ✅ 要改代码 |
| P1 | 维持 EXACT（58k 规模、500 ms 预算下） | ❌ 现状即可 |
| P2 | 上线检索计划观测：记录每次检索的 `Index Name`，非 HNSW 立即告警 | ✅ 要改代码 |
| P3 | 若预算收紧到 300 ms：切 ANN 并设 `hnsw.ef_search=800`，接受 Top10 显著损失 | ✅ 要改配置 |
| — | ❌ 不要选 ef=200 / 400 | 退化成全量排序，比 EXACT 慢一倍 |

## 7. 风险

| 风险 | 证据 | 处置 |
|---|---|---|
| **今天生产在饥饿状态** | §3.1：7/100 条返回 0 行、5 条返回不足 | 事务内设 `iterative_scan=relaxed_order`，**要改代码，待授权** |
| **优化器会静默切 FALLBACK** | §4.1：ef=200/400 走 `book_idx`+`Sort`，518 ms | 避开 160~400 区间；上线后加 plan 观测 |
| **推荐 ef 紧邻悬崖** | 800 是 HNSW，但 400 就是 FALLBACK | 观测 + 保留回退到 EXACT 的开关 |
| **ANN 的 Top10 损失是真实的** | §4.2：所有 ef 的 Top10 均显著劣化（ef=800 p=0.0117） | 若产品依赖候选列表完整性，不要切 |
| 曲线只有两个规模点 | 24k / 58k，两点定线，无法评估残差 | 下次扩书到 ~100k 时复测一次，修正斜率 |
| 编码服务是单点 | RSS 峰值 ~1.97 GB，不可按请求拉起 | 常驻进程 + 健康检查 |
| 分母 100 条仍偏小 | 1 条 = 1.0 pp；McNemar 在 100 样本下功效有限 | 结论以「统计不显著 ≠ 无差异」表述 |

## 8. 本次做了什么 / 没做什么

**做了（全部只读）**：

- Query 集 47 → 100 条，逐条用 `content ILIKE` 验证锚点（目标书第一、跨书 0 命中）
- 实测单 query 编码延迟（batch size=1，warmup 12 + 正式 120）
- 验证生产 SQL 在三种形态下的执行计划，并挖出「今天生产在饥饿」
- 跑完 9 臂 × 2 口径的 B.6 矩阵（100 条 × 5 次）
- 补测 24k / 58k 两个真实规模点的 EXACT 与 HNSW 延迟曲线

**没做（等授权）**：

- 未 REINDEX 正式索引（仍 `discovered_book_chunks_embedding_hnsw_idx` 456 MB）
- 未改 `hnsw.ef_search` 默认值（仍 40）、未改 `hnsw.iterative_scan`（仍 off）
- 未改 `postgresql.conf`、未改 API 检索 SQL、未改前端发现页、未提交 Git（HEAD 未变）

**下一步授权点**：

1. 是否允许在检索事务里加 `set_config('hnsw.iterative_scan','relaxed_order',true)`？（这是 P0，不修的话后面所有 ef 调优都是在饥饿状态下做的）
2. 是否按 Q2 推荐固定 `hnsw.ef_search=800`，并接受 Top10 的显著损失？
3. 是否加检索执行计划观测（记录 `Index Name`）？
4. 「发现书籍」目前**没有 HTTP API**，所有结论只影响未来实现。是否开始建 API？
5. 本轮新增脚本 / JSON / 报告是否纳入 Git？当前 HEAD 未变，等你确认。

