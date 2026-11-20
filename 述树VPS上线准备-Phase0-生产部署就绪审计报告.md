# 述树（tellshu.com）VPS 上线准备 · Phase 0 生产部署就绪审计报告

> 审计性质：**只读审计**。未购买 VPS、未配置 DNS/CDN/R2/生产数据库/HTTPS，未部署。
> 本报告仅基于**实际代码、配置、文档**给出结论；凡无法核实处一律标注「待核实」。
> 审计时间：2026-11-03。审计范围仓库：`C:\Users\lagom\WorkBuddy\2026-10-02-10-40-40\shutree\述树交付包\`（含 `src/`、`server/`、`api/`、`bge-m3-onnx/`、`scripts/`、`data/` 等）。
> 约束遵守：未执行 git add/commit/reset/clean/stash/checkout，未改源码/配置/环境变量，未装依赖/启停服务/迁移数据库/连真实库/上传文件/调真实服务，未泄露任何密钥。

---

## 〇、审计前置记录（Git 状态，只读快照）

| 项 | 值 | 证据 |
|---|---|---|
| HEAD | `760e999f785797e8b008943aca1809964686cc15` | `git log -1` |
| HEAD 提交信息 / 时间 | “A5-1 响应式布局改造验收交付报告（最终归档）” / 2026-11-02 | `git log -1` |
| 暂存区（staged） | **6 个文件**（B12 阶段工作，非本次任务）：`B12-*.md` ×4、`api/b12-phase-b-verify.py`、`reports/stage-b12-overview.md` | `git diff --cached --name-status` |
| 未暂存修改（unstaged） | **51 个文件**，含大量 `src/` 改动、`vite.config.ts`（+45 行）、`产品前提卡-给协作方.md`（-931 行）、`发现书籍链路-Stage2前置召回实验方案.md` | `git diff --stat` |
| 未跟踪文件（untracked） | **187 个文件**，多为 `V1.2.11–V1.2.17` 设计稿、`scripts/*`、各 `练习/` 报告等 | `git ls-files --others` |

**⚠️ 部署前重要提示**：当前工作区存在大量未提交改动（含 `vite.config.ts` 与 51 个 src 文件），且仓库内 `dist/`（2026-11-01）早于这批未提交改动（2026-11-03），即 **`dist/` 相对于工作区源码已陈旧**。上线前必须先确定发布基线（commit 或打 tag）→ 在该基线重新 `npm run build` 生成 `dist/`，**不得直接部署当前 `dist/` 或当前未提交源码**。暂存区另有他人（B12）工作，按协作纪律不得裹挟。

---

## A. 当前系统架构图

### A.1 逻辑架构（组件与依赖）

```
                         Internet
                            │  HTTPS (443)
                            ▼
        ┌─────────────────────────────────────────────┐
        │  反向代理 / TLS 终结（缺失！需新建 Caddy/Nginx）│   ← 仓库内无 Caddyfile/nginx 配置
        │  路由： / → 静态 ；/api → 8787 ；/api/discover → 8000 │
        └───────────┬───────────────┬──────────────────┘
                    │               │
          ┌─────────▼──────┐   ┌────▼──────────────────────┐
          │ 前端静态 (dist) │   │  Node 后端 (Express)        │
          │ 1.1MB 纯静态    │   │ 127.0.0.1:8787            │
          │ PWA + SW        │   │ OCR / 词典同步 / ASR调度    │
          └─────────┬──────┘   │ 格式转换入口 / AI(SSE) / 管理 │
                    │          │  spawn → ASR sidecar        │
                    │          └───┬──────────┬───────────┬──────────┐
          词库数据   │              │          │           │          │
          (R2 或本地)│      ┌───────▼───┐ ┌────▼─────┐ ┌──▼──────┐ ┌─▼────────┐
                    │      │ ASR sidecar│ │ Convert  │ │ Discover│ │ 外部SaaS │
                    │      │ FastAPI    │ │ Worker   │ │ API     │ │PaddleOCR │
                    │      │ :8177      │ │ (Python) │ │ FastAPI │ │ /LLM(OpenAI兼容)/Translate
                    │      │ whisper-sm │ │ PDF→PNG  │ │ :8000   │ │          │
                    │      └──────┬─────┘ └────┬─────┘ └────┬─────┘ └──────────┘
                    │             │            │            │
                    │             └────────────┴────────────┴──► PostgreSQL 18 + pgvector
                    │                        (同一 shutree 库，含 entries/toc/words/
                    │                         discovered_books/chunks/convert_* )
                    ▼
        ┌──────────────────────────────────────────┐
        │ Cloudflare R2（仅公共词库，已设计未全落地）│  shushu-public/linguabase/v1/
        │ 出口流量免费；用户私有文件桶 shushu-private │  ← 设计稿，代码未实现
        │ 尚未实现                                  │
        └──────────────────────────────────────────┘
```

### A.2 进程与端口清单（实测自代码）

| 进程 | 绑定 | 启动方式 | 证据 |
|---|---|---|---|
| 前端静态 | 由反代提供（无独立进程） | `vite build` → `dist/` | `vite.config.ts`、`package.json` build |
| Node 后端 | `127.0.0.1:<PORT>`（默认 **8787**） | `node dist/src/index.js` | `server/src/config.ts:102`、`server/package.json` start |
| Discover API | `127.0.0.1:<API_PORT>`（默认 **8000**） | `uvicorn main:app` | `api/config.py:98,184`、`api/main.py:7` |
| ASR sidecar | `127.0.0.1:<ASR_SIDECAR_PORT>`（默认 **8177**） | 由 Node **自动 spawn** | `server/src/asr/sidecar.ts:50`、`server/package.json` asr:sidecar |
| Convert Worker | 无监听端口（轮询 PG） | `python -m convert_worker.worker` | `server/convert_worker/worker.py` |
| PostgreSQL | `127.0.0.1:5432` | 系统服务 | `server/.env.example`、Runbook |
| BGE-M3 ONNX 模型 | 进程内（API 内） | 随 API 启动加载 | `api/main.py:254` `build_embedder` |

> **关键结论**：所有后端服务均正确绑定回环地址（`127.0.0.1`），生产拓扑应为「公网 → 反代(443) → 回环服务」。仓库内**缺少反代配置、进程编排（systemd/docker-compose）、备份脚本**——这是上线的最大缺口（详见 B、J、K）。

---

## B. 模块部署清单（已具备 / 需修复 / 尚未实现）

### B.1 已具备生产条件（代码层）
| 模块 | 就绪度 | 证据 |
|---|---|---|
| 前端生产构建（1.1MB 静态 + PWA/SW） | ✅ | `package.json` build、`vite.config.ts` PWA、`README.md` |
| 前端数据外置 + 运行期缓存 + 穿越防护 | ✅ | `src/data/dataClient.ts`、`vite.config.ts` localDataPlugin |
| Node 后端分层/错误处理/健康检查 | ✅ | `server/src/app.ts`、`routes/health.ts` |
| CORS 显式来源（无通配） | ✅ | `server/src/app.ts:43-61` |
| 管理员鉴权（sha256+timingSafeEqual+Bearer） | ✅ | `server/src/http/adminAuth.ts` |
| 上传校验（memoryStorage+白名单+50MB 上限） | ✅ | `server/src/http/upload.ts` |
| Discover 检索（HNSW/ef=800/启动自检/health） | ✅ | `api/main.py`、`api/db.py`、`server/sql/002_discover.sql` |
| BGE-M3 ONNX 推理（int8，省内存） | ✅ | `api/requirements-api.txt`、`api/config.py` onnx 分支 |
| ASR 本地转录（whisper-small int8，诚实失败） | ✅ | `server/asr_service/`、`server/src/asr/` |
| 格式转换任务系统（PDF→PNG 真实引擎） | ⚠️ 部分 | `server/convert_worker/`（仅 PDF→PNG 真；其余 ConverterNotImplemented） |
| 数据库迁移（幂等 IF NOT EXISTS，可重复执行） | ✅ | `server/sql/*.sql`、`server/src/scripts/migrate.ts` |
| 连接池 + 每连接 hnsw GUC 初始化 | ✅ | `api/db.py` DiscoverPool、db-conn-init.sql |
| 速率限制（AI 10/hr/IP、ASR 等） | ✅（单实例） | `server/src/http/rateLimit.ts`、`routes/ai.ts:36` |
| 结构化日志（API 带 request_id） | ✅ | `api/main.py` JsonFormatter |
| Discover API 监控脚本 | ✅ | `scripts/monitor-check.sh` |

### B.2 需要修复 / 补齐（上线阻塞或高优先级）
| 项 | 问题 | 优先级 | 证据 |
|---|---|---|---|
| **反向代理配置缺失** | 仓库无 Caddyfile/Nginx；前端 `/api`、`/api/discover` 在生产无入口 | **P0 阻塞** | `find` 全仓仅 2 个 .sh，无 proxy 配置 |
| **进程编排缺失** | 无 systemd unit / docker-compose 编排 5 个进程（Node/API/ASR/Convert/PG） | **P0 阻塞** | 无 `.service`/compose 文件 |
| **ASR sidecar 死亡不自愈** | sidecar 退出为终态，不自动重启；需重启 Node 才恢复 → 生产可用性风险 | **P1** | `server/src/asr/sidecar.ts:175-181`（`_markDead` 终态） |
| **速率限制仅单实例** | 多实例部署需 Redis，否则限流失效 | **P2** | `rateLimit.ts:15` 注释 |
| **用户私有文件 R2 未实现** | 设计稿 `shushu-private` 桶未落地，当前全落 VPS 本地 | **P2** | `V1.2.11-...R2对象存储接入架构设计.md` §一/§五 |
| **安全响应头缺失** | 无 HSTS/CSP/X-Content-Type-Options（反代层应补） | **P2** | 代码仅 `disable('x-powered-by')` |
| **全站无统一鉴权/网关** | 除 admin 外，`/api/discover`、`/api/ocr`（公开态）、转换/ASR 对可达者开放 | **P1** | `app.ts` 路由挂载无全局 auth；OCR 受 `OCR_PUBLIC_ENABLED` 控制 |
| **发布基线未定** | 51 文件未提交、`dist/` 陈旧 | **P0 阻塞** | §〇 git 状态 |
| **备份自动化缺失** | Runbook 提及 pg_dump cron，但仓库无脚本；无异地备份 | **P1** | 全仓无 backup 脚本 |

### B.3 尚未实现（不阻塞首版，但需知悉）
- 用户私有书籍上 R2（`shushu-private` 桶 + 签名 URL + owner 校验）—— 仅设计（V1.2.11）。
- 书籍资产/知识库问答的统一入库（Work 版资产模型、RLS、AI 问答链路）—— 设计阶段（V1.2.x 系列文档），代码未落地。
- 转换其余 5 个方向（PDF⇄DOCX/PNG·JPG→PDF/XLSX→PDF）—— `ConverterNotImplemented`，诚实失败。
- Docker 化 / 容器编排 —— 无。

---

## C. PostgreSQL 与 HNSW 向量索引资源需求

| 维度 | 实测/要求 | 来源 |
|---|---|---|
| 版本 | PostgreSQL **18** + **pgvector 0.8.6** | `server/sql/002_discover.sql:27`、`找书功能-生产部署前置方案.md` §1 |
| 当前库体积 | **~1.3GB**（含 HNSW 索引 456MB） | 前置方案 §1 |
| HNSW 索引 | `discovered_book_chunks_embedding_hnsw_idx`，`vector_cosine_ops`，**1024 维** | `002_discover.sql:112-113` |
| 检索 GUC（每连接） | `hnsw.ef_search=800`、`hnsw.iterative_scan=strict_order` | `db-conn-init.sql`、`api/config.py` |
| **shared_buffers** | **必须 = 2GB**（否则 retrieve 从 8ms 退化为 ~30ms） | Runbook §2、前置方案 §1 |
| effective_cache_size | = 8GB（规划器提示，非独占内存） | Runbook §2 |
| 连接池（Discover API） | 5~10 连接，每连接执行 3 条 init SQL | `api/config.py:79-80`、`api/db.py` |
| 数据表范围 | `entries`/`toc`/`grammar_rules`/`scan_records`/`words`（001）+ `discovered_books`/`discovered_book_chunks`（002）+ `convert_files`/`convert_tasks`（004）+ `005` | `server/sql/*.sql` |
| 扩展 | `vector`、`pg_trgm`、`pgcrypto` | `001_init.sql:12-13`、`002_discover.sql:27` |
| CPU | 单条检索单核为主；`ef_search=800` 提升计算量；建议 ≥4 核 | 实测描述（B.12 口径） |
| 内存占用 | shared_buffers 2GB + 工作集 ~1GB ≈ **3GB（仅 PG）** | 综合 Runbook |

> **上线约束**：PG 必须与检索 API **同机共置**以保住 8ms 检索口径（前置方案 §2 明确：托管小实例会退回 30ms 档）。因此 PG 不能简单外包给低配托管 PG。

---

## D. ONNX 模型运行资源需求（区分模型文件 / 运行时内存 / 并发推理）

| 维度 | BGE-M3 ONNX（int8） | 来源 |
|---|---|---|
| 模型文件 | `bge-m3-onnx/model_int8.onnx` = **543MB**（gitignore，不入仓，需随包/挂盘传输） | `找书功能-生产部署前置方案.md` §1、`api/requirements-api.txt` 注释 |
| 运行时常驻内存 | **~1.3GB**（INT8）；对比 torch 后端 ~2.2GB | `requirements-api.txt` 注释（ONNX 把常驻从 2.2GB 压到 1.3GB） |
| 推理线程 | `ONNX_THREADS` 默认 **4** | `api/config.py:145` |
| 单查询编码耗时 | ONNX P50 **~21ms**（torch 115ms） | `api/main.py` latency_profile 注释（B.11） |
| 启动加载 | ~2.7s（冷启动敏感 → 常驻进程优于函数） | 前置方案 §1 |
| 并发模型 | 单模型实例在 API 进程内；请求串行经线程池卸载，高并发会排队 | `api/db.py` to_thread 设计 |
| 横向扩展 | 可选 `EMBEDDING_BACKEND=remote` 拆独立推理实例 | `api/config.py:130-160` |
| 磁盘外依赖 | venv 装 `onnxruntime==1.31.0` + `transformers==5.19.0`（约 1–2GB） | `requirements-api.txt` |

> ASR 模型另计：whisper-small int8 **~461MB 文件**，峰值内存 **~0.48GB**（见 E）。

---

## E. ASR / AI / 格式转换 Worker 独立部署要求

### E.1 ASR Worker（本地模型，被 Node spawn）
- 形态：FastAPI sidecar `:8177`，由 Node 启动自动 spawn（`server/src/asr/sidecar.ts`）；也可独立 `uvicorn app:app --host 127.0.0.1 --port 8177`。
- 模型：whisper-small int8，**~461MB 文件**，峰值内存 **~0.48GB**，CPU int8，转录约 2× 实时。
- 并发：**串行单 worker**（`queue` 单推理循环），队列如实返回 `queued`；同一时刻仅 1 个转录。
- 依赖：独立的 `asr_service/venv`（faster-whisper 1.2.1 + ctranslate2 4.8.3 + av 18.1.0 锁定，**勿升级**）。
- ⚠️ 可用性：**sidecar 进程死亡为终态，不自动重启**，需重启 Node 才恢复（`sidecar.ts:175`）。生产须以 systemd 监管 Node，使重启级联恢复；并加 external health 探针。
- 磁盘：输入 `server/data/asr/in/<jobId>/`、输出 `server/data/asr/out/<jobId>.json`（gitignore）。

### E.2 AI Worker（云端 LLM，SSE）
- 形态：Node 路由 `POST /api/ai/study-notes`，SSE 流式；**无本地模型**，调用 OpenAI 兼容云端 LLM。
- 依赖：`AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` 三项齐备才启用，缺则 503「未接入」。
- 限流：10 次/小时/IP（计费调用从紧）。
- 风险：外部 SaaS 依赖 + 密钥管理（密钥仅 `server/.env`，服务端，OK）。

### E.3 格式转换 Worker（Python，轮询 PG）
- 形态：无端口，轮询 `convert_tasks`（`UPDATE...RETURNING` 原子认领），调 Converter，落盘，写回。
- 真实引擎：**仅 PDF→PNG（PyMuPDF）**；其余方向 `ConverterNotImplemented` 诚实失败。
- 启用条件：`CONVERT_ENGINE_ENABLED=true` + Worker 在跑；否则创建任务接口 503。
- 磁盘：`CONVERT_STORAGE_DIR`（默认 `server/data/convert`），源文件转换后删除，结果文件 TTL 1h 清理（`index.ts` 定时器）。
- 依赖：`convert_worker/requirements.txt`（PyMuPDF≥1.24,<2）。

### E.4 OCR（外部 SaaS）
- PaddleOCR 云端 API，依赖 `PADDLEOCR_ACCESS_TOKEN`；`OCR_PUBLIC_ENABLED` 控制是否开放公开上传端点。外部依赖。

---

## F. VPS CPU / 内存 / SSD / 带宽需求及计算依据

### F.1 稳态内存预算（同机共置全部 5 类进程 + PG + 前端）
| 组件 | 稳态内存 |
|---|---|
| OS + 监控开销 | ~1.0 GB |
| PostgreSQL（shared_buffers 2GB + 工作集） | ~3.0 GB |
| Discover API + BGE-M3 ONNX（1.3GB 常驻） | ~2.0 GB |
| Node 后端（Express + OCR/词典/调度） | ~0.4 GB |
| ASR sidecar（whisper-small int8） | ~1.0 GB |
| Convert Worker（空闲 + PyMuPDF 偶发） | ~0.4 GB |
| **合计（稳态）** | **≈ 7.8 GB** |

> 叠加并发尖峰（ASR 推理 + 检索 + 转换同时发生）、venv/依赖缓存、OS 页缓存竞争，建议预留 ≥2× 稳态余量。

### F.2 各资源建议
- **CPU**：检索单查询单核；BGE-M3 ONNX `onnx_threads=4`；ASR ctranslate2 多线程；转换 PDF→PNG CPU 密集。建议 **4–8 vCPU**（8 为舒适档）。
- **内存**：稳态 ~8GB → 推荐 **16GB**（4GB 仅够「检索子系统」，见 K 说明）。
- **SSD（NVMe 优先）**：
  - PG 数据 1.3GB（增长后估 5–10GB）→ HNSW 随书籍/分块增长；
  - 模型文件：BGE-M3 543MB + whisper 461MB ≈ 1GB；
  - venv/依赖：API venv ~1–2GB，ASR venv ~0.5–1GB，Node `node_modules` 已存在；
  - 用户上传（OCR/ASR/转换）+ 日志 + WAL + 备份：建议 20–40GB；
  - 若词库数据改走 VPS 本地（非 R2）再加 410MB+。
  - **建议 80–120GB SSD**（40GB 仅够检索子系统极低增长）。
- **带宽**：
  - 词库数据走 **R2（出口免费）** → VPS 对词库 egress ≈ 0；
  - VPS egress 主要为 API JSON 响应 + 用户上传回传，量级小；
  - ingress 为用户上传（单文件 ≤50MB）。
  - 建议 **1–5TB/月**（新站 1TB 足够；R2 承担大头）。

---

## G. R2 与 VPS 本地存储职责划分

| 数据类别 | 归属 | 当前状态 | 证据 |
|---|---|---|---|
| 公共词库（410MB，`/linguabase/v1/`） | **R2 公共桶** `shushu-public` | ✅ 已设计 + `upload_data.py`（boto3，演练 159 对象/409MB） | `scripts/upload_data.py`、`V1.2.11…R2对象存储接入架构设计.md` §五 |
| 用户私有上传文件（原始/衍生/学习稿） | **R2 私有桶** `shushu-private`（签名 URL） | ❌ **仅设计，代码未实现**；当前全落 VPS 本地 | V1.2.11 §一/§五 |
| OCR 原始图片 | VPS 本地 `server/data/ocr` | ✅ 现状 | `server/src/config.ts:150` |
| ASR 媒体 in/out | VPS 本地 `server/data/asr` | ✅ 现状 | `asr_service/README.md` 数据边界 |
| 转换源/结果文件 | VPS 本地 `server/data/convert` | ✅ 现状 | `convert_worker/config.py:30` |
| PostgreSQL 数据 + WAL | VPS 本地磁盘 | ✅ 现状 | — |
| 模型文件（BGE-M3/whisper） | VPS 本地（随包/挂盘，gitignore） | ✅ 现状 | `.env.example` 注释 |
| 应用代码 / 日志 | VPS 本地 | ✅ 现状 | — |

**划分结论**：
- **R2 当前只承载公共词库**（出口免费是选 R2 的决定性理由）；用户私有文件上 R2 待实现。
- **VPS 本地负责**：用户生成文件、模型、PG 数据、日志。
- 首版建议：词库 → R2；用户文件 → VPS 本地（接受，因私有 R2 未实现）；后续再切私有桶。

---

## H. DNS / CDN / HTTPS 配置规划

> 现状：`tellshu.com` 仅在任务书提及，**全仓库 0 处出现该域名**（Grep 证实），无 DNS/CDN/证书配置。

### H.1 建议拓扑（基于 Cloudflare，因 R2 已选 Cloudflare）
1. **DNS**：`tellshu.com`（或 `app.tellshu.com`）A 记录 → VPS 公网 IP；`data.tellshu.com` CNAME → R2 自定义域（词库）。
2. **CDN/代理**：将主域 **橙色云（proxy）** 接入 Cloudflare → 免费 TLS、WAF、静态缓存、DDoS 防护；R2 走 `data.tellshu.com` 自定义域并开 CORS。
3. **HTTPS/TLS**：Cloudflare 边缘证书 + 源站 **Origin Certificate**；VPS 反代（Caddy 或 Nginx）强制 443→反代。亦可按 Runbook 用 Caddy 自动 TLS（但 Caddy 的 Let's Encrypt 与 Cloudflare 代理并存需注意回源证书）。
4. **防火墙**：仅放行 22/80/443（Runbook §1）；8000/8177/8787/5432 不对公网。
5. **CORS**：R2 桶放行 `https://tellshu.com`（及预览域）；当前 `.env.production.example` 注释模板需替换为真实域。
6. **路由规则**（反代必须实现，对应 vite 开发代理键序）：
   - `/` → 静态 `dist/`
   - `/api/discover` → `127.0.0.1:8000`（**先于 `/api`**，与 `vite.config.ts:171` 一致）
   - `/api` → `127.0.0.1:8787`
   - 关闭反代缓冲（AI SSE 需 `X-Accel-Buffering: no`，代码已设 `routes/ai.ts:79`）

### H.2 缺失项
- 无 Caddyfile / Nginx 配置模板（**需新建**）。
- 无 `data.tellshu.com` / R2 自定义域 / CORS 实际值（**待用户提供域名后填**）。
- 无_origin certificate 流程（待定）。

---

## I. 生产环境安全风险清单

### I.1 已具备（代码层正确实践）
- ✅ 后端全绑定 `127.0.0.1`，不直接暴露公网。
- ✅ CORS 显式来源白名单，无 `*` 通配（`app.ts:43`）。
- ✅ 管理员鉴权 sha256 + timingSafeEqual（`adminAuth.ts`）。
- ✅ 上传 memoryStorage + MIME/扩展名白名单 + 文件大小上限（`upload.ts`）。
- ✅ 边界输入校验（Discover 请求体/ef_search 白名单，`api/main.py:354`）。
- ✅ 全局错误处理器不回传堆栈/内部细节（`api/main.py:316`、`errors.ts`）。
- ✅ 密钥仅 `server/.env`（gitignore），无硬编码（`config.ts` 全环境变量）。
- ✅ 路径穿越防护（vite localDataPlugin、`convert` 用 uuid 命名）。
- ✅ AI 错误不泄露密钥（`routes/ai.ts` 用 `ApiError`，不含 key）。

### I.2 风险与待办（上线前必须处理）
| # | 风险 | 等级 | 建议 |
|---|---|---|---|
| 1 | 反代/TLS 配置缺失，API 无公网入口且未收敛到单一网关 | **高** | 新建 Caddy/Nginx + Cloudflare；所有 `/api` 经网关 |
| 2 | 除 admin 外，discover/OCR(公开)/convert/ASR 对可达者开放，无统一鉴权/网关限速 | **高** | Cloudflare WAF + 速率限制；必要时加每路由鉴权 |
| 3 | ASR sidecar 死亡不自愈 | **中** | systemd 监管 Node + 外部 health 重启；或独立监管 sidecar |
| 4 | 限流仅单实例（进程内 Map） | **中** | 单实例可接受；多实例改 Redis |
| 5 | 安全响应头缺失（HSTS/CSP/X-Content-Type） | **中** | 反代层统一加 |
| 6 | 管理密钥为单一静态 Bearer，无轮换 | **中** | 密钥入 secrets manager；定期轮换 |
| 7 | PG 口令/各 token 存 `server/.env`，需 `chmod 600` + 仅 root/服务用户可读 | **中** | 部署时设权限；不入仓（已 gitignore） |
| 8 | 无集中日志/审计（仅 stdout/stderr + API JSON 日志） | **低** | 接 journald / 日志收集 |
| 9 | 无 SQL 注入复核结论（代码用参数化，但未专门审计） | **低** | 上线前安全复核 parameterize 全路径 |

---

## J. 数据备份、恢复与上线回滚方案

### J.1 备份
- **PostgreSQL**（核心资产）：
  - `pg_dump -Fc shutree > shutree.pgdump`（Runbook §2，库 ~1.3GB，分钟级）。
  - **建议**：每日 cron，保留 7 份；异地（R2 / 第二盘）。**仓库内无备份脚本，需新建**。
- **模型/代码**：代码在 git（模型文件、词库数据 gitignore，需独立保管/可重下）。
- **词库数据**：R2（天然持久）+ 本地副本。
- **用户文件**（VPS 本地）：随 PG 备份 + 单独 `server/data/{ocr,asr,convert}` 目录归档。

### J.2 恢复
- PG：`pg_restore -d shutree --no-owner shutree.pgdump`（Runbook §2）。
- 迁移为**追加式 + 幂等**（IF NOT EXISTS），可重跑；但**无 down-migration**（回滚只能靠备份点恢复）。
- 模型：从包/挂盘恢复或重新下载（whisper 461MB、BGE-M3 543MB）。

### J.3 回滚
- **前端/后端**：保留上一版 `dist/` 与构建产物（符号链接切换或镜像 tag）；systemd 重启到旧版。
- **数据库**：因无 down 脚本 → 回滚 = 恢复到迁移前 `pg_dump`；**必须保证备份先于任何迁移**（上线阻塞项）。
- **词库数据**：按路径版本（`v1`/`v2`）灰度，回滚 = `VITE_DATA_VERSION` 退回旧版，互不影响。
- **检索子系统回滚**（Runbook §8）：删 `vercel.json` 的 `/api/discover` 重写 → 功能可观测关闭但不白屏；`systemctl stop shutree-discover` 不影响他服务。

> **阻塞项**：备份自动化 + 恢复演练 + 回滚 runbook 均**未落地**，上线前必须补齐并实测一次恢复。

---

## K. 推荐 VPS 配置

| 档位 | CPU | 内存 | SSD | 带宽 | 适用 | 明确限制 |
|---|---|---|---|---|---|---|
| **最低可运行** | 4 vCPU | **8 GB** | 40 GB NVMe | 1 TB/月 | 首版低流量；检索子系统（PG+API）绰绰有余 | ⚠️ 8GB 中 PG 独占 3GB + ONNX 1.3GB + ASR 1GB 后仅 ~2.7GB 余量，**ASR+检索+转换并发时极易 OOM**；**Runbook 的 2C4G 仅适用于检索子系统，绝不足以跑全栈** |
| **推荐（首版生产）** | 8 vCPU | **16 GB** | 120 GB NVMe | 2–5 TB/月 | 全栈 5 进程 + 余量；可承受并发 ASR/检索/转换 | 单实例，限流为进程内；流量显著增长需拆分 |
| **后续扩展** | 见下 | 见下 | 见下 | 见下 | 负载升高 / 多实例 | — |

**后续扩展路径（依据代码可拆分性）**：
1. **拆 PG**：独立 PG 实例（或托管 pgvector），保留 `shared_buffers=2GB` + 同机检索 API 以保 8ms 口径；跨机需重验延迟。
2. **拆推理**：BGE-M3 改用 `EMBEDDING_BACKEND=remote` 独立推理实例，横向扩缩容。
3. **拆 ASR/转换**：独立 Worker 节点（已是独立进程，易迁出）。
4. **容器化**：补 `Dockerfile` + `docker-compose`（当前缺失）便于多实例与编排。
5. **多实例限流**：`rateLimit.ts` 注释已指明需 Redis。

---

## 证据索引（审计依据文件）

| 结论 | 证据文件:行 / 命令 |
|---|---|
| 系统组件与端口 | `server/src/config.ts:102`、`api/config.py:98,184`、`server/src/asr/sidecar.ts:50`、`server/package.json` |
| 前端构建/数据外置 | `package.json`、`vite.config.ts`、`src/data/dataClient.ts`、`.env.example` |
| 检索/HNSW/GUC | `server/sql/002_discover.sql`、`server/src/scripts/db-conn-init.sql`、`api/db.py`、`api/main.py`、`api/config.py` |
| 模型资源 | `api/requirements-api.txt`、`bge-m3-onnx/`、`找书功能-生产部署前置方案.md` §1 |
| ASR | `server/asr_service/README.md`、`server/asr_service/asr_core/config.py`、`server/src/asr/sidecar.ts` |
| 转换 | `server/convert_worker/worker.py`、`config.py`、`README.md`、`server/sql/004_convert.sql` |
| 安全实践 | `server/src/app.ts:43`、`http/adminAuth.ts`、`http/upload.ts`、`http/rateLimit.ts`、`routes/ai.ts` |
| R2 划分 | `scripts/upload_data.py`、`V1.2.11-Cloudflare-R2对象存储接入架构设计.md` |
| 部署缺口 | 全仓 `find` 无 Caddyfile/nginx/systemd/compose（仅 `scripts/monitor-check.sh`、`server/scripts/poll_loop.sh`） |
| Git 状态 | `git log -1` / `git diff --cached --name-status` / `git diff --stat` / `git ls-files --others` |
| 域名缺失 | Grep 全仓无 `tellshu.com` |

---

## 上线阻塞项与优先级（执行摘要）

**P0（必须，否则无法上线）**
1. 确定发布基线（commit/tag）→ 重新 `npm run build` 生成 `dist/`；不得用当前陈旧 `dist/` 或未提交源码。
2. 新建反向代理配置（Caddy/Nginx）+ Cloudflare DNS/TLS，收敛 `/`、`/api`、`/api/discover`。
3. 新建进程编排（systemd ×5 或 docker-compose），确保 PG/API/Node/ASR/Convert 开机自启、崩溃可恢复。

**P1（上线前应完成）**
4. ASR sidecar 自愈（外部监管 + health 重启）。
5. 备份自动化（pg_dump 每日 + 异地）+ 恢复演练。
6. 全站统一网关鉴权/限速（Cloudflare WAF 或每路由鉴权），尤其公开 OCR/转换/ASR 端点。

**P2（可后续）**
7. 安全响应头（HSTS/CSP 等）。
8. 多实例 Redis 限流。
9. 用户私有文件上 R2（shushu-private 桶）。

**待用户决策/提供**
- VPS 采购（规格参考 K）、域名 `tellshu.com` 的 DNS 托管（建议 Cloudflare）、R2 账号与桶、Cloudflare API 令牌、`server/.env` 各项真实值（DB 口令/各 SaaS token/管理员密钥）。

---

> 本审计为只读，未对任何系统做改动。所有结论均附证据索引；未核实项已明确标注。等待用户审核后进入 Phase 1（部署实施）。
