# 发现书籍链路 · Stage B.5 最终报告

> 生成时间：2026-10-12 08:26:05　·　数据集：**30 本冻结基线**
> 脚本：`server/src/scripts/stage-b5-experiment.py`（**只读**）　→　`make-stageb5-final-report.py`（渲染，同样只读）
> 原始数据：`server/.crawl-cache/_b5-matrix.json`
> 前置文件：《StageB5-资产冻结复核报告.md》—— 资产冻结成立，本报告结论可作决策依据

---

## 0. 决策摘要

### 0.1 数据规模

| 项 | 值 |
|---|---|
| 书籍数 | **30 本** |
| 文本块 chunks | **58,332** |
| embedding | **58,332 × 1024 维**（recipe=v2，无缺失） |
| 正文字符合计 | 25,625,443 |
| 无章节块 | 11,769（20.18%） |
| 正式 HNSW 索引 | **456 MB**（插入自动维护，未 REINDEX） |
| 内容指纹 | `770e7c8bbaca404c8418087418d1c632` |

### 0.2 精确基线（EXACT）

> 过滤开启口径（`chapter_title IS NOT NULL`），分母 47 条。这是**召回率天花板**。

| 指标 | 值 |
|---|---|
| **Top1** | **25/47（53.2%）** |
| **Top10** | **41/47（87.2%）** |
| **P50** | **271.8 ms** |
| P95 | 302.9 ms |
| 实际路径 | EXACT×57 |

### 0.3 最优真实 ANN（HNSW）

> `ann-ef800` —— 在**真正走了 HNSW 索引**的臂里 Top1 最高的一组。

| 指标 | 值 |
|---|---|
| **ef_search** | **800** |
| **Top1** | **24/47（51.1%）** |
| **Top10** | **36/47（76.6%）** |
| **P50** | **7.0 ms** |
| P95 | 12.2 ms |
| 实际路径 | HNSW×57 |

- 距 EXACT 天花板：**Top1 -2.1pp**、**Top10 -10.6pp**
- P50 比 EXACT **快 39 倍**（271.8 ms → 7.0 ms）
- Top1 差距 2.1pp vs 噪声门槛 2.1pp：**正好落在噪声门槛上（边界情形）**，不足以断定低于 EXACT

### 0.4 一句话

> 在 **30 本 / 58,332 chunks** 这个规模上，**HNSW + ef_search=800** 能把 Top1 做到 51.1%，和 EXACT 天花板 53.2% 只差 2.1pp（噪声门槛 2.1pp），而延迟从 271.8 ms 降到 7.0 ms；代价是 **Top10 仍低 10.6pp**。

## 1. 路径命名约定（全文统一）

> ⚠️ **禁止使用「Index Scan = ANN」这种说法。**
> 本轮实测证明：`FALLBACK` 路径在 PostgreSQL 计划里同样显示为 *Index Scan*，
> 但它是**全扫 + 排序**，一次距离计算都没省，与 ANN 无关。
> 判断路径的**唯一依据是计划里出现的索引名**，不是节点类型。

| 标签 | 定义 | 计划判据 | 说明 |
|---|---|---|---|
| **EXACT** | Seq Scan 精确余弦 | `seq_exact` | 顺序扫描全表，逐条算余弦距离。召回率的天花板，代价是延迟随规模线性增长。 |
| **HNSW** | 使用 hnsw_idx | `hnsw_ann` | 走 `discovered_book_chunks_embedding_hnsw_idx`（`vector_cosine_ops`）做近似检索。近似度由 `hnsw.ef_search` 控制。 |
| **FALLBACK** | 优化器放弃 HNSW | `other_index_exact` | 名义上请求的是 ANN，但优化器改用 `discovered_book_chunks_book_idx` 全扫 + Sort（top-N heapsort）。结果等价于精确，延迟却比 EXACT 更糟。**不是 ANN。** |

判据实现（`stage-b5-experiment.py`）：

```
出现 discovered_book_chunks_embedding_hnsw_idx  -> hnsw_ann        -> HNSW
出现 Seq Scan on discovered_book_chunks         -> seq_exact       -> EXACT
出现 discovered_book_chunks_book_idx + Sort     -> other_index_exact -> FALLBACK
```

## 2. 实验方法

| 项 | 值 |
|---|---|
| 载体 | **正式表**（`discovered_book_chunks`），只读，**不建任何索引** |
| 查询集 | `discover-queries-b5.txt`，57 条 |
| Top-K | 10 |
| 每条重复 | 5 次（取 P50/P95，并校验重复结果是否稳定） |
| 分母（过滤开启） | 47 条 |
| 分母（过滤关闭） | 53 条 |
| **噪声门槛** | **1 条 = 2.1pp**（过滤开启）／ 1.9pp（过滤关闭） |

会话级参数一律 `SELECT set_config(..., true)`（等价 `SET LOCAL`）与查询**同事务**，commit 后自动重置，**不污染连接池**。

### 2.1 过滤开启口径为何少 6 条

下面这些书的期望书名在库里**没有任何 `chapter_title IS NOT NULL` 的块**，在过滤开启口径下**物理上不可召回**，计入分母就是污染指标，故剔除：

| ID | 目标书籍 | Query |
|---|---|---|
| `S23` | The String of Pearls | 斯威尼·托德在舰队街的理发店里接待客人 |
| `B5-9` | The strange case of Dr. Jekyll and Mr. Hyde | 一位医生配制药剂让自己变成另一个人格，夜里在城里行恶 |
| `B5-16` | Manon Lescaut | 一位年轻贵族为一名女子倾家荡产，最终随她流放海外 |
| `B5-21` | The Lady of the Lake | 一位苏格兰高地首领与国王在湖畔的少女之间周旋 |
| `B5-28` | The Love Letters of Mary Wollstonecraft | 一位女作家写给情人却被对方冷淡以对的书信 |
| `B5-29` | Meditations | 一位罗马皇帝写给自己的道德自省札记 |

## 3.1 主结果矩阵 · 过滤开启（chapter_title IS NOT NULL）　分母 47

| 臂 | Top1 | Top1% | Top10 | Top10% | P50 ms | P95 ms | 实际路径 | 是否 ANN 样本 |
|---|---:|---:|---:|---:|---:|---:|---|---|
| `默认计划` | 18/47 | 38.3% | 23/47 | 48.9% | 1.1 | 6.3 | HNSW×57 | ✅ 是 |
| `强制 EXACT` | 25/47 | 53.2% | 41/47 | 87.2% | 271.8 | 302.9 | EXACT×57 | —（EXACT 基线） |
| `HNSW ef=40` | 18/47 | 38.3% | 23/47 | 48.9% | 1.1 | 8.7 | HNSW×57 | ✅ 是 |
| `HNSW ef=80` | 18/47 | 38.3% | 25/47 | 53.2% | 1.3 | 6.3 | HNSW×57 | ✅ 是 |
| `HNSW ef=120` | 21/47 | 44.7% | 28/47 | 59.6% | 1.7 | 6.7 | HNSW×57 | ✅ 是 |
| `HNSW ef=200` | 25/47 | 53.2% | 41/47 | 87.2% | 806.9 | 852.6 | FALLBACK×57 | ❌ 否（FALLBACK） |
| `HNSW ef=400` | 25/47 | 53.2% | 41/47 | 87.2% | 738.5 | 865.5 | FALLBACK×57 | ❌ 否（FALLBACK） |
| `HNSW ef=800` | 24/47 | 51.1% | 36/47 | 76.6% | 7.0 | 12.2 | HNSW×57 | ✅ 是 |

## 3.2 主结果矩阵 · 过滤关闭（全量块）　分母 53

