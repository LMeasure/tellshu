# Phase 1.5 — ASR Provider 实施方案（音视频转字幕 · 真实服务接入）

> ⚠️ **2026-10-17 已修订**：用户指令「使用我们自己的ASR工具」，Provider 改为**本地自建（faster-whisper small int8）**，本文腾讯云选型作废、仅作契约留存。新基线见《Phase1.5-ASR Provider方案修订-本地自建.md》。

> 依据《Phase1.5-ASR Provider接入指令》第三节输出；**未经方案确认，禁止编码**。
> 约束基线：① 用户拍板「不要因为接入 ASR 而重构系统」；② Phase 1 接缝（`server/src/asr/` + `src/domain/transcript/`）已就绪，本方案只在接缝内填充；③ 指令第二节范围：只做 Provider / Adapter / 真实转录 / 响应转换 / 端到端验证，不碰 Reader、OCR、词典、知识库。

---

## 0. 结论摘要

- **选定：腾讯云「录音文件识别（新）」v3 接口**（`https://asr.cloud-rtc.com/v3/`）。
- **核心理由（全部实证，非印象）**：① 本机网络探测只有腾讯云可达（OpenAI 连接失败、阿里云 ISI 端点连接失败，对照组百度/腾讯云/阿里云主站均正常）；② 本地文件 base64 直传（`source_type=1`）与 Phase 1 `submit(buffer)` 接缝同构，零基础设施新增；③ v3 明确支持 mp4/mov/mkv/webm 等视频容器直收，满足「按供应商直接接收视频设计、不做音频提取」；④ 任务状态 0/1/2/3 与现有 `queued/running/done/failed` 直射，不新增状态。
- **最大妥协：本地文件 ≤ 5MB（base64 编码后）**。更大文件只能走公网 URL 路径，那需要对象存储/公网托管——属于基础设施新增，**超出「不重构」约束，本方案明确不做**，留待后续阶段与持久化一起拍板。
- **改动面**：服务端 6 改 3 增；前端 2 改 0 增（limits 端点 + 上传预检）。Reader/OCR/词典/知识库/并行 convert 功能零接触；PG/Dexie 零建表；npm 零新增依赖。
- **另两家去向**：OpenAI Whisper 架构上最贴合但本机不可达 → 缓接（接缝保留，`providers/openai.ts` + 一个 switch case 即可复活）；阿里云只收公网 URL → 违反约束 → 排除。
- **需要你**：拍板 6 个决策点（均附默认值）；提供 SDKAppID + SecretKey 后才能跑真实音频集成测试。

---

## 1. 现状接缝确认（本轮代码实证，非照文档抄）

| 文件 | 现状（已实读） | 本方案是否动用 |
|---|---|---|
| `server/src/asr/provider.ts` | `AsrProvider{name, submit, getStatus, fetchTranscript}`；`resolveAsrProvider` 恒 `null` | **改**：switch 加 `tencent` case |
| `server/src/asr/service.ts` | submit→running 或 failed(202)；syncJob→done+normalize；媒体 buffer `finally` 置空 | **改**：submit 错误分类重抛；`providerMaxFileBytes` getter |
| `server/src/asr/normalize.ts` | 形态 A（`segments[]` 秒）/ 形态 B（`results[].sentences[]` 毫秒）；缺字段丢弃并计数 | **改**：+ 形态 C（腾讯云 v3） |
| `server/src/asr/jobStore.ts` | 进程内 Map + TTL 2h + 墓碑；记录字段全集 8 个（无媒体载体） | 不动 |
| `server/src/routes/asr.ts` | POST：202/400/413(100MB)/503；GET：200/400/404/410 | **改**：provider 上限 413 快检；+ `GET /api/asr/limits` |
| `server/src/config.ts` | `asr{provider, baseUrl, apiKey, timeoutMs}`，全 optional，缺省即 503 | **改**：+ `sdkAppId`；ASR 超时上限放宽 |
| `server/src/index.ts` | 装配期 `resolveAsrProvider(config.asr)` → `new AsrService(...)` | **不动**（接入实现零 wiring 改动） |
| `server/src/types.ts` | `ASR_MAX_FILE_BYTES`(100MB)、`ASR_JOB_TTL_MS` 等 | 视需要加腾讯云常量 |
| 前端 `MediaTranscriptImport.tsx` | 上传→轮询→只读字幕→导出 TXT/SRT/VTT（Phase 1 已就绪） | **改**：limits 接入 + 上限文案 |

