# 格式转换·执行前检查表（Pre-Execution Checklist）

> 用途：在「启动 PostgreSQL → 确认迁移 → 恢复 API → 启动 Worker → PDF→PNG 端到端」之前，先固化所有只读核查结果。
> 本文件为**检查表**，不含任何已执行的启动/安装/写库动作。所有「待执行」项均需单独授权后才会运行。
> 采集时间：2026-10-20 22:47 初版；23:0x 增补 Phase A 只读补证。全部为只读采集。

---

## ⛔ 冻结标注（2026-10-21 00:1x 追加，来源：B.12 启动控制权核查 + 用户决策）

**并发控制权问题已确认**：本机存在两个任务各自规划启动同一个 PostgreSQL 数据目录
（`D:\Program Files\PostgreSQL\data`）—— 本清单（格式转换）与 B.12 检索恢复。
日志证据：`FATAL: the database system is starting up` 在 2026-10-20 17:05 出现两次（重叠启动）。
详见 `B12-启动控制权核查报告.md`。

**用户决策：控制权优先级 = 述树检索恢复（B.12）优先；格式转换任务的 PostgreSQL 启动步骤暂缓。**

在 B.12 完成恢复、并明确交还控制权之前，**本清单及以下禁令同时生效**：

1. **不执行** `Start-Service postgresql-x64-18`，**不执行** 任何手动 `pg_ctl start/stop/restart`。
2. **不删除、重命名或覆盖** `D:\Program Files\PostgreSQL\data\postmaster.pid`
   （当前为陈旧锁文件：无任何 `postgres.exe` 进程与之对应）。
3. **不更改** 服务账户（`NT AUTHORITY\NetworkService`）、数据目录 ACL 或 PostgreSQL 任何配置
   （含 `shared_buffers` / `effective_cache_size`）。
4. **不停止** Express server、ASR sidecar(8177) 或任何其他会话的进程。
5. **不提交** 本文件及相关报告，**不覆盖** 其他会话的工作（含 Git 写操作）。

> 说明：这是**流程冻结**，不是删除步骤 2。步骤 2 的内容保留原样，
> 待 B.12 恢复完成、唯一控制方确认后，再按新的协调结果决定是否执行。
> 若另一会话仍在运行，执行前**先确认它当前正在做什么**，不要假定它空闲。

### 🔁 解除冻结的前置条件（2026-10-21 00:2x 追加 · 需对方会话明确回复）

> 本冻结**不是**靠等待自动解除。B.12 侧是单边标记，尚未取得本清单所属会话的确认。
> 恢复执行步骤 2 之前，需要**本清单所属会话明确回复以下三件事**（缺一不可）：

1. **已看到本冻结标注**，并同意「控制权优先级 = B.12 检索恢复优先」。
2. **当前没有**正在执行、即将执行或后台排队的 PostgreSQL 启动操作
   （包括 `Start-Service`、`pg_ctl`、任何脚本或后台常驻任务）。
3. **同意**在 B.12 完成 PostgreSQL 与检索 API(8000) 的恢复与验证、
   并由用户明确交还控制权之后，才解除本冻结。

> 补充口径：**一段时间没有新进程 ≠ 对方已同意交出控制权**。
> 进程静默只能作为辅助旁证，不能替代上述第 1–3 条的明确回复。
> 解除时请在本文件追加「🟢 冻结已解除（时间 + 解除人 + B.12 交还记录）」，**不要删除本段**。

---

## 0. 状态冻结快照（本轮已采集，执行阶段不再沿用旧值）

