# Phase 1 实施方案 · 音视频转字幕

> 2026-10-12 · 依据《AI学习工作台产品设计约束》《音视频转字幕 Agent 指令》《方向确认-AI学习工作台.md》（已按推荐默认值拍板）编制。
> 本文只做方案，**未开始编码**；按指令第三节，确认本方案后才动代码。

## 0. 范围锁定（拍板值）

| 项 | 口径 |
|---|---|
| 输入 | 视频 mp4 / mov / webm；音频 mp3 / wav / m4a。单文件，≤100MB（`ASR_MAX_FILE_BYTES` 可调） |
| 输出 | 会话内时间轴字幕 + 导出 TXT / SRT / VTT |
| 供应商 | 不绑定。只做 adapter 接缝（接口 + 路由 + 注册点），未配置时如实 503「转录服务未接入」 |
| 音频提取 | **不做**。按「供应商直接接收视频容器」设计 |
| 持久化 | **不落库**。不新增 Dexie 表、不新增 PG 表；Transcript 仅会话内 + 导出文件 |
| 命名 | 采集 `src/services/asr/`；业务与转换 `src/domain/transcript/`；HTTP `src/data/asrClient.ts` |

明确不做（防范围蔓延）：字幕编辑、批量文件、实时录音转写、任务恢复（刷新续传）、供应商实现、前端音频提取、任何 Phase 2+ 能力。

---

## 1. 当前架构分析（已对代码逐一核实）

**前端分层（与前提卡 §3 一致，实测无误）**

```
页面 src/pages/*.tsx          只调 domain 与 service/data 的公开 API
  ↓
domain src/domain/*.ts        业务规则；import @/data/dictClient + @/services/*（见 domain/dict.ts）
  ↓
service src/services/*/       平台能力（DOM/媒体），四件套结构：types.ts + web.ts + noop.ts + index.ts
  ↓
data src/data/*Client.ts      纯 HTTP：requestJson（超时 + AbortController + 非 JSON 防护 + 错误提取）
```

- 后端调用基址：`src/data/dictClient.ts` 的 `DICT_API_BASE = import.meta.env.VITE_API_BASE_URL ?? '/api'`；dev/preview 的 `/api` 由 `vite.config.ts` 代理到 `127.0.0.1:8787`（已配置，本方案不动）。
- **异步任务先例（照抄对象）**：PaddleOCR 全链路 = 提交 → 轮询 → 下载结果（`server/src/paddle/client.ts`、`server/src/ocr/pipeline.ts`、`server/src/routes/ocr.ts`）；前端轮询范式在 `src/pages/Import.tsx` 的 `pollScanJob`（2s × 30 次，超时抛错）。
- **「未接入」先例（照抄对象）**：`server/src/routes/translate.ts` 在 `translate.url === null` 时抛 `ApiError.serviceUnavailable('未配置 TRANSLATE_API_URL，翻译服务不可用')`；前端 `ScanImport` 用 `EmptyState` 明示「翻译服务未接入」，不造假译文。
- **存储现状**：OCR 任务落 PG `scan_records`（持久）。本阶段禁止建表 → 任务状态用**进程内 Map**（重启即丢），与「会话内」口径一致。
- 勘查备注：`src/services/` 下除前提卡 §3 所列四个外还有 `sync/`、`auth/`（账号同步能力，前提卡服务清单未列——既有文档缺口，非本次引入，按规矩只在交付说明指出、不擅自改前提卡）。本方案不复用它们。

**服务端分层**

```
routes/*.ts        createXxxRouter(deps) 工厂，统一挂 /api（app.ts）
http/*             errors(ApiError) / validate(readUuidParam) / rateLimit / upload(multer)
asr/（新增）        provider(接缝) / jobStore(内存) / normalize(纯函数) / service(编排)
types.ts            unknown 收敛守卫（asString/asNumber/isRecord）+ 响应类型 + 常量
index.ts            装配：loadConfig → 构造依赖 → createApp → listen
```

## 2. 可复用模块（不改，直接照 pattern 用）

