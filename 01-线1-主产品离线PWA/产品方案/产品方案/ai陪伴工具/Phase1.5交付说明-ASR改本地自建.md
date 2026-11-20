# Phase 1.5 交付说明 · ASR 改本地自建（faster-whisper sidecar）

> 日期：2026-10-17 方案批准，2026-10-18 实施完成 · 对应《Phase1.5-ASR Provider方案修订-本地自建.md》。
> 5 个决策点全部按默认值执行：① small int8 ② 删除 tencent.ts ③ Node 自动 spawn
> ④ FastAPI + uvicorn ⑤ VAD 默认关。
> 腾讯契约未丢失：完整保留在《Phase1.5-ASR Provider实施方案.md》（原文件仅作契约留存）。

---

## 1. 修改 / 新增文件列表

**服务端（新增 6 / 修改 8 / 删除 1）**

| 文件 | 动作 | 要点 |
|---|---|---|
| `server/asr_service/`（10 个文件） | 新增 | Python sidecar：`app.py`（FastAPI：`POST /transcribe` / `GET /jobs/{id}` / `GET /health`）+ `asr_core/`（config/model/transcriber/upload/job_queue，从「语音识别」项目 v0.5.0 迁移适配）+ `requirements-asr.txt` + `README.md` |
| `server/src/asr/providers/local.ts` | 新增 | sidecar HTTP 客户端（fetch + FormData，可注入）；状态码→kind 错误分类 |
| `server/src/asr/sidecar.ts` | 新增 | spawn uvicorn 子进程 + health 门控（60s 宽限）+ 死亡终态（不自动重启） |
| `server/src/asr/mediaStore.ts` | 新增 | `data/asr/in/<jobId>/` 落盘与终态清理；JobStore 仍不持媒体 |
| `server/src/asr/service.ts` | 修改 | submit「写盘→传路径」；AsrProviderError→ApiError(503/400/504) 映射；终态清媒体 |
| `server/src/asr/provider.ts` | 修改 | `AsrSubmitInput` 改 `{filePath, fileName, language, nodeJobId}`（两侧同一 jobId 对账）；`resolveAsrProvider` 增 `case 'local'` |
| `server/src/asr/providerError.ts` | 修改 | 删腾讯 v3 数字码分类表与重试策略注释（本地形态注释替换） |
| `server/src/config.ts` | 修改 | `AsrProviderConfig` 改本地形状：`provider/pythonPath/modelDir/sidecarPort/sidecarTimeoutMs/sidecarLoadMs/dataDir/debugSaveRaw` |
| `server/src/types.ts` | 修改 | 删 `ASR_DIRECT_UPLOAD_LIMIT`、`AsrLimitsResponse`（本地无 5MB 直传限制） |
| `server/src/routes/asr.ts` | 修改 | 仅注释更新（100MB 产品上限 413 保留；无 limits 端点） |
| `server/src/index.ts` | 修改 | 装配显式传 `config.asr.dataDir`；shutdown 时 `close()` sidecar（防残留占端口+内存） |
| `server/.env.example` | 修改 | ASR 块重写：`ASR_PROVIDER=local` + venv/模型目录/端口/超时/dataDir/debug 附安装命令 |
| `server/package.json` | 修改 | 加 `asr:sidecar` 手动启动脚本（备查；默认路径是 Node 自动 spawn） |
| `server/.gitignore` | 修改 | 忽略 `asr_service/venv/`、`__pycache__/`、`nul`（保留设备名幽灵条目） |
| `server/src/asr/providers/tencent.ts` | **删除** | 330 行 UserSig 契约代码；其 `deflateSync` 误导入 bug（自 10-13 起 server typecheck 红）随之消除——**删除后 server typecheck 立即转绿** |

**测试**：`server/test/asr_local.test.ts` 新增 18 例；`server/test/asr.test.ts` 适配新接口并补终态清理断言。
**前端零功能改动**（`validate.ts` / `MediaTranscriptImport.tsx` 未动；100MB 上限本就是产品上限）。

