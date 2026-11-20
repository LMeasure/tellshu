# 发现书籍链路 · Stage B.5 实验报告

> 生成时间：2026-10-12 08:26:05　·　数据集：30 本冻结（《StageB5-30本冻结数据集报告.md》）
> 脚本：`server/src/scripts/stage-b5-experiment.py`（**只读**，不建索引、不写库）
> 原始数据：`server/.crawl-cache/_b5-matrix.json`

---

## 0. 一句话结论

> 详细数字见 §3。先看三件最重要的事：
>
> 1. **今天生产正在发生什么**：优化器在 58k 规模下已不再自选 Seq Scan，`默认计划` 臂实测走
>    **HNSW 近似**，Top1 18/47（38.3%）、P50 1.1 ms。这不是配置改出来的，是规模涨上去之后优化器自己换的。
> 2. **召回天花板有多高**：强制精确检索能到
>    Top1 25/47（53.2%），代价是 P50 从个位数毫秒涨到 **271.8 ms**（约 200+ 倍）。
> 3. **ANN 能不能追平**：真正走 HNSW 的臂里，把 ef_search 拉到 800 才能贴近精确
>    （Top1 24/47，距精确 -2.1pp），而 P50 只有 7.0 ms —— 但 Top10 仍差 -10.6pp。
>
> 噪声门槛：过滤开启分母 47 条 → 1 条 = **2.1pp**；过滤关闭分母 53 条 → 1 条 = **1.9pp**。
> 低于这个量的差异不解读。

## 1. 实验设计

### 1.1 与 Stage B 的区别

| | Stage B（24k） | Stage B.5（30 本 / 58k） |
|---|---|---|
| 研究对象 | 索引**构建**参数 m / ef_construction | 查询期**执行路径**与 ef_search |
| 载体 | 实验副本表 `discovered_book_chunks_exp`，反复 DROP/CREATE 索引 | **只读跑正式表**，不建任何索引 |
| 分母 | 13 条（1 条 = 7.7pp） | **47 / 53 条**（1 条 = 2.1 / 1.9pp） |
| 要回答 | HNSW 建不建得起 | 生产到底走精确还是 ANN |

### 1.2 为什么必须重做

Stage C 把规模从 24k 推到 58k 之后，出现了一个**无配置变更的静默切换**：

- 24k 时优化器判 Seq Scan（＝精确检索）更便宜；
- 58k 时改判 Index Scan using `discovered_book_chunks_embedding_hnsw_idx`（＝ANN 近似检索）；
- 而 `hnsw.ef_search` 一直是默认 **40**——正是 Stage 1 曾把召回打到 1/6 的那个值。

也就是说：**Stage B 的所有结论都是在「走精确检索」的前提下得出的，在今天的生产路径上已经全部过期。**

### 1.3 臂（查询期配置）

| 臂 | set_config 设置 | 意图 |
|---|---|---|
| `default` | （不动任何 GUC） | ① 默认计划（= 今天生产实际发生的事） |
| `exact` | enable_indexscan/bitmapscan/indexonlyscan = off | ② 强制精确检索（禁用索引，Seq Scan） |
| `ann-ef40` | enable_seqscan=off, hnsw.ef_search=40, iterative_scan=relaxed_order | ③ ANN · ef_search=40（= 会话默认值） |
| `ann-ef80` | enable_seqscan=off, hnsw.ef_search=80, iterative_scan=relaxed_order | ④ ANN · ef_search=80 |
| `ann-ef120` | enable_seqscan=off, hnsw.ef_search=120, iterative_scan=relaxed_order | ⑤ ANN · ef_search=120 |
| `ann-ef200` | enable_seqscan=off, hnsw.ef_search=200, iterative_scan=relaxed_order | ⑥ ANN · ef_search=200 |
| `ann-ef400` | enable_seqscan=off, hnsw.ef_search=400, iterative_scan=relaxed_order | ⑦ ANN · ef_search=400 |
| `ann-ef800` | enable_seqscan=off, hnsw.ef_search=800, iterative_scan=relaxed_order | ⑧ ANN · ef_search=800 |

所有会话级参数一律 `set_config(..., true)`（＝`SET LOCAL`），与检索同事务，commit 后自动重置，
**不污染连接池**。所有臂跑同一份查询字面量、同一份 embedding、同一个正式索引。

### 1.4 只读保证

实验前后各跑一次指纹校验，**零差异**——期间主表行数 / embedding / 内容指纹 / 正式索引大小 /
v1 备份全部未变，只读保证成立。

| 校验项 | 值 |
|---|---|
| 书籍 / chunk / embedding | 30 / 58332 / 58332 |
| 正文字符合计 | 25,625,443 |
| 无章节块 | 11,769 |
| 正式 HNSW 索引 | {'discovered_book_chunks_embedding_hnsw_idx': 477863936} |
| 内容指纹 | `770e7c8bbaca404c8418087418d1c632` |
| v1 备份 | {'rows': 24244, 'embeddings': 24244} |
| 会话默认 hnsw.ef_search / iterative_scan | 40 / off |

## 2. 查询集与分母

| 类别 | 条数 | 是否计入分母 |
|---|---:|---|
| `fixed` | 6 | 是 |
| `stage2` | 8 | 是 |
| `b5` | 39 | 是 |
| `probe` | 2 | 否（行为探针 / 负对照） |
| `control` | 2 | 否（行为探针 / 负对照） |
| **合计** | **57** | |

**过滤开启口径自动出局 6 条**（期望书名在库中没有任何 `chapter_title IS NOT NULL` 的块，
该书在这口径下物理上不可召回，计入分母是对指标的污染）：

- `S23` 《The String of Pearls》 —— 斯威尼·托德在舰队街的理发店里接待客人
- `B5-9` 《The strange case of Dr. Jekyll and Mr. Hyde》 —— 一位医生配制药剂让自己变成另一个人格，夜里在城里行恶
- `B5-16` 《Manon Lescaut》 —— 一位年轻贵族为一名女子倾家荡产，最终随她流放海外
- `B5-21` 《The Lady of the Lake》 —— 一位苏格兰高地首领与国王在湖畔的少女之间周旋
- `B5-28` 《The Love Letters of Mary Wollstonecraft》 —— 一位女作家写给情人却被对方冷淡以对的书信
- `B5-29` 《Meditations》 —— 一位罗马皇帝写给自己的道德自省札记

- 过滤关闭分母 = **53**（1 条 = 1.9pp）
- 过滤开启分母 = **47**（1 条 = 2.1pp）

## 3. 主结果矩阵

