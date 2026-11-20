# 述树 VPS 上线准备 · Phase 0.6 生产数据安全与可靠性设计

> 本文档承接 Phase 0（生产部署就绪审计）、Phase 0.5（生产部署架构设计与资源预算）、Phase 0.5-R（关键结论补证）。
> **纯只读审计 + 方案设计**，未对仓库源码 / 配置 / `.env` / Git / 服务器 / 数据库 / IndexedDB 做任何改动，也未写入任何真实密钥。所有配置草案均为占位示例。
>
> **当前运行时实测 = 无**：本轮未启动任何服务 / 进程 / Worker，无任何新运行时采集数据。所有「当前」结论均来自对当前工作区源码的静态复核（file:line 见正文）。
>
> 可信度标签（贯穿全文）：
> - **【当前源码验证】** 直接读当前源码 / 路由确认（含 file:line）。
> - **【当前配置验证】** 直接读当前配置文件确认。
> - **【历史实测】** Phase 0 / 0.5 / 0.5-R 已实测数字（检索时延、HNSW 体积、shared_buffers 等）。
> - **【源码推断】** 由源码结构合理推断但未逐条压测（如崩溃路径、孤儿风险）。
> - **【架构建议】** 本轮提出的修复 / 目标架构设计（尚未实施）。
> - **【估算】** 基于已知事实推算（增长率、磁盘占用）。
> - **【未证实】** 受环境限制无法确认，标注待查。
> - **【待产品决策】** 需产品侧拍板，不可擅自定案。

---

## 1. 执行摘要

Phase 0.5-R 已确认七类生产数据安全问题，本轮（Phase 0.6）对其做完整的架构审计、风险定级与修复设计。核心发现：

1. **身份认证完全缺失（最高优先级认知）**：系统当前**没有**任何真实用户账户 / 登录 / 会话 / 令牌机制。前端 `auth/web.ts` 是本地桩（随机 uuid 假 token，从不发往服务端）；服务端 `app.ts` 无任何用户鉴权中间件；全部业务表无 `owner_id`/`user_id` 列；管理员 `ADMIN_API_KEY` 仅守护词典入库一条链路。【当前源码验证】
2. **Convert 三个文件接口构成直接 IDOR（P0）**：`GET /api/convert/files/:fileId/download`、`GET /api/convert/tasks/:taskId/zip`、`POST /api/convert/tasks/:taskId/ocr` 仅凭随机 UUID 取文件 / 打包 / 提取文字，**零所有权校验**，任何持有 UUID 者皆可读他人结果。【当前源码验证】
3. **ASR sidecar 异常退出遗留孤儿进程（P0）**：spawn 无 `detached`，但 `main().catch→exit(1)` 与全局未捕获异常 / SIGKILL 三条路径均跳过 `shutdown()`，sidecar 不被回收 → 8177 被占、约 0.5GB 内存泄漏、systemd 重启 Node 后 health 门控永久失败 → 永久 503。【当前源码验证】
4. **ASR 任务态纯内存、重启即丢（P1）**：`AsrJobStore` 为内存 `Map`，Node 重启任务全失；`data/asr/out/*.json` 永不清理、且 Node 实际不走文件取结果（死写入）。【当前源码验证】
5. **文件生命周期普遍缺失删除 / 清理机制（P1）**：OCR 原图永久累积且 `store_failed` 分支留孤儿图；Convert Worker 删磁盘源文件但不删 `convert_files` 行（孤儿 DB 行），TTL 清理删结果磁盘但不删结果行；全仓无孤儿文件检测。【当前源码验证】
6. **开发模式静态托管暴露敏感文件（P1/P0 视部署方式）**：`app.ts:64` `express.static(path.join(__dirname,'..'))` 在 tsx 直跑 `server/src` 时根目录为 `server/`，会暴露 `server/.env`（含 `ADMIN_API_KEY`/`DATABASE_URL`/`PADDLEOCR_ACCESS_TOKEN`）与 `server/data/ocr`（用户上传原图）。【当前源码验证】

文档给出：接口矩阵（A1）、身份模型现状与三种访问控制方案（A2/A3）、统一文件资产清单（B1）、统一文件状态机与幂等删除（B2）、OCR/Convert/ASR 专项生命周期（B3–B5）、ASR 三方案架构比较（C2/C3）、DB-文件一致性草案（D）、备份恢复方案（E）、磁盘预算（F）、风险优先级（§11）、实施阶段（§12）、产品待决策（§13）、验收清单（§14）。**本轮止步于设计，不进入 Phase 0.7 或 Phase 1。**

---

## 2. 当前身份认证与访问控制现状

### 2.1 全仓文件相关接口矩阵（A1）

> 说明：「访问授权」一栏写**无授权校验**＝既无登录态校验，也无基于 owner/归属的 DB 过滤。已确认 `convertStore`/`repository`/`mediaStore`/`ocr/storage` 全部无 owner 字段。【当前源码验证】