---

## 2. 实际完成能力

```
浏览器 ──POST /api/asr/jobs──▶ Node (Express, :8787)
                                 │ multer memoryStorage → service.submit
                                 │ 落盘 data/asr/in/<jobId>/<原名>
                                 ▼
                         LocalAsrProvider ──POST /transcribe {path, job_id, language}──▶ sidecar (:8177)
                                 │                                                    · 模型常驻（small int8）
                                 │                                                    · 单推理串行队列（queued→running）
                                 │                                                    · PyAV 解码探测 → int8 推理
                                 │                                                    · canonical + 原子落盘 out/<jobId>.json
                           轮询 GET /jobs/<id> ◀──GET /api/asr/jobs/:jobId── 浏览器
                                 ▼
                    normalize.ts 结构校验/清洗 → JobStore → transcript 响应
```

- **canonical 直出**：sidecar 直接产出 `{language, duration, segments:[{start,end,text}]}`（与语音识别项目 `TranscriptionResult` 同构），`normalize.ts` 退化为结构校验 + 字段清洗。
- **串行队列**：内存约束下一次推理；排队任务如实 `queued`（与 JobStore 状态同构）。
- **诚实边界**：sidecar 未就绪/死亡 → 503「转录服务进程退出…」；坏文件/空文件/坏容器 → 400 明确原因；队列满 → 503；`/health` 未就绪不接收提交（不排队假任务）。
- **生命周期**：Node 启动 spawn sidecar（模型预加载）；Node 退出 SIGTERM 带走子进程；不自动重启（防崩溃循环），重启 Node 即恢复。

---

## 3. 真实音频集成验证记录（2026-10-18，本机，零成本全量真跑）

素材（spike 资产）：`jfk.flac`（真实英语 11s）、`zh_sample.mp3`（edge-tts 中文 10.2s）、`spike_video.mp4/mkv`（同源切片）。

| 验证项 | 结果 |
|---|---|
| sidecar 直连 · jfk.flac | done，`en`，11.0s，JFK 名言全文精确，2727ms（RTF≈0.25） |
| sidecar 直连 · zh mp3 | done，`zh`，10.18s，3 段时间轴正确，3125ms（RTF≈0.31） |
| sidecar 直连 · mkv（video 容器） | done，3 段一致，2131ms——PyAV 内置 ffmpeg 直收，无需系统 ffmpeg |
| **Node 全链路 · zh mp3** | 202→running→done；transcript 归一化正确；`in/<jobId>/` 终态已清；`out/<jobId>.json` 与 Node jobId 同名（对账一致） |
| **Node 全链路 · mp4** | 同上全过，`duration 10.24`，3 段正确 |
| Node 自动 spawn | Node 起 → sidecar 起（health 200，model_loaded=true，cpu/int8，vad=false） |
| sidecar 被 kill 后提交 | 503 `provider_unavailable`：「转录服务进程退出（code=1），请重启服务」；连提两次均 503（dead 是终态，不自动重启、不造假） |
| Node 退出后 | 8177 与 8787 端口均释放——sidecar 子进程被带走，无残留 |
| 错误路径（sidecar 层） | 410 文件不存在 / 415 容器白名单 / 400 空文件 / 503 重复 jobId / 404 未知 job / 截断文件→failed（`AudioDecodeError(EOFError)`，不返回空结果冒充成功） |

**识别质量记录（如实）**：专名「述树」被识别为同音「数数」——edge-tts 合成样本无上下文专名，属预期；small 档对真实口音/专业内容未测（见 §5）。

---

## 4. 测试结果（七项全绿）

