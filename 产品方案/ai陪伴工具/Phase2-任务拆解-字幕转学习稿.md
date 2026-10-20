# Phase 2 任务拆解：字幕 → 学习稿

日期：2026-10-18 · 状态：**待用户评审**（未开工） · 依据：用户当日三项拍板 + 代码事实核查

---

## 0. 决策记录（2026-10-18 拍板）

| 决策点 | 结论 | 核心依据 |
|---|---|---|
| 持久化落点 | **前端 Dexie `transcripts` 表**，PG 不新增 asr 表 | 离线优先红线；transcript 是用户资产起点，必须跟着用户走；PG 角色不变（账号 + 系统配置） |
| LLM 供应商 | **云端，OpenAI 兼容接口**；prompt 设计列为 Phase 2 核心开发任务单独迭代 | 本机 15.2GB 内存跑 ASR small int8 已吃紧，本地 LLM 不考虑 |
| 重点词汇打通 | **必须打通**本地词库；transcript 为数据中枢，派生数据双向关联 | 述树核心价值定义，非可选增强 |

`transcripts` 表结构（拍板稿）：

```ts
// Dexie version(9) 新增
{
  id: string,          // job_id，与 ASR job 对齐
  language: string,
  duration: number,    // 秒
  segments: Segment[], // {start, end, text}[]
  created_at: number,  // epoch ms
  source: string       // 'asr' — 后续学习稿可能另有来源
}
```

### 两项事实修正（影响拆解，必须先说清）

**修正 1：「代码里已有 AI_PROVIDER / OPENAI_* 配置体系和 LLMProvider Protocol」——在述树不存在。**
对 `server/src` 全量 grep（openai / AI_PROVIDER / OPENAI_ / LLMProvider / EventSource / event-stream）**零命中**。这套设施的真实位置在「语音识别」项目 `backend/app/ai/`（provider / prompts / streaming / worker / schemas / repository + SSE 事件桥 + Step 9 验收报告）。因此 Phase 2.2 的处理方式与 Phase 1.5 的 ASR 相同：**迁移适配，不是「直接用」**。

**修正 2：语音识别项目的流式架构不能整体照搬。**
其 LLM 跑在独立 Python Worker 进程，SSE 订阅者在 API 进程，两者用「内部 HTTP 事件桥 + 0.3s 节拍落库 + offset 断线重连」粘合——这套是为「Worker 与 API 分离」设计的。述树 Node 侧调用 OpenAI 兼容接口只是**普通出站 HTTPS 流式请求**，Express 路由可直接持有上游流并管道化为 SSE 响应，单进程内不需要 Worker、事件桥、DB 轮询。**迁移的是概念**（provider 协议、prompt 管理、增量累加器），**不是架构**。

**架构后果（由决策 1+2 推出）**：LLM 调用**必须走后端路由**——项目红线「令牌只在 server/.env」，前端不持有 API key。transcript 存前端 Dexie 与调用走后端不矛盾：按请求把 transcript 文本发给后端，密钥不出服务器。

---

## 1. 架构总览

```
【2.1 持久化】ASR done → 前端轮询到 transcript
                → 写 Dexie transcripts 表（永久留存）
                → JobStore record 仍按 2h TTL 回收（只管任务生命周期）

【2.2 生成】   Dexie transcripts
                → 前端 POST /api/ai/study-notes（带 segments + language）
                → server/src/llm/（OpenAI 兼容，流式 fetch）
                → SSE 逐段回流 → 前端累加渲染（脉冲指示）
                → 完成写 Dexie studyNotes 表（source: ai_generated）

【2.3 词汇】   studyNotes.vocabulary[]
                → 本地 Dexie dictEntries 匹配（22,791 条，已同步在库）
                → 命中：词库释义/音标/例句（权威）+ LLM 双语解释（语境补充）
                → 未命中：LLM 释义 + 「AI 生成」徽标 → 一键入 vocab 生词本 → SRS

【2.5 回溯】   studyNote 条目 → segmentIndex/start → 媒体 currentTime 跳转

【2.4 增量】   vocabulary → 检索 API（B.7/B.8 HNSW）→ 书籍真实用例卡片
```

---

## 2. 任务分解（按依赖排序）

### 2.1 transcript 持久化 —— 前端为主，后端零改动

