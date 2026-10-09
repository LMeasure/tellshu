# 发现书籍链路 · Stage 0 检查报告

> 生成时间：2026-10-07 19:35
> 状态：**BLOCKED**（3 个决策点待你确认，见文末）
> 本阶段未写任何 crawler、未抓取任何数据、未创建任何表或 embedding。

---

## 1. 项目结构（真实代码核对）

### 主 App（前端离线 PWA）

```
src/pages/Discover.tsx        6.6 KB  已有「课程 / 词库 / 笔记」三个 Tab
src/data/dictClient.ts       10.7 KB  旁路后端客户端样板（requestJson + endpoint + 超时 + 错误映射）
src/domain/                   types.ts / learning.ts / dict.ts
src/services/                 storage / speech / recording / ocr（平台 API 唯一出口）
src/components/ui/            EmptyState / ErrorState / Card / Tabs / Badge / Sheet …
src/components/icons/shushu.tsx   自绘图标
```

结论：`src/data/` 确实是页面与后端之间的唯一出口，`dictClient.ts` 可直接照抄成 `discoverClient.ts`（它已经做到「页面不 fetch、管理员密钥只存内存、4xx/超时映射成中文文案」）。

### 旁路后端 `server/`

```
server/package.json   express4 + pg + multer + dotenv + cors；TS strict CommonJS
                      ⚠️ 目前没有 crawl:books 脚本，也没有 python 相关脚本
server/tsconfig.json  include = ["src/**/*.ts","test/**/*.ts"]，noUncheckedIndexedAccess 已开
server/sql/001_init.sql  只有一份（entries / toc / grammar_rules / scan_records / words）
server/src/db/pool.ts     createPool + withTransaction 已封装
server/src/http/          errors / adminAuth / rateLimit / upload / validate
server/src/routes/        health / ocr / translate / dictionary / admin
server/src/scripts/       migrate / reparse / review / confirm / seed-words（全是 .ts）
```

结论：后端骨架齐全（连接池、事务、错误体系、管理员中间件、按路由挂载），接入 discover 不需要动现有任何一张表。

### 数据库现状（实测）

```
PostgreSQL 18.6 on x86_64-windows   —— 连接成功
已装扩展：pg_trgm 1.6 / pgcrypto 1.4 / plpgsql   —— ⚠️ 没有 vector
已有表：entries / grammar_rules / scan_records / toc / words
```

### 前端红线自检（现有代码）

`/discover` 当前**完全没有**「发现的书籍」相关内容，只有课程卡 / 主题词库 / 笔记占位（`EmptyState` + "笔记流即将上线"）。新增书籍流属于**新增 Tab**，不动现有三个 Tab 的逻辑。

---

## 2. 目标数据源

**你还没有指定目标网站。** 按口令 §0.1 与 §39 第 1 条，我必须先停在这里问你，不能自己挑。

我预先实测了 4 个常见公共领域英文书源的可达性和 robots.txt，供你决策：

| 源 | 可达性 | robots.txt 实测原文（与目标路径相关的部分） | 初步判断 |
|---|---|---|---|
| **Project Gutenberg**<br>www.gutenberg.org | ✅ 200<br>`/ebooks/1342` 200（24.9 KB）<br>`/cache/epub/1342/pg1342.txt` 200（772 KB，但**慢**：25s 只下到 544 KB） | ```User-agent: *```<br>```Disallow: /ebooks/search``` | 书目页 `/ebooks/<id>` 与全文 `/cache/epub/<id>/pg<id>.txt` **未被禁止**；仅搜索接口禁止。无 Crawl-delay。可用官方目录 CSV 代替搜索接口。 |
| **Standard Ebooks**<br>standardebooks.org | ✅ 200（`/ebooks` 34.6 KB） | ```# Badly-behaved bots```<br>```User-agent: *```<br>```Disallow: /honeypot```<br><br>```# SEO crawlers```<br>```User-agent: SemrushBot```<br>…（AhrefsBot / DataForSeoBot …）<br>```User-agent: chatgpt-user```<br>```User-agent: claude-user```<br>```User-agent: claude-web```<br>```User-agent: MistralAI-User```<br>```User-agent: Perplexity-User```<br><br>```Disallow: /ebooks/*/downloads/*```<br>```Disallow: /ebooks/*/text*``` | ⚠️ **风险高**：站点明确把一批 AI agent UA 挡在 `/ebooks/*/text*`（正是正文本体）之外。虽然我们用的是浏览器 UA、字面不在名单里，但「换 UA 绕过站点对 AI 抓取的明确表态」在合规上站不住。**需要你明确表态是否仍要抓。** |
| Internet Archive<br>archive.org | ❌ `CONNECT tunnel failed, 502` | 取不到 | 当前网络环境连不通 |
| Wikisource<br>en.wikisource.org | ❌ 连接超时 25s | 取不到 | 当前网络环境连不通 |

