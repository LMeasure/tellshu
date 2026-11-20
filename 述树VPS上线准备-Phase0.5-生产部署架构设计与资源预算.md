# 述树 VPS 上线准备 · Phase 0.5 生产部署架构设计与资源预算

> 本文档是 Phase 0（生产部署就绪审计报告）的延续与深化。**纯设计、只读**，未对仓库源码 / 配置 / `.env` / Git / 服务器做任何改动，也未写入任何真实密钥。
> 所有配置草案均为**占位示例**，不写入仓库。
> 结论一律标注可信度标签：
> - **【已由源码验证】** 直接读源码确认
> - **【已由配置验证】** 直接读配置文件 / 运行态 `SHOW` 实测（B.11/B.12 报告）确认
> - **【估算】** 基于已知事实推算，未经压测
> - **【待实际压测】** 需在目标 VPS 上实测
> - **【待采购报价】** 价格需向云厂商询价

---

## 1. 最终服务拓扑图

### 1.1 拓扑（文本图）

```
                        互联网
                          │
                          │ 仅 443/80（TLS 终止）
                          ▼
                   ┌──────────────┐
                   │   Caddy       │  systemd: caddy.service（apt 安装）
                   │  反向代理+TLS  │  唯一公网入口；健康检查 /api/health
                   └──────┬───────┘
            ┌─────────────┼─────────────────────┐
            │             │                      │
     静态前端(dist)   /api/*(除discover)    /api/discover/*
            │             │                      │
            │             ▼                      ▼
            │      ┌─────────────┐        ┌──────────────┐
            │      │  Node API    │        │ Discover API │  systemd: shushu-discover
            │      │  :8787       │        │ :8000 (FastAPI│  EMBEDDING_BACKEND=onnx
            │      │ (Express)    │        │ +BGE-M3 ONNX) │
            │      └──────┬───────┘        └──────┬───────┘
            │             │                      │
            │             │  child_process.spawn  │
            │             ▼                      │
            │      ┌─────────────┐                │
            │      │ ASR sidecar │◄─ Node 子进程  │
            │      │ :8177       │   不独立管理    │
            │      │(whisper-int8)│               │
            │      └──────┬───────┘               │
            │             │                      │
            │   ┌─────────┴──────────┐           │
            │   │  Convert Worker     │           │
            │   │ (systemd: shushu-   │           │
            │   │  convert, PG 轮询)   │           │
            │   └─────────┬──────────┘           │
            │             │                      │
            └─────────────┼──────────────────────┘
                          ▼
                   ┌──────────────┐
                   │ PostgreSQL 18 │  systemd: postgresql（apt 安装）
                   │ +pgvector 0.8 │  shared_buffers=2GB（已由配置验证）
                   │ :5432 仅回环   │  HNSW 索引 456MB（已由历史报告验证）
                   └──────────────┘

   本地磁盘（VPS 内）：
     data/ocr      ← OCR 图片（相对路径存 scan_records.image_path）
     data/convert  ← 转换文件（convert_files.storage_path）
     data/asr      ← ASR 媒体/结果 JSON（仅 sidecar 写盘，不在 DB）
     （R2 shushu-public 词库：已上线，属另一桶，与本拓扑无关）
```

### 1.2 关键拓扑事实（均【已由源码验证】）

| 项 | 事实 | 证据 |
|---|---|---|
| 后端全回环 | Node 8787、Discover 8000、ASR 8177 均 `host 127.0.0.1` | `index.ts` 监听 `127.0.0.1:8787`；`api/main.py` 绑 `127.0.0.1:8000`；`sidecar.ts` `buildSidecarSpawn` 传 `--host 127.0.0.1` |
| 唯一公网入口 | 仅 Caddy 暴露 443/80；反向代理到回环 | 设计约定；源码无公网 bind |
| ASR 生命周期 | 由 Node `spawn` 拉起，**随 Node 退出而退出**；**不**作为独立 systemd 单元 | `sidecar.ts:165-186`；`index.ts` 优雅停机 `child.kill` |
| ASR 死亡语义 | sidecar 退出 → `dead` 终态（**不自动重启**）→ 后续 submit 直接 503 | `sidecar.ts:175-181` 注释明示「不自动重启，防崩溃循环」 |
| 前端形态 | 纯静态 `dist/`，由 Caddy 直接 serve | PWA + Vite build（Phase 0 已确认） |

> ⚠️ **设计红线**：ASR sidecar 不得设计为独立 systemd 服务。若另设单元，会与 Node 父子关系冲突（双重管理 / 孤儿进程 / 端口争用）。一切 ASR 生命周期必须挂在 Node 之下（或经 Node 重启间接恢复）。

---

## 2. 服务进程管理矩阵

| 服务 | 来源 / 命令 | 监听 | 公网？ | 生命周期管理方 | 重启策略 | 崩溃影响 |
|---|---|---|---|---|---|---|
| **Caddy** | `caddy run` (apt) | :80/:443 | ✅ 是 | systemd `caddy.service` | `Restart=on-failure` | 全站不可达；恢复即生效 |
| **PostgreSQL 18** | `postgres` (apt) | :5432 回环 | ❌ | systemd `postgresql.service` | 自带 | 所有依赖 DB 的服务降级（Node /health→503） |
| **Node API** | `node dist/src/index.js` | :8787 回环 | ❌(经 Caddy) | systemd `shushu-node.service` | `Restart=on-failure` | API 全挂；**会重拉 ASR sidecar**（子进程随父生） |
| **ASR sidecar** | `python -m uvicorn app:app`（Node 内 spawn） | :8177 回环 | ❌ | **Node 子进程（无独立单元）** | 随 Node 重启恢复；自身死亡 **不**自启 | 仅 ASR 转写 503；OCR/检索/转换不受影响 |
| **Discover API** | `uvicorn main:app --host 127.0.0.1 --port 8000` | :8000 回环 | ❌(经 Caddy) | systemd `shushu-discover.service` | `Restart=on-failure` | 找书检索 503；主站其他功能正常 |
| **Convert Worker** | `python worker.py`（PG 轮询 claim） | 无（常驻） | ❌ | systemd `shushu-convert.service` | `Restart=on-failure` | 文档转换排队；超时任务被 reclaim |
| **前端静态** | Caddy `file_server`（读 `dist/`） | 经 Caddy | ✅ 是 | 无进程（文件） | 改 `dist/` 即生效 | 静态资源 404（构建未产出） |

**启动顺序与依赖**（systemd `After=` / `Wants=`）：
1. `postgresql` → 2. `shushu-node`（需 PG）→ 3. `shushu-discover`（需 PG）→ 4. `shushu-convert`（需 PG）→ 5. `caddy`（需上述监听就绪）。
   - Node 启动时会 `spawn` ASR sidecar 并轮询 `/health` 至就绪（最长 `sidecarLoadMs`，默认 60s 宽限）。
   - 建议 `caddy.service` 加 `After=shushu-node.service shushu-discover.service`，但 Caddy 与后端解耦（后端挂了 Caddy 仍可返回 503/静态壳）。

**监控 / 健康**：
- Caddy → `GET /api/health`（Node 聚合 DB 状态，200/503）【已由源码验证】。
- Discover 自带 `/api/discover/health` + `/status`【已由源码验证】。
- Convert 自带 `/api/convert/health`（含 `engineEnabled`）【已由源码验证】。
- 建议外部探针（如 UptimeRobot）只打 Caddy 443 + `/api/health`，避免直连回环。

