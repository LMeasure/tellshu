# Stage C 前置探针 · 阶段一~三报告（**未执行探针**）

> 生成日期：2026-10-11
> 状态：阶段一（资产冻结只读检查）✅ / 阶段二（.gitignore 遗漏检查）✅ / 阶段三（候选选择）✅
> **阶段四（探针执行）未开始，等待确认。**
> 本文件生成过程：只读查询 + 新增文档。未下载正文、未写库、未改 API/前端、未提交 Git、未合并前提卡。

---

## 阶段一 · 资产冻结检查（只读）

### 1.1 Git

| 项 | 值 | 判断 |
|---|---|---|
| HEAD commit | `f2174ba` | ✅ 未变 |
| 工作区已跟踪改动 | `.gitignore`（+26）、`发现书籍链路-Stage2前置召回实验方案.md`（+52/−12） | 均为上一轮/本轮文档与忽略规则，**非代码** |
| 未提交文件 | 22 个（全部为 `.md` / `.py` / `.txt` 文档与脚本） | ✅ |
| **大文件风险** | **>1 MB 的未忽略文件：0 个** | ✅ |
| 最大未忽略文件 | `server/src/scripts/hnsw-experiment.py` — 32 KB | ✅ 正常 |
| 数据库文件 / embedding 文件 | **0 个** | ✅ |

> 上一轮新增的 `.gitignore` 规则已生效：14 MB 的 `.hnsw-exp-matrix.json` 等大型实验产物
> 已不在 `git status` 中，风险解除。

### 1.2 数据库（只读，指纹沿用项目已有公式）

**指纹公式**（项目已有，未新设计）：
`md5(string_agg(chunk_index || ':' || content_chars || ':' || coalesce(chapter_title,'<null>'), '|' ORDER BY id))`

| 资产 | 冻结值 | 实测 | 状态 |
|---|---|---|---|
| `discovered_books` | 10 本 | **10** | ✅ |
| `discovered_book_chunks` | 24,244 行 | **24,244** | ✅ |
| embedding 条数 | 24,244 | **24,244** | ✅ |
| **embedding 维度** | 1024 | **1024**（`vector_dims` 去重后唯一值） | ✅ |
| **content_chars 总量** | 10,509,217 | **10,509,217** | ✅ |
| `embedding_recipe` | v2 | **v2-title-author-chapter** | ✅ |
| `chapter_title IS NULL` | 7,203 | **7,203** | ✅ |
| **md5 指纹** | `5341e1b810d0b1e69aa7f2673b2608a3` | **一致** | ✅ |
| `discovered_book_chunks_emb_v1` | 24,244 行 | **24,244**（向量 24,244 / 维度 1024） | ✅ |
| 正式 HNSW index | 189 MB | `discovered_book_chunks_embedding_hnsw_idx` **189 MB** | ✅ |

**关于 v1 备份表的指纹**：该表结构为
`(book_id, chunk_index, embedding, embedding_model, embedding_dim, embedding_recipe)`，
**不含 `content_chars` 与 `chapter_title`**，因此上面的内容指纹公式**对它不适用**。
我没有为它新造一个指纹算法（遵守「禁止自行设计新的指纹算法」），只核对了冻结口径里的
**行数 24,244 / 向量数 24,244 / 维度 1024**，全部一致。

**库内 `discovered_*` 表清单**（确认无新增正式表）：
`discovered_books`、`discovered_book_chunks`、`discovered_book_chunks_emb_v1`、
`discovered_book_chunks_exp`（实验副本，已标记）。

### 1.3 结论

**正式资产：`UNCHANGED`。** 无需停止，可继续。

---

## 阶段二 · `.gitignore` 遗漏检查（**只出建议，未修改**）

检查结果 —— **三个文件全部遗漏**（均未被忽略）：

| 文件 | 体积 | 是否被忽略 |
|---|---|---|
| `server/.hnsw-exp-probe.json` | 7,124 B | ❌ 遗漏 |
| `server/.hnsw-summary.txt` | 18,557 B | ❌ 遗漏 |
| `server/.candidate-render.md` | 7,465 B | ❌ 遗漏 |

### 建议

```
建议新增规则：
    *.hnsw-exp-probe.json
    *.hnsw-summary.txt
    *.candidate-render.md

原因：
    这三类都是脚本的**派生输出**，与已忽略的 .hnsw-exp-matrix.json / .hnsw-smoke.json
    同源同性质 —— 由 hnsw-experiment.py、summarize-hnsw-exp.py、render-candidates.py
    生成，内容可由脚本随时重算，进仓库只会制造无意义的 diff 噪音。
    上一轮补规则时它们不在你给的清单里，我未自行扩大范围，故至今仍暴露。

影响：
    三条规则共覆盖 3 个文件、合计约 33 KB，**体积影响可忽略**。
    收益是 git status 里不再出现派生产物，降低误提交概率，
    也让「哪些是真文档、哪些是脚本输出」一眼可分。
    风险：无 —— 这三个文件都可一键重算（重跑对应脚本即可），
    且本轮未删除任何文件，忽略不等于删除。
```

**等待确认后我再改 `.gitignore`。** 当前 `.gitignore` 除上一轮的 +26 行外未被触碰。