| 项 | 内容 |
|---|---|
| 范围 | Dexie `version(9).stores({..., transcripts})` 只增表（遵守 web.ts 既有纪律：只新增 version，不改历史版本）；storage service 层加 transcripts CRUD；domain 层编排写入 |
| 写入时机 | `domain/transcript` 轮询到 `done` → 经 storage service 落库（页面不直接碰 dexie，红线） |
| JobStore | **不改**。2h TTL + 墓碑 + 终态 removeMedia 原样保留；它管 ASR 任务生命周期，transcript 已在前端永久化 |
| PG | 不动（无 asr 表） |
| 同步 | 不进 sync_queue（同步链只服务词典数据），避免误入账号同步 |
| 验收 | 杀后端/重启浏览器后 transcript 仍在；Dexie v8→v9 迁移测试；service CRUD 单测 |
| 风险 | segments 体积：10 分钟音频 ≈ 几百 KB，Dexie 可承受；单条超限先不堵，真炸再说 |

### 2.2 学习稿生成（LLM 流式）—— 后端新模块 + 前端流式消费

**后端 `server/src/llm/`（新目录，与 asr/ 平级）**：

| 文件 | 职责 |
|---|---|
| `config.ts` | `AI_PROVIDER` / `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` / `AI_FIRST_TOKEN_TIMEOUT_MS`（默认 30000）/ `AI_STREAM_TIMEOUT_MS`（默认 120000）；未配置 → `resolveAiProvider` 返回 null → 路由 503「AI 服务未接入」（与 translate 同构，不造假）。双超时：首 token 超时防模型卡死，总超时防生成过长 |
| `provider.ts` | OpenAI 兼容客户端：`generate()` 非流式 + `generateStream()` 流式。**fetch 直连零依赖**（不引官方 SDK，先例：zip.ts）；上游 abort 即客户端断开即停 |
| `prompts.ts` | 四要素 prompt：内容摘要 / 双语解释 / 核心观点 / 重点词汇。**Phase 2 核心开发任务，单独设计迭代**；输出受 JSON schema 约束（见下） |
| `routes/ai.ts` | `POST /api/ai/study-notes` → `text/event-stream`；按路由挂中间件（红线：禁 router.use 全局挂） |

**2.2/2.3 接口契约（2026-10-18 评审冻结）**：LLM 输出 JSON——

```ts
{
  summary: string,          // 内容摘要
  bilingual_notes: string,   // 双语解释（述树差异化主力；与 summary 拆开，四要素独立可编辑）
  key_points: string[],     // 核心观点
  vocabulary: [{
    word: string,           // 原形/lemma
    pos: string,            // 词性——dictEntries 同词形多条记录靠它精确命中
    gloss: string,          // AI 生成的双语解释
    context?: string,       // 原文语境（可选；segments 已有时间戳，不强求）
  }],
}
```

**为什么 vocabulary 必须带 pos**：dictEntries 22,791 条，同一词形可能对应多条不同词性记录；无 pos 只能模糊前缀查，命中率与精度双降，且无法给出「词库有这个词但词性不同」的有用反馈。**释义不编造**——命中词库用词库，未命中显「AI 生成」标。

**前端**：

| 文件 | 职责 |
|---|---|
| `src/data/llmClient.ts`（新） | fetch + ReadableStream 读 SSE（POST 场景必须 fetch，EventSource 只能 GET）；超时/中断/非 JSON 防护沿用 asrClient 范式 |
| `src/domain/studyNote/`（新） | 流式累加 + 校验；经 storage service 写 `studyNotes` 表（Dexie version(9) 同批新增） |

**studyNotes 表 schema（评审冻结；注意 id 实现为 string uuid 而非 auto-increment——保持类型契约 `id: string` 不变，「调用方不管理 id」的行为用服务层生成 uuid 等价实现，与 readings/annotations/collections 等多数表现有一致风格）**：

```ts
{
  id: string,              // uuid（服务层生成）
  transcript_id: string,   // → transcripts.id
  summary: string,
  bilingual_notes: string, // 双语解释（与 summary 拆开，四要素独立）
  key_points: string[],
  vocabulary: { word: string, pos: string, gloss: string; context?: string }[],
  status: 'generating' | 'ready' | 'modified',
  created_at: number,
  updated_at: number,
  source: 'ai_generated' | 'user_modified',
}
```