---

## 2.5 ASR sidecar 生命周期审计（Phase 0.5-R 补证）

> 证据：sidecar.ts:39-57（spawn，无 `detached`）、sidecar.ts:134-160（`close()` SIGTERM→3s→SIGKILL）、sidecar.ts:175-181（`exit`→`dead` 终态）、index.ts:115-146（graceful `shutdown` 调 `asrProvider.close()`）、index.ts:149-153（`main().catch`→`process.exit(1)` **未**调 `shutdown`）、jobStore.ts:40-41（任务状态仅内存）。

### 2.5.1 spawn 与退出机制（关键事实）

- **创建**：`buildSidecarSpawn` 用 `spawn()`，**未设 `detached: true`** → sidecar 与 Node **同进程组、非独立会话**（sidecar.ts:39-57）。
- **正常关闭**：Node 收到 `SIGINT`/`SIGTERM` → `shutdown()` → `asrProvider?.close?.()` → 先 `SIGTERM`，3s 未退则 `SIGKILL`（sidecar.ts:135-160；index.ts:125-128）。✅ sidecar 被带走。
- **异常退出**：`main().catch` 直接 `process.exit(1)`，**不调用 `shutdown()`**（index.ts:149-153）→ sidecar **不被显式杀死**。
- **sidecar 自身退出**：`child.on('exit')` → `_markDead`（终态，不自动重启，注释明示「防崩溃循环」）（sidecar.ts:175-181）。

### 2.5.2 正常退出流程图

```
[Node 收到 SIGINT/SIGTERM]
        │
        ▼
index.ts shutdown()  clearInterval(cleanup)
        │  asrProvider.close()
        ▼
sidecar.close(): child.kill(SIGTERM)
        │  ├─ 3s 内退出 → 完成
        │  └─ 超时 → child.kill(SIGKILL)
        ▼
server.close() → pool.end() → process.exit(0)
        ⇒ sidecar 已随 Node 退出（同进程组，systemd KillMode=control-group 亦兜底）
```

### 2.5.3 异常退出流程图

```
情形 A：Node 被 SIGKILL（kill -9 / OOM killer 仅杀 Node）
   Node 无法执行 shutdown()
        ⇒ sidecar 进程未收到信号 → 成为孤儿（由 init/PID1 接管）
        ⇒ 仍占 8177 端口 + ~0.5–1GB 内存
        ⇒ systemd 重启 Node → 新 sidecar 企图 bind 8177 → 失败 → 新 sidecar 进入 dead
        ⇒ ASR 永久 503，直到孤儿被手动 kill

情形 B：Node 崩溃（未捕获异常 → main().catch → process.exit(1)）
   与 A 类似：shutdown() 未执行 → sidecar 孤儿化
   （若 systemd KillMode=control-group 且单位判定失败，cgroup 内残留进程会被一并清掉；
    但若 KillMode=process 或 kill -9 直击 Node PID，则孤儿残留）

情形 C：sidecar 自行崩溃 / 模型加载失败
   sidecar 退出 → SidecarProcess.dead（终态）
   Node 仍存活，但 /api/asr 提交直接 503
   内存中 AsrJobStore 的 running 任务在下次 syncJob 时 failing/超时 → 转 failed + removeMedia
   ⇒ 必须重启 Node 才能重拉 sidecar
```

### 2.5.4 当前已实现行为（【已由源码验证】）

| 行为 | 现状 |
|---|---|
| 随 Node 启动自动 spawn | ✅（index.ts:97-102） |
| 正常停机带走 sidecar | ✅（SIGTERM/SIGINT 路径） |
| sidecar 死亡后不自动重启 | ✅（设计：防崩溃循环） |
| 任务状态持久化 | ❌ 仅 Node 内存 `Map`，重启全失（jobStore.ts:40-41） |
| 在途媒体文件崩溃清理 | ❌ 崩溃时 `in/<jobId>/` 孤儿（service.ts 仅在终态调 `removeMedia`） |
| 端口冲突自愈 | ❌ 见情形 A |

### 2.5.5 当前未实现的恢复能力

1. **sidecar 死亡自愈**：Node 存活时 sidecar 死 → 永久 503，须人工/外部重启 Node。
2. **任务断点恢复**：因状态仅内存，**任何 Node 重启都丢失全部在途任务**，用户须重提；无 PG 任务表（与 Convert 不同）。
3. **孤儿 sidecar 端口冲突恢复**：情形 A 下新 sidecar bind 失败，无检测/清理逻辑。
4. **`out/*.json` 清理**：sidecar 写的 canonical JSON 永不删（见 §4.2 ASR Q10）。

### 2.5.6 部署约束与未来修复建议（不修改代码，仅建议）

- **部署约束（硬）**：ASR sidecar **不得**设为独立 systemd 单元（会与 Node 父子关系冲突 → 双管理/孤儿/端口争用）。其生命周期必须挂在 Node 之下。systemd `shushu-node.service` 须保持默认 `KillMode=control-group`（或显式声明），确保单位停止时连 sidecar 一起清。
- **外部监管（Phase 1 建议）**：在 Caddy/外部探针加 `/api/health` 之外的**独立 ASR 存活探针**，sidecar 死 → 触发 `systemctl restart shushu-node`（连带重拉 sidecar），作为「不自愈」的兜底。
- **未来代码修复（待授权）**：① Node 监听 sidecar `exit` 后做有限次 `respawn`（`sidecar.ts` 当前显式不重启，需改设计）；② `main().catch` 改调 `shutdown()` 而非裸 `process.exit(1)`；③ 在途媒体 `in/` 加启动期扫描清理（防崩溃孤儿）；④ sidecar `out/*.json` 加 TTL 清理。

---

## 3. 三档服务器配置及资源预算

### 3.1 稳态内存拆解（逐项标注 · Phase 0.5-R 修正）

> **标签说明（本轮新增）**：
> - **【配置实测】** 运行态 `SHOW`/配置值实测（本机 Windows 开发机 B.11/B.12，**非目标 VPS**）。
> - **【源码推断】** 由代码逻辑推断，未实测。
> - **【估算】** 基于已知事实推算。
> - **【已有历史实测】** 旧报告在开发机的测量值（仅供参照，非目标机）。
> - **【当前运行时实测】= 无**：本轮只读审计**未启动任何服务**，目标 VPS 亦不存在；下表**没有任何一项来自目标机实测**。

> **计算口径修正**：下表「常驻」为各进程**常驻 resident 的上限估算**（非平均值、非当前实测）。**7.8GB 是各进程上限之和（偏保守/偏上限）**，并非观测到的稳态 RSS——各进程不会同时处于峰值，OS 也会回收空闲页，故真实稳态 RSS 通常**低于** 7.8GB。结论用于「容量规划上限」，不得当作「实测常占」。

