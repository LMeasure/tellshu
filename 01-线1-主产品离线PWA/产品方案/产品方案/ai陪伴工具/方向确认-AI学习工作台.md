# AI 学习工作台 · 方向确认

> 2026-10-12 · 基于《AI学习工作台产品设计约束.md》《音视频转字幕 Agent 指令.txt》（Phase 1）与《产品前提卡-给协作方.md》逐条比对得出。
> 用途：拍板后即可进入《Phase 1 实施方案》。

## 结论

**方向可以确认。** AI 学习工作台的产品理念（AI 整理、用户确认、系统验证复习）与述树「记忆」内核一致；
分层架构、阶段开发、人机协作标注（ai_generated / user_modified）、结构化数据优先等约束均与前提卡兼容，无路线冲突。

**Phase 1（音视频 → 转录 → 时间轴字幕）可启动**，但有 1 个阻塞项 + 2 个口径问题需拍板（下文均附推荐默认值）。

---

## 一、与前提卡逐条对齐

| 工作台约束 | 前提卡依据 | 判定 |
|---|---|---|
| 页面层 → domain → service 分层 | §3 硬性规则 | 一致 |
| 禁止页面直调 MediaRecorder / getUserMedia / SpeechRecognition / AudioContext | 红线 4 | 一致；新增能力进 `src/services/asr/`（新文件，不越界） |
| 绝不编造数据、禁止模拟字幕 | 红线 1 | 一致；推论：无真实 ASR 接入前只能交付接口层 + 单测，不能演示假结果 |
| 第三方令牌只放后端 | 红线 7 | ASR 必须走旁路后端新增路由，前端零令牌 |
| 阶段开发、禁止提前实现后续阶段 | 约束第六节 ↔ Phase 1 指令第二节 | 一致 |
| 页面不直接 fetch，走 `src/data/dictClient.ts` | §3 | `/api/asr` 需同层新增 client（如 `src/data/asrClient.ts`） |
| 「修改数据库结构除非明确要求」 | Phase 1 指令第九节「不新增数据库/不设计永久数据表」 | 本阶段不落库，Transcript 仅会话内 + 文件导出；持久化留到 Phase 2 前拍板 |
| 验证命令 typecheck/test/build | 根 package.json 三个脚本都在 | 一致；⚠️ 指令第十节漏了前端第四件 `python scripts/check_pwa.py`，补上 |

## 二、需拍板的 3 件事

### 1. ASR 供应商选型（阻塞项）

现实约束（已逐一排除法）：

- **Web Speech API（SpeechRecognition）不能作为主路径**：只能实时麦克风输入，无法转录上传的音视频文件；无可靠时间轴；微信 WebView 对 Web Speech 的限制已有记录（V2.0 听书无声）。只能作为「实时录音转写」附加能力，且须诚实降级。
- **本地 Whisper（cpp/wasm）排除**：Phase 1 指令禁止下载大型模型；本机内存现状也跑不动大模型。
- **服务端 ASR API 是唯一可行主路径**：令牌按红线 7 进 `server/.env`，新增 `/api/asr` 任务路由（提交 + 查状态，避免长请求超时）。异步任务型供应商（阿里云录音文件识别、腾讯云 ASR）的轮询机制与 `server/src/paddle/client.ts` 的「异步 job 提交 → 轮询 → 下载」现成模式完全同构，可直接照搬。

**推荐默认值**：选一家服务端 ASR。按接口形态分两类：① **异步任务型**（阿里云录音文件识别、腾讯云 ASR）——提交后轮询任务状态，与 paddle 模式同构，首选；② **同步请求型**（OpenAI Whisper API）——上传后直接返回，需处理大文件分片与请求超时。service 接口按供应商中立设计，server 侧用 adapter 封装（与 paddle/client.ts 同思路），后续可切换供应商不改上层；两类都要确认能直接接受视频容器（省掉音频提取）。若有国内供应商偏好（备案 / 计费 / 网络可达性），告诉我，adapter 结构不用变。

### 2. 视频是否需要先「提取音频」

- 若供应商直接收视频（上述候选多数支持）→ **不需要服务端 ffmpeg**，指令第五节的「音频提取接口」可从 Phase 1 范围移除（指令同时禁止修改服务器环境，服务端并没装 ffmpeg）。
- 若选定供应商只吃纯音频 → 需要 ffmpeg（服务端没装，且禁止改环境）或 ffmpeg.wasm（大型依赖，指令禁止未经确认引入）。

**推荐默认值**：按「供应商直接收视频」设计，音频提取移出 Phase 1；`src/services/asr/` 预留音频提取的接口位置但不实现，等确有供应商需要时再议。

### 3. Transcript 持久化口径

- Phase 1 指令第九节明确「不新增数据库、不设计永久数据表」→ 本阶段不落 Dexie，Transcript 只在会话内存 + 导出文件（TXT/SRT/VTT 下载兜底）。
- Phase 2（学习稿）必须引用 transcript → 持久化（新增 Dexie 表，如 `transcripts: id/language/duration/segments/created_at/source`）需在 Phase 2 启动前拍板。性质是「新增表」不是「改现有表」，与词典扫描库新增四表、annotations 表同理。

**推荐默认值**：Phase 1 按指令字面执行（会话内 + 导出），Phase 2 前再定持久化。

---

## 三、无需拍板、可立即执行的项（不阻塞）

- Transcript 类型定义（指令第六节结构即最终形态：segments 带 start/end/text）
- SRT / VTT / TXT 生成与导出：纯函数 + Blob 下载，零新增依赖，可用 fixture 时间轴完整单测
- `src/services/asr/` 供应商中立接口定义
- server 侧 `/api/asr` 路由骨架 + adapter 模式（照搬 paddle/client.ts 的 job 轮询结构）
- UI 外壳：上传/进度/时间轴/导出（设计约束见下）

## 四、设计系统方向（Phase 1 UI 约束）

- **不新建设计令牌**，全部沿用前提卡 §4.1：`--primary 152 56% 40%`（草绿）、`--accent 33 96% 54%`（暖黄）、`--radius 1rem`；深色模式两套变量一起改。
- 新增组件模式（均可在现有 `src/components/ui/` 基础上扩展，不重复造）：
  - 媒体选择区（复用 Import 页上传交互）
  - 转录 job 进度（轮询 + 可取消，交互照搬 OCR 异步识别）
  - 时间轴字幕列表（段级点选高亮、当前段跟随）
  - 导出按钮组（TXT / SRT / VTT）
- 移动端优先：375px（`max-w-app`）、触摸目标 ≥44px、空态/失败走 `EmptyState`/`ErrorState`（ASR 未接入时如实显示「转录服务未接入」，不用假数据兜底）；图标按钮带 `aria-label` + `title`。

## 五、验证口径

- 前端：`npx tsc --noEmit` / `npm test` / `npm run build` / `python scripts/check_pwa.py`（指令第十节漏了第四件，补跑）
- server：`npm run typecheck` / `npm test` / `npm run build`
- 端到端（真实音频生成文本、真实视频可提交、SRT 被播放器加载、时间轴抽查）**必须等 ASR 接入后才能验**；接口层阶段用 fixture 单测覆盖 SRT/VTT 转换逻辑。

## 六、下一步

对上面 3 件事拍板（或直接回「按推荐默认值」）→ 输出《Phase 1 实施方案》（架构分析 / 可复用模块 / 修改文件清单 / 新增文件清单 / 风险点）→ 确认后开工。