| 模块 | 接口路径 | 方法 | 文件类型 | 当前认证 | 访问授权(所有权校验) | 风险 | 证据 file:line |
|---|---|---|---|---|---|---|---|
| OCR | `/api/ocr/material` | POST | 图片上传 | 无（仅 `OCR_PUBLIC_ENABLED` 开关） | **无授权校验** | 中-高：开启后匿名上传 + OCR 计费 | `routes/ocr.ts:35-66`；开关 `config.ts:166` |
| OCR | `/api/ocr/jobs/:scanId` | GET | 识别文本 | 无 | **无授权校验** | 中：凭 UUID 读他人图片文本 | `routes/ocr.ts:68-88` |
| Convert | `/api/convert/files/upload` | POST | 源文件 | 无（IP 限流 30/h） | **无授权校验** | 中：未认证上传 | `routes/convert.ts:149-181` |
| Convert | `/api/convert/tasks` | POST | 创建任务 | 无（IP 限流） | **无授权校验** | 中：凭他人 `fileId` 建任务 | `routes/convert.ts:183-212` |
| Convert | `/api/convert/tasks/:taskId` | GET | 任务状态 | 无 | **无授权校验** | 中：凭 UUID 看他人状态 | `routes/convert.ts:214-236` |
| Convert | `/api/convert/files/:fileId/download` | GET | **结果/源文件下载** | 无 | **无授权校验** | **高(IDOR)** | `routes/convert.ts:238-253`；`db/convertStore.ts:46-58` |
| Convert | `/api/convert/tasks/:taskId/zip` | GET | **结果打包下载** | 无（IP 限流） | **无授权校验** | **高(IDOR)** | `routes/convert.ts:256-301` |
| Convert | `/api/convert/tasks/:taskId/ocr` | POST | **结果转文字** | 无（IP 限流） | **无授权校验** | **高(IDOR)** | `routes/convert.ts:304-344` |
| ASR | `/api/asr/jobs` | POST | 音视频上传 | 无（IP 限流 10/h） | **无授权校验** | 中：未认证大文件 + 转录 | `routes/asr.ts:48-83` |
| ASR | `/api/asr/jobs/:jobId` | GET | 字幕轮询 | 无 | **无授权校验** | 中：凭 UUID 取他人字幕 | `routes/asr.ts:85-92` |
| Admin | `/api/admin/dictionary/scans` | POST | 词典页图片 | **ADMIN_API_KEY** | 无用户所有权（管理全局） | 中：单 key 即全量写权限，无用户隔离 | `routes/admin.ts:77-109`；`http/adminAuth.ts:10-31` |
| Admin | `/api/admin/dictionary/batches/:batchId` | GET | 批量状态 | **ADMIN_API_KEY** | 无用户所有权 | 中：同上 | `routes/admin.ts:111-133` |
| Dict/Sync | `/api/sync/dictionary` | GET | 增量同步 | 无 | 全局公开共享词库 | 低-中 | `routes/dictionary.ts:52-60` |
| Dict/Sync | `/api/search` `/api/dictionary/entries` | GET | 检索/词条 | 无 | 全局公开 | 低 | `routes/dictionary.ts:62-80` |
| AI | `/api/ai/study-notes` | POST | 学习稿(SSE) | 无（IP 限流 10/h） | **无授权校验** | 中：未认证计费 LLM | `routes/ai.ts:51-116` |
| Translate | `/api/translate` | POST | 文本翻译 | 无 | **无授权校验** | 低-中 | `routes/translate.ts:43-106` |
| Health | `/api/health` `/api/convert/health` | GET | 健康 | 无 | N/A | 低 | `routes/health.ts:19-34`；`routes/convert.ts:144-147` |
| 静态 | `/*`（根静态） | GET | 任意静态 | 无 | **无授权校验** | **高(开发模式)** 暴露 `server/.env` + `data/ocr` | `app.ts:64` |
| Discover | `POST /api/discover` 等 | — | 无文件 | 无 | 全局只读 | 低：仅向量检索，不提供文件上传/下载 | `api/main.py:348-593` |
| ASR sidecar | `GET /health` `POST /transcribe` `GET /jobs/{id}` | — | 磁盘路径转录 | 无（回环 127.0.0.1） | 内部 | 中：输入为本地路径，须严格仅回环 | `asr_service/app.py:71-105` |

**关键结论**：除 `/api/admin/*` 需 `ADMIN_API_KEY` 外，所有涉及用户文件的上传 / 读取 / 下载 / 轮询 / 结果获取接口均**既无用户登录鉴权、也无任何资源归属校验**。其中 Convert 三接口构成直接 IDOR。【当前源码验证】

### 2.2 身份模型现状（A2）

| 问题 | 现状 | 性质 | 证据 |
|---|---|---|---|
| 真实用户账户系统 | 无。前端本地桩，后端无 `app_users` 表、无 `user_id`/`owner_id` 列 | **仅设计/本地桩** | `auth/web.ts:10-49`；`app.ts:36-100`；`db/repository.ts`（全表无 owner）；`sql/001_init.sql`、`002_discover.sql`、`004_convert.sql` |
| 登录 / 会话 / Token | 本地 Dexie 会话 + 随机 uuid 假 token，**从不发往服务端** | **本地桩（非真实认证）** | `auth/web.ts:14-21,31-34`；`useAuth.ts:9-46`；前端无 `Authorization` 发送路径 |
| 数据归属 | 服务端零归属；IndexedDB `owner` 恒为常量 `'guest'`，不关联登录态 | **壳子/无意义** | `storage/web.ts:11,56-79`；`learning.ts:114,158,178`；`wordLearning.ts:31,318` |
| IndexedDB↔服务端身份 | 服务端无身份源，sync 远端是内存 `LocalSyncStub`（进程重启即清空） | **完全不关联** | `sync/remote.ts:16-33`；`sync/engine.ts:22-171` |
| 匿名/共享设备/多端同步 | 游客默认且非强制登录；同浏览器共享、无隔离；多端同步仅设计未落地 | **游客已实现；同步仅设计** | `StartLogin.tsx:93-105`；`AccountSection.tsx:15-32`；V1.2.9/V1.2.10 §2.4 |
| 管理员认证 | 仅守护词典入库，共享 Bearer 密钥，非 per-user 角色 | **已实现（共享密钥）** | `http/adminAuth.ts:10-31`；`routes/admin.ts:71-133`；`data/dictClient.ts:255-264,320-336` |

**诚实结论**：当前系统是「单浏览器本地 guest 模型 + 旁路服务端（词典/发现/转换/转录/翻译/学习稿）」。**没有任何可信的、跨设备一致的真实用户身份**，所有用户文件在服务端均以「任务 ID / 扫描 ID」标识，无 owner 维度。【当前源码验证】

### 2.3 访问控制模型比较与推荐（A3）

> **硬性要求（用户明确）**：UUID、随机文件名、不可猜测路径**不能代替**身份认证与访问授权。