**写入规则（2026-10-18 评审冻结）**：
- **覆盖不追加**：重新生成按 `transcript_id` upsert 同一行（查索引→存在则原地重置，不存在才新增），杜绝孤儿记录
- **用户修改保护**：重生成会丢掉 `user_modified`（source 重置为 `ai_generated`）——预期行为，UI 必须弹确认「重新生成将覆盖你的修改，确定？」
- **流式落库策略**：生成开始即建行（`status: 'generating'`，字段空），流式期间节流更新（字段完成即写，不做逐 chunk 落库）；完成置 `'ready'`；用户编辑置 `'modified'`。刷新 = 重生成（中断恢复不做），重启后残留的 `'generating'` 行一律视为上次中断残留，加载时按无效处理（下次生成自然覆盖）
| UI 入口 | `MediaTranscriptImport` 结果区下方「生成学习稿」按钮；流式逐字渲染 + 脉冲指示（模式参考语音识别 Step 9 前端 applyDelta；述树侧新写，含 loading/错误态） |

**明确不做**（修正 2 的落地）：Worker 进程、内部事件桥、DB 节拍落库、offset 断线重连。刷新页面 = 重生成（成本一次 LLM 调用，可接受）。停止生成按钮 = abort fetch，顺手做。

**验收**：未配置 → 503 明示；流式中断可重试；JSON 校验失败有明确错误；`llm` 单测（假 provider 流式 + 管道断言）。

### 2.3 重点词汇 ↔ 本地词库 —— 前端为主，零后端

| 项 | 内容 |
|---|---|
| 查询路径 | **本地 Dexie `dictEntries`**（22,791 条已由词典同步链落入 IndexedDB，不需要新接口、不调 PG） |
| 匹配 | `vocabulary[].word` → dictEntries 查询；大小写归一 + 原形还原复用 domain/dict 现有能力 |
| 命中 | 展示词库释义/音标/例句（权威源）；LLM 双语解释作为语境补充并列展示 |
| 未命中 | 展示 LLM gloss + 「AI 生成」徽标（与词库权威释义视觉区分）；「入生词本」一键写入 `vocab` 既有链路 → SRS |
| 验收 | 命中/未命中分流正确；未命中绝不显示词库内容（红线：不编造）；入生词本复用既有错误处理/EmptyState |

### 2.5 时间戳回溯 —— 前端纯逻辑，并入 2.2 UI 做

- studyNote 条目携带 `segmentIndex`/`start`，点击 → 结果区 `<audio>/<video>` `currentTime` 跳转
- 这是「保留来源关系」铁律（产品约束文档 §2）的技术落点
- 无后端、无存储改动，UI 层半小时级工作量

### 2.4 书籍用例检索 —— 增量，可后置

- **前置依赖**：发现书籍检索 API 不存在（B.7/B.8 只建了 DB 侧 HNSW 设施），需先暴露受控查询端点
- 链路：vocabulary → HNSW 检索 → 书籍真实用例卡片（「这个词在你读过的书里怎么用」）
- 与 2.1–2.3 **无依赖**，不阻塞 M3；接入时机由 B.7/B.8 API 决策触发

---

## 3. 依赖顺序与里程碑

```
M1 ── 2.1（transcript 入 Dexie）            无依赖，先做
M2 ── 2.2 + 2.5（生成 + 回溯闭环）          依赖 M1 提供真实测试数据
M3 ── 2.3（词库打通 = 核心差异化）           依赖 M2 的 vocabulary JSON 契约
M4 ── 2.4（书籍用例增量接入）                依赖检索 API 决策，可后置
```

- 2.3 的**词库查询部分**可与 M2 并行开发（契约先定即可）
- 每里程碑独立验证（产品约束文档 §6）：完一个再进下一个

---

## 4. 评审结论（2026-10-18）

| 待定项 | 结论 |
|---|---|
| vocabulary 契约 | ✅ 冻结：`{word, pos, gloss, context?}`（pos 为词库精确命中必备） |
| 摘要 vs 双语解释 | ✅ **拆开**：产品定义四要素彼此独立，用户可只改其一；bilingual_notes 是述树差异化主力，不做 summary 的附属 |
| studyNotes 同批 v9 | ✅ 同意，两表 schema 一并冻结（见 §2.2） |
| 中断恢复 | ✅ 不做（刷新=重生成）；附加覆盖规则：同 transcript_id upsert + 重生成 UI 确认 |
| AI 端点三值 | ✅ 同意；`.env.example` 留模板，真值只进 `server/.env`；超时拆首 token 30s / 总流式 120s |

**仍开放**：AI 端点三值（base_url / model / key）由你提供后写入 `server/.env` —— M2 联调前必需。

## 5. 交付纪律（不变）