> 说明：Gutenberg / Standard Ebooks 的 robots.txt 是**真实抓取**结果（浏览器 UA，非伪造）。archive.org / wikisource 取不到是网络环境问题，不是站点禁止。

---

## 3. 版权判断（**未完成**——取决于你选哪个源）

按口令 §0.3，robots.txt ≠ 版权许可，必须分开判断。现在只能给出**待你选定源之后的判定路径**：

- **Gutenberg**：绝大多数为美国 Public Domain，站点对每本标注 License（多数 `Public domain in the USA`，部分受他国版权条款约束）。抓取时**必须逐本读真实 license 字段存库**，不能整站假定 PD。
- **Standard Ebooks**：正文以 CC0 / 公有领域方式发布（其「License」页有逐本说明），但其 robots 已对 AI agent 表态（见上表）。

**现在不给出结论**——等你选定源，我会抓 1 本真实样本逐字段核实 license / license_url / attribution 要求，再写进报告。没有真实来源的字段一律写 `null`，不允许出现任何编造值。

---

## 4. 数据结构（**未完成**——目标源未定）

Stage 0.5 的 9 项检查（站点可访问 / 真实书目列表 / 详情页可解析 / 书名 / 作者 / source URL / license / 正文 / 章节）都要在选定源之后才能做。

先记一条已实测的事实：Gutenberg 的 `/ebooks/1342`（Pride and Prejudice）返回 24.9 KB HTML，可访问；正文 txt 接口可达但**单本 772 KB 就要 25 秒以上**，Stage 1 抓 10 本必须接受「慢」这个现实，或改用官方目录 CSV + 逐个 txt 拉取。

---

## 5. PostgreSQL

- 版本：**PostgreSQL 18.6 (x86_64-windows)**，`127.0.0.1:5432`，库 `shutree`
- 连接：**成功**
- 现有表：`entries` / `grammar_rules` / `scan_records` / `toc` / `words`（本次任务一行都不动）
- 本机安装目录：`D:\Program Files\PostgreSQL\18`（`bin` / `lib` / `share` 齐全，`pg_config.exe` 存在）

---

## 6. pgvector —— **未安装（阻塞项）**

实测结果：

```
share/extension/vector.control   —— 不存在
lib/vector.dll                   —— 不存在
pg_extension                     —— 只有 pg_trgm / pgcrypto / plpgsql
```

即：`CREATE EXTENSION vector;` **现在必然失败**，`VECTOR(1024)` 与 HNSW `vector_cosine_ops` 都无从谈起。

三条可行路径（**必须由你选**，我不擅自改系统目录）：

### 方案 A：社区预编译包解压进 PG18 安装目录（推荐）

- 来源：`andreiramani/pgvector_pgsql_windows` Releases
- 资产：`vector.v0.8.6-pg18.zip`，166 KB，2026-07-30 发布，标注 "Test in PostgreSQL 18.4 with Microsoft Windows 11 x64"
- sha256：`bda17eb97d9e687e3da701adbf4b65a342943b3e0cdc81935ccf0b9833a1ed62`（我会下载后校验）
- 操作：解压出 `lib/` 与 `share/` 覆盖到 `D:\Program Files\PostgreSQL\18`，然后 `CREATE EXTENSION vector;`
- 代价：**改写本机 PostgreSQL 安装目录**（第三方二进制进 PG 的 lib）。我会先备份被覆盖的文件。需要你授权。

### 方案 B：Docker Desktop 跑 `pgvector/pgvector:pg18`

- 现状：Docker CLI 在（29.6.2），但**守护进程没启动**（`npipe:////./pipe/dockerDesktopLinuxEngine` 连不上）
- 代价：要你先启动 Docker Desktop；且是**另一套数据库**，现有 5 张表要迁移过去，等于给 OCR/词典链路换库 —— 影响面比方案 A 大得多。**不推荐。**

### 方案 C：不用 pgvector

- 用 `real[]` / `bytea` 存向量，余弦相似度在 Python 或 SQL 里算
- 违背你明确指定的技术选型（`VECTOR(1024)` + HNSW + `vector_cosine_ops`），**除非你改主意，否则不做**

---

## 7. Embedding 环境

模型：`BAAI/bge-m3`，维度 **1024**

### 已核实（真实数据）

```
HF 缓存：C:\Users\lagom\.cache\huggingface\hub\models--BAAI--bge-m3
snapshots/5617a9f.../config.json  →  "hidden_size": 1024   ✅ 与要求的 1024 一致
                                     "architectures": ["XLMRobertaModel"]
                                     "max_position_embeddings": 8194
sentence_bert_config.json         →  max_seq_length 8192
modules.json                      →  Transformer + Pooling + Normalize
```

