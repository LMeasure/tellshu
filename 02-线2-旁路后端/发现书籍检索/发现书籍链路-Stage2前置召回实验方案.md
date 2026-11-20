# 发现书籍链路 · Stage 2 前置召回实验方案

- 日期：2026-10-09
- 性质：**方案文档，不含任何已执行的数据变更**。本阶段不进入正式 Stage 2，不开发 API，不改前端。
- 前置：已确认《发现书籍链路-Stage1.5-检索质量修正报告》。
- 目标：在 30–50 本规模上，把「精确检索质量 / ANN 召回率 / 端到端命中率 / 延迟」四个指标分开测量，定出可放行的检索与索引参数；若 HNSW 在该规模仍不稳定，**停止调参并如实报告**。

---

## 0. 状态冻结声明（本节为已执行的事实核对，不是计划）

| 对象 | 当前状态 | 本阶段处置 |
|---|---|---|
| 10 本书 / 24,244 chunk / 24,244 embedding | recipe 全为 `v2-title-author-chapter`，1024 维，范数正常 | **冻结**，不重抓、不重算 |
| `discovered_book_chunks_emb_v1` | 24,244 行，1024 维，24,244 条非空；临时 HNSW 索引已清理，仅剩 btree | **保留**，不得删除或覆盖 |
| `sql/001_init.sql`、`sql/002_discover.sql`、`migrate.ts` | 已验证幂等 | **不改** |
| 主表 HNSW 索引 | `discovered_book_chunks_embedding_hnsw_idx`，189 MB（已 REINDEX） | 实验期可重建，方案见第 5 节 |
| `chapter_title IS NULL` 块 | 7,203 个 | **保留**，只做 query-time filter |
| 前端 `src/` | 最近改动 2026-10-09 01:08（阅读器 V3.0，上一轮已交付） | **未触碰** |

---

## 1. 实验设计与样本选择方法

### 1.1 规模：30 本起步，50 本封顶，分两批

| 批次 | 累计通过本数 | 触发条件 |
|---|---|---|
| 现状 | 10 | 已存在 |
| 批次 A | 10 → **30** | 需你先确认 |
| 批次 B | 30 → **50** | 仅当批次 A 结论不足以定参数时才申请，**需再次确认** |

**不自动扩量。** 每批抓取前我会给出拟抓取的候选清单（书名 / source_id / 作者卒年 / rights），你点头才执行。

### 1.2 样本选择方法

- 来源沿用已确认的 **Project Gutenberg**，入口 `https://www.gutenberg.org/browse/scores/top`（`crawl-books.ts` 中 `LIST_URL`）。
- 沿用 `--limit` 语义：脚本会持续扫描候选直到凑够通过数，因此 `--limit 30` 会自动扫到约 50 本候选（Stage 1 实测通过率 10/17 ≈ 59%）。
- **跳过已入库的 10 本**（按 `source_id` 去重），不重复抓取。
- 不做任何"挑书"：完全按榜单顺序取，避免人为构造对检索友好的样本集。

### 1.3 版权口径（沿用口径 A，不得自动放行）

一本书只有全部满足才入库：
1. `language = 'en'`；
2. RDF 中**每位**作者/贡献者都能解析出可靠卒年（`<pgterms:deathdate>`）；
3. 所有卒年最大值 ≤ **1975**；
4. 缺卒年、卒年解析失败、语言不符 → **记入失败清单并跳过**，不推断、不放行。

> 已知案例：Stage 1 中 65238（阿加莎，卒 1976 > 1975）与 62215（`language=fr`）被此口径拦截。
> **中国口径提醒**：`<dcterms:rights>` 的「Public domain in the USA」在中国不自动成立（中国为 life+50），阿加莎在中国保护至 2026-12-31。口径 A 的 1975 阈值对中美双清仍偏保守，实验阶段**继续沿用不放宽**。

### 1.4 规模与资源预估（按现状外推，仅供排期参考）