| 维度 | 方案 A：单用户私有实例 | 方案 B：多用户账户体系 | 方案 C：维持现状 + 限制公网 |
|---|---|---|---|
| 身份验证 | 无（实例仅自己用） | Supabase Auth / 自建 JWT + `app_users` | 无（同现状） |
| 文件归属 | 实例所有者全部拥有 | `owner_id`(=sub) 关联 every 文件/任务/业务实体 | 无（任务 ID 隔离） |
| 文件下载授权 | 实例内任意 | 查询时 `WHERE owner_id = $sub` + RLS | 必须引入**能力令牌**（见下） |
| 跨用户访问防护 | 不适用（单人） | RLS + 复合外键（V1.2.5–1.2.10 已设计） | 能力令牌单次/短效，UUID 不再作为授权依据 |
| 会话失效 | 不适用 | 刷新令牌服务端存储、可吊销 | 不适用 |
| API 访问控制 | 反向代理层 IP/网络隔离 | 网关统一鉴权中间件 | 反向代理收敛 `/api/*` 仅内网/特定来源 |
| 迁移成本 | 极低（现状即用） | 高（V1.2.x 大量设计未实施：建表、补列、RLS、配额） | 低（仅加能力令牌 + 代理收敛） |
| 与现有架构兼容 | 完全兼容（guest 模型） | 需重构 Dexie `owner='guest'`→真实 sub、补表列 | 兼容（不改变存储模型） |

**推荐（分阶段）**：
- **近期上线（Phase 1）采用方案 A+C 混合**：维持 guest 模型，但 (1) Convert 三文件接口引入**签名能力令牌（capability token）**——任务创建时由服务端签发，下载/打包/提取必须携带且单次/短效，使 UUID 不再单独构成授权依据；【架构建议】(2) 反向代理（Caddy）收敛 `/api/*` 仅允许前端来源 + 内网，不向公网裸暴露；(3) 关闭开发模式静态托管隐患（见 §11 P0）。
- **中期（产品确认多用户后）迁移方案 B**：引入 Supabase/JWT + `app_users` + `owner_id` 列 + RLS（V1.2.x 已有成熟设计，本处不重复）。【架构建议】【待产品决策】

> 无论哪种方案，**能力令牌 / 会话令牌禁止存入 localStorage、禁止放入 URL 查询参数**（全栈专家红线）。【架构建议】

---

## 3. 文件资产清单（B1）

> 路径配置项真实命名（区别于历史报告口语）：`OCR_STORAGE_DIR`（默认 `data/ocr`）、`CONVERT_STORAGE_DIR`（默认 `data/convert`）、`ASR_DATA_DIR`（默认 `data/asr`）。【当前配置验证】【当前源码验证】

| 文件类型 | 产生模块 | 产生时机 | 实际存储路径 | 路径配置项 | DB 表.字段 | 用户关联 | 读取接口 | 删除接口 | 当前清理规则 | 异常残留风险 | 备份要求 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| OCR 原图 | `OcrPipeline.submit→saveImage` | 上传即落盘 | `OCR_STORAGE_DIR/<yyyy>/<mm>/<hex24><ext>` (`ocr/storage.ts:43-69`) | `OCR_STORAGE_DIR` (`config.ts:150,194`) | `scan_records.image_path` + `image_name/mime_type/size_bytes/page_number` (`001_init.sql:313-328`;`repository.ts:312,409`) | 无（仅自由文本 `source_book`/`batch_id`） | 无对外下载端点 | **无** | **无**（全仓无 unlink OCR 图） | 永久累积；`store_failed` 分支留孤儿图(`pipeline.ts:190-199`) | 定期备份（无回收无副本） |
| OCR 结果 | `pipeline.syncScanRow` | 任务 done/failed 归档 | **不落独立文件，仅存 DB** | 不适用 | `scan_records.result_text/raw_ocr_json/parser_rules/parsed_drafts` (`001_init.sql:330-334`) | 无 | `GET /ocr/jobs/:scanId` (`ocr.ts:68`) | **无** | 无（`scan_records` 行永久） | 行不可删不可清；`raw_ocr_json` 截断 20 条(`pipeline.ts:26,113`) | 随主库备份 |
| ASR 原始媒体 | `AsrService.submit→saveMedia` | 上传落盘 | `ASR_DATA_DIR/in/<jobId>/<safeName>` (`asr/mediaStore.ts:31-37`) | `ASR_DATA_DIR` (`config.ts:152,189`) | **仅内存 `AsrJobStore` Map，无 DB 行** (`asr/jobStore.ts:41-43`) | 无 | `GET /asr/jobs/:jobId` (结果；`routes/asr.ts:85`) | 终态 `removeMedia` 删目录 (`service.ts:82,90,109,133,143,154`) | 终态删 `in/` (`mediaStore.ts:40-47`) | Node 重启 `in/` 残留（Map 丢失，无人清理） | 不备份（可重传） |
| ASR 输出 JSON | sidecar `_persist` | 推理完成落盘 | `ASR_DATA_DIR/out/<jobId>.json` (`asr_core/job_queue.py:199-209`) | `ASR_OUT_DIR` (`config.ts`/sidecar env) | 无 DB 行 | 无 | 仅 sidecar `GET /jobs/{id}`；**Node 不走文件取结果** | **无** | **无**（全仓无 unlink `out/`） | **无限累积**（死写入，Node 不读） | 不备份 |
| ASR 转写文本 | Node `normalizeProviderTranscript` | 同步结果入库(内存) | 内存（经 HTTP 返回，不落盘） | 不适用 | 内存 Map `transcript` 字段 | 无 | `GET /asr/jobs/:jobId` | 随 Map TTL/`missing` | TTL 墓碑 (`jobStore.ts:93-103`) | 重启即失 | 不备份 |
| Convert 源输入 | `ConvertStore.createFile`+路由落盘 | 上传即写盘 | `CONVERT_STORAGE_DIR/<uuid>` (`convertStore.ts:30`；`routes/convert.ts:163-172`) | `CONVERT_STORAGE_DIR` (`config.ts:151,197`) | `convert_files.id/original_name/format/mime_type/size_bytes/storage_path` (`004_convert.sql:11-18`；`convertStore.ts:31-35`) | 无（仅 IP 限流） | Worker 内部 `db.get_source_path` (`db.py:106`)；**无用户下载端点** | Worker 任务完成后删磁盘 (`worker.py:52-60,113-115`) | Worker 删盘（非 TTL）；**DB 源行永不删** | **源 DB 行孤儿**（指向已删文件，下载 ENOENT `convert.ts:251`） | 不备份（处理后即删） |
| Convert 中间文件 | `worker.py` 调 Converter | 认领后 `storage_dir/<task_id>/` | `CONVERT_STORAGE_DIR/<task_id>/page_001.png` (`worker.py:81-85`) | 同上 | 中间态无 DB 行；成功登 `convert_files` | 无 | Worker 内部 | 失败 `_cleanup_outputs` (`worker.py:42-49`) | 失败清半成品；**空 `task_id` 目录不删** | 强杀可能漏清；残留空目录 | 不备份 |
| Convert 最终结果 | `worker.py` `commit_success` | 转换成功登记 | 同中间路径 `CONVERT_STORAGE_DIR/<task_id>/<name>` | 同上 | `convert_files` 结果行 + `convert_tasks.result_file_id/result_files` (`004_convert.sql:26,29`;`005_convert_result_files.sql:17`) | 无 | `GET /files/:fileId/download`、`GET /tasks/:taskId/zip`、`POST /tasks/:taskId/ocr` (`convert.ts:238-344`) | 无用户删除端点 | **TTL 仅删磁盘**：`cleanupExpiredResultFiles` (`convertStore.ts:151-208`)，默认 1h(`index.ts:39`)、每 10min(`index.ts:40`) | **结果 DB 行孤儿**（删盘不清行）；`task_id` 空目录残留 | 不备份（仅留 1h，须窗口内下载） |