| 项 | 本轮实测 | 状态 |
| --- | --- | --- |
| 工作区变更 | `git status --short` 显示大量并行改动（发现书籍 Stage B/C、阅读器 V3.x、格式转换等）。格式转换相关未跟踪：`src/components/convert/`、`src/domain/convert.ts`、`src/services/convert/`、`src/lib/download.ts`；已修改：`src/pages/Import.tsx` | 已采集 |
| `git diff --check` | 仅 `server/src/scripts/crawl-books.ts` 与 `make-b10-execution-report.py` 有尾部空白告警（与格式转换无关） | 已采集 |
| PostgreSQL 服务 | `postgresql-x64-18`：**Stopped**，StartMode=Auto，StartName=`NT AUTHORITY\NetworkService` | 已采集 |
| 端口 5432 | 未监听（PG 未起） | 已采集 |
| 端口 8787 | 监听，归属 **PID 29088**（非 3268） | 已采集 |
| PID 3268 | **不存在**（Phase D 旧值已失效） | 已采集 |
| API 进程 | PID 29088，命令 `"D:\Program Files\nodejs\node.exe" dist/src/index.js`，监听 8787 | 已采集 |
| ⚠️ API 工作目录(CWD) | **WMI `CurrentDirectory` 为空，无法直接验证**。间接证据：`dist/src/index.js` 相对路径成功加载、dotenv 成功加载 `server/.env`（否则必填项 `DATABASE_URL` 缺失会令进程退出）→ 强烈推断 CWD=`server/`，但属推断非直接证明 | ❓ 间接推断/未直接验证 |
| ⚠️ PG 锁文件 | **`D:\Program Files\PostgreSQL\data\postmaster.pid` 存在（=True）**，但**无任何 `postgres.exe` 进程运行** → 这是上次未干净关闭留下的**陈旧锁文件**，是启动前的阻断项 | ⚠️ 阻断项 |
| 数据目录 ACL | `NT AUTHORITY\NETWORK SERVICE` 有 ReadAndExecute+FullControl；当前用户 `DESKTOP-NPCOU69\lagom` 也有 ReadAndExecute+FullControl → **两个账户都能访问同一数据目录**（这正是「两账户争用」风险的根因） | 已采集 |
| Worker | `server/.venv` 不存在，`fitz`/`PyMuPDF` 未安装 | 已采集 |
| Python 候选 | 托管解释器 `C:\Users\lagom\.workbuddy\binaries\python\versions\3.13.12\python.exe` **存在**，实报 `Python 3.13.14`（win32），pip 26.1.2 可用 → 解释器可行 | 已采集 |
| `dist` 与源码 | `dist/src/routes/convert.js` 构建于 2026-10-20 14:40，晚于 `src/routes/convert.ts`（10-18 11:54）→ **dist 为当前构建** | 已采集 |

> ⚠️ **与 Phase D 的差异**：Phase D 记录的「PID 3268 运行 API」已失效，当前真实 API 为 **29088**。后续所有「重启 API」动作必须以 29088 为待核查目标，禁止沿用 3268。

---

## 1. 五处修正的落实情况

| 你的修正要求 | 本检查表如何落实 |
| --- | --- |
| **PG 启动不假定 `pg_ctl`** | 第 1 步先只读确认服务注册（账户/数据目录/PathName），第 2 步**优先用既有服务管理**；`pg_ctl` 仅在「服务启动因权限被拒」时作为回退，且明确标注其账户差异。 |
| **迁移判定不能只看两张表** | 第 3 步要求逐项比对 004/005 的**全部对象/列/约束/索引**，并说明 `migrate.ts` 无迁移历史表，验证只能靠结构比对。 |
| **数据库回滚默认不 `DROP TABLE`** | 回滚铁律（见文末）：默认停止服务+保留数据；`DROP` 仅在四项条件齐备且显式授权后才考虑。 |
| **Worker 安装属执行阶段** | 第 5 步只读核对解释器/依赖/`fitz`；`venv` 创建与 `pip install` 列为「需授权」动作，本轮不执行。 |
| **API 重启不盲目 `kill 3268`** | 第 4 步先重认 PID（实测 29088）、可执行文件、命令行、端口归属；仅确认无误且获授权后才停止。 |
| **`CONVERT_ENGINE_ENABLED=true` 非无条件** | 设为**门控动作**（见文末）：须 Step3+4+5 全通过且显式授权后才置位并重启 API；此前入口保持 503。 |

---

## 2. Phase A 只读补证结果（2026-10-20 23:0x，回应 6 项修正）

### P0-① PostgreSQL 启动回退（两账户争用风险，已证实）
- **数据目录 ACL 证实两个账户均拥有 FullControl**：`NETWORK SERVICE` 与当前用户 `lagom`。
- 服务注册以 `NetworkService` 运行；若改以当前用户 `lagom` 跑 `pg_ctl start`，会变成**第二个账户持有同一数据目录**，与注册服务相互争用 —— 这正是需规避的。
- **结论**：优先修复「能否以 NetworkService 启动服务」的权限路径；**禁止**「服务起不来就直接用 `lagom` 跑 pg_ctl」作为默认回退。pg_ctl 仅在服务方式彻底不可行、且确认不会同时存在一个服务实例时才考虑，且须显式知晓其账户差异。
- **陈旧锁文件阻断项**：`postmaster.pid` 存在但无 postgres 进程 → 必须先处理（见步骤 2）。服务自启时通常会自检并清除指向已死 PID 的 pid 文件；若启动报错 pid 文件冲突，则仅在确认无 postgres 进程后、经授权才手动删除该文件。