### 3.1 过滤关闭（全量块）　分母 53

| 臂 | Top1 | Top1% | Top3 | Top3% | Top10 | Top10% | P50 ms | P95 ms | 实际执行路径 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| `默认计划` | 21/53 | 39.6% | 24/53 | 45.3% | 26/53 | 49.1% | 0.9 | 1.6 | hnsw_ann×57 |
| `强制精确` | 29/53 | 54.7% | 38/53 | 71.7% | 41/53 | 77.4% | 320.3 | 348.9 | seq_exact×57 |
| `ANN ef=40` | 21/53 | 39.6% | 24/53 | 45.3% | 26/53 | 49.1% | 0.8 | 1.4 | hnsw_ann×57 |
| `ANN ef=80` | 21/53 | 39.6% | 25/53 | 47.2% | 28/53 | 52.8% | 1.1 | 1.9 | hnsw_ann×57 |
| `ANN ef=120` | 24/53 | 45.3% | 27/53 | 50.9% | 31/53 | 58.5% | 1.5 | 3.0 | hnsw_ann×57 |
| `ANN ef=200` | 29/53 | 54.7% | 38/53 | 71.7% | 41/53 | 77.4% | 441.8 | 508.4 | other_index_exact×57 |
| `ANN ef=400` | 29/53 | 54.7% | 38/53 | 71.7% | 41/53 | 77.4% | 435.0 | 500.9 | other_index_exact×57 |
| `ANN ef=800` | 28/53 | 52.8% | 36/53 | 67.9% | 38/53 | 71.7% | 6.9 | 10.7 | hnsw_ann×57 |

异常项：

| 臂 | 重复结果不一致 | 返回 0 行 | 返回不足 K 行 | 结果里混入无章节块 |
|---|---:|---:|---:|---:|
| `默认计划` | 0 | 0 | 0 | 0 |
| `强制精确` | 0 | 0 | 0 | 0 |
| `ANN ef=40` | 0 | 0 | 0 | 0 |
| `ANN ef=80` | 0 | 0 | 0 | 0 |
| `ANN ef=120` | 0 | 0 | 0 | 0 |
| `ANN ef=200` | 0 | 0 | 0 | 0 |
| `ANN ef=400` | 0 | 0 | 0 | 0 |
| `ANN ef=800` | 0 | 0 | 0 | 0 |

> 过滤关闭时本就允许出现无章节块，这一列无意义；「重复结果不一致」= 同一条 Query 的第 2~5 次 Top-K 不一致，反映 ANN 的随机性。

### 3.2 过滤开启（chapter_title IS NOT NULL）　分母 47

| 臂 | Top1 | Top1% | Top3 | Top3% | Top10 | Top10% | P50 ms | P95 ms | 实际执行路径 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| `默认计划` | 18/47 | 38.3% | 21/47 | 44.7% | 23/47 | 48.9% | 1.1 | 6.3 | hnsw_ann×57 |
| `强制精确` | 25/47 | 53.2% | 36/47 | 76.6% | 41/47 | 87.2% | 271.8 | 302.9 | seq_exact×57 |
| `ANN ef=40` | 18/47 | 38.3% | 21/47 | 44.7% | 23/47 | 48.9% | 1.1 | 8.7 | hnsw_ann×57 |
| `ANN ef=80` | 18/47 | 38.3% | 22/47 | 46.8% | 25/47 | 53.2% | 1.3 | 6.3 | hnsw_ann×57 |
| `ANN ef=120` | 21/47 | 44.7% | 25/47 | 53.2% | 28/47 | 59.6% | 1.7 | 6.7 | hnsw_ann×57 |
| `ANN ef=200` | 25/47 | 53.2% | 36/47 | 76.6% | 41/47 | 87.2% | 806.9 | 852.6 | other_index_exact×57 |
| `ANN ef=400` | 25/47 | 53.2% | 36/47 | 76.6% | 41/47 | 87.2% | 738.5 | 865.5 | other_index_exact×57 |
| `ANN ef=800` | 24/47 | 51.1% | 32/47 | 68.1% | 36/47 | 76.6% | 7.0 | 12.2 | hnsw_ann×57 |

异常项：

| 臂 | 重复结果不一致 | 返回 0 行 | 返回不足 K 行 | 结果里混入无章节块 |
|---|---:|---:|---:|---:|
| `默认计划` | 0 | 0 | 0 | 0 |
| `强制精确` | 0 | 0 | 0 | 0 |
| `ANN ef=40` | 0 | 0 | 0 | 0 |
| `ANN ef=80` | 0 | 0 | 0 | 0 |
| `ANN ef=120` | 0 | 0 | 0 | 0 |
| `ANN ef=200` | 0 | 0 | 0 | 0 |
| `ANN ef=400` | 0 | 0 | 0 | 0 |
| `ANN ef=800` | 0 | 0 | 0 | 0 |

> 过滤开启时「混入无章节块」必须为 0，否则过滤器失效；「重复结果不一致」= 同一条 Query 的第 2~5 次 Top-K 不一致，反映 ANN 的随机性。

### 3.3 ⚠ 关键陷阱：某些 ef 下优化器会放弃 HNSW，悄悄退回全扫+排序

过滤开启口径下，以下臂**名义上是 ANN，实际走的不是 HNSW**：

| 臂 | 实际路径分布 | 退化条数 | P50 ms |
|---|---|---:|---:|
| `ANN ef=200` | other_index_exact×57 | 57/57 | 806.9 |
| `ANN ef=400` | other_index_exact×57 | 57/57 | 738.5 |

退化后的实际计划（取自本轮真实 `EXPLAIN ANALYZE`，向量字面量已截断）：

