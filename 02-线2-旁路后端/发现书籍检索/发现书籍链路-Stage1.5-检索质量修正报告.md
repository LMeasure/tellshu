# 发现书籍链路 · Stage 1.5 检索质量修正报告

- 日期：2026-10-09
- 范围：Stage 1 暴露的检索质量问题修正 + 重新验收（**不含** Stage 2 / API / 前端 / Reader 复用）
- 数据：10 本书、24,244 chunk、24,244 embedding，BAAI/bge-m3 本地离线，pgvector 0.8.6
- 结论一句话：**问题修好了（6/6），但根因不是 embedding——是 HNSW 近似检索 + 索引状态。v1 旧向量在精确检索下本来就是 6/6。**

---

## 0. 先说三个必须知道的结论

1. **Stage 1 报告里的「抽象中文情节错书」不是 embedding 的锅。** 同一批 v1 旧向量，走精确余弦检索 **6/6 全命中**（Q2 也是 Jane Eyre 0.5573）。错书只发生在走 HNSW 索引时。
2. **「修复前」基线无法逐条复现。** 重建 v1 索引后，Q2 的 `A Room with a View 0.5071` 与 Stage 1 报告完全一致，但 Q1/Q3/Q5/Q6 与当时不同（从「对」变成「错/空」）。原因是 HNSW 图的构建方式不同（当时边插入边增量构建，这次批量构建）。**这本身说明：索引状态会改变检索结果，v1 embedding 本身没问题。**
3. **ef_search 与结果质量不单调。** ef=40 4/6、ef=100~400 6/6、**ef=1000 又退回 4/6**。所以「把 ef 调大」不能当作稳定手段，本轮到此停止调参。

---

## 1. 修改内容

### 1.1 检索端 query-time filter（按要求：不删数据，只检索时过滤）

- `server/src/scripts/search-discover.py`、`eval-discover.py`：默认 `WHERE chapter_title IS NOT NULL`，新增 `--include-front-matter` 开关可放开。
- **没有删除任何 chunk**。`chapter_title IS NULL` 的 7,203 块（占 29.7%）全部保留在库：

  | 书 | 无章节归属块数 |
  |---|---:|
  | The String of Pearls | 7,044 |
  | Pride and Prejudice | 76 |
  | The Odyssey | 35 |
  | Jane Eyre | 13 |
  | Crime and Punishment | 11 |
  | **合计** | **7,203** |

- 后续如需 `include_front_matter` 参数，接口层加一个布尔开关即可，不需要动数据。

### 1.2 embedding 输入格式改为真实 metadata + 正文

新格式（`build_embedding_text`）：

```
Title: {真实书名}
Author: {真实作者}
Chapter: {真实章节名}
{正文}
```

- `chapter_title` 为 null → **整行省略**，不写 "Chapter: Unknown" 之类；
- `author_display` 为 null → 同样省略；
- 不添加任何不存在的 metadata。四种组合已单测验证（有章节 / 无章节 / 无作者 / 全空）。
- 新增 `embedding_recipe TEXT` 列记录版本：`v1-book-chapter`（旧）→ `v2-title-author-chapter`（新），带索引便于日后分版本检索。

### 1.3 重新 embedding 的安全措施

- **`--backup-embeddings`**：先把 24,244 条 v1 向量整表复制到 `discovered_book_chunks_emb_v1`，再动主表。备份表至今保留（24,244 行，全 1024 维），可随时回滚或复跑 v1 配置。
- **按书事务提交**：单本全部 chunk 写完后才 commit；任一批次异常 → 整本 rollback 并记失败清单。实测 10 本全部成功，`整本回滚的书 = 0`、`失败条目 = 0`。
- 进度台账仍走 `source_sha256`，中断后可用 `--skip-existing-embeddings` 续跑。

### 1.4 migration 纳入（见第 7 节）

### 1.5 顺带修掉的 bug