**区分（用户要求）**：
- **仅内存**：ASR 转写文本、全部任务态。重启即失。
- **本地磁盘文件**：OCR 原图、ASR `in/` `out/`、Convert `源/中间/结果`。
- **数据库记录**：OCR `scan_records`、Convert `convert_files`/`convert_tasks`；ASR **无 DB 记录**。
- **可重新生成的中间产物**：Convert 中间 PNG（可由源重转）。
- **无法重新生成的原始用户资料**：OCR 原图、ASR 原始媒体、Convert 源输入（处理后已删，故源本身不可再生——这是风险点）。【当前源码验证】

---

## 4. OCR 生命周期设计（B3）

### 4.1 现状问题
- `scan_records.image_path` 存相对路径，图片写 `data/ocr/<yyyy>/<mm>/<hex24>.<ext>`，**全仓无任何删除 / 下载接口**。【当前源码验证】
- `pipeline.ts:190-199` 的 `store_failed` 分支：`saveImage` 已写盘但 `insertScan`/`paddle.submitJob` 失败时，磁盘已有孤儿图且 `image_path` 未入库 → 无法经 DB 追溯、无法清理。【当前源码验证】
- 图片是否可重生：**否**（用户上传原图，服务端不保留可重生成来源）。【当前源码验证】

### 4.2 设计（架构建议，待产品决策保留期）
1. **引入软删除 + 异步清理**：`scan_records` 增加 `deleted_at`(nullable)、`image_retained_until`(timestamptz)。删除走软删，由后台清理任务在 `image_retained_until` 后物理删 `data/ocr/...` 并置 `deleted`。
2. **用户删除 OCR 记录时处理原图**：软删记录 → 清理任务到达保留期后 `fs.rm` 原图（与 DB 行删除解耦，保证幂等）。
3. **修复 `store_failed` 孤儿**：`saveImage` 成功但后续失败时必须回滚删除已写图片（或登记为待清理孤儿，由孤儿检测任务回收）。
4. **历史兼容**：现有 `scan_records` 无 `deleted_at` → 迁移补列默认 NULL（视为未删）；现有图片无保留期 → 迁移时按产品给定默认保留期回填 `image_retained_until`，或标记为「永久保留待裁」。
5. **可选对外下载**：若产品需用户取回原图，新增 `GET /api/ocr/jobs/:scanId/image` 并**强制能力令牌 / 未来 owner 校验**，不复用裸 UUID。【架构建议】

---

## 5. Convert 生命周期设计（B4）

### 5.1 现状问题
- `convert_files` 与 `convert_tasks` 关系：源文件 `createFile` 插 `convert_files`(source) 行并写盘；`createTask` 插 `convert_tasks` 行引用 `fileId`；Worker 完成后插结果 `convert_files`(result) 行、更新 `result_file_id/result_files`。【当前源码验证】
- **源文件被 Worker 删除后 DB 行为何保留**：`worker.py:113-115` 在 `finally` 无条件 `os.remove(source_path)`，但无对应 `DELETE convert_files WHERE id=source` → 孤儿源行。【当前源码验证】
- **上传但没有创建任务的文件**：`createFile` 已插 `convert_files` 行并写盘；若用户不上 `POST /tasks`，则该行+盘文件成孤儿（目前无 TTL 回收源文件）。【当前源码验证】
- **成功/失败/取消/超时任务保留规则**：成功结果 TTL 1h 删盘；失败/取消/超时任务无清理，源与中间文件残留（失败 `_cleanup_outputs` 仅清中间，源仍留盘+行）。【当前源码验证】
- **下载结果过期后 DB 与磁盘一致性**：TTL `cleanupExpiredResultFiles` 删磁盘并清空 `result_files/result_file_id`，但**不删 `convert_files` 结果行** → 结果行悬空指针。【当前源码验证】

### 5.2 数据一致性修复设计（架构建议）
1. **删除即联动（事务 / 异步两阶段）**：删除 `convert_files` 行与 `fs.unlink` 磁盘必须在同一幂等流程中；推荐「DB 标记 `deleted_at` → 清理任务删盘 → 置 `purged`」，避免删盘成功但行残留。
2. **上传无任务孤儿回收**：源文件增加 `uploaded_at` + `claimed_task_id`(nullable)；清理任务回收「超过 N 分钟无 `convert_tasks` 引用」的源文件+行。
3. **Worker 删源同时删行**：`worker.py` `finally` 删盘后 `DELETE convert_files WHERE id=source`（或标记 `deleted_at`，交统一清理）。
4. **结果过期一致性**：TTL 清理改为「删盘 + 软删结果行（置 `deleted_at`）」，下载接口对软删行返回 410 而非 ENOENT。
5. **能力令牌授权（P0 修复）**：`POST /tasks` 成功时签发 `download_token`（HMAC 签名、短效、绑定 `taskId`/`fileId`）；`/download`、`/zip`、`/ocr` 必须校验该令牌，UUID 不再单独授权。【架构建议】
6. **空目录清理**：清理任务顺带 `rmdir` 空 `task_id` 目录。