### P0-② 迁移执行器事务边界（已读 004/005 全文确认）
- `migrate.ts`：按文件名升序，**逐文件** `client.query(sql)`，使用 simple query 协议（支持多语句含 `BEGIN/COMMIT`），**无外层事务、无迁移历史表**。
- `004_convert.sql`：**含 `BEGIN; … CREATE TABLE IF NOT EXISTS …; CREATE INDEX IF NOT EXISTS …; COMMIT;`** —— 整文件原子。
- `005_convert_result_files.sql`：**含 `BEGIN; DO $$ … ALTER TABLE … ADD COLUMN IF NOT EXISTS …; $$; COMMIT;`** —— 整文件原子。
- **失败判定**：PG simple query 协议中，文件内任一语句报错 → 该文件事务中止、已执行部分**回滚**，不会留下部分变更；`migrate.ts` 在首个错误即 `exit(1)` 并 `client.end()`，无悬挂事务。
- **重跑安全性 = 事务原子性 + DDL 幂等（`IF NOT EXISTS`）**。因此不能「只凭 IF NOT EXISTS 判定重跑安全」——更准确的说法是「事务保证单文件失败全回滚 + 幂等 DDL 保证重跑无害」。
- 仍须注意：`migrate.ts` **不写迁移历史表**，故「实际迁移记录」= 对象存在性比对，无独立日志。

### P0-③ API 进程工作目录（无法直接验证，已记录为缺口）
- WMI `CurrentDirectory` 返回**空**，无法从可用工具直接证明 CWD。
- 间接证据（非证明）：相对命令 `dist/src/index.js` 已成功加载；`loadDotenv()` 成功加载 `server/.env`（否则必填 `DATABASE_URL` 缺失会令进程启动即退出）→ 推断 CWD=`server/`。
- **处置**：停止/重启 29088 前，必须以显式 `cd server` 启动来保证 CWD 正确；或在授权重启前用可读取 CWD 的工具（如 Process Explorer）直接确认。缺口不得被当作已验证。

### P1-① 环境变量覆盖优先级
- `config.ts` 顶部 `loadDotenv()` 使用 dotenv 默认行为：**不覆盖已存在的 `process.env` 键**。即若 29088 启动时父环境已 export 了 `DATABASE_URL` 等，则 `.env` 中的同名值不生效；否则以 `.env` 为准。
- `CONVERT_ENGINE_ENABLED`：`parseBool(optional('CONVERT_ENGINE_ENABLED'))` → `optional` 缺失返回 `null` → `parseBool(null)` 返回 **`false`**。**缺省默认 = 关闭（安全默认）**。
- `package.json` `start` 脚本 = `node dist/src/index.js`，**无启动脚本注入环境变量**。但 29088 的实际启动环境（是否父 shell 已 export）未直接核实。
- 结论：`.env` 是配置来源之一但非唯一优先级；需结合「进程启动环境」判断 29088 实际生效值。

### P1-② Worker 安装可行性
- 候选解释器 `…\python\versions\3.13.12\python.exe` 存在，实报 `Python 3.13.14`（win32），pip 26.1.2 可用 → **解释器本体可行**。
- `requirements.txt`：`psycopg2-binary>=2.9,<3`、`python-dotenv>=1.0,<2`、`PyMuPDF>=1.24,<2`（注释提示 PyMuPDF 版本需按 2026 最新稳定版核实）。
- **不能因 requirements 存在就认定安装必然成功**：需在授权安装时实际拉取，确认 cp313-win_amd64 轮子可用（PyMuPDF/psycopg2-binary 均提供 Windows 轮子，预期可行，但属「待安装实测」，非本论验证）。