| 臂 | Top1 | Top1% | Top10 | Top10% | P50 ms | P95 ms | 实际路径 | 是否 ANN 样本 |
|---|---:|---:|---:|---:|---:|---:|---|---|
| `默认计划` | 21/53 | 39.6% | 26/53 | 49.1% | 0.9 | 1.6 | HNSW×57 | ✅ 是 |
| `强制 EXACT` | 29/53 | 54.7% | 41/53 | 77.4% | 320.3 | 348.9 | EXACT×57 | —（EXACT 基线） |
| `HNSW ef=40` | 21/53 | 39.6% | 26/53 | 49.1% | 0.8 | 1.4 | HNSW×57 | ✅ 是 |
| `HNSW ef=80` | 21/53 | 39.6% | 28/53 | 52.8% | 1.1 | 1.9 | HNSW×57 | ✅ 是 |
| `HNSW ef=120` | 24/53 | 45.3% | 31/53 | 58.5% | 1.5 | 3.0 | HNSW×57 | ✅ 是 |
| `HNSW ef=200` | 29/53 | 54.7% | 41/53 | 77.4% | 441.8 | 508.4 | FALLBACK×57 | ❌ 否（FALLBACK） |
| `HNSW ef=400` | 29/53 | 54.7% | 41/53 | 77.4% | 435.0 | 500.9 | FALLBACK×57 | ❌ 否（FALLBACK） |
| `HNSW ef=800` | 28/53 | 52.8% | 38/53 | 71.7% | 6.9 | 10.7 | HNSW×57 | ✅ 是 |

## 4. ⚠ 关键陷阱：ef=200 / ef=400 触发路径切换，不是 ANN

### 4.1 事实

以下臂**名义上是 ANN 配置，实测优化器放弃了 HNSW**：

| 臂 | 请求的配置 | 实际路径 | 退化条数 | P50 ms |
|---|---|---|---:|---:|
| `HNSW ef=200` | `hnsw.ef_search=200`, `enable_seqscan=off` | **FALLBACK×57** | 57/57 | 806.9 |
| `HNSW ef=400` | `hnsw.ef_search=400`, `enable_seqscan=off` | **FALLBACK×57** | 57/57 | 738.5 |

> **ef=200 / ef=400 出现路径切换，不作为 ANN 参数比较样本。**

它们的召回数字之所以等于 EXACT，是因为它们**就是**在做全量扫描 —— 不是「ANN 效果好」，而是「根本没走 ANN」。

### 4.2 退化后的真实计划（取自本轮 EXPLAIN ANALYZE，向量字面量已截断）

```
Limit  (cost=7328.62..7328.65 rows=10 width=82) (actual time=999.327..999.331 rows=10.00 loops=1)
  Buffers: shared hit=372769 read=37102
  ->  Sort  (cost=7328.62..7443.35 rows=45889 width=82) (actual time=999.326..999.327 rows=10.00 loops=1)
        Sort Key: ((c.embedding <=> '[...] [-0.016772,0.027185,-0.015085,-0.037611,-0.046282,-0.000232, …(向量字面量截断)…
        Sort Method: top-N heapsort  Memory: 27kB
        Buffers: shared hit=372769 read=37102
        ->  Merge Join  (cost=0.43..6336.98 rows=45889 width=82) (actual time=0.464..986.699 rows=46563.00 loops=1)
              Merge Cond: (c.book_id = b.id)
              Buffers: shared hit=372769 read=37102
              ->  Index Scan using discovered_book_chunks_book_idx on discovered_book_chunks c  (cost=0.29..6920.11 rows=45889 width=55) (actual time=0.065..131.273 rows=46563.00 loops=1)
                    Filter: ((embedding IS NOT NULL) AND (chapter_title IS NOT NULL))
                    Rows Removed by Filter: 11769
                    Index Searches: 1
                    Buffers: shared hit=621 read=5686
              ->  Index Scan using discovered_books_pkey on discovered_books b  (cost=0.14..24.13 rows=26 width=37) (actual time=0.008..0.178 rows=30.00 loops=1)
                    Index Searches: 1
                    Buffers: shared hit=6 read=10
Planning:
  Buffers: shared hit=5
Planning Time: 0.098 ms
Execution Time: 1125.998 ms
```

要点：它把 **46,563 行全部算一遍距离再排序**（`Sort Method: top-N heapsort`），召回等价于精确，代价却远高于 `EXACT` 臂的 Seq Scan。

**结论：ef 调大 ≠ 换到更好的 ANN。中途会踩到 FALLBACK 退化区（本轮实测在 ~160–400 之间）。**

## 5. HNSW 的 ef_search 边际收益（只统计真正走 HNSW 的臂）

### 5.1 过滤开启

- EXACT 天花板：Top1 25/47（53.2%）、Top10 41/47（87.2%）、P50 271.8 ms

| ef_search | Top1% | 距 EXACT pp | Top10% | 距 EXACT pp | P50 ms | P95 ms | 路径 |
|---:|---:|---:|---:|---:|---:|---:|---|
| 40 | 38.3% | -14.9 | 48.9% | -38.3 | 1.1 | 8.7 | HNSW×57 |
| 80 | 38.3% | -14.9 | 53.2% | -34.0 | 1.3 | 6.3 | HNSW×57 |
| 120 | 44.7% | -8.5 | 59.6% | -27.7 | 1.7 | 6.7 | HNSW×57 |
| 200 | 53.2% | — | 87.2% | — | 806.9 | 852.6 | **FALLBACK×57（非 ANN，不计入比较）** |
| 400 | 53.2% | — | 87.2% | — | 738.5 | 865.5 | **FALLBACK×57（非 ANN，不计入比较）** |
| 800 | 51.1% | -2.1 | 76.6% | -10.6 | 7.0 | 12.2 | HNSW×57 |

### 5.2 过滤关闭

- EXACT 天花板：Top1 29/53（54.7%）、Top10 41/53（77.4%）、P50 320.3 ms

| ef_search | Top1% | 距 EXACT pp | Top10% | 距 EXACT pp | P50 ms | P95 ms | 路径 |
|---:|---:|---:|---:|---:|---:|---:|---|
| 40 | 39.6% | -15.1 | 49.1% | -28.3 | 0.8 | 1.4 | HNSW×57 |
| 80 | 39.6% | -15.1 | 52.8% | -24.5 | 1.1 | 1.9 | HNSW×57 |
| 120 | 45.3% | -9.4 | 58.5% | -18.9 | 1.5 | 3.0 | HNSW×57 |
| 200 | 54.7% | — | 77.4% | — | 441.8 | 508.4 | **FALLBACK×57（非 ANN，不计入比较）** |
| 400 | 54.7% | — | 77.4% | — | 435.0 | 500.9 | **FALLBACK×57（非 ANN，不计入比较）** |
| 800 | 52.8% | -1.9 | 71.7% | -5.7 | 6.9 | 10.7 | HNSW×57 |

## 6. 今天生产实际发生的事

`默认计划` 臂 = **不动任何 GUC**，让 PG 优化器自己选 —— 这就是现在线上跑的样子。

| 项 | 实测 |
|---|---|
| 实际路径 | **HNSW×57** |
| Top1 | 18/47（38.3%） |
| Top10 | 23/47（48.9%） |
| P50 / P95 | 1.1 / 6.3 ms |
| 当时的 `hnsw.ef_search` | **40**（默认，无人改过） |

**这是一个没有任何配置变更发生的静默切换**：

- 24k 规模时，优化器判 Seq Scan（＝EXACT）更便宜 → 线上其实是精确检索；
- 规模涨到 58,332 之后，优化器改判 `hnsw_idx`（＝HNSW 近似）→ 线上变成了 ANN；
- 而 `hnsw.ef_search` 一直是默认 **40**，正是 Stage 1 曾把召回打到很低的那个值。

也就是说：**Stage B（24k）的所有结论都建立在「走 EXACT」这个前提上，在今天的生产路径上已经全部过期。**

## 7. 结论（事实，不含推断）

1. 58,332 规模下，EXACT 的天花板是 Top1 25/47（53.2%）、Top10 41/47（87.2%），P50 271.8 ms / P95 302.9 ms。
2. 不做任何干预（`默认计划` 臂）：Top1 18/47（38.3%）、P50 1.1 ms，实际路径 **HNSW×57**。
3. 真正走 HNSW 的臂里最高的是 `ann-ef800`：Top1 24/47（51.1%）、Top10 36/47（76.6%）、P50 7.0 ms。

   > ⚠️ 注意：**不是** ef=200/400。那两组虽然数字更高，但实测已切成 FALLBACK（见 §4），**不是 ANN**，不得作为「ANN 参数」引用。
4. ef_search 在 ~160–400 区间会让优化器切换到 FALLBACK 路径，延迟反而比 EXACT 更差。这条是非单调的，不是简单「ef 越大越好」。

### 7.1 判据

