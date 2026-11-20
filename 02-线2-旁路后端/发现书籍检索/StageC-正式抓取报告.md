# Stage C 正式抓取报告（A 组剩余 18 本）

- 执行日期：2026-10-11
- 范围：A 组 20 本中除探针已下载的 PG 1661 / PG 564 之外的 **18 本**
- 授权边界：只允许写正式 `discovered_*` 数据链路；不改 API / 前端 / 产品前提卡；不重建 HNSW；不提交 Git
- 产物：`server/.crawl-cache/`（正文与 RDF）、`server/.crawl-cache/_stage-c-ingest.log`、`_stage-c-ingest.json`

---

## 1. 执行前资产冻结检查（只读）

| 项 | 实测 | 冻结值 | 结论 |
|---|---|---|---|
| `discovered_books` | 10 | 10 | ✅ |
| `discovered_book_chunks` | 24,244 | 24,244 | ✅ |
| embedding | 24,244 条 / 1024 维 / recipe=v2 | 同 | ✅ |
| `content_chars` | 10,509,217 | 10,509,217 | ✅ |
| md5 指纹（项目既有公式） | `5341e1b810d0b1e69aa7f2673b2608a3` | 同 | ✅ |
| 正式 HNSW | `discovered_book_chunks_embedding_hnsw_idx` 189 MB | 189 MB | ✅ |
| v1 备份 | 24,244 行 / 24,244 向量 / 1024 维 | 同 | ✅ |
| Git HEAD | `f2174ba` | `f2174ba` | ✅ |

未发现任何正式资产变化，按授权继续执行。

---

## 2. 抓取流程执行情况

六步门禁全部按既有脚本执行，未另起炉灶：

| 步骤 | 实现 | 本轮实测 |
|---|---|---|
| robots 检查 | 抓取前预热 `https://www.gutenberg.org/robots.txt` | 首次握手失败、退避后 HTTP 200（冷启动现象复现，重试机制生效） |
| RDF 元数据 + 版权判定 | 口径 A：language=en 且所有作者/贡献者卒年 ≤ 1975 | 18 本全部通过，无一因版权被拒 |
| 正文 Range 下载 | Range 续传 + 重试退避 | 本轮无续传触发（一次收满），重试命中多次 |
| 完整性校验 | SHA256 + START/END 标记 + Content-Length 比对 | 18/18 全部 `ok` |

**网络情况需要如实说明**：Gutenberg 对 Node 客户端的 TLS 握手不稳定（curl 正常、Node 报 `Client network socket disconnected`）。首轮 18 本只成功 14 本，缺失的 4 本（2701 / 2868 / 67979 / 75201）**全部是网络失败，不是版权拒绝**，单独重试一轮后到齐。抓取脚本自身的 4 次重试不足以覆盖，本次在 shell 层加了一轮重试。

---

## 3. 逐本实测指标

| PG ID | 书名 | 作者 | 卒年 | 正文字节 | SHA256(前12) | RDF校验 | 正文下载ms | chunk | embedding | 入库耗时 | 章节 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 2701 | Moby Dick; Or, The Whale | Melville, Herman | 1891 | 1,276,315 | `b5e88b71a1cd` | ✅ | 2132 | 3,278 | 3,278 | 920s | 132 |
| 2868 | The Green Mummy | Hume, Fergus | 1932 | 533,606 | `dc857e3fba03` | ✅ | 1898 | 1,422 | 1,422 | 493s | 27 |
| 67979 | The Blue Castle: a novel | Montgomery, L. M. | 1942 | 428,204 | `b418e6dae927` | ✅ | 1769 | 1,099 | 1,099 | 188s | 45 |
| 34413 | The Love Letters of Mary Wollstonecraft | Wollstonecraft, Mary | 1936 | 212,807 | `a40eca210856` | ✅ | 1742 | 542 | 542 | 89s | 0 |
| 345 | Dracula | Stoker, Bram | 1912 | 890,348 | `96cd16eacdbf` | ✅ | 21024 | 2,348 | 2,348 | 351s | 27 |
| 11 | Alice's Adventures in Wonderland | Carroll, Lewis | 1898 | 174,311 | `01b38ea4c710` | ✅ | 1480 | 425 | 425 | 108s | 12 |
| 21839 | Sense and Sensibility | Austen, Jane | 1921 | 723,210 | `65f2dd0dee79` | ✅ | 2195 | 1,894 | 1,894 | 384s | 50 |
| 601 | The Monk: A Romance | Lewis, M. G. | 1818 | 828,870 | `9b139e3492be` | ✅ | 2183 | 2,115 | 2,115 | 336s | 12 |
| 43 | The strange case of Dr. Jekyll and Mr. Hyde | Stevenson, Robert Louis | 1894 | 163,495 | `b43448a88391` | ✅ | 1500 | 373 | 373 | 60s | 0 |
| 6133 | The Extraordinary Adventures of Arsène Lupin | Leblanc, Maurice | 1941 | 344,171 | `1b8fcfb07800` | ✅ | 1912 | 900 | 900 | 151s | 9 |
| 2680 | Meditations | Marcus Aurelius | 180 | 425,304 | `6977474f82a3` | ✅ | 1787 | 1,085 | 1,085 | 223s | 0 |
| 3011 | The Lady of the Lake | Scott, Walter | 1832 | 511,649 | `11c3cd3a8032` | ✅ | 2976 | 1,378 | 1,378 | ⚠ 含休眠 | 0 |
| 468 | Manon Lescaut | Prévost, abbé | 1763 | 370,240 | `6ccd3dbaee25` | ✅ | 1737 | 906 | 906 | 127s | 0 |
| 76639 | Eloisa : $b or, A series of original letters | Rousseau, Jean-Jacques | 1779 | 1,810,742 | `1131311fe3c5` | ✅ | 2509 | 4,505 | 4,505 | 710s | 4 |
| 72 | Thuvia, maid of Mars | Burroughs, Edgar Rice | 1950 | 295,385 | `5ad6732dba9d` | ✅ | 1907 | 830 | 830 | 127s | 14 |
| 75201 | A farewell to arms | Hemingway, Ernest | 1961 | 525,518 | `e33b8eea4483` | ✅ | 1919 | 1,344 | 1,344 | 217s | 41 |
| 3296 | The Confessions of St. Augustine | Augustine, of Hippo | 1882 | 632,170 | `ef3fa6267968` | ✅ | 2006 | 1,589 | 1,589 | ⚠ 含休眠 | 13 |
| 145 | Middlemarch | Eliot, George | 1880 | 1,865,684 | `dc2e0107e6ae` | ✅ | 2402 | 4,920 | 4,920 | 1130s | 86 |