| 进程 | 常驻 resident（上限估算） | 峰值 peak | 依据与标签 | 标签 |
|---|---|---|---|---|
| OS（Debian headless） | 0.8–1.2 GB | ~1.2 GB | 内核+systemd+sshd+日志 | 【估算】 |
| **PostgreSQL 18** | **2.0 GB（shared_buffers 独占预分配）** + 0.3–0.7 GB（后端连接~5-10 ×数MB + 其他表/开销） | ~2.5–3.0 GB | `shared_buffers=2GB`【配置实测(开发机)】；检索热工作集 chunks 808MB+HNSW 456MB=1264MB **已包含在 2GB 内**（非叠加）【已有历史实测】；连接池 5–10（api/db.py） | shared_buffers【配置实测】；余量【估算】 |
| **Discover API**（ONNX BGE-M3 int8） | ~1.3–2.0 GB | ~2.0–2.5 GB | **模型文件 `model_int8.onnx`≈543MB（文件大小，非 RSS）**【源码推断路径】；常驻 RSS 估算含 onnxruntime+向量+`onnx_threads=4` 工作区 | 文件大小【源码推断】；RSS【估算】 |
| **Node API**（Express 8787） | ~0.3–0.5 GB | ~0.6 GB | `memoryStorage` 缓冲（单文件≤50MB，瞬时）+ ASR 子进程管理开销 | 【估算】 |
| **ASR sidecar**（whisper-small int8） | ~0.7–1.0 GB | ~1.0–1.3 GB | **模型文件 whisper-small int8≈461MB（文件大小）**【源码推断路径】；RSS≈Python+ctranslate2+模型 ≈ 0.7–1.0GB | 文件大小【源码推断】；RSS【估算】 |
| **Convert Worker**（Python） | ~0.3–0.4 GB | ~0.6 GB | PyMuPDF PDF→PNG + PG 连接（空闲常驻低） | 【估算】 |
| **合计（上限之和）** | **≈ 7.3–8.5 GB（取 7.8GB 代表值）** | **≈ 9–11 GB（组合峰值）** | 各进程上限相加，偏保守 | 【估算】 |

> **`shared_buffers=2GB` 取值依据**【配置实测(开发机)】+【已有历史实测】：B.11 实测单次检索工作集 ≈ chunks 808MB + HNSW 456MB = **1264MB**；原 128MB 装不下 → 128MB→2GB 后 retrieve 从 30.8ms 降至 8.4–8.9ms（B.12 `SHOW` 实测生效）。**该 1264MB 热工作集已被 2GB 的 shared_buffers 吸收，不得再在「工作集」行重复加计。**

#### 3.1.1 用户四问解答（内存口径澄清）

1. **Phase 0 ASR 峰值 ~0.48GB vs Phase 0.5 ~1GB 差异**：
   - ~0.48GB ≈ whisper-small int8 **模型文件大小（461MB）**，是「模型占用」的下界口径（Phase 0 E.1 表述）。
   - ~1GB 是**进程常驻 RSS 估算**（Python 解释器 + ctranslate2 运行时 + 音频缓冲 + 模型），更接近真实占用。
   - 二者**均为估算、非实测**；差异源于「模型文件大小」vs「进程 resident」两种口径，不构成矛盾。本轮统一采用 RSS 口径（0.7–1.0GB 上限），避免把文件大小当内存。
2. **Discover 的 2GB 是模型文件 / RSS / 估算？**
   - 模型**文件** `model_int8.onnx` ≈ **543MB**（文件大小，非内存）。
   - 表中 2GB 指**进程常驻 RSS 上限估算**（含 onnxruntime + 推理工作区），**不是模型文件大小**，也不是实测。
3. **PostgreSQL ~3GB 是否重复计算 shared_buffers / 查询内存 / OS 页缓存？**
   - **不重复**：`shared_buffers=2GB` 是 PG 向 OS **独占预分配**的匿名内存（非 OS 页缓存）；检索热工作集 1264MB 已含在其中。
   - 额外 0.3–0.7GB 是**后端连接进程 + 非缓冲数据/临时结构**（属 RSS，非 shared_buffers、非 OS 页缓存）。
   - OS 页缓存是 shared_buffers 之外的**第 2 层缓存**，由 OS 自由支配剩余内存，不计入进程 resident；故 3GB 与 OS 页缓存不叠加。
4. **7.8GB 是否代表稳态？**
   - **不代表观测稳态，是「各进程常驻上限之和」**（容量规划上界）。真实稳态 RSS 通常更低（进程不全在峰值、OS 回收）。**本轮无任何目标机运行时实测**，所有数字为【估算】/【源码推断】/【已有历史实测(开发机)】。不得伪造为实测值。

> ⚠️ **结论降级**：原报告把 7.8GB 表述为「稳态常占」偏绝对；修正为「**常驻上限之和 ≈7.8GB，真实稳态低于此，目标机须压测确认**」。

### 3.2 三档服务器配置评估（Phase 0.5-R 修正）

> 内存口径：以「常驻上限之和 ≈7.8GB」为基准；真实稳态 RSS 通常更低；组合峰值 ≈9–11GB（估算，无实测）。下述「理论内存余量」按上限口径算，偏保守。

| 档位 | CPU | RAM | 磁盘 | 部署范围 | 理论内存余量(上限口径) | CPU 并发风险 | 建议限制并发任务 | 未验证风险 | 采购结论 |
|---|---|---|---|---|---|---|---|---|---|
| **4C8G** | 4 核 | 8 GB | 80–120 GB SSD | 全栈同机(硬塞) | ≈0.2 GB（峰值 9–11GB **远超 8GB** → OOM 高危） | 高（ONNX 4 线程占满 4 核，ASR/PG 无余） | 不可行，不建议 | 峰值必超物理内存；托管 PG 可能锁 `shared_buffers`→检索退回 30ms | ❌ **不建议采购**（连 Runbook 2C4G 仅够检索子系统都不够全栈） |
| **4C16G** | 4 核 | 16 GB | 120 GB SSD | 全栈同机 | ≈8.2 GB（充裕） | 中高（4 核，ONNX 占满后 ASR/PG 争抢） | 检索 ≤4 QPS；ASR 串行(本就1)；转换串行 | CPU 饱和致检索延迟上升；无实测 | ⚠️ **可作低成本试运行候选**（预算紧/流量低）；CPU 为瓶颈，非推荐 |
| **8C16G（优先）** | 8 核 | 16 GB | 120 GB SSD | 全栈同机 | ≈8.2 GB；峰值 9–11GB < 16GB | 低–中（ONNX4+whisper2+PG1–2+杂项，余 1–2 核） | 检索 ≤20–50 QPS（连接池 5–10 已限）；ASR 串行；转换串行 | 组合峰值 CPU 饱和（S6）；无目标机实测 | ✅ **优先候选，待压测**（推荐首版） |

> **价格**：国内主流云（阿里云/腾讯云/华为云）8C16G 按量/包年需**【待采购报价】**；轻量应用服务器通常封顶 4C8G，故全栈 8C16G 需标准 ECS/CVM，预算显著高于 Runbook 假设的 2C4G 轻量机。
> **分类口径**：「不建议采购」= 内存上界已超物理内存；「低成本试运行候选」= 内存够但 CPU 受限，仅适合低流量验证；「优先候选待压测」= 资源最匹配，但仍需目标机压测确认峰值不 OOM/不失速。

### 3.3 8C16G 六场景可行性（Phase 0.5-R 修正）

