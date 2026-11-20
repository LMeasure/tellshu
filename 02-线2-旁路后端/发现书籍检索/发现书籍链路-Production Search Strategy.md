# 发现书籍链路 · Production Search Strategy

> 版本：v1（**方案，未实现任何代码**）　·　日期：2026-10-12
> 数据集：30 本冻结基线（books=30 / chunks=58,332 / embedding 58,332 × 1024 / HNSW 456 MB）
> 事实来源：《发现书籍链路-StageB.5最终报告.md》《StageB5-资产冻结复核报告.md》
> 本文件**不改一行代码、不动一个 GUC、不 REINDEX**。

---

## 0. 先把事实摆清楚，再谈方案

### 0.1 ⚠ 当前**没有**发现书籍的 HTTP API

只读核实现状（`server/src`）：

| 项 | 现状 |
|---|---|
| `src/routes/` 下的路由 | `admin.ts` / `dictionary.ts` / `health.ts` / `ocr.ts` / `translate.ts` —— **没有 discovery/search** |
| `discovered_book_chunks` 在 `src` 内被引用 | **只在 `src/scripts/` 里**（迁移注释与 plan-candidates 注释），业务代码零引用 |
| 实际检索入口 | `server/src/scripts/search-discover.py` —— **只读 CLI**，psycopg2 直连，不提供 HTTP |
| README 里的路由总表（`src/index.ts` 头部） | 只列了 health / ocr / translate / sync / search（**词典**检索）/ admin |

**这一步的结论比方案本身更重要**：三个方案都是「**尚未建成**」的前提下的选择，
所以对比的不只是运行时性能，还有**建设成本**——而建设成本里最贵的一项见 §0.5。

### 0.2 路径命名（沿用最终报告，全文一致）

| 标签 | 定义 | 说明 |
|---|---|---|
| **EXACT** | Seq Scan 精确余弦 | 召回天花板，延迟随规模线性增长 |
| **HNSW** | 使用 `embeddings_hnsw_idx` | 近似检索，精度由 `hnsw.ef_search` 控制 |
| **FALLBACK** | 优化器放弃 HNSW，改 `book_idx` 全扫 + Sort | 计划里同样显示为 *Index Scan*，但它**不是 ANN**，延迟比 EXACT 还差 |

> 判路径的**唯一依据是计划里出现的索引名**，不是节点类型。

### 0.3 现有检索 SQL 形态（`search-discover.py`）

```sql
SELECT b.id, b.title, b.author_display, b.language, b.rights,
       c.chunk_index, c.chapter_title, c.content,
       1 - (c.embedding <=> $v::vector) AS similarity
FROM discovered_book_chunks c
JOIN discovered_books b ON b.id = c.book_id
WHERE c.embedding IS NOT NULL
  AND ($model_filter::text IS NULL OR c.embedding_model = $model_filter)
  AND ($include_front_matter OR c.chapter_title IS NOT NULL)
ORDER BY c.embedding <=> $v::vector
LIMIT $k
```

注意：**这条 SQL 一个 GUC 都没设**。所以它在 58,332 规模下走什么路径，完全由优化器决定——
而 Stage B.5 的 `默认计划` 臂（同样不动 GUC）实测走的是 **HNSW，`ef_search` 仍是默认 40**。

### 0.4 ✅ 已验证：真实生产 SQL 不会引入额外的 FALLBACK 风险

Stage B.5 的实验 SQL 少了 `embedding_model` 这个谓词。这会改变计划吗？
本轮用「库里现成的一条 embedding」做探针，对**两种 SQL 形态 × 两种 GUC** 各跑 9 次取 P50：

| GUC | SQL 形态 | P50 ms | 实际路径 |
|---|---|---:|---|
| 默认（不动 GUC） | 真实生产 SQL（带 model 过滤） | 0.283 | HNSW |
| 默认（不动 GUC） | 真实生产 SQL（filter=NULL） | 0.256 | HNSW |
| 默认（不动 GUC） | 实验 SQL（Stage B.5） | 0.277 | HNSW |
| ef=800 + relaxed_order | 真实生产 SQL（带 model 过滤） | 2.467 | HNSW |
| ef=800 + relaxed_order | 真实生产 SQL（filter=NULL） | 2.241 | HNSW |
| ef=800 + relaxed_order | 实验 SQL（Stage B.5） | 2.185 | HNSW |

**结论：**