- 任何两组之间的 Top1 差异 **小于 2.1pp** 一律视为噪声，不据此决策。
- 只有差异超过噪声门槛、且延迟可接受时，才谈「切换」。
- 本报告不替业务做「延迟 vs 召回」的取舍，只把两条曲线的对应点摆出来（取舍方案见《发现书籍链路-Production Search Strategy.md》）。

### 7.2 本轮没做的事

- ❌ 未调整 `hnsw.ef_search`（仍为默认 40）
- ❌ 未修改 `postgresql.conf`
- ❌ 未 REINDEX 正式索引
- ❌ 未改动 API 查询 SQL / 检索路由 / 连接池配置
- ❌ 未改动前端发现页
- ❌ 未删除实验表 / 实验 JSON / 实验索引
- ❌ 未提交 Git（HEAD 仍 `f2174ba`）

## 8. 只读保证

实验前后各跑一次指纹校验：

- `fingerprint_diffs`：**[]**
- 期间主表行数 / embedding / 内容指纹 / 正式索引大小 / v1 备份**全部未变**，只读成立。

| 校验项 | 值 |
|---|---|
| books / chunks / embedding | 30 / 58,332 / 58,332 |
| content_chars | 25,625,443 |
| 内容指纹 | `770e7c8bbaca404c8418087418d1c632` |
| 正式 HNSW | {'discovered_book_chunks_embedding_hnsw_idx': 477863936} |
| v1 备份 | {'rows': 24244, 'embeddings': 24244} |
| `hnsw.ef_search` / `iterative_scan` | 40 / off |

## 附录 A · 过滤开启逐条明细

<details><summary>默认计划　路径 HNSW×57</summary>