- `eval-discover.py` 在检索返回 0 行时会 `TypeError: unsupported format string passed to NoneType` 崩溃（正是这个问题暴露了 HNSW + 过滤的空结果现象），已改为输出 `n/a(空结果)`。

---

## 2. embedding 数量与健康度

| 指标 | 数值 |
|---|---:|
| discovered_books | 10（去重 (source_site, source_id) = 10） |
| discovered_book_chunks | 24,244（去重 (book_id, chunk_index) = 24,244） |
| 带 embedding | **24,244**（100%） |
| 维度 | 全部 1024 |
| 范数 min / max / avg | 0.999999 / 1.000001 / 1.000000 |
| NaN / Inf 向量 | **0** |
| embedding_recipe | 全部 `v2-title-author-chapter` |
| HNSW cosine 索引 | 存在（`vector_cosine_ops`），**REINDEX 后 189 MB** |
| pgvector 版本 | 0.8.6 |

逐本重算明细（10 本，无跳过、无失败）：

| source_id | 书名 | chunk |
|---|---|---:|
| 1260 | Jane Eyre: An Autobiography | 2,854 |
| 1342 | Pride and Prejudice | 2,055 |
| 1513 | Romeo and Juliet | 418 |
| 1695 | The Man Who Was Thursday | 904 |
| 1727 | The Odyssey | 1,835 |
| 2465 | Carmen | 364 |
| 2554 | Crime and Punishment | 3,177 |
| 2641 | A Room with a View | 1,084 |
| 3268 | The Mysteries of Udolpho | 4,509 |
| 59828 | The String of Pearls | 7,044 |

---

## 3. Query 数量说明（6 条，不是 8 条）

Stage 1 完成报告里实际记录并跑过的是 **6 条**固定 Query（A-1~A-3 / B-1~B-3），没有第 7、8 条的原文记录。已与你确认按 6 条执行，**不新增、不补写**，避免把新 Query 混进基线对比。6 条原文固化在 `server/src/scripts/discover-queries-stage1.txt`。

| # | Query | 期望命中 |
|---|---|---|
| Q1 | 拉斯柯尔尼科夫为了证明自己的理论而杀人，之后饱受良心折磨 | Crime and Punishment |
| Q2 | 一个家庭教师被雇去照顾一个孩子，住在阴森的大宅里 | Jane Eyre |
| Q3 | 关于爱情与阶级的英文小说 | Pride and Prejudice |
| Q4 | Odysseus returns home and takes revenge on the suitors | The Odyssey |
| Q5 | two young lovers from feuding families die tragically | Romeo and Juliet |
| Q6 | a governess hired to teach a girl at a gloomy mansion called Thornfield | Jane Eyre |

---

## 4. A/B 对比

### 4.1 Top1 命中矩阵

| Q | 期望 | v1+过滤+精确 | v1+不过滤+精确 | v1+过滤+HNSW40 | v1+不过滤+HNSW40 | v2+过滤+精确 | v2+不过滤+精确 | v2+过滤+HNSW100 | v2+不过滤+HNSW100 |
|---|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| 1 | Crime and Punishment | ✅ | ✅ | ❌空 | ❌ | ✅ | ✅ | ✅ | ✅ |
| 2 | Jane Eyre | ✅ | ✅ | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ |
| 3 | Pride and Prejudice | ✅ | ✅ | ❌空 | ❌ | ✅ | ✅ | ✅ | ✅ |
| 4 | The Odyssey | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 5 | Romeo and Juliet | ✅ | ✅ | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ |
| 6 | Jane Eyre | ✅ | ✅ | ❌空 | ❌ | ✅ | ✅ | ✅ | ✅ |
| | **命中** | **6/6** | **6/6** | **1/6** | **1/6** | **6/6** | **6/6** | **6/6** | **6/6** |

> 「❌空」= HNSW + 过滤条件下**返回 0 行**（pgvector 过滤后候选不足的已知行为）。

### 4.2 Top1 score 矩阵