### Python 环境实测

| 解释器 | sentence-transformers | torch | numpy | psycopg2 |
|---|---|---|---|---|
| 托管版 `3.13.12` | ❌ 未装 | ❌ | ❌ | ❌ |
| **系统 `C:\Python314\python.exe` (3.14.6)** | ✅ **6.2.0.dev0** | ✅ **2.14.1+cpu** | ✅ 2.5.3 | ❌ 未装（PyPI 可达，cp314 win_amd64 wheel 有，已验证能下载到 `psycopg2_binary-2.9.13`） |

即：**必须用系统 Python 3.14**，托管版 3.13 什么都没有。

### 阻塞点

1. **模型权重还没下完**：`blobs/` 里两个 `.incomplete` 文件（0 B 与 201 MB），还在下载中。所以现在跑 `check-embedding.py` 必然失败，**不能报 PASS**。
2. **缺数据库驱动**：psycopg2 未装（PyPI 已验证可达，装 `psycopg2-binary` 即可；也可以选纯 Python 的 `pg8000`，但 psycopg2-binary 有现成 cp314 wheel，更稳）。
3. **切块器**：`langchain_text_splitters` 未装。你指定用 `RecursiveCharacterTextSplitter`——**建议自己在 Python 里按你给的分隔符优先级（`\n\n` → `\n` → 。！？ → .!?）手写一个**，不引入 langchain 这条重依赖（它会拖进来一整套包）。这一点也需要你点头。

---

## 8. 发现的问题

1. **pgvector 未安装** —— 直接阻塞建表与向量检索（§39 第 7 条，必须问你）。
2. **目标数据源未指定** —— 阻塞 robots 判定、版权判定、数据结构检查（§39 第 1 条，必须问你）。
3. **Standard Ebooks 的 robots.txt 明确排斥 AI agent 抓正文** —— 即使 UA 字面不命中，合规上有争议，需要你表态。
4. **archive.org / en.wikisource.org 在本机网络环境连不通** —— 若你指定这两个，需要先解决网络。
5. **Gutenberg 全文下载很慢**（单本 772 KB > 25s）—— Stage 1 的 10 本要预留足够时间，且 rate limiter 必须做成全局硬上限。
6. **必须额外装 Python 依赖**（psycopg2-binary），且必须用系统 Python 3.14 —— 属于「新增依赖」，按 §39 第 15 条报备。
7. **`server/.gitignore` 现在不忽略 `.crawl-cache`** —— 原始抓取缓存（含全文）绝不能进 git，Stage 1 动手前我会先加上这一行。
8. **`server/src/scripts/` 目前全是 `.ts`** —— 按你的架构要求（§18），`check-embedding.py` / `ingest-books.py` 会以 `.py` 放进同一目录。根 `tsconfig.json` 的 include 只有 `src` 与 `vite.config.ts`，`server/` 也不参与前端编译，不会互相干扰。
9. **产品决策点先记账（不现在决定）**：①「发现的书籍」是新增第四个 Tab 还是改造现有发现页；②书籍详情是否复用 `/reader/:id` 读正文——你已明确要求问，我留到对应阶段再问。

---

## 9. 结论（第一次评估：19:35）

```
PASS / BLOCKED
```

## **BLOCKED** —— 三个决策点没解决前，不写 crawler、不抓数据、不建表、不生成 embedding。

（20:10 已完成 pgvector 与 BGE-M3 两项验证，最新结论见 §12）

---

## 11. 补充（19:50 更新：已授权项的执行结果）

你已确认：pgvector 走方案 A、Python 用系统 3.14 + psycopg2-binary。执行结果：

### ✅ psycopg2-binary —— 已完成

```
Successfully installed psycopg2-binary-2.9.13
import psycopg2 → 2.9.13 (dt dec pq3 ext lo64)
```

### ⚠️ pgvector —— 卡在权限

包已下载并校验通过：

```
文件    vector.v0.8.6-pg18.zip   169,785 B
sha256  bda17eb97d9e687e3da701adbf4b65a342943b3e0cdc81935ccf0b9833a1ed62
        与发布页标注值逐字符一致 ✅
内容    lib/vector.dll (280,064 B) + share/extension/vector.control + vector.sql
        + 0.1.0→0.8.6 全部升级脚本 + include/server/extension/vector/*.h
```

目标位置确认（运行实例实读）：

```
pg_config --sharedir → D:/Program Files/PostgreSQL/18/share
pg_config --libdir   → D:/Program Files/PostgreSQL/18/lib
data_directory       → D:/Program Files/PostgreSQL/data
```

覆盖检查：`vector.dll` / `vector.control` / `vector--*.sql` **均不存在**，属全新安装，无文件会被覆盖、无需备份。

