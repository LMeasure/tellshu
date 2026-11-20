# Stage B.5 收尾 · 资产冻结复核报告

> 复核时间：2026-10-12　·　**全程只读**，未执行任何写操作
> 阶段目的：确认「58k / 30 本」冻结基线仍然成立，才能把 Stage B.5 的结论当成决策依据

---

## Git Freeze Report

- **HEAD**: `f2174ba`（`f2174baae425d79573d290aca0b0566bf01bac42`）—— **未变化**，仍是最初那次提交，本轮零 commit
- **Modified files**: 11 个（全部为此前阶段遗留的本地改动，**本轮未新增任何修改**）
- **Untracked files**: 32 个（全部为脚本 / SQL 迁移 / Markdown 报告）
- **Risk files**: **0**

### Modified files 明细（11）

| 文件 | 来源阶段 |
|---|---|
| `.gitignore` | Stage B 收尾：补忽略规则 |
| `server/.gitignore` | Stage B.5：补 `.probe-cache/` 等 3 条 |
| `server/src/scripts/crawl-books.ts` | Stage C：新增 `--ids`（纯新增，不传时行为不变） |
| `src/components/reader/PageFlipContainer.tsx` | 阅读器 V3.1 |
| `src/components/reader/ReaderControlCenter.tsx` | 阅读器 V3.1 |
| `src/components/reader/ReaderSettingsSheet.tsx` | 阅读器 V3.1 |
| `src/index.css` | 阅读器 V3.1（`.animate-drawer-in` 等） |
| `src/pages/Reader.tsx` | 阅读器 V3.1 |
| `产品前提卡-给协作方.md` | 前提卡更新 |
| `发现书籍链路-Stage2前置召回实验方案.md` | Stage 2 方案 |
| `overview.md` | 项目说明 |

> **与检索链路相关的真相**：`server/src` 下**非 scripts 目录的已跟踪改动数 = 0**。
> 也就是说 —— **API 查询 SQL、检索路由、连接池配置一行都没动**。
> `src/` 下的 5 个改动全部属于阅读器 V3.1，与「发现书籍」页无关。

### Untracked files 明细（32）

脚本 / 迁移：`003_curation_flags.sql`、`discover-queries-b5.txt`、`discover-queries-stage2.txt`、
`flag-curation.py`、`hnsw-experiment.py`、`make-stageb-report.py`、`make-stageb5-report.py`、
`probe-stage-c-bench.py`、`probe-stage-c.ts`、`render-candidates.py`、`run-stage-c-ingest.py`、
`stage-b5-experiment.py`、`summarize-hnsw-exp.py`、`test_hnsw_counted.py`

报告 / 清单（21 个 Markdown）：未改动任何产线对象。

### Risk files 检查（入库风险）

| 检查项 | 结果 |
|---|---|
| `server/.crawl-cache/_b5-matrix.json`（实验 JSON） | ✅ IGNORED |
| `server/.probe-cache/1661.json` / `564.json`（探针正文） | ✅ IGNORED |
| `server/.crawl-cache/_stage-c-30/1661.json`（抓取正文） | ✅ IGNORED |
| `server/.hnsw-exp-matrix.json`（历史实验 JSON） | ✅ IGNORED |
| 已跟踪文件中的 `.db/.sqlite/.bin/.embedding/.vector/.pkl/.pt/.onnx/.tar/.zip` | ✅ **0 个**（干净） |
| 数据库文件 / embedding 原始数据入 Git | ✅ **无** |

---

## DB Freeze Report

### 数量一致性

| 对象 | 冻结值 | 实测值 | 结论 |
|---|---:|---:|---|
| `discovered_books` | 30 | **30** | ✅ |
| `discovered_book_chunks` | 58,332 | **58,332** | ✅ |
| `discovered_book_chunks.embedding` | 58,332 | **58,332** | ✅ |
| 向量维度 | 1024 | **1024**（`vector_dims()` 实测） | ✅ |
| `content_chars` 合计 | 25,625,443 | **25,625,443** | ✅ |
| 无章节块 | 11,769 | **11,769** | ✅ |

### 指纹一致性

| 校验项 | 值 | 结论 |
|---|---|---|
| 全局内容指纹 | `770e7c8bbaca404c8418087418d1c632` | ✅ 与冻结值一致 |
| 原 10 本指纹 | `5341e1b810d0b1e69aa7f2673b2608a3` | ✅ 未变 |

> 指纹公式（唯一判据，禁止自造）：
> `md5(string_agg(chunk_index || ':' || content_chars || ':' || coalesce(chapter_title,'<null>'), '|' ORDER BY id))`

### 索引与备份

| 对象 | 值 |
|---|---|
| `discovered_book_chunks_embedding_hnsw_idx`（正式） | **456 MB**（未 REINDEX） |
| `discovered_book_chunks_book_idx` | 976 kB |
| `discovered_book_chunks_pkey` | 1824 kB |
| `discovered_book_chunks_unique` | 2568 kB |
| `discovered_book_chunks_recipe_idx` | 616 kB |
| `discovered_book_chunks_emb_v1`（v1 备份） | rows=24,244 / emb=24,244（**未动**） |
| `discovered_book_chunks_exp`（实验副本） | 保留未删，COMMENT 为 *"Stage B experiment only. Do not use in production API."* |

### 生产参数（未改）

| 参数 | 当前值 | 本轮是否改动 |
|---|---|---|
| `hnsw.ef_search` | **40**（会话级与文件级一致） | ❌ 未改 |
| `hnsw.iterative_scan` | `off` | ❌ 未改 |
| `shared_buffers` | 16,384 (128 MB) | ❌ 未改 |
| `work_mem` | 4,096 (4 MB) | ❌ 未改 |
| `maintenance_work_mem` | 65,536 (64 MB) | ❌ 未改 |

> ⚠️ 提醒：HNSW 456 MB 已远超 `maintenance_work_mem` 64 MB。将来若要 REINDEX 必须先临时上调，
> 属于**环境变更**，本轮及其之前都未做。

---

## 结论

**生产资产冻结成立。** 可以安全地把 Stage B.5 的实验结论作为决策依据使用。

- ✅ Git：HEAD 未变、零 commit、零风险文件入库
- ✅ DB：数量 / 维度 / 内容指纹 / 索引体积 / v1 备份全部与冻结值一致
- ✅ 参数：`hnsw.ef_search` 仍为默认 40，未做任何生产配置调整
- ✅ 代码：`server/src` 非脚本部分零改动，API 检索路径未被触碰
- ✅ 实验副本 `discovered_book_chunks_exp` 保留，已打禁接生产的 COMMENT

---

## 待拍板项（本轮不做）

1. 是否在产线显式固定执行路径（EXACT / HNSW）
2. 是否把 `hnsw.ef_search` 上调到 800 量级
3. Query 集是否从 47 条扩到 100 条再重新定论
4. 本轮新增的脚本 / 迁移 / 报告是否纳入 Git