| 项 | 现状 10 本 | 30 本（预估） | 50 本（预估） |
|---|---:|---:|---:|
| chunk 数 | 24,244 | ~73,000 | ~121,000 |
| embedding 耗时 | 35–45 min | ~110–130 min | ~180–220 min |
| HNSW 索引大小 | 189 MB | ~570 MB | ~940 MB |
| 单索引构建 | 36 s | ~2 min | ~3 min |
| 抓取请求数 | — | ~150（≤30 req/min，约 6–10 min） | ~250 |

**内存风险（必须先说）**：本机物理内存 15.2 GB，**当前可用仅 3.0 GB**；`shared_buffers=128 MB`、`effective_cache_size=4 GB`。30–50 本规模的索引（570–940 MB）已远超 `shared_buffers`，查询延迟会显著受 OS cache 命中率影响。**延迟数据必须标明冷热状态**，否则不可比。

---

## 2. Query 验收表

### 2.1 第一类：保留原有 6 条固定 Query（原文不动）

来自 `server/src/scripts/discover-queries-stage1.txt`，用于与 Stage 1 / Stage 1.5 严格对齐：

| # | Query | 期望命中 | Stage 1.5 实测（v2+过滤+ef=100） |
|---|---|---|---|
| Q1 | 拉斯柯尔尼科夫为了证明自己的理论而杀人，之后饱受良心折磨 | Crime and Punishment | ✅ 0.5861 |
| Q2 | 一个家庭教师被雇去照顾一个孩子，住在阴森的大宅里 | Jane Eyre | ✅ 0.5518 |
| Q3 | 关于爱情与阶级的英文小说 | Pride and Prejudice | ✅ 0.5576 |
| Q4 | Odysseus returns home and takes revenge on the suitors | The Odyssey | ✅ 0.5846 |
| Q5 | two young lovers from feuding families die tragically | Romeo and Juliet | ✅ 0.5495 |
| Q6 | a governess hired to teach a girl at a gloomy mansion called Thornfield | Jane Eyre | ✅ 0.5572 |

> 注意：扩到 30–50 本后，这 6 条的期望书籍仍在库中，但**竞争书籍变多**，命中难度上升。它们的作用是对齐历史，不代表扩量后的目标难度。

### 2.2 第二类：新增 Query（覆盖 5 类场景）

**依据来源说明**：下表的「依据」全部来自**本次对库内正文的只读检索实测**（`content ILIKE` 的书籍分布），不是凭印象编造。

已核实的锚点分布（块数 = 含该词的 chunk 数）：

| 锚点词 | 分布（块数） | 唯一性 |
|---|---|---|
| `Thornfield` | Jane Eyre 108 | 唯一 |
| `Lowood` | Jane Eyre 66 | 唯一 |
| `Raskolnikov` | Crime and Punishment 784 | 唯一 |
| `Sonia` | Crime and Punishment 346 | 唯一 |
| `Sweeney Todd` | The String of Pearls 525 | 唯一 |
| `Udolpho` | The Mysteries of Udolpho 70 | 唯一 |
| `Pemberley` | Pride and Prejudice 65 | 唯一 |
| `Cecil` | A Room with a View 236 | 唯一 |
| `Florence` | A Room with a View 63（+Jane Eyre 2、Udolpho 2 噪声） | 主导 |
| `Ithaca` | The Odyssey 129 | 唯一 |
| `Verona` | Romeo and Juliet 14（+Udolpho 1 噪声） | 主导 |
| `Escamillo` | **0（全库无命中）** | — |

> `Escamillo` 零命中是个必要提醒：**不能想当然地用人名当依据**。原计划用「Carmen 的斗牛士 Escamillo」做锚点，实测落空，故该条不纳入。这条规则写入第 2.4 节。

#### 新增 Query 草案（8 条）