但解压失败：

```
PermissionError: [WinError 5] 拒绝访问
touch D:/Program Files/PostgreSQL/18/lib/__wtest          → Permission denied
touch D:/Program Files/PostgreSQL/18/share/extension/...  → Permission denied
whoami → lagom（非提权令牌，Program Files 受 UAC 保护）
```

**需要一次管理员权限。** 三种走法（我不擅自弹 UAC，请你选）：

1. **你自己跑一条提权命令**（推荐，最干净）：用「以管理员身份运行」的 PowerShell 执行一次解压，命令我会给全。
2. **授权我触发 UAC 弹窗**：我用 `Start-Process -Verb RunAs` 起一个提权进程，Windows 会弹授权框，**需要你在屏幕上点「是」**。
3. **改走 Docker 方案**：先启动 Docker Desktop，跑 `pgvector/pgvector:pg18` 容器（代价是另起一套库、现有 5 张表要迁移）。

包目前放在 `C:\Users\lagom\AppData\Local\Temp\pgvector\vector.v0.8.6-pg18.zip`（`/tmp/pgvector`），校验已过，随时可用。

### ⚠️ bge-m3 模型下载异常

```
19:28  blobs/ 有一个 1,073,055,968 B 的 .incomplete
19:34  blobs/ 变成 0 B + 201,135,713 B 两个 .incomplete（重新下了）
19:44  blobs/ 变空，只剩目录
```

三次观察里两次被清空重来，**下载没有稳定完成**。所以 `check-embedding.py` 现在跑必然失败，Stage 0.6 不能报 PASS。
（已确认的静态事实不受影响：缓存里 `config.json` 的 `hidden_size = 1024`、架构 `XLMRobertaModel`、池化 + Normalize 模块齐全。）

### 仍然 BLOCKED 的三件事（第一次评估）

| # | 事项 | 状态 |
|---|---|---|
| 1 | 目标数据源 URL | **等你给**（你选了「我来指定其他 URL」，但还没给地址） |
| 2 | pgvector 安装 | **等你选提权方式**（见上） |
| 3 | bge-m3 权重下载完成 | 下载不稳定，需重跑一次 |

---

## 12. 复检结果（20:10）—— pgvector 与 BGE-M3 两项均通过

### ✅ 12.1 pgvector 已装好并验证通过

文件落位（用户提权后）：

```
D:/Program Files/PostgreSQL/18/lib/vector.dll              280,064 B
D:/Program Files/PostgreSQL/18/share/extension/vector.control
      comment = 'vector data type and ivfflat and hnsw access methods'
      default_version = '0.8.6'
```

**验证方式**：新建临时库 `shutree_vector_probe` 做全量能力探针，**跑完即删**，未触碰 `shutree` 库任何数据。
实测输出：

```
extension     = 0.8.6
typeOk        = vector 类型已注册
columnType    = vector (typmod=1024)
storedDims    = id1:dim=1024,norm=1.000000  id2:dim=1024,norm=1.000000  id3:dim=1024,norm=1.000000
dimEnforced   = YES —— 3 维被拒: expected 1024 dimensions, not 3
cosineOps     = id3:sim=1.000000  id1:sim=0.707107  id2:sim=0.707107
hnswIndex     = CREATE INDEX ... USING hnsw (embedding vector_cosine_ops)
annQuery      = id3:sim=1.000000  id1:sim=0.707107  id2:sim=0.707107
availableTypes= halfvec, sparsevec, vector
accessMethods = hnsw, ivfflat
```

逐条对照你的验收清单：

| 检查项 | 结果 |
|---|---|
| PostgreSQL 连接成功 | ✅ |
| pgvector 已安装 | ✅ 0.8.6 |
| vector 类型可用 | ✅ |
| dimension = 1024 | ✅ `typmod=1024`，且 3 维写入被强制拒绝 |
| cosine distance 支持 | ✅ `<=>` 运算符，45° 向量相似度 0.707107（数学正确） |
| HNSW + vector_cosine_ops | ✅ 索引创建成功，ANN 查询结果有序 |
| **没有**用 VECTOR(384) / VECTOR(512) | ✅ |

收尾确认：`pg_database` 里只剩 `shutree`（探针库已删），`shutree` 库中**尚未**创建 vector 扩展——等 Stage 1 建表迁移时再 `CREATE EXTENSION IF NOT EXISTS`，不在 Stage 0 里动业务库。

### ✅ 12.2 BGE-M3 检查通过

新增 `server/src/scripts/check-embedding.py`（Stage 0.6 交付物，非 crawler）。