| ID | 目标书籍 | Top1 实际 | Top1 | Top10 | 行数 | 重复稳定 | 路径 |
|---|---|---|---|---|--:|---|---|
| `FIX1` | Crime and Punishment | Crime and Punishment | ✓ | ✓ | 10 | ✓ | HNSW |
| `FIX2` | Jane Eyre | A Room with a View | ✗ | ✗ | 10 | ✓ | HNSW |
| `FIX3` | Pride and Prejudice | Middlemarch | ✗ | ✗ | 10 | ✓ | HNSW |
| `FIX4` | The Odyssey | The Odyssey
Rendered into English | ✓ | ✓ | 10 | ✓ | HNSW |
| `FIX5` | Romeo and Juliet | Romeo and Juliet | ✓ | ✓ | 10 | ✓ | HNSW |
| `FIX6` | Jane Eyre | Jane Eyre: An Autobiography | ✓ | ✓ | 10 | ✓ | HNSW |
| `S21` | Jane Eyre | Jane Eyre: An Autobiography | ✓ | ✓ | 10 | ✓ | HNSW |
| `S22` | The Mysteries of Udolpho | The Mysteries of Udolpho | ✓ | ✓ | 10 | ✓ | HNSW |
| `S24` | Crime and Punishment | The Adventures of Sherlock Holmes | ✗ | ✗ | 10 | ✓ | HNSW |
| `S25` | A Room with a View | Jane Eyre: An Autobiography | ✗ | ✗ | 10 | ✓ | HNSW |
| `S26` | The Odyssey | The Man Who Was Thursday: A Nightm | ✗ | ✗ | 10 | ✓ | HNSW |
| `S27` | Pride and Prejudice | Moby Dick; Or, The Whale | ✗ | ✗ | 10 | ✓ | HNSW |
| `S28` | Romeo and Juliet | A Room with a View | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-1` | Carmen | The Odyssey
Rendered into English | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-2` | The Man Who Was Thursday | The Extraordinary Adventures of Ar | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-3` | Jane Eyre | A Room with a View | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-4` | Pride and Prejudice | Jane Eyre: An Autobiography | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-5` | Crime and Punishment | Jane Eyre: An Autobiography | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-6` | Romeo and Juliet | Eloisa : $b or, A series of origin | ✗ | ✓ | 10 | ✓ | HNSW |
| `B5-7` | Alice's Adventures in Wonderland | Alice's Adventures in Wonderland | ✓ | ✓ | 10 | ✓ | HNSW |
| `B5-8` | Alice's Adventures in Wonderland | The Mystery of Edwin Drood | ✗ | ✓ | 10 | ✓ | HNSW |
| `B5-10` | Thuvia, maid of Mars | Thuvia, maid of Mars | ✓ | ✓ | 10 | ✓ | HNSW |
| `B5-11` | Thuvia, maid of Mars | The Odyssey
Rendered into English | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-12` | Middlemarch | Middlemarch | ✓ | ✓ | 10 | ✓ | HNSW |
| `B5-13` | Middlemarch | The Adventures of Sherlock Holmes | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-14` | Dracula | Moby Dick; Or, The Whale | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-15` | Dracula | Dracula | ✓ | ✓ | 10 | ✓ | HNSW |
| `B5-17` | The Monk: A Romance | The Monk: A Romance | ✓ | ✓ | 10 | ✓ | HNSW |
| `B5-18` | Moby Dick | Moby Dick; Or, The Whale | ✓ | ✓ | 10 | ✓ | HNSW |
| `B5-19` | Moby Dick | Moby Dick; Or, The Whale | ✓ | ✓ | 10 | ✓ | HNSW |
| `B5-20` | The Green Mummy | The Green Mummy | ✓ | ✓ | 10 | ✓ | HNSW |
| `B5-22` | The Confessions of St. Augustine | A Room with a View | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-23` | The Confessions of St. Augustine | Middlemarch | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-24` | The Extraordinary Adventures of Ar | The Adventures of Sherlock Holmes | ✗ | ✓ | 10 | ✓ | HNSW |
| `B5-25` | The Extraordinary Adventures of Ar | The Extraordinary Adventures of Ar | ✓ | ✓ | 10 | ✓ | HNSW |
| `B5-26` | Sense and Sensibility | Sense and Sensibility | ✓ | ✓ | 10 | ✓ | HNSW |
| `B5-27` | Sense and Sensibility | Jane Eyre: An Autobiography | ✗ | ✓ | 10 | ✓ | HNSW |
| `B5-30` | The Blue Castle | Crime and Punishment | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-31` | The Blue Castle | A farewell to arms | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-32` | A farewell to arms | A farewell to arms | ✓ | ✓ | 10 | ✓ | HNSW |
| `B5-33` | A farewell to arms | The Mysteries of Udolpho | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-34` | Eloisa | Eloisa : $b or, A series of origin | ✓ | ✓ | 10 | ✓ | HNSW |
| `B5-35` | Eloisa | Middlemarch | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-36` | The Adventures of Sherlock Holmes | The Extraordinary Adventures of Ar | ✗ | ✓ | 10 | ✓ | HNSW |
| `B5-37` | The Adventures of Sherlock Holmes | A Room with a View | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-38` | The Mystery of Edwin Drood | The Green Mummy | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-39` | The Mystery of Edwin Drood | The Blue Castle: a novel | ✗ | ✗ | 10 | ✓ | HNSW |

</details>

<details><summary>强制 EXACT　路径 EXACT×57</summary>

| ID | 目标书籍 | Top1 实际 | Top1 | Top10 | 行数 | 重复稳定 | 路径 |
|---|---|---|---|---|--:|---|---|
| `FIX1` | Crime and Punishment | Crime and Punishment | ✓ | ✓ | 10 | ✓ | EXACT |
| `FIX2` | Jane Eyre | The Green Mummy | ✗ | ✓ | 10 | ✓ | EXACT |
| `FIX3` | Pride and Prejudice | Pride and Prejudice | ✓ | ✓ | 10 | ✓ | EXACT |
| `FIX4` | The Odyssey | The Odyssey
Rendered into English | ✓ | ✓ | 10 | ✓ | EXACT |
| `FIX5` | Romeo and Juliet | Romeo and Juliet | ✓ | ✓ | 10 | ✓ | EXACT |
| `FIX6` | Jane Eyre | Jane Eyre: An Autobiography | ✓ | ✓ | 10 | ✓ | EXACT |
| `S21` | Jane Eyre | Jane Eyre: An Autobiography | ✓ | ✓ | 10 | ✓ | EXACT |
| `S22` | The Mysteries of Udolpho | The Blue Castle: a novel | ✗ | ✓ | 10 | ✓ | EXACT |
| `S24` | Crime and Punishment | Crime and Punishment | ✓ | ✓ | 10 | ✓ | EXACT |
| `S25` | A Room with a View | Jane Eyre: An Autobiography | ✗ | ✓ | 10 | ✓ | EXACT |
| `S26` | The Odyssey | The Man Who Was Thursday: A Nightm | ✗ | ✗ | 10 | ✓ | EXACT |
| `S27` | Pride and Prejudice | Pride and Prejudice | ✓ | ✓ | 10 | ✓ | EXACT |
| `S28` | Romeo and Juliet | A Room with a View | ✗ | ✓ | 10 | ✓ | EXACT |
| `B5-1` | Carmen | Middlemarch | ✗ | ✓ | 10 | ✓ | EXACT |
| `B5-2` | The Man Who Was Thursday | The Man Who Was Thursday: A Nightm | ✓ | ✓ | 10 | ✓ | EXACT |
| `B5-3` | Jane Eyre | Jane Eyre: An Autobiography | ✓ | ✓ | 10 | ✓ | EXACT |
| `B5-4` | Pride and Prejudice | Pride and Prejudice | ✓ | ✓ | 10 | ✓ | EXACT |
| `B5-5` | Crime and Punishment | Crime and Punishment | ✓ | ✓ | 10 | ✓ | EXACT |
| `B5-6` | Romeo and Juliet | Eloisa : $b or, A series of origin | ✗ | ✓ | 10 | ✓ | EXACT |
| `B5-7` | Alice's Adventures in Wonderland | Alice's Adventures in Wonderland | ✓ | ✓ | 10 | ✓ | EXACT |
| `B5-8` | Alice's Adventures in Wonderland | Carmen | ✗ | ✓ | 10 | ✓ | EXACT |
| `B5-10` | Thuvia, maid of Mars | Thuvia, maid of Mars | ✓ | ✓ | 10 | ✓ | EXACT |
| `B5-11` | Thuvia, maid of Mars | The Man Who Was Thursday: A Nightm | ✗ | ✗ | 10 | ✓ | EXACT |
| `B5-12` | Middlemarch | Sense and Sensibility | ✗ | ✓ | 10 | ✓ | EXACT |
| `B5-13` | Middlemarch | A Room with a View | ✗ | ✓ | 10 | ✓ | EXACT |
| `B5-14` | Dracula | Moby Dick; Or, The Whale | ✗ | ✓ | 10 | ✓ | EXACT |
| `B5-15` | Dracula | Dracula | ✓ | ✓ | 10 | ✓ | EXACT |
| `B5-17` | The Monk: A Romance | The Monk: A Romance | ✓ | ✓ | 10 | ✓ | EXACT |
| `B5-18` | Moby Dick | Moby Dick; Or, The Whale | ✓ | ✓ | 10 | ✓ | EXACT |
| `B5-19` | Moby Dick | The Green Mummy | ✗ | ✓ | 10 | ✓ | EXACT |
| `B5-20` | The Green Mummy | The Green Mummy | ✓ | ✓ | 10 | ✓ | EXACT |
| `B5-22` | The Confessions of St. Augustine | A Room with a View | ✗ | ✓ | 10 | ✓ | EXACT |
| `B5-23` | The Confessions of St. Augustine | The Confessions of St. Augustine | ✓ | ✓ | 10 | ✓ | EXACT |
| `B5-24` | The Extraordinary Adventures of Ar | The Extraordinary Adventures of Ar | ✓ | ✓ | 10 | ✓ | EXACT |
| `B5-25` | The Extraordinary Adventures of Ar | Crime and Punishment | ✗ | ✓ | 10 | ✓ | EXACT |
| `B5-26` | Sense and Sensibility | Sense and Sensibility | ✓ | ✓ | 10 | ✓ | EXACT |
| `B5-27` | Sense and Sensibility | Sense and Sensibility | ✓ | ✓ | 10 | ✓ | EXACT |
| `B5-30` | The Blue Castle | Crime and Punishment | ✗ | ✗ | 10 | ✓ | EXACT |
| `B5-31` | The Blue Castle | Jane Eyre: An Autobiography | ✗ | ✗ | 10 | ✓ | EXACT |
| `B5-32` | A farewell to arms | A farewell to arms | ✓ | ✓ | 10 | ✓ | EXACT |
| `B5-33` | A farewell to arms | A farewell to arms | ✓ | ✓ | 10 | ✓ | EXACT |
| `B5-34` | Eloisa | Jane Eyre: An Autobiography | ✗ | ✓ | 10 | ✓ | EXACT |
| `B5-35` | Eloisa | Sense and Sensibility | ✗ | ✓ | 10 | ✓ | EXACT |
| `B5-36` | The Adventures of Sherlock Holmes | The Extraordinary Adventures of Ar | ✗ | ✓ | 10 | ✓ | EXACT |
| `B5-37` | The Adventures of Sherlock Holmes | The Man Who Was Thursday: A Nightm | ✗ | ✗ | 10 | ✓ | EXACT |
| `B5-38` | The Mystery of Edwin Drood | The Mystery of Edwin Drood | ✓ | ✓ | 10 | ✓ | EXACT |
| `B5-39` | The Mystery of Edwin Drood | The Blue Castle: a novel | ✗ | ✗ | 10 | ✓ | EXACT |

</details>

<details><summary>HNSW ef=40　路径 HNSW×57</summary>

| ID | 目标书籍 | Top1 实际 | Top1 | Top10 | 行数 | 重复稳定 | 路径 |
|---|---|---|---|---|--:|---|---|
| `FIX1` | Crime and Punishment | Crime and Punishment | ✓ | ✓ | 10 | ✓ | HNSW |
| `FIX2` | Jane Eyre | A Room with a View | ✗ | ✗ | 10 | ✓ | HNSW |
| `FIX3` | Pride and Prejudice | Middlemarch | ✗ | ✗ | 10 | ✓ | HNSW |
| `FIX4` | The Odyssey | The Odyssey
Rendered into English | ✓ | ✓ | 10 | ✓ | HNSW |
| `FIX5` | Romeo and Juliet | Romeo and Juliet | ✓ | ✓ | 10 | ✓ | HNSW |
| `FIX6` | Jane Eyre | Jane Eyre: An Autobiography | ✓ | ✓ | 10 | ✓ | HNSW |
| `S21` | Jane Eyre | Jane Eyre: An Autobiography | ✓ | ✓ | 10 | ✓ | HNSW |
| `S22` | The Mysteries of Udolpho | The Mysteries of Udolpho | ✓ | ✓ | 10 | ✓ | HNSW |
| `S24` | Crime and Punishment | The Adventures of Sherlock Holmes | ✗ | ✗ | 10 | ✓ | HNSW |
| `S25` | A Room with a View | Jane Eyre: An Autobiography | ✗ | ✗ | 10 | ✓ | HNSW |
| `S26` | The Odyssey | The Man Who Was Thursday: A Nightm | ✗ | ✗ | 10 | ✓ | HNSW |
| `S27` | Pride and Prejudice | Moby Dick; Or, The Whale | ✗ | ✗ | 10 | ✓ | HNSW |
| `S28` | Romeo and Juliet | A Room with a View | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-1` | Carmen | The Odyssey
Rendered into English | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-2` | The Man Who Was Thursday | The Extraordinary Adventures of Ar | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-3` | Jane Eyre | A Room with a View | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-4` | Pride and Prejudice | Jane Eyre: An Autobiography | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-5` | Crime and Punishment | Jane Eyre: An Autobiography | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-6` | Romeo and Juliet | Eloisa : $b or, A series of origin | ✗ | ✓ | 10 | ✓ | HNSW |
| `B5-7` | Alice's Adventures in Wonderland | Alice's Adventures in Wonderland | ✓ | ✓ | 10 | ✓ | HNSW |
| `B5-8` | Alice's Adventures in Wonderland | The Mystery of Edwin Drood | ✗ | ✓ | 10 | ✓ | HNSW |
| `B5-10` | Thuvia, maid of Mars | Thuvia, maid of Mars | ✓ | ✓ | 10 | ✓ | HNSW |
| `B5-11` | Thuvia, maid of Mars | The Odyssey
Rendered into English | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-12` | Middlemarch | Middlemarch | ✓ | ✓ | 10 | ✓ | HNSW |
| `B5-13` | Middlemarch | The Adventures of Sherlock Holmes | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-14` | Dracula | Moby Dick; Or, The Whale | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-15` | Dracula | Dracula | ✓ | ✓ | 10 | ✓ | HNSW |
| `B5-17` | The Monk: A Romance | The Monk: A Romance | ✓ | ✓ | 10 | ✓ | HNSW |
| `B5-18` | Moby Dick | Moby Dick; Or, The Whale | ✓ | ✓ | 10 | ✓ | HNSW |
| `B5-19` | Moby Dick | Moby Dick; Or, The Whale | ✓ | ✓ | 10 | ✓ | HNSW |
| `B5-20` | The Green Mummy | The Green Mummy | ✓ | ✓ | 10 | ✓ | HNSW |
| `B5-22` | The Confessions of St. Augustine | A Room with a View | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-23` | The Confessions of St. Augustine | Middlemarch | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-24` | The Extraordinary Adventures of Ar | The Adventures of Sherlock Holmes | ✗ | ✓ | 10 | ✓ | HNSW |
| `B5-25` | The Extraordinary Adventures of Ar | The Extraordinary Adventures of Ar | ✓ | ✓ | 10 | ✓ | HNSW |
| `B5-26` | Sense and Sensibility | Sense and Sensibility | ✓ | ✓ | 10 | ✓ | HNSW |
| `B5-27` | Sense and Sensibility | Jane Eyre: An Autobiography | ✗ | ✓ | 10 | ✓ | HNSW |
| `B5-30` | The Blue Castle | Crime and Punishment | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-31` | The Blue Castle | A farewell to arms | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-32` | A farewell to arms | A farewell to arms | ✓ | ✓ | 10 | ✓ | HNSW |
| `B5-33` | A farewell to arms | The Mysteries of Udolpho | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-34` | Eloisa | Eloisa : $b or, A series of origin | ✓ | ✓ | 10 | ✓ | HNSW |
| `B5-35` | Eloisa | Middlemarch | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-36` | The Adventures of Sherlock Holmes | The Extraordinary Adventures of Ar | ✗ | ✓ | 10 | ✓ | HNSW |
| `B5-37` | The Adventures of Sherlock Holmes | A Room with a View | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-38` | The Mystery of Edwin Drood | The Green Mummy | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-39` | The Mystery of Edwin Drood | The Blue Castle: a novel | ✗ | ✗ | 10 | ✓ | HNSW |