| # | 类别 | Query（草案） | 预期命中 | 依据 |
|---|---|---|---|---|
| N1 | 中文抽象描述 | 一个孤儿女孩在慈善学校忍饥挨冻，后来到一座大宅里做家庭教师 | Jane Eyre | `Lowood` 66 + `Thornfield` 108 均唯一落在 Jane Eyre；且 Stage 1.5 Q2/Q6 已实测命中 |
| N2 | 中文抽象描述 | 一位孤女被亲戚囚禁在阴森的古堡里，接连遭遇恐怖事件 | The Mysteries of Udolpho | `Udolpho` 70 块唯一 |
| N3 | 中文专有名词 | 斯威尼·托德在舰队街的理发店里接待客人 | The String of Pearls | `Sweeney Todd` 525 块唯一 |
| N4 | 中文专有名词 | 拉斯柯尔尼科夫向索尼娅坦白自己杀了人 | Crime and Punishment | `Raskolnikov` 784 + `Sonia` 346 均唯一 |
| N5 | 英文抽象描述 | a young Englishwoman travels to Italy and must choose between propriety and her own heart | A Room with a View | `Cecil` 236、`Florence` 63 均主导落在该书 |
| N6 | 英文抽象描述 | a man returns after many years to find his home occupied by those who presume him dead | The Odyssey | `Ithaca` 129 块唯一 |
| N7 | 英文专有名词 | Mr Darcy and the grand estate of Pemberley | Pride and Prejudice | `Pemberley` 65 块唯一 |
| N8 | 英文专有名词 | a masked ball in Verona where two young people first meet | Romeo and Juliet | `Verona` 14 块主导（含 1 块 Udolpho 噪声，允许） |

#### front matter 探针（2 条，验收的是行为不是书籍）

| # | 类别 | Query（草案） | 验收点 | 依据 |
|---|---|---|---|---|
| F1 | front matter 干扰 | This eBook is for the use of anyone anywhere at no cost and with almost no restrictions | **开启过滤时，Top-K 中不得出现 `chapter_title IS NULL` 的块**；关闭过滤时允许出现 | 实测 `Gutenberg` 一词在库内确有 1 块（String of Pearls），证明此类块真实存在 |
| F2 | 过滤充分性 | 一条极窄 Query（如仅含罕见短语） | **不得静默返回 0 行**；必须与精确检索对照，区分「真实无匹配」与「近似过滤导致不足」（判定方法见 4.4） | — |

### 2.3 新增 Query 在扩量后的处理规则

新增的 20–40 本书在抓取前无法预知内容，因此：

1. 批次 A 抓取完成后，**先不跑评测**；
2. 用与 2.2 节相同的方法（只读检索锚点词分布）为**新书**补充 2–4 条锚定 Query，每条必须附"锚点词 + 命中块数 + 唯一性"证据；
3. 若某条找不到可验证锚点 → **不纳入**，不计入分母；
4. 只有证据齐了才开始评测。

### 2.4 硬性规则（防止编造）

- 任何 Query 的"预期命中"必须有可复现的 SQL/检索证据支撑；
- 无证据的 Query 不得进入验收集；
- 不得因"某条总是错"而事后修改期望书籍（如确属标注错误，须单独记录并说明理由，保留原记录）。

---

## 3. HNSW 参数实验矩阵

分三阶段，**后一阶段的输入来自前一阶段结论**，不做全组合穷举。

### 阶段 A：查询参数（不动索引）

索引固定为当前 `m=16, ef_construction=64`。

| 变量 | 取值 |
|---|---|
| `ef_search` | 40 / 60 / 100 / 200 / 400 / 800 |
| `hnsw.iterative_scan` | off / relaxed_order |
| 过滤 | 开（`chapter_title IS NOT NULL`）/ 关 |
| `top_k` | 1 / 3 / 5 / 10 |

组合数：6 × 2 × 2 = 24 组 × 16 条 Query × top_k 10 = 可测。
**明确不预设"参数越大越好"**：Stage 1.5 已观测到 ef=800 比 ef=200 差、ef=1000 比 ef=400 差的反常，本阶段正是要定位该现象。

### 阶段 B：建索引参数（重建索引）

取阶段 A 中表现最好的 2 组查询参数，对下列 9 个索引各测一遍：

| `m` | `ef_construction` | 备注 |
|---|---|---|
| 8 | 64 | 最小图 |
| 8 | 128 | |
| 16 | 64 | **当前现状（基线）** |
| 16 | 128 | |
| 16 | 256 | |
| 32 | 64 | |
| 32 | 128 | |
| 32 | 256 | 最大图 |
| 16 | 64 | 重建一次的重复项，用于测构建随机性 |