**执行中发现的真实问题**：`huggingface.co` 在本机走代理返回 `502 Bad Gateway`，`SentenceTransformer("BAAI/bge-m3")` 在线解析 revision 失败。但权重早已在本地缓存（`pytorch_model.bin` 2,271,145,830 B，之前观察到的是下载过程中的 `.incomplete` 临时文件）。
脚本因此设计为：**在线优先 → 失败自动以 `local_files_only=True` 重试一次，并把所用模式打印出来**（支持 `--offline` 强制离线）。不静默降级、不 skip。

实测输出：

```
[ OK ] sentence-transformers 已安装（版本 6.2.0.dev0）
[ OK ] numpy 2.5.3
[ OK ] 模型已加载（模式 = offline(本地缓存)）
[ OK ] 模型标识 = BAAI/bge-m3
[ OK ] max_seq_length = 8192
[ OK ] 向量 shape = (2, 1024)
[ OK ] 实际 dimension = 1024
[ OK ] NaN 数量 = 0，Inf 数量 = 0
[ OK ] 第 1 条向量范数 = 1.000000
[ OK ] 第 2 条向量范数 = 1.000000
[ OK ] 中文句 ↔ 英文句 余弦相似度 = 0.4014（仅打印，不作为通过条件）
[PASS] BAAI/bge-m3 可用，dimension=1024，normalize_embeddings=True 已生效
退出码 = 0
```

逐条对照你的验收清单：

| 检查项 | 结果 |
|---|---|
| sentence-transformers 已安装 | ✅ 6.2.0.dev0 |
| 模型能加载 | ✅（本地缓存，无需云端 API） |
| 模型名 = BAAI/bge-m3 | ✅ 从模块里读出的真实标识 |
| 生成测试 embedding | ✅ |
| shape = (1, 1024) | ✅ 实际 (2, 1024)（两条测试句），维度 1024 |
| 无 NaN / Inf | ✅ 0 / 0 |
| normalize_embeddings=True | ✅ 范数 1.000000 |
| 输出实际 dimension | ✅ 1024 |
| 输出成功/失败原因 | ✅ 失败时打印完整 traceback |

附带观察：中文查询「关于爱情与阶级的英文小说」↔ 英文句 cosine ≈ 0.40，说明跨语言语义空间是通的（Stage 1 会用真实书籍正文做正式验收）。

### 12.3 副作用检查

- `server` 的 `npm run typecheck`：**通过**（新增的 `.py` 不参与 TS 编译）
- 未新增/修改任何 `.ts`、未建表、未抓数据、未生成任何 embedding 数据

### 12.4 剩余阻塞（只剩 1 项）

| # | 事项 | 状态 |
|---|---|---|
| 1 | **目标数据源 URL** | ❌ **仍等你给** |
| 2 | pgvector 安装 | ✅ 已完成并验证 |
| 3 | bge-m3 环境 | ✅ 已完成并验证 |

**Stage 0 差这一步就全绿**：给我数据源 URL（+ 抓取范围 / 是否抓全文 / Stage 1 数量），我立刻做 robots.txt 原文引用、逐本版权判定、页面结构可解析性检查，出 Stage 0 终版结论。在你确认前**不进 Stage 1**。

---

## 13. 数据源评估：loc.gov —— ❌ **不通过，停止**

你指定：`https://www.loc.gov/`，流程是「等验证信息出来后勾选进入 → 搜索名称带『英语』的书 → 下载第一本」。

### 13.1 robots.txt 原文（真实抓取，`https://www.loc.gov/robots.txt`，HTTP 200）

```
User-agent: 008
Disallow: /

#Baiduspider
User-agent: Baiduspider
Disallow: /

User-agent: Baiduspider-image
Disallow: /

User-agent: *
Disallow: /cgi-bin/
Disallow: /web_arch/
Disallow: /rr/mopic/staff
Disallow: /loc/volunteers
Disallow: /ficmanagers
Disallow: /preserv/extranet/
Disallow: /myloc
Disallow: /nationalfilmregistry
Disallow: /fedsearch
Disallow: /search
Disallow: /pictures/search
Disallow: /pictures/related
Crawl-Delay: 5

Sitemap: https://www.loc.gov/sitemap.xml
```

### 13.2 判定

| 项 | 结论 |
|---|---|
| 目标路径是否 Disallow | **是**。`User-agent: *` 下 `Disallow: /search` |
| Crawl-delay | **有，`Crawl-Delay: 5`**（= 每分钟最多 12 次，你要求的 ≤30/min 能满足，但这是次要问题） |
| 无 robots.txt？ | 否，robots.txt 存在且明确 |

**搜索这一步就命中禁令。** 已用真实请求确认搜索确实落在 `/search/`：

```
首页搜索表单 action = "/search/"
GET https://www.loc.gov/search/?q=英语&fo=json  →  HTTP 403
```

也就是说：站点不仅 robots 层面禁 `/search`，**服务端也直接返回 403 拒绝**。