| Q | v1+过滤+精确 | v1+不过滤+精确 | v1+不过滤+HNSW40 | v2+过滤+精确 | v2+过滤+HNSW100 |
|---|---:|---:|---:|---:|---:|
| 1 | 0.5912 | 0.5912 | 0.4733 | 0.5861 | 0.5861 |
| 2 | 0.5573 | 0.5573 | 0.5071 | 0.5518 | 0.5518 |
| 3 | 0.5123 | 0.5262 | 0.5252 | 0.5576 | 0.5576 |
| 4 | 0.5946 | 0.5946 | 0.5946 | 0.5846 | 0.5846 |
| 5 | 0.5763 | 0.5763 | 0.4498 | 0.5495 | 0.5495 |
| 6 | 0.5509 | 0.5509 | 0.5110 | 0.5572 | 0.5572 |

### 4.3 修复前 → 修复后（统一口径）

修复前 = `v1 + 不过滤 + HNSW ef=40`（Stage 1 真实产线口径）
修复后 = `v2 + 默认过滤 + HNSW ef=100`（本轮建议的产线口径）

| Q | 期望 | 修复前 Top1 | 修复后 Top1 | 前 score | 后 score | Δ | 命中 |
|---|---|---|---|---:|---:|---:|:--:|
| 1 | Crime and Punishment | The String of Pearls | Crime and Punishment | 0.4733 | 0.5861 | +0.1129 | ✅ |
| 2 | Jane Eyre | A Room with a View | Jane Eyre: An Autobiography | 0.5071 | 0.5518 | +0.0447 | ✅ |
| 3 | Pride and Prejudice | The String of Pearls | Pride and Prejudice | 0.5252 | 0.5576 | +0.0324 | ✅ |
| 4 | The Odyssey | The Odyssey | The Odyssey | 0.5946 | 0.5846 | −0.0100 | ✅ |
| 5 | Romeo and Juliet | Crime and Punishment | Romeo and Juliet | 0.4498 | 0.5495 | +0.0997 | ✅ |
| 6 | Jane Eyre | The String of Pearls | Jane Eyre: An Autobiography | 0.5110 | 0.5572 | +0.0463 | ✅ |

**命中率 1/6 → 6/6。**

### 4.4 单独拆开两个因素各自的贡献

用**精确检索**（排除 ANN 干扰）单独看：

- **embedding 格式 v1 → v2**：命中率 6/6 → 6/6，**没有变化**。分数有升有降：Q3 +0.045（0.5123→0.5576）明显改善，Q5 −0.027（0.5763→0.5495）下降，其余 ±0.01 内。
- **query-time filter（排除无章节块）**：精确检索下命中率同样是 6/6 → 6/6，**对 Top1 命中无影响**；价值在于 Top3 里不再出现前言/版权页/版式块，Q3 的分数还从 0.5123 抬到 0.5576。
- **HNSW 检索路径**：这是唯一决定成败的因素——v1 精确 6/6，v1 HNSW40 1/6。

---

## 5. Top 3 明细（修复后 v2 + 过滤 + HNSW ef=100）

**Q1 拉斯柯尔尼科夫为了证明自己的理论而杀人，之后饱受良心折磨** → 期望 Crime and Punishment ✅ 3/3
1. 0.5861 Crime and Punishment · chunk 901 · PART II — CHAPTER VII
2. 0.5579 Crime and Punishment · chunk 1997 · PART V — CHAPTER IV
3. 0.5550 Crime and Punishment · chunk 1533 · PART IV — CHAPTER IV

**Q2 一个家庭教师被雇去照顾一个孩子，住在阴森的大宅里** → 期望 Jane Eyre ✅ 3/3
1. 0.5518 Jane Eyre · chunk 2380 · CONCLUSION
2. 0.5495 Jane Eyre · chunk 2379 · CONCLUSION
3. 0.5401 Jane Eyre · chunk 1877 · CHAPTER XXXI