| # | 场景 | 内存（上限口径） | CPU | 可行性 | 说明 |
|---|---|---|---|---|---|
| S1 | 稳态常驻（全服务空闲） | ~7.8GB（上限）；真实更低 | 近 0 | ✅ 充裕 | 16GB 余 ~8GB 给 OS 页缓存 |
| S2 | 找书检索并发（10–50 QPS） | ~8GB | ONNX encode(4 线程)+PG | ✅ 可行 | CPU 余量可扛中小并发；连接池 5–10 限流【源码推断】 |
| S3 | ASR 转写（单/少量） | ~8.5–9GB | whisper 占 2 核 | ✅ 可行 | sidecar 单进程串行，多上传排队 |
| S4 | OCR 识别（Node 收图+OCR） | ~8.2GB | 轻 | ✅ 可行 | `memoryStorage` 50MB 上限【已由源码验证】 |
| S5 | Convert 批处理（PDF→PNG） | ~8.4GB | PyMuPDF 单任务 | ✅ 可行 | 原子认领，串行 |
| S6 | 组合峰值（检索+ASR+Convert） | ~9–11GB | 8 核被占满 | ⚠️ CPU 饱和风险 | 需限流/队列化解；内存仍 <16GB |

**结论（8C16G）**：内存上限口径余量 ≈8.2GB、峰值 <16GB；唯一风险是 S6 的 CPU 饱和，可经 Caddy/应用层限流化解。**8C16G 为全栈常驻+中等并发的优先候选，但所有数字为【估算】，须目标机压测确认。**【待实际压测】

### 3.3 8C16G 在 6 个场景下的可行性

| # | 场景 | 内存占用 | CPU 占用 | 可行性 | 说明 |
|---|---|---|---|---|---|
| S1 | 稳态常驻（全服务空闲待命） | ~7.8 GB | 近 0 | ✅ 充裕 | 16GB 余 ~8GB 给 OS 页缓存 |
| S2 | 找书检索并发（10–50 QPS discover） | ~8 GB（基本不变） | ONNX encode(4 线程)+PG 主导 | ✅ 可行 | CPU 余量可扛中小并发；连接池 5–10 限流 |
| S3 | ASR 转写（单/少量并发） | ~8.5–9 GB | whisper 占 2 核 | ✅ 可行 | sidecar 单进程**串行**，多上传排队，不爆内存 |
| S4 | OCR 扫描识别（Node 收图+OCR） | ~8.2 GB | 轻 | ✅ 可行 | `memoryStorage` 临时缓冲，50MB 上限【已由源码验证】 |
| S5 | Convert 批处理（PDF→PNG） | ~8.4 GB | PyMuPDF 单任务 | ✅ 可行 | `UPDATE…RETURNING` 原子 claim，串行 |
| S6 | 组合峰值（检索+ASR+Convert 同时） | ~9–11 GB | **8 核被占满**（ONNX4+whisper2+PG1–2+杂项） | ⚠️ 可行但有 CPU 饱和风险 | 需限流/队列化解；内存仍 < 16GB |

**结论（8C16G）**：稳态 49% 内存占用、峰值 < 16GB、6 场景均不 OOM；唯一风险是 S6 的 CPU 饱和，可通过 Caddy/应用层并发限流（队列）化解。**8C16G 为全栈常驻 + 中等并发的推荐档**【估算，待实际压测】。

---

## 4. 私有文件存储完整链路审计（Phase 0.5-R 补证）

> ⚠️ **重要区分**：本节只讨论**用户私有文件**（OCR 图片 / ASR 媒体 / 转换文件）。词库 R2 桶 `shushu-public` **已上线、属另一桶**，与本审计无关，切勿混淆；私有 R2 桶 `shushu-private` 目前**仅设计、未实现**。
> 本轮逐项追踪「上传 → 落盘 → 路径生成 → DB 记录 → 读取/下载 → 删除/清理」，结论均附**文件路径 : 行号**；无法从源码确认处明确标「未证实」。

### 4.0 证据基线（当前运行时实测 = 无）

- 本轮为**只读**审计，未启动任何服务、未连库、未跑 Worker。
- 因此内存/文件落盘结论一律为 **【已由源码验证】**（读码确认逻辑）或 **【源码推断】**；**没有任何一项是「当前运行时实测」**。下文的「会 / 不会」「永不 / 永久」均指**代码既定行为**，非本次观测到的运行态。

### 4.1 三链路 12 问对照表（OCR / ASR / Convert）

| # | 问题 | OCR（素材识别） | ASR（音视频转字幕） | Convert（格式转换） |
|---|---|---|---|---|
| Q1 原始上传文件 | multer `memoryStorage`（内存，不落临时文件）；`saveImage` 落 `data/ocr` | multer `memoryStorage`（内存）；`submit` 时 `saveMedia` 落 `data/asr/in/<jobId>/<安全名>` | multer `memoryStorage`（内存）；upload 路由 `writeFile` 落 `data/convert/<uuid>` |
| Q2 中间产物 | Paddle 任务在外部 SaaS，不在本机；`raw_ocr_json` 存 DB | sidecar 写 `data/asr/out/<jobId>.json`（canonical transcript） | Worker 写 `data/convert/<taskId>/<文件>`（转换中间产物） |
| Q3 最终产物 | 文本 `result_text`+`raw_ocr_json` 存 `scan_records`（DB）；原图保留 `data/ocr` | 转录结果存 `AsrJobStore`（**Node 内存**）；`out/*.json` 留盘 | 结果文件 `data/convert/<taskId>/*`；DB `convert_files`(结果行)+`convert_tasks` |
| Q4 是否用 `server/data/` | ✅ `data/ocr` | ✅ `data/asr/in`、`data/asr/out` | ✅ `data/convert` |
| Q5 路径配置项 | `OCR_STORAGE_DIR`（默认 `data/ocr`，config.ts:150） | `ASR_DATA_DIR`（默认 `data/asr`）；`ASR_OUT_DIR`（sidecar，默认 `data/asr/out`，config.py:18 / sidecar.ts:47） | `CONVERT_STORAGE_DIR`（默认 `data/convert`，config.ts:151 / worker config.py:45） |
| Q6 DB 表/字段 | `scan_records.image_path`（**相对路径**）、`image_name`、`mime_type`、`size_bytes`（repository.ts:52,311-312） | **无 DB 记录**（任务状态仅 Node 内存 `AsrJobStore`，jobStore.ts:40-41） | `convert_files(id, original_name, format, mime_type, size_bytes, storage_path)`；`convert_tasks(file_id FK, result_files jsonb, result_file_id)`（convertStore.ts:31-37,80-103） |
| Q7 关联用户 ID | ❌ 否（`scan_records` 无 owner/user 列） | ❌ 否（应用当前无账号体系） | ❌ 否（`convert_files`/`convert_tasks` 无 owner/user 列） |
| Q8 下载权限校验 | **无下载端点**（原图不对外提供：ocr.ts 仅 `POST /material` + `GET /jobs/:scanId`） | **无下载端点**（结果在内存，轮询返回 transcript） | ⚠️ **仅按 `fileId`(uuid) 取，无 owner 校验**（convert.ts:238-253 单文件下载、256-301 ZIP/下载）；应用无账号体系，属「靠 uuid 不可猜」而非鉴权 |
| Q9 删 DB 记录是否删文件 | **无删除 `scan_records` 的代码** → 图片永不删 | 任务终态 `removeMedia` 删 `in/`（service.ts:82,109,133,143,154）；但 `out/*.json` **永不删**；Node 崩溃则 `in/` 也不删 | Worker `finally` 删**源磁盘文件**（不删源 DB 行，worker.py:52-60,113-115）；`success` 结果经 TTL 定时器删盘+清 `result_files`（convertStore.ts:151-208） |
| Q10 孤儿/清理缺口 | ⚠️ 图片**只写不删** → 磁盘无限增长；无 TTL | ⚠️ `out/*.json` **永不删** → 无限增长；⚠️ 崩溃时 `in/<jobId>/` 成孤儿；内存任务重启全丢 | ⚠️ 源 `convert_files` 行**永不删**（文件已删→悬空 storage_path）；⚠️ 上传未建任务→源文件+行永久孤儿；failed 任务残留结果可能留盘 |
| Q11 重启后仍可用 | 图片在盘+路径在 DB → 可解析（但无端点取） | 内存任务全失（用户须重提）；`in/``out/` 孤儿残留 | 文件在盘+任务在 PG → 可用；Worker 重启可 `reclaim_stale_tasks` 续跑 |
| Q12 DB/文件备份一致 | 须同窗备 `data/ocr`+DB（`image_path` 为相对路径，须连同 storageDir 根备） | 内存任务不可备；`data/asr` 可备但重启即废，无语义价值 | `convert_files`/`convert_tasks` 随 PG 备；`data/convert` 须同窗备以保证 `storage_path` 可解析 |