---

## 2. Provider 选择理由（指令第五节：不凭感觉，输出依据）

### 2.1 本机网络实证（2026-10-12，部署机 = 本地旁路后端）

| 端点 | 探测结果 | 结论 |
|---|---|---|
| `api.openai.com/v1/models` | 连接失败（HTTP 000，2.1s，两次复测一致） | **不可达** |
| `asr.cloud-rtc.com/v3/describe_transcription` | HTTP 405（1.5s，GET 打到 POST 口的正常应答） | **可达** |
| `asr.tencentcloudapi.com` | HTTP 200（0.3s） | 可达（v2 旧接口） |
| `nls-slrs.cn-shanghai.aliyuncs.com` | 连接失败（HTTP 000，2.1s） | 不可达（且架构不符，见 2.3） |
| 对照组：`baidu.com` / `cloud.tencent.com` / `aliyun.com` | 200 / 200 / 403 | 探测有效，非假象 |

> 探测经本机 shell 执行；若服务端将来迁到境外主机，此结论需重测（届时 OpenAI 路线反优，adapter 隔离保证可切换）。

### 2.2 七维度对比（指令第五节要求的比较项）

| 维度 | OpenAI Whisper | 腾讯云 v3（选定） | 阿里云录音文件识别 |
|---|---|---|---|
| 本地 buffer 提交 | multipart 直传 ✓ | base64 `data` 直传 ✓ | **仅公网 URL**（官方文档明确「不支持提交本地文件」）✗ |
| 音频格式 | mp3/mp4/mpeg/mpga/m4a/wav/webm | mp3/wav/m4a/wma/aac/ogg/amr/fla | WAV/MP3/MP4/M4A/WMA/AAC/OGG/AMR/FLAC |
| 视频容器直收 | mp4 ✓（其余多需容器兼容） | **mp4/wmv/m4v/flv/rmvb/dat/mov/mkv/webm** ✓ | MP4 ✓ |
| 大小/时长 | ≤25MB/请求 | 本地 ≤5MB（base64 后）；URL ≤12h/1GB | 音频≤512MB，视频≤2GB，≤12h |
| 时间轴 | verbose_json `segments[]{start,end}`（秒） | `result_detail[]{final_sentence, start_ms, end_ms}`（毫秒）；`res_text_format` 0–2 带词级时间戳+标点 | 结果 sentences 毫秒级 |
| 中/英识别 | 99 语言，中英俱强 | 中文普通话/英语/粤语；`bigmodel` 大模型版多语种+语种参数 | 中英+方言，模型按项目配置 |
| 成本（官方页面实证） | whisper-1 $0.006/min；gpt-4o-mini-transcribe $0.003/min | 新版 AI 智能语音 **0.013 元/分钟**（≈0.78 元/小时）；旧版在线 1.75 元/小时 | **未检索到官方时价页面，不写数字** |
| 网络（本机实证） | 不可达 | 可达 | 端点不可达 |
| 接入复杂度 | Bearer + FormData，最简 | UserSig 自签（SDKAppID+SecretKey，有效期 86400s，每请求重签，node:crypto 约 50 行；官方有 Node SDK 但指令禁止业务代码直调第三方 SDK，故自签） | 需先建 OSS/公网托管 + 预签名 URL |
| 架构冲击 | 零（但网络一票否决） | **零**（source_type=1 路径） | **必须新增托管设施 = 违反本次约束** |

### 2.3 架构冲击筛选（用户红线）

