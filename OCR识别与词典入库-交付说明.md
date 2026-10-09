# 交付说明 · 图片识别（功能 A）+ 词典扫描入库（功能 B）

> 日期：2026-10-06 · 本轮为上一轮中断后的续做，4 步交付全部完成，验证全绿。

---

## 一、改了什么

### 功能 A：导入页「扫描识别」（纯前端新增，不动原有三档）

| 文件 | 改动 |
|---|---|
| `src/pages/Import.tsx` | 新增第 4 个页签「扫描识别」与 `ScanImport` 子组件；页签类型改为 `ReadingType \| 'scan'` |
| `src/services/ocr/{types,web,noop,index}.ts` | 新增图像采集服务（**全项目唯一**允许 `getUserMedia` / `createImageBitmap` / canvas 的位置）：相册多选、系统相机 `<input capture>`、实时取景 `captureLive()`（失败自动回退）、压缩到长边 1600 / JPEG 0.85 |
| `src/data/dictClient.ts` | 素材识别 `submitMaterialScans` / 任务轮询 `fetchScanJob` / 在线翻译 `translateText`（超时与错误都有类型，无 any） |

识别出的文本**两个独立去向**：
1. **在线翻译** —— 走后端 `/api/translate`；后端没配 `TRANSLATE_API_URL` 时返回 503，前端如实显示「翻译服务未接入」，**绝不返回任何编造译文**。
2. **保存到我的素材** —— 复用 `saveReading({ type:'article', content })` 落本地 `readings` 表，保存后直接进阅读器（可点词、听书、默写）。

### 功能 B：词典扫描结构化入库（旁路后端 + 前端权限入口）

**后端 `server/`（独立 package，不参与前端打包）**

| 层 | 文件 | 要点 |
|---|---|---|
| Schema | `sql/001_init.sql` | 四表 `entries / toc / grammar_rules / scan_records`；pg_trgm + pgcrypto；`tsvector` 生成列 + GIN + 前缀索引；合并函数（释义只补不覆盖、数组按键去重合并）；幂等可重复执行 |
| OCR 客户端 | `paddle/client.ts` | 异步 job 提交 / 轮询 / 下载 JSONL；令牌只在服务端；错误分级（quota/auth/retryable/server/network）+ 日志脱敏 |
| 适配器 | `parsers/adapter.ts` | 兼容 PaddleOCR 四种返回形态，未知形态返回空数组不抛异常 |
| 解析器 | `parsers/{toc,entry,table,instruction,classify}.ts` | 目录页（缩进→层级、引导点/空白/松散三式、罗马页码）；词条页（词头/音标/词性/英中释义/例句/同反义/短语/词根，自动打标签）；表格→不规则动词；使用说明→ParserRules；页面自动分类 |
| 编排 | `ocr/pipeline.ts` | 提交→落盘→建记录；轮询 done 后归档原始 JSON、**按页**分派解析器（unknown 自动分类）、同一本书规则先读库再增量合并、30 天结果及时入库 |
| 入库 | `db/repository.ts` | `entries` 唯一键 `(word_key,pos_key)`、`toc` `(source_book,title_key,page_start)`、`grammar_rules` `(type,base_form_key)`；ON CONFLICT 只补不覆盖；增量同步按全局游标窗口取数（跨表不跳读） |
| 路由 | `routes/{health,ocr,translate,dictionary,admin}.ts` | `/api/health`、`/api/ocr/material`（公开，IP 限流 10 次/小时）、`/api/translate`、`/api/sync/dictionary`、`/api/search`、管理员 `/api/admin/*`（Bearer 口令，按路由挂中间件） |

**前端**