1. ✅ 多加一个 `embedding_model` 谓词**不会**把计划推到 FALLBACK，路径仍是 HNSW。
2. ✅ 额外的代价只有约 **+9%（2.241 → 2.467 ms）**，可接受。
3. ⚠️ **这张表的绝对延迟不能和 Stage B.5 对比**：这里的探针是「某一条文档的 embedding」，
   属于**分布内**向量，HNSW 图遍历很快就收敛；而 Stage B.5 用的是「中文 query 编码出的向量」，
   远离所有英文文档，遍历深得多（P50 7.0 ms）。这张表**只能用来看计划形状与相对开销**。

### 0.5 ⚠ 隐藏的最大成本：query 必须在 Python 侧编码

这是一个容易被漏算的点：

- 库里的 embedding 是 **BGE-M3（1024 维，normalize=True）** 产出的；
- **Node.js 侧没有 sentence-transformers**，没法用 JS 复算同一个向量；
- 所以任何一次「用户输入自然语言 → 检索」都必须**跑一遍 PyTorch 推理**，
  也就是生产环境需要一个**常驻的 Python 编码进程/服务**，而模型常驻内存
  （本项目实测 RSS 峰值 **2,227 MB**）。

这意味着三件事：

1. **端到端延迟 =  query 编码 + SQL 检索 + 传输**，不能只谈 SQL P50。
2. 方案 A 与方案 B 之间那点 271.8 ms vs 7.0 ms 的检索差异，可能被编码时间**稀释**。
3. 部署侧多了一个「有状态、吃内存、要预热」的组件，运维复杂度上升。

### 0.6 延迟预算：已测 vs 未测（**不编造**）

| 环节 | 状态 | 数值 |
|---|---|---|
| SQL 检索 · EXACT | ✅ **实测**（Stage B.5，过滤开启） | P50 **271.8 ms** / P95 302.9 ms |
| SQL 检索 · HNSW ef=800 | ✅ **实测**（同上） | P50 **7.0 ms** / P95 12.2 ms |
| SQL 检索 · 默认（ef=40） | ✅ **实测**（同上） | P50 **1.1 ms** / P95 6.3 ms |
| query 单次编码 | ❌ **未测** | — |
| HTTP + JSON 往返 | ❌ **未接入**，无法测 | — |

> **为什么编码延迟没测**：本机当前可用内存 2,793 MB，BGE-M3 加载需要约 2,200 MB，
> 本轮尝试两次均以 **Segmentation fault** 失败。所以这里**不填数字**，也不拿别的东西冒充。
>
> 可引用的实测只有**批量吞吐**（Stage C 探针/入库）：168.06 ms/条（探针，无写库）与
> 200.6 ms/条（入库，含写库）——但这是**批量**推理，transformer 的固定开销被摊薄了，
> **不能当作单次延迟**，尤其不能当作 P50。

**因此：本报告的所有延迟结论都只针对「SQL 检索这一段」，端到端结论必须等编码延迟测出来后再定。**

### 0.7 规模外推（**估算，不是实测**）

EXACT 是 Seq Scan，理论上随 chunks 线性增长。以 58,332 → 271.8 ms 为锚：

| chunks | EXACT 估算 P50 | 口径 |
|---:|---:|---|
| 58,332 | **271.8 ms** | ✅ 实测锚点 |
| 100,000 | ~466 ms | 估算（线性外推） |
| 200,000 | ~932 ms | 估算 |
| 500,000 | ~2.33 s | 估算 |

⚠️ 实际会比线性更糟，因为：

- 表 heap 只有 39 MB，但 embedding 合计 228 MB 是 **TOAST 外存**，
  Seq Scan 需要额外 TOAST 抓取；
- `shared_buffers` 只有 **128 MB**，而 embedding 总量已达 228 MB，
  规模再涨 buffer miss 会显著上升。

HNSW 侧理论上近似 O(log N)，但它受另一个因素支配：**随着规模增长，
优化器会更倾向于切换到 HNSW，而 `ef_search` 需要跟着往上调**——
而我们已经知道 ef 上调到某个区间会触发 FALLBACK。这个交互是本项目最大的不确定性。

---

## 1. 方案 A：继续 EXACT

### 1.1 适用条件

```
chunks < 50,000
```

> 注：当前已到 58,332，**已越线**。这就是为什么今天优化器自己跑去了 HNSW。

### 1.2 如何落地（待实现）

```sql
-- 必须在同一事务内，用 SET LOCAL 语义
SELECT set_config('enable_indexscan',      'off', true);
SELECT set_config('enable_bitmapscan',     'off', true);
SELECT set_config('enable_indexonlyscan',  'off', true);
-- ... 然后紧接上面的检索 SQL
```

### 1.3 优点