记录每个索引的：构建耗时、索引大小、`EXPLAIN (ANALYZE, BUFFERS)` 的实际计划、召回指标。

### 阶段 C：整批重写向量后的重建流程

1. 记录当前（重写前）的召回基线；
2. 执行一次全表 embedding 重写（模拟 Stage 2 实际运维）；
3. 立即测召回 → 预期出现退化（Stage 1.5 实测：索引 189 MB → 247 MB 膨胀，召回变差）；
4. 执行 `REINDEX` → 再测召回，确认恢复；
5. 输出「重写后必须 REINDEX」的量化证据与耗时。

### 阶段 D（可选，仅在 A–C 通过后）

在 50 本规模上复测阶段 A 的优选取，验证参数是否随规模变化。

---

## 4. 验收标准

四个指标**分开记录，不合并**。

### 4.0 指标口径定义（分母 / K 值 / 查询集 / 统计方式 / 冷热）

> 本节只定义「怎么算」，不含任何门槛数字。门槛在 4.2，且**均为待验证建议值**。

**查询集与分母（全局唯一口径）**

| 集合 | 条数 | 是否计入命中率分母 | 说明 |
|---|---:|---|---|
| Stage 1 固定 Query（A-1~A-3 / B-1~B-3） | 6 | ✅ 计入 | 原文不动，用于与 Stage 1 / 1.5 直接比较 |
| 新增定向 Query（N1–N8） | 8 | ✅ 计入 | 每条附锚点词 + 命中块数 + 唯一性证据（§2.2） |
| front matter 探针（F1 / F2） | 2 | ❌ **不计入** | F1 验收「开启过滤时不得出现无章节块」，F2 验收「不得静默返回 0 行」，验的是行为不是书籍 |
| **命中率分母合计** | **14** | | 扩量后按 §2.3 补锚定 Query，找不到可验证锚点的新 Query 不纳入、不计入分母 |

若某条 Query 在扩量后因新书涌入而失去唯一性（例如同一情节出现在两本书），**保留原记录并单独说明**，不修改期望书籍。

**各指标口径**

| 指标 | 分母 | K 值 | 统计方式 |
|---|---|---|---|
| 端到端 Top1 命中率 | 14 条定向 Query | K = 1 | 分子 = Top1 命中期望书籍的条数；命中判定按**书名**匹配（忽略大小写与副标题差异），**不**放宽到同作者的其他书。每组参数独立统计，不跨组平均 |
| 端到端 Top3 / Top5 命中率 | 14 条 | K = 3 / 5 | 期望书籍出现在 Top-K 任意位置即计命中（同一本书多个 chunk 占位不影响，出现一次就算） |
| 精确检索质量 | 14 条 | K = 1 / 3 / 5 | 禁用索引（`enable_indexscan/bitmapscan/indexonlyscan=off`）下统计，作为能力上限参考，**不用于判定 ANN 是否达标** |
| ANN vs 精确 Top-K 重合率 | 14 条 | **K = 10（固定）** | 按 **chunk 粒度**（`book_id` + `chunk_index`）比对，不按书名。重合率 = `|ANN(K) ∩ Exact(K)| / min(|Exact(K)|, K)`；`|Exact| < K`（真实匹配不足）时按 `min` 作分母并标注。逐条计算后取算术平均，作为该组参数的重合率 |
| 静默空结果 | 14 条 × 参数组数 | — | 每条 Query × 每组参数都要判一次（判定表见 4.4），**不抽检** |
| 延迟 P50 / P95 / max | 见下 | — | 见下 |
| 稳定性 | 14 条 × 参数组数 | K 同该组设定 | 5 次重复的 Top-K（`book_id` + `chunk_index` + `score`）逐项一致，score 容差 1e-6 |

**延迟与冷热状态**