| 文件 | 改动 |
|---|---|
| `src/domain/types.ts` | 新增 `DictEntry / DictTocNode / DictGrammarRule / DictMeta`；`StorageSchema` / `PrimaryKeyMap` 同步 |
| `src/services/storage/{types,web,memory}.ts` | Dexie **v6** 新增四表（索引齐全）；新增 `whereStartsWith`（未建索引直接抛错，禁止全表扫描）；memory driver 三处同步 |
| `src/domain/dict.ts` | 同步落库 + 游标；**三档检索**：精确 `word_lower`（100 分）→ 前缀 `whereStartsWith`（60 分）→ 全文兜底（10–30 分，上限 5000 条扫描）；搜索建议；目录树组装；语法表检索 |
| `src/store/useDictStore.ts` | zustand（非 persist，**管理员密钥只存内存**） |
| `src/components/dict/*` | `DictSearchPanel`（防抖建议 + 匹配类型徽标）、`EntryDetailCard`（空字段整块不渲染）、`DictPanels`（目录树 / 语法表 / 上传面板） |
| `src/pages/DictIngest.tsx` + `App.tsx` | 新路由 `/dict-ingest`（检索 / 目录 / 语法 / 扫描入库四页签 + 同步按钮 + 缓存计数） |
| `src/pages/Settings.tsx` / `Profile.tsx` | 权限入口卡片（图标带 `aria-label` + `title`） |
| `产品前提卡-给协作方.md` | 同步更新 §0/§1/§2/§3/§3.1/§5/§6/§8/§9/§10 与更新日志 |

**配置**：`server/.env` 已填入你提供的 PaddleOCR 令牌；`ADMIN_API_KEY` 为本地随机生成（文件已被 `server/.gitignore` 忽略，**勿提交**）。

---

## 二、验证了什么（全部通过）

```
前端：npx tsc --noEmit ✅  npm test（10 套）✅  npm run build ✅  python scripts/check_pwa.py ✅
      preview 4174 冒烟：/ 、/import 、/dict-ingest 均 200
后端：npm run typecheck ✅  npm test（node:test 13/13）✅  npm run build ✅
      真实 .env 冒烟：
        GET  /api/health        → 200 degraded（database:"error" 本机无 PG；paddleConfigured:true）
        GET  /api/nope          → 404（不再被管理员中间件污染成 401）
        POST /api/admin/...（无口令）→ 401
        POST /api/translate     → 503（未配置翻译服务，如实拒绝）
        POST /api/admin/...（带口令缺 sourceBook）→ 400 参数校验
```

单测覆盖你给的四类真实样本：缩进目录页（层级还原 + page_end 回填）、词条页（全字段抽取 + 标签）、不规则动词表（markdown→二维数组→规则）、使用说明页（词性缩写/符号语义→ParserRules），外加适配器四形态与页面分类。

---

## 三、还有什么没做（需要你提供环境才能做）

1. **PostgreSQL 未建库**：本机没有 PG，`npm run db:migrate` 与「上传→解析→入库→同步」全链路未实测。需要你：装 PG → 建 `shutree` 库 → 改 `server/.env` 的 `DATABASE_URL` → `cd server && npm run db:migrate`。
2. **PaddleOCR 真实联调未做**：异步契约（提交/轮询/JSONL）来自官方文档，未用真实图片打过一遍。建议建库后先传 1 张使用说明页验证规则学习，再传正文页。
3. **在线翻译未接**：`TRANSLATE_API_URL` 留空。如果你有 LibreTranslate 兼容服务（自建或第三方），填入即可启用；不填则前端永远如实显示「未接入」。
4. **部署**：`server/` 目前只在本机跑（PORT=8787）。上线需要选一台机器常驻 + HTTPS（前端 `getUserMedia` 拍摄只在安全上下文可用，相册/系统相机不受影响）+ 前端 `VITE_API_BASE_URL` 指向它。

---

## 四、需要你决策什么

| 决策点 | 选项 | 我的建议 |
|---|---|---|
| 管理员口令 | 用我生成的 `server/.env` 里那串，还是换成你自己的 | 换成你自己好记的（改 .env 重启即生效；前端入口输入同一串） |
| 翻译服务 | 接 LibreTranslate / 其他兼容 API / 暂不接 | 暂不接也没问题——OCR 存素材的主链路不依赖它 |
| 后端部署位置 | 本机常驻 / 云服务器 / Serverless | 云服务器 + HTTPS（拍摄识别与多人共用词库都需要） |
| 公开 OCR 开关 | `OCR_PUBLIC_ENABLED=true`（当前）任何人可用素材识别（有 IP 限流） | 保持 true；被滥用再改 false，管理员通道不受影响 |

---

## 五、2026-10-06 晚 · 真实环境 E2E 实测结论（本机 PostgreSQL 18 + 11 张真实词典扫描图）