- 验证四件套 + server 三件套全绿才算完；`node --test "dist/test/*.test.js"`
- Import 页新增「生成学习稿」入口 → 影响《产品前提卡-给协作方.md》页面清单 → 交付时同步
- 交付说明写清：改了什么 / 验证了什么 / 没什么没做 / 需要你决策什么
- 显式按路径 `git add`；禁 `git add .`

---

## 6. M1 交付记录（2026-10-19）

**改了什么**
- `src/domain/transcript/types.ts`：新增 `TranscriptRecord` / `StudyNoteRecord` / `StudyNoteVocabulary` / 状态与来源枚举；`types.ts` 头注 Phase 1「不落任何库」口径已改
- `src/domain/types.ts`：`StorageSchema` + `PrimaryKeyMap` 挂 v9 两表
- `src/services/storage/web.ts`：`version(9).stores({transcripts, studyNotes})` 纯新增无 upgrade；`INDEXED_FIELDS` / 类属性 / 头注索引清单同步
- `src/services/storage/memory.ts`：三张登记表（INDEXED_FIELDS / AUTO_INCREMENT / PRIMARY_KEY）同步，单测与降级兜底行为对齐
- `src/domain/transcript/store.ts`（新）：transcripts CRUD + studyNotes upsert/patch/delete；uuid 服务层生成；`storage` 出口注入，不直接碰 dexie
- `src/domain/transcript/transcribe.ts`：新增 `transcribeAndSave`（done 后落库；落库失败只告警不阻断）
- `src/components/transcript/MediaTranscriptImport.tsx`：入口换 `transcribeAndSave`；弱提示「刷新即丢」改「自动保存在本机」
- `scripts/test_transcript_store.ts`（新，31 断言）+ `package.json` test 链挂载

**验证了什么**：前端四件套全绿——tsc 0 错 / `npm test` 15 套全过（新测试覆盖幂等覆盖、upsert 不追加、patch、索引、done 自动落库）/ build（PWA v1.3.0，15 precache）/ check_pwa 10 项。

**没什么没做**：① 历史字幕列表 UI（属 M2，与学习稿入口一并做）；② studyNotes 流式读写（M2）；③ 前提卡 §5 页面清单仍缺 Phase 1 的「音视频字幕」页签记载（Phase 1 遗留的陈旧，按约定只在交付记录指出、未擅改）；④ 落库失败目前只 console 告警，UI 无提示（结果仍可看可导出，判定为可接受）。

**需要你决策什么**：无。M2（学习稿生成）开工前只需要 AI 端点三值（base_url / model / key）进 `server/.env`。

---

## 7. M2 交付记录（2026-10-20）

**改了什么**

*服务端（新模块 + 半成品脚手架演进）*
- `server/src/config.ts`：`loadConfig` 新增 `ai:` 装配（baseUrl / apiKey / model / firstTokenMs=30000 / streamMs=120000 / maxSegments=1200；越界回退默认）；修复了 `AiConfig` 接口存在但未装配的既有 typecheck 红号
- `server/src/llm.ts`（**重写**，原为 demo 版）：`streamLLM` 流式调用（AiConfig 注入、双超时、外部 signal 中断、SSE 行解析、错误分类 `LlmError(kind)` 与 `LLM_ERROR_STATUS` 映射）
- `server/src/llmStudyNote.ts`（新）：四要素 prompt 构造、`parseStudyNoteRequest` 请求体守卫、`validateStudyNotePayload` 契约校验（坏项丢弃 / 缺 pos 回退空串 / 重复词去重 / 全空判败）、`runStudyNoteGeneration` 编排
- `server/src/routes/ai.ts`（**重写**，废弃 demo 的 `GET /ai/stream?word=`）：`POST /api/ai/study-notes` → SSE（delta / done / error 三事件）；未接入 503 与坏请求 400 走写头前的统一 JSON；客户端断开 abort 上游、`res.on('error')` 防未捕获异常；限流 10 次/小时/IP；`fetchImpl` 仅测试注入
- `server/src/types.ts`：新增 `StudyNoteVocabulary` / `StudyNoteBilingualNote` / `StudyNotePayload` / `StudyNoteRequest` / `StudyNoteEvent`
- `server/src/app.ts` / `server/.env.example`：接线与 AI_* 六项模板（key 只进 .env）
- `server/test/llm.test.ts`（新，23 测）：流式累加、[DONE]/坏行容忍、上游错、双超时、外部中断、契约校验、请求体守卫、路由冒烟（503/400/SSE 全链路/断开即 abort 上游）