### 4.2 各链路证据链（文件:行）

**OCR（素材识别）**
- 上传：multer `memoryStorage`（`upload.ts:56-78`）；`saveImage` 写 `{year}/{month}/{hex24}{ext}`，返回**相对路径**（`storage.ts:43-69`）。
- 入库：`pipeline.submit` 把 `saved.relativePath` 存 `scan_records.image_path`（`pipeline.ts:150-162`；列定义在 `repository.ts:52,311-312`）。
- 读取/下载：**全仓无 `unlink`/删除 `scan_records` 代码，无图片下载路由**（grep `server/src` 仅 `asr/mediaStore` 与 `convertStore` 有 `rm`/`unlink`；`ocr.ts` 仅有 `POST /material` 与 `GET /jobs/:scanId`）。→ 原图永久留存。
- 结论：DB 关联✅、相对路径✅、清理❌（无限增长）。【已由源码验证】

**ASR（音视频转字幕）**
- 上传：`memoryStorage`（`upload.ts:34-54`）；`submit` → `saveMedia` 写 `data/asr/in/<jobId>/<安全名>`（`mediaStore.ts:31-37`、service.ts:65-72）。
- 推理：仅把路径传给 sidecar；sidecar 原子写 `data/asr/out/<jobId>.json`（`job_queue.py:200-206`；`ASR_OUT_DIR` 见 `config.py:18` / `sidecar.ts:47`）。
- 状态：**仅 Node 内存 `AsrJobStore`**（`jobStore.ts:40-41`），`process` 重启即失。
- 清理：终态 `removeMedia` 删 `in/`（`service.ts` 多处）；**`out/*.json` 无删除逻辑**（grep `asr_service` 无任何 `remove`/`unlink`/`rmtree`）。→ `out/` 无限增长。
- 崩溃：`main().catch` 走 `process.exit(1)` **不调用 `shutdown()`**（`index.ts:149-153`），`removeMedia` 不执行 → `in/<jobId>/` 成孤儿。
- 结论：DB 关联❌、原媒体临时落盘+终态清、结果 JSON 永久留存、`in/` 崩溃孤儿。【已由源码验证】

**Convert（格式转换）**
- 上传：`memoryStorage`（`convert.ts:118-136`）；`createFile` 生成 `fileId=uuid`、`storage_path=${dir}/${fileId}`，再 `writeFile`（`convert.ts:163-172`；`convertStore.ts:29-37`）。
- 任务：`convert_tasks` 行（`convert.ts:183-212`）。
- Worker：`claim_task` 原子认领（`db.py:77-104`）→ 源路径 `get_source_path`（`db.py:106-110`）→ 结果写 `data/convert/<taskId>/`（worker.py:81-82）→ `commit_success` 登记结果 `convert_files`（`db.py:112-150`）→ `finally` 删**源磁盘文件**（`worker.py:113-115` → `_cleanup_source` 仅 `os.remove(source_path)`）。
- 清理定时器：`cleanupExpiredResultFiles` **仅删 `status='success'` 的结果文件**（convertStore.ts:151-208），清 `result_files`/`result_file_id`，保留任务行。
- **孤儿确认**：① 源 `convert_files` 行**永不删**（DB 行悬空指向已删文件）；② 上传后未建任务 → 源文件+行永久孤儿（无清理路径触及）；③ `out/<taskId>/` 目录在结果清理后残留空目录。**全仓无 `DELETE FROM convert_files`**（grep 确认）。
- 下载：`GET /files/:fileId/download` 与 `GET /tasks/:taskId/zip` 仅按 id 取，**无 owner/权限校验**（convert.ts:238-253,256-301）。
- 结论：落盘✅、DB 关联✅(但源行悬空)、下载无鉴权⚠️、孤儿缺口⚠️。【已由源码验证】

### 4.3 三方案比较（与 Phase 0.5 原 §4.2 一致，补充结论）

| 维度 | A. VPS 本地磁盘（现状） | B. R2 私有桶（设计未实现） | C. 大陆可达 OSS（如阿里云 OSS/COS） |
|---|---|---|---|
| 上传 | 本地写，最快 | S3 API，略增延迟 | SDK 上传，大陆快 |
| 下载 | 回环/同机，最快 | 签名 URL；Cloudflare 出海快、**大陆慢** | 大陆 CDN 快 |
| 持久性 | 单盘（依赖磁盘/RAID） | 11 个 9 | 高（多副本） |
| 备份 | 需自建 rsync/快照（须含 `data/{ocr,convert,asr}`） | R2 自带+跨区 | 自带+跨区域 |
| 成本 | 含在 VPS 内 | 存储+请求费【待采购报价】 | 存储+流量【待采购报价】 |
| 工作量 | 低（已实现） | 中 | 中 |
| 单点风险 | 高（盘故障即丢；且当前无清理→**磁盘无限增长**） | 低 | 低 |

### 4.4 推荐路径（修订）

1. **上线即采用 A（本地磁盘 + 定期备份 + 补清理）**：零开发、最快上线；但 Phase 1 **必须补三类清理**（见 §8 新增 B9–B11），否则磁盘持续膨胀。
2. **中期迁移 B/C**：待 Phase 1 稳定，且**必须补 owner 关联 + 签名 URL 鉴权**（当前下载接口零鉴权，详见 §8 B12）。
3. **绝不混淆**：词库 `shushu-public` 已用，私有文件用独立桶/目录，权限与生命周期分开管。

---

## 5. Caddyfile 与 systemd 配置草案（占位，不写入仓库）

> 以下均为**草案占位**，含 `<...>` 占位符；真实值由 Phase 1 实施时填入环境变量文件。

### 5.1 目录规划

```
/srv/shushu/
├── frontend/dist/          # 前端构建产物（Caddy 直接 serve）
├── server/                 # Node 后端（含 dist/）
├── api/                    # Discover FastAPI + bge-m3-onnx/
├── convert_worker/         # Convert Worker
├── data/{ocr,convert,asr}  # 私有文件落盘
├── env/                    # *.env（权限 600，gitignore）
└── var/log/shushu/         # 日志
```

### 5.2 Caddyfile 草案

