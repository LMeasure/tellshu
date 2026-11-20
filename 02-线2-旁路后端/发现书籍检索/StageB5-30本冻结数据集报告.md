# Stage B.5 · 30 本冻结数据集报告

> 生成时间：2026-10-11
> 范围：补入 PG 1661 / PG 564 → 冻结 30 本数据集 → 之后的实验一律以本报告的指纹为基线
> 数据库：PostgreSQL 18.6 @127.0.0.1:5432/shutree，pgvector 0.8.6
> 本轮动作：**写库只有 discovered_books / discovered_book_chunks 两表的 2 本书 3,135 条新记录**；
> 未改任何既有行、未重建索引、未提交 Git。

---

## 1. 为什么要补这两本

Stage C 结束时是 **28 本**：PG 1661 / PG 564 在探针阶段只下载了正文（落在 `server/.probe-cache/`），
没有走 `crawl-books.ts`，因此产物缺少 `title / authors / rights / copyright / language / cover_url`
等元数据字段，**不能直接入库**（缺字段入库＝编造元数据，违反红线）。

补入做法：对这两本**重新走一遍正式抓取链路** `crawl-books.ts --ids 1661,564`，拿到完整 RDF 元数据 +
Range 续传正文 + SHA256 + START/END 校验，产物落在 `server/.crawl-cache/_stage-c-30/`，
再走 `ingest-books.py` 按书级事务入库。探针产物**只用于速率预估，未参与入库**。

---

## 2. 补入过程实测

### 2.1 抓取（crawl-books.ts --ids 1661,564）

| 项 | PG 1661 | PG 564 |
|---|---|---|
| 榜单命中 | #11 | #32（榜单共 119 本） |
| RDF | 200 / 17,950 B | 200 / 20,180 B |
| 版权口径 A | ✅ en，作者 1，最大卒年 **1930** | ✅ en，作者 1，最大卒年 **1870** |
| rights | Public domain in the USA. | Public domain in the USA. |
| 正文 URL | `/cache/epub/1661/pg1661.txt` | `/cache/epub/564/pg564.txt` |
| 正文字符 | 562,213 | 539,937 |
| 章节解析 | tier=bare-counter，**12 章**，与 RDF `dcterms:tableOfContents` 交叉核对一致 | tier=chapter，**23 章** |
| 网络 | 2 次失败后第 3 次成功（TLS 抖动，非版权拒绝） | 3 次失败后第 4 次成功 |
| 封面 | 有（pg1661.cover.medium.jpg） | 有（pg564.cover.medium.jpg） |

### 2.2 入库（ingest-books.py --in .crawl-cache/_stage-c-30 --batch 16）

| 指标 | 实测 |
|---|---|
| 书籍 upsert | 2 |
| chunk 写入 | **3,135**（1661 = 1,595 / 564 = 1,540） |
| 新生成 embedding | 3,135（recipe = v2-title-author-chapter，1024 维，BAAI/bge-m3 本地离线） |
| 跳过重算 | 0 |
| 整本回滚 | 0 |
| 失败条目 | 0 |
| 墙钟 | **587.7 s（9.8 分钟）** |
| 速率 | **5.33 条/s ≈ 187.5 ms/条** |
| RSS 峰值 | 采样峰值 1,799.4 MB / 生命周期峰值 1,878.7 MB |

> 说明：探针预估 3,135 条，正式入库实际 3,135 条，**完全一致**。
> 速率 5.33 条/s 略快于 Stage C 的 4.99 条/s（Stage C 是 18 本连跑，写库开销占比更高），同量级。

---

## 3. 冻结基线（30 本）

### 3.1 全局指标

| 指标 | 冻结值 |
|---|---|
| 书籍 `discovered_books` | **30** |
| chunk `discovered_book_chunks` | **58,332** |
| embedding 数 / 维度 / recipe | **58,332 / 1024 / v2-title-author-chapter**（无缺失） |
| 正文字符合计 | **25,625,443** |
| 无章节块（chapter_title IS NULL） | **11,769（20.18%）** |
| 正式 HNSW 索引 | `discovered_book_chunks_embedding_hnsw_idx`，**456 MB**（477,863,936 B） |
| v1 备份 `discovered_book_chunks_emb_v1` | **24,244** 行（未动） |
| **全局内容指纹** | **`770e7c8bbaca404c8418087418d1c632`** |

指纹公式（项目唯一口径，勿另写）：

```sql
md5(string_agg(chunk_index || ':' || content_chars || ':' || coalesce(chapter_title,'<null>'),
               '|' ORDER BY id))
```