---

## 6. ASR 生命周期设计（B5 + C1）

### 6.1 当前状态机（C1，file:line）
- 状态集（两侧同构四态）：`queued | running | done | failed`（`types.ts:201`；`asr_core/job_queue.py:39`）。
- Node 侧转移：`create→queued`(`jobStore.ts:51-65`)；`queued→running`(`service.ts:72-74`)；`running→done`(`service.ts:136-144`)；`running→failed`(`service.ts:76-91,128-135,148-156`)；`任意→expired` 墓碑(`jobStore.ts:93-103`)。【当前源码验证】
- sidecar 侧：`queued→running`(`job_queue.py:155`)；`running→done`+落盘 `out/<jobId>.json`(`job_queue.py:185-209`)；`running→failed`(`job_queue.py:147-183`)。【当前源码验证】
- **队列/claim/heartbeat/持久化**：两侧均**纯内存**（Node `Map` + sidecar `asyncio.Queue` 单 worker 串行），无 DB/Redis，无租约/心跳，重启全清；sidecar 重启后 Node `getStatus` 见 404 → 任务判 `failed` 提示重提（`local.ts:81-84`）。【当前源码验证】

### 6.2 生命周期事实
- **Node 如何 spawn**：`main()` → `resolveAsrProvider` → `LocalAsrProvider` 构造即 `new SidecarProcess().start()`（`index.ts:97`；`providers/local.ts:58-60`）。spawn **无 `detached`**（`sidecar.ts:39-58`）。【当前源码验证】
- **正常退出**：`SIGTERM/SIGINT` → `shutdown()` → `asrProvider?.close?.()` → `SidecarProcess.close()` SIGTERM 3s 后 SIGKILL（`index.ts:114-143`；`sidecar.ts:135-160`）。【当前源码验证】
- **异常退出（孤儿）**：① `SIGKILL` 杀 Node → 处理器不跑 → sidecar 留孤儿；② 未捕获异常 / unhandledRejection → `index.ts`/`sidecar.ts` **无全局处理器** → 进程直崩 → sidecar 留孤儿；③ `main().catch→exit(1)`（`index.ts:149-153`）**不调 `close()`**，而 sidecar 已 spawn → 崩溃即孤儿。【当前源码验证】
- **文件**：`in/` 终态清理（已做）；`out/*.json` **永不清理**（Node 不读，死写入）。【当前源码验证】

### 6.3 必须持久化 vs 可清理（设计结论）
- **必须持久化（建议）**：任务状态、归属（能力令牌/未来 owner）、原始媒体引用、最终结果文本 → 引入 `asr_jobs` 表（内存态迁入 DB），Node 重启后可恢复 / 重同步 sidecar。【架构建议】
- **可清理**：`in/` 媒体在终端态删（已做，保留期由产品定）；`out/*.json` 因 Node 不走文件，**改为完成后即删**（或干脆不写，仅经 HTTP 返回）。【架构建议】
- **原始媒体保留**：同 OCR，属不可再生用户资料，按保留期软删。【架构建议】

---

## 7. ASR 故障恢复架构比较（C3）

### 7.1 12 种异常场景（C2）当前行为

| # | 场景 | 当前行为 | 数据丢失 | 重复执行 | 永久卡住 | 推荐恢复 |
|---|---|---|---|---|---|---|
| 1 | Node 正常退出(SIGTERM) | `shutdown()` 关 sidecar | 无 | 否 | 否 | 现状 OK |
| 2 | Node 收 SIGTERM(正常路径) | 同 1 | 无 | 否 | 否 | 现状 OK |
| 3 | Node 收 SIGKILL | 处理器不跑，sidecar 孤儿 | 在途任务丢 | 可能（重启重提） | 否 | 补全局 handler 关 sidecar + 启动前清理 8177 |
| 4 | Node 进程崩溃(未捕获) | 无全局 handler，直崩，sidecar 孤儿 | 在途任务丢 | 可能 | 否 | 补 `uncaughtException/unhandledRejection`→`close()` |
| 5 | sidecar 自身崩溃 | `child.on('exit')`→`_markDead`(终态) | 该 sidecar 任务丢 | 否 | **是(永久 503)** | 方案二/三托管生命周期 |
| 6 | 8177 被孤儿占用 | Node 重启 health 门控失败→dead | 全部 ASR 不可用 | — | **是(永久 503)** | 启动前检测并清理占用进程 |
| 7 | Node 重启旧任务仍 processing | 内存 Map 空，旧任务视为不存在 | 旧任务丢 | 需重提 | 否 | 持久化 + 启动对账 |
| 8 | 任务完成但 Node 未收结果 | sidecar 写 `out/` 但 Node 轮询前崩 | 结果可能丢 | 重提 | 否 | 持久化落库 + 重启重拉 |
| 9 | Worker 已处理但未持久化 | 内存态，重启即失 | 丢 | 重提 | 否 | 落库 |
| 10 | 同一任务被重复领取 | 单 worker 串行，无多领取 | 无 | 否 | 否 | 现状 OK（单 worker） |
| 11 | 同一任务被重复执行 | 单 worker 串行 | 无 | 否 | 否 | 现状 OK |
| 12 | sidecar 重启后结果文件已存在 | Node 不读 `out/`，重提 | 结果丢 | 是(重提) | 否 | 落库去重 |

注：当前为单 worker 串行，故 10/11 不发生；一旦改多 worker/多实例（方案三）必须引入 claim 租约去重。【当前源码验证】【源码推断】

### 7.2 三方案比较