```caddyfile
# 述树 production Caddyfile（草案/占位，未写入仓库）
# 仅 443/80 公网；后端全回环
tellshu.com {
    encode zstd gzip

    # 静态前端（SPA：未命中路径回退 index.html）
    handle {
        root * /srv/shushu/frontend/dist
        try_files {path} /index.html
        file_server
    }

    # 发现检索（FastAPI，保留 /api/discover 前缀）
    handle /api/discover/* {
        reverse_proxy 127.0.0.1:8000
    }

    # 其余 API（Node Express，含 OCR/ASR/Convert）
    handle /api/* {
        reverse_proxy 127.0.0.1:8787
    }

    # 安全头（草案）
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options "nosniff"
        X-Frame-Options "DENY"
        -Server
    }
    # TLS 由 Caddy 自动 ACME（Cloudflare DNS 验证）；限流可后续加
}
```

### 5.3 systemd 单元草案

```ini
# /etc/systemd/system/shushu-node.service（草案/占位）
[Unit]
Description=ShuShu Node API
After=postgresql.service network-online.target
Wants=postgresql.service

[Service]
User=shushu
WorkingDirectory=/srv/shushu/server
EnvironmentFile=/srv/shushu/env/node.env
ExecStart=/usr/bin/node dist/src/index.js
Restart=on-failure
RestartSec=3
# ASR sidecar 是 Node 子进程，无独立单元；Node 重启即重拉

[Install]
WantedBy=multi-user.target
```

```ini
# /etc/systemd/system/shushu-discover.service（草案/占位）
[Unit]
Description=ShuShu Discover API (FastAPI + BGE-M3 ONNX)
After=postgresql.service network-online.target

[Service]
User=shushu
WorkingDirectory=/srv/shushu/api
EnvironmentFile=/srv/shushu/env/discover.env
ExecStart=/srv/shushu/api/venv/bin/uvicorn main:app --host 127.0.0.1 --port 8000 --workers 1
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```ini
# /etc/systemd/system/shushu-convert.service（草案/占位）
[Unit]
Description=ShuShu Convert Worker
After=postgresql.service network-online.target

[Service]
User=shushu
WorkingDirectory=/srv/shushu/convert_worker
EnvironmentFile=/srv/shushu/env/convert.env
ExecStart=/srv/shushu/convert_worker/venv/bin/python worker.py
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

> PostgreSQL / Caddy 用发行版自带单元（`postgresql.service` / `caddy.service`），无需自建。

### 5.4 环境变量清单（占位，真实值进 `env/*.env`，权限 600，gitignore）

| 变量 | 用途 | 示例/占位 |
|---|---|---|
| `DATABASE_URL` | PG 连接（回环） | `postgresql://shushu:<PW>@127.0.0.1:5432/shushu` |
| `NODE_PORT` | Node 监听 | `8787` |
| `ASR_SIDECAR_PORT` | ASR sidecar | `8177` |
| `CORS_ORIGIN` | 显式来源白名单【已由源码验证】 | `https://tellshu.com` |
| `OCR_STORAGE_DIR` / `CONVERT_STORAGE_DIR` / `ASR_DATA_DIR` | 私有文件落盘 | `/srv/shushu/data/{ocr,convert,asr}` |
| `EMBEDDING_BACKEND` | 编码后端 | `onnx` |
| `ONNX_MODEL_PATH` / `ONNX_THREADS` | ONNX 模型与线程 | `/srv/shushu/api/bge-m3-onnx/model_int8.onnx` / `4` |
| `ADMIN_TOKEN_SHA256` | 管理接口鉴权（sha256+timingSafeEqual）【已由源码验证】 | `<sha256 hex>` |
| `R2_*` | 词库公共桶凭据（已用，勿与私有混） | `<placeholder>` |

### 5.5 PostgreSQL 备份脚本草案（占位）

```bash
#!/usr/bin/env bash
# /srv/shushu/scripts/pg_backup.sh（草案/占位）
set -euo pipefail
BACKUP_DIR=/srv/shushu/var/backup/pg
DATE=$(date +%F-%H%M)
mkdir -p "$BACKUP_DIR"
# 全量 dump（压缩）
PGPASSWORD="$PG_PASS" pg_dump -h 127.0.0.1 -U shushu -F c -f "$BACKUP_DIR/shushu_$DATE.dump" shushu
# 私有文件一并打包
tar -czf "$BACKUP_DIR/files_$DATE.tgz -C /srv/shushu/data ocr convert asr
# TODO(Phase 1): 上传到 R2 / 异地；保留 N 日；首次做恢复演练
```

---

## 6. 备份与恢复设计

| 项目 | 方案 | 标签 |
|---|---|---|
| **PG 全量备份** | 每日 `pg_dump -Fc`；保留 7–30 日；与文件备份同时间戳 | 【设计】 |
| **WAL / PITR** | 建议开 `archive_mode=on` + WAL 归档到异地，支持时间点恢复（数据有回收价值） | 【待实际压测】+【设计】；当前本机 PG 未确认归档配置【已由历史报告：本机 PG 参数仅 shared_buffers/effective_cache_size 被调，归档未动】 |
| **私有文件备份** | `data/{ocr,convert,asr}` 随 PG 同窗口 `tar`；异地 rsync / R2 | 【设计】 |
| **异地（offsite）** | 备份副本推到第二区域 / R2（非同盘），防单盘故障 | 【设计】 |
| **恢复演练** | 上线后做首次 `pg_restore` + 文件解包演练，记录 RTO/RPO；之后每季度一次 | 【设计，待 Phase 1 执行】 |
| **迁移回滚（DB schema）** | ⚠️ 当前迁移仅有前向幂等（`IF NOT EXISTS`），**无 down migration**【已由源码确认 001–005】→ schema 回滚只能靠**备份恢复**，不是 `migrate down` | 【已由源码验证】 |
| **应用版本回滚** | git tag 锁定发布基线；`dist/` 由对应 commit 重建；`systemctl restart` 切回旧版 | 【设计】 |
| **文件-DB 一致性** | OCR `image_path` / Convert `storage_path` 与磁盘文件须同源备份；接受「备份窗口内极小不一致」风险，或备份前短暂停写 | 【设计】 |

---

## 7. 生产安全检查表

| # | 检查项 | 状态 | 标签 |
|---|---|---|---|
| 1 | 所有后端 bind `127.0.0.1`，仅 Caddy 公网 | ✅ 源码已满足 | 【已由源码验证】 |
| 2 | TLS 自动 ACME + HSTS + 安全头 | ⬜ 待 Phase 1 配 Caddy | 【设计】 |
| 3 | CORS 显式白名单（`CORS_ORIGIN`），禁 `*` | ✅ 源码已满足 | 【已由源码验证】 |
| 4 | 管理接口 sha256 + `timingSafeEqual` + Bearer | ✅ 源码已满足 | 【已由源码验证】 |
| 5 | 上传 `memoryStorage` + 扩展名白名单 + 50MB 上限 | ✅ 源码已满足 | 【已由源码验证】 |
| 6 | 错误处理器不泄露堆栈 / 内部细节 | ✅ 源码已满足 | 【已由源码验证】 |
| 7 | 密钥仅 `.env`（权限 600），不入库 | ✅ 约定；Phase 1 落实 | 【已由配置验证】+【设计】 |
| 8 | 防火墙仅开 443/80，SSH 限 IP / 改端口 | ⬜ 待 Phase 1 | 【设计】 |
| 9 | 反向代理层限流（防 ASR/检索被打满） | ⬜ 待加 | 【设计】 |
| 10 | 依赖定期审计 / 更新（Node/Python/PG） | ⬜ 待建流程 | 【设计】 |
| 11 | 备份加密 + 异地 | ⬜ 待 Phase 1 | 【设计】 |
| 12 | 日志不记密码 / 令牌 / 隐私 | ✅ 结构化日志约定 | 【已由配置验证】 |

