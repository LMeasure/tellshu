# Phase 1.5 — ASR Provider 实施方案修订：腾讯云 v3 → 本地自建

> 日期：2026-10-17 · 修订触发：用户指令**「使用我们自己的ASR工具」**。
> 本文替换《Phase1.5-ASR Provider实施方案.md》（腾讯云 v3 选型）为新基线；腾讯契约在该原文中完整保留，需要时可原样重建。
> 《方向确认-AI学习工作台.md》第 35 行「本地 Whisper（cpp/wasm）排除」的结论**由本次用户决策推翻**（原排除理由：禁下载大型模型 + 内存跑不动；本次以实测数据逐条证伪/收敛，见 §1）。
> 约束基线不变：不因接入 ASR 重构系统；Phase 1 接缝（`server/src/asr/` + `src/domain/transcript/`）原样复用。

---

## 0. 修订摘要

- **Provider 改为本地自建**：faster-whisper（CTranslate2 推理，**无 PyTorch**）+ Whisper **small int8** 档；Node 服务旁挂一个 Python sidecar（模型常驻、串行队列），复用 Phase 1 的 `AsrProvider` 接缝与 JobStore。
- **已完成的腾讯云代码去向**：`providerError.ts`（通用错误分级）保留；`tencent.ts` 及 UserSig 算法建议删除；`provider.ts / config.ts / types.ts` 按本地形状重写（已在 Phase 1.5 前半改过一轮，二次改动量小）。
- **比腾讯方案更小的改动面**：无 5MB 直传限制、无密钥/UserSig、无供应商网络重试语义、无 `/asr/limits` 端点；前端 `validate.ts` / `MediaTranscriptImport.tsx` **零改动**（产品上限沿用既有 100MB）。
- **真实音频验证从「缺凭据只能写未执行」变为可全量执行**——本地推理零边际成本，flac/mp3/mkv/mp4 端到端可跑。
- **本机实测（2026-10-17 spike，全部一手数据）**：转录速度 ≈ 2 倍实时（RTF 0.43–0.74x），峰值内存 **0.48GB**，mp4/mkv 视频容器直收成功，中英文识别与段级时间轴正确。
- **需你拍板 5 个决策点（§9，均附默认值）**。

---

## 1. 可行性实测（2026-10-17，本机 spike，一手数据）

> 环境：Win11 / Ryzen 9 9955HX（16C/32T）/ 总内存 15.2GB（**可用 0.5–2.5GB 波动**，WorkBuddy 主程序+其服务常驻约 7GB）/ 磁盘余 141.8GB。测试音频：jfk.flac（真实英语 11s）、edge-tts 生成中文（10.2s）/英文（6.8s）、同源 mkv/mp4 切片。

| 项 | 实测结果 | 结论 |
|---|---|---|
| Python 环境 | 托管 Python 3.13.12 建 venv，`pip install faster-whisper==1.2.1` 一次通过 | 无需降级 3.12；ctranslate2 有 cp313 wheel |
| **PyAV 版本** | av 19.0.1 与 faster-whisper 1.2.1 不兼容（`av.open()` 已移除 `metadata_errors` 参数，转录直接 TypeError）；**av 18.1.0 参数仍在，工作正常** | requirements 必须 pin `av==18.1.0` 并注释原因 |
| 模型下载 | HF 官方站不可达（代理 502）；**hf-mirror.com 可达**；Xet 通道 401（hf-mirror 不代理）；**直接 curl 单文件 461.1MB / 3m03s 成功** | 模型获取走 hf-mirror 直下 4 个文件，绕开 hf_hub/Xet |
| hf_hub 缓存 | snapshot_download 落盘异常（blob 完整但 snapshot 全 0 字节，疑似失败残留占位） | 运行时**直载本地目录**（`WhisperModel(model_dir)`），不依赖 hf_hub 缓存 |
| 模型加载 | `server/data/asr-models/whisper-small/` 目录直载 **1.3–2.1s** | 常驻 sidecar 模式下无感 |
| 转录速度 | jfk.flac 5.2s/11s（RTF 0.47）；中文 5.1s/10.2s（RTF 0.51）；英文 3.5s/6.8s（RTF 0.52）；mkv 7.6s（RTF 0.74）；mp4 4.4s（RTF 0.43） | **≈1.4–2.3 倍实时**；30 分钟视频 ≈ 13–21 分钟 |
| 内存 | **峰值 RSS 0.48GB**（官方基准同配置 1477MB，本机实测远低）；可用内存 0.63GB 时仍正常完成 | **原「内存跑不动」结论对 small int8 档不成立**（对 medium/large 仍成立，见 §7） |
| 识别质量 | jfk 全文精确；中文流利句全文精确（专名「述树」被识别为同音「数数」——edge-tts 样本本身无上下文专名，属预期）；段级时间戳正确 | small 档满足字幕场景基础质量；专业内容需真实素材抽验（§7） |
| 容器直收 | flac / mp3 / **mkv / mp4** 全部直收，段结果与源一致 | PyAV 内置 ffmpeg，**无需系统 ffmpeg**（延续「供应商直收视频、不做音频提取」设计） |
| VAD | silero_vad_v6.onnx 随 faster-whisper wheel 打包（1.2MB） | 离线可用；默认关（§9 决策点 5） |