- 腾讯云 `source_type=1`（data base64）→ 与 Phase 1 `submit(buffer)` 同构 → **零重构** ✓
- 腾讯云 `source_type=0`（url）/ 阿里云 `file_link` → 都要求「公网可下载的文件」→ 本服务端无公网入口、无对象存储 → 选任一都必须先建托管设施 → 出局
- OpenAI → 无设施问题，但网络不可达（实证）→ 缓接

### 2.4 结论

**腾讯云 v3**。状态机直射：

| 腾讯云 `status` | 含义 | 本系统状态 |
|---|---|---|
| 0 | 排队 | `queued` |
| 1 | 执行中 | `running` |
| 2 | 成功 | `done` |
| 3 | 失败（带 `error_msg`） | `failed` |

- **OpenAI 缓接说明**：接缝不动；未来 `server/src/asr/providers/openai.ts` + `provider.ts` 加一个 case 即可复活（其同步 API 需在 adapter 内后台任务化，属 adapter 内部细节，上层无感）。
- **阿里云排除说明**：唯一阻塞是「只收公网 URL」，与「不因接入 ASR 重构系统」直接冲突；时价未取到官方页面，不参与决策。

---

## 3. 接入流程（Adapter 设计）

### 3.1 落点（按指令第四节结构，适配现有代码）

```
server/src/asr/
├── provider.ts          （改：switch 加 tencent case）
├── providerError.ts     （增：AsrProviderError + kind→HTTP 映射）
├── providers/
│   └── tencent.ts       （增：TencentAsrProvider + buildUserSig）
├── service.ts           （改：submit 错误分类）
├── normalize.ts         （改：+ 形态 C）
├── jobStore.ts          （不动）
server/src/routes/asr.ts （改：413 快检 + GET /api/asr/limits）
server/src/config.ts     （改：+ sdkAppId）
server/src/types.ts      （ASR 类型按现状留在此，不新建 asr/types.ts）
```

### 3.2 时序（与 Phase 1 契约逐帧对应）

```
前端 POST /api/asr/jobs（media 单文件 + language 可选）
 → 路由校验：mime/扩展名/provider 上限（超限 413，先于任何网络调用）
 → service.submit → provider.submit：
     buffer > 5MB        → AsrProviderError('too_large')（本地预检，零网络调用）
     生成 request_id(UUID) + UserSig(SDKAppID+SecretKey)
     POST /v3/create_transcription
       { auth:{sdkappid, usersig, request_id},
         params:{ engine_model_type:'bigmodel', channel_num:1, res_text_format:2,
                  source_type:1, data:<base64>, data_len:<buffer.length>,
                  language:<仅用户指定时> } }
     body.code !== 0 或 HTTP 非 2xx → AsrProviderError 分类
     成功 → { providerJobId: transcription_id }
 → JobStore: queued→running；HTTP 202 返回
前端轮询 GET /api/asr/jobs/:id → service.syncJob → provider.getStatus：
     POST /v3/describe_transcription { auth, params:{transcription_id} }
     status 0/1/2/3 → queued/running/done/failed(3 带 error_msg)
 done → provider.fetchTranscript（describe 原始响应）→ normalize 形态 C → JobStore.transcript
媒体 buffer 生命周期不变：service.submit finally 置空；base64 字符串随 submit 调用栈释放，
JobStore 从不持有媒体（Phase 1 测试已断言字段全集，继续有效）。
```

### 3.3 错误映射表（指令第七节：不吞错误，统一格式）

| 场景 | kind | HTTP | 落点 |
|---|---|---|---|
| provider 未配置 | — | 503 | submit 抛错（Phase 1 既有） |
| 文件超 provider 上限（5MB） | `too_large` | **413** | submit 抛错 |
| 认证失败（HTTP 401/403 或 body 鉴权码） | `auth` | **401** | submit 抛错 |
| 无效/不支持文件（body 10004/10006/10002/10003） | `bad_file` | **400** | submit 抛错 |
| 供应商超时（AbortController，`ASR_TIMEOUT_MS`） | `timeout` | **504** | submit 抛错 |
| 供应商 5xx / 限流 / 网络错误 | `unavailable` | **503** | submit 抛错 |
| 未知异常（非 AsrProviderError） | — | 202 + `failed` 记录 | 保留 Phase 1 防御行为 |
| 轮询期失败 | 记录 `failed`（`code=provider_<kind>`，message 带可读原因） | 200 | 既有契约不变 |