---

## 8. 尚未解决的上线阻塞项（Phase 0.5-R 更新）

| # | 阻塞项 | 严重度 | 说明 / 证据 |
|---|---|---|---|
| B0 | **发布基线未锁定 + `dist/` 重建** | P0 | `dist/` 陈旧、源码未提交；须 git tag + 全流程 `tsc --noEmit`/`npm test`/`npm run build` 后重建【已由 Phase 0 验证】 |
| B1 | **缺反向代理 + TLS** | P0 | 仓库无 Caddy/Nginx 配置；全部后端裸奔回环，无公网入口【已由源码验证】 |
| B2 | **缺进程编排** | P0 | 无 systemd 单元；无法常驻/自愈【设计缺口】 |
| B3 | **缺备份脚本** | P1 | §6/§5.5 仅草案；本机 PG 未确认归档【已由历史报告】 |
| B4 | **ASR sidecar 死亡不自愈 + 孤儿风险** | P1 | 【已由源码验证】`sidecar.ts:175-181` dead 终态；`main().catch`→`process.exit(1)` 不调 `shutdown()`（index.ts:149-153）；spawn 无 `detached`（sidecar.ts:39-57）。→ ① Node 存活时 sidecar 死→ASR 永久 503；② Node 被 SIGKILL / 崩溃时 sidecar 孤儿化，若 systemd 重启 Node 则新 sidecar bind 8177 失败→ASR 仍 503。部署约束见 §2.5.6；建议外部探针兜底 `restart shushu-node`。 |
| B5 | **私有文件 R2 未实现** | P2（非阻塞） | 仅设计；上线可先用本地+备份【§4】 |
| B6 | **无 down migration** | P2 | schema 回滚靠备份【已由源码验证】 |
| B7 | **`shared_buffers=2GB` 目标机可调性** | P1 | 托管 PG 小实例可能锁死参数→检索退回 30ms 档；选自备 VPS 则自由【已由配置验证】+【待采购报价】 |
| B8 | **大陆访问速度** | P2 | Cloudflare R2 + 静态若走 CF CDN，大陆用户可能慢；DNS/CDN/HTTPS 归 Phase 1 |
| **B9** | **OCR 图片无限增长（无清理）** | P1 | 【已由源码验证】`scan_records.image_path` 只写不删；全仓无 `unlink`/删除 `scan_records` 代码、无图片下载路由（§4.2 OCR）。上线须补 TTL/定期归档，否则磁盘持续膨胀。 |
| **B10** | **ASR `out/*.json` 无限增长 + 崩溃 `in/` 孤儿** | P1 | 【已由源码验证】sidecar 写 `data/asr/out/<jobId>.json` 无清理（grep `asr_service` 无 remove）；Node 崩溃时 `in/<jobId>/` 不被 `removeMedia` 清理（§4.2 ASR Q10）。须补 out/ TTL 清理 + 启动期 in/ 扫描清理。 |
| **B11** | **Convert 源 `convert_files` 孤儿行 + 上传无任务孤儿** | P1 | 【已由源码验证】Worker 仅删源磁盘文件、不删源 DB 行（worker.py:52-60）；全仓无 `DELETE FROM convert_files`；上传后未建任务→源文件+行永久孤儿（§4.2 Convert Q10）。须补源行 TTL/孤儿清理。 |
| **B12** | **Convert 下载零鉴权** | P2 | 【已由源码验证】`GET /files/:fileId/download`、`/tasks/:taskId/zip` 仅按 uuid 取，无 owner/权限校验（convert.ts:238-253,256-301）。应用当前无账号体系，属「靠 uuid 不可猜」；迁移 R2 私有桶时须补 owner + 签名 URL 校验。 |

---

## 9. Phase 1 实施顺序与验收标准

### 9.1 实施顺序

1. **锁定发布基线**：git tag（如 `release/v1.0.0`）；前端/后端跑通 `tsc --noEmit` / `npm test` / `npm run build`；产出可信 `dist/`。
2. **准备 VPS**：装 Debian/Ubuntu；防火墙（仅 443/80 + SSH 限 IP）；建 `shushu` 用户；建 `/srv/shushu` 目录树；装 Node / Python venv / PostgreSQL 18 + pgvector 0.8.6。
3. **部署 PostgreSQL**：`shared_buffers=2GB` + `effective_cache_size=8GB`；`pg_restore` 导入 dump；`SHOW` 复核；开 WAL 归档（建议）。
4. **部署后端三进程**：Node（spawn ASR）、Discover（uvicorn onnx）、Convert Worker；落 systemd 单元（`Restart=on-failure`，`After=postgresql`）。
5. **部署前端 + Caddy**：放 `dist/`；写 Caddyfile（§5.2）；启 ACME TLS；验证 443 反代到回环。
6. **ASR 生命周期加固（建议）**：Node 内对 sidecar `exit` 加有限次 respawn（解决 B4）；或接受「靠 Node 重启恢复」并在监控里告警。
7. **备份 + 演练**：落 `pg_backup.sh` + 定时任务；首次 `pg_restore` + 文件解包演练，记录 RTO/RPO。
8. **冒烟 + 安全自检**：逐项过 §7；外部探针打 `/api/health`。

### 9.2 验收标准

| 项 | 验收口径 | 标签 |
|---|---|---|
| 构建 | `tsc --noEmit` / `npm test` / `npm run build` 全绿；`dist/` 与 tag 一致 | 【待 Phase 1 执行】 |
| PG | `SHOW shared_buffers`=2GB、`SHOW effective_cache_size`=8GB；连接池正常 | 【已由配置验证】（目标机待复核） |
| 健康 | `GET /api/health`=200、`/api/discover/health`=ok、`/api/convert/health`=ok | 【已由源码验证】 |
| 检索 | discover retrieve P95 < 15ms（同 B.12 热态口径） | 【待实际压测】 |
| ASR | 单任务转写成功；sidecar 死亡后（若加 respawn）能恢复，否则 Node 重启后恢复 | 【待 Phase 1 执行】 |
| OCR/Convert | 上传图片 OCR 跑通；PDF→PNG 转换跑通 | 【待 Phase 1 执行】 |
| 备份 | 能 `pg_restore` + 文件解包恢复至干净机；RTO/RPO 记录 | 【待 Phase 1 执行】 |
| 安全 | §7 全部 ✅；CORS 仅白名单；TLS A 评级（SSL Labs） | 【待 Phase 1 执行】 |
| 资源 | 8C16G 稳态内存 < 10GB、峰值 < 16GB、无 OOM | 【估算，待实际压测】 |

---

## 附：结论可信度汇总（统一标签）

