# Stage C Probe Preflight Freeze Report

> 生成日期：2026-10-11
> 阶段：第三阶段（执行前状态冻结）
> **状态：前三阶段全部完成，第四阶段未执行，等待明确授权「执行阶段四探针」。**
> 本轮动作：仅修改 `.gitignore`（+3 行）+ 新增文档 + 只读查询。
> **未下载正文、未抓取 Gutenberg、未运行 chunk、未运行 embedding、未进入正式数据链路。**

---

## 1. 数据库冻结状态

| 资产 | 冻结值 | 执行前实测 | 判定 |
|---|---|---|---|
| `discovered_books` count | 10 | **10** | ✅ |
| `discovered_book_chunks` count | 24,244 | **24,244** | ✅ |
| `embedding` count | 24,244 | **24,244** | ✅ |
| `embedding` dimension | 1024 | **1024**（去重后唯一值） | ✅ |
| `embedding_recipe` | v2 | **v2-title-author-chapter** | ✅ |
| `content_chars` 合计 | 10,509,217 | **10,509,217** | ✅ |
| md5 指纹（项目已有公式） | `5341e1b810d0b1e69aa7f2673b2608a3` | **一致** | ✅ |
| 正式 HNSW index | name: `discovered_book_chunks_embedding_hnsw_idx` / size: 189 MB | **同名 / 189 MB** | ✅ |
| v1 backup count | 24,244 | **24,244**（向量 24,244 / 维度 1024） | ✅ |

**指纹公式**（沿用项目已有，未新设计）：
`md5(string_agg(chunk_index || ':' || content_chars || ':' || coalesce(chapter_title,'<null>'), '|' ORDER BY id))`

**库内表清单**（确认无新增正式表、无残留探针表）：
`discovered_books`、`discovered_book_chunks`、`discovered_book_chunks_emb_v1`、
`discovered_book_chunks_exp`（实验副本，已标记 experiment only）。
**无 `probe_*` 表** —— 探针尚未创建任何库对象。

**结论：正式资产未变化，继续执行。**

---

## 2. Git 冻结状态

| 项 | 值 |
|---|---|
| HEAD commit | **`f2174ba`** ✅ 未变 |
| 已跟踪文件改动 | `.gitignore`、`发现书籍链路-Stage2前置召回实验方案.md`（均为文档/规则，非代码） |
| 未跟踪文件数 | **18** |
| 提交 | **0**（未提交任何对象） |

---

## 3. `.gitignore` 本轮变更（第一阶段）

### 3.1 修改前

- 行数：**73**
- md5：`cd2c4defd66c3450694f245f1086b471`
- 未跟踪文件数：21

### 3.2 修改后

- 行数：**76**（+3）
- 未跟踪文件数：**18**（−3，即被新规则忽略的三个文件）
- **仅新增 3 行，位于「实验产物」小节第 59–61 行**

### 3.3 本轮 diff（仅这 3 行）

```diff
 # ── 实验产物（体积大 / 可复现，不进仓库）────────────────────
 # experiments
 *.hnsw-exp-matrix.json
 *.hnsw-smoke.json
 *.exact-baseline-latency.json
+*.hnsw-exp-probe.json
+*.hnsw-summary.txt
+*.candidate-render.md
```

> 说明：`git diff .gitignore` 相对 HEAD 会显示 +29 行，其中 **26 行是上一轮**已确认新增的
> （crawl cache / python / tmp / generated data），本轮只有上面这 3 行。

### 3.4 `git check-ignore -v` 命中结果（三文件全部命中）

| 文件 | 命中规则 | 结果 |
|---|---|---|
| `server/.hnsw-exp-probe.json` | `.gitignore:59:*.hnsw-exp-probe.json` | ✅ 命中 |
| `server/.hnsw-summary.txt` | `.gitignore:60:*.hnsw-summary.txt` | ✅ 命中 |
| `server/.candidate-render.md` | `.gitignore:61:*.candidate-render.md` | ✅ 命中 |

### 3.5 未影响已有规则证明

1. **零删除**：`git diff .gitignore` 中以 `-` 开头的行 **只有 1 行**，且是 diff 头
   `--- a/.gitignore`，**实际删除 0 行**。既有 45 行规则全部原样保留。