前置：本机已装 PostgreSQL 18.6（127.0.0.1:5432，库 shutree 已迁移建表），`server/.env` 指向本机，
`/api/health` 实测 `database:"ok"`、`paddleConfigured:true`。11 张扫描图全部经网盘签名 URL 下载并校验
JPEG 魔数后，按页类型（instruction×3 / toc×2 / entry×1 / table×2 / unknown×3）经
`POST /api/admin/dictionary/scans` 提交，共 13 个 scan（含早期重复提交的 2 个）全部轮询至 `done`。

**实测通过**：entries 6 行真实词条（abandon/abacus 等词头+IPA 音标+中英释义+例句）；
instruction 页 parser_rules 提取成功（短语/反义词标记等）；`/api/search?q=abacus` 模糊检索正常；
`/api/sync/dictionary?since=0` 增量同步正常。

**实测暴露的解析缺口（均为真实证据，未做任何兜底编造，原始 OCR 文本完整保留在 scan_records.result_text）**：
1. **HTML 表格不被识别**：不规则动词页与语法横页的 OCR 结果中，表格以 HTML `<table>` 呈现，
   表格解析器只认 markdown 管道表格 → `tables:0`、`grammar_rules` 0 行。 irregular verbs 表
   （abide/arise/awake…）文本完整存在但未结构化入库。
2. **音节圆点截断词头**：OCR 把 `aba·cus`、`aban·don` 的间隔号当断词符 → word 截成 "aba"/"aban"，
   abandon 与 abandonment 的 word_key 冲突。
3. **跨行错拼**：abandonment 例句尾部与下一词条 abate 拼接，生成错误词条 "election policy"。
4. **目录解析失败**：两张目录图只产出 1 行拼接标题；目录.jpg 文本中结构清晰（使用说明6/英语发音表7~24…）。
5. **音标页等 3 张 unknown 页**：管线自动分类后未结构化，原始文本保留待人工处理（符合"绝不猜测入库"红线）。

**遗留事项（2026-10-06 20:40 状态）**：
① 修 HTML 表格→结构化解析 —— ✅ 已修（见 §6.3）；
② 修词条切分（圆点/跨行）—— ✅ 已修（见 §6.1）；
③ toc 结构化解析 —— ✅ 已修（见 §6.2）；
④ `sourceBook` 当前为占位"英语词典"，待真实书名后重提交或 SQL 改键（未做）；
⑤ image_name 因 Windows curl 编码存成乱码（仅该字段，未做）；
⑥ 补拍真正的不规则动词表页（当前只扫到 1 页 7 行，未做）。（复制即用）

```bash
# 前端（固定端口，别换）
npm install
npm run preview -- --port 4174 --strictPort

# 后端（首次）
cd server
npm install
# 先确保 PostgreSQL 已建库并改好 .env 的 DATABASE_URL
npm run db:migrate
npm run dev          # 或 npm run build && npm start（默认 8787）

# 前端连后端（联调时）
#   根目录 .env.local 写：VITE_API_BASE_URL=http://127.0.0.1:8787/api
```

使用流程：`/import → 扫描识别`（功能 A）；`设置 → 词典扫描库`（功能 B，入口输 `server/.env` 里的 ADMIN_API_KEY 解锁上传，提交后回「检索」页点「同步服务端数据」）。

---

## 六、2026-10-06 20:40 · OCR 解析器修复 + 清库重跑

用户报告：OCR 识别本身正常，但**入库后数据全错**（词条被截断、目录挤成 1 行、语法表 0 行）。
三个根因全部拿到实锤证据后修复，然后用库里留存的原始 OCR JSON 重跑，
**没有二次调用 PaddleOCR**（省额度、结果可复现）。

### 6.1 词条 parser（`server/src/parsers/entry.ts`，重写）

| 症状（旧） | 根因 | 修法 |
|---|---|---|
| `aba·cus` → `aba`、`aban·don` → `aban`，abandon 与 abandonment 撞成同一 word_key | 词头正则不含音节间隔号 `·` | 词头允许 `·`，命中后 `normalizeHeadword()` 还原成 `abacus` |
| 一行里的 `abate` / `abbey` 被吞掉 | 按 block/行切分，一行只取第一个词头 | 改为**在整页文本上用「词条起始模式」正则扫描**，命中即开新词条 |
| 出现假词条 `election policy`（例句尾巴 + 下一词条拼在一起） | 同上 | 起始模式要求「词头 + 可选音标 + 词性缩写」同时成立 |
| `rebellio` 这类回退式误伤 | 词性 `n.` 吃掉了词尾字母 | 无音标时要求词头与词性之间必须有真实分隔符、且必须位于行首 |
| 例句抽不出来 | 例句与释义混在一行 | 「英文句（首字母大写 + ≥3 词 + 句末标点）+ 紧随中文译文」成对抽取 |