**合计：正文 12,012,029 字节（11.5 MB）· chunk 30,953 · embedding 30,953 · 失败 0 · 回滚 0**

> 两本（3011 / 3296）的墙钟跨越了本机休眠，时长不可信，已剔除不参与速率统计。

### 汇总指标

| 指标 | 实测 |
|---|---|
| 下载总字节 | 12,012,029（11.5 MB，不含 RDF） |
| chunk 总数 | 30,953 |
| embedding 总数 | 30,953（chunk 与 embedding 一一对应，无跳过、无重复生成） |
| 有效 embedding 速率 | **4.99 条/s = 200.6 ms/条**（干净样本 27,986 条 / 5,614 s） |
| 全批有效耗时 | **约 103.5 分钟**（30,953 条按干净速率折算） |
| CPU | 峰值约 15.8 核等价（32 逻辑核） |
| **内存峰值 RSS** | **2,227.5 MB**（3,595 个采样点） |

**关于「每本内存峰值」**：ingest 是单进程长驻、模型只加载一次，进程 RSS 峰值是全程累积值，**无法按书拆分**。上表给的是全局峰值；探针阶段（2 本 3,135 条）独立测得的峰值是 2,241 MB，两者一致，说明 2.2 GB 主要是模型常驻开销，与处理规模弱相关。

**实测 vs 探针预测**：探针预测 30 本约 58,300 chunk、1.6 小时；本轮 18 本实测 30,953 chunk / 103.5 分钟。速率比探针的 5.95 条/s 慢 16%（探针只跑 3 千条、无写库开销），**预测偏差在 ±16% 内，可信**。

---

## 4. 2680 / 76639 的处理（保留原值 + 仅加标记）

新增可空列 `discovered_books.curation_flags jsonb`（迁移 `server/sql/003_curation_flags.sql`，幂等，已被 `db:migrate` 接管），只写这一列，**title / author_display / authors / contributors 一律未动**：

| PG | 原值（保留） | 标记 |
|---|---|---|
| 2680 | title=`Meditations`，author=`Marcus Aurelius, Emperor of Rome` | `translator_source_unverified`：译本，RDF 未给出译者与底本来源，不做推断 |
| 76639 | title=`Eloisa : $b or, A series of original letters`，author=`Rousseau, Jean-Jacques` | `title_cleanup_pending`：标题含 MARC 子字段符 `$b`，清洗规则待定，不自动改写 |

写入后已逐本复核原值一字未变（脚本内校验，不一致即回滚）。

---

## 5. 资产前后对比