### P1-③ 清理与回滚边界（已读 convertStore.ts / worker.py 确认）
- **API TTL 清理**（`ConvertStore.cleanupExpiredResultFiles`）：仅 `SELECT … WHERE status='success' AND created_at < now()-ttl` → 对每条任务的 `result_files`（jsonb 数组）逐个查 `convert_files.storage_path` 后 `unlink` **具体路径**；**不扫描目录、不递归、不触碰其他功能文件**；随后清空该任务的 `result_files`/`result_file_id`（保留任务记录供审计）。作用域仅限转换结果目录。
  - ⚠️ 前提：`CONVERT_STORAGE_DIR`（默认 `data/convert`）须与 `OCR_STORAGE_DIR`(`data/ocr`)、`ASR_DATA_DIR`(`data/asr`) **物理隔离**，否则清理可能误伤。需在执行阶段确认三者路径无重叠。
- **Worker 源文件删除**（`_cleanup_source`）：仅在任务 `finally` 中删除**该任务源文件的具体 `source_path`**（来自 `convert_files.storage_path`），`os.remove` 单文件，非目录级清除。按设计「不长期留存用户文件」。
  - ⚠️ 含义：**测试输入源文件在处理完成后会被删除** → 端到端测试**必须使用专用 PDF 副本**，禁止拿真实用户文件或不可再生的样本直接提交。

---

## 3. 检查表主体（步骤 0–6）

图例：✅ 本轮只读已验证　⏳ 需 PG 起后执行　🔒 需单独授权　❓ 待补全

### 步骤 0 — 冻结当前状态（✅ 已完成本轮）
- 命令（只读）：见 §0 快照采集命令（git / Get-Service / Get-NetTCPConnection / Get-CimInstance）。
- 通过标准：已记录变更、确认 PG 状态与 5432 归属、确认 API 真实 PID 与端口、记录 `postmaster.pid` 陈旧锁与 CWD 缺口。
- 当前结果：见 §0 与 §2。
- 状态：✅ 已验证（含两项缺口标注）。

### 步骤 1 — 核实 PostgreSQL 启动方式（✅ 只读已完成，启动方式待定）
- 命令（只读）：`Get-CimInstance Win32_Service -Filter "Name='postgresql-x64-18'"`（Name/State/StartName/PathName/StartMode）、`Test-Path` bin 与 data、`Get-Acl` data 目录、`Test-Path data/postmaster.pid`。
- 本轮实测：服务 `Stopped`/`Auto`/`NetworkService`；PathName=`pg_ctl runservice -D "D:\Program Files\PostgreSQL\data"`；data 目录 ACL 含 `NetworkService` 与 `lagom` 双 FullControl；**`postmaster.pid` 存在但无 postgres 进程（陈旧）**。
- 通过标准：注册参数与实际路径一致；数据目录为现有目录；运行账户与目录权限已确认；主版本（18）一致；**陈旧 pid 文件已识别并制定处理口径（见步骤 2）**。
- 启动方式决策（执行阶段）：**优先启动既有 Windows 服务**（NetworkService 账户，ACL 已具备）；`pg_ctl` 不作为默认回退（见 P0-①）。
- 状态：✅ 只读已验证；🔒 启动方式决策待执行授权。

### 步骤 2 — 启动 PostgreSQL（🔒 需授权，优先服务管理，先处理陈旧锁）

> 🚫 **【暂缓执行 · 2026-10-21 00:1x 冻结】**
> 控制权已判定为 **B.12 检索恢复优先**（见文首「冻结标注」）。
> **在 B.12 完成恢复并明确交还控制权之前，本步骤不执行**，且以下动作一律禁止：
> 启动/停止服务、手动 `pg_ctl`、删除或改动 `postmaster.pid`、改服务账户与 ACL、改 PG 配置。
> 原内容保留如下，仅供协调完成后参考，**当前不作为可执行指令**。

- **前置阻断项**：`postmaster.pid` 陈旧。处理口径：
  - 首选：`Start-Service` 自启时 PG 会自检 pid 文件，指向已死 PID 则自动清除并启动。
  - 若启动报错「pid 文件冲突/已存在实例」：先 `Get-CimInstance Win32_Process` 确认**确实无 postgres.exe**；仅在确认无进程且获🔒授权后，才手动删除 `data/postmaster.pid`；删除后立即启动，不再二次操作。