起始模式：`边界(行首/空白/汉字/假名/右括号) + 词头(含·) + 可选符号 + 可选音标 + 可选符号 + 词性缩写`。
刻意**不包含冒号边界**——发音规则表里大量 `读作/ei/：gate/gert/n.` 这类微型词条会被过滤掉。

### 6.2 目录 parser（`server/src/parsers/toc.ts`，重写）

| 症状（旧） | 根因 | 修法 |
|---|---|---|
| toc 只有 1 行、title 578 字符 | 目录页整页只有 1 个 OCR block，整块被当成 1 行；且 adapter 归一化时把 `\n` 压成空格 | ① adapter 逐行折叠空白、保留换行；② parser 先把 block 再按 `\n` 拆成行 |
| 多栏目录页码串行 | 同行挤了多个条目 | 同行多条目扫描 + 起止页码式（`1179~1254`）+ 粘连页码对半拆（`12001207` → 1200） |
| 层级全塌成 1 级 | 多栏 OCR 全顶格，没有缩进信息 | 缩进不可用时按编号前缀推导（`第X部分`=1 / 中文序号=3 / 罗马序号=4 / 其余=2） |
| 「重难点详解索引」产出几百条页码全错的目录 | 条目序号 1..N 被当成页码 | 整页页码去重后构成 1..N 稠密序列（N≤120）→ 整页丢弃 |
| 动物图形图页产出「gull 海鸥 → p.0」 | 没有页码也被当目录 | 一页至少 40% 条目带真实页码才承认是目录页 |

### 6.3 表格 parser（`server/src/parsers/table.ts` + `adapter.ts`）

`grammar_rules` 恒为 0 的根因：PaddleOCR 的表格在 `table_res_list[].pred_html`，
是 **HTML**（`<table><tr><td>动词原形(Infinitive）`），旧 adapter 只认 `markdown` 管道表。
修法：新增 `parseHtmlTables()`（支持 rowspan/colspan、HTML 实体解码、`<br>` 换行），
adapter 优先读 `pred_html`；`looksLikeVerbForm()` 放宽到允许 `be (am,is,are)` 这类带括号写法
（并在 `extra.baseFormAlias` 留下可直接检索的短形式 `be`）。

### 6.4 清库重跑（`server/src/scripts/reparse.ts`）

```bash
cd server
npm run db:reparse -- --dry-run              # 只预览，不写库
npm run db:reparse                            # 清派生三表 + 回放解析
npm run db:reparse -- --source-book=英语词典  # 只重放某一本书
npm run db:reparse -- --no-truncate           # 增量补解析，不清库
```

- 只清空 `entries / toc / grammar_rules`；`scan_records`（含原始 OCR JSON）**永远不动**；
- 共享序列 `dictionary_sync_seq` **不重置**，已同步过的前端还能拉到全部新数据；
- 分派逻辑抽到 `src/ocr/ingest.ts`，实时管线（`OcrPipeline`）与离线重跑共用同一份实现，
  避免两边漂移；多张目录页的 `order_index` 按批次累加偏移，保证同书内全局有序。

### 6.5 重跑结果（实测）

| 表 | 重跑前 | 重跑后 |
|---|---|---|
| `entries` | 6（截断/错拼：`aba`×2、`election policy`） | **12**（a / aback / abacus / abandon / abandonment / abate / abbey / abbreviate / abbreviation / ABC×2 / abdicate） |
| `toc` | 1（整页挤成一行，578 字符） | **81**（两页目录，19 条带父节点，含页码区间） |
| `grammar_rules` | 0 | **7**（abide / arise / awake / babysit / be / bear / beat） |

### 6.6 验证

```
npm run typecheck   ✅
npm test            ✅ 25/25（新增 12 条真实样本回归用例）
npm run build       ✅
npm run db:reparse  ✅ 全 13 条扫描重放无异常
```