**方向文档「排除本地 Whisper」两条理由的当代判定**：① 「禁下载大型模型」——用户本次决策即授权，且只下载一次 461MB（small 档），之后完全离线；② 「内存跑不动」——对 medium/large 成立，对 small int8 不成立（峰值 0.48GB）。

---

## 2. 选型：为什么是 faster-whisper + small int8

| 候选 | 依赖体量 | 内存/本机可行性 | 中文+时间戳 | 视频容器 | 判定 |
|---|---|---|---|---|---|
| **faster-whisper（CTranslate2）** | 纯 pip，**无 PyTorch**，venv 约 500MB | 峰值 0.48GB 实测 | 段级时间戳原生，中英文实测可用 | PyAV 内置 ffmpeg，实测直收 | **选定** |
| FunASR / SenseVoice / PaddleSpeech | 拉 PyTorch ≈2.5GB+ | 本机可用内存 0.5–2.5GB 波动，装完即触顶 | SenseVoice 无原生段级时间戳（需额外对齐模型） | 需自行接 ffmpeg | 排除（依赖与内存双超） |
| transformers.js（Node 内推理） | onnxruntime-node，Node 零 Python | 同数量级内存 | 通用但长音频/分片/VAD 全要自己造 | 需自解 | 排除（工期与成熟度；Node 单项目诱惑大但不划算） |
| whisper.cpp | 需本地 C++ 编译或预编译二进制 | 小 | 好 | 需外挂 ffmpeg | 排除（Windows 构建链不可控） |

**模型档位**：默认 `small` int8（速度/质量/内存平衡点，已实测）；备选 `base`（更快更小，质量略降）——配置可切，换目录即可，不换代码。

---

## 3. 架构设计

```
浏览器 ──POST /api/asr/submit──▶ Node server (Express)
                                    │ 写文件 data/asr/in/<jobId>/<原名>
                                    │ JobStore(内存 Map, TTL 2h) 记 status
                                    ▼
                            LocalAsrProvider.submit()
                                    │ POST multipart (localhost)
                                    ▼
                            Python sidecar (FastAPI+uvicorn)
                              · faster-whisper 模型常驻（启动加载 2s）
                              · 单任务串行队列（并发>1 时排队）
                              · 解码(PyAV)→int8 推理→canonical JSON
                                    │ 写 data/asr/out/<jobId>.json
                                    ▼
浏览器 ◀──GET /api/asr/jobs/:id── Node(JobStore 轮询 → provider.getStatus/fetchTranscript)
```

**关键设计**：