| 维度 | 方案一：Node 父子 + 补强 | 方案二：sidecar 独立 systemd | 方案三：独立 ASR Worker + 持久队列 |
|---|---|---|---|
| 故障隔离 | 弱（同进程组） | **强（OS 级独立单元）** | **最强（独立进程+队列）** |
| 自动恢复 | 需补 handler；SIGKILL 仍孤儿 | **systemd `Restart=on-failure` 自愈** | 队列 + Worker 自愈 |
| 任务持久性 | 需另引 DB（仍需改） | 需另引 DB | **天然（队列/DB 持久）** |
| 重复执行风险 | 低(单 worker) | 低(单 worker) | 需 claim 租约 |
| 资源管理 | Node 管内存，弱 | systemd 限内存/重启 | 最强 |
| 部署复杂度 | 低（改 Node） | **中（加 unit 文件）** | 高（队列+Worker+迁移） |
| 改造范围 | 中（handler+持久化+清理） | **中（去 spawn、加 unit、改端口发现）** | 大（重写任务模型） |
| 兼容性 | 高 | **高（仅停 spawn，HTTP 调用不变）** | 低（接口/模型重构） |

### 7.3 推荐
- **目标架构 = 方案二（sidecar 独立 systemd 服务）**。【架构建议】理由：以最小改造代价（移除 Node `spawn`、改 `asr_provider` 指向 `http://127.0.0.1:8177` 由 systemd 托管）彻底消除孤儿进程（systemd 拥有 PID，崩溃自动 `Restart`）与永久 503；故障隔离与资源管理显著优于方案一；比方案三成本低、兼容性好。
- **近期快速加固（Phase 0.8 可落地）采用方案一补强**：① `index.ts` 补 `process.on('uncaughtException'/'unhandledRejection')` 在退出前 `await asrProvider?.close?.()`；② `main().catch` 内显式 `close()` 已 spawn 的 sidecar（`index.ts:149-153`）；③ 启动前检测 8177 占用并清理；④ 清理 `out/*.json`；⑤ 引入 `asr_jobs` 表做状态持久化（为方案二/三铺垫）。【架构建议】

---

## 8. 数据库与文件一致性设计（D）