| 项 | Stage C 前 | Stage C 后 | 说明 |
|---|---|---|---|
| `discovered_books` | 10 | **28** | +18 |
| `discovered_book_chunks` | 24,244 | **55,197** | +30,953 |
| embedding | 24,244 / 1024 / v2 | **55,197 / 1024 / v2** | 全 v2，未变 recipe |
| `content_chars` | 10,509,217 | **24,274,100** | |
| 无章节块（`chapter_title IS NULL`） | 7,203 (29.7%) | **11,764 (21.3%)** | 新增部分占比更低 |
| 正式 HNSW 索引 | 189 MB | **431 MB** | **插入时自动维护，未重建**（预测 454 MB，实测 431 MB） |
| v1 备份 | 24,244 | **24,244** | 未动 |
| **原 10 本 md5 指纹** | `5341e1b8…` | **`5341e1b8…` ✅ 一致** | 存量数据零改动 |
| Git HEAD | `f2174ba` | **`f2174ba`** | 未提交 |

---

## 6. ⚠️ 必须上报的发现：产线检索计划已静默切换

入库后我做了一次**只读**的执行计划与召回核对（纯 `SELECT`，未写入、未 DDL、未改任何配置），结果超出预期：

```
hnsw.ef_search      = 40        ← pgvector 默认值，从未被显式设置
hnsw.iterative_scan = off

过滤开：Index Scan using discovered_book_chunks_embedding_hnsw_idx
过滤关：Index Scan using discovered_book_chunks_embedding_hnsw_idx
```

**24k 时优化器把同样的查询判成 Seq Scan（等于精确检索，P50 72.8 ms）；55k 后改判为 HNSW Index Scan。** 也就是说：

- 产线检索行为**在任何配置都没有改动的情况下，从精确检索静默切换成了 ANN**；
- 而且用的是 `ef_search=40` —— **这正是 Stage 1 实测召回崩到 1/6 的那个值**。

55k 下的粗测对照（16 条查询集，每档 1 轮，**样本量小，仅作预警不作结论**）：

| 口径 | 计划 | P50 | Top1 命中 | Top10 内含 |
|---|---|---|---|---|
| 产线默认（ANN, ef=40）· 过滤开 | Index Scan | 57.1 ms | 7/13 | 7/13 |
| 产线默认（ANN, ef=40）· 过滤关 | Index Scan | 1.1 ms | 8/14 | 8/14 |
| 强制精确 · 过滤开 | Seq Scan | 304.1 ms | 8/13 | 12/13 |
| 强制精确 · 过滤关 | Seq Scan | 217.9 ms | 10/14 | 13/14 |

两点要说清楚：

1. **ANN 比精确检索少命中 1 条 Top1，且 Top10 内含差距明显（7/13 vs 12/13）** —— 与 Stage B 在 24k 下的结论方向一致：ANN 换不来召回。
2. **精确检索本身的 Top1 也比 24k 时下降了**（过滤开 10/13 → 8/13）。这不是索引问题，是**干扰项变多**——30,953 个新 chunk 进来后，部分 Query 的最近邻被别的书抢走。分母只有 13 条，1 条即 7.7 pp，但方向值得警惕。

**我没有做任何改动**：不重建索引、不调 `ef_search`、不改任何配置。这需要你拍板。

---

## 7. 未执行内容（严格遵守授权边界）

- ❌ 未抓取 1661 / 564 之外的任何书（**当前 28 本，不是 30 本**，见下）
- ❌ 未重建 / 未 REINDEX 正式 HNSW 索引（431 MB 是插入自动维护的结果）
- ❌ 未修改 API、未修改前端、未合并产品前提卡
- ❌ 未修改 `discovered_book_chunks_emb_v1`（仍 24,244 行）
- ❌ 未提交任何 Git 对象（HEAD 仍 `f2174ba`）
- ❌ 未修改任何 PostgreSQL 参数

---

## 8. 待确认事项

1. **总数不是 30 本而是 28 本** —— PG 1661 / PG 564 在探针阶段只下载了正文做测试，**从未入库**。正文已在 `server/.probe-cache/`，补入库约需 15 分钟（约 3,135 条）。要不要补，等你定。
2. **ANN / 精确检索的取舍** —— 见 §6。可选方向：(a) 显式 `SET hnsw.ef_search` 到较大值并强制走索引；(b) 显式禁用索引回到精确检索（P50 约 300 ms）；(c) 重跑阶段 B 参数实验后再定。**我倾向先扩大查询集分母（现 13 条太小）再决策。**
3. **是否重跑阶段 B** —— 规模已从 24k 变 55k，阶段 B 的全部结论（含「精确优先」）严格来说都已过期。
4. **HNSW 索引 431 MB vs `maintenance_work_mem` 64 MB** —— 若将来要 REINDEX，建议临时上调。这属于环境变更，我没动。
5. **本轮新增文件是否纳入 Git**：`server/sql/003_curation_flags.sql`、`server/src/scripts/run-stage-c-ingest.py`、`server/src/scripts/flag-curation.py`、`crawl-books.ts` 的 `--ids` 改动、本报告。