| 项 | 结果 |
|---|---|
| server `npm run typecheck` | ✅ 通过（tencent.ts 删除后修复了 10-13 以来的红） |
| server `npm test` | ✅ **69/69**（原 51 + `asr_local` 18：spawn/env 纯函数、sidecar 状态机含「就绪后死亡」回归、错误分类、mediaStore 穿越清洗、service 映射） |
| server `npm run build` | ✅ 通过 |
| 前端 `npx tsc --noEmit` | ✅ 通过 |
| 前端 `npm test` | ✅ 通过（含 transcript 单测） |
| 前端 `npm run build` | ✅ 通过（PWA v1.3.0，precache 15 entries） |
| `python scripts/check_pwa.py` | ✅ 10 项通过 |

另：HEAD 快照经 git worktree 独立检出 + typecheck 通过（提交自包含、可编译）。
Git：`7fdc588`（sidecar）→ `4ac6957`（本地 provider）→ `1778d16`（测试+健壮性修复）。

---

## 5. 未完成项 / 开放项（如实登记）

1. **长音频未实测**：素材最长 11s；RTF≈0.25–0.31 外推 30 分钟视频 ≈8–16 分钟。3–5 分钟真实素材复测留待用户提供。
2. **真实用户素材抽验未做**：small 档对口音/专业内容的 WER 无数据；不够只能升 base（内存不允许 medium/large）。
3. **本机 venv 复用的是 spike 环境**（`shutree-asr`，faster-whisper 1.2.1 + av 18.1.0 + ctranslate2 4.8.3 + fastapi/uvicorn）；`server/asr_service/venv/` 标准位置未另建（README 有从零安装命令）。`.env` 的 `ASR_PYTHON_PATH` 指向该 venv。
4. **`.env` 已清理**：原腾讯 SDKAppID/SecretKey（从未使用过）已替换为 local 配置；`.env` 不进 git。
5. **前端可选容器仍六种**（mp3/wav/m4a/mp4/mov/webm，与 `validate.ts` 一致）：flac/mkv 在 sidecar 白名单内但前端选不了——属产品范围决策，未擅自扩大。
6. **`src/data/asrClient.ts` 未入库**：根 `.gitignore` 的 `data/` 规则（无前导斜杠）误伤整个前端数据层——既有仓库配置问题，建议改为 `/data/`（只忽略根级 data/），本次未动。
7. 集成 harness（FormData 提交→轮询脚本）是 `/tmp` 临时验证工具，未入库；相同覆盖已由 `asr_local.test.ts` 单测固化（打桩），真实音频链路靠 §3 记录。

---

## 6. 风险与已知边界

| 风险 | 等级 | 现状 |
|---|---|---|
| av 版本升级即炸 | 高 | requirements pin `av==18.1.0`（19 移除 `metadata_errors`，spike 实测 TypeError）；注释已写明 |
| 可用内存波动（0.5–2.5GB） | 中 | small int8 峰值 0.48GB 实测安全；**勿无脑切 medium/large** |
| sidecar 崩溃循环 | 低 | 不自动重启 + dead 终态 + 重启 Node 恢复；退出信号已接 |
| 2h 以上媒体 | 低 | JobStore TTL 2h；前端 100MB 上限内不常见 |
| 端口占用 | 低 | 8177 避开 8000/5173/4174/5432；Node 退出必带走子进程 |

## 7. 使用方式（协作者/AI 代理速览）

- **默认路径**：`server/.env` 配 `ASR_PROVIDER=local` + `ASR_PYTHON_PATH` → `npm run dev/start` 自动起全部。
- **从零部署 sidecar**：`server/asr_service/README.md`（venv 三行命令 + 模型 curl 直下 4 文件约 461MB，hf-mirror）。
- **手动调试**：`npm run asr:sidecar` 或 `python -m asr_core.transcriber <文件> --language auto`（CLI 直出 canonical JSON）。
- **排障**：`ASR_DEBUG_SAVE_RAW=true` 落盘 `data/asr-debug/<jobId>.json`（经 redactSecrets，绝不进 Transcript）。
- **换模型档**：替换模型目录即可（base↔small），零代码改动。