| 模块 | 复用点 |
|---|---|
| `src/data/dictClient.ts` | `requestJson` 完整范式（超时/ AbortController / 非 JSON 防护 / 错误消息提取 / FormData）→ asrClient 照抄 |
| `src/services/ocr/{types,web,noop,index}.ts` | 四件套结构 + `pickFiles`（隐藏 input + focus 兜底 + hasDom 守卫）→ asr 采集服务照抄 |
| `src/pages/Import.tsx` | Tabs 页签、虚线上传区、`pollScanJob` 轮询、stage 文案、弱提示条（`bg-secondary/50`）、aria-label/title 范式 |
| `src/components/ui/*` | Button / Card / Tabs / EmptyState / ErrorState（不重复造） |
| `src/lib/textLang.ts` | `detectLanguage`（结果语言标注，可选） |
| `server/src/routes/{ocr,translate}.ts` | 路由工厂 + 503 未接入 + 限流挂载范式 |
| `server/src/http/{errors,validate,rateLimit,upload}.ts` | ApiError / readUuidParam / createIpRateLimiter / multer 工厂 |
| `server/src/paddle/client.ts` | 异步 job（提交/查状态/下载）结构，作为 provider adapter 的参照 |
| `scripts/test_*.ts`、`server/test/parsers.test.ts` | 前端 assert/eq 范式；服务端 node:test 范式 |
| `vite.config.ts` | `/api` 代理已就绪；`check_pwa.py` 不检包体积、只查 SW 路由与 precache 泄漏——新增页面不会卡体检 |

## 3. 新增模块设计

### 3.1 数据流

```
Import 页「音视频字幕」页签（/import?tab=media）
  └─ components/transcript/MediaTranscriptImport.tsx
       ├─ services/asr（pickMedia：选文件 + 扩展名/大小预校验，只碰 DOM）
       ├─ domain/transcript/transcribe.ts（编排：提交 → 轮询 → 取结果）
       │     └─ data/asrClient.ts（POST/GET /api/asr/*）
       ├─ domain/transcript/subtitle.ts（toTxt/toSrt/toVtt 纯函数）
       └─ lib/download.ts（Blob 下载）

服务端：
POST /api/asr/jobs（multer media 字段）→ routes/asr.ts
  ├─ provider === null → 503「未配置 ASR 供应商」
  ├─ asr/jobStore.ts（内存 Map + TTL 2h，lazy sweep）
  └─ asr/service.ts.submit → provider.submit（适配层）
GET /api/asr/jobs/:jobId → service.syncJob
  └─ provider.getStatus / fetchTranscript → asr/normalize.ts（供应商响应 → segments）
```

### 3.2 API 契约（前后端各自定义同名字段，联调用）

```
POST /api/asr/jobs      multipart/form-data：media（单文件）、language（可选，默认 auto）
  202 { jobId, status, error }        status 可能直接是 failed（提交即败）
  400 文件类型/大小不符      413 超限      503 未配置 ASR 供应商

GET /api/asr/jobs/:jobId
  200 { jobId, status, transcript, error }
  400 非法 UUID      404 不存在或已过期（TTL 2h）
```

核心类型（`src/domain/transcript/types.ts` 与 `server/src/asr/provider.ts` 字段对齐）：

```ts
export interface TranscriptSegment { start: number; end: number; text: string }  // 秒，允许小数
export interface Transcript { id: string; language: string; duration: number; segments: TranscriptSegment[] }
export type AsrJobStatus = 'queued' | 'running' | 'done' | 'failed'
export interface AsrJobError { code: string; message: string }
```

### 3.3 关键纯函数（单测主战场）

```ts
// domain/transcript/subtitle.ts
formatTimecode(seconds: number, sep: ',' | '.'): string   // HH:MM:SS,mmm；毫秒 = Math.round(seconds*1000)
toTxt(segments): string      // 每段一行
toSrt(segments): string      // 序号 / "HH:MM:SS,mmm --> HH:MM:SS,mmm" / 文本 / 空行
toVtt(segments): string      // "WEBVTT" 头 + "HH:MM:SS.mmm --> HH:MM:SS.mmm"

// domain/transcript/validate.ts
MEDIA_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.mp4', '.mov', '.webm']
MAX_MEDIA_BYTES = 100 * 1024 * 1024
validateMediaFile(name, sizeBytes): { ok: true } | { ok: false; reason: string }

// server/src/asr/normalize.ts（fixture = 测试夹具，非真实供应商响应；联调时按真实响应补样本）
normalizeProviderTranscript(raw: unknown): { language, duration, segments }
// 覆盖两种典型形态：A) { segments:[{start,end,text}] }（秒）  B) { results:[{sentences:[{start_time(ms),end_time(ms),text}]}] }（毫秒）
// 规则：三段字段齐全才成段；缺字段的丢弃并计数记日志，不编造不补全
```

### 3.4 编排与轮询参数（本阶段锁定值）

`domain/transcript/transcribe.ts`：`transcribeMedia(input, hooks)` → 提交 → 轮询 **3s × 100 次（5 分钟）** → done 返回 `Transcript`；failed 抛 `Error(error.message)`；503 原样透出「转录服务未接入」文案。超时文案：「任务仍在服务端处理，请稍后重新提交（结果不保留）」。OCR 的 2s×30 对长音视频不够，故放宽并写成常量，联调时按真实时长可调。