*前端*
- `src/data/llmClient.ts`（新）：fetch + ReadableStream 手工解析 SSE（EventSource 只能 GET）；`ApiRequestError(503)` 走未接入引导；`StudyNoteRequestError(code)` 透传 SSE error
- `src/domain/studyNote/generate.ts`（新）：与 server 同口径的契约校验、`matchVocabularyContext` 语境回匹（word 字幕段命中记 context + segment_start；未命中不硬造）、`generateAndSaveStudyNote` 编排（完成即 upsert，status=ready）
- `src/domain/transcript/types.ts` / `store.ts`：`bilingual_notes` 由整段 string 升级为 `StudyNoteBilingualNote[]`；`StudyNoteVocabulary` 增 `segment_start?: number`
- `src/components/transcript/StudyNotePanel.tsx`（新）：生成入口 / 生成中进度（累加字符数 + 骨架屏）/ 四要素分区展示 / 词汇点按跳转（无 segment_start 降级为不可点徽标，title 说明原因）/ user_modified 重生成覆盖确认（Dialog）
- `src/components/transcript/MediaTranscriptImport.tsx`：字幕完成后挂载面板，新增 `seekToSeconds`（词汇跳转给的是段起点秒而非 index）
- `scripts/test_study_note_generate.ts`（新，30 断言）+ `package.json` test 链

**验证了什么**：前端四件套全绿——tsc 0 错 / `npm test` 16 套全过（新测试覆盖契约校验、回匹、SSE 全链路、503/invalid_payload/incomplete_stream 失败分类、二次生成覆盖幂等）/ build（PWA v1.3.0）/ check_pwa 10 项。server 三件套全绿——typecheck 0 错 / `node --test "dist/test/*.test.js"` 91/91 / build 通过。

**对冻结结论的三处修正（落地时发现，如实记载）**
1. **流式落库策略**：§2.2 曾冻结「生成期间节流更新 studyNotes」——单 JSON 契约下 partial 文本不可解析，节流写入只能存半截原文、无展示价值。改为**完成即写一次 upsert**；生成中进度只走内存态（delta 累加字数）。「中断恢复不做」的结论不变（刷新=重生成）。
2. **bilingual_notes 形态**：M1 建表时 `bilingual_notes: string` 是 LLM 未接的占位；M2 按「四要素拆开、独立可编辑」升级为逐句结构化数组 `{en, zh}[]`（Dexie v9 表结构未动，仅字段类型升级，无 upgrade 逻辑）。
3. **「脉冲逐字渲染」表述**：partial JSON 不可解析，无法逐字渲染结构化内容；生成中改为「已接收字符数 + 骨架屏」进度感知，完成即展示结构化学习稿。

**没什么没做**：① 真实 LLM 联调 smoke（需 AI 端点三值进 `server/.env` 后由你触发）；② M3 词库打通（词汇命中本地 dictEntries / 未命中标「AI 生成」）；③ 历史字幕列表 UI；④ SSE 心跳未加（本地联调场景，前置代理若闲断流再议）。

**需要你决策什么**：AI 端点三值（base_url / model / key）——`.env.example` 已有模板，真值按纪律只写 `server/.env`，值给我即可（或你自己填），随后跑一次真实生成 smoke。

### 7.1 真实 LLM 联调 smoke（2026-10-20，已补跑）

启动 `server`（真实 `.env`，AI 三值在位）后实测：
- **主路径**：POST /api/ai/study-notes（3 段英文对白）→ HTTP 200，总耗时 8.95s，618 个 delta + 0 error + 1 done；done.note 经**前端同款契约校验通过**（summary / bilingual_notes 3 条 / key_points 6 条 / vocabulary 6 条）。
- **回匹实况**：6 个词 5 个命中字幕段；`look forward to meeting` 未命中——LLM 给 lemma 形而字幕原文是 `looking forward to meeting`（字面子串匹配不到），**未硬造，如实留空**。这证实了回匹「查无此据就留空」的口径，也提示 M3 词库打通时词形还原（looking→look）是真实需求点。
- **错误路径**：空 body / segments 为空 → 400 + 统一 JSON 错误体（与前端 asrClient 解析口径一致）。
- smoke 期间顺带发现 8787 端口有残留旧实例（已杀重启）；PG 当时未启动，`/api/health` 报 `database:error`（诚实降级，AI 链路不碰 PG，未受影响）。

smoke 不改任何代码；结论：**M2 全链路真实环境可用**，「真实 LLM 联调 smoke」从遗留项移除。遗留仅剩 M3 词库打通（含词形还原需求）。