### 8.1 文件元数据字段（建议 `file_assets` 统一表，或扩展现有表）
`id`(uuid PK)、`kind`(ocr_image|asr_media|asr_out|convert_source|convert_result|convert_intermediate)、`owner_token`(nullable，能力令牌/未来 owner)、`storage_path`、`status`(created|uploaded|processing|completed|failed|expired|deleting|deleted)、`ref_task_id`(nullable)、`checksum`、\`size_bytes\`、`created_at`、`updated_at`、`expires_at`、`deleted_at`、`purged_at`。【架构建议】

### 8.2 关联与防错
- **关联用户/任务/业务实体**：当前无 owner → 过渡期用 `owner_token`（任务创建时签发，绑定 `ref_task_id`）；多用户落地后改 `owner_id`(=sub) + 复合外键（V1.2.x 已设计）。【架构建议】
- **防路径穿越**：现有 `sanitizeOriginalName`/`safeMediaName` 已清洗原始名、物理名用 UUID（`ocr/storage.ts`、`convertStore.ts`、`asr/mediaStore.ts`）→ 保留并单测覆盖。【当前源码验证】
- **防同名覆盖**：UUID 命名天然唯一，无覆盖风险。【当前源码验证】
- **防悬空引用**：下载/读取前校验 `storage_path` 文件存在；软删行返回 410 而非 ENOENT。【架构建议】
- **孤儿文件检测**：新增后台任务「目录遍历 ↔ DB 对账」：扫描 `data/ocr`、`data/asr/in`、`data/convert` 下文件，找出「无 DB 记录」的孤儿文件（删除或归档）；反向找出「有记录但文件缺失」的行（标记 `missing`）。当前**完全缺失该机制**。【当前源码验证】【架构建议】

### 8.3 幂等删除与并发
- 删除流程：`DELETE ... WHERE id=$1 AND status IN (completed,failed,expired) AND ref_task_id NOT IN (SELECT active)` → 置 `deleted_at` → 清理任务删盘 → `purged_at`。用 DB 事务 + `FOR UPDATE` 锁行，避免与运行中的 Worker 冲突（用户删除时 Worker 仍在运行：先软删、Worker 完成回写时检测 `deleted_at` 中止并清理）。【架构建议】
- **失败任务诊断信息保留**：`failed` 行保留 `error_message`/`error_code` 与原始请求引用，不立即物理删，便于排查（现有 `convert_tasks.error_message` 已有字段）。【当前源码验证】

### 8.4 迁移风险
- 新增 `file_assets` 表 + 现有表补 `deleted_at`/`owner_token`/`expires_at` 列；迁移须幂等（现有 001–005 风格）。
- 历史 `scan_records`/`convert_files` 无删除概念 → 补列默认值 NULL；`convert_files` 现有孤儿源/结果行需在迁移或后台任务中识别并软删。
- 不破坏现有 `convert_tasks.result_file_id` 外键语义。【架构建议】

---

## 9. 备份与恢复方案（E）

### 9.1 备份范围

| 内容 | 必须备份？ | 说明 | 证据/性质 |
|---|---|---|---|
| PostgreSQL（含 `scan_records`/`convert_files`/`convert_tasks` 及词典/发现表） | **必须** | 主数据，定期全量 + WAL | 【当前源码验证】表存在 |
| OCR 原图 `data/ocr` | **建议** | 不可再生、无回收；按保留期 | §3/§4 |
| ASR 原始媒体 `data/asr/in` | 视保留期 | 可重传；若保留则备份 | §6.3 |
| ASR 输出 `data/asr/out` | **否** | 死写入、可清 | §6.2 |
| Convert 源输入 | **否** | 处理后即删 | §3/§5 |
| Convert 结果 | **否（或窗口内）** | TTL 1h，须窗口内下载 | `index.ts:39` |
| 环境配置（不含密钥明文） | **必须** | `.env.example` + 非密配置；`.env` 密文单独管理 | 【架构建议】 |
| 模型文件 / 静态资源 | 否（可重下/重构建） | BGE-M3、whisper-small、前端 dist | 【历史实测】模型体积已知 |

### 9.2 备份策略
- **PG 每日全量 `pg_dump` + WAL 归档（PITR）**：当前 PG 为开发机 Windows、归档未配置（Phase 0 已记）；生产须开启 `archive_mode=on` + `wal_level=replica`。【历史实测】【架构建议】
- **文件增量备份**：`data/ocr` 每日 rsync/快照；仅备份未备份过的文件（按 `checksum`/mtime）。
- **异地备份**：PG dump + `data/ocr` 加密传异地（R2 / 大陆 OSS），保留 ≥ 2 份。
- **保留周期**：PG 30 天滚动 + 周/月归档；`data/ocr` 与业务保留期对齐。
- **加密**：备份加密（GPG / 对象存储服务端加密）；`.env` **绝不**明文进备份，改由密钥管理器 / 加密卷提供。
- **完整性校验**：备份后算 `sha256` 校验和并校验恢复可读性。
- **失败告警**：备份脚本非零退出即告警（区别于「命令成功即恢复」——见 §9.3）。【架构建议】

### 9.3 恢复演练（四种场景）

| 场景 | 恢复顺序 | 文件-DB 对齐 | 验证 | RPO / RTO |
|---|---|---|---|---|
| 1 PG 数据损坏 | 停服 → 最近全量 + WAL 前滚 → 校验行数/约束 | 重新链接 `data/ocr` 等文件路径 | `SELECT count(*)` 抽样 + 抽检 `image_path` 存在 | RPO 待定【待产品决策】；RTO 待压测【估算】 |
| 2 VPS 磁盘损坏 | 重建实例 → 恢复 PG → 恢复 `data/ocr` 快照 → 重建 dist/模型 | 同上 | 端到端冒烟（上传/下载/检索） | 同上 |
| 3 误删用户文件 | 定位备份时间点 → 仅恢复该文件/目录 → 对账 DB 行 | 恢复后跑孤儿检测 | 文件存在性 + DB 引用一致 | RPO 取决于备份频率【待产品决策】 |
| 4 版本升级失败回滚 | 保留上一版 dist + 上一版 DB 快照 → 停服回滚 → 迁移回滚脚本 | 版本化 `storage_path` 前缀避免混用 | 冒烟 + 回归 | RTO 待定【待产品决策】 |

> **红线**：「备份命令执行成功」≠「可恢复」。必须定期（季度）做真实恢复演练并记 RTO。【架构建议】
> RPO/RTO 当前**缺业务依据**，标记为【待产品决策】，不可擅自承诺。

---

## 10. 磁盘与存储预算（F）

> 原则：**不编造用户量/文件量/增长率**。无数据时给公式与待测指标。R2 私有迁移尚未实现，不当作现成功能。【当前源码验证】【估算】

### 10.1 空间构成（单 VPS）
- **模型固定占用**：BGE-M3 ONNX int8 ≈ 543MB；whisper-small int8 ≈ 461MB；合计 ≈ 1.0GB（Phase 0.5-R 已记）。【历史实测】
- **OS + 应用 + 依赖**：≈ 4–6GB（含 Node/Python/PG 程序、前端 dist）。【估算】
- **PG 数据 + `shared_buffers=2GB`**：当前数据量小；`shared_buffers` 常驻 2GB（Phase 0.5-R 已验证）。增长随词典/发现书/扫描记录。【历史实测】【估算】
- **用户文件（变量）**：
  - OCR 原图：`OCR_growth = N_users × uploads/day × avg_img_MB × retention_days`。当前**无清理 → retention_days→∞**，是最大不确定项。【当前源码验证】【估算】
  - ASR `out/*.json`：每任务约数十 KB–数 MB，无清理 → 线性增长。【当前源码验证】【估算】
  - Convert 结果：TTL 1h，常态接近 0；源处理后删。【当前源码验证】
- **日志**：结构化 JSON 日志，建议独立卷 + 轮转（logrotate），预留 5–10GB。【架构建议】【估算】

### 10.2 两档规划

| 项目 | 4C16G | 8C16G |
|---|---|---|
| 内存 | 16GB（Phase 0.5-R：稳态 ~7.8GB 上限估算和，余量充足） | 16GB（同，余量更宽） |
| **磁盘建议** | **120GB SSD 起步**（模型1G+OS6G+PG常驻2G+文件变量+日志10G ≈ 20G 基础，余给 OCR 增长） | **同 120GB，或 160–200GB**（若 OCR 保留期长/用户多） |
| OCR 增长容忍 | 需设保留期上限（否则 120G 数月内吃满） | 同，但缓冲更大 |
| 备份空间(异地) | ≈ 主数据 2–3× 滚动（PG+`data/ocr`） | 同 |
| 评估结论 | 低成本试运行候选（Phase 0.5-R） | 优先候选待压测（Phase 0.5-R） |

> 关键待测指标（上线前必须采集）：日均 OCR 上传数、平均图片体积、ASR 任务数、`out/` 单文件体积、Convert 峰值并发、日志日增量。【估算】【待产品决策】

### 10.3 对象存储评估
- **VPS 本地磁盘**：现状唯一落地方案，零开发；风险 = 单点盘损（须备份）。【当前源码验证】
- **R2 `shushu-private`**：设计未实现，仅 `shushu-public`（词库）已用。出海友好、大陆慢。【历史实测】【架构建议】
- **大陆 OSS**：大陆快；当前未接入。若面向中国大陆用户且文件量大，中期评估。【架构建议】
- 不把未实现的私有 R2 迁移当作现成能力。【当前源码验证】

---

## 11. 风险优先级

| 级别 | 编号 | 风险 | 证据 | 性质 |
|---|---|---|---|---|
| **P0** | R1 | Convert 三接口 IDOR 文件越权下载/打包/提取 | `convert.ts:238-253,256-301,304-344`；`convertStore.ts:46-58` | 【当前源码验证】 |
| **P0** | R2 | ASR sidecar 异常退出遗留孤儿 → 永久 503 | `sidecar.ts:39-58`；`index.ts:149-153`（跳过 close）；无全局 handler | 【当前源码验证】 |
| **P0** | R3 | 开发模式静态托管暴露 `.env` + 用户原图 | `app.ts:64`（`__dirname/..`）；tsx 跑 `server/src` 时根=`server/` | 【当前源码验证】（视部署方式，生产用 dist 则不触发，但须固化防回归） |
| **P1** | R4 | OCR 原图永久累积 + `store_failed` 孤儿图 | `ocr/storage.ts`（无删）；`pipeline.ts:190-199` | 【当前源码验证】 |
| **P1** | R5 | Convert 孤儿 DB 行（源/结果）致 ENOENT + DB 膨胀 | `worker.py:113-115`（删盘不删行）；`convertStore.ts:151-208`（删盘不清行） | 【当前源码验证】 |
| **P1** | R6 | ASR 任务态纯内存、重启即丢 | `asr/jobStore.ts:41-43` | 【当前源码验证】 |
| **P1** | R7 | ASR `out/*.json` 无限累积（死写入） | `asr_core/job_queue.py:199-209`；无 unlink | 【当前源码验证】 |
| **P1** | R8 | 无 DB-文件孤儿检测 | 全仓无目录↔DB 对账 | 【当前源码验证】 |
| **P1** | R9 | 无真实用户身份 / 访问控制模型未定 | §2.2 | 【待产品决策】 |
| **P2** | R10 | 上传无任务孤儿源文件无 TTL | §5.1 | 【当前源码验证】 |
| **P2** | R11 | 多实例/多 worker 时缺 claim 租约去重 | §7.1 注 | 【源码推断】 |
| **P2** | R12 | 备份未演练、RPO/RTO 未定 | §9.3 | 【待产品决策】 |

---

## 12. 实施阶段与依赖关系

```
Phase 0.6 (本) ──► Phase 0.7 ──► Phase 0.8 ──► Phase 0.9 ──► Phase 1
 审计+设计        产品安全模型    修复方案设计    实施计划+迁移   生产部署
                  与保留期确认    与技术评审      回滚设计
```

- **Phase 0.7 产品安全模型与数据保留规则确认**（依赖本报告的 §13 待决策项）：单用户 vs 多用户、游客是否保留、OCR/ASR/Convert 保留期、免费额度、管理员密钥治理。
- **Phase 0.8 修复方案设计与技术评审**：针对 R1–R8 出具体实现（能力令牌、静态托管固化、孤儿清理、ASR 状态持久化+方案一补强、孤儿检测任务、`file_assets` 表/列迁移）。建议**在 Phase 0.8 插入「P0 快速加固」**子阶段（R1/R2/R3 改动小、风险低、不依赖产品决策），先于等待产品拍板。
- **Phase 0.9 修复实施计划、迁移与回滚设计**：迁移脚本（幂等）、回滚脚本、灰度、压测（8C16G 峰值/并发）。
- **Phase 1 生产环境部署**：Caddy+TLS、systemd 编排（含 ASR sidecar 独立 unit，若采纳方案二）、备份 cron、健康检查、限流。

> 阶段划分调整建议：因 R1/R2/R3 为纯工程 P0 且**不依赖产品决策**，建议 Phase 0.8 内优先排「P0 加固」并尽早合入，避免与 Phase 0.7 产品决策串行阻塞安全上线。【架构建议】

---

## 13. 产品待决策事项

1. **单用户私有实例 vs 多用户账户体系？**（决定 §2.3 方案 A/C 还是 B，影响全部存储与鉴权）【待产品决策】
2. **OCR 原图 / ASR 原始媒体 / Convert 源输入的保留期各是多少天？**（决定磁盘增长与备份量，§4/§6/§10）【待产品决策】
3. **生产是否允许游客/匿名使用旁路服务？限额如何？**（当前游客默认，§2.2）【待产品决策】
4. **管理员 `ADMIN_API_KEY` 是否需轮换/审计/豁免业务配额？**（§2.2/§13.1）【待产品决策】
5. **免费额度具体数值？**（V1.2.10 红线：未做成本测算前不给具体值）【待产品决策】
6. **ASR 目标架构是否采纳方案二（独立 systemd sidecar）？**（§7.3）【架构建议】【待产品决策】
7. **RPO / RTO 业务目标？**（§9.3，缺依据不可擅定）【待产品决策】

---

## 14. Phase 0.6 验收清单

- [x] **A1** 全仓文件相关接口矩阵完成，标注认证/授权/风险（§2.1）。【当前源码验证】
- [x] **A2** 身份模型现状核实：无真实账户/登录/owner，admin 仅守护词典（§2.2）。【当前源码验证】
- [x] **A3** 三方案比较 + 推荐（能力令牌过渡 + 远期多用户）（§2.3）。【架构建议】
- [x] **B1** 文件资产清单（OCR/ASR/Convert 各类，区分内存/磁盘/DB/可重生/原始）（§3）。【当前源码验证】
- [x] **B2** 统一文件状态机与 10 种异常幂等删除设计（§3/§4/§5/§8.3）。【架构建议】
- [x] **B3/B4/B5** OCR/Convert/ASR 专项生命周期与一致性修复（§4/§5/§6）。【当前源码验证】【架构建议】
- [x] **C1/C2/C3** ASR 状态机、12 场景、三方案比较、推荐方案二（§6/§7）。【当前源码验证】【架构建议】
- [x] **D** 文件元数据表/列、关联、防穿越/覆盖/悬空、孤儿检测、幂等删除（§8）。【架构建议】
- [x] **E** 备份范围/策略/四种恢复场景/RPO-RTO（§9）。【架构建议】【待产品决策】
- [x] **F** 4C16G/8C16G 磁盘规划 + 公式与待测指标（§10）。【估算】
- [x] **风险定级** P0×3 / P1×6 / P2×3（§11）。【当前源码验证】
- [x] **实施阶段** 依赖关系 + P0 加固前置建议（§12）。【架构建议】
- [x] **产品待决策** 7 项列出（§13）。【待产品决策】
- [x] **可信度标签** 全文标注，且明确「当前运行时实测=无」（§首 + 各节）。

> **本轮（Phase 0.6）止步于审计与方案设计，未对任何系统/源码/配置/仓库/数据库/IndexedDB 做改动，未进入 Phase 0.7 或 Phase 1。请审核与授权。**