### 13.3 结论

> **当前目标站点 robots.txt 禁止抓取目标路径，不能继续实施 crawler。请提供允许抓取的其他来源。**

按你口令 §0.2 与 §39 第 3 条，此处**立即停止**：不写 crawler、不碰 `/search`、不尝试用其它路径/UA/接口绕开搜索禁令、不去碰那个「验证勾选」环节。

### 13.4 补充事实（供你决策，不代表我建议绕行）

- `https://www.loc.gov/apis/` 返回 200，且**不在** Disallow 列表里。但 LOC 的官方 JSON API 用法是在搜索 URL 后加 `fo=json`（即仍然走 `/search` 路径，实测 403），所以「换 API 就等于换路径」——是否要走这条路**由你决定，我不自行选择**。
- 未被 Disallow 的路径（如 `/collections/…`、`/item/…`、`/books/…`）在 robots 层面是允许的，但要拿到书必须先过搜索这一关，否则就是在变相绕开禁令。
- **版权另判**：LOC 藏品逐件标注 Rights（部分公有领域、部分仍受版权或访问限制），即使路径合规也仍需逐本读真实 Rights 字段，取不到就 `null`。本条因 robots 已阻断，未进入版权判定。
- 你提到的「验证信息勾选」——自动化绕过站点的人机/访问确认环节，本身也是我不做的行为。

### 13.5 需要你做的

给我一个**搜索路径未被 robots 禁止**的书源。已实测可作参考的：

| 源 | robots 状态 |
|---|---|
| **Project Gutenberg** | ✅ 只 `Disallow: /ebooks/search`；书目页 `/ebooks/<id>` 与全文 `/cache/epub/<id>/pg<id>.txt` 均开放，无 Crawl-delay |
| Standard Ebooks | ⚠️ 对 `claude-user` / `chatgpt-user` 等 AI agent 禁 `/ebooks/*/text*` |
| archive.org / en.wikisource.org | ❌ 本机网络连不通（502 / 超时） |

或者你给另一个具体 URL，我重新跑一遍 robots + 版权 + 结构三重检查。

---

## 14. 数据源评估：`https://zh.z-lib.sk/`（Z-Library 镜像）—— ❌ **不能用，拒绝执行**

### 14.1 访问性实测

```
GET https://zh.z-lib.sk/robots.txt   →  curl: (7) CONNECT tunnel failed, response 502
GET https://zh.z-lib.sk/             →  http=000（同样 502）
```

本机网络**根本连不上**，robots.txt 取不到。按你的规则「无 robots.txt → 记录并谨慎操作」，但下面这条是更硬的否决理由，不依赖 robots。

### 14.2 版权判定（决定性）

Z-Library 是**未经权利人授权的图书分发站（shadow library）**，架上主体内容是**商业版权书籍**。对照你自己定的 §0.3 分类：

| 你的规则 | 本源的情况 |
|---|---|
| A. Public Domain | ❌ 不适用 |
| B. Open License | ❌ 无任何 CC / 开放许可标注 |
| C. 明确授权来源 | ❌ 拿不到权利人授权范围 |
| **D. 商业版权书籍** | ✅ **命中：默认不得保存完整正文，只能考虑 metadata / source URL** |
| E. 版权状态不明确 | — （这里不是不明确，是明确侵权分发） |

**本链路要做的事恰好是规则 D 明令禁止的动作**：抓全文 → 切块 → embedding → 落 PostgreSQL → 语义检索并展示片段。
embedding 本身是对全文的复制性再生产（derivative copy），检索展示 snippet 也是再传播。这不是「存 metadata + 原站链接」那种可允许的用法，**整条链路都无法在 D 类规则下成立**。

补充事实（供你判断风险，不是法律意见）：Z-Library 多个域名在多国被执法查处、ISP 层面封锁，运营方被以刑事版权侵权起诉；书目的产生方式本身就是未经授权的复制与传播。

### 14.3 还踩了你自己定的另外两条线

- **需要登录/账号才能下载** —— 你明确写过「默认禁止多个账号绕过限制」，用凭据批量下载属于该禁区（也涉及把凭据写进 `server/.env` 的问题）。
- **robots.txt 取不到** —— 即便能连通，也只能记「无 robots.txt，谨慎操作」，并建议大规模抓取前联系站点所有者；而联系站点所有者取得授权这件事，对该站不成立。

### 14.4 结论与已执行动作

> **这个源不能用。不写 crawler、不抓取、不入库、不做 embedding。**

已明确拒绝并停止，与 robots 是否允许无关——光是版权这一条就否决了。请换源。

### 14.5 推荐：Project Gutenberg（已实测可达）

刚才顺手做了只读预检（未写入任何数据、未触碰 `/ebooks/search`）：