---

## 阶段三 · 探针候选书选择（**等确认**）

### 3.1 选择口径

按你的三条标准筛 A 组 20 本（**全部已通过版权过滤口径 A**）：

1. **正文体量中等** → 取预估 chunk 在 **1,000 ~ 2,000** 区间（避开 442 的过小样本与 5,301 的超大体量）
2. **章节结构完整** → 优先经典分章小说（避免诗歌/书信体/译本导致的章节格式不统一）
3. **非重复版本** → 排除 B 组的 42 / 45839 / 42671；且不在已入库 10 本内
   （已入库：1260 / 1342 / 1513 / 1695 / 1727 / 2465 / 2554 / 2641 / 3268 / 59828）

**额外一条我自己加的约束**：排除候选书单里标注「需人工复核」的 6 本
（34413 / 21839 / 2680 / 76639 / 72 / 75201 / 3296）——
探针不该依赖尚未拍板的人工决策，否则测出来的数据可能要作废。

### 3.2 候选表

| id | title | author | death year | rights | estimated chunks |
|---|---|---|---|---|---|
| **1661** | The Adventures of Sherlock Holmes | Doyle, Arthur Conan（1859–1930） | **1930** | Public domain in the USA. | **1,776** |
| **564** | The Mystery of Edwin Drood | Dickens, Charles（1812–1870） | **1870** | Public domain in the USA. | **1,653** |

两本合计预估 **3,429 chunk**（txt 合计 1,172,722 B ≈ 1.1 MB）。

**为什么是这两本**：

- **体量中等且接近**（1,776 / 1,653）—— 样本量足够算速率，两本互相印证可看出方差。
- **章节结构可靠**：福尔摩斯短篇集每篇独立成章；狄更斯长篇是标准编号章节。
  两者都不是诗歌（如 3011《The Lady of the Lake》分 canto）或书信体（34413），
  能规避 Stage 1 踩过的「章节格式不统一」坑。
- **无重复版本、无待人工复核项**，两条都不占。
- 版权证据完整：`language=en`、作者卒年真实（1930 / 1870）均 ≤ 1975。

### 3.3 备选（若你不认可上面两本）

| id | title | death year | est. chunks | 备注 |
|---|---|---|---|---|
| 67979 | The Blue Castle: a novel | 1942 | 1,170 | 体量中等， Montgomery 长篇，章节规整 |
| 2868 | The Green Mummy | 1932 | 1,471 | Hume 长篇，章节规整 |
| 468 | Manon Lescaut | 1763 | 1,082 | **译本**（法→英），章节结构风险略高 |
| 3011 | The Lady of the Lake | 1832 | 1,402 | **叙事诗**，分 canto，章节解析风险高，不推荐做探针 |

### 3.4 诚实标注：一项无法在选书阶段验证的事

**「章节结构完整」这条我目前只能靠文本类型推断，不能实测** ——
要确认必须下载正文，而下载正文属于阶段四，需你先确认。
所以探针执行后我会**实测两本的 `chapter_title` 覆盖率**并如实回报；
如果其中一本大量块落到 `NULL`，我会说明原因并告诉你需要换书重测的成本。

---

## 阶段四 · 探针执行方案（**待你确认后才跑**）

### 4.1 隔离设计（不碰任何正式对象）

| 环节 | 隔离方式 |
|---|---|
| 正文与 RDF 下载 | 落到**独立临时目录** `server/.probe-cache/`，**不写** `.crawl-cache/` |
| chunk 测试 | 复用 `ingest-books.py` 的切块函数，**纯内存/临时文件**，不落库 |
| embedding 测试 | 模型 `BAAI/bge-m3`，`HF_HUB_OFFLINE=1` 本地跑，**结果只写临时 JSON** |
| 数据库 | **优先完全不落库**。若确需落库，建独立表 `probe_chunks_exp` 并打 `COMMENT 'Stage C probe only. Do not use in production API.'` |
| 正式表 / 正式 embedding / 正式 HNSW | **一律不写、不重建** |

### 4.2 执行步骤（仅限这 6 步）

1. 下载正文（`crawl-books.ts` 的 Range 续传 + 重试退避路径）
2. 保存 RDF metadata
3. SHA256 校验
4. START/END 标记校验
5. chunk 测试（记录实际 chunk 数，与预估 1,776 / 1,653 对比）
6. embedding 测试（记录速率）

### 4.3 会记录的指标（按你的要求）

- 下载耗时（分本）
- chunk 数量（实际值）
- embedding 数量
- **单条 embedding 平均耗时**（核心目标）
- 总耗时
- CPU 使用情况
- **内存峰值**

### 4.4 明确不做

- 建正式索引 ❌
- 写正式表 ❌
- 抓其余 18 本 ❌
- 改 API / 前端 ❌
- 合并前提卡 ❌
- Git commit ❌

---

## 下一步等待确认

1. **是否认可探针候选：PG 1661 + PG 564？**（或指定备选）
2. **是否批准执行阶段四探针**（下载这 2 本正文 + 跑 chunk/embedding 测试）？
3. **是否批准我给 `.gitignore` 补上阶段二的三条规则？**