### 3.4 Transcript 转换（指令第九节：provider 格式不进 domain）

供应商 `describe`（status=2）原始响应：

```json
{ "code": 0, "transcription_id": "tid-...", "status": 2,
  "audio_duration": 12.34, "result": "全文…",
  "result_detail": [ { "final_sentence": "句子一。", "start_ms": 20, "end_ms": 2380, "words": [] } ],
  "error_msg": "" }
```

`normalize.ts` 新增形态 C（纯函数，单测主战场）：

- `segments[] = { start: start_ms/1000, end: end_ms/1000, text: final_sentence }`（毫秒→秒，与形态 B 同规）；
- `duration ← audio_duration`（缺失则按段落最大 end 推导，现有规则）；
- `language ← 'und'`：供应商响应不含语种字段，提交时的 language 是请求参数，**不臆造进结果**；
- 丢弃规则同现有：缺字段 / `end<=start` / 空文本 → 计数，调用方记日志；
- `words[]` 等噪声字段忽略。provider 原始格式止步于 normalize，不进 `src/domain/transcript/`。

### 3.5 前端 limits（配合 5MB 妥协，见 DP-2）

- 新增 `GET /api/asr/limits` → `{ provider: 'tencent' | null, maxFileBytes: number }`（无 provider 时回全局 100MB）；
- `MediaTranscriptImport.tsx` 挂载时 fetch，用于文件选择器预检；fetch 失败回落现有常量；
- 目的：5MB 上限在 UI 明示，避免用户上传 30MB 视频后等待半天拿到 413。

---

## 4. 文件修改列表 / 新增文件列表

### 4.1 修改（服务端 6 + 前端 2，共 8）

| # | 文件 | 改动 |
|---|---|---|
| 1 | `server/src/asr/provider.ts` | `resolveAsrProvider` 按 `config.provider` switch，`case 'tencent'` 返回 `TencentAsrProvider`；文件头注释更新为「已接入腾讯云 v3」 |
| 2 | `server/src/asr/service.ts` | submit catch：`AsrProviderError` 按 kind 映射 `ApiError`(401/400/413/504/503) 重抛，未知错误保留 202+failed；syncJob catch 细化 `error.code=provider_<kind>`；+ `providerMaxFileBytes` getter |
| 3 | `server/src/asr/normalize.ts` | + 形态 C（腾讯云 v3 `result_detail`，见 3.4） |
| 4 | `server/src/config.ts` | `asr.sdkAppId`（`ASR_SDK_APP_ID`，optional）；`ASR_TIMEOUT_MS` 上限 300s→600s（仅 ASR 分支局部解析，**不动** `parseTimeout` 共享逻辑，不影响 OCR） |
| 5 | `server/src/routes/asr.ts` | submit 前按 provider 上限 413 快检（文案带供应商上限值）；+ `GET /api/asr/limits` |
| 6 | `server/.env.example` | + `ASR_SDK_APP_ID`；补注：v3 端点、5MB 本地文件上限、`ASR_API_KEY` 在此语境 = SecretKey |
| 7 | `server/test/asr.test.ts` | 「提交即败」用例改按分类契约（auth→401 等）；+ limits / 413 快检冒烟 |
| 8 | `src/data/asrClient.ts` + `src/components/transcript/MediaTranscriptImport.tsx` | + `fetchAsrLimits()`；组件挂载 fetch + 预检上限 + 5MB 文案 |

### 4.2 新增（服务端 3）