- 候选命令（执行阶段，**按序尝试**）：
  ```powershell
  # 首选：既有服务管理（SCM 以 NetworkService 拉起，ACL 已具备，生命周期由系统托管）
  Start-Service -Name postgresql-x64-18
  # 若报「权限不足/Access Denied」（本机非管理员调用 SCM 受限）：
  #   正确路径是获取提升权限后仍以服务方式启动；
  #   非默认回退到 pg_ctl —— 若万不得已用之，须明知其以当前账户(lagom)运行，
  #   与 NetworkService 服务注册形成两账户争用，且须确保不会有服务实例同时启动。
  #   & "D:\Program Files\PostgreSQL\18\bin\pg_ctl.exe" start -D "D:\Program Files\PostgreSQL\data"
  #   （经后台任务拉起时加 ` && sleep infinity` 防命令结束清掉进程树）
  ```
- 通过标准：服务 State=`Running`；5432 归属正确；`pg_isready` 返回接受连接；用项目 `DATABASE_URL` 只读 `SELECT 1` 成功；**未出现两账户/两实例争用数据目录**。
- 回滚边界：**启动失败即停**。禁止 `initdb`、禁止重建/删除数据目录、禁止改 PG 配置绕过。保留现场查日志（`pg_log`）。
- 状态：⏳🔒 待执行。

### 步骤 3 — 确认迁移状态（⏳ 需 PG 起后；🔒 写库动作需授权）
- 只读核查（PG 起后执行）：
  ```sql
  SELECT to_regclass('public.convert_tasks');
  SELECT to_regclass('public.convert_files');
  SELECT column_name, data_type, column_default
  FROM information_schema.columns
  WHERE table_schema='public' AND table_name='convert_tasks'
  ORDER BY ordinal_position;
  SELECT indexname FROM pg_indexes WHERE tablename IN ('convert_tasks','convert_files');
  -- CHECK 约束：
  SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
  WHERE conrelid='convert_tasks'::regclass AND contype='c';
  ```
- **逐项比对脚本**（不是只看两张表）：
  - `004_convert.sql`：表 `convert_files`(id/original_name/format/mime_type/size_bytes/storage_path/created_at)、表 `convert_tasks`(id/file_id/source_format/target_format/status/progress/result_file_id/error_message/created_at/updated_at/finished_at)、`status` CHECK 约束(`waiting|processing|success|failed`)、2 索引 `convert_tasks_status_idx`/`convert_tasks_created_idx`；**整文件 `BEGIN/COMMIT` 原子**。
  - `005_convert_result_files.sql`：为 `convert_tasks` 增加 `result_files jsonb NULL`（DO 块内 `IF NOT EXISTS` 守卫）；**整文件 `BEGIN/COMMIT` 原子**。
- ⚠️ **事务边界（已证实）**：每个 SQL 文件自含事务，单文件失败全回滚；`migrate.ts` 无历史表，验证靠结构比对。重跑安全 = 原子性 + 幂等 DDL（见 §2 P0-②）。
- 通过标准：DB 中对象与 004/005 **完全一致**（表/列/类型/默认值/CHECK/外键/索引）。
- 若结构完整：**不迁移**。若缺失/不一致：**停止**，先制定针对性修复方案，**不自动执行迁移**。
- 回滚边界：**不执行 `DROP TABLE`**。异常时保留现场、记录错误。
- 状态：⏳🔒 待执行（PG 未起，无法查询）。

### 步骤 4 — 核实 API 配置与进程归属（✅ 部分已验证；❓ CWD 缺口待补）
- 只读核查（本轮已完成）：
  - `server/package.json` `start` = `node dist/src/index.js`（无环境注入）。
  - 配置来源：`loadDotenv()` 加载 `server/.env`；dotenv 默认**不覆盖**已有 `process.env`（见 §2 P1-①）。
  - `CONVERT_ENGINE_ENABLED` 缺省 = **false**（安全默认）。
  - 真实进程：PID **29088**，`"D:\Program Files\nodejs\node.exe" dist/src/index.js`，监听 8787。
  - CWD：**WMI 取空，推断 `server/`（未直接验证）**（见 §2 P0-③）。
- ❓ 待补全：以可读取 CWD 的工具直接确认 29088 工作目录；或在授权重启时统一用 `cd server` 显式保证。
- 通过标准：配置来源与覆盖优先级明确；确认是否需重启加载新配置；确认不会起第二个 API（8787 仅 29088）；确认 PG 恢复后连接池是否需重建。
- 结论：当前 API 已运行但未连 DB（PG 停）→ `database:error`；`engineEnabled:false`（env 未置）。**恢复路径 = 先起 PG，再按需重启 API**，而非盲目 kill。
- 停/重启动作（🔒 需授权）：先复核 29088 仍为目标，再 `Stop-Process -Id 29088`；确认 8787 释放后 **`cd server && npm run start`**（显式 CWD，后台任务）。
- 状态：✅ 只读已验证（PID/配置/dist/缺省值）；❓ CWD 待补；🔒 重启待授权。