### 6.7 还有什么没做 / 需要你决策

1. **只有 1 页词条页被扫**：12 条词条来自 `单词.jpg` 一页。要填满词库得继续拍正文页。
2. **`sourceBook` 仍是占位「英语词典」**：真实书名定下来后重提交或用 SQL 改键。
3. **`image_name` 乱码**：Windows curl 编码问题，仅该字段，原始图与结果都不受影响。
4. **字母索引栏页码串行**（`b 67O` 这类 OCR 把 0 认成 O）：属于 OCR 本身不可复原，未做兜底。
5. **要不要真的重跑一遍 OCR**：现在的重跑用的是库里留存的原始 JSON（结果可复现、不消耗额度）。
   如果你怀疑 OCR 本身有问题（比如想换拍得更清楚的照片），那要重新提交图片、会消耗 PaddleOCR 额度。

---

## 七、2026-10-06 21:45 · 义项分组 + 确认入库 + 扫描数据接入主界面

### 7.1 改了什么

**后端 `server/`**

| 文件 | 改动 |
|---|---|
| `src/parsers/entry.ts` | 新增**义项切分**：`splitSenseSegments()` 按「义项起始数字」把正文切段（标记 = 数字 1–9 紧贴拉丁字母/`(`，或「空格+拉丁字母」且前置为中文语境字符；真实样本驱动，`他有 2 本书` 不会误切），每段独立抽释义与例句 → `EntryDraft.senses[]`（例句挂到所属释义下，`他有 2 本书` 型例句一条不丢） |
| `src/types.ts` | 新增 `EntrySense` / `ParsedDrafts` / `parseParsedDrafts()`；`ScanStatus` 新增 `'parsed'`；`EntryDraft`/`SyncEntry` 增加 `senses` |
| `sql/001_init.sql` | `entries` 加 `senses jsonb`；`scan_records` 加 `parsed_drafts jsonb` + status CHECK 加 `'parsed'`（存量库幂等升级） |
| `src/db/repository.ts` | upsert 合并 `senses`（新值非空才整体覆盖）；`syncSince` 透传 senses；新增 `stageParsedScan()`（status='parsed' + parsed_drafts） |
| `src/ocr/ingest.ts` | 拆成 `parseIngestPages()`（纯解析不碰库）与 `applyParsedDrafts()`（确认后 upsert），管线/重跑/确认三方共用 |
| `src/ocr/pipeline.ts` | dictionary 用途识别完成后**暂存待确认**（不再直接入库）；material 用途保持原行为 |
| `src/scripts/reparse.ts` | 改为「重解析 → 暂存」，不再写正式表、不再清库 |
| `src/scripts/review.ts` | **新增** `npm run db:review`：打印待确认草稿（逐词条义项/例句/目录/语法，只读） |
| `src/scripts/confirm.ts` | **新增** `npm run db:confirm [--truncate] [--scan=|--batch=|--source-book=]`：确认入库，目录跨页 order 偏移在此处理 |
| `test/parsers.test.ts` | 25 → **29** 用例（新增义项分组 4 条：真实样本 a / abacus / aback / abandonment + 普通数字防误切） |

**前端 `src/`**

| 文件 | 改动 |
|---|---|
| `src/data/dictClient.ts` | `ScanStatus` 加 `'parsed'`；`SyncEntry` 加 `senses` |
| `src/domain/types.ts` | 新增 `DictSense`；`DictEntry.senses` |
| `src/domain/dict.ts` | 同步落库时守卫式解析 senses（脏数据丢弃不崩） |
| `src/components/dict/DictSenseSection.tsx` | **新增**：义项 chips 上排并列（横滑、选中葱绿），点选显示该释义的例句；例句全量展示不设上限；无法归属义项的例句如实标注「其他例句（未标注所属释义）」；老数据无分组时回退整条释义 |
| `src/pages/Search.tsx` | 内置词库结果下方新增「词典扫描库命中」分组（点击进 `/word/:word`）；内置 0 命中且有扫描命中时不再显示「没找到」空态 |
| `src/pages/WordDetail.tsx` | 新增「词典扫描」分区（可参与排序）；内置词库查不到该词时分区独立成页，不显示「词库里没有」；例句点词弹窗、跟读评分在扫描例句上照常可用 |
| `src/components/dict/DictPanels.tsx` | 上传面板文案对齐两段式：状态显示「待确认」，摘要改名「解析摘要（待确认）」并提示需 db:confirm |