1. **接缝零改动**：`AsrProvider` 接口不变；`resolveAsrProvider(config)` 增 `case 'local'`；JobStore、路由、前端链路全部沿用。
2. **文件不驻内存**：媒体落盘 `data/asr/in/<jobId>/`，Node 只传**路径**给 sidecar（避免 100MB buffer 再走 HTTP multipart 双份拷贝）；sidecar 结果写 `data/asr/out/<jobId>.json`，`fetchTranscript` 读文件。与 OCR/convert 的 storageDir 惯例一致。
3. **sidecar 返回 canonical 形态**：sidecar 是自有服务，直接产出 Phase 1 Transcript 结构 `{language, duration, segments:[{start,end,text}]}`——`normalize.ts` 从「解析供应商响应形态」退化为「 canonical 结构校验 + 字段清洗」，比腾讯形态 C 更简单。
4. **串行队列**：本机内存约束下，同时跑多个推理必然互相踩踏；sidecar 内部 asyncio 锁保证一次一个，其余排队（ queued → running）。这与 JobStore 的 queued/running 状态天然同构。
5. **生命周期**：Node 启动时 spawn sidecar 子进程（python 路径/模型目录/端口走 config），`/health` 就绪后才放行 submit；sidecar 未就绪/死亡 → 路由 503「转录服务未接入」，**不排队假任务**。不自动重启（防崩溃循环），重启 Node 即恢复。
6. **超时语义**（对原 5 条约束的本地化，见 §4）：submit 是入队（毫秒级）；status 查询毫秒级；Node→sidecar 的 HTTP 调用各自 10s 超时；真正的长耗时发生在 sidecar 内部，由异步 job + 轮询天然覆盖，**不存在长请求超时问题**。
7. **长任务边界**：2x 实时 ⇒ 30min 视频 ≈13–21min，2h 视频 ≈60min。JobStore TTL 2h 覆盖 ≤2h 媒体；UI 文案如实提示「本地转录速度约 2 倍实时，预计 X 分钟」。

---

## 4. 五条工程约束的本地化映射

| 原约束（腾讯语境） | 本地落地 |
|---|---|
| ① 5MB = `ASR_DIRECT_UPLOAD_LIMIT` 供应商直传限制，非产品永久限制 | **不适用**：本地无供应商直传通道。产品上限沿用前端 `MAX_MEDIA_BYTES=100MB`；删除 `ASR_DIRECT_UPLOAD_LIMIT` 常量与 `/asr/limits` 端点 |
| ② 日志禁输出 SecretKey / UserSig / Authorization | 本地**零密钥**（配置文件不含任何令牌）；`redactSecrets` 工具函数保留备用（debug 落盘路径仍经过它） |
| ③ Provider 原始响应 debug 保存、默认关、绝不进 Transcript | 保留同语义：`ASR_DEBUG_SAVE_RAW` 默认 false；local provider 的「原始响应」= sidecar 返回的完整 JSON（含 canonical segments），落盘 `data/asr-debug/`；Transcript 只认 canonical 字段展示，debug 文件不进数据流 |
| ④ 网络错误重试 2 次退避 1s/3s；业务错误 401/400/413 不重试 | 本地无供应商网络错误。仅保留两种情况：sidecar **未就绪** → 503 unavailable（不重试，诚实报错）；单次 HTTP 调用超时 → 10s AbortController（不重试——sidecar 是自有进程，超时即故障）。`AsrProviderError/kind` 体系保留，kind 收敛为 unavailable/unknown |
| ⑤ submit 30s / query 10s | submit = 入队（毫秒级，无 30s 需求）；status 查询毫秒级；Node→sidecar HTTP 统一 10s 超时（`ASR_SIDECAR_TIMEOUT_MS`）；模型启动加载给 60s 宽限（health 门控等待） |

---

## 5. 文件修改清单

**服务端（新增 4 / 修改 8 / 删除 1）**