</details>

<details><summary>HNSW ef=80　路径 HNSW×57</summary>

| ID | 目标书籍 | Top1 实际 | Top1 | Top10 | 行数 | 重复稳定 | 路径 |
|---|---|---|---|---|--:|---|---|
| `FIX1` | Crime and Punishment | Crime and Punishment | ✓ | ✓ | 10 | ✓ | HNSW |
| `FIX2` | Jane Eyre | The Green Mummy | ✗ | ✗ | 10 | ✓ | HNSW |
| `FIX3` | Pride and Prejudice | Middlemarch | ✗ | ✗ | 10 | ✓ | HNSW |
| `FIX4` | The Odyssey | The Odyssey
Rendered into English | ✓ | ✓ | 10 | ✓ | HNSW |
| `FIX5` | Romeo and Juliet | Romeo and Juliet | ✓ | ✓ | 10 | ✓ | HNSW |
| `FIX6` | Jane Eyre | Jane Eyre: An Autobiography | ✓ | ✓ | 10 | ✓ | HNSW |
| `S21` | Jane Eyre | Jane Eyre: An Autobiography | ✓ | ✓ | 10 | ✓ | HNSW |
| `S22` | The Mysteries of Udolpho | The Blue Castle: a novel | ✗ | ✓ | 10 | ✓ | HNSW |
| `S24` | Crime and Punishment | The Adventures of Sherlock Holmes | ✗ | ✗ | 10 | ✓ | HNSW |
| `S25` | A Room with a View | Jane Eyre: An Autobiography | ✗ | ✗ | 10 | ✓ | HNSW |
| `S26` | The Odyssey | The Man Who Was Thursday: A Nightm | ✗ | ✓ | 10 | ✓ | HNSW |
| `S27` | Pride and Prejudice | The Green Mummy | ✗ | ✗ | 10 | ✓ | HNSW |
| `S28` | Romeo and Juliet | A Room with a View | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-1` | Carmen | The Odyssey
Rendered into English | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-2` | The Man Who Was Thursday | The Extraordinary Adventures of Ar | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-3` | Jane Eyre | A Room with a View | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-4` | Pride and Prejudice | Pride and Prejudice | ✓ | ✓ | 10 | ✓ | HNSW |
| `B5-5` | Crime and Punishment | Jane Eyre: An Autobiography | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-6` | Romeo and Juliet | Eloisa : $b or, A series of origin | ✗ | ✓ | 10 | ✓ | HNSW |
| `B5-7` | Alice's Adventures in Wonderland | Alice's Adventures in Wonderland | ✓ | ✓ | 10 | ✓ | HNSW |
| `B5-8` | Alice's Adventures in Wonderland | The Mystery of Edwin Drood | ✗ | ✓ | 10 | ✓ | HNSW |
| `B5-10` | Thuvia, maid of Mars | Thuvia, maid of Mars | ✓ | ✓ | 10 | ✓ | HNSW |
| `B5-11` | Thuvia, maid of Mars | The Odyssey
Rendered into English | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-12` | Middlemarch | Middlemarch | ✓ | ✓ | 10 | ✓ | HNSW |
| `B5-13` | Middlemarch | The Adventures of Sherlock Holmes | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-14` | Dracula | Moby Dick; Or, The Whale | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-15` | Dracula | Dracula | ✓ | ✓ | 10 | ✓ | HNSW |
| `B5-17` | The Monk: A Romance | The Monk: A Romance | ✓ | ✓ | 10 | ✓ | HNSW |
| `B5-18` | Moby Dick | Moby Dick; Or, The Whale | ✓ | ✓ | 10 | ✓ | HNSW |
| `B5-19` | Moby Dick | Moby Dick; Or, The Whale | ✓ | ✓ | 10 | ✓ | HNSW |
| `B5-20` | The Green Mummy | The Green Mummy | ✓ | ✓ | 10 | ✓ | HNSW |
| `B5-22` | The Confessions of St. Augustine | A Room with a View | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-23` | The Confessions of St. Augustine | Middlemarch | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-24` | The Extraordinary Adventures of Ar | The Adventures of Sherlock Holmes | ✗ | ✓ | 10 | ✓ | HNSW |
| `B5-25` | The Extraordinary Adventures of Ar | The Extraordinary Adventures of Ar | ✓ | ✓ | 10 | ✓ | HNSW |
| `B5-26` | Sense and Sensibility | Sense and Sensibility | ✓ | ✓ | 10 | ✓ | HNSW |
| `B5-27` | Sense and Sensibility | Sense and Sensibility | ✓ | ✓ | 10 | ✓ | HNSW |
| `B5-30` | The Blue Castle | Crime and Punishment | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-31` | The Blue Castle | Jane Eyre: An Autobiography | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-32` | A farewell to arms | A farewell to arms | ✓ | ✓ | 10 | ✓ | HNSW |
| `B5-33` | A farewell to arms | The Mysteries of Udolpho | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-34` | Eloisa | Middlemarch | ✗ | ✓ | 10 | ✓ | HNSW |
| `B5-35` | Eloisa | Middlemarch | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-36` | The Adventures of Sherlock Holmes | The Extraordinary Adventures of Ar | ✗ | ✓ | 10 | ✓ | HNSW |
| `B5-37` | The Adventures of Sherlock Holmes | Crime and Punishment | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-38` | The Mystery of Edwin Drood | The Green Mummy | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-39` | The Mystery of Edwin Drood | The Blue Castle: a novel | ✗ | ✗ | 10 | ✓ | HNSW |

</details>

<details><summary>HNSW ef=120　路径 HNSW×57</summary>

