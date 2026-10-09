# 述树（ShuShu）— 项目交付包

移动优先的英语学习 App，面向**零基础中文母语者**。纯前端离线运行（Dexie / IndexedDB 本地数据），已在云端部署。

> 在线地址（真机 Chrome 打开即可验证）：
> **https://a8e9777fb6f038d30.app.workbuddy.host**

---

## 目录结构

| 目录 / 文件 | 说明 |
|---|---|
| `dist/` | **已构建的可部署应用**（直接用静态服务器托管即可运行，无需编译）。约 1.1MB，**不含词库数据** |
| `src/` | 全部源代码（React18 + Vite + TS + Tailwind） |
| `src/services/` | **平台适配层**：`storage`（Dexie）/ `speech`（Web Speech）/ `recording`（MediaRecorder）。平台 API 只出现在这里 |
| `src/domain/` | **领域层**：学习数据实体（`types.ts`）与 SRS / 统计业务逻辑（`learning.ts`），与存储实现解耦 |
| `data/linguabase/v1/` | 真实词库 **410MB**（OpenEtymology 22,791 词 + Linguabase 全量 104 万单词），**不参与打包**，已 gitignore |
| `public/` | 只放 PWA 图标等小文件（`favicon.ico` + `icons/`，约 50KB） |
| `产品方案/` | 13 篇设计文档（PRD→IA→Flow→Pages→Components→DataModel→组件树→技术选型→MVP顺序→验收标准→数据校验→接入管线→内容层） |
| `scripts/` | 数据管线（`build_search_index.py` / **`upload_data.py`** / `gen_icons.py`）+ 单测（`test_*.ts`） |
| 根配置文件 | `package.json` `vite.config.ts` `tsconfig.json` `tailwind.config.js` `postcss.config.js` `index.html` `vercel.json` `.env.example` `.gitignore` |
| `部署与外部存储方案.md` | 数据外置 + PWA + Service 层的完整设计（P0→P3 阶段划分） |
| `项目续作摘要.md` | 给新任务的接手上下文（技术栈 / 已做 / 约束 / 待办） |

---

## 架构分层（改动前必读）

```
页面 / 组件           src/pages, src/components      ← 只调 domain 与 service 的公开 API
      ↓
领域层（业务规则）    src/domain/{types,learning}.ts ← SRS 状态机、统计口径；不知道数据存哪
      ↓
服务层（平台适配）    src/services/{storage,speech,recording}
      ↓
平台 API             Dexie/IndexedDB · Web Speech API · MediaRecorder
      ↓
内容数据（只读）      src/data/{dataClient,repository}.ts → 外部对象存储
```

**硬性规则**：`dexie` 只允许出现在 `src/services/storage/web.ts`；
`speechSynthesis` / `SpeechRecognition` 只允许出现在 `src/services/speech/web.ts`；
`MediaRecorder` / `getUserMedia` 只允许出现在 `src/services/recording/web.ts`。
将来包 Capacitor / 小程序时，只需新增一个实现并在各 `index.ts` 里换 driver，上层零改动。

已用静态检查守住这条线：

```bash
# 1) 应该只输出 src/services/storage/web.ts 一个文件
grep -rln "from 'dexie'" src

# 2) 应该没有任何输出（只匹配真正的调用，不误伤注释里的说明文字）
grep -rnE "speechSynthesis\.|new MediaRecorder|navigator\.mediaDevices|webkitSpeechRecognition" src \
  | grep -v "src/services/"
```

---

## 本地运行 / 二次开发

```bash
# 1. 安装依赖（已锁定版本，见 package-lock.json）
npm install

# 2. 本地开发预览
npm run dev

# 3. 生产构建（产物输出到 dist/）
npm run build

# 4. 本地预览构建产物（**验证 PWA 必须用这个**，dev 下 Service Worker 是关闭的）
npm run preview     # http://localhost:4173

# 5. 跑全部单测（6 套）
npm test
```