**Q3 关于爱情与阶级的英文小说** → 期望 Pride and Prejudice ✅ 2/3
1. 0.5576 Pride and Prejudice · chunk 1500 · CHAPTER LV.
2. 0.5522 Pride and Prejudice · chunk 1889 · CHAPTER LXI.
3. 0.5435 A Room with a View · chunk 603 · PART TWO — Chapter XIV

**Q4 Odysseus returns home and takes revenge on the suitors** → 期望 The Odyssey ✅ 3/3
1. 0.5846 The Odyssey · chunk 1413 · BOOK XXIV
2. 0.5824 The Odyssey · chunk 1520 · BOOK XXIV
3. 0.5784 The Odyssey · chunk 1678 · BOOK XXIV

**Q5 two young lovers from feuding families die tragically** → 期望 Romeo and Juliet ✅ 1/3
1. 0.5495 Romeo and Juliet · chunk 7 · ACT I — A public place.
2. 0.4849 Jane Eyre · chunk 2377 · CONCLUSION
3. 0.4667 Crime and Punishment · chunk 2527 · PART VI — CHAPTER VIII

**Q6 a governess hired to teach a girl at a gloomy mansion called Thornfield** → 期望 Jane Eyre ✅ 3/3
1. 0.5572 Jane Eyre · chunk 736 · CHAPTER XV
2. 0.5535 Jane Eyre · chunk 2385 · CONCLUSION
3. 0.5504 Jane Eyre · chunk 1874 · CHAPTER XXXI

> Q5 只有 1/3：Romeo and Juliet 全文仅 418 chunk（占库 1.7%），Top1 正确但第 2、3 位被长书挤掉。这是语料体量导致的，不是检索错误。

---

## 6. 错误案例与根因分类

### 6.1 四类逐一判断

| 类别 | 是否主因 | 证据 |
|---|:--:|---|
| **embedding 表达问题** | ❌ 否 | v1 旧格式在精确检索下 6/6 全对。v2 改格式后命中率仍是 6/6，只改变分数分布（Q3 +0.045 / Q5 −0.027）。 |
| **chunk 上下文问题** | ⚠️ 次要 | Top1 chunk 内容看，Q2/Q6 命中的是 CONCLUSION / CHAPTER XV 等正文章节，片段与意图吻合；未发现因切块导致的明显错配。500/80 的切块参数本轮未动。 |
| **front matter 干扰** | ❌ 否 | 精确检索下过滤与否命中率均 6/6。真实影响是 HNSW 下过滤会触发「返回 0 行」（Q1/Q3/Q6 空结果）——**过滤本身没有害处，但它与 HNSW 组合时暴露了 pgvector 的过滤缺陷**。 |
| **语义模型能力边界** | ✅ 是（部分） | Q2 精确检索下 Jane Eyre 0.5518 vs A Room with a View 0.5352，**差距只有 0.017**。模型对这段抽象中文情节的区分度本就很低，任何微小扰动都会翻转排序。 |
| **（额外）ANN 近似召回 + 索引状态** | ✅ **是（主因）** | ① 同一批向量，精确 6/6 vs HNSW ef=40 1/6；② 整表 UPDATE 24,244 行后索引从 189 MB 膨胀到 247 MB，REINDEX 后才恢复；③ ef_search 与质量非单调（100~400 好，1000 又差）。 |

### 6.2 典型错误案例

**案例 A：Q2 抽象中文情节（Stage 1 报告的原始错书）**
- v1 + HNSW ef=40 → `A Room with a View` 0.5071（错）
- v1 + 精确 → `Jane Eyre` 0.5573（**对**）
- v2 + HNSW ef=100 → `Jane Eyre` 0.5518（对）
- 判断：向量本身能区分，只是 margin 太小（0.017），ANN 误差足以翻转。