| ID | 目标书籍 | Top1 实际 | Top1 | Top10 | 行数 | 重复稳定 | 路径 |
|---|---|---|---|---|--:|---|---|
| `FIX1` | Crime and Punishment | Crime and Punishment | ✓ | ✓ | 10 | ✓ | HNSW |
| `FIX2` | Jane Eyre | The Green Mummy | ✗ | ✗ | 10 | ✓ | HNSW |
| `FIX3` | Pride and Prejudice | Middlemarch | ✗ | ✗ | 10 | ✓ | HNSW |
| `FIX4` | The Odyssey | The Odyssey
Rendered into English | ✓ | ✓ | 10 | ✓ | HNSW |
| `FIX5` | Romeo and Juliet | Romeo and Juliet | ✓ | ✓ | 10 | ✓ | HNSW |
| `FIX6` | Jane Eyre | Jane Eyre: An Autobiography | ✓ | ✓ | 10 | ✓ | HNSW |
| `S21` | Jane Eyre | Jane Eyre: An Autobiography | ✓ | ✓ | 10 | ✓ | HNSW |
| `S22` | The Mysteries of Udolpho | The Blue Castle: a novel | ✗ | ✓ | 10 | ✓ | HNSW |
| `S24` | Crime and Punishment | Crime and Punishment | ✓ | ✓ | 10 | ✓ | HNSW |
| `S25` | A Room with a View | Jane Eyre: An Autobiography | ✗ | ✗ | 10 | ✓ | HNSW |
| `S26` | The Odyssey | The Man Who Was Thursday: A Nightm | ✗ | ✓ | 10 | ✓ | HNSW |
| `S27` | Pride and Prejudice | The Green Mummy | ✗ | ✗ | 10 | ✓ | HNSW |
| `S28` | Romeo and Juliet | A Room with a View | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-1` | Carmen | The Odyssey
Rendered into English | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-2` | The Man Who Was Thursday | The Extraordinary Adventures of Ar | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-3` | Jane Eyre | A Room with a View | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-4` | Pride and Prejudice | Pride and Prejudice | ✓ | ✓ | 10 | ✓ | HNSW |
| `B5-5` | Crime and Punishment | Jane Eyre: An Autobiography | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-6` | Romeo and Juliet | Eloisa : $b or, A series of origin | ✗ | ✓ | 10 | ✓ | HNSW |
| `B5-7` | Alice's Adventures in Wonderland | Alice's Adventures in Wonderland | ✓ | ✓ | 10 | ✓ | HNSW |
| `B5-8` | Alice's Adventures in Wonderland | The Mystery of Edwin Drood | ✗ | ✓ | 10 | ✓ | HNSW |
| `B5-10` | Thuvia, maid of Mars | Thuvia, maid of Mars | ✓ | ✓ | 10 | ✓ | HNSW |
| `B5-11` | Thuvia, maid of Mars | The Odyssey
Rendered into English | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-12` | Middlemarch | Middlemarch | ✓ | ✓ | 10 | ✓ | HNSW |
| `B5-13` | Middlemarch | The Adventures of Sherlock Holmes | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-14` | Dracula | Moby Dick; Or, The Whale | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-15` | Dracula | Dracula | ✓ | ✓ | 10 | ✓ | HNSW |
| `B5-17` | The Monk: A Romance | The Monk: A Romance | ✓ | ✓ | 10 | ✓ | HNSW |
| `B5-18` | Moby Dick | Moby Dick; Or, The Whale | ✓ | ✓ | 10 | ✓ | HNSW |
| `B5-19` | Moby Dick | Moby Dick; Or, The Whale | ✓ | ✓ | 10 | ✓ | HNSW |
| `B5-20` | The Green Mummy | The Green Mummy | ✓ | ✓ | 10 | ✓ | HNSW |
| `B5-22` | The Confessions of St. Augustine | A Room with a View | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-23` | The Confessions of St. Augustine | Middlemarch | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-24` | The Extraordinary Adventures of Ar | The Adventures of Sherlock Holmes | ✗ | ✓ | 10 | ✓ | HNSW |
| `B5-25` | The Extraordinary Adventures of Ar | The Extraordinary Adventures of Ar | ✓ | ✓ | 10 | ✓ | HNSW |
| `B5-26` | Sense and Sensibility | Sense and Sensibility | ✓ | ✓ | 10 | ✓ | HNSW |
| `B5-27` | Sense and Sensibility | Sense and Sensibility | ✓ | ✓ | 10 | ✓ | HNSW |
| `B5-30` | The Blue Castle | Crime and Punishment | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-31` | The Blue Castle | Jane Eyre: An Autobiography | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-32` | A farewell to arms | A farewell to arms | ✓ | ✓ | 10 | ✓ | HNSW |
| `B5-33` | A farewell to arms | A farewell to arms | ✓ | ✓ | 10 | ✓ | HNSW |
| `B5-34` | Eloisa | Middlemarch | ✗ | ✓ | 10 | ✓ | HNSW |
| `B5-35` | Eloisa | Middlemarch | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-36` | The Adventures of Sherlock Holmes | The Extraordinary Adventures of Ar | ✗ | ✓ | 10 | ✓ | HNSW |
| `B5-37` | The Adventures of Sherlock Holmes | Crime and Punishment | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-38` | The Mystery of Edwin Drood | The Mystery of Edwin Drood | ✓ | ✓ | 10 | ✓ | HNSW |
| `B5-39` | The Mystery of Edwin Drood | The Blue Castle: a novel | ✗ | ✗ | 10 | ✓ | HNSW |

</details>

<details><summary>HNSW ef=200　路径 FALLBACK×57</summary>