> - `npm run dev` → **5173**；`npm run preview` → **4173**（分端口是为了能同时对照「开发」与「PWA 生效」）。
> - 词库数据在 `data/` 下，**不在 public/**。dev / preview 由 `vite.config.ts` 里的 `localDataPlugin`
>   把 `/data/linguabase/v1/**` 映射到本地目录；生产改成 `VITE_DATA_BASE_URL` 指向对象存储。
> - 依赖 `compromise`（语法分析）已做动态分包，仅在点词时懒加载，不拖慢首屏。
> - 录音需要**安全上下文**：`https` 或 `localhost`。手机通过局域网 IP（http://192.168.x.x）打开时录音按钮会隐藏 —— 这是浏览器限制，不是 bug。

### 从零重建词库数据（一般不需要）

```bash
# 1. 由本地全量数据集导出到 data/linguabase/v1/（在 D:\English 下运行）
python export_full_to_shushu.py

# 2. 生成全词搜索索引 + 学习路径目录
python scripts/build_search_index.py

# 3. 生成 PWA 图标（改了品牌色才需要）
python scripts/gen_icons.py
```

---

## 已交付功能清单

- **设计层**：从 0 完成 10 步设计（PRD→验收标准）+ 3 篇数据专题文档。
- **真实内容层**：OpenEtymology EPUB 解析，CC BY-SA 4.0（**须署名**，见下方约束）。22,791 词，分片于 `data/linguabase/v1/`（index.json + books/CET4…GRE8000.json）。
- **学习闭环**：生词本（分层 new→apply→mastered）+ SRS 间隔复习 + 闯关（连对 5 次晋级）+ 听书 + 跟读评分。
- **导入能力**
  - 文本粘贴导入
  - 书籍：**TXT / EPUB** 真实解析（EPUB 用 jszip 解包提取全文），其余格式在导入页标注「敬请期待」，绝不伪造内容
  - 音频：**MP3 / M4A / M4B** 文件上传（已移除麦克风录音）
- **增强阅读器（双模式）**
  - 阅读模式：点词自动加生词本 + 语法分析（句型结构 / 时态 / 词性角色）
  - 记忆模式 = **就地默写**：被隐藏的词在原文位置直接变成输入框，没有单独的答案框；输入过程逐字实时校验，偏离答案立刻标红
  - 隐藏方式三选一：随机隐藏（15% / 30% / 45% / 65% / 90%，另有「换一批」）/ 完全隐藏（不含标点 · 含标点）/ 自主选择（点词即勾选）
  - 听书可调倍速：0.5 / 0.75 / 1 / 1.25 / 1.5 / 2，改完长期生效
  - 默写进度自动保存（500ms 防抖写本地），下次打开同一素材接着写
  - **录音背诵**：MediaRecorder 录真实音频，页面上直接回放；可继续录制（连录多段）、取消、删除；自动归档到「我的 → 背诵」，文件名 =「当前日期-背诵时长」（如 `2026-10-02-01:23`）
  - 内置细绿滚动条 + 滚动位置记忆（下次进入接续上次）
- **书架**：「我的」页书籍分区（加入 / 移出书架），首页书架分区即点即看；音频项内联播放。
- **CC BY-SA 4.0 署名**：设置页「数据来源与授权」区块，来源 / 署名 / 协议 / 词数全部取自 `index.json`，并声明「衍生作品采用相同协议」。换数据源时署名自动跟随，不会张冠李戴。
- **诊断测试**：由真实词库现场生成 5 题梯度（L1 基础短词 ×2 / L2 中长词 ×2 / L3 长词 ×1），答完定级并推荐起始词本，结果存本地 `diagnose` 表。题干与干扰项均为真实词条的真实释义。
- **进度可视化**：连续学习天数、生词本分层统计、周 / 月 / 年 / 总掌握量柱图、阅读时长，全部来自本机真实行为日志。
- **每轮词数可配置**：设置页可选 5 / 10 / 20 / 30 / 50，学习流按此分批出卡、复习闯关按此限制本轮题量，改完即存、长期生效（旧存档自动补默认值）。
- **学完一轮有交代**：本组最后一张点「完成本轮」弹窗结算 —— 鼓励语 + 本轮词数 / 新入生词本数 / 生词本现有词数（全部真实统计），本轮的词**自动进入生词本**（layer=new，10min 后首次复习），随后按「生词 → 运用 → 掌握」的 SRS 节奏推进；已在生词本里的词不会被重置。
- **音频自动让位**：听书朗读中查单词或播放其他音频（背诵回放 / 音频素材），会自动暂停听书、播放当前的，**当前的播完再自动接着听书**。听书按**句子**推进，被抢占后只从当前句开头重读，几乎无感。
- **书籍目录 + 分页 + 续读**：EPUB 解析保留章节导航（EPUB3 nav / EPUB2 NCX），TXT 识别 `Chapter N` / `第X章` 自动切章；阅读器按段落分页（不切断句子），页码写回本地，下次打开直接续读；听书与记忆默写均以「当前页」为单位。
- **全词库搜索**：一次搜索覆盖全部 5 个词本（22,791 词），不再需要用户选词本；匹配优先级为「前缀 → 词内包含 → 中文释义」，点结果按需加载完整词条（例句 / 词源 / 词根词缀）。
- **学习路径**：按「词本 × 难度档」组织，共 5 词本 × 3 档；节点词数由 `catalog.json` 预计算，点击直接进入该档学习流。

---

## PWA 与离线能力

用 `vite-plugin-pwa`（v1.3.0，Workbox 7.4.1）实现，`registerType: 'autoUpdate'`。
产物：`dist/sw.js` + `dist/workbox-*.js` + `dist/manifest.webmanifest`，预缓存 14 项（约 968KB）。

**绝不 precache 词库数据**（410MB）。数据走运行时缓存，按 URL 分流：

| 类型 | URL | 策略 | 理由 |
|---|---|---|---|
| 稳定索引 | `index.json` `manifest.json` `catalog.json` `themes/index.json` `bank/index.json` | **NetworkFirst**（5s 超时） | 联网优先拿最新目录，断网回退缓存 |
| 版本化分片 | `books/*` `themes/<id>.json` `bank/L*.json` `defs/*` | **CacheFirst** | 路径带 `v1`，内容不可变；命中即回缓存，最省流量 |

缓存上限：索引 12 条 / 7 天，数据分片 60 条 / 90 天，且 `purgeOnQuotaError`（配额吃紧时先丢数据缓存，别把应用外壳挤掉）。

**iOS 注意**：Safari 对未「添加到主屏幕」的站点，7 天不活跃后会清空 CacheStorage/IndexedDB。
要让离线内容长期保留，必须引导用户安装到主屏幕。

**验证 PWA 必须用 `npm run preview`（4173）**：`devOptions.enabled = false`，
避免开发时 SW 缓存住分片数据、改了看不到。

---

## 部署（前端 Vercel + 数据 Cloudflare R2）

前端上 Vercel，410MB 词库放对象存储。**选 R2 的决定性理由：出口流量免费**
（词库会被反复读取，S3 + CloudFront 那类按流量计费的方案账单会失控）。

```bash
# 1. 上传数据（详见 scripts/upload_data.py 头部说明）
export S3_ENDPOINT="https://<account_id>.r2.cloudflarestorage.com"
export S3_BUCKET="shushu-data"
export AWS_ACCESS_KEY_ID="..."          # R2 API 令牌
export AWS_SECRET_ACCESS_KEY="..."
export AWS_DEFAULT_REGION="auto"
python scripts/upload_data.py --dry-run # 先看计划：159 个对象 / 409.2MB
python scripts/upload_data.py           # 正式上传

# 2. 在 R2 控制台给桶配 CORS（允许你的站点域名 GET）
#    最小配置见 .env.production.example 里的注释

# 3. Vercel：导入仓库 → 设置环境变量 → 部署
#    VITE_DATA_BASE_URL = https://<你的域名>/linguabase/v1/
```

- `vercel.json` 已配好：SPA 回落（除静态文件外全部 rewrite 到 `index.html`）+
  分层缓存头（`sw.js` 绝不缓存；`/assets/*` 一年 immutable）。
- 缓存头策略由 `scripts/upload_data.py` 统一决定：分片 `immutable` 一年，索引 5 分钟。
- **发新版数据 = 发 `v2` 目录**，老客户端继续读 `v1`，互不影响（路径即版本）。

---

## 硬约束（务必遵守）

1. **绝不编造虚拟数据** —— 全程使用真实 Linguabase / OpenEtymology 抽取内容。
2. **CC BY-SA 4.0 署名** —— OpenEtymology 词库采用该协议，App 设置页**已**补充署名与「衍生作品采用相同协议」声明（✅ 已落地，见 `src/components/SourceAttribution.tsx`）。
3. **headless 环境无 IndexedDB** —— 依赖 Dexie 的功能无法在沙箱里做端到端点击验证，改用 `fake-indexeddb` 单测 + 真机验证。
4. **数据不得放在 `public/` 下** —— 否则 `vite build` 会把 410MB 原样复制进 `dist`，构建产物爆炸。放 `data/`（已 gitignore），走 `dataClient` 访问。
5. **平台 API 不得越过 service 层** —— 页面 / domain 禁止直接 `import Dexie`、调 `speechSynthesis` 或 `MediaRecorder`。

---

## ⚠️ 数据陷阱（改动前必读）

**`frequency_rank` 不是词频，是字母序下标。** 实测 CET4 共 4515 词，该字段恰为 `1..4515`，
而词表本身按字母序排列 —— 任何「按词频排序 / 分档」的逻辑都会退化成按首字母 a→z 切片，梯度失效。

已受影响并修正的两处：

- 诊断分档 → 改用 **词长 + 语素数（`morphemes`）** 作难度信号（`src/lib/diagnostic.ts`）
- `sortWords` → 改用 **difficulty_level → 词长升序**，短词先学（`src/data/repository.ts`）

若将来接入真正的词频数据，需重新审视这两处。

---

## 数据管线（改动词库后需重跑）

```bash
# 生成全词搜索索引 + 学习路径目录（两者都由词本 JSON 预计算）
python3 scripts/build_search_index.py
```

产出 `data/linguabase/v1/search-index.json`（22,791 词，约 4MB，gzip 后 ~1.2MB，按需懒加载）
与 `catalog.json`（约 1.4KB，学习路径用）。未跑该脚本时，搜索页与路径页会显示空状态，不会退回假数据。

---

## 验证状态

- `tsc --noEmit` 通过
- `npm run build` 通过，`dist/` **1.1MB**（此前数据在 public/ 下时为 410MB+），且已确认产物中无任何词库 JSON
- `npm test` 六套单测全部通过：
  | 脚本 | 覆盖 |
  |---|---|
  | `test_features.ts`（81 项） | 默写标红比对 / EPUB 提取 / 语法分析 / 诊断出题与定级 / 搜索排序归并 / 分页与目录 / TXT 章节 / 音频仲裁 / 听书抢占恢复 / 录音命名 |
  | `test_data_client.ts`（15 项） | 基址解析优先级与尾斜杠 / 路径穿越拒绝 / 成功才入缓存 / 404 不重试而 5xx 重试 / LRU 上限 48 |
  | `test_storage.ts`（19 项） | 内存 driver 的 CRUD / 批量读写 / 自增主键 / 索引查询与**未建索引字段显式报错** / 领域逻辑跑在内存实现上 |
  | `test_services.ts`（26 项） | 语音与录音在无浏览器 API 时优雅降级 / `speakAsync` 必须 resolve / 听书循环无真实语音也能跑完 / 跟读评分 |
  | `test_learning_loop.ts` | Dexie driver 上的 SRS 闭环（new→apply→mastered、答错回流、层统计） |
  | `test_readings.ts` | Dexie driver 上的导入 / 阅读进度 / 跨日时长累计 |
- 启动冒烟：
  - dev（5173）：`/`、`data/linguabase/v1/index.json`、`bank/index.json`、`bank/L1.json` 均 200
  - preview（4173）：`/`、`manifest.webmanifest`、`sw.js`、`icons/icon-192.png`、`data/.../index.json`、`data/.../defs/bank_L1.json` 均 200；`/bank/level/L1` SPA 回落 200
  - 目录穿越 `../..%2fpackage.json` → **403**
- Service Worker 运行时分流规则逐 URL 校验通过（13 个样例全部匹配预期策略，数据文件均未被纳入 precache）

---

## 待办

### P3 上线（需要你的云账号，代码侧已就绪）
- [ ] 建 Cloudflare R2 桶 + 配 CORS（模板见 `.env.production.example`）
- [ ] `python scripts/upload_data.py` 上传 159 个对象 / 409.2MB
- [ ] Vercel 导入仓库，设 `VITE_DATA_BASE_URL`，部署
- [ ] 真机验收：Chrome / Safari「添加到主屏幕」→ 断网打开已加载内容
- 详见 `部署与外部存储方案.md`

### 功能迭代（可选）
- 运用层：造句 + AI 校验（Phase 2）
- GRE8000 词本再切分；其余书籍格式（DJVU / CBZ / CBR / MOBI / AZW3 / FB2 / PDF）能力拓展
- 诊断目前只考「词义辨识」，未覆盖 PRD 里的字母 / 音标与句型题（缺对应真实数据，故不编造）
- 真机回归：诊断、进度图表、EPUB 目录、分页续读均需真机点一遍（沙箱无 IndexedDB / DOMParser）
- `extractEpubText` 已无调用方（导入改用 `extractEpubBook`），保留作兼容 API