### 3.5 UI 状态机（MediaTranscriptImport.tsx）

`idle → picked → submitting → running → done`，分支：`failed`（ErrorState + 重试）、`not-configured`（503 → EmptyState「转录服务未接入」）。
结果区：媒体播放器（按扩展名选 `<audio>`/`<video>` + objectURL）+ 段落列表（`timeupdate` 高亮当前段、点段落 seek）+ 导出按钮组（TXT/SRT/VTT）。
诚实文案：结果仅存本次会话、刷新即丢；文件将上传至服务端转录。图标按钮均带 `aria-label` + `title`，触摸目标 ≥44px。

## 4. 修改文件列表（共 8 个，全部增量式）

**前端**

1. `package.json` — `test` 链末尾追加 `&& tsx scripts/test_transcript.ts`（第 12 套）。
2. `src/pages/Import.tsx` — 5 处小改，均增量：① `ImportTab` 联合类型加 `'media'`；② `?tab=` 白名单加 `'media'`；③ Tabs `items` 加 `{ key: 'media', label: '音视频字幕' }`（放在「音频」后）；④ 条件渲染加一行 `{tab === 'media' && <MediaTranscriptImport />}`；⑤ 顶部 import 新组件。不动其他三个页签任何逻辑。

**服务端**

3. `server/package.json` — `test` 脚本由写死的 `node --test dist/test/parsers.test.js` 改为 `node --test dist/test/`（目录自动发现；Node ≥22 支持）。
4. `server/src/config.ts` — `AppConfig` 加 `asr: { provider, baseUrl, apiKey, timeoutMs }`，全部 `optional()` 读取（`ASR_PROVIDER` / `ASR_API_BASE_URL` / `ASR_API_KEY` / `ASR_TIMEOUT_MS`，默认 120s）。缺失即 null → 503，与 translate 同构。
5. `server/src/types.ts` — 加 `ASR_MAX_FILE_BYTES`（100MB）、`ASR_JOB_TTL_MS`（2h）、`AsrJobResponse` / `AsrSubmitResponse` 响应类型。
6. `server/src/http/upload.ts` — **新增** `createMediaUpload(maxBytes)`（multer memoryStorage；MIME `audio/*`+`video/*`、扩展名白名单、字段名 `media`）。不改现有 `createImageUpload`。
7. `server/src/app.ts` — `AppDeps` 加 `asr: AsrService`；挂 `createAsrRouter`（限流 10 次/小时/IP，与公开 OCR 一致）。
8. `server/src/index.ts` — 装配 `resolveAsrProvider(config.asr)` + `new AsrService(...)` 传入 deps；文件头路由总表注释补两行。

## 5. 新增文件清单

**前端（11 个）**

| 文件 | 内容 |
|---|---|
| `src/services/asr/types.ts` | `PickedMedia`（file/name/mimeType/sizeBytes/kind）+ `AsrCaptureService` 契约 |
| `src/services/asr/web.ts` | `pickMedia()`：隐藏 `<input type=file accept=...>` + focus 兜底；只碰 DOM，不上传 |
| `src/services/asr/noop.ts` | 无 DOM 桩（复刻 ocr/noop） |
| `src/services/asr/index.ts` | driver 选择 + 导出（复刻 ocr/index.ts） |
| `src/data/asrClient.ts` | `submitAsrJob` / `fetchAsrJob`；自带 requestJson（照抄 dictClient，不重构它） |
| `src/domain/transcript/types.ts` | Transcript / Segment / AsrJobStatus / AsrJobError |
| `src/domain/transcript/validate.ts` | 扩展名 + 大小预校验（纯函数） |
| `src/domain/transcript/subtitle.ts` | TXT/SRT/VTT 转换（纯函数） |
| `src/domain/transcript/transcribe.ts` | 编排：提交 → 轮询 → Transcript；错误映射 |
| `src/components/transcript/MediaTranscriptImport.tsx` | 页签内容组件（状态机见 3.5） |
| `src/lib/download.ts` | `downloadTextFile(name, text)`：Blob + URL.createObjectURL + a.click（页面里直接写 Blob 下载已有先例：Import.tsx AudioRow） |
| `scripts/test_transcript.ts` | subtitle 转换（时间码/舍入/跨小时/空文本）+ validate 边界 + transcribe 错误映射（fetch 打桩） |

**服务端（6 个）**