| 优点 | 说明 |
|---|---|
| **召回最高** | Top1 25/47 (53.2%)、Top10 41/47 (87.2%) —— 这就是天花板，没有更好的了 |
| **没有 ANN 风险** | 不涉及 ef_search、不涉及图遍历质量、不存在「近似损失」这回事 |
| **行为可预测** | Seq Scan 的计划几乎不受统计信息漂移影响，不会出现今天这种「静默切换」 |
| **结果完全可复现** | 同样的数据同样的查询，Top-K 一模一样（Stage B.5 实测 `重复结果不一致 = 0`） |

### 1.4 缺点

| 缺点 | 说明 |
|---|---|
| **延迟线性增长** | 见 §0.7，100k 估 ~466 ms、500k 估 ~2.33 s |
| 拖的是 CPU | Seq Scan + TOAST 抓取吃 CPU 与 IO；并发高时会和写入抢资源 |
| 越往后越难回头 | 一旦用户习惯了完整召回，再切 ANN 会有体验落差 |

### 1.5 失败模式

单点失败基本没有——它是最保守的一条路。真正的失败是**成本失控**：
规模翻倍，延迟翻倍，最后被迫在没准备好的时候切换。

---

## 2. 方案 B：固定 HNSW（`hnsw.ef_search = 800`）

### 2.1 适用条件

```
chunks > 50,000 且 < 150,000（上限待验证）
```

### 2.2 ✅ 必验项 1：API 是否支持事务级 `SET LOCAL`

**答：支持，而且现有代码已经提供了正确的原语。**

`server/src/db/pool.ts`：

```ts
export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();   // ← 从池里取出独占 client
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();                    // ← 归还，此时事务已结束
  }
}
```

判断依据：

- `pool.connect()` 拿到的是**独占**的 `PoolClient`，事务期间不会被别的请求复用；
- `SET LOCAL` / `set_config(..., true)` 的作用域是**事务**，随 COMMIT/ROLLBACK 自动失效；
- 而 `client.release()` 发生在事务结束之后 → **归还时连接已经干净**。

✅ 结论：**只要所有 GUC 设置都写在 `withTransaction` 的回调里，`SET LOCAL` 是安全的。**

### 2.3 ⚠ 必验项 2：连接池污染风险

**现状**：`src/index.ts` 里 `createPool({ connectionString })` **没有传 `max`**，
而 `createPool` 的默认值是 **`max: 10`**，另有 `idleTimeoutMillis: 30_000`。

危险来自**裸 `SET`**（会话级）：

| 写法 | 作用域 | 是否污染连接池 | 判定 |
|---|---|---|---|
| `SELECT set_config('hnsw.ef_search','800',true)` **在 `withTransaction` 内** | 事务 | ❌ 不污染 | ✅ **唯一正确姿势** |
| `SET hnsw.ef_search = 800` 独立执行 | 会话 | ✅ **会污染** | ❌ **禁止** |
| 通过 `pool.query()` 分两次执行（设 GUC 一次、查询一次） | 各自独立 | ⚠️ 设了也没用，且可能残留 | ❌ 禁止 |

> pgvector **不支持索引级** `ef_search`，也没有 per-query hint，
> 只能**会话/事务级**设置 —— 所以这条纪律没有任何绕过的余地。

**建议的护栏（待实施，本轮不写代码）：**

1. 把「设有 GUC 的检索」收敛到 **repository 层的单一方法**，路由层禁止手搓 SQL；
2. 该方法**强制要求**接收一个 `PoolClient` 而不是 `Pool`，
   从类型上杜绝「脱离事务设置 GUC」；
3. 加一条集成测试：设完 `ef_search=800` 后，用另一个连接读 `current_setting('hnsw.ef_search')`，
   断言仍为默认值，防止未来有人改成裸 `SET`。

### 2.4 ⚠ 必验项 3：ef 上调会踩到 FALLBACK 退化区

这是 Stage B.5 最重要的发现，也是方案 B 最大的隐患：

- 在 58,332 规模下，**ef=200 / ef=400 会触发优化器放弃 HNSW**，
  改走 `book_idx` 全扫 46,563 行 + Sort，**P50 738–807 ms，比 EXACT（271.8 ms）还慢 2~3 倍**；
- ef=800 实测**仍走 HNSW**（P50 7.0 ms），暂时安全；
- 但这个选择是**基于成本估算的动态结果**，不是由 ef 值直接决定的。

**风险**：数据规模、统计信息、数据分布一旦变化（比如再入库一批新书），
ef=800 也可能退化到 FALLBACK。**到那时延迟会比方案 A 还差，而没人会察觉。**