- **样本量**：每条 Query 重复 **5 次**；以「参数组」为单位汇总，热样本 = 14 × 4 = **56 个**。
- **冷样本**：每组参数的**首条 Query 的第 1 次**执行（OS / DB 缓存未预热）→ **单列报告，不进 P50/P95**。
- **计时口径**：Python 侧 wall clock（含往返与反序列化）为准；同时记录 `EXPLAIN (ANALYZE)` 的 `Execution Time` 作为服务端内部耗时，两者都写进报告，差异大时如实说明。
- **冷热判定证据**：附每组 `EXPLAIN (ANALYZE, BUFFERS)` 的 `Buffers: shared hit=… read=…` —— **`read > 0` 即含冷读**，必须在报告中标注。
- ❗ 本机 `shared_buffers=128MB`、可用内存约 3.0GB，30–50 本索引（570–940MB）**远超缓存**，因此冷/热延迟差距会被放大；跨组比较必须在**同一冷热状态**下进行。

### 4.1 指标定义

| 指标 | 定义 |
|---|---|
| **精确检索质量** | 禁用索引（`enable_indexscan/bitmapscan/indexonlyscan=off`）下的 Top1/Top3/Top5 命中率。**代表 embedding + 语料的能力上限** |
| **ANN 召回率** | HNSW Top-K 结果集合与精确检索 Top-K 结果集合的**重合率**（如 Top10 重合 8 个 = 80%），以及「精确检索里排第 1 的书，在 ANN Top-K 中是否出现」 |
| **端到端命中率** | 用户视角：Top1 / Top3 / Top5 中是否出现期望书籍 |
| **延迟** | P50 / P95 / 最大值 |

### 4.2 放行门槛（建议值，需你确认）

> ⚠️ **本节所有数字均为「待验证的建议门槛」，不是已验证标准。**
> 截至目前（Stage 1.5 结束、10 本 / 24,244 chunk），**一次都未在 30–50 本规模上跑过**，
> 唯一相关的实测只有：24k 规模下 v2 + 过滤 + HNSW ef=100 = 6/6（6 条固定 Query）。
> 这些门槛要先在阶段 A 跑出来，才知道定得高还是低。口径（分母 / K / 冷热）一律以 **§4.0** 为准。

在 30–50 本规模、**14 条定向 Query**（§4.0）上：

| 指标 | 门槛 | 口径 |
|---|---|---|
| 端到端 Top1 命中率 | **≥ 80%** | 分母 14，K=1（§4.0） |
| 端到端 Top3 命中率 | **≥ 90%** | 分母 14，K=3（§4.0） |
| 精确检索 Top1 命中率 | **≥ 90%**（若达不到，说明问题在 embedding/语料而非 ANN，应停下去查前者） | 分母 14，禁用索引 |
| ANN vs 精确 Top10 重合率 | **≥ 80%** | 分母 14，K=10，chunk 粒度 |
| 静默空结果 | **0 次**（见 4.4） | 分母 = 14 × 参数组数，不抽检 |
| P95 延迟 | **≤ 300 ms**（30 本）/ **≤ 500 ms**（50 本） | 只从热样本算，冷样本单列（§4.0） |
| 稳定性 | 同 Query 重复 5 次，Top-K 顺序**完全一致**；索引 REINDEX 后复测一致 | 分母 14 × 参数组数 |

**门槛本身也接受检验**：若阶段 A 实测显示 80%/90% 明显偏高或偏低，我会带着数据回来改门槛，而不是改数据去凑门槛。

### 4.3 延迟记录规范

每条查询重复 **5 次**，记录 P50 / P95 / 最大。每次实验必须同时记录：

- 查询条数、`top_k`、过滤开关
- 数据库：`shared_buffers=128MB`、`work_mem=4MB`、`maintenance_work_mem=64MB`、`effective_cache_size=4GB`、`max_parallel_maintenance_workers=2`、pgvector **0.8.6**、PostgreSQL **18.6** (x86_64-windows)
- 硬件：Windows 11 (10.0.26200)、AMD64 Family 26 Model 68、**32 逻辑核心**、物理内存 **15.2 GB（可用 3.0 GB）**、C 盘可用 140 GB
- **冷热状态**：首轮为冷（OS cache 未预热），第 2–5 次为热，两者分开报

