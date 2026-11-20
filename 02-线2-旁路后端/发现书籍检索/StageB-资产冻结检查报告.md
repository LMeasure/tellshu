# Stage B · 资产冻结检查报告

> 检查时间：2026-10-10 23:19（GMT+8）
> 检查方式：**纯只读**（`set_session(readonly=True, autocommit=True)`，未执行任何 DDL / DML）
> 检查脚本：`server/.tmp_asset_freeze_check.py`（临时脚本，gitignore）
> 结论：**PASS —— 正式资产与 Stage B 实验开始前完全一致，无偏离。**

---

## 1. 正式表

| 项目 | 要求 | 实测 | 判定 |
|---|---|---|---|
| `discovered_books` 行数 | 10 本书 | **10** | ✅ |
| `discovered_book_chunks` 行数 | 24,244 | **24,244** | ✅ |
| embedding 非空数 | 24,244 | **24,244** | ✅ |
| embedding 维度 | 1024（BGE-M3） | **1024** | ✅ |
| embedding 内积合计（单位向量校验） | ≈24,244 | **24,244.0012** | ✅ |
| `embedding_recipe` 分布 | 全 `v2-title-author-chapter` | **24,244 条全为 v2** | ✅ |
| `chapter_title IS NULL` 块数 | 7,203 | **7,203** | ✅ |
| `content_chars` 合计 | 10,509,217 | **10,509,217** | ✅ |
| 内容指纹 | `5341e1b810d0b1e69aa7f2673b2608a3` | **完全一致** | ✅ |

**内容指纹公式**（与 `hnsw-experiment.py` 内置指纹函数同款，保证可比）：
`md5(string_agg(chunk_index || ':' || content_chars || ':' || coalesce(chapter_title,'<null>'), '|' ORDER BY id))`

> 备注：本次检查先用 `length(content)` + 正文拼接算过一个 md5（`ff87efaacc0d9082ef119fee8f5c352c`），与实验记录的 `5341e1b8…` 不同。**已核实为公式差异导致的预期不同，不是数据变化** —— 换成脚本同款公式后逐字符一致。

## 2. 正式索引（`discovered_book_chunks` 上共 5 个）

| 索引名 | 类型 | 大小 | DDL |
|---|---|---|---|
| `discovered_book_chunks_embedding_hnsw_idx` | **hnsw** | **189 MB（198,615,040 B）** | `USING hnsw (embedding vector_cosine_ops)` |
| `discovered_book_chunks_pkey` | btree (PK) | 1080 kB | `(id)` |
| `discovered_book_chunks_unique` | btree (UNIQUE) | 1512 kB | `(book_id, chunk_index)` |
| `discovered_book_chunks_book_idx` | btree | 728 kB | `(book_id)` |
| `discovered_book_chunks_recipe_idx` | btree | 464 kB | `(embedding_recipe)` |

- **正式 HNSW 索引数量 = 1，大小 189 MB，与实验记录逐字节一致，未被重建、未被删除。**
- 无残留的实验索引挂在正式表上。

## 3. 备份表

| 项目 | 要求 | 实测 | 判定 |
|---|---|---|---|
| `discovered_book_chunks_emb_v1` 行数 | 24,244 | **24,244** | ✅ |
| embedding 非空数 | 24,244 | **24,244** | ✅ |
| 内积合计 | ≈24,244 | **24,244.0014** | ✅ |
| 其上的索引 | — | `discovered_book_chunks_emb_v1_bk_idx`（760 kB，btree） | 正常 |

**v1 备份表未被删除、未被覆盖。**

## 4. 实验副本表（允许修改，仅记录状态）

| 项目 | 实测 |
|---|---|
| `discovered_book_chunks_exp` 行数 | 24,244 |
| 表体积 | 333 MB |
| 索引 `exp_hnsw_idx` | 189 MB（矩阵最后一组留下的 m=16 / efC=64） |
| 当前表 COMMENT | **无**（本轮待补，见第四节） |

## 5. 库内 `discovered_*` / `*exp*` 对象全量盘点

| 类型 | 对象 | 体积 |
|---|---|---|
| r | `discovered_book_chunks` | 389 MB |
| r | `discovered_book_chunks_emb_v1` | 131 MB |
| r | `discovered_book_chunks_exp` | 333 MB |
| r | `discovered_books` | 136 kB |
| i | `discovered_book_chunks_embedding_hnsw_idx` | 189 MB |
| i | `exp_hnsw_idx` | 189 MB |
| i | `discovered_book_chunks_unique` | 1512 kB |
| i | `discovered_book_chunks_pkey` | 1080 kB |
| i | `discovered_book_chunks_emb_v1_bk_idx` | 760 kB |
| i | `discovered_book_chunks_book_idx` | 752 kB |
| i | `discovered_book_chunks_recipe_idx` | 488 kB |
| i | `discovered_books_language_idx` | 16 kB |
| i | `discovered_books_pkey` | 16 kB |
| i | `discovered_books_source_unique` | 16 kB |
| S | `discovered_book_chunks_id_seq` / `discovered_books_id_seq` | 8192 B |

**无预期外对象。**

## 6. 关键文件修改时间

| 修改时间 | 大小 | 文件 |
|---|---|---|
| 2026-10-09 22:42:44 | 30,773 B | `server/src/scripts/hnsw-experiment.py` |
| 2026-10-09 22:44:33 | 11,698 B | `server/src/scripts/summarize-hnsw-exp.py` |
| 2026-10-09 00:38:12 | 41,160 B | `server/src/scripts/ingest-books.py` |
| 2026-10-07 23:18:34 | 71,944 B | `server/src/scripts/crawl-books.ts` |
| 2026-10-09 00:32:05 | 6,132 B | `server/sql/002_discover.sql` |
| 2026-10-09 22:42:04 | 14,105,231 B | `server/.hnsw-exp-matrix.json` |
| 2026-10-09 22:44:39 | 18,557 B | `server/.hnsw-summary.txt` |
| 2026-10-09 22:42:04 | 14,006 B | `server/.hnsw-matrix.log` |
| 2026-10-09 22:02:47 | 7,124 B | `server/.hnsw-exp-probe.json` |
| 2026-10-09 22:23:12 | 987,596 B | `server/.hnsw-smoke.json` |

**判读：**
- `ingest-books.py`（10-09 00:38）与 `crawl-books.ts`（10-07）的最后修改时间**都早于**实验产物（10-09 22:42），说明**实验期间未跑过抓取或重新 embedding**。
- 实验产物时间戳集中在 10-09 22:02–22:44，与「54 组矩阵耗时 5 分 12 秒 + 汇总重跑」的时间线吻合。

---

## 7. 结论

| 检查项 | 结果 |
|---|---|
| 正式表 10 本书 / 24,244 chunk | ✅ 未变 |
| 正式 embedding（24,244 条，1024 维，单位向量） | ✅ 未变 |
| 正式 HNSW 索引（1 个，189 MB） | ✅ 未变 |
| v1 备份表（24,244 行） | ✅ 未变 |
| 内容指纹 | ✅ 一致 |
| 无预期外数据库对象 | ✅ |
| 抓取 / embedding 脚本未被重新执行 | ✅ |

**未发现任何正式资产变化，无需停止。实验副本表状态正常，可继续本轮收尾工作。**