```
Limit  (cost=7328.62..7328.65 rows=10 width=82) (actual time=999.327..999.331 rows=10.00 loops=1)
  Buffers: shared hit=372769 read=37102
  ->  Sort  (cost=7328.62..7443.35 rows=45889 width=82) (actual time=999.326..999.327 rows=10.00 loops=1)
        Sort Key: ((c.embedding <=> '[-0.016772,0.027185,-0.015085,-0.037611,-0.046282,-0.000232,0.003081,-0.03762,-0.024535,0.008696,-0.00537,0.02075,-0.035819,0.032158,0.048414,0.055865,0.063331,-0.029678,-0.029231,-0.034575,-0.03787,-0.029856,-0.032558,0.05 ……(向量字面量截断)……
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

它把 **46,563 行全部算一遍距离再排序**——召回率等于精确检索，但代价远高于
「强制精确」臂的 Seq Scan。也就是说：**ef 调大不一定换来 ANN，
反而可能触发一次没人察觉的静默降级。**

这类臂的召回数字**不能当作 ANN 的结果解读**，本报告在 ANN 边际收益表中已按路径标注。

## 4. ANN 的 ef_search 边际收益

**过滤开启**：相对同口径精确检索的天花板

- 精确检索天花板 Top1 = 25/47 （53.2%），Top10 = 41/47 （87.2%），P50 271.8 ms / P95 302.9 ms

| ef_search | Top1% | 距精确 pp | Top10% | 距精确 pp | P50 ms | P95 ms | 实际路径 |
|---:|---:|---:|---:|---:|---:|---:|---|
| 40 | 38.3% | -14.9 | 48.9% | -38.3 | 1.1 | 8.7 | hnsw_ann×57 |
| 80 | 38.3% | -14.9 | 53.2% | -34.0 | 1.3 | 6.3 | hnsw_ann×57 |
| 120 | 44.7% | -8.5 | 59.6% | -27.7 | 1.7 | 6.7 | hnsw_ann×57 |
| 200 | 53.2% | +0.0 | 87.2% | +0.0 | 806.9 | 852.6 | other_index_exact×57　**← 非 ANN，勿按 ANN 解读** |
| 400 | 53.2% | +0.0 | 87.2% | +0.0 | 738.5 | 865.5 | other_index_exact×57　**← 非 ANN，勿按 ANN 解读** |
| 800 | 51.1% | -2.1 | 76.6% | -10.6 | 7.0 | 12.2 | hnsw_ann×57 |

**过滤关闭**：相对同口径精确检索的天花板

- 精确检索天花板 Top1 = 29/53 （54.7%），Top10 = 41/53 （77.4%），P50 320.3 ms / P95 348.9 ms

| ef_search | Top1% | 距精确 pp | Top10% | 距精确 pp | P50 ms | P95 ms | 实际路径 |
|---:|---:|---:|---:|---:|---:|---:|---|
| 40 | 39.6% | -15.1 | 49.1% | -28.3 | 0.8 | 1.4 | hnsw_ann×57 |
| 80 | 39.6% | -15.1 | 52.8% | -24.5 | 1.1 | 1.9 | hnsw_ann×57 |
| 120 | 45.3% | -9.4 | 58.5% | -18.9 | 1.5 | 3.0 | hnsw_ann×57 |
| 200 | 54.7% | +0.0 | 77.4% | +0.0 | 441.8 | 508.4 | other_index_exact×57　**← 非 ANN，勿按 ANN 解读** |
| 400 | 54.7% | +0.0 | 77.4% | +0.0 | 435.0 | 500.9 | other_index_exact×57　**← 非 ANN，勿按 ANN 解读** |
| 800 | 52.8% | -1.9 | 71.7% | -5.7 | 6.9 | 10.7 | hnsw_ann×57 |

## 5. 跨期比较

### 5.1 跨期对照

| 阶段 | 规模 | 分母 | 当时的默认路径 | 说明 |
|---|---|---:|---|---|
| Stage 1.5 | 24k | 13 | Seq Scan（精确） | 优化器自选精确 |
| Stage B | 24k（实验副本表） | 13 | Seq Scan（精确） | 结论全部建立在「走精确」的前提上 |
| **Stage B.5** | **58k** | **47 / 53** | 见 §3 `默认计划` 臂 | 前提已变，须重评 |

**Stage 1 固定 6 条单独看**（跨阶段唯一口径完全一致的 6 条，过滤开启）：

| 臂 | Top1 |
|---|---|
| `默认计划` | 4/6 |
| `强制精确` | 5/6 |
| `ANN ef=40` | 4/6 |
| `ANN ef=80` | 4/6 |
| `ANN ef=120` | 4/6 |
| `ANN ef=200` | 5/6 |
| `ANN ef=400` | 5/6 |
| `ANN ef=800` | 5/6 |

## 6. 结论

### 6.1 事实（不含推断）

1. 58k 规模下，精确检索的天花板是 Top1 25/47（53.2%），P50 271.8 ms / P95 302.9 ms。
2. 不加任何干预、让优化器自选时（`默认计划` 臂）：Top1 18/47（38.3%），P50 1.1 ms / P95 6.3 ms，实际走的是 HNSW 近似×57。
3. **真正走 HNSW 近似**的臂里最高的是 `ann-ef800`：Top1 24/47（51.1%），P50 7.0 ms / P95 12.2 ms。

   （ef=200 / ef=400 的召回数字更高，但那两组实测已退化成全扫+排序，**不是 ANN**，见 §3.3，不计入本条比较。）

### 6.2 判据

- 任何两组之间的 Top1 差异 **小于 2.2pp** 的一律视为噪声，不据此决策。
- 只有差异超过噪声门槛、且延迟可接受时，才谈「切换」。
- 本报告不替业务做「延迟 vs 召回」的取舍，只把两条曲线的对应点摆出来。

### 6.3 尚未做的事

- **没有改任何生产配置**：`discovered_book_chunks_embedding_hnsw_idx` 未 REINDEX，`hnsw.ef_search` 未动。
- **没有改 API / 前端**：`server/src` 的检索路径本轮零改动。
- **没有提交 Git**（HEAD 仍为初始 commit）。
- 要不要在生产里显式固定执行路径、要不要上调 ef_search，等产品拍板后再动。

## 附录 A · 过滤开启口径逐条明细（选择的臂）

<details><summary>默认计划</summary>

| ID | 期望书名 | Top1 实际 | Top1 | Top10 | 行数 | 重复稳定 | 路径 |
|---|---|---|---|---|--:|---|---|
| FIX1 | Crime and Punishment | Crime and Punishment | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| FIX2 | Jane Eyre | A Room with a View | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| FIX3 | Pride and Prejudice | Middlemarch | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| FIX4 | The Odyssey | The Odyssey
Rendered into English pro | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| FIX5 | Romeo and Juliet | Romeo and Juliet | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| FIX6 | Jane Eyre | Jane Eyre: An Autobiography | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| S21 | Jane Eyre | Jane Eyre: An Autobiography | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| S22 | The Mysteries of Udolpho | The Mysteries of Udolpho | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| S24 | Crime and Punishment | The Adventures of Sherlock Holmes | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| S25 | A Room with a View | Jane Eyre: An Autobiography | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| S26 | The Odyssey | The Man Who Was Thursday: A Nightmare | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| S27 | Pride and Prejudice | Moby Dick; Or, The Whale | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| S28 | Romeo and Juliet | A Room with a View | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-1 | Carmen | The Odyssey
Rendered into English pro | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-2 | The Man Who Was Thursday | The Extraordinary Adventures of Arsène | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-3 | Jane Eyre | A Room with a View | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-4 | Pride and Prejudice | Jane Eyre: An Autobiography | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-5 | Crime and Punishment | Jane Eyre: An Autobiography | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-6 | Romeo and Juliet | Eloisa : $b or, A series of original l | ✗ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-7 | Alice's Adventures in Wonderland | Alice's Adventures in Wonderland | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-8 | Alice's Adventures in Wonderland | The Mystery of Edwin Drood | ✗ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-10 | Thuvia, maid of Mars | Thuvia, maid of Mars | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-11 | Thuvia, maid of Mars | The Odyssey
Rendered into English pro | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-12 | Middlemarch | Middlemarch | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-13 | Middlemarch | The Adventures of Sherlock Holmes | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-14 | Dracula | Moby Dick; Or, The Whale | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-15 | Dracula | Dracula | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-17 | The Monk: A Romance | The Monk: A Romance | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-18 | Moby Dick | Moby Dick; Or, The Whale | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-19 | Moby Dick | Moby Dick; Or, The Whale | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-20 | The Green Mummy | The Green Mummy | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-22 | The Confessions of St. Augustine | A Room with a View | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-23 | The Confessions of St. Augustine | Middlemarch | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-24 | The Extraordinary Adventures of Arsène | The Adventures of Sherlock Holmes | ✗ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-25 | The Extraordinary Adventures of Arsène | The Extraordinary Adventures of Arsène | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-26 | Sense and Sensibility | Sense and Sensibility | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-27 | Sense and Sensibility | Jane Eyre: An Autobiography | ✗ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-30 | The Blue Castle | Crime and Punishment | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-31 | The Blue Castle | A farewell to arms | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-32 | A farewell to arms | A farewell to arms | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-33 | A farewell to arms | The Mysteries of Udolpho | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-34 | Eloisa | Eloisa : $b or, A series of original l | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-35 | Eloisa | Middlemarch | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-36 | The Adventures of Sherlock Holmes | The Extraordinary Adventures of Arsène | ✗ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-37 | The Adventures of Sherlock Holmes | A Room with a View | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-38 | The Mystery of Edwin Drood | The Green Mummy | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-39 | The Mystery of Edwin Drood | The Blue Castle: a novel | ✗ | ✗ | 10 | ✓ | HNSW 近似 |

</details>

<details><summary>强制精确</summary>

| ID | 期望书名 | Top1 实际 | Top1 | Top10 | 行数 | 重复稳定 | 路径 |
|---|---|---|---|---|--:|---|---|
| FIX1 | Crime and Punishment | Crime and Punishment | ✓ | ✓ | 10 | ✓ | Seq Scan 精确 |
| FIX2 | Jane Eyre | The Green Mummy | ✗ | ✓ | 10 | ✓ | Seq Scan 精确 |
| FIX3 | Pride and Prejudice | Pride and Prejudice | ✓ | ✓ | 10 | ✓ | Seq Scan 精确 |
| FIX4 | The Odyssey | The Odyssey
Rendered into English pro | ✓ | ✓ | 10 | ✓ | Seq Scan 精确 |
| FIX5 | Romeo and Juliet | Romeo and Juliet | ✓ | ✓ | 10 | ✓ | Seq Scan 精确 |
| FIX6 | Jane Eyre | Jane Eyre: An Autobiography | ✓ | ✓ | 10 | ✓ | Seq Scan 精确 |
| S21 | Jane Eyre | Jane Eyre: An Autobiography | ✓ | ✓ | 10 | ✓ | Seq Scan 精确 |
| S22 | The Mysteries of Udolpho | The Blue Castle: a novel | ✗ | ✓ | 10 | ✓ | Seq Scan 精确 |
| S24 | Crime and Punishment | Crime and Punishment | ✓ | ✓ | 10 | ✓ | Seq Scan 精确 |
| S25 | A Room with a View | Jane Eyre: An Autobiography | ✗ | ✓ | 10 | ✓ | Seq Scan 精确 |
| S26 | The Odyssey | The Man Who Was Thursday: A Nightmare | ✗ | ✗ | 10 | ✓ | Seq Scan 精确 |
| S27 | Pride and Prejudice | Pride and Prejudice | ✓ | ✓ | 10 | ✓ | Seq Scan 精确 |
| S28 | Romeo and Juliet | A Room with a View | ✗ | ✓ | 10 | ✓ | Seq Scan 精确 |
| B5-1 | Carmen | Middlemarch | ✗ | ✓ | 10 | ✓ | Seq Scan 精确 |
| B5-2 | The Man Who Was Thursday | The Man Who Was Thursday: A Nightmare | ✓ | ✓ | 10 | ✓ | Seq Scan 精确 |
| B5-3 | Jane Eyre | Jane Eyre: An Autobiography | ✓ | ✓ | 10 | ✓ | Seq Scan 精确 |
| B5-4 | Pride and Prejudice | Pride and Prejudice | ✓ | ✓ | 10 | ✓ | Seq Scan 精确 |
| B5-5 | Crime and Punishment | Crime and Punishment | ✓ | ✓ | 10 | ✓ | Seq Scan 精确 |
| B5-6 | Romeo and Juliet | Eloisa : $b or, A series of original l | ✗ | ✓ | 10 | ✓ | Seq Scan 精确 |
| B5-7 | Alice's Adventures in Wonderland | Alice's Adventures in Wonderland | ✓ | ✓ | 10 | ✓ | Seq Scan 精确 |
| B5-8 | Alice's Adventures in Wonderland | Carmen | ✗ | ✓ | 10 | ✓ | Seq Scan 精确 |
| B5-10 | Thuvia, maid of Mars | Thuvia, maid of Mars | ✓ | ✓ | 10 | ✓ | Seq Scan 精确 |
| B5-11 | Thuvia, maid of Mars | The Man Who Was Thursday: A Nightmare | ✗ | ✗ | 10 | ✓ | Seq Scan 精确 |
| B5-12 | Middlemarch | Sense and Sensibility | ✗ | ✓ | 10 | ✓ | Seq Scan 精确 |
| B5-13 | Middlemarch | A Room with a View | ✗ | ✓ | 10 | ✓ | Seq Scan 精确 |
| B5-14 | Dracula | Moby Dick; Or, The Whale | ✗ | ✓ | 10 | ✓ | Seq Scan 精确 |
| B5-15 | Dracula | Dracula | ✓ | ✓ | 10 | ✓ | Seq Scan 精确 |
| B5-17 | The Monk: A Romance | The Monk: A Romance | ✓ | ✓ | 10 | ✓ | Seq Scan 精确 |
| B5-18 | Moby Dick | Moby Dick; Or, The Whale | ✓ | ✓ | 10 | ✓ | Seq Scan 精确 |
| B5-19 | Moby Dick | The Green Mummy | ✗ | ✓ | 10 | ✓ | Seq Scan 精确 |
| B5-20 | The Green Mummy | The Green Mummy | ✓ | ✓ | 10 | ✓ | Seq Scan 精确 |
| B5-22 | The Confessions of St. Augustine | A Room with a View | ✗ | ✓ | 10 | ✓ | Seq Scan 精确 |
| B5-23 | The Confessions of St. Augustine | The Confessions of St. Augustine | ✓ | ✓ | 10 | ✓ | Seq Scan 精确 |
| B5-24 | The Extraordinary Adventures of Arsène | The Extraordinary Adventures of Arsène | ✓ | ✓ | 10 | ✓ | Seq Scan 精确 |
| B5-25 | The Extraordinary Adventures of Arsène | Crime and Punishment | ✗ | ✓ | 10 | ✓ | Seq Scan 精确 |
| B5-26 | Sense and Sensibility | Sense and Sensibility | ✓ | ✓ | 10 | ✓ | Seq Scan 精确 |
| B5-27 | Sense and Sensibility | Sense and Sensibility | ✓ | ✓ | 10 | ✓ | Seq Scan 精确 |
| B5-30 | The Blue Castle | Crime and Punishment | ✗ | ✗ | 10 | ✓ | Seq Scan 精确 |
| B5-31 | The Blue Castle | Jane Eyre: An Autobiography | ✗ | ✗ | 10 | ✓ | Seq Scan 精确 |
| B5-32 | A farewell to arms | A farewell to arms | ✓ | ✓ | 10 | ✓ | Seq Scan 精确 |
| B5-33 | A farewell to arms | A farewell to arms | ✓ | ✓ | 10 | ✓ | Seq Scan 精确 |
| B5-34 | Eloisa | Jane Eyre: An Autobiography | ✗ | ✓ | 10 | ✓ | Seq Scan 精确 |
| B5-35 | Eloisa | Sense and Sensibility | ✗ | ✓ | 10 | ✓ | Seq Scan 精确 |
| B5-36 | The Adventures of Sherlock Holmes | The Extraordinary Adventures of Arsène | ✗ | ✓ | 10 | ✓ | Seq Scan 精确 |
| B5-37 | The Adventures of Sherlock Holmes | The Man Who Was Thursday: A Nightmare | ✗ | ✗ | 10 | ✓ | Seq Scan 精确 |
| B5-38 | The Mystery of Edwin Drood | The Mystery of Edwin Drood | ✓ | ✓ | 10 | ✓ | Seq Scan 精确 |
| B5-39 | The Mystery of Edwin Drood | The Blue Castle: a novel | ✗ | ✗ | 10 | ✓ | Seq Scan 精确 |

</details>

<details><summary>ANN ef=40</summary>

| ID | 期望书名 | Top1 实际 | Top1 | Top10 | 行数 | 重复稳定 | 路径 |
|---|---|---|---|---|--:|---|---|
| FIX1 | Crime and Punishment | Crime and Punishment | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| FIX2 | Jane Eyre | A Room with a View | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| FIX3 | Pride and Prejudice | Middlemarch | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| FIX4 | The Odyssey | The Odyssey
Rendered into English pro | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| FIX5 | Romeo and Juliet | Romeo and Juliet | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| FIX6 | Jane Eyre | Jane Eyre: An Autobiography | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| S21 | Jane Eyre | Jane Eyre: An Autobiography | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| S22 | The Mysteries of Udolpho | The Mysteries of Udolpho | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| S24 | Crime and Punishment | The Adventures of Sherlock Holmes | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| S25 | A Room with a View | Jane Eyre: An Autobiography | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| S26 | The Odyssey | The Man Who Was Thursday: A Nightmare | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| S27 | Pride and Prejudice | Moby Dick; Or, The Whale | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| S28 | Romeo and Juliet | A Room with a View | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-1 | Carmen | The Odyssey
Rendered into English pro | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-2 | The Man Who Was Thursday | The Extraordinary Adventures of Arsène | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-3 | Jane Eyre | A Room with a View | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-4 | Pride and Prejudice | Jane Eyre: An Autobiography | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-5 | Crime and Punishment | Jane Eyre: An Autobiography | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-6 | Romeo and Juliet | Eloisa : $b or, A series of original l | ✗ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-7 | Alice's Adventures in Wonderland | Alice's Adventures in Wonderland | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-8 | Alice's Adventures in Wonderland | The Mystery of Edwin Drood | ✗ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-10 | Thuvia, maid of Mars | Thuvia, maid of Mars | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-11 | Thuvia, maid of Mars | The Odyssey
Rendered into English pro | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-12 | Middlemarch | Middlemarch | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-13 | Middlemarch | The Adventures of Sherlock Holmes | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-14 | Dracula | Moby Dick; Or, The Whale | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-15 | Dracula | Dracula | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-17 | The Monk: A Romance | The Monk: A Romance | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-18 | Moby Dick | Moby Dick; Or, The Whale | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-19 | Moby Dick | Moby Dick; Or, The Whale | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-20 | The Green Mummy | The Green Mummy | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-22 | The Confessions of St. Augustine | A Room with a View | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-23 | The Confessions of St. Augustine | Middlemarch | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-24 | The Extraordinary Adventures of Arsène | The Adventures of Sherlock Holmes | ✗ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-25 | The Extraordinary Adventures of Arsène | The Extraordinary Adventures of Arsène | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-26 | Sense and Sensibility | Sense and Sensibility | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-27 | Sense and Sensibility | Jane Eyre: An Autobiography | ✗ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-30 | The Blue Castle | Crime and Punishment | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-31 | The Blue Castle | A farewell to arms | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-32 | A farewell to arms | A farewell to arms | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-33 | A farewell to arms | The Mysteries of Udolpho | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-34 | Eloisa | Eloisa : $b or, A series of original l | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-35 | Eloisa | Middlemarch | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-36 | The Adventures of Sherlock Holmes | The Extraordinary Adventures of Arsène | ✗ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-37 | The Adventures of Sherlock Holmes | A Room with a View | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-38 | The Mystery of Edwin Drood | The Green Mummy | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-39 | The Mystery of Edwin Drood | The Blue Castle: a novel | ✗ | ✗ | 10 | ✓ | HNSW 近似 |

</details>

<details><summary>ANN ef=80</summary>

| ID | 期望书名 | Top1 实际 | Top1 | Top10 | 行数 | 重复稳定 | 路径 |
|---|---|---|---|---|--:|---|---|
| FIX1 | Crime and Punishment | Crime and Punishment | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| FIX2 | Jane Eyre | The Green Mummy | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| FIX3 | Pride and Prejudice | Middlemarch | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| FIX4 | The Odyssey | The Odyssey
Rendered into English pro | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| FIX5 | Romeo and Juliet | Romeo and Juliet | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| FIX6 | Jane Eyre | Jane Eyre: An Autobiography | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| S21 | Jane Eyre | Jane Eyre: An Autobiography | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| S22 | The Mysteries of Udolpho | The Blue Castle: a novel | ✗ | ✓ | 10 | ✓ | HNSW 近似 |
| S24 | Crime and Punishment | The Adventures of Sherlock Holmes | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| S25 | A Room with a View | Jane Eyre: An Autobiography | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| S26 | The Odyssey | The Man Who Was Thursday: A Nightmare | ✗ | ✓ | 10 | ✓ | HNSW 近似 |
| S27 | Pride and Prejudice | The Green Mummy | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| S28 | Romeo and Juliet | A Room with a View | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-1 | Carmen | The Odyssey
Rendered into English pro | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-2 | The Man Who Was Thursday | The Extraordinary Adventures of Arsène | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-3 | Jane Eyre | A Room with a View | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-4 | Pride and Prejudice | Pride and Prejudice | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-5 | Crime and Punishment | Jane Eyre: An Autobiography | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-6 | Romeo and Juliet | Eloisa : $b or, A series of original l | ✗ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-7 | Alice's Adventures in Wonderland | Alice's Adventures in Wonderland | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-8 | Alice's Adventures in Wonderland | The Mystery of Edwin Drood | ✗ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-10 | Thuvia, maid of Mars | Thuvia, maid of Mars | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-11 | Thuvia, maid of Mars | The Odyssey
Rendered into English pro | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-12 | Middlemarch | Middlemarch | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-13 | Middlemarch | The Adventures of Sherlock Holmes | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-14 | Dracula | Moby Dick; Or, The Whale | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-15 | Dracula | Dracula | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-17 | The Monk: A Romance | The Monk: A Romance | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-18 | Moby Dick | Moby Dick; Or, The Whale | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-19 | Moby Dick | Moby Dick; Or, The Whale | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-20 | The Green Mummy | The Green Mummy | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-22 | The Confessions of St. Augustine | A Room with a View | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-23 | The Confessions of St. Augustine | Middlemarch | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-24 | The Extraordinary Adventures of Arsène | The Adventures of Sherlock Holmes | ✗ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-25 | The Extraordinary Adventures of Arsène | The Extraordinary Adventures of Arsène | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-26 | Sense and Sensibility | Sense and Sensibility | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-27 | Sense and Sensibility | Sense and Sensibility | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-30 | The Blue Castle | Crime and Punishment | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-31 | The Blue Castle | Jane Eyre: An Autobiography | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-32 | A farewell to arms | A farewell to arms | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-33 | A farewell to arms | The Mysteries of Udolpho | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-34 | Eloisa | Middlemarch | ✗ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-35 | Eloisa | Middlemarch | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-36 | The Adventures of Sherlock Holmes | The Extraordinary Adventures of Arsène | ✗ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-37 | The Adventures of Sherlock Holmes | Crime and Punishment | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-38 | The Mystery of Edwin Drood | The Green Mummy | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-39 | The Mystery of Edwin Drood | The Blue Castle: a novel | ✗ | ✗ | 10 | ✓ | HNSW 近似 |

</details>

<details><summary>ANN ef=120</summary>

| ID | 期望书名 | Top1 实际 | Top1 | Top10 | 行数 | 重复稳定 | 路径 |
|---|---|---|---|---|--:|---|---|
| FIX1 | Crime and Punishment | Crime and Punishment | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| FIX2 | Jane Eyre | The Green Mummy | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| FIX3 | Pride and Prejudice | Middlemarch | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| FIX4 | The Odyssey | The Odyssey
Rendered into English pro | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| FIX5 | Romeo and Juliet | Romeo and Juliet | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| FIX6 | Jane Eyre | Jane Eyre: An Autobiography | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| S21 | Jane Eyre | Jane Eyre: An Autobiography | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| S22 | The Mysteries of Udolpho | The Blue Castle: a novel | ✗ | ✓ | 10 | ✓ | HNSW 近似 |
| S24 | Crime and Punishment | Crime and Punishment | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| S25 | A Room with a View | Jane Eyre: An Autobiography | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| S26 | The Odyssey | The Man Who Was Thursday: A Nightmare | ✗ | ✓ | 10 | ✓ | HNSW 近似 |
| S27 | Pride and Prejudice | The Green Mummy | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| S28 | Romeo and Juliet | A Room with a View | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-1 | Carmen | The Odyssey
Rendered into English pro | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-2 | The Man Who Was Thursday | The Extraordinary Adventures of Arsène | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-3 | Jane Eyre | A Room with a View | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-4 | Pride and Prejudice | Pride and Prejudice | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-5 | Crime and Punishment | Jane Eyre: An Autobiography | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-6 | Romeo and Juliet | Eloisa : $b or, A series of original l | ✗ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-7 | Alice's Adventures in Wonderland | Alice's Adventures in Wonderland | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-8 | Alice's Adventures in Wonderland | The Mystery of Edwin Drood | ✗ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-10 | Thuvia, maid of Mars | Thuvia, maid of Mars | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-11 | Thuvia, maid of Mars | The Odyssey
Rendered into English pro | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-12 | Middlemarch | Middlemarch | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-13 | Middlemarch | The Adventures of Sherlock Holmes | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-14 | Dracula | Moby Dick; Or, The Whale | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-15 | Dracula | Dracula | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-17 | The Monk: A Romance | The Monk: A Romance | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-18 | Moby Dick | Moby Dick; Or, The Whale | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-19 | Moby Dick | Moby Dick; Or, The Whale | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-20 | The Green Mummy | The Green Mummy | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-22 | The Confessions of St. Augustine | A Room with a View | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-23 | The Confessions of St. Augustine | Middlemarch | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-24 | The Extraordinary Adventures of Arsène | The Adventures of Sherlock Holmes | ✗ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-25 | The Extraordinary Adventures of Arsène | The Extraordinary Adventures of Arsène | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-26 | Sense and Sensibility | Sense and Sensibility | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-27 | Sense and Sensibility | Sense and Sensibility | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-30 | The Blue Castle | Crime and Punishment | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-31 | The Blue Castle | Jane Eyre: An Autobiography | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-32 | A farewell to arms | A farewell to arms | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-33 | A farewell to arms | A farewell to arms | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-34 | Eloisa | Middlemarch | ✗ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-35 | Eloisa | Middlemarch | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-36 | The Adventures of Sherlock Holmes | The Extraordinary Adventures of Arsène | ✗ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-37 | The Adventures of Sherlock Holmes | Crime and Punishment | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-38 | The Mystery of Edwin Drood | The Mystery of Edwin Drood | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-39 | The Mystery of Edwin Drood | The Blue Castle: a novel | ✗ | ✗ | 10 | ✓ | HNSW 近似 |

</details>

<details><summary>ANN ef=200</summary>

| ID | 期望书名 | Top1 实际 | Top1 | Top10 | 行数 | 重复稳定 | 路径 |
|---|---|---|---|---|--:|---|---|
| FIX1 | Crime and Punishment | Crime and Punishment | ✓ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| FIX2 | Jane Eyre | The Green Mummy | ✗ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| FIX3 | Pride and Prejudice | Pride and Prejudice | ✓ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| FIX4 | The Odyssey | The Odyssey
Rendered into English pro | ✓ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| FIX5 | Romeo and Juliet | Romeo and Juliet | ✓ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| FIX6 | Jane Eyre | Jane Eyre: An Autobiography | ✓ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| S21 | Jane Eyre | Jane Eyre: An Autobiography | ✓ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| S22 | The Mysteries of Udolpho | The Blue Castle: a novel | ✗ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| S24 | Crime and Punishment | Crime and Punishment | ✓ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| S25 | A Room with a View | Jane Eyre: An Autobiography | ✗ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| S26 | The Odyssey | The Man Who Was Thursday: A Nightmare | ✗ | ✗ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| S27 | Pride and Prejudice | Pride and Prejudice | ✓ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| S28 | Romeo and Juliet | A Room with a View | ✗ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| B5-1 | Carmen | Middlemarch | ✗ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| B5-2 | The Man Who Was Thursday | The Man Who Was Thursday: A Nightmare | ✓ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| B5-3 | Jane Eyre | Jane Eyre: An Autobiography | ✓ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| B5-4 | Pride and Prejudice | Pride and Prejudice | ✓ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| B5-5 | Crime and Punishment | Crime and Punishment | ✓ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| B5-6 | Romeo and Juliet | Eloisa : $b or, A series of original l | ✗ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| B5-7 | Alice's Adventures in Wonderland | Alice's Adventures in Wonderland | ✓ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| B5-8 | Alice's Adventures in Wonderland | Carmen | ✗ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| B5-10 | Thuvia, maid of Mars | Thuvia, maid of Mars | ✓ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| B5-11 | Thuvia, maid of Mars | The Man Who Was Thursday: A Nightmare | ✗ | ✗ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| B5-12 | Middlemarch | Sense and Sensibility | ✗ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| B5-13 | Middlemarch | A Room with a View | ✗ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| B5-14 | Dracula | Moby Dick; Or, The Whale | ✗ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| B5-15 | Dracula | Dracula | ✓ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| B5-17 | The Monk: A Romance | The Monk: A Romance | ✓ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| B5-18 | Moby Dick | Moby Dick; Or, The Whale | ✓ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| B5-19 | Moby Dick | The Green Mummy | ✗ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| B5-20 | The Green Mummy | The Green Mummy | ✓ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| B5-22 | The Confessions of St. Augustine | A Room with a View | ✗ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| B5-23 | The Confessions of St. Augustine | The Confessions of St. Augustine | ✓ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| B5-24 | The Extraordinary Adventures of Arsène | The Extraordinary Adventures of Arsène | ✓ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| B5-25 | The Extraordinary Adventures of Arsène | Crime and Punishment | ✗ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| B5-26 | Sense and Sensibility | Sense and Sensibility | ✓ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| B5-27 | Sense and Sensibility | Sense and Sensibility | ✓ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| B5-30 | The Blue Castle | Crime and Punishment | ✗ | ✗ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| B5-31 | The Blue Castle | Jane Eyre: An Autobiography | ✗ | ✗ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| B5-32 | A farewell to arms | A farewell to arms | ✓ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| B5-33 | A farewell to arms | A farewell to arms | ✓ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| B5-34 | Eloisa | Jane Eyre: An Autobiography | ✗ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| B5-35 | Eloisa | Sense and Sensibility | ✗ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| B5-36 | The Adventures of Sherlock Holmes | The Extraordinary Adventures of Arsène | ✗ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| B5-37 | The Adventures of Sherlock Holmes | The Man Who Was Thursday: A Nightmare | ✗ | ✗ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| B5-38 | The Mystery of Edwin Drood | The Mystery of Edwin Drood | ✓ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| B5-39 | The Mystery of Edwin Drood | The Blue Castle: a novel | ✗ | ✗ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |

</details>

<details><summary>ANN ef=400</summary>

| ID | 期望书名 | Top1 实际 | Top1 | Top10 | 行数 | 重复稳定 | 路径 |
|---|---|---|---|---|--:|---|---|
| FIX1 | Crime and Punishment | Crime and Punishment | ✓ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| FIX2 | Jane Eyre | The Green Mummy | ✗ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| FIX3 | Pride and Prejudice | Pride and Prejudice | ✓ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| FIX4 | The Odyssey | The Odyssey
Rendered into English pro | ✓ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| FIX5 | Romeo and Juliet | Romeo and Juliet | ✓ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| FIX6 | Jane Eyre | Jane Eyre: An Autobiography | ✓ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| S21 | Jane Eyre | Jane Eyre: An Autobiography | ✓ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| S22 | The Mysteries of Udolpho | The Blue Castle: a novel | ✗ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| S24 | Crime and Punishment | Crime and Punishment | ✓ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| S25 | A Room with a View | Jane Eyre: An Autobiography | ✗ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| S26 | The Odyssey | The Man Who Was Thursday: A Nightmare | ✗ | ✗ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| S27 | Pride and Prejudice | Pride and Prejudice | ✓ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| S28 | Romeo and Juliet | A Room with a View | ✗ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| B5-1 | Carmen | Middlemarch | ✗ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| B5-2 | The Man Who Was Thursday | The Man Who Was Thursday: A Nightmare | ✓ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| B5-3 | Jane Eyre | Jane Eyre: An Autobiography | ✓ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| B5-4 | Pride and Prejudice | Pride and Prejudice | ✓ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| B5-5 | Crime and Punishment | Crime and Punishment | ✓ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| B5-6 | Romeo and Juliet | Eloisa : $b or, A series of original l | ✗ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| B5-7 | Alice's Adventures in Wonderland | Alice's Adventures in Wonderland | ✓ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| B5-8 | Alice's Adventures in Wonderland | Carmen | ✗ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| B5-10 | Thuvia, maid of Mars | Thuvia, maid of Mars | ✓ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| B5-11 | Thuvia, maid of Mars | The Man Who Was Thursday: A Nightmare | ✗ | ✗ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| B5-12 | Middlemarch | Sense and Sensibility | ✗ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| B5-13 | Middlemarch | A Room with a View | ✗ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| B5-14 | Dracula | Moby Dick; Or, The Whale | ✗ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| B5-15 | Dracula | Dracula | ✓ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| B5-17 | The Monk: A Romance | The Monk: A Romance | ✓ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| B5-18 | Moby Dick | Moby Dick; Or, The Whale | ✓ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| B5-19 | Moby Dick | The Green Mummy | ✗ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| B5-20 | The Green Mummy | The Green Mummy | ✓ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| B5-22 | The Confessions of St. Augustine | A Room with a View | ✗ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| B5-23 | The Confessions of St. Augustine | The Confessions of St. Augustine | ✓ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| B5-24 | The Extraordinary Adventures of Arsène | The Extraordinary Adventures of Arsène | ✓ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| B5-25 | The Extraordinary Adventures of Arsène | Crime and Punishment | ✗ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| B5-26 | Sense and Sensibility | Sense and Sensibility | ✓ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| B5-27 | Sense and Sensibility | Sense and Sensibility | ✓ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| B5-30 | The Blue Castle | Crime and Punishment | ✗ | ✗ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| B5-31 | The Blue Castle | Jane Eyre: An Autobiography | ✗ | ✗ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| B5-32 | A farewell to arms | A farewell to arms | ✓ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| B5-33 | A farewell to arms | A farewell to arms | ✓ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| B5-34 | Eloisa | Jane Eyre: An Autobiography | ✗ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| B5-35 | Eloisa | Sense and Sensibility | ✗ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| B5-36 | The Adventures of Sherlock Holmes | The Extraordinary Adventures of Arsène | ✗ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| B5-37 | The Adventures of Sherlock Holmes | The Man Who Was Thursday: A Nightmare | ✗ | ✗ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| B5-38 | The Mystery of Edwin Drood | The Mystery of Edwin Drood | ✓ | ✓ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |
| B5-39 | The Mystery of Edwin Drood | The Blue Castle: a novel | ✗ | ✗ | 10 | ✓ | ⚠ 其他索引全扫+排序（变相精确） |

</details>

<details><summary>ANN ef=800</summary>

| ID | 期望书名 | Top1 实际 | Top1 | Top10 | 行数 | 重复稳定 | 路径 |
|---|---|---|---|---|--:|---|---|
| FIX1 | Crime and Punishment | Crime and Punishment | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| FIX2 | Jane Eyre | The Green Mummy | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| FIX3 | Pride and Prejudice | Pride and Prejudice | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| FIX4 | The Odyssey | The Odyssey
Rendered into English pro | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| FIX5 | Romeo and Juliet | Romeo and Juliet | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| FIX6 | Jane Eyre | Jane Eyre: An Autobiography | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| S21 | Jane Eyre | Jane Eyre: An Autobiography | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| S22 | The Mysteries of Udolpho | The Blue Castle: a novel | ✗ | ✓ | 10 | ✓ | HNSW 近似 |
| S24 | Crime and Punishment | Crime and Punishment | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| S25 | A Room with a View | Jane Eyre: An Autobiography | ✗ | ✓ | 10 | ✓ | HNSW 近似 |
| S26 | The Odyssey | The Man Who Was Thursday: A Nightmare | ✗ | ✓ | 10 | ✓ | HNSW 近似 |
| S27 | Pride and Prejudice | Pride and Prejudice | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| S28 | Romeo and Juliet | A Room with a View | ✗ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-1 | Carmen | The Odyssey
Rendered into English pro | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-2 | The Man Who Was Thursday | The Man Who Was Thursday: A Nightmare | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-3 | Jane Eyre | Jane Eyre: An Autobiography | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-4 | Pride and Prejudice | Pride and Prejudice | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-5 | Crime and Punishment | Middlemarch | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-6 | Romeo and Juliet | Eloisa : $b or, A series of original l | ✗ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-7 | Alice's Adventures in Wonderland | Alice's Adventures in Wonderland | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-8 | Alice's Adventures in Wonderland | Middlemarch | ✗ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-10 | Thuvia, maid of Mars | Thuvia, maid of Mars | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-11 | Thuvia, maid of Mars | The Odyssey
Rendered into English pro | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-12 | Middlemarch | Sense and Sensibility | ✗ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-13 | Middlemarch | A farewell to arms | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-14 | Dracula | Moby Dick; Or, The Whale | ✗ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-15 | Dracula | Dracula | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-17 | The Monk: A Romance | The Monk: A Romance | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-18 | Moby Dick | Moby Dick; Or, The Whale | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-19 | Moby Dick | Moby Dick; Or, The Whale | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-20 | The Green Mummy | The Green Mummy | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-22 | The Confessions of St. Augustine | A Room with a View | ✗ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-23 | The Confessions of St. Augustine | The Man Who Was Thursday: A Nightmare | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-24 | The Extraordinary Adventures of Arsène | The Extraordinary Adventures of Arsène | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-25 | The Extraordinary Adventures of Arsène | Crime and Punishment | ✗ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-26 | Sense and Sensibility | Sense and Sensibility | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-27 | Sense and Sensibility | Sense and Sensibility | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-30 | The Blue Castle | Crime and Punishment | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-31 | The Blue Castle | Jane Eyre: An Autobiography | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-32 | A farewell to arms | A farewell to arms | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-33 | A farewell to arms | A farewell to arms | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-34 | Eloisa | Jane Eyre: An Autobiography | ✗ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-35 | Eloisa | Middlemarch | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-36 | The Adventures of Sherlock Holmes | The Extraordinary Adventures of Arsène | ✗ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-37 | The Adventures of Sherlock Holmes | The Man Who Was Thursday: A Nightmare | ✗ | ✗ | 10 | ✓ | HNSW 近似 |
| B5-38 | The Mystery of Edwin Drood | The Mystery of Edwin Drood | ✓ | ✓ | 10 | ✓ | HNSW 近似 |
| B5-39 | The Mystery of Edwin Drood | The Blue Castle: a novel | ✗ | ✗ | 10 | ✓ | HNSW 近似 |

</details>