### 4.4 过滤：禁止静默空结果

每条 Query 同时跑两遍：

1. ANN（带过滤）→ 得到行数 `n_ann`；
2. 精确（同过滤条件）→ 得到行数 `n_exact`。

判定：

| 情形 | 结论 |
|---|---|
| `n_exact = 0` 且 `n_ann = 0` | **真实无匹配**，正常 |
| `n_exact > 0` 且 `n_ann = 0` | **近似索引过滤导致结果不足**，判为失败，必须修（迭代扫描 / 提高 ef / 改过滤策略） |
| `0 < n_ann < top_k` 且 `n_exact ≥ top_k` | 结果不足，记录并分析 |

此判定对**每条 Query、每组参数**都执行，不抽检。

### 4.5 稳定性

- 同 Query 重复 5 次，Top-K（书名 + chunk_id + score）必须逐项一致（浮点允许 1e-6 误差）；
- 阶段 B 每个索引 `REINDEX` 后再测一遍，比较重建前后结果；
- 出现任何不一致 → 记录为「不稳定」，该组参数不得放行。

### 4.6 停止条件（不达标就停）

若阶段 A–C 全部跑完，HNSW 在 30–50 本规模仍无法达到 4.2 的门槛：

1. **停止调参**，不再试新参数组合；
2. **不自行扩大数据量**；
3. 输出报告：给出实测矩阵、失败模式分类、以及可选替代方案（如：按语种/主题分区建索引、改用 IVFFlat、或在当前规模直接走精确检索并给出其延迟上限）；
4. 等你的决策。

---

## 5. 数据库与索引回滚方案

### 5.1 实验前的保护动作（需你确认后执行）

| 对象 | 保护措施 |
|---|---|
| 主表 `discovered_book_chunks` | `CREATE TABLE ... AS SELECT` 全量快照到 `discovered_book_chunks_snap_exp`（不进 migration） |
| `discovered_books` | 同上快照 |
| `discovered_book_chunks_emb_v1` | **只读保留**，实验全程不写、不删、不覆盖 |
| 迁移文件 | 不改；实验期的临时表/索引一律用一次性脚本管理，不写进 `sql/` |

### 5.2 索引回滚

- 实验期所有索引变更都在**同一张表**上做 `DROP INDEX` / `CREATE INDEX` / `REINDEX`；
- 任一索引构建失败 → 立即 `DROP INDEX`，重建回基线参数（`m=16, ef_construction=64`），并跑一次 Stage 1.5 的 6 条 Query 确认回到 6/6；
- 现状索引 189 MB、重建约 36 s @24k，回滚成本极低。

### 5.3 数据回滚

- 抓取与 ingest 全部幂等（唯一键 `(book_id, chunk_index)`、`(source_site, source_id)`），新增书失败不会污染已有 10 本；
- 若需撤销批次 A：`DELETE FROM discovered_book_chunks WHERE book_id IN (...)` + `DELETE FROM discovered_books WHERE source_id IN (...)`（按 manifest 里的 source_id 清单），已有 10 本不动；
- 极端情况：用 5.1 的快照表整表恢复。

### 5.4 回退触发条件

出现下列任一情况立即停止并回滚：

- 已有 10 本的 chunk 数或 embedding 数发生变化；
- `discovered_book_chunks_emb_v1` 行数变化；
- 迁移被修改或 `db:migrate` 结果不一致；
- 抓取过程中出现版权证据缺失却被放行。

---

## 6. 必须验证的技术问题（逐条对应）