### 7.2 入库流程（新）

```
上传/识别完成 → 解析成草稿暂存（status='parsed'，不写正式表）
  → npm run db:review                 # 人工核对（逐条打印义项/例句）
  → npm run db:confirm [--truncate]   # 核对无误才入库；--truncate 先清三表全量重建
```

本轮已执行：`db:migrate`（加列）→ `db:reparse`（13 条全部暂存）→
`db:review`（12 词条 / 21 义项 / 10 例句核对无误）→ `db:confirm --truncate`（入库）。

### 7.3 重跑后数据

| 表 | 数量 | 备注 |
|---|---|---|
| `entries` | 12 | **全部含义项分组，共 21 义项**；例句 10 条各挂所属释义 |
| `toc` | 81 | 与上轮一致 |
| `grammar_rules` | 7 | 与上轮一致 |

### 7.4 验证（全绿）

```
server:  typecheck ✅  test 29/29 ✅  build ✅  db:migrate/reparse/review/confirm ✅
         GET /api/health ✅  /api/search?q=abacus ✅  /api/sync/dictionary 含 senses ✅
前端:    tsc --noEmit ✅  npm test（10 套）✅  build ✅  check_pwa 10 项 ✅
         preview 4174：/ /search /word/aback /dict-ingest 全 200 ✅
```

### 7.5 还有什么没做 / 需要你决策

1. **aback 第一条例句的中文译文尾部带「常用短语」四个字**（原书排版就是
   `…把书捡了起来。常用短语 take sb. aback…`，文字系统切分把它并进了译文）。
   属于真实文本流，未做删改——要修需引入「短语小节」结构识别，等扫描页多了再定。
2. **义项 3（a 的 every;any）那条例句没配上**：原 OCR 文本该例句以 `.(一辆)` 结尾
   （英文句号后紧跟全角括号），配对判定不认。与旧版扁平抽取行为一致，未加兜底规则。
3. **前端要看效果**：`/dict-ingest` 页点「同步服务端数据」把新 senses 拉到本地后，
   `/search` 搜 aback 即出现「词典扫描库命中」，点进 `/word/aback` 看「词典扫描」分区。
4. 同上轮：只扫了 1 页词条页、`sourceBook` 占位、`image_name` 乱码、字母索引页码串行。

---

## 八、2026-10-06 23:30 · 搜索全局化 + 未收录文案 + 音标口音标注

### 8.1 需求与实现

| 需求 | 实现 |
|---|---|
| 搜索是全局的，现有单词也放数据库 | 新表 `words`：内置 5 本词库（CET4/CET6/TEM8/TOEFL/GRE8000）由 `npm run db:seed-words` 从 `data/linguabase/v1/search-index.json` 幂等导入——22,791 条去重为 **13,974 词**（13,972 含音标，2 词无音标）。一词一行，多本收录聚合进 `books` jsonb |
| 搜索全局 | `GET /api/search` 一次返回 `{ hits(扫描库), words(内置词库) }`；words 排序：精确 > 前缀 > 词内包含 > 中文释义。前端 `/search` 主走服务端，服务端不可达才回退本地（离线兜底，空态注明）。新增 `GET /api/dictionary/entries?word=`：详情页扫描词条「本地优先 → 服务端回退」，不再依赖手动同步 |
| 未搜到提示「该词暂未收录」 | `/search` 空态与 `/word/:word` 空态统一改为「该词暂未收录」 |
| 音标检查英美、只标有的、无替换按钮 | 内置词库音标来源为英音 → 显示「英音」标注；美音音标无数据来源 → **英/美切换按钮整体移除**（没有的数据不提供入口）；TTS 朗读口音跟随既有 accent 设置（默认英音）；扫描词条音标原书未标口音，如实不标；无音标词（2 个）显示「音标未收录」 |

### 8.2 改动文件

**后端**：`sql/001_init.sql`（words 表 + 索引）、`src/scripts/seed-words.ts`（新增）、`src/types.ts`（WordBookRef/WordSearchHit/EntriesByWordResponse，SearchResponse 加 words）、`src/db/repository.ts`（searchWords / listEntriesByWord / search 拆分并行）、`src/routes/dictionary.ts`（新端点）、`package.json`（db:seed-words）。