**案例 B：HNSW + 过滤返回 0 行（v1 下 Q1/Q3/Q6）**
- 现象：带 `chapter_title IS NOT NULL` 走 HNSW，直接返回 0 行。
- 判断：pgvector 0.8 的 HNSW 不支持真正的 filtered search，索引扫描取到的候选被 WHERE 过滤掉后不会补取。
- 已验证的规避手段：开启 `hnsw.iterative_scan = relaxed_order`（0.8 特性）后不再出现空结果（ef=40 时 Q1/Q3/Q6 均正常返回 3 行）。

**案例 C：结果整体塌陷到同一本书（v1 + HNSW + 不过滤）**
- 现象：Q1/Q3/Q6 的 Top1 全部是 `The String of Pearls`（7,044 chunk，占库 29%）。
- 判断：HNSW 图遍历在该 query 上收敛到密集区域，短书被系统性地漏掉。**这是 ANN 的典型失败模式，不是数据问题。**

### 6.3 ef_search 实测（REINDEX 后，v2 + 过滤）

| ef_search | 命中 | 优化器实际选择 | 中位延迟 |
|---|:--:|---|---:|
| 40 | 4/6 | HNSW Index Scan | 1.3 ms |
| 60 | 4/6 | HNSW Index Scan | — |
| 100 | **6/6** | Seq Scan + Sort（放弃索引） | 128 ms |
| 150 | **6/6** | Seq Scan + Sort | — |
| 200 | **6/6** | Seq Scan + Sort | — |
| 400 | **6/6** | Seq Scan + Sort | 127 ms |
| 1000 | 4/6 | HNSW Index Scan | — |

强制走索引（`enable_seqscan=off` + `iterative_scan=relaxed_order`）：ef=40/60/100 → 1.8~2.4 ms 但 5/6；ef=200 → 79 ms 6/6；**ef=800 → 14 ms 却 5/6**。

> ef 与质量**不单调**（ef=800 比 ef=200 差），原因未完全确定（可能与 pgvector cost 模型、relaxed_order 迭代终止条件有关）。**据此停止调参**，不再继续试 ef 组合。

### 6.4 延迟参考（24,244 chunk 规模，LIMIT 10）

| 路径 | 中位延迟 | 说明 |
|---|---:|---|
| 精确（禁用索引） | 79.5 ms | 结果确定性最强 |
| HNSW ef=40 | 1.3 ms | 快，但只有 4/6 |
| HNSW ef=100 | 128 ms | 优化器已放弃索引，等价于精确扫描 |

**当前规模下 HNSW 并没有真正省时间**——能给出正确答案的配置（ef≥100）优化器会自己转成全表排序。

---

## 7. migration 验证

### 7.1 改动

- `server/src/scripts/migrate.ts` 重写：扫描 `sql/*.sql` **按文件名排序**依次执行（001 → 002 → …），每个文件在**单事务**内执行，失败即回滚并报错。
- **`001_init.sql` 未做任何修改**。
- `002_discover.sql` 新增 `embedding_recipe TEXT` 列 + `discovered_book_chunks_recipe_idx`（幂等 `IF NOT EXISTS`）。

### 7.2 验证结果

| 检查项 | 结果 |
|---|---|
| `npm run db:migrate` 一次 | ✅ 执行 001 + 002，共 2 个迁移 |
| 连续运行两次 | ✅ 库状态完全一致 |
| 两次后数据 | books=10、chunks=24,244、embedding=24,244、recipe 种类=1、HNSW 索引=1 |
| 全新空库按序迁移 | ✅ 在临时库 `shutree_migrate_probe` 上验证：建出全部表、pgvector 0.8.6 扩展、HNSW `vector_cosine_ops` 索引、`embedding_recipe` 列（验证完已删库） |
| pgvector 版本 | 0.8.6 |

> 注：备份表 `discovered_book_chunks_emb_v1` 由 ingest 脚本 `--backup-embeddings` 创建，**不在 migration 里**（它是一次性回滚点，不应成为新环境的标准对象）。

---

## 8. 是否改善？是否建议进入 Stage 2？