| # | 要求 | 本方案对应做法 |
|---|---|---|
| 1 | 对比精确与 HNSW 的 Top-K 重合率、命中率、延迟 | 4.1 分开定义；阶段 A 每组参数都同时跑精确与 ANN |
| 2 | 用 `EXPLAIN (ANALYZE, BUFFERS)` 确认实际计划，不得靠配置推测 | **所有参数组必须附 `EXPLAIN (ANALYZE, BUFFERS)` 原文摘要**，记录是否 Index Scan / Seq Scan、实际行数、buffers 命中 |
| 3 | 分别测 `m`、`ef_construction`、`ef_search`，不预设越大越好 | 阶段 A（查询参数）+ 阶段 B（9 组建索引参数）；已记录 Stage 1.5 的非单调现象作为反例 |
| 4 | 测批量重写向量后重建索引的流程，验证重建前后召回 | 阶段 C 全流程（重写 → 测 → REINDEX → 复测） |
| 5 | 测迭代扫描与过滤组合，确认返回数量、质量、计划 | 阶段 A 的 `iterative_scan ∈ {off, relaxed_order}` × 过滤开关；4.4 的三种判定 |
| 6 | 区分精确质量、ANN 召回率、端到端命中率、延迟 | 4.1 四指标分开，报告里分表呈现，不做加权合并 |
| 7 | 不达标就停止调参并报告，不自行扩数据量 | 4.6 停止条件 |

---

## 7. API 参数设计建议（仅设计，本阶段不实现）

### 7.1 可配置参数

| 参数 | 建议默认值 | 说明 |
|---|---|---|
| `ef_search` | 100（待实验确认） | 会话级，不可索引级固化 |
| `iterative_scan` | `relaxed_order` | 用于避免过滤导致结果不足 |
| `top_k` | 10 | 业务层可覆盖 |
| `include_front_matter` | false | 默认排除 `chapter_title IS NULL` |

### 7.2 连接池下的会话级参数设置（**已实测，附证据**）

pgvector 0.8.6 不支持索引级 `ef_search`（实测 `ALTER INDEX ... SET (ef_search=100)` → `unrecognized parameter "ef_search"`），只能在会话/事务层设置。三种方式的实测对比（同一 Query、同一库）：

| 方式 | 是否生效 | 证据 |
|---|:--:|---|
| `SET hnsw.ef_search = 100`（会话级） | ✅ 生效 | 执行计划变 Seq Scan，Top1 变正确 |
| `set_config('hnsw.ef_search','100', false)`（会话级） | ✅ 生效 | 同上 |
| `set_config('hnsw.ef_search','100', true)`（= `SET LOCAL`） | **仅在显式事务内生效** | 事务内：Seq Scan + 结果正确；`rollback` 后 `SHOW` 回落到 40，Top1 回到错误结果 |

**陷阱（必须遵守）**：
- 在 **autocommit** 模式下执行 `SET LOCAL` **无效**——它作用于 set_config 语句自身的事务，下一条查询已在新事务里，实测仍走 Index Scan、Top1 错误。
- **正确做法**：把 `set_config(..., true)` 与检索查询放在**同一个显式事务**内；事务结束（commit/rollback）后自动重置，不会污染连接池里的后续请求——已实测 `rollback` 后 `SHOW hnsw.ef_search` 回到 40。
- **禁止**用裸 `SET`（会话级）在连接池里设置，否则会污染该连接的后续所有请求。
- 建议封装：查询函数在事务内先执行 `SELECT set_config('hnsw.ef_search', $1, true)`，再执行检索语句。

**另一个已观测风险**：未加载扩展时 `SHOW hnsw.ef_search` 报 `unrecognized configuration parameter`（PostgreSQL 会为带点的未知 GUC 建占位符）。因此不要在启动阶段 `SHOW` 做断言，应在真实查询事务里验证执行计划。

### 7.3 其他

- 过滤条件必须与召回策略一起验证（4.4）；
- 不承诺索引级固定 `ef_search`，一切以当前安装的 pgvector 0.8.6 实际能力为准；
- 本阶段不写任何 API 代码。

---

## 8. 产品前提卡差异稿

针对「发现书籍数据源与数据治理」的补充内容，已单独输出为
**`产品前提卡-差异稿-发现书籍数据源与数据治理.md`**，**未覆盖原文件**。

要点：Project Gutenberg 来源与路径、robots.txt 遵守、版权核验口径与证据字段、原始缓存/元数据/正文/chunk/embedding 的关系、各类失败的记录方式、语义检索质量验证要求、**美国公有领域 ≠ 其他国家公有领域**。