**建议护栏（待实施）：**

1. 检索路径务必保持**可观测**：记录每次实际走的索引名（而非只记录耗时）；
2. 设置告警：一旦出现 FALLBACK 路径（或 P95 突增），立刻告警；
3. 备选加固：考虑对该查询固定行为（如 `enable_sort`-相关开关），
   但这类开关会**全局影响**优化器决策，需要先单独做一次影响面评估，
   **本轮不建议直接采用**。

### 2.5 优点 / 缺点

| | 内容 |
|---|---|
| ✅ 优点 | 检索段延迟从 271.8 ms 降到 **7.0 ms**（约 39 倍）；Top1 24/47 (51.1%)，距 EXACT 只差 2.1pp，**恰好落在噪声门槛上**（边界，不足以断定更低） |
| ❌ 缺点 1 | **Top10 仍差 -10.6pp**（76.6% vs 87.2%）——这是超过噪声门槛的真实损失 |
| ❌ 缺点 2 | 依赖优化器的成本估算，存在退化到 FALLBACK 的尾部风险 |
| ❌ 缺点 3 | 需要常驻 Python 编码服务（同 §0.5，与方案无关但必须计入） |

---

## 3. 方案 C：混合召回（HNSW → 条件性 EXACT 回退）

### 3.1 流程

```
  query
    │
    ├─ ① 编码（Python / BGE-M3）
    │
    ├─ ② HNSW(ef=800) Top-K          ← 常态路径，~7 ms
    │
    ├─ ③ 判定是否需要回退
    │      · 结果行数 < K
    │      · 或 最高分 score < 阈值 T
    │      · 或 走的是 FALLBACK 路径（从 EXPLAIN/日志里读到）
    │
    ├─ 否 → 直接返回
    └─ 是 → ④ EXACT Top-K            ← 罕见路径，~272 ms
```

### 3.2 触发条件怎么选（这是这个方案的全部难点）

| 触发方式 | 优点 | 缺点 |
|---|---|---|
| **结果行数 < K** | 语义明确、不漂移；直接对应 pgvector 在有过滤条件时的已知失效模式 | 只能捕捉「完全没召回」，抓不到「召回了但排错了」 |
| **Top1 score < T** | 能捕捉「召回质量差」的情况 | **阈值会随规模/数据分布漂移**，维护成本高；T 定错会大幅增加回退率 |
| **检测到 FALLBACK 路径** | 精确捕捉 §2.4 的退化 | 需要先拿到计划（多一次 EXPLAIN 开销）或用启发式判断 |

**建议**：先用「**结果行数 < K**」这个最不容易出问题的信号上线，
分数阈值作为第二期再加——而且要**用 100 条查询集（Stage B.6）来标定**，
不许拍脑袋定 T。

### 3.3 延迟分析

设回退率为 r，Top-K 检索段的期望延迟：

```
E ≈ (1 - r) × 7.0 ms + r × (7.0 + 271.8) ms
```

| 回退率 r | 检索段期望 P50 估算 |
|---:|---:|
| 0% | 7.0 ms |
| 5% | 20.9 ms |
| 20% | 62.8 ms |
| 50% | 142.9 ms |

> ⚠️ 这是**算术期望**，不是 P50/P95 分布。**回退率 r 目前完全没有实测依据**
> （Stage B.5 里 `返回 0 行 = 0`、`返回不足 K 行 = 0`，说明**在当前 53 条查询集上回退率为 0**）。
> 分母太小，不能据此断定真实线上也是 0。要估准必须先把 Stage B.6 的 100 条跑出来。

### 3.4 成本与复杂度

| 维度 | 评价 |
|---|---|
| 实现复杂度 | **高**：两条 SQL 路径 + 触发逻辑 + 阈值管理 |
| 运维可观测性 | **要求最高**：必须区分「走 HNSW 直接返回」和「回退到 EXACT」，否则指标失去意义 |
| 资源成本 | 常态省 CPU；回退时峰值比纯 EXACT 还高（HNSW 白跑了一次） |
| 失败模式 | **隐蔽**：回退逻辑出 bug 时会静默降级到某一个分支，而且很难被发现 |
| 收益上限 | 不超过方案 A 的召回，<｜hy_place▁holder▁no▁813｜>的是「大部分请求享受 HNSW 的速度」 |

---

## 4. 三方案对比