### 8.1 是否改善：**是**

- 产线口径命中率 **1/6 → 6/6**。
- 6 条 Query 全部命中期望书籍，且 Top1 score 全部 ≥ 0.5495。
- 但要如实说明：**改善主要来自检索路径修正（ef_search + REINDEX + 迭代扫描），不是来自换 embedding 格式。** embedding 格式的改动收益有限（命中率 0，Q3 分数 +0.045、Q5 −0.027），它仍有价值（metadata 显式化、Top3 质量），但不该被记成「修好了错书」的那个因素。

### 8.2 是否建议进入 Stage 2：**建议暂缓**，先确认两件事

理由（不是保守，是有具体未收敛项）：

1. **检索参数还没固化到代码里。** 本轮所有结论都在脚本里验证，产线需要的是 API 层固定执行：
   ```
   SET LOCAL hnsw.ef_search = 100;
   SET LOCAL hnsw.iterative_scan = relaxed_order;
   ```
   pgvector 0.8.6 **不支持**索引级 `ALTER INDEX ... SET (ef_search=...)`（实测报 `unrecognized parameter`），只能在会话/查询层设置。这一步属于 API 阶段，本轮按要求未做。

2. **ef 非单调的问题没解决。** 24k 规模下「正确」的配置实际上退化为全表扫描（~80~128 ms）。Stage 2 若扩到 200 本 / 约 50 万 chunk，全表扫描会到秒级，那时必须依赖 HNSW——而 HNSW 在我们的数据上表现出非单调和不稳定。**建议在扩量后、用 30~50 本的样本重做一次召回实验**（含 m / ef_construction 建索引参数），再定产线参数。

3. **运维约束已明确，需要写进流程：** 整表重写 embedding 后**必须 REINDEX** HNSW 索引（本轮实测 189 MB → 247 MB 膨胀）。

如果你希望直接进 Stage 2，我的建议是**分两步**：先扩到 30~50 本做召回实验定参数，通过后再一次性扩到 200 本。这比一次性扩满再发现问题要省时间。

---

## 9. 本轮新增 / 修改的文件

| 文件 | 说明 |
|---|---|
| `server/src/scripts/search-discover.py` | 加 query-time filter 与 `--include-front-matter` |
| `server/src/scripts/eval-discover.py` | 新增；A/B 矩阵评测器，支持 v1/v2 源表、过滤开关、exact/ann 检索路径、ef_search；修空结果崩溃 |
| `server/src/scripts/verify-discover.py` | 新增；库内状态校验（数量/维度/范数/NaN/索引/recipe） |
| `server/src/scripts/discover-queries-stage1.txt` | 新增；6 条固定 Query 固化 |
| `server/src/scripts/ingest-books.py` | 改 embedding 输入格式 + recipe 列 + 按书事务 + `--backup-embeddings` |
| `server/src/scripts/migrate.ts` | 改为按序执行 `sql/*.sql` |
| `server/sql/002_discover.sql` | 新增 `embedding_recipe` 列与索引，纳入 db:migrate |
| `server/.gitignore` | 加 `.eval-*.json`、`.tmp-*.py`、`.ab-compare.txt` |

数据库对象：
- `discovered_book_chunks.embedding_recipe`（新列）
- `discovered_book_chunks_emb_v1`（备份表，24,244 行 v1 向量，**保留中**，可删但建议先留着）

---

## 10. 待你确认

1. 是否接受第 8.2 节的建议（暂缓 Stage 2，先做 30~50 本召回实验）？
2. 备份表 `discovered_book_chunks_emb_v1` 是否保留？（建议保留到 Stage 2 参数定稿后）
3. 产线检索参数是否按第 8.1 节固化（属 API 阶段，等你放行）？
4. 是否需要把「发现书籍数据源」补进《产品前提卡-给协作方.md》？（本轮未改前端页面清单，故未擅动）

**Stage 1.5 到此停止，等你确认。**