### 步骤 5 — 核实 Worker 解释器与依赖（✅ 只读已完成；🔒 安装/启动待授权）
- 只读核查（本轮已完成）：
  - `server/.venv` 不存在；`fitz` 未安装。
  - `requirements.txt`：`psycopg2-binary>=2.9,<3` / `python-dotenv>=1.0,<2` / `PyMuPDF>=1.24,<2`。
  - 候选解释器存在且为 `Python 3.13.14`（win32），pip 可用（安装预期可行但待实测，见 §2 P1-②）。
- 执行阶段（🔒 需授权）确认解释器（只用已核实绝对路径）：
  ```powershell
  & "C:\Users\lagom\.workbuddy\binaries\python\versions\3.13.12\python.exe" --version
  & "C:\Users\lagom\.workbuddy\binaries\python\versions\3.13.12\python.exe" -c "import fitz; print(fitz.__doc__.splitlines()[0])"
  ```
- 通过标准：Python 版本/平台符合；`PyMuPDF` 可导入；DB 配置与结果目录明确；Worker 入口/工作目录/退出方式明确；**`CONVERT_STORAGE_DIR` 与 OCR/ASR 目录物理隔离**（见 §2 P1-③）。
- 安装与启动（🔒 需授权，非本轮）：
  ```bash
  cd server
  PY="C:/Users/lagom/.workbuddy/binaries/python/versions/3.13.12/python.exe"
  "$PY" -m venv .venv
  ./.venv/Scripts/pip install -r convert_worker/requirements.txt   # 观察轮子拉取，确认无编译/版本错
  ./.venv/Scripts/python -m convert_worker.worker   # 后台任务保活
  ```
- ⚠️ **测试隔离**：Worker 处理完会删除源文件（`_cleanup_source`），且 API TTL 清理只删转换结果目录的具体文件；端到端**必须使用专用 PDF 副本**，禁止真实用户文件。
- 状态：✅ 只读已验证（未安装/解释器可行）；🔒 安装/启动待授权。

### 步骤 6 — PDF→PNG 端到端验收（⏳ 需 Step1–5 全通过后）
- 顺序与通过标准：
  1. 上传**专用测试 PDF 副本**（字段名必须为 **`file`**）。
  2. 上传响应含 `fileId`/`format`/`originalName`/`sizeBytes`。
  3. 建任务体必须为 **`{fileId, targetFormat:"png"}`**，初始 `status:"waiting"`。
  4. 轮询 `GET /api/convert/tasks/:id`：终态 `success` 或明确 `failed`+`errorMessage`。
  5. 下载 ZIP，**解析 ZIP 中央目录**统计实际 PNG 条目数（禁止 `raw.count(b"page_")`）。
  6. PNG 数量 = 源 PDF 页数，且逐文件可解码。
  7. 可选：OCR 仅对 `status='success'` 且 `targetFormat='png'` 验证 `text`/`pages`。
- 停止条件：
  - 503 → 查引擎配置，不重复提交。
  - DB 连接失败 → 停，不起第二个 API。
  - 任务卡 `processing` → 查 Worker 日志/回收逻辑（`reclaim_stale_tasks` 默认 300s），不直改 DB。
  - ZIP 损坏/页数不符/PNG 不可解码 → 保留样本与日志，不判通过。
- 状态：⏳ 待执行。

---

## 4. 启动前最终核对（新增章节，进入启动前逐项打勾）