| 维度 | A. 继续 EXACT | B. 固定 HNSW(ef=800) | C. 混合召回 |
|---|---|---|---|
| 适用规模 | **< 50k**（已越线） | 50k–150k（上限待验） | 50k–150k |
| Top1（过滤开启） | **53.2%** ✅ 天花板 | 51.1%（-2.1pp，边界） | ≤ 53.2%，取决于回退率 |
| Top10（过滤开启） | **87.2%** ✅ | 76.6%（**-10.6pp，真实损失**） | 介于两者之间 |
| 检索 P50 | 271.8 ms | **7.0 ms** | 7.0 ~ 142.9 ms（随回退率） |
| 延迟随规模 | ❌ 线性增长 | ✅ 近似 log（但受 ef 牵制） | 两者之间 |
| 结果可复现 | ✅ 完全一致 | ⚠️ ANN 有随机性（实测 `重复不一致 = 0`） | ⚠️ 混合后更难复现 |
| 尾部风险 | 成本失控 | **退化到 FALLBACK**（比 EXACT 更慢） | 回退逻辑本身的 bug |
| 实现复杂度 | **低** | 中（+ 必须加 plan 观测） | **高** |
| 运维复杂度 | 低 | 中（要盯 ef 与 plan） | **高**（要盯回退率、阈值、分支分布） |
| 是否需要常驻 Python 编码 | 是（三个方案都需要） | 是 | 是 |
| 失败时的最坏结果 | 变慢 | 悄悄变成最慢的那条路 | 分支逻辑出错，静默降级 |

---

## 5. 推荐（分档，含前置条件）

沿用项目已确立的架构分档：

| chunks 区间 | 推荐 | 理由 |
|---|---|---|
| **< 50k** | **A · EXACT** | 召回最高，延迟可接受，行为最可预测 |
| **50k – 150k**（当前 58,332 落在这一档） | **B · HNSW ef=800** + **强制加 plan 观测** | 延迟省 39 倍，Top1 差距在噪声边界；**但必须盯住 FALLBACK** |
| **> 150k** | 重做参数实验后再定 | ef 下限 + FALLBACK 边界都会移动，现有结论不再适用 |

### 5.1 但先别急着落地 B —— 两个前置测量还没做

| # | 前置测量 | 为什么阻塞 | 现状 |
|---|---|---|---|
| 1 | **单次 query 编码延迟** | 它可能是端到端延迟的大头；如果编码要 300 ms，那么 A 与 B 的差异在用户体验上会被稀释 | ❌ 未测（本机内存不足，加载模型 segfault） |
| 2 | **Stage B.6 · 100 条查询集** | 当前所有差距都卡在 2.1pp 噪声门槛上；分母到 100 之后门槛降到 1.0pp，才能给「差 2.1pp」这句话定性 | ⏳ 方案已就绪（《StageB.6 Query扩展方案.md》），未执行 |

**建议顺序**：先把这两个测量做完，再拍 A / B / C。在此之前做任何切换都是凭噪声做决策。

### 5.2 如果选 B，落地清单（待授权）

1. 新建 discover 检索路由（当前不存在）——顺带解决 Node 无法编码的问题
2. 常驻 Python 编码服务（BGE-M3，内存预算 ≥ 2.5 GB，需预热）
3. 检索路径统一进 `withTransaction`，GUC 一律 `set_config(..., true)`
4. repository 层收敛入口，**类型上禁止**脱离事务设 GUC
5. 记录每次实际走的**索引名**，对 FALLBACK 路径告警
6. 集成测试：跑完带 GUC 的检索后，另一连接读到的 `hnsw.ef_search` 必须仍是默认值

### 5.3 关于方案 C

不推荐现在就做。**它解决的是一个尚未被证实存在的问题**（回退率实测为 0%），
却引入了三方案里最高的复杂度和最难排查的失败模式。
如果 Stage B.6 跑完发现「结果行数 < K」确实频繁发生，届时再从 B 升级到 C 会更从容。

---

## 6. 本阶段红线自检

| 禁止项 | 状态 |
|---|---|
| 修改 `hnsw.ef_search` | ✅ 未改（仍为默认 40） |
| 修改 `postgresql.conf` | ✅ 未改 |
| REINDEX 正式索引 | ✅ 未做 |
| 修改 API 查询 SQL | ✅ 未改（且当前 API 尚未包含 discover 路由） |
| 修改前端发现页 | ✅ 未改 |
| 删除实验表 / 实验 JSON / 实验索引 | ✅ 未删 |
| 提交 Git | ✅ 未提交（HEAD 仍 `f2174ba`） |
| 伪造未测的数字 | ✅ 未做——query 编码延迟明确标注为「未测」，规模外推明确标注为「估算」 |