| 文件 | 内容 |
|---|---|
| `server/src/asr/provider.ts` | `AsrProvider` 接口（submit/getStatus/fetchTranscript）+ `resolveAsrProvider(config)`：**Phase 1 恒返回 null**，注释写清接入时的 switch 骨架 |
| `server/src/asr/jobStore.ts` | `AsrJobStore`：Map + TTL lazy sweep；create/get/update |
| `server/src/asr/normalize.ts` | 供应商响应 → segments（纯函数，fixture 两种形态） |
| `server/src/asr/service.ts` | `AsrService.submit/syncJob` 编排；provider 为 null 时路由层已 503，此处不兜底 |
| `server/src/routes/asr.ts` | `createAsrRouter`：POST/GET 两个路由 + 限流 + readUuidParam |
| `server/test/asr.test.ts` | node:test：normalize（两种形态 + 缺字段丢弃）、jobStore（状态流转 + TTL 过期）、路由 503 冒烟（app.listen(0) + fetch） |

## 6. 风险点（按严重度）

1. **内存（高）**：multer memoryStorage 整文件进内存。100MB 上限 + 单文件 + 10 次/小时限流可控（本机可用 ~3GB）；并发大会压垮。缓解：上限 env 可调；磁盘临时文件/流式上传列为后续优化，本阶段不做。
2. **无供应商 → 端到端验不了（高，已知）**：「真实音频生成文本」等四项端到端验证必须等供应商接入。本阶段以 fixture 单测（normalize/subtitle）+ 503 冒烟 + 手工联调清单替代；交付说明如实写明「未做」。
3. **时间轴质量（中）**：供应商 segments 参差（中英混排、无标点、断句）。本阶段只透传 + 导出，不做校正；「时间轴随机检查」列入联调清单（对拍 3 段）。
4. **轮询时长（中）**：长音频转录可能超过 5 分钟轮询上限；任务在服务端 TTL 2h 内仍在，但无 jobId 恢复机制 → 超时即丢。文案如实告知；任务恢复列入后续。
5. **上传超时（中）**：provider 调用超时 `ASR_TIMEOUT_MS` 默认 120s；轮询 3s×100。两者在联调时按真实时长调整。
6. **微信 WebView（低）**：本阶段无摄像头/麦克风需求；`<input type=file>` 可用；`/api` 走代理，需后端同时在跑（既有联调前提）。
7. **测试链变长（低）**：`npm test` 追加第 12 套、server 测试改为目录发现——任一新测试失败即阻断四件套；新测试必须自包含绿。
8. **合规（低，Phase 1 不触发）**：用户媒体经服务端转交供应商，选型时须过目供应商数据条款；UI 弱提示明示上传事实。

## 7. 验证方案

**自动化（改完必跑，全绿才算完）**

```bash
# 前端（根目录）
npx tsc --noEmit                      # strict 全过（新增 11 个文件）
npm test                              # 12 套（新增 test_transcript.ts）
npm run build
python scripts/check_pwa.py           # 10 项；新增页面进主包，不涉数据路由，预期通过

# 服务端（server/）
npm run typecheck
npm test                              # 目录发现：parsers + asr
npm run build
```

**手工联调（后端 8787 与 preview 4174 必须同时在跑；预览端口固定 `--port 4174 --strictPort`）**

| # | 场景 | 预期 |
|---|---|---|
| A | 不配任何 `ASR_*`，选 mp3 提交 | 503 → 页面 EmptyState「转录服务未接入」，无假结果 |
| B | 接入首个 provider 后，真实 mp3 | segments 非空、duration>0；段落列表可点 |
| C | 导出的 SRT 载入 VLC/播放器 | 时间轴对齐；抽 3 段对拍原始音频 |
| D | 伪扩展名文件 / >100MB 文件 | 前端预校验 + 后端 400/413 双重拒绝 |
| E | 刷新页面 | 结果消失（会话内口径），文案已明示 |

**端到端四项（真实音频成文/真实视频提交/SRT 可加载/时间轴抽查）**：A–E 中 B/C 覆盖前三项，第四项即抽查；全部依赖供应商接入，列入供应商落地后的联调报告。

## 8. 交付与下一步

- 本方案交付物：本文档。编码前需你确认；确认后按 §4/§5 施工，完成后交《Phase 1 交付说明》（改了什么 / 验证了什么 / 还没做什么 / 需要决策什么）。
- 「还没做什么」预登记：供应商实现与端到端联调、字幕编辑、任务恢复、持久化（Phase 2 前拍板）。
- Phase 2 入口：字幕 → 学习稿（依赖 LLM 供应商，选型时一并评估）。