按要求：差异稿**不含**尚未验证的 HNSW 最优参数，也**不自行决定**书籍详情页复用 Reader 还是新建页面。

---

## 9. 当前 Git 变更与 v1 备份表状态

### 9.1 Git：项目目录不是 Git 仓库

```
git rev-parse --is-inside-work-tree
→ fatal: not a git repository (or any of the parent directories): .git
```

**没有版本控制**，因此不存在"未提交的改动"这一概念，也无法做 diff/回滚。这是需要你决定的一件事：是否初始化 Git（我会先只做 `git init` + 写 `.gitignore`，不提交任何内容）。

作为替代，下面给出**本轮（Stage 1.5）实际改动的文件清单**（按修改时间核对）：

| 文件 | 类型 | 说明 |
|---|---|---|
| `server/src/scripts/verify-discover.py` | 新增 | 库内状态校验（数量/维度/范数/NaN/索引/recipe） |
| `server/src/scripts/eval-discover.py` | 新增 | A/B 矩阵评测器（版本 × 过滤 × 检索路径 × ef） |
| `server/src/scripts/discover-queries-stage1.txt` | 新增 | 6 条固定 Query 固化 |
| `server/src/scripts/search-discover.py` | 修改 | 加 query-time filter 与 `--include-front-matter` |
| `server/src/scripts/ingest-books.py` | 修改 | 新 embedding 格式 + recipe 列 + 按书事务 + `--backup-embeddings` |
| `server/src/scripts/migrate.ts` | 修改 | 改为按文件名升序执行 `sql/*.sql` |
| `server/sql/002_discover.sql` | 修改 | 新增 `embedding_recipe` 列与索引，纳入 db:migrate |
| `server/.gitignore` | 修改 | 加 `.eval-*.json`、`.tmp-*.py`、`.ab-compare.txt` |
| `发现书籍链路-Stage1.5-检索质量修正报告.md` | 新增 | 报告 |

**未被本轮触碰的近期文件**（属上一轮阅读器 V3.0，保持原样）：
`src/index.css`(01:08)、`src/lib/annotate.tsx`(01:01)、`src/lib/fitPaging.ts`(01:01)、`产品前提卡-给协作方.md`(01:12)、`overview.md`(01:13)、`阅读器V3.0改版-交付说明.md`(01:12)。

### 9.2 v1 备份表状态

| 项 | 值 |
|---|---|
| 表名 | `discovered_book_chunks_emb_v1` |
| 行数 | **24,244**（embedding 非空 24,244） |
| 维度 | 全部 1024 |
| 索引 | 仅 `discovered_book_chunks_emb_v1_bk_idx`（btree）；临时 HNSW 索引 `tmp_v1_hnsw` 已在 Stage 1.5 结束时删除 |
| 是否在 migration 中 | **否**（由 `ingest-books.py --backup-embeddings` 创建的一次性回滚点） |
| 处置 | 按你的要求**保留**，实验期不删、不覆盖、不写入 |

---

## 10. 停止条件

本方案输出后**立即停止等待确认**。在收到你的明确批准前，不会：

- 抓取任何新书（不发起 `crawl-books.ts` 的新一轮运行）；
- 重算任何 embedding；
- 重建正式索引（阶段 B/C 的重建也要等你批准实验开始）；
- 开发 API 或修改前端；
- 修改 migration 或删除 v1 备份表。

**需要你确认的 6 件事：**

1. 批次 A 扩到 30 本 —— 是否批准？（批准后我会先给出候选书名清单再抓）
2. 4.2 节的验收门槛数值是否认可？
3. 阶段 B 的 9 组索引参数是否照此执行（约 20–30 min 构建 + 评测）？
4. 阶段 C（整批重写向量 + REINDEX）是否执行？它会让全表 embedding 重写一遍（30 本约 2 小时）。
5. 是否初始化 Git 仓库管理本项目？
6. 前提卡差异稿是否合并进《产品前提卡-给协作方.md》？（合并前会再给你看一次 diff）