2. **规则回归验证 15/15 全部命中**（上一轮 12 条 + 本轮 3 条）：

   | 规则 | 验证路径 | 结果 |
   |---|---|---|
   | `.crawl-cache/` | `.crawl-cache/x.txt` | ✅ |
   | `server/.crawl-cache/` | `server/.crawl-cache/x.txt` | ✅ |
   | `*.hnsw-exp-matrix.json` | `server/.hnsw-exp-matrix.json` | ✅ |
   | `*.hnsw-smoke.json` | `server/.hnsw-smoke.json` | ✅ |
   | `*.exact-baseline-latency.json` | `server/.exact-baseline-latency.json` | ✅ |
   | `__pycache__/` | `server/src/scripts/__pycache__/foo.pyc` | ✅ |
   | `*.pyc` | `server/src/scripts/foo.pyc` | ✅ |
   | `.tmp_*.py` | `server/.tmp_asset_freeze_check.py` | ✅ |
   | `data/` | `data/foo.bin` | ✅ |
   | `*.embedding` | `foo.embedding` | ✅ |
   | `*.vector` | `foo.vector` | ✅ |
   | `*.hnsw-exp-probe.json` | `server/.hnsw-exp-probe.json` | ✅ 本轮新增 |
   | `*.hnsw-summary.txt` | `server/.hnsw-summary.txt` | ✅ 本轮新增 |
   | `*.candidate-render.md` | `server/.candidate-render.md` | ✅ 本轮新增 |

   （`server/.crawl-cache/` 另由 `server/.gitignore` 第 10 行命中，属既有覆盖，未冲突。）

3. **未扩大范围**：只加了指定的 3 条 glob，**未**顺手添加 `.hnsw-summary.json`、
   `.candidate-plan.json`、`.eval-*.json` 等其他候选。
4. **未删除任何文件**：三个文件仍在磁盘上，仅被忽略。

---

## 4. 探针候选校验（第二阶段 · 只读 metadata，未请求正文）

| id | title | author | death year | rights | decision |
|---|---|---|---|---|---|
| **1661** | The Adventures of Sherlock Holmes | Doyle, Arthur Conan（1859–1930） | **1930** | Public domain in the USA. | ✅ **PASS** |
| **564** | The Mystery of Edwin Drood | Dickens, Charles（1812–1870） | **1870** | Public domain in the USA. | ✅ **PASS** |

### 4.1 逐项检查

| 检查项 | PG 1661 | PG 564 | 依据 |
|---|---|---|---|
| 是否已进入正式 `discovered_books` | **否**（`source_id='1661'` 匹配 0 行） | **否**（`source_id='564'` 匹配 0 行） | 数据库只读查询；已入库 10 本为 1260/1342/1513/1695/1727/2465/2554/2641/3268/59828 |
| 是否存在重复版本 | **无**（31 本扫描范围内，同标题+同作者 0 条；同标题 0 条） | **无**（同上） | `.candidate-plan.json` 全量归一化比对 |
| RDF 是否已扫描过 | **是** | **是** | 均在 `evaluations` 内，含 `rdfUrl`：`.../cache/epub/1661/pg1661.rdf`、`.../cache/epub/564/pg564.rdf` |
| 作者卒年是否满足版权口径 A | **是**（1930 ≤ 1975） | **是**（1870 ≤ 1975） | `verdict.maxDeathYear` |
| rights 字段是否满足要求 | **是**（`Public domain in the USA.`，`language=en`） | **是**（同上） | RDF `<dcterms:rights>` / `<dcterms:language>` |
| 不确定项 / 备注 | **无**（`uncertainties=[]`、`note=null`） | **无** | — |
| contributors | 空 | 空 | 无需额外卒年校验 |

**额外说明**：`.candidate-plan.json` 的口径与 `crawl-books.ts` 做过 12/12 交叉验证，
两本的 `verdict.code = include`，与正式抓取管线判定一致。

**仍待实测的一项**：章节结构完整性**无法在 metadata 阶段验证**，需下载正文后才能测
`chapter_title` 覆盖率。若实测发现某本大量块落到 `NULL`，我会如实报告并说明换书重测成本。

### 4.2 候选体量

| id | 预估 chunk | txt 字节 |
|---|---|---|
| 1661 | 1,776 | 607,504 |
| 564 | 1,653 | 565,218 |
| **合计** | **3,429** | **1,172,722（≈1.1 MB）** |

---

## 5. 等待授权

**已完成**：第一阶段（`.gitignore`）、第二阶段（候选校验）、第三阶段（冻结报告）。
**未执行**（等待明确授权「执行阶段四探针」）：

1. RDF 下载
2. 正文 Range 下载
3. SHA256 校验
4. START/END 校验
5. chunk 测试
6. embedding benchmark

**仍然禁止**：进入正式数据链路（写 `discovered_books` / `discovered_book_chunks` /
重建正式 HNSW / 改正式 embedding）、抓其余 18 本、改 API、改前端、合并前提卡、Git commit。

### 授权后的隔离方案（未变动）

- 正文与 RDF 落 `server/.probe-cache/`，**不写** `.crawl-cache/`
- chunk 与 embedding **优先完全不落库**（临时文件 + JSON）；确需落库则建 `probe_chunks_exp`
  并打 `COMMENT 'Stage C probe only. Do not use in production API.'`
- 记录：下载耗时、chunk 数、embedding 数、单条平均耗时、总耗时、CPU、内存峰值