- [ ] **数据目录安全**：服务注册 `-D` 路径 = `postgresql.conf` 中 `data_directory` = `D:\Program Files\PostgreSQL\data` 一致；无第二个 PG 实例占用该目录；陈旧 `postmaster.pid` 已按口径处理。
- [ ] **迁移可审计**：004/005 的表、列、类型、默认值、CHECK、外键、索引与数据库实际结构**逐项对照**一致；确认 `migrate.ts` 无历史表、单文件事务原子。
- [ ] **连接配置可追溯**：确认 API 与 Worker 最终读取的是同一个预期数据库（`DATABASE_URL` 同源），但**不输出密码或完整连接串**。
- [ ] **API 实例可控**：确认 PID（29088）、端口（8787）、工作目录（推断 server/，待直接验证）、启动来源、停止方式；避免误停 vite/WorkBuddy MCP/其他 node 服务。
- [ ] **清理范围明确**：确认 TTL 清理只作用于转换专用结果目录（具体文件路径，非目录扫描）；确认 `CONVERT_STORAGE_DIR` 与 OCR/ASR 目录无重叠；确认 Worker 仅删任务源文件具体路径。
- [ ] **测试数据隔离**：使用专用 PDF 副本；记录测试文件路径与任务 ID；禁止使用真实用户文件。
- [ ] **冒烟脚本已审查**：核对路由、请求字段（`file` / `{fileId,targetFormat}`）、状态枚举、ZIP 中央目录解析、PNG 实际解码与超时逻辑。
- [ ] **恢复策略明确**：启动失败时默认停止后续步骤、保留数据库和文件，不自动删表、不清理目录、不重建数据目录。

---

## 5. 数据库回滚铁律（默认不 DROP）

- **默认动作**：停止相关服务（PG / API / Worker），**保留全部数据**，记录现场。
- `DROP TABLE convert_tasks, convert_files` **不在默认回滚范围内**。仅在以下四项同时满足时才考虑，且须🔒显式授权：
  1. 数据归属已确认：仅格式转换测试数据，无其他功能共享；
  2. 外键依赖已排查（`convert_tasks.file_id`→`convert_files.id` 级联）；
  3. 已有备份或可接受清空；
  4. 获得明确执行授权。
- 即便满足，也优先「停服务 + 保留数据」，而非删表。

---

## 6. `CONVERT_ENGINE_ENABLED=true` 门控（非无条件）

- **门控条件**（全部满足 + 显式授权后才置位）：
  - Step 3 迁移结构完整；
  - Step 4 API 配置与进程归属明确、可受控重启（CWD 已确认）；
  - Step 5 Worker 解释器/`fitz` 就绪并能消费 `waiting` 任务；
  - §4「启动前最终核对」八项全部打勾。
- 置位前：入口保持关闭，`POST /api/convert/tasks` 返回 503，前端显示「未接入」——**避免真实请求进入尚未验证的执行链路**。
- 动作（🔒 需授权）：在 `server/.env` 置 `CONVERT_ENGINE_ENABLED=true`，重启 API（29088）加载。

---

## 7. 冒烟脚本字段逻辑修正（落盘/执行前必改）

| 错误做法 | 正确做法 |
| --- | --- |
| 用轮询 `resultFileId`（单字段）推断页数 | 该字段仅单结果文件指针，不含页数；页数须从 ZIP 或 `result_files` 取 |
| `raw.count(b"page_")` 统计 ZIP 条目 | 真实条目名格式 `{NNN}_{清洗原名}`（见 `convert.ts:287`），不含 `page_`；须**解析 ZIP 中央目录**筛选 PNG 条目 |
| 只信文件名字符串 | 通过标准 = **源 PDF 页数 = ZIP 中可解码 PNG 数量** |
| OCR 对任意任务测试 | 仅 `status='success'` **且** `targetFormat='png'` |
| 上传字段/建任务体随意 | 上传字段必须为 `file`；建任务体必须为 `{fileId, targetFormat}` |

---

## 8. 进入启动与端到端的前置门槛

在以下全部确定前，**不进入步骤 2–6 的执行**：
- [ ] 数据库迁移状态已结构比对确认（Step 3）
- [ ] API 配置来源与进程归属（PID 29088）已确认，CWD 缺口已关闭（Step 4）
- [ ] Worker 解释器与 `fitz` 已核实（Step 5）
- [ ] `CONVERT_ENGINE_ENABLED=true` 的置位已获显式授权且作为门控（§6）
- [ ] 数据库回滚铁律已确认（§5）
- [ ] §4「启动前最终核对」八项全部打勾

> 本文件为只读核查的固化产物；任何🔒项均不在本轮执行。

---

## 9. 控制权交还记录（2026-10-21 00:5x · B.12 代记）

**格式转换会话已明确交还控制权给 B.12**，并声明：本轮及此前 Phase A **始终为零执行**——
未启动 PostgreSQL、未删除 `postmaster.pid`、未改 `.env`、未跑迁移、未装依赖、未停止任何进程。