| ID | 目标书籍 | Top1 实际 | Top1 | Top10 | 行数 | 重复稳定 | 路径 |
|---|---|---|---|---|--:|---|---|
| `FIX1` | Crime and Punishment | Crime and Punishment | ✓ | ✓ | 10 | ✓ | FALLBACK |
| `FIX2` | Jane Eyre | The Green Mummy | ✗ | ✓ | 10 | ✓ | FALLBACK |
| `FIX3` | Pride and Prejudice | Pride and Prejudice | ✓ | ✓ | 10 | ✓ | FALLBACK |
| `FIX4` | The Odyssey | The Odyssey
Rendered into English | ✓ | ✓ | 10 | ✓ | FALLBACK |
| `FIX5` | Romeo and Juliet | Romeo and Juliet | ✓ | ✓ | 10 | ✓ | FALLBACK |
| `FIX6` | Jane Eyre | Jane Eyre: An Autobiography | ✓ | ✓ | 10 | ✓ | FALLBACK |
| `S21` | Jane Eyre | Jane Eyre: An Autobiography | ✓ | ✓ | 10 | ✓ | FALLBACK |
| `S22` | The Mysteries of Udolpho | The Blue Castle: a novel | ✗ | ✓ | 10 | ✓ | FALLBACK |
| `S24` | Crime and Punishment | Crime and Punishment | ✓ | ✓ | 10 | ✓ | FALLBACK |
| `S25` | A Room with a View | Jane Eyre: An Autobiography | ✗ | ✓ | 10 | ✓ | FALLBACK |
| `S26` | The Odyssey | The Man Who Was Thursday: A Nightm | ✗ | ✗ | 10 | ✓ | FALLBACK |
| `S27` | Pride and Prejudice | Pride and Prejudice | ✓ | ✓ | 10 | ✓ | FALLBACK |
| `S28` | Romeo and Juliet | A Room with a View | ✗ | ✓ | 10 | ✓ | FALLBACK |
| `B5-1` | Carmen | Middlemarch | ✗ | ✓ | 10 | ✓ | FALLBACK |
| `B5-2` | The Man Who Was Thursday | The Man Who Was Thursday: A Nightm | ✓ | ✓ | 10 | ✓ | FALLBACK |
| `B5-3` | Jane Eyre | Jane Eyre: An Autobiography | ✓ | ✓ | 10 | ✓ | FALLBACK |
| `B5-4` | Pride and Prejudice | Pride and Prejudice | ✓ | ✓ | 10 | ✓ | FALLBACK |
| `B5-5` | Crime and Punishment | Crime and Punishment | ✓ | ✓ | 10 | ✓ | FALLBACK |
| `B5-6` | Romeo and Juliet | Eloisa : $b or, A series of origin | ✗ | ✓ | 10 | ✓ | FALLBACK |
| `B5-7` | Alice's Adventures in Wonderland | Alice's Adventures in Wonderland | ✓ | ✓ | 10 | ✓ | FALLBACK |
| `B5-8` | Alice's Adventures in Wonderland | Carmen | ✗ | ✓ | 10 | ✓ | FALLBACK |
| `B5-10` | Thuvia, maid of Mars | Thuvia, maid of Mars | ✓ | ✓ | 10 | ✓ | FALLBACK |
| `B5-11` | Thuvia, maid of Mars | The Man Who Was Thursday: A Nightm | ✗ | ✗ | 10 | ✓ | FALLBACK |
| `B5-12` | Middlemarch | Sense and Sensibility | ✗ | ✓ | 10 | ✓ | FALLBACK |
| `B5-13` | Middlemarch | A Room with a View | ✗ | ✓ | 10 | ✓ | FALLBACK |
| `B5-14` | Dracula | Moby Dick; Or, The Whale | ✗ | ✓ | 10 | ✓ | FALLBACK |
| `B5-15` | Dracula | Dracula | ✓ | ✓ | 10 | ✓ | FALLBACK |
| `B5-17` | The Monk: A Romance | The Monk: A Romance | ✓ | ✓ | 10 | ✓ | FALLBACK |
| `B5-18` | Moby Dick | Moby Dick; Or, The Whale | ✓ | ✓ | 10 | ✓ | FALLBACK |
| `B5-19` | Moby Dick | The Green Mummy | ✗ | ✓ | 10 | ✓ | FALLBACK |
| `B5-20` | The Green Mummy | The Green Mummy | ✓ | ✓ | 10 | ✓ | FALLBACK |
| `B5-22` | The Confessions of St. Augustine | A Room with a View | ✗ | ✓ | 10 | ✓ | FALLBACK |
| `B5-23` | The Confessions of St. Augustine | The Confessions of St. Augustine | ✓ | ✓ | 10 | ✓ | FALLBACK |
| `B5-24` | The Extraordinary Adventures of Ar | The Extraordinary Adventures of Ar | ✓ | ✓ | 10 | ✓ | FALLBACK |
| `B5-25` | The Extraordinary Adventures of Ar | Crime and Punishment | ✗ | ✓ | 10 | ✓ | FALLBACK |
| `B5-26` | Sense and Sensibility | Sense and Sensibility | ✓ | ✓ | 10 | ✓ | FALLBACK |
| `B5-27` | Sense and Sensibility | Sense and Sensibility | ✓ | ✓ | 10 | ✓ | FALLBACK |
| `B5-30` | The Blue Castle | Crime and Punishment | ✗ | ✗ | 10 | ✓ | FALLBACK |
| `B5-31` | The Blue Castle | Jane Eyre: An Autobiography | ✗ | ✗ | 10 | ✓ | FALLBACK |
| `B5-32` | A farewell to arms | A farewell to arms | ✓ | ✓ | 10 | ✓ | FALLBACK |
| `B5-33` | A farewell to arms | A farewell to arms | ✓ | ✓ | 10 | ✓ | FALLBACK |
| `B5-34` | Eloisa | Jane Eyre: An Autobiography | ✗ | ✓ | 10 | ✓ | FALLBACK |
| `B5-35` | Eloisa | Sense and Sensibility | ✗ | ✓ | 10 | ✓ | FALLBACK |
| `B5-36` | The Adventures of Sherlock Holmes | The Extraordinary Adventures of Ar | ✗ | ✓ | 10 | ✓ | FALLBACK |
| `B5-37` | The Adventures of Sherlock Holmes | The Man Who Was Thursday: A Nightm | ✗ | ✗ | 10 | ✓ | FALLBACK |
| `B5-38` | The Mystery of Edwin Drood | The Mystery of Edwin Drood | ✓ | ✓ | 10 | ✓ | FALLBACK |
| `B5-39` | The Mystery of Edwin Drood | The Blue Castle: a novel | ✗ | ✗ | 10 | ✓ | FALLBACK |

</details>

<details><summary>HNSW ef=400　路径 FALLBACK×57</summary>

| ID | 目标书籍 | Top1 实际 | Top1 | Top10 | 行数 | 重复稳定 | 路径 |
|---|---|---|---|---|--:|---|---|
| `FIX1` | Crime and Punishment | Crime and Punishment | ✓ | ✓ | 10 | ✓ | FALLBACK |
| `FIX2` | Jane Eyre | The Green Mummy | ✗ | ✓ | 10 | ✓ | FALLBACK |
| `FIX3` | Pride and Prejudice | Pride and Prejudice | ✓ | ✓ | 10 | ✓ | FALLBACK |
| `FIX4` | The Odyssey | The Odyssey
Rendered into English | ✓ | ✓ | 10 | ✓ | FALLBACK |
| `FIX5` | Romeo and Juliet | Romeo and Juliet | ✓ | ✓ | 10 | ✓ | FALLBACK |
| `FIX6` | Jane Eyre | Jane Eyre: An Autobiography | ✓ | ✓ | 10 | ✓ | FALLBACK |
| `S21` | Jane Eyre | Jane Eyre: An Autobiography | ✓ | ✓ | 10 | ✓ | FALLBACK |
| `S22` | The Mysteries of Udolpho | The Blue Castle: a novel | ✗ | ✓ | 10 | ✓ | FALLBACK |
| `S24` | Crime and Punishment | Crime and Punishment | ✓ | ✓ | 10 | ✓ | FALLBACK |
| `S25` | A Room with a View | Jane Eyre: An Autobiography | ✗ | ✓ | 10 | ✓ | FALLBACK |
| `S26` | The Odyssey | The Man Who Was Thursday: A Nightm | ✗ | ✗ | 10 | ✓ | FALLBACK |
| `S27` | Pride and Prejudice | Pride and Prejudice | ✓ | ✓ | 10 | ✓ | FALLBACK |
| `S28` | Romeo and Juliet | A Room with a View | ✗ | ✓ | 10 | ✓ | FALLBACK |
| `B5-1` | Carmen | Middlemarch | ✗ | ✓ | 10 | ✓ | FALLBACK |
| `B5-2` | The Man Who Was Thursday | The Man Who Was Thursday: A Nightm | ✓ | ✓ | 10 | ✓ | FALLBACK |
| `B5-3` | Jane Eyre | Jane Eyre: An Autobiography | ✓ | ✓ | 10 | ✓ | FALLBACK |
| `B5-4` | Pride and Prejudice | Pride and Prejudice | ✓ | ✓ | 10 | ✓ | FALLBACK |
| `B5-5` | Crime and Punishment | Crime and Punishment | ✓ | ✓ | 10 | ✓ | FALLBACK |
| `B5-6` | Romeo and Juliet | Eloisa : $b or, A series of origin | ✗ | ✓ | 10 | ✓ | FALLBACK |
| `B5-7` | Alice's Adventures in Wonderland | Alice's Adventures in Wonderland | ✓ | ✓ | 10 | ✓ | FALLBACK |
| `B5-8` | Alice's Adventures in Wonderland | Carmen | ✗ | ✓ | 10 | ✓ | FALLBACK |
| `B5-10` | Thuvia, maid of Mars | Thuvia, maid of Mars | ✓ | ✓ | 10 | ✓ | FALLBACK |
| `B5-11` | Thuvia, maid of Mars | The Man Who Was Thursday: A Nightm | ✗ | ✗ | 10 | ✓ | FALLBACK |
| `B5-12` | Middlemarch | Sense and Sensibility | ✗ | ✓ | 10 | ✓ | FALLBACK |
| `B5-13` | Middlemarch | A Room with a View | ✗ | ✓ | 10 | ✓ | FALLBACK |
| `B5-14` | Dracula | Moby Dick; Or, The Whale | ✗ | ✓ | 10 | ✓ | FALLBACK |
| `B5-15` | Dracula | Dracula | ✓ | ✓ | 10 | ✓ | FALLBACK |
| `B5-17` | The Monk: A Romance | The Monk: A Romance | ✓ | ✓ | 10 | ✓ | FALLBACK |
| `B5-18` | Moby Dick | Moby Dick; Or, The Whale | ✓ | ✓ | 10 | ✓ | FALLBACK |
| `B5-19` | Moby Dick | The Green Mummy | ✗ | ✓ | 10 | ✓ | FALLBACK |
| `B5-20` | The Green Mummy | The Green Mummy | ✓ | ✓ | 10 | ✓ | FALLBACK |
| `B5-22` | The Confessions of St. Augustine | A Room with a View | ✗ | ✓ | 10 | ✓ | FALLBACK |
| `B5-23` | The Confessions of St. Augustine | The Confessions of St. Augustine | ✓ | ✓ | 10 | ✓ | FALLBACK |
| `B5-24` | The Extraordinary Adventures of Ar | The Extraordinary Adventures of Ar | ✓ | ✓ | 10 | ✓ | FALLBACK |
| `B5-25` | The Extraordinary Adventures of Ar | Crime and Punishment | ✗ | ✓ | 10 | ✓ | FALLBACK |
| `B5-26` | Sense and Sensibility | Sense and Sensibility | ✓ | ✓ | 10 | ✓ | FALLBACK |
| `B5-27` | Sense and Sensibility | Sense and Sensibility | ✓ | ✓ | 10 | ✓ | FALLBACK |
| `B5-30` | The Blue Castle | Crime and Punishment | ✗ | ✗ | 10 | ✓ | FALLBACK |
| `B5-31` | The Blue Castle | Jane Eyre: An Autobiography | ✗ | ✗ | 10 | ✓ | FALLBACK |
| `B5-32` | A farewell to arms | A farewell to arms | ✓ | ✓ | 10 | ✓ | FALLBACK |
| `B5-33` | A farewell to arms | A farewell to arms | ✓ | ✓ | 10 | ✓ | FALLBACK |
| `B5-34` | Eloisa | Jane Eyre: An Autobiography | ✗ | ✓ | 10 | ✓ | FALLBACK |
| `B5-35` | Eloisa | Sense and Sensibility | ✗ | ✓ | 10 | ✓ | FALLBACK |
| `B5-36` | The Adventures of Sherlock Holmes | The Extraordinary Adventures of Ar | ✗ | ✓ | 10 | ✓ | FALLBACK |
| `B5-37` | The Adventures of Sherlock Holmes | The Man Who Was Thursday: A Nightm | ✗ | ✗ | 10 | ✓ | FALLBACK |
| `B5-38` | The Mystery of Edwin Drood | The Mystery of Edwin Drood | ✓ | ✓ | 10 | ✓ | FALLBACK |
| `B5-39` | The Mystery of Edwin Drood | The Blue Castle: a novel | ✗ | ✗ | 10 | ✓ | FALLBACK |