| 文件 | 动作 | 要点 |
|---|---|---|
| `server/asr_service/app.py` + `requirements-asr.txt` + `README.md` | 新增 | FastAPI+uvicorn sidecar：`POST /transcribe`（表单含文件路径+jobId+语言）、`GET /jobs/{id}`、`GET /health`；串行队列；canonical JSON 输出；requirements pin `faster-whisper==1.2.1 / av==18.1.0 / ctranslate2==4.8.3 / onnxruntime / fastapi / uvicorn`，注释写清 av==18.1.0 的兼容原因 |
| `server/src/asr/sidecar.ts` | 新增 | spawn 子进程（`ASR_PYTHON_PATH -m uvicorn`）、health 等待（60s 宽限）、进程死亡标记不可用 |
| `server/src/asr/providers/local.ts` | 新增 | sidecar HTTP 客户端（原生 fetch+FormData，照 `paddle/client.ts` 模式）；错误映射 `AsrProviderError`；可注入 `fetchImpl` 供测试 |
| `server/data/asr-models/whisper-small/`（已在位，461MB） | 新增 | spike 已下载的模型 4 文件+vocab；**确认 `.gitignore` 不收**（data/ 目录整体忽略） |
| `server/src/asr/provider.ts` | 修改 | `resolveAsrProvider` 增 `case 'local'`（modelDir 存在即装配，否则 null→503）；接口移除 `maxDirectUploadBytes` |
| `server/src/config.ts` | 修改 | `AsrProviderConfig` 改本地形状：`{provider, pythonPath, modelDir, sidecarPort, sidecarTimeoutMs, debugSaveRaw}`；删除 `apiKey/sdkAppId/baseUrl/submitTimeoutMs/queryTimeoutMs` |
| `server/src/types.ts` | 修改 | 删 `ASR_DIRECT_UPLOAD_LIMIT`、`AsrLimitsResponse`；按需补 canonical 段类型 |
| `server/src/asr/service.ts` | 修改 | submit 改为「写盘→传路径」；错误映射沿用已写好的 `AsrProviderError→ApiError(PROVIDER_ERROR_STATUS[kind])`；providerName getter 返回 'local' |
| `server/src/asr/normalize.ts` | 修改 | 新增 canonical 校验形态（segments 数组守卫、start/end 数值清洗、language 校验）；**删腾讯形态 C 计划** |
| `server/src/routes/asr.ts` | 修改 | 删 413 provider-limit 预检、删 `GET /asr/limits` |
| `server/.env.example` | 修改 | ASR 块重写：`ASR_PROVIDER=local / ASR_PYTHON_PATH / ASR_MODEL_DIR / ASR_SIDECAR_PORT / ASR_SIDECAR_TIMEOUT_MS / ASR_DEBUG_SAVE_RAW`，附 venv 与模型下载命令 |
| `server/package.json` | 修改 | 加 `asr:sidecar` 手动启动脚本（备查）；server 自动 spawn 为默认路径 |
| `server/src/asr/providers/tencent.ts` | **删除** | UserSig 等约 330 行；契约在原方案文档可重建（决策点 2）。另：该文件自 2026-10-13 起带着 `deflateSync` 误从 `node:crypto` 导入（应为 `node:zlib`）的 bug，server typecheck/build 一直红着——**删除即修复** |

**前端（改 1 / 不动 2）**

| 文件 | 动作 | 要点 |
|---|---|---|
| `src/data/asrClient.ts` | 微改 | 仅修正过时 `ASR_TIMEOUT_MS` 注释；180s submit/30s poll 超时保留（本地语义下宽裕，无需调整） |
| `src/domain/transcript/validate.ts` | **不动** | `MAX_MEDIA_BYTES=100MB` 即产品上限，本就不需要 provider limits |
| `src/components/transcript/MediaTranscriptImport.tsx` | **不动** | sidecar 不可用时同样走既有 503→EmptyState「转录服务未接入」诚实路径 |

**测试**：新增 `server/test/asr_local.test.ts`（provider stub、normalize canonical 守卫、routes sidecar 未起 → 503 不造假、错误映射）；集成用真实音频跑端到端（flac/mp3/mkv/mp4 + 一段 3–5 分钟音频验证 RTF 与串行队列）。

---

## 6. 测试方案

1. **单元测试**（`npm test`，node:test，照既有风格）：local provider（stub fetch：提交/查态/取稿三段 + 错误分类）、sidecar.ts（spawn 与 health 的纯逻辑部分）、normalize canonical 守卫（脏 segments 丢弃不崩）、路由层（sidecar 未配置 → 503）。
2. **集成验证（本地免费，全量真跑）**：spike 同款四种容器端到端；额外一段 3–5 分钟音频验证 RTF≈0.5 与串行队列；sidecar 中途 kill → 状态如实 failed、不卡死。
3. **全套**：前端四件套（tsc/npm test/build/check_pwa）+ 服务端三件套（typecheck/npm test/build）。