| # | 文件 | 内容 |
|---|---|---|
| 1 | `server/src/asr/providerError.ts` | `AsrProviderError extends Error{kind}` + `PROVIDER_ERROR_STATUS` 映射表（纯函数，单测覆盖） |
| 2 | `server/src/asr/providers/tencent.ts` | `TencentAsrProvider implements AsrProvider`：`buildUserSig`（node:crypto HMAC，无新依赖）+ create/describe + 错误分类 + 5MB 预检 |
| 3 | `server/test/asr_tencent.test.ts` | UserSig / 请求体形状 / 状态映射 / 错误分类 / normalize 形态 C / service 映射 / 路由冒烟（fetch 全打桩） |

### 4.3 明确不动（清单即承诺）

Reader / OCR / 词典 / 知识库 / 并行 convert 功能；前端主链路与路由；`JobStore` 结构与 TTL；PG 与 Dexie 零建表；`package.json` 零新增依赖（前后端都不加包）；平台 API 边界（令牌只进 `server/.env`）。

---

## 5. 风险分析

| # | 风险 | 等级 | 缓解 |
|---|---|---|---|
| R1 | **5MB 本地文件上限**：真实学习视频大多超限，只能转短音频/小片段 | 高 | UI 明示 + limits 预检 + 413 文案带上限值；根治需公网托管（下阶段，与持久化一起拍板，不塞进本期） |
| R2 | UserSig 自签正确性：官方只提供多语言 SDK，Node 自签无公开测试向量 | 中 | 实现首日用官方 Node SDK 对同输入交叉验证一次（一次性手工，不作为项目依赖），再锁单测（确定性 + request_id 敏感性 + 格式） |
| R3 | v3 字段细节未全量实证：`language` 在录音文件识别 create 是否支持、`res_text_format=3`（字幕场景）是否可用、鉴权失败 surfaced 为 HTTP 码还是 body code | 中 | §8 校准清单处理；分类表已同时覆盖 HTTP 码与 body code 两种形态 |
| R4 | 识别质量未实测：bigmodel vs 16k_zh_en、热词、语种参数效果 | 中 | 真实音频集成测试回答；`engine_model_type`/`res_text_format` 为集中常量，一行可切 |
| R5 | 费用：按音频时长计费，失败任务可能仍计费 | 低-中 | 5MB 本地预检 + 413 先行避免大部分无效计费；测试用小短音频（§6.2） |
| R6 | 幻觉/静音段（ASR 通用风险） | 低-中 | 导出后可人工校对；`dropped` 只统计缺字段段，不静默丢内容 |
| R7 | 任务有效期错位：供应商 24h vs JobStore 2h | 低 | 我们先过期，无冲突 |
| R8 | 网络环境变化：迁境外主机则 OpenAI 反优 | 低 | adapter 隔离，切换 = 新文件 + 一个 case |
| R9 | 供应商限流：提交 20QPS / 并发 200 | 低 | 路由限流 10 次/小时/IP，远低于 |

---

## 6. 测试方案

### 6.1 单元测试（fetch 全打桩，零真实调用、零费用）

- `buildUserSig`：同输入确定性输出；`request_id` 变则输出变；base64url 格式合法；过期时间戳合理（≈ now+86400s）
- `submit`：请求体形状断言（`auth.sdkappid/usersig/request_id` 非空；`params.source_type=1`、`data` 为 base64、`data_len=buffer.length`、`engine_model_type/res_text_format/channel_num` 正确）；5MB 预检时 **fetch 零调用**；`body.code!=0` → 正确 kind
- `getStatus`：status 0/1/2/3 → `queued/running/done/failed`；3 携带 `error_msg`
- `fetchTranscript`：status=2 原始响应透传（不做字段修剪）
- 错误分类：HTTP 401/403→auth；body 10004/10006/10002/10003→bad_file；AbortError→timeout；500/429→unavailable；fetch 抛网络错→unavailable
- normalize 形态 C：含 `words` 噪声的 fixture → 秒转换正确；`audio_duration`→duration；缺 `final_sentence`/`end<=start` → dropped 计数；空 `result_detail` → `segments:[]`
- service 映射：auth→路由 401；too_large→413；未知 Error→202+failed（回归 Phase 1 契约）；`GET /api/asr/limits` 返回体
- 状态机：queued→running→done 全链路（stub 依序返回 create→describe(1)→describe(2)）