对照文首「🔁 解除冻结的前置条件」三条：

| # | 条件 | 判定 | 证据 |
|---|---|---|---|
| 1 | 已看到冻结标注、同意 B.12 优先 | ✅ | 回复原文「收到，控制权交还给你」 |
| 2 | 当前无正在/即将/排队的 PG 启动操作 | ✅ | 回复原文「本轮及此前 Phase A 始终为零执行」+ 实测 `postgres.exe`=0、5432 无监听、服务 Stopped |
| 3 | 同意 B.12 恢复完成后才解除冻结 | ✅ | 回复原文「接下来由你定……我在此停住，不再自主推进」 |

⇒ **G1 达成**（证据等级：用户转述 + 对方会话声明原文）。

**冻结不因交还而自动解除**：B.12 恢复期间，本清单步骤 2 仍维持暂缓；
待 B.12 完成 PostgreSQL 与检索 API(8000) 的恢复与验证、由用户交还后，再追加「🟢 冻结已解除」。

---

## 10. 遗留发现的补做与代记（B.12 于 00:5x 只读补证）

### 10.1 `postmaster.pid` 陈旧性 —— 【已闭合】

- **PID 25980 当前未被任何进程占用**（`Get-CimInstance Win32_Process -Filter "ProcessId=25980"` 无返回）；`postgres.exe` 数量 = 0。
- pid 文件内容（只读）：`25980` / `D:/Program Files/PostgreSQL/data` / 启动时间戳 `1792495668` = **2026-10-20 19:27:48** / `5432` / 监听 `*` / 状态 **`ready`**。
- PG 日志 `D:\Program Files\PostgreSQL\data\log\postgresql-2026-10-20_192749.log`：
  `19:27:49 启动` → `19:28:23 syncing data directory (fsync), elapsed time: 34.26 s` → `19:28:23 database system is ready` →
  **末条记录 20:40:28 之后没有任何 shutdown 记录**。

**结论【实测】**：该实例是**被外部终止进程**（不是正常关闭），因此留下了状态为 `ready` 的陈旧锁文件。
陈旧锁文件判定成立，证据链完整（PID 未占用 + 无 postgres 进程 + 日志无关闭记录 + 状态为 ready）。

**处置口径不变**：**不手动删除**。PG 启动时会自检 PID 是否存活，不存活则自行移除（日志出现 `removing stale pid file`）。

### 10.2 下次启动的预期耗时 —— 【新增风险，需在 Phase B 注意】

- 上次是非正常关闭 ⇒ 下次启动**必然再走一次** `syncing data directory (fsync)`，上次实测 **34.26 s**。
- Windows SCM 服务启动默认超时约 30 s（由 `HKLM\SYSTEM\CurrentControlSet\Control\ServicesPipeTimeout` 控制，本轮未查到该值 →【待验证】）
  ⇒ 用 `Start-Service` 启动**可能返回 1053「服务没有及时响应启动或控制请求」**，但 PG 可能仍在后台正常起来。

**处置**：启动后**不凭报错判定失败**，改以「5432 出现监听 + 日志出现 `database system is ready`」为准；
必要时由管理员把 `ServicesPipeTimeout` 调到 `120000`（毫秒）。

### 10.3 代记：格式转换会话未写回的发现（来源：其 00:5x 交还说明，**非 B.12 实测**）

- **API 进程链**：29088 已不存在；当前 8787 监听为 pid **38124**，父进程 **38312 = `node --watch dist/src/index.js`**（`npm run dev` 的观察器）。
  ⇒ 38124 是观察器子进程，**单独 kill 38124 会被 `--watch` 自动拉起新 PID**；`CWD=server/` 的推断因此更稳（dev 从 `server/` 起）。
- **存储目录隔离**：`.env` 设 `OCR_STORAGE_DIR=data/ocr`、`ASR_DATA_DIR=data/asr`，`CONVERT_STORAGE_DIR` 未设 → 默认 `data/convert`；
  三者均在 `server/` 下物理分目录 ⇒ TTL 清理只删转换结果目录的前提成立（执行阶段再确认）。
- **其两点未决的处置**：① `postmaster.pid` 陈旧性 → 已在 10.1 闭合；
  ② API 的 CWD（WMI 取不到，属间接推断）→ 仍为【待验证】，`cd server` 只能保证**新**实例，不能反证旧实例。
