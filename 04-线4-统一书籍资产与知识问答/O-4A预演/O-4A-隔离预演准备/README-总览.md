# O-4A 第十轮 · 隔离预演资产可执行性修复总览

> 目标：修复第九轮发现的**执行资产缺陷**，使隔离 PostgreSQL 18 预演具备真实可执行性、权限边界可验证性、并发屏障确定性与证据可追溯性。
> 本轮**未启动 PG、未执行任何 SQL/DDL/DML、未连接 R2、未使用真实凭证**。所有验证均为本地静态/语法验证。
> 最终结论：**A. 满足 O-4A 隔离 PG18 预演执行前提，等待负责人明确授权**（A ≠ 已获 PG 执行授权）。

---

## 文件导航（15 个）

| 文件 | 对应任务 | 第十轮状态 / 一句话 |
|---|---|---|
| `README-总览.md` | 导航 | 本文件（第十轮更新） |
| `01-SQL依赖清单与缺陷登记.md` | 任务一 | 完整依赖清单 + SQL-A~E 闭环 + D1~D7（D5/P0、D6/P1、D7/P1 已修） |
| `02-O-4A-Runbook.md` | 任务一/七 | 可执行初始化命令 + 5 角色 DSN + 22 场景 + `evidence/<run_id>/` + 准入清单 |
| `03-init-cleanup.sql` | 任务一 | **重写**：真可执行（无手工去注释）；授权+密码闸门+ON_ERROR_STOP+单事务+幂等重置+TRG-01 SECURITY DEFINER+持久化屏障表+GRANT 矩阵 |
| `03-cleanup.sql` | 任务一 | **新增**：独立清理脚本（DROP SCHEMA，角色默认保留） |
| `04-并发测试套件.py` | 任务二~五 | **重写**：psycopg3≥3.2.4 + `notifies(timeout=)` + 四状态持久化屏障 + 5 角色 DSN + 22 场景 + 六态证据；py_compile 通过 |
| `04b-READ-COMMITTED验证设计.md` | 任务五 | 逐 SQL 理论↔观测表 + SQL-A~E 真实覆盖核验 + 「测试定义≠测试通过」纪律 |
| `04c-屏障状态机与失败处理设计.md` | 任务二 | **新增**：listener_ready→participant_arrived→barrier_released→participant_completed + 失败处理表 + psycopg 版本依据 |
| `05-不变量测试映射.md` | 完整性验证 | I1~I7 ↔ 22 场景映射 + 覆盖完整性核对 |
| `06-证据采集规范.md` | 任务五 | `evidence/<run_id>/` 布局 + 每会话 txid/PID/SQLSTATE/锁等待/结果 + 六态判定（缺证据绝不 PASS） |
| `07-网络与权限隔离.md` | 任务三 | 5+2 角色职责隔离 + 逐项 GRANT/REVOKE 矩阵 + 管理权限旁路边界 |
| `08-U-R8-2-U-R8-3-实施设计.md` | 任务六 | **重写**：不可变材料表 + 可变治理状态事件表 + 三时点判断 + 唯一推荐 mTLS+KMS + 双重重放防护 |
| `09-完整交付报告.md` | 交付 | **重写**：启动纪律 + 六项修复处置 + 完整性验证 + 结论 A |
| `10-Git基线与文件度量.md` | 交付 | **重写**：第十轮实测 Git 基线 + 15 文件度量 + 静态验证结果 |
| `11-静态验证.py` | 完整性验证 | **新增**：11 组静态结构检查，实测 `PASS=49 FAIL=0` |

---

## 关键事实速记

- **执行阻断已消除**：D5（TRG-01 SECURITY INVOKER 致 verifier 无 consumption UPDATE 权限 → 42501）改为 `SECURITY DEFINER + search_path 锁定 + owner=fn_owner`；D6（REVOKE 缺 ON 子句语法错）改为 `REVOKE ALL ON ALL TABLES IN SCHEMA` + 精确 GRANT；D7（SQL 大量被注释、需手工去注释）改为真可执行脚本。
- **确定性并发**：持久化四状态屏障（`rehearsal_barriers` / `rehearsal_barrier_events`），LISTEN 先于 NOTIFY，`conn.notifies(timeout=)`，**禁用 sleep 猜测**；psycopg≥3.2.4（3.2.4 前 LISTEN 与生成器间通知会丢失）。
- **角色隔离**：fixture_admin / collector / verifier / monitor / app 五职责分离；verifier 无 consumption UPDATE；fixture 清理在业务事务外；单角色回退已删除。
- **场景扩展**：12 → **22**（T01~T16 + T12A~T12F），含屏障协议自身测试、权限负向测试、异常/超时测试。
- **T12 边界收窄**：只证明「普通业务角色不能绕过受控入口」，SUPERUSER / owner / DISABLE TRIGGER / DDL 管理旁路**如实登记**，不扩大解释。
- **证据六态**：`PASS/FAIL/NO_RUN/TIMEOUT/ABORT/PARTIAL`；缺证据 → ABORT，禁止缺失证据默认 PASS；`evidence/<run_id>/` 防覆盖。
- **密钥语义统一**：append-only 不可变材料表 + 可变治理状态事件表；`effective_at`/`discovered_at` 取代矛盾的 `revoked_at`/`compromised_at`；签署时/验证时/事后泄露三时点判断；私钥仅在 KMS/HSM。
- **诚实边界**：所有「PG 观测」「R2 能力」仍为 `[待PG]`/`[待R2]`，未以理论冒充实测。

---

## 下一步（需负责人明确授权后）

1. 起隔离 PG18 实例（Runbook §2）。
2. 整文件执行初始化：`psql -v O4A_AUTHORIZED=1 -v ...pw=... -f 03-init-cleanup.sql`（**无需手工去注释**；见 Runbook）。
3. 配置 5 角色 DSN 环境变量（`O4A_DSN_FIXTURE_ADMIN` / `..._COLLECTOR` / `..._VERIFIER` / `..._MONITOR` / `..._APP`）。
4. 运行测试套件：`python 04-并发测试套件.py --out evidence/<run_id>/`（22 场景）。
5. 采集 `evidence/<run_id>/<Txx>.json` + `summary.json`，按六态判定。
6. 独立清理：`psql -v O4A_AUTHORIZED=1 -f 03-cleanup.sql`；销毁实例（Runbook §6）。
7. 交付证据包做 O-4A 准入裁决。

> 结论 A 仅表示**满足执行前提**，不代表 O-4A / O-4B / O-4C / 阶段 1B 已获准，也不代表已取得 PG 执行授权。