```
GET /cache/epub/feeds/pg_catalog.csv   → 200, text/csv, 21,245,518 B（官方图书总目录）
GET /browse/scores/top                 → 200, text/html, 61,123 B（热门书目榜，非禁用路径）
GET /ebooks/1342                       → 200, text/html, 24,938 B（书目详情页）
```

- robots 只禁 `/ebooks/search`，上面三条路径都不在禁令里，也无 Crawl-delay。
- 官方 CSV 目录可以完全替代搜索接口 —— **这也正好绕开了那个被禁路径，而不需要绕开任何东西**。
- ⚠️ 网络很慢：CSV 21MB，30 秒只下到 352 KB。Stage 1 抓 10 本（含全文）要预留足够时间，rate limiter 按 `Crawl-Delay` 精神取 ≤12 req/min 更稳妥。
- ⚠️ 版权仍需**逐本**读真实 license 字段（多数为美国 Public Domain，但部分受他国条款约束），不得整站假定；取不到就 `null`。

**需要你一句话确认：就用 Project Gutenberg 吗？** 确认后我立刻跑 §13 那套完整检查（robots 原文、逐本 license 判定、页面结构可解析性），出 Stage 0 终版结论。确认前不进 Stage 1。

---

## 15. Stage 0 终版结论：Project Gutenberg —— ✅ PASS（附 1 个必答决策）

> 你已确认换用 **Project Gutenberg**。以下全部为**真实抓取**结果（浏览器 UA，未触碰 `/ebooks/search`）。

### 15.1 robots.txt（原文，HTTP 200）

```
User-agent: *
Disallow: /ebooks/search
```

- 无 `Crawl-Delay`。
- 本次要用到的路径 `/browse/scores/top`、`/ebooks/<id>`、`/cache/epub/<id>/*` **全部不在禁令内**。
- ✅ **合规**。且发现官方 CSV 总目录可以直接替代搜索功能，**不需要碰被禁路径**。

### 15.2 版权判定（逐本，真实字段）

每本书都有官方机器可读元数据 RDF：`https://www.gutenberg.org/cache/epub/<id>/pg<id>.rdf`

实测三本：

| ID | 书名 | 作者 | `<dcterms:rights>` | 作者卒年 |
|---|---|---|---|---|
| 1342 | Pride and Prejudice | Austen, Jane | `Public domain in the USA.` | 1775–1817 |
| 2701 | Moby Dick; Or, The Whale | Melville, Herman | `Public domain in the USA.` | 1891 |
| 1513 | Romeo and Juliet | Shakespeare, William | `Public domain in the USA.` | 1616 |
| 65238 | The Secret of Chimneys | Christie, Agatha | `Public domain in the USA.` | **1976** |

许可页（真实可达，HTTP 200）：`https://www.gutenberg.org/policy/license.html`

全文头部的授权声明原文照抄：

```
This eBook is for the use of anyone anywhere in the United States and
most other parts of the world at no cost and with almost no restrictions
whatsoever. You may copy it, give it away or re-use it under the terms
of the Project Gutenberg License included with this eBook or online
at www.gutenberg.org. If you are not located in the United States,
you will have to check the laws of the country where you are located
before using this eBook.
```

#### ⚠️ 必须你拍板的决策：美国 PD ≠ 中国 PD

上面这段最后两句是关键。你是中国用户，**「Public domain in the USA」在中国不自动成立**。中国著作权保护期是「作者终生 + 50 年」。

**反例就在热门榜第 6 名**：Agatha Christie（卒于 1976-01-12）的 *The Secret of Chimneys* —— Gutenberg 标注美国 PD，但在中国保护期到 **2026-12-31**，现在**仍在保护期内**。
好消息：RDF 里每个作者都有真实 `<pgterms:birthdate>` / `<pgterms:deathdate>`，**这个过滤可以精确做**。

请确认采用哪条：

- **A（建议）**：`Language = en` **且** 全部作者卒年 ≤ **1975**（中国「终生+50 年」已过期）→ 中美双清，最稳
- **B**：只看 `<dcterms:rights>` 含 "Public domain in the USA" → 简单，但会把 Christie 这类在中国仍在保护期的书抓进来
- **C**：更严：全部作者卒年 ≤ **1955**（欧盟/美国常见「life+70」口径留余量）

### 15.3 数据结构可解析性（Stage 0.5，九项逐条）

