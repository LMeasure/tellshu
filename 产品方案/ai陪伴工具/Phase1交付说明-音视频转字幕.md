# Phase 1 交付说明 · 音视频转字幕

> 2026-10-12 · 依据《Phase1实施方案-音视频转字幕.md》施工完成。
> 用户拍板的 5 条调整全部落实；供应商未接入，接口层与编排层全量交付，端到端联调待供应商。

## 1. 修改 / 新增文件列表

**新增 18 个**

前端（12）：

| 文件 | 内容 |
|---|---|
| `src/domain/transcript/types.ts` | Transcript / Segment / AsrJobStatus / 提交与轮询响应类型（与服务端字段对齐） |
| `src/domain/transcript/validate.ts` | 扩展名白名单 + 100MB 体积预校验（纯函数，与后端白名单一致） |
| `src/domain/transcript/subtitle.ts` | `formatTimecode` / `toTxt` / `toSrt` / `toVtt`（纯函数） |
| `src/domain/transcript/transcribe.ts` | 编排：提交 → 轮询 3s×100 → Transcript；错误映射 |
| `src/data/asrClient.ts` | `submitAsrJob` / `fetchAsrJob`；requestJson 范式 + `ApiRequestError`（带 HTTP status） |
| `src/services/asr/types.ts` | `PickedMedia` + `AsrCaptureService` 契约（四件套之类型） |
| `src/services/asr/web.ts` | `pickMedia()`：隐藏 input + focus 兜底；只碰 DOM，不上传 |
| `src/services/asr/noop.ts` | 无 DOM 桩 |
| `src/services/asr/index.ts` | driver 选择 + 出口 |
| `src/components/transcript/MediaTranscriptImport.tsx` | 页签内容组件：状态机 + 播放器 + **只读**字幕列表 + 导出 |
| `src/lib/download.ts` | `downloadTextFile`（Blob 下载，URL 延迟回收） |
| `scripts/test_transcript.ts` | 第 13 套前端单测（转换 / 校验 / 编排错误映射，fetch 打桩） |

服务端（6）：

| 文件 | 内容 |
|---|---|
| `server/src/asr/provider.ts` | `AsrProvider` 接口 + `resolveAsrProvider`（**Phase 1 恒返回 null**，附接入骨架注释） |
| `server/src/asr/jobStore.ts` | 进程内 Map + TTL 2h + lazy sweep + 墓碑（区分 404/410）；**无任何媒体字段** |
| `server/src/asr/normalize.ts` | 供应商响应 → segments（纯函数；秒/毫秒两形态；缺字段丢弃并计数） |
| `server/src/asr/service.ts` | `submit` / `syncJob` 编排；媒体 buffer 用完即在 finally 释放 |
| `server/src/routes/asr.ts` | `POST/GET /api/asr/jobs`；限流 10 次/小时/IP；400/404/410/413/503 |
| `server/test/asr.test.ts` | 第 2 套服务端 node:test（normalize 5 + jobStore 2 + 路由 7） |

**修改 10 个**（方案原列 8 个，实际多 2 个，原因见 §6）

| 文件 | 改动 |
|---|---|
| `src/pages/Import.tsx` | 5 处增量：类型联合 / `?tab=` 白名单 / Tabs 项 / 条件渲染 / import（不动其他页签） |
| `package.json` | `test` 链末尾追加 `&& tsx scripts/test_transcript.ts` |
| `server/package.json` | `test` 脚本改为 `node --test "dist/test/*.test.js"`（见 §6 节点名兼容实证） |
| `server/src/config.ts` | `AppConfig.asr`（ASR_PROVIDER / ASR_API_BASE_URL / ASR_API_KEY / ASR_TIMEOUT_MS 默认 120s，全部 optional） |
| `server/src/types.ts` | `ASR_MAX_FILE_BYTES`(100MB) / `ASR_JOB_TTL_MS`(2h) / ASR 响应与 Transcript 类型 |
| `server/src/http/upload.ts` | 新增 `createMediaUpload` / `mediaFileOf` / 媒体 MIME 与扩展名白名单（不改图片上传） |
| `server/src/http/errors.ts` | multer 两条错误文案改为与路由解耦的通用口径（原因见 §6） |
| `server/src/app.ts` | `AppDeps.asr` + 挂载 `createAsrRouter` |
| `server/src/index.ts` | 装配 `resolveAsrProvider` + `AsrService`；路由总表补两行 |
| `server/.env.example` | 登记 ASR_* 四个变量及「留空即 503」口径 |

## 2. 实际完成能力

- **采集**：导入页第 6 个页签「音视频字幕」（`/import?tab=media` 可直开）；单选 mp3/wav/m4a/mp4/mov/webm；前端扩展名 + 体积双重预校验。
- **提交与轮询**：`POST /api/asr/jobs`（202，multipart 单文件 `media` 字段 + 可选 `language`）→ `GET /api/asr/jobs/:jobId` 轮询（3s×100，5 分钟）；阶段文案「提交中…/排队中…/转写中…」。
- **结果展示（只读）**：按扩展名渲染 `<audio>`/`<video>`（objectURL，参与音频仲裁）；段落列表随 `timeupdate` 高亮、点段落 seek；语言/时长/段数元信息。
- **导出**：TXT（每段一行）/ SRT（逗码时间码）/ VTT（WEBVTT 头 + 点码），毫秒舍入、跨小时进位均有单测。
- **未接入口径**：`resolveAsrProvider` 恒 null → 503「未配置 ASR 供应商，转录服务不可用」→ 页面显示 EmptyState 空态引导，**不返回任何假字幕**（与翻译服务同口径）。
- **任务存储**：进程内 Map，只存 jobId/status/providerJobId/transcript/error/时间戳；TTL 2h，lazy sweep；重启即丢（与「会话内」口径一致）。
- **API 状态码**：202 提交（提交即败也返回 202 + status=failed，轮询一次即见原因）；400 字段/类型；404 不存在；**410 已过期**（墓碑保留一个 TTL 后降解为 404）；413 超限；503 未接入。
- **按调整落实的边界**：① 无字幕编辑/保存/学习稿/思维导图/卡片/测试系统任何入口；② 结果区只读；③ 媒体 buffer 仅在 `provider.submit` 调用期间存活，finally 置空，JobStore 结构上无媒体字段（测试断言记录字段全集）；④ 404/410 区分；⑤ 测试脚本节点兼容已实证（§3）。