### 3.2 存量 10 本指纹未变

1260 / 1342 / 1513 / 1695 / 1727 / 2465 / 2554 / 2641 / 3268 / 59828 单独聚合结果：

```
5341e1b810d0b1e69aa7f2673b2608a3     ← 与 Stage C 之前记录的冻结值一致，未被改动
```

### 3.3 治理标记仍在

| source_id | curation_flags | 原值是否改动 |
|---|---|---|
| 2680 | `translator_source_unverified` | 否（title / author 一字未改） |
| 76639 | `title_cleanup_pending` | 否（标题含 `$b`，保留原值） |

### 3.4 逐本冻结值

| source_id | 书名 | 作者 | chunk | 有章节块 | 逐本指纹 |
|---:|---|---|---:|---:|---|
| 11 | Alice's Adventures in Wonderland | Carroll, Lewis | 425 | 423 | `92501901817747383c8f4cc950e78db6` |
| 43 | The strange case of Dr. Jekyll and Mr. Hyde | Stevenson, Robert Louis | 373 | **0** | `982afa6611c62a788a1c68f4dad3b0a0` |
| 72 | Thuvia, maid of Mars | Burroughs, Edgar Rice | 830 | 828 | `98b4728232a0055764bc6d72da648697` |
| 145 | Middlemarch | Eliot, George | 4,920 | 4,909 | `f2e8b3c6e37a75526e1117f88357ddee` |
| 345 | Dracula | Stoker, Bram | 2,348 | 2,341 | `c962f02a45892ca4cf25cd0f25c034f0` |
| 468 | Manon Lescaut | Prévost, abbé | 906 | **0** | `7008e993a6806ce4907a728465967adc` |
| 564 | **The Mystery of Edwin Drood** 🆕 | Dickens, Charles | 1,540 | 1,537 | `51dafe233ec2c3a2dc69262bcd18049b` |
| 601 | The Monk: A Romance | Lewis, M. G. | 2,115 | 2,107 | `7fc7e079406bdb69825795f674118396` |
| 1260 | Jane Eyre: An Autobiography | Brontë, Charlotte | 2,854 | 2,841 | `ce9b6b05361b4da669a3734f0f6bd250` |
| 1342 | Pride and Prejudice | Austen, Jane | 2,055 | 1,979 | `6e45f19fba974991a433613b398d6a71` |
| 1513 | Romeo and Juliet | Shakespeare, William | 418 | 411 | `e713da97ff7329dc0f9d91c72e12789b` |
| 1661 | **The Adventures of Sherlock Holmes** 🆕 | Doyle, Arthur Conan | 1,595 | 1,593 | `99a0cae9e30f26c9c9281a654aff2fdd` |
| 1695 | The Man Who Was Thursday: A Nightmare | Chesterton, G. K. | 904 | 894 | `80645765568b1e64d1ca0c3ab72fd8b8` |
| 1727 | The Odyssey（含换行副标题） | Homer | 1,835 | 1,800 | `5ec788e5898376518c8a7bec77aa5292` |
| 2465 | Carmen | Mérimée, Prosper | 364 | 363 | `2aecbc581a621cbb5fdc6d49d17b4123` |
| 2554 | Crime and Punishment | Dostoyevsky, Fyodor | 3,177 | 3,166 | `6f765c47cab1d859c19ad291cc3cefb0` |
| 2641 | A Room with a View | Forster, E. M. | 1,084 | 1,082 | `93165abccea11f08b855d4f74a7e1beb` |
| 2680 | Meditations | Marcus Aurelius | 1,085 | **0** | `e95e2c94ea5dcb3b77ae997a4d8efcd1` |
| 2701 | Moby Dick; Or, The Whale | Melville, Herman | 3,278 | 3,209 | `4bd99e99994cfd02b6b9f2a1b4ba800b` |
| 2868 | The Green Mummy | Hume, Fergus | 1,422 | 1,420 | `4dbc74ed883b33e7debd784fc1bafeb0` |
| 3011 | The Lady of the Lake | Scott, Walter | 1,378 | **0** | `130373f391086bb168e4840fac12de6b` |
| 3268 | The Mysteries of Udolpho | Radcliffe, Ann Ward | 4,509 | 4,505 | `41579216feb96ef535e8f1199fcae9a7` |
| 3296 | The Confessions of St. Augustine | Augustine, of Hippo, Saint | 1,589 | 1,588 | `bca4b78ad457248edadc0125c96c21db` |
| 6133 | Arsène Lupin, Gentleman-Burglar | Leblanc, Maurice | 900 | 898 | `40b16fe3f4ffc48f6a3f88c831dcdd60` |
| 21839 | Sense and Sensibility | Austen, Jane | 1,894 | 1,857 | `cac9d9c9abb0a1f3f9fbd6681df498fd` |
| 34413 | The Love Letters of Mary Wollstonecraft | Wollstonecraft, Mary | 542 | **0** | `7199319d7321bad2a3c3385680b6c91b` |
| 59828 | The String of Pearls（Sweeney Todd） | Rymer / Prest | 7,044 | **0** | `fafba30fed4c242deda39fa5bdb057e8` |
| 67979 | The Blue Castle: a novel | Montgomery, L. M. | 1,099 | 1,096 | `79b50076aeb0428cf4de41f856c2bacd` |
| 75201 | A farewell to arms | Hemingway, Ernest | 1,344 | 1,341 | `73461c308e921304b59fbd2fe21b0141` |
| 76639 | Eloisa : $b or, A series of original letters | Rousseau, Jean-Jacques | 4,505 | 4,375 | `ab1ae4010febe7b809f0429ecadce061` |