### 6.2 集成测试（真实供应商；批准 + 提供密钥后执行，指令第十节）

- 素材：≤5MB 短音频 2 条（中文 1 条、英文 1 条，30–60s）。**成本控制**（指令第十一节）：合计 ≤2 分钟音频 ≈ 0.013 元/分钟 × 2 ≈ **0.026 元**
- 流程：真实文件 → 202 → 轮询至 done → 结果区只读展示 → 导出 TXT/SRT/VTT → SRT 载入播放器抽 3 处时间轴核对
- 记录模板（写进交付说明）：文件大小 / MIME / 时长 / 识别耗时 / 字符数 / dropped / 错误情况 / 费用估算
- 失败恢复：错误密钥跑一次 → 401 文案；>5MB 文件 → 413 文案

### 6.3 自动化验证（指令第十二节）

前端四件套（`npx tsc --noEmit` / `npm test` / `npm run build` / `python scripts/check_pwa.py`）+ 服务端三件套（`npm run typecheck` / `npm test` / `npm run build`）。server test 脚本已为 glob 形式（`node --test "dist/test/*.test.js"`），Node 22/24 双版本实证过，新增测试文件自动被发现。

---

## 7. 待拍板决策点（均附默认值；回「按默认值」即开工）

| # | 决策点 | 默认值 |
|---|---|---|
| DP-1 | Provider 选型 | **腾讯云 v3**（依据 §2） |
| DP-2 | 5MB 上限的处置 | **接受**；执行 limits 端点 + 前端预检 + 明确文案；大文件留待对象存储阶段 |
| DP-3 | submit 错误契约 | **按分类抛 HTTP 码**（401/400/413/504/503，指令第七节）；未知错误保留 202+failed |
| DP-4 | 环境变量 | **新增 1 个** `ASR_SDK_APP_ID`；`ASR_API_KEY` 复用为 SecretKey；`ASR_API_BASE_URL` 默认 `https://asr.cloud-rtc.com`；`ASR_TIMEOUT_MS` 上限放宽至 600s（仅 ASR） |
| DP-5 | 真实音频集成测试 | **需要你提供** SDKAppID + SecretKey（只写进 `server/.env`，不进文档/前端/日志）；未提供则只跑单测，交付说明如实写「未做」 |
| DP-6 | 引擎与格式参数 | `engine_model_type=bigmodel`、`res_text_format=2`、`channel_num=1`、`language` 仅在用户指定时透传；集中为常量，验证后可一行切换 |

---

## 8. 编码前最后校准（实现首日 15 分钟，结果写进交付说明）

1. 按官方文档核对 v3 `create_transcription` / `describe_transcription` 全字段名与取值（本文引用的字段以文档页 https://cloud.tencent.com/document/product/647/138785 与官方 TRTC-ASR SDK README 双源为准）；
2. 用官方 Node SDK 对同输入交叉验证 `buildUserSig` 输出；
3. 确认鉴权失败的真实 surfaced 形态（HTTP 码 vs body code），校准 §3.3 分类表；
4. 确认 `language` / `res_text_format` 在录音文件识别 create 的实际支持度，不支持则去掉对应入参（不影响上层）。

---

## 附：本方案与指令的对应

- 指令 §3 五件输出：Provider 选择理由（§2）/ 接入流程（§3）/ 文件修改列表（§4）/ 风险分析（§5）/ 测试方案（§6）✓
- 指令 §4 Adapter 模式：上层只依赖 `AsrProvider` 接口，业务代码不直调任何第三方 SDK ✓
- 指令 §6 配置：密钥只进 `server/.env` + `.env.example` 登记 ✓
- 指令 §8 任务状态：沿用 queued/running/done/failed/expired，不新增 ✓
- 指令 §9 转换：provider 原始格式止步 normalize，统一 Transcript segments[{start,end,text}] ✓