---

## 7. 风险

| 风险 | 等级 | 缓解 |
|---|---|---|
| 可用内存波动（0.5–2.5GB，WorkBuddy 自身占 ~7GB） | 中 | small int8 峰值仅 0.48GB，实测安全；**配置锁 small**，medium/large 无脑切换会炸（决策点 1） |
| 长音频耗时（2x 实时，2h 视频 ≈60min） | 中 | JobStore TTL 2h 覆盖 ≤2h；UI 文案给预计耗时；超出 2h 的媒体在前端 100MB 上限外本就不常见 |
| 识别质量对专业/口音内容未测 | 中 | 交付前用真实用户素材抽验并如实记录 WER 表现；不够则升档（受内存约束，只能 small↔base） |
| PyAV 19 不兼容 | **已实证** | requirements pin `av==18.1.0` + 注释；CI 无，靠单测里的解码冒烟 |
| hf-mirror 可用性是「当前」事实 | 低 | 模型落盘后永久离线；交付说明记录下载命令 + 校验和；换源只影响首次安装 |
| Windows 子进程管理（spawn/日志/死亡） | 低 | spawn 失败即不可用 → 503；探针 health 门控；不自动重启防崩溃循环 |
| sidecar 串行队列下多用户场景 | 低 | 本机单人使用定位；队列状态在 UI 已如实显示 queued |
| PG 18 + sidecar 同机内存竞争 | 低 | 峰值 0.48GB + PG ~0.6GB，总量可控；实测可用 0.63GB 时仍跑通 |

---

## 8. 成本记录

- **边际成本 0**：无任何 API 调用、无供应商账单。
- **一次性成本**：模型 461MB 下载（hf-mirror，3–4 分钟）；venv 依赖约 500MB。
- **计算成本**：本机 CPU，约 2 倍实时（Ryzen 9 9955HX，16 线程）。
- **对比**（同等 30 分钟视频）：腾讯云 0.013 元/min ≈ 0.39 元/次；OpenAI $0.006/min ≈ 0.43 元/次（且本机不可达）；**本地 0 元**。
- **代价**：质量上限锁 small 档（大模型内存不允许）；速度受 CPU 约束。

---

## 9. 决策点（待你拍板，均附默认值）

1. **模型档位**：默认 `small` int8（推荐，已实测）；备选 `base`（更快、内存更小，质量略降）。
2. **tencent.ts 去向**：默认**删除**（推荐——用户已明确转向，且该代码无凭据从未真跑过；契约在原方案文档完整可重建）；备选保留为 `ASR_PROVIDER=tencent` 可选分支。
3. **sidecar 启动方式**：默认 **Node 启动时自动 spawn + health 门控**（推荐，用户一条命令跑全部）；备选像 PG 一样独立 `npm run asr:sidecar` 手动起。
4. **sidecar 技术栈**：默认 FastAPI + uvicorn（推荐，multipart/并发/文档开箱即用，依赖约 15MB）；备选 Python 标准库 http.server（零依赖，手写 multipart，代码量翻倍）。
5. **VAD 过滤**：默认**关**（推荐——whisper 自身分段已满足字幕场景，开 VAD 多一次 onnx 会话与调参面）；备选开（对含大量静音/音乐的素材分段更干净，配置可切）。

> 拍板后（或回复「按默认值执行」）即进入编码：先 sidecar（Task #12）→ 本地 provider 替换（Task #13）→ 测试与全套验证（Task #9）→ 交付说明（Task #10）。

> ✅ **2026-10-18 已交付**：5 个决策点全部按默认值实施完毕，真实音频集成验证通过（zh mp3 / mp4 端到端 RTF 0.25–0.31），七项验证全绿（server 69/69 测试）。交付记录见《Phase1.5交付说明-ASR改本地自建.md》。