**7 本完全没有有章节块**（43 / 468 / 2680 / 3011 / 34413 / 59828，另加 1727 等有少量）。
在「chapter_title IS NOT NULL」过滤口径下这 6 本整体不可召回——Stage B.5 的查询集已按库内实测
自动把它们排除出过滤口径的分母（见下节）。

---

## 4. 冻结后的实验查询集（分母从 13 扩到 45）

文件：`server/src/scripts/discover-queries-b5.txt`

| 类别 | 条数 | 说明 |
|---|---:|---|
| `fixed` | 6 | Stage 1 固定 6 条，原文一字不改，跨阶段可比 |
| `stage2` | 8 | Stage 2 的 N1–N8，原文一字不改 |
| `b5` | 37 | 本轮新增定向 Query，锚点全部 ILIKE 实测核实 |
| `probe` | 2 | F1/F2 行为探针，不计入分母 |
| `control` | 2 | 负对照，不计入分母 |
| **合计** | **55** | |

分母口径（由脚本按库内实测自动判定，不写死）：

- 过滤关闭：**51**
- 过滤开启：**45**（51 − 6 条期望书名在库中无任何有章节块）

> 之前分母只有 13，1 条 = 7.7pp，任何 <15pp 的差异都是噪声。
> 扩到 45 之后 1 条 = 2.2pp，7pp 以上的差异才谈得上可分辨。

### 4.1 锚点校验结果

`stage-b5-experiment.py --verify-anchors`：**0 条需要复核**（首轮 4 条不合格已换锚点后复测通过）。

首轮被否掉的 4 条（记录备查，防止将来重复踩坑）：

| 原锚点 | 问题 | 替换为 |
|---|---|---|
| `Monica` | 全库仅 4 命中，全在 Sherlock Holmes | `Alypius`（29，100% 落在 Confessions） |
| `Lupin` | 命中 707，其中 430 条在 String of Pearls（"lupine" 子串干扰） | `Arsène`（250，100% 落在 Arsène Lupin） |
| `Julie` | 命中 147，其中 140 条在 Romeo and **Juliet** | `Wolmar`（273，100% 落在 Eloisa） |
| `Saint-Preux` | 全库 0 命中 | `Clarens`（43，98% 落在 Eloisa） |

---

## 5. 本轮未做的事（明确边界）

- **未重建 / REINDEX 正式 HNSW 索引**：456 MB 是新块插入时自动维护的结果，没有人工干预。
- **未改 API / 前端 / 前提卡**。
- **未提交 Git**（HEAD 仍为 `f2174ba`）。
- **未做**任何检索参数变更——那是 Stage B.5 实验要回答的问题，见《发现书籍链路-StageB5实验报告.md》。

---

## 6. 产物清单

| 路径 | 说明 |
|---|---|
| `server/.crawl-cache/_stage-c-30/1661.json` / `564.json` | 正式抓取产物（含完整 RDF 元数据） |
| `server/.crawl-cache/_stage-c30-ingest.log` / `.json` | 入库日志与速率/内存指标 |
| `server/src/scripts/discover-queries-b5.txt` | B.5 查询集（55 条，含锚点列） |
| `server/src/scripts/stage-b5-experiment.py` | B.5 实验脚本（**只读**，不建索引不写库） |
| `server/.crawl-cache/_b5-matrix.json` | B.5 矩阵原始结果 |