| 检查项 | 实测结果 |
|---|---|
| 网站可访问 | ✅ `https://www.gutenberg.org/` 200 |
| 真实存在书籍列表 | ✅ `/browse/scores/top` 200（61,123 B），**去重后 119 个书目链接**，锚文本自带「书名 + 作者」 |
| 书籍详情页 | ✅ `/ebooks/1342` 200（24,938 B） |
| 能获取真实书名 | ✅ RDF `<dcterms:title>` / CSV `Title` 列 |
| 能获取作者 | ✅ RDF `<pgterms:name>` + 生卒年 / CSV `Authors` 列（含生卒年） |
| 能获取 source URL | ✅ `/ebooks/<id>` 稳定可用 |
| 能判断 license/copyright | ✅ RDF `<dcterms:rights>` 逐本真实值 + 许可页 URL |
| 能判断是否存在正文 | ✅ `/cache/epub/<id>/pg<id>.txt` 200，P&P 实测 **772,386 B / 14,915 行**，含 `*** START/END OF THE PROJECT GUTENBERG EBOOK ***` 标记 |
| 能获取章节信息 | ⚠️ 见下 |

**官方总目录 CSV**（可替代被禁的搜索）：
`https://www.gutenberg.org/cache/epub/feeds/pg_catalog.csv` → 200，`21,245,518 B`
字段：`Text#,Type,Issued,Title,Language,Authors,Subjects,LoCC,Bookshelves`
→ 有 `Language`（可筛 en）、有 `Subjects`（→ category）、有 `Bookshelves`；**没有 rights 列**，所以 license 必须逐本读 RDF。

**封面**（实测有解，但非全站保证）：
`https://www.gutenberg.org/cache/epub/1342/pg1342.cover.medium.jpg` → 200 image/jpeg 31,675 B
→ 有就有，没有就老实写 `null` 走 placeholder，绝不拿别图冒充。

### 15.4 三个真实风险（不是警告，是必须写进实现的）

1. **章节格式不统一**。P&P 里同时出现三种写法：目录处的 `Chapter I.]`、正文的 `CHAPTER II.`、无句点的 `CHAPTER XIII`（全书 61 处）。**不能写死一条正则**，必须按「罗马数字/阿拉伯数字 + 可选句点 + 行首」多模式匹配，且要靠内置 TOC 段校验，抓不到就 `null`，不许编。
2. **网络很不稳定**。单本 772 KB 首次请求 `curl(56) server closed abruptly`，只下到 218 KB；靠 **HTTP Range 续传**（`-C -`，返回 206）才补齐。CSV 更是 30 秒只下 352 KB。
   → crawler **必须内置断点续传 + 重试 + 指数退避**，否则 Stage 1 抓 10 本必有残缺数据（残缺 = 脏数据，比没有更糟）。
3. **速率**：robots 没写 Crawl-Delay，我会按你给的「≤30 req/min + 0.8–2s 随机」双约束里**更严的**执行。

### 15.5 Stage 0 验收

| 验收项 | 结果 |
|---|---|
| robots.txt 合规 | ✅ 目标路径均未 Disallow |
| 版权状态明确 | ✅ 逐本真实 rights 字段可得；**过滤口径待你选（15.2 A/B/C）** |
| 目标数据源结构确认 | ✅ 九项全通过（章节一项有已知格式差异，可解） |
| ≤10 本成功抓取 | ⏳ Stage 1 |
| 无伪造字段 | ⏳ Stage 1（规则已立：缺失一律 `null`） |
| 至少 1 本成功 chunk / embedding / 1024 维 / 无 NaN / HNSW / 中英检索 / 幂等 | ⏳ Stage 1 |

**结论：Stage 0 PASS。** 环境侧（pgvector 0.8.6 + BGE-M3 1024）已全绿，数据源侧合规性与可解析性已验证。

### 15.6 请回复这两条，我再进 Stage 1

1. **版权过滤口径**：A / B / C（我建议 **A**）
2. **Stage 1 取书名单怎么来**：用 `/browse/scores/top` 的 119 本按过滤条件取前 10（快、稳），还是下载 21 MB 官方 CSV 全量筛选（慢、易断，但覆盖面广）？——我建议先用前者跑通链路。

在你明确回复前，**不写 `crawl-books.ts`、不抓任何数据、不建表、不生成 embedding**。


---

## 10. 下一步（等你回答这 3 个问题）

1. **目标数据源**：Gutenberg / Standard Ebooks / 你指定的其他 URL？抓取范围、是否抓全文、Stage 1 数量？
2. **pgvector 怎么装**：方案 A（社区预编译包解压进 `D:\Program Files\PostgreSQL\18`，需你授权动 PG 安装目录）/ 方案 B（起 Docker）/ 方案 C（放弃 pgvector）？
3. **Python 依赖**：确认用系统 Python 3.14 + 装 `psycopg2-binary`，且切块器自己手写不引 langchain？

拿到答复后我会继续执行：装 pgvector → 写 `check-embedding.py` 并跑通 1024 维校验 → 抓真实 robots/版权/结构样本 → 出 Stage 0 终版结论。