> 以下标签贯穿全文，Phase 0.5-R 修订后统一采用，便于区分「已证实」与「推算」：
> - **【已由当前源码验证】** 直接读源码/路由确认（含 file:line）。
> - **【已由配置验证】** 直接读配置文件或运行态 `SHOW` 实测（B.11/B.12）确认。
> - **【已有历史实测】** Phase 0 / 既往报告中的实测数字（检索时延、HNSW 体积等）。
> - **【当前运行时实测】** = **无**。本轮（含 Phase 0.5-R）为只读，未启动任何服务/进程/压测，无任何新运行时采集数据。
> - **【源码推断】** 由源码结构合理推断但未逐条压测（如崩溃路径、孤儿风险）。
> - **【估算】** 基于已知事实推算（组件 resident 上限之和、并发上限）。
> - **【未证实】** 受环境限制无法确认，明确标注待查。
> - **【待实际压测】** 需在目标 VPS 实测（内存峰值、并发、retrieve P95）。
> - **【待采购报价】** 价格需向云厂商询价。

| 标签 | 涵盖的关键结论 |
|---|---|
| 【已由当前源码验证】 | 全回环 bind；ASR 为 Node 子进程、spawn 无 `detached`、`child.on('exit')` 置 dead 终态无 respawn；`index.ts` 优雅 `shutdown()` 调 `asrProvider.close()`，但 `main().catch`→`process.exit(1)` 跳过 `shutdown()`；上传 `memoryStorage`+50MB；私有文件落盘路径（OCR `data/ocr/.../hex24.ext`、ASR `data/asr/in`+`out`、Convert `data/convert/<taskId>`）；OCR `scan_records.image_path` 存相对路径且无删除/下载接口；ASR `AsrJobStore` 为纯内存 `Map` 无 DB 行；Convert 下载接口 `GET /files/:fileId/download`、`GET /tasks/:taskId/zip` 以 uuid 取文件无 owner/鉴权；无 down migration；模型文件路径（config.ts / config.py）。 |
| 【已由配置验证】 | `shared_buffers=2GB`（postgresql.conf:132 + B.12 `SHOW` 实测）；`effective_cache_size=8GB`；R2 公共词库桶已用。 |
| 【已有历史实测】 | HNSW 索引 456MB；检索热工作集 ~1264MB；2GB shared_buffers 后 retrieve 8.4–8.9ms；本机 PG 归档未配置。 |
| 【当前运行时实测】 | **无**——本轮未做任何运行时采集。 |
| 【源码推断】 | SIGKILL/崩溃致 Node 异常退出会遗留孤儿 sidecar；systemd 重启 Node 后因 8177 被占而 bind 失败→永久 503；sidecar 自崩→永久 503；删除 DB 行不删磁盘文件；Convert Worker 删磁盘源文件不删 `convert_files` 行→孤立行。 |
| 【估算】 | 7.8GB 内存 = 各进程 resident 上限之和（非观测稳态）；OS/Node/Convert resident；8C16G 各场景可行性；各档并发任务上限。 |
| 【未证实】 | 「私有文件全部正确关联用户并随用户删除」——ASR 无任何用户/DB 关联，OCR/Convert 仅链路内关联；R2 `shushu-private` 为设计未落地。 |
| 【待实际压测】 | 8C16G/4C16G 内存峰值、CPU 并发上限、retrieve P95、备份 RTO/RPO。 |
| 【待采购报价】 | 8C16G / 4C16G 云价；R2 / OSS 存储与流量费。 |

---

## 10. Phase 0.5-R 补证记录

> 本轮目标：复核 Phase 0.5 关键结论，纠正「估算与实测混用」，补全私有文件存储链路与 ASR sidecar 生命周期证据。**仅修订本报告，未对任何系统/源码/配置/仓库做改动，未进入 Phase 1。**

### 10.1 私有文件存储链路

| 原结论 | 新证据（file:line） | 是否修正 | 修正后结论 | 仍未解决 |
|---|---|---|---|---|
| （Phase 0.5 隐含）私有文件有 DB 关联、路径可追溯、可随用户删除 | ASR：`AsrJobStore` 纯内存 `Map`（`jobStore.ts:40`），无 DB 行；媒体落 `data/asr/in/<jobId>/`，终态 `removeMedia`（`service.ts`/`mediaStore.ts`），`out/<jobId>.json` 永不清理（`asr_core/job_queue.py:200-206`，全仓无 unlink）；OCR：`scan_records.image_path` 存相对路径（`pipeline.ts:150-162`），图写 `data/ocr/<YYYY>/<MM>/<hex24>.<ext>`（`storage.ts:43-69`），全仓无删除/下载接口（`routes/ocr.ts`）；Convert：`convert_files`/`convert_tasks` 表，源文件 Worker 处理后删磁盘不删行（`convert_worker/worker.py:113-115`），结果 TTL 仅清 success（`convertStore.ts:151-208`），下载接口零鉴权（`routes/convert.ts:238-301`） | **是** | 三类链路性质不同：ASR 完全内存态、无 DB 记录；OCR 有 DB 记录但图片永不清删、无下载接口；Convert 有 DB 记录但源行孤立、结果零鉴权下载 | 缺统一私有文件服务/R2 落地；DB 行删除不联动磁盘；孤儿文件清理；下载鉴权 |

### 10.2 ASR sidecar 生命周期

| 原结论 | 新证据（file:line） | 是否修正 | 修正后结论 | 仍未解决 |
|---|---|---|---|---|
| ASR sidecar 为 dead 终态、崩溃循环防护 | `buildSidecarSpawn` 无 `detached`（`sidecar.ts:39-57`）；`close()` SIGTERM→3s→SIGKILL（`sidecar.ts:134-160`）；`child.on('exit')`→`_markDead` 注释「不自动重启」（`sidecar.ts:175-181`）；`index.ts` 优雅 `shutdown()` 调 `close()`（L115-146），但 `main().catch`→`process.exit(1)`（L149-153）**跳过** `shutdown()` | **是** | 正常退出：Node 优雅关机→`close()` 回收 sidecar；异常退出（SIGKILL/崩溃）：遗留孤儿 sidecar；systemd 重启 Node 后 8177 被占→bind 失败→永久 503；sidecar 自崩→永久 503；task 状态残留内存 `Map` | 无 systemd 级 sidecar 托管；崩溃后须人工重启；内存态 task 不可恢复 |

### 10.3 内存预算

| 原结论 | 新证据 | 是否修正 | 修正后结论 | 仍未解决 |
|---|---|---|---|---|
| 7.8GB 稳态；ASR ~0.48GB vs ~1GB 差异存疑 | 7.8GB = 各进程 resident 上限**估算之和**，非观测稳态；ASR 0.48GB=模型文件体积，1GB=RSS 估算；Discover 2GB=RSS 估算非模型文件大小（543MB）；PG ~3GB 未重复计算（检索热集 ~1264MB 已吸收于 `shared_buffers=2GB`） | **是** | 7.8GB 为上限估算和，标注【估算】；不得写为实测稳态；需压测确认 | 无【当前运行时实测】数据；峰值并发未测 |

### 10.4 服务器档位

| 原结论 | 新证据 | 是否修正 | 修正后结论 | 仍未解决 |
|---|---|---|---|---|
| 4C8G 不足；4C16G 候选；8C16G 首选 | 按三维度重评（理论内存余量 / CPU 并发风险 / 建议并发上限 / 未验证风险 / 采购结论） | **是** | 4C8G=**不建议采购**；4C16G=**低成本试运行候选**；8C16G=**优先候选待压测** | 无实际压测数字；CPU 并发上限未测 |

> 本轮（Phase 0.5-R）止步于补证与修订，**未对任何系统/源码/配置/仓库做改动，未进入 Phase 1**。请审核。