## 3. 测试结果（七项全绿）

| # | 命令 | 结果 |
|---|---|---|
| 1 | 前端 `npx tsc --noEmit` | 0 错误（strict 全过，新增 12 个文件） |
| 2 | 前端 `npm test` | 13 套全绿；新增第 13 套 `test_transcript`（timecode 9 项 + 导出 7 项 + 校验 11 项 + 编排 8 场景，全部通过） |
| 3 | 前端 `npm run build` | 成功（10.31s；chunk 偏大警告为存量，非本次引入） |
| 4 | `python scripts/check_pwa.py` | 10 项通过（新页签进主包，不涉数据路由） |
| 5 | 服务端 `npm run typecheck` | 0 错误 |
| 6 | 服务端 `npm test` | **43/43 通过**（parsers 29 + asr 14；asr 覆盖 normalize 两形态/缺字段丢弃、jobStore 状态流转与 TTL 410/404、路由 503/404/410/400/202→200 done 全链路 + 媒体不进 Store 断言） |
| 7 | 服务端 `npm run build` | 成功，`dist/src/asr/` 与 `dist/test/asr.test.js` 产物齐全 |

**Node 版本兼容实证（调整 5）**：本机可用 Node 22.22.2（managed）与 24.17.0（system），server engines ≥22。
实测发现方案原写的 `node --test dist/test/`（目录参数）在 Node 22 下会把目录当模块加载，直接 `MODULE_NOT_FOUND` 失败；
改用 `node --test "dist/test/*.test.js"`（Node 内部 glob，cmd/sh 行为一致），**两个 Node 版本均实证通过**后才写进 package.json。

## 4. 未完成项（如实登记）

1. **供应商实现**：`resolveAsrProvider` 恒返回 null。接入首个供应商需在 provider.ts 补实现 + switch（骨架注释已写好），上层零改动。
2. **端到端四项全未做**：真实音频成文、真实视频提交、SRT 载入播放器、时间轴抽查——全部依赖供应商，方案中的手工联调清单 A–E 未跑（当前环境无可用 ASR 供应商）。
3. **413 超限的自动化用例**：构造 >100MB 测试 buffer 内存代价过高，未写；前端预校验 + 路由 backstop 代码路径在，联调时补。
4. **持久化 / 任务恢复**：不落库、刷新即丢为 Phase 1 既定口径；Phase 2 启动前拍板。
5. 方案 §7 手工联调表（A–E）待供应商接入后补跑并出联调报告。

## 5. 风险项

1. **内存（高）**：multer memoryStorage 整文件进内存；100MB 上限 + 单文件 + 10 次/小时/IP 限流可控，但并发上传会累积（本机可用内存常年 ~3GB）。磁盘临时文件/流式上传列为后续优化。
2. **无供应商即生产不可用（高，已知）**：当前所有提交都会得到 503；这是接缝交付的预期状态，不是缺陷。
3. **时间轴质量未验证（中）**：供应商 segments 原样透传（中英混排、断句、标点参差），无校正；联调时抽 3 段对拍。
4. **轮询上限（中）**：5 分钟轮询对长音频可能不够；任务在服务端 TTL 2h 内仍在但前端无 jobId 恢复，超时即丢（文案已如实告知）。
5. **并行任务共存（提示，非本功能风险）**：工作树同时并入了「格式转换」功能（convert 页签 + `/api/convert` 路由 + `004_convert.sql` 等，非本次改动）。本次与其在共享文件（Import.tsx / package.json / server 装配层）上干净共存，七项验证是**合并后整体**结果。另注意到 `server/src/index.ts` 路由总表注释未列 convert 路由（并行作者漏更），按规矩未代为修改，在此提示。
6. **微信 WebView（低）**：`<input type=file>` 与 `/api` 代理均为既有能力，未在微信内实测。

## 6. 与方案的两处计划外偏差（均有据可查）

1. **多改了 2 个文件**：`server/src/http/errors.ts`——原 multer 错误文案写死「超过 50MB 上限 / 字段名应为 images」，对 ASR 路由（100MB / media 字段）会误导用户，改为与路由解耦的通用口径（精确上限由各路由自己的预校验提示）；`server/.env.example`——登记 ASR_* 变量，与既有 TRANSLATE_* 同规格。
2. **`asrClient.ts` 未 1:1 照抄 dictClient**：① 定时器用 `globalThis.setTimeout`——tsx 跑单测时 `import.meta.env` 为 undefined 已实证，`window.*` 会直接 ReferenceError（dataClient 的头注释早有此结论，本次按其口径用可选链）；② 抛 `ApiRequestError` 带 HTTP status——UI 需要区分 503（空态引导）与常规失败（重试），dictClient 的裸 Error 做不到。dictClient 本身未动。