**前端**：`src/data/dictClient.ts`（searchGlobal / fetchDictionaryEntriesByWord）、`src/domain/dict.ts`（lookupDictEntries）、`src/pages/Search.tsx`（服务端主路径 + 本地回退 + 空态）、`src/pages/WordDetail.tsx`（音标区重构 + lookupDictEntries + 空态）、`scripts/test_word_detail.ts`（需求 2 断言按新需求更新）。

### 8.3 验证（全绿）

```
db:migrate ✅  db:seed-words ✅（13,974 词）
server:  typecheck ✅  test 29/29 ✅  build ✅
         GET /api/health ✅
         /api/search?q=aback → words:0 + hits:3（aback 只在扫描库，内置词库无此词——正确行为）
         /api/search?q=算盘 → words:[abacus]（中文释义命中）
         /api/dictionary/entries?word=aback → 1 条完整词条（senses/examples 齐全）
前端:    tsc ✅  npm test 全部通过 ✅（旧「英美切换」断言按新需求更新）  build ✅  check_pwa 10 项 ✅
         preview：/ /search /word/aback /word/abacus /dict-ingest 全 200 ✅
```

### 8.4 备注

- 之前截图搜 aback 空结果，根因是旧架构要**手动同步**扫描数据到本地才能搜到；现在服务端直查，无需同步。
- 离线时回退本地：内置词库走本地索引照常可搜，扫描库只能搜到已同步过的部分（空态已如实注明）。

---

## 九、2026-10-07 23:40 · 修复局域网/手机访问接口全 404

### 9.1 现象与根因（一个根因，三种症状）

| 症状 | 链路 |
|---|---|
| 扫描上传报「请求失败（HTTP 404）」 | POST `/api/ocr/material` → vite 无代理直接 404 |
| 同步报 `Cannot read properties of null (reading 'entries')` | GET `/api/sync/dictionary` 被 vite SPA 回退接住返回 **200 + index.html**，前端 JSON.parse 得 null → `applySyncPayload(null).entries` 崩 |
| 搜索无数据 | 同理，搜索接口全被 vite 拦截 |

根因：`vite.config.ts` 从未配置 `/api` 代理。手机/局域网设备访问 `http://<本机IP>:4174`
时，前端以相对路径 `/api` 发请求，全部落在 vite 自己身上而非 8787 后端。
（POST 无 SPA 回退 → 404；GET 被 history 回退当页面路由 → 200 HTML，更具迷惑性。）

### 9.2 修复

1. `vite.config.ts`：新增 `apiProxy`（`/api` → `http://127.0.0.1:8787`，可环境变量
   `VITE_API_PROXY_TARGET` 覆盖），同时挂到 `server.proxy` 与 `preview.proxy`——dev 与 preview 一并生效。
2. `src/data/dictClient.ts`：`requestJson` 对「HTTP 200 但响应体不是 JSON」抛明确错误
   「服务返回异常（响应不是 JSON），请确认后端服务已启动」，不再让 null 流进上层。
3. 运维要求写进前提卡：**后端 8787 与前端服务器必须同时在跑**（本次现场后端就没起）。

### 9.3 验证（curl 走 4174 代理 = 手机视角，全绿）

```
GET http://127.0.0.1:4174/api/health        → 200 {"status":"ok",...,"database":"ok"}
GET /api/search?q=aback                     → hits:3 精确命中（扫描库）
GET /api/sync/dictionary?since=0&limit=1    → 正常 JSON（此前被 SPA 回退吃掉）
GET /api/dictionary/entries?word=abacus     → 完整词条含 senses
```

### 9.4 未构建说明与遗留

- **本次未执行 `npm run build`**：`src/pages/Reader.tsx` / `ReaderSettingsSheet.tsx` 存在
  8 个类型错误（`settingsPanel`→`settingsOpen` 改名改一半、`Sun`/`TypeIcon` 未导入等），
  属于 2026-10-07 01:40「界面七项改版」的遗留/进行中编辑，不在本次修复范围，待其完成后再统一构建。
  代理修复**不需要重新构建**（vite 配置重启进程即生效），当前 dist（10-07 22:25 全绿版）照常服务。
- dictClient 兜底改动已在源码，随下次构建一起生效。