</details>

<details><summary>HNSW ef=800　路径 HNSW×57</summary>

| ID | 目标书籍 | Top1 实际 | Top1 | Top10 | 行数 | 重复稳定 | 路径 |
|---|---|---|---|---|--:|---|---|
| `FIX1` | Crime and Punishment | Crime and Punishment | ✓ | ✓ | 10 | ✓ | HNSW |
| `FIX2` | Jane Eyre | The Green Mummy | ✗ | ✗ | 10 | ✓ | HNSW |
| `FIX3` | Pride and Prejudice | Pride and Prejudice | ✓ | ✓ | 10 | ✓ | HNSW |
| `FIX4` | The Odyssey | The Odyssey
Rendered into English | ✓ | ✓ | 10 | ✓ | HNSW |
| `FIX5` | Romeo and Juliet | Romeo and Juliet | ✓ | ✓ | 10 | ✓ | HNSW |
| `FIX6` | Jane Eyre | Jane Eyre: An Autobiography | ✓ | ✓ | 10 | ✓ | HNSW |
| `S21` | Jane Eyre | Jane Eyre: An Autobiography | ✓ | ✓ | 10 | ✓ | HNSW |
| `S22` | The Mysteries of Udolpho | The Blue Castle: a novel | ✗ | ✓ | 10 | ✓ | HNSW |
| `S24` | Crime and Punishment | Crime and Punishment | ✓ | ✓ | 10 | ✓ | HNSW |
| `S25` | A Room with a View | Jane Eyre: An Autobiography | ✗ | ✓ | 10 | ✓ | HNSW |
| `S26` | The Odyssey | The Man Who Was Thursday: A Nightm | ✗ | ✓ | 10 | ✓ | HNSW |
| `S27` | Pride and Prejudice | Pride and Prejudice | ✓ | ✓ | 10 | ✓ | HNSW |
| `S28` | Romeo and Juliet | A Room with a View | ✗ | ✓ | 10 | ✓ | HNSW |
| `B5-1` | Carmen | The Odyssey
Rendered into English | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-2` | The Man Who Was Thursday | The Man Who Was Thursday: A Nightm | ✓ | ✓ | 10 | ✓ | HNSW |
| `B5-3` | Jane Eyre | Jane Eyre: An Autobiography | ✓ | ✓ | 10 | ✓ | HNSW |
| `B5-4` | Pride and Prejudice | Pride and Prejudice | ✓ | ✓ | 10 | ✓ | HNSW |
| `B5-5` | Crime and Punishment | Middlemarch | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-6` | Romeo and Juliet | Eloisa : $b or, A series of origin | ✗ | ✓ | 10 | ✓ | HNSW |
| `B5-7` | Alice's Adventures in Wonderland | Alice's Adventures in Wonderland | ✓ | ✓ | 10 | ✓ | HNSW |
| `B5-8` | Alice's Adventures in Wonderland | Middlemarch | ✗ | ✓ | 10 | ✓ | HNSW |
| `B5-10` | Thuvia, maid of Mars | Thuvia, maid of Mars | ✓ | ✓ | 10 | ✓ | HNSW |
| `B5-11` | Thuvia, maid of Mars | The Odyssey
Rendered into English | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-12` | Middlemarch | Sense and Sensibility | ✗ | ✓ | 10 | ✓ | HNSW |
| `B5-13` | Middlemarch | A farewell to arms | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-14` | Dracula | Moby Dick; Or, The Whale | ✗ | ✓ | 10 | ✓ | HNSW |
| `B5-15` | Dracula | Dracula | ✓ | ✓ | 10 | ✓ | HNSW |
| `B5-17` | The Monk: A Romance | The Monk: A Romance | ✓ | ✓ | 10 | ✓ | HNSW |
| `B5-18` | Moby Dick | Moby Dick; Or, The Whale | ✓ | ✓ | 10 | ✓ | HNSW |
| `B5-19` | Moby Dick | Moby Dick; Or, The Whale | ✓ | ✓ | 10 | ✓ | HNSW |
| `B5-20` | The Green Mummy | The Green Mummy | ✓ | ✓ | 10 | ✓ | HNSW |
| `B5-22` | The Confessions of St. Augustine | A Room with a View | ✗ | ✓ | 10 | ✓ | HNSW |
| `B5-23` | The Confessions of St. Augustine | The Man Who Was Thursday: A Nightm | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-24` | The Extraordinary Adventures of Ar | The Extraordinary Adventures of Ar | ✓ | ✓ | 10 | ✓ | HNSW |
| `B5-25` | The Extraordinary Adventures of Ar | Crime and Punishment | ✗ | ✓ | 10 | ✓ | HNSW |
| `B5-26` | Sense and Sensibility | Sense and Sensibility | ✓ | ✓ | 10 | ✓ | HNSW |
| `B5-27` | Sense and Sensibility | Sense and Sensibility | ✓ | ✓ | 10 | ✓ | HNSW |
| `B5-30` | The Blue Castle | Crime and Punishment | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-31` | The Blue Castle | Jane Eyre: An Autobiography | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-32` | A farewell to arms | A farewell to arms | ✓ | ✓ | 10 | ✓ | HNSW |
| `B5-33` | A farewell to arms | A farewell to arms | ✓ | ✓ | 10 | ✓ | HNSW |
| `B5-34` | Eloisa | Jane Eyre: An Autobiography | ✗ | ✓ | 10 | ✓ | HNSW |
| `B5-35` | Eloisa | Middlemarch | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-36` | The Adventures of Sherlock Holmes | The Extraordinary Adventures of Ar | ✗ | ✓ | 10 | ✓ | HNSW |
| `B5-37` | The Adventures of Sherlock Holmes | The Man Who Was Thursday: A Nightm | ✗ | ✗ | 10 | ✓ | HNSW |
| `B5-38` | The Mystery of Edwin Drood | The Mystery of Edwin Drood | ✓ | ✓ | 10 | ✓ | HNSW |
| `B5-39` | The Mystery of Edwin Drood | The Blue Castle: a novel | ✗ | ✗ | 10 | ✓ | HNSW |

</details>

