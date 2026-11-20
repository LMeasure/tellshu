# O-4A PG18 隔离预演 Runbook

> 配套：`01-SQL依赖清单与缺陷登记.md`、`03-init-cleanup.sql`、`03-cleanup.sql`、`04-并发测试套件.py`、`04c-屏障状态机与失败处理设计.md`、`06-证据采集规范.md`、`07-网络与权限隔离.md`、`11-静态验证.py`。
> 本文件是**操作手册**，描述「O-4A 授权后如何执行隔离预演」。第十轮为**修复轮**：未启动 PG、未执行任何 SQL、未连 R2、未用真实凭证。
> 红线：授权前任何人不得启动 PostgreSQL、不得执行 `03-init-cleanup.sql`/`03-cleanup.sql`、不得连接 R2、不得使用真实凭证、不得触碰正式迁移链。
> 第十轮变更：初始化脚本已改为真正可执行（无手工去注释）；删除违规的「单角色回退」；测试套件改用 5 角色 DSN + psycopg≥3.2.4 + 持久化屏障。

---

## 1. 目标与范围

- 目标：在**独立隔离 PostgreSQL 18 实例**上，对 WP-02 SQL-A~E 闭环（TRG-01 六通道推进）做**纯 PG 实测**，产出可审计证据，验证七项不变量 I1~I7。
- 范围（闭环子集）：`evidence_signing_key` / `r2_evidence_record` / `r2_evidence_verification` / `r2_evidence_consumption` / `TRG-01` + 最小基线 `object_outbox` 桩 + 测试协调表。
- 不在范围：cross_gen_*、backup_manifests、TRG-02..09、T-TERMINALIZE、R2 真实能力（U-4 十三条仍 `[待R2]`）。

---

## 2. 隔离实例部署方案（PG18）

| 维度 | 方案 |
|---|---|
| 部署形态 | 单节点独立 PostgreSQL 18 容器/进程，**专用端口**（默认 5433，避开生产 5432），数据目录位于一次性临时卷 |
| 操作系统/版本 | PostgreSQL 18.x（`server_version` 须 = 18，证据采集强制记录） |
| 进程隔离 | 独立 OS 用户（非 `postgres` 生产账户），`cgroup`/命名空间隔离；不挂载生产数据目录 |
| 网络绑定 | 仅绑定 `127.0.0.1`（或隔离 overlay 网段），**不暴露公网**；见 §7 |
| 生命周期 | 预演前 `initdb` + 启动 → 跑测试 → 收证据 → `pg_ctl stop` + 删数据目录；**不留持久态** |
| 资源 | 1 vCPU / 2GiB 即可；并发测试最多 12 连接，远低于默认 `max_connections` |

**启动（授权后，编排器执行，非本 Agent）：**
```bash
export O4A_PGDATA=/tmp/o4a_pgdata
export O4A_PORT=5433
initdb -D "$O4A_PGDATA" --auth=trust --username=o4a_admin   # 仅隔离实例，trust 限定 127.0.0.1
pg_ctl -D "$O4A_PGDATA" -o "-p $O4A_PORT -c listen_addresses='127.0.0.1' -c fsync=on" -l "$O4A_PGDATA/log" start
createdb -p "$O4A_PORT" -U o4a_admin shutree_o4a
```

---

## 3. 初始化方案

### 3.1 数据库初始化
- 新建专用库 `shutree_o4a`，owner = 超级用户 `o4a_admin`（仅用于建对象/角色，测试会话不用）。
- `CREATE EXTENSION pgcrypto;`（提供 `gen_random_uuid()`）。

### 3.2 Schema 初始化（自包含，真正可执行；不依赖正式迁移链）
- **直接整文件执行** `psql -f 03-init-cleanup.sql`（脚本内 SQL 全部为真实可执行语句，**无手工去注释**）。
- 三道启动闸门：须传 `-v O4A_AUTHORIZED=1` 及 6 个 `*_pw` 变量，缺一即 `\quit`；`ON_ERROR_STOP on` 失败即停；全程单事务，失败整体回滚；开头 `DROP SCHEMA CASCADE` 保证重复初始化幂等。
- **关键决策**：本仓 `server/sql/001~005` **不含** `object_outbox`/`shutree_sec`/相关角色（见 01 §6-D4），故**不跑正式迁移链**；改由本脚本自包含重建最小基线。
- 执行顺序：闸门 → schema → 角色/密码 → 基线桩(object_outbox) → OBJ-02/03/04/05 → TRG-01(SECURITY DEFINER) → 协调表 → GRANT → COMMIT。
- 完整调用命令见脚本头部注释块（密码走 `-v`，不写仓库/聊天）。

### 3.3 最小权限角色方案（5 角色职责隔离）
- `shutree_fn_owner`（NOLOGIN，对象属主 + TRG-01 SECURITY DEFINER 执行主体）、`shutree_fixture_admin`（仅合成数据种子/清理/采证，业务事务之外）、`shutree_evidence_collector`（仅 INSERT record）、`shutree_evidence_verifier`（仅 INSERT verification，触发 TRG-01）、`shutree_monitor`（只读 pg_locks/pg_stat_activity，授予 pg_monitor）、`shutree_app`（只读）、`shutree_admin`（SUPERUSER 仅审计，旁路如实登记）。
- 密码全部由环境变量/secret 注入（`-v xxx_pw="$XXX_PW"`），**绝不向负责人索取、绝不入库**（见 07 §3）。
- **禁止单角色回退**：不得低于权限隔离运行全部会话；缺任一角色 DSN，测试套件以退出码 92 拒绝启动（见 §3.4）。逐项 GRANT/REVOKE 见 07 §2.1。

### 3.4 测试套件角色 DSN（与套件实际连接一致）
测试套件**只认 5 个环境变量**，缺一即拒绝运行（不降级）：
```bash
export O4A_DSN_FIXTURE_ADMIN='host=127.0.0.1 port=5433 dbname=shutree_o4a user=shutree_fixture_admin password=...'
export O4A_DSN_COLLECTOR='... user=shutree_evidence_collector password=...'
export O4A_DSN_VERIFIER='... user=shutree_evidence_verifier password=...'
export O4A_DSN_MONITOR='... user=shutree_monitor password=...'
export O4A_DSN_APP='... user=shutree_app password=...'
```
- `03-init-cleanup.sql` 由超级用户 `o4a_admin` 执行；**测试会话一律用上述最小权限角色**。
- 套件启动校验 `psycopg>=3.2.4`（`notifies(timeout)` 依赖，见 04c §6），不满足退出码 91。

---

## 4. 合成测试数据方案

- **原则**：所有 fixture 为**显式合成值**，由 `04-并发测试套件.py` 通过 psycopg 参数化 INSERT 生成（**不硬编码于 .sql**，避免「编造数据」违规与不可重复）；seed 不依赖任何真实语料/真实 R2 对象。
- 预置内容（每测试隔离）：
  1. `evidence_signing_key`：1~2 行（不同 `org_unit` / `key_id`）。
  2. `app.object_outbox`：1 行（`outbox_id` 合成 UUID）。
  3. `r2_evidence_record`：6 行，共享同一 `evidence_snapshot_id=S`，`channel=C1..C6`，`collector_org_unit='ORG_COLL'`，`payload_sha256` 一致。
  4. `r2_evidence_consumption`：1 行（`evidence_snapshot_id=S`, `state='created'`）。
- 每个测试用例在独立 `evidence_snapshot_id` 上运行，互不污染；用例前由 `fixture_admin` 在**业务事务之外** TRUNCATE/重建保证可重复（见 04 `fixture_reset`）。
- `fixture_admin` 不参与任何业务事务；`verifier/collector/app` 无 TRUNCATE/DELETE/UPDATE 权限（T12A~T12F 负向覆盖）。
- 槽位 `consumption(created)` 由 fixture 预置；业务角色不得自行 INSERT/UPDATE 槽位（第十轮起，收集者仅 INSERT record）。

### 4.1 T12 权限边界子场景（任务四重定义）
T12 证明目标严格限定为「**普通业务角色不能绕过受控状态推进入口**」，拆为 T12 + T12A~T12F：
- T12/T12A：verifier、collector 直接 `UPDATE consumption` → 42501。
- T12B：app 直接 `INSERT verification` → 42501。
- T12C/T12D：collector `DELETE`/`TRUNCATE` → 42501。
- T12E：verifier `ALTER TABLE`（改触发器/函数同属 DDL 管理权）→ 42501。
- T12F：正常受控入口（verifier INSERT 触发 TRG-01）仍合法推进 → COMMIT/verified。
- 独立登记、**不由普通角色测试**：SUPERUSER 旁路、表所有者旁路、`DISABLE TRIGGER`、DDL 管理权（见 07 §4）。绝不把普通角色结果扩大解释为「DB 超级用户也无法绕过」。

---

## 5. 网络隔离方案（详见 `07-网络与权限隔离.md` §3）
- 预演实例仅 `127.0.0.1:$O4A_PORT`，防火墙规则拒绝非本机来源。
- 与 DB-A（真实恢复目标集群）/ DB-B（审计库）**物理隔离**：本预演不连接任何既有数据库，不创建 `cross_gen_*`/`backup_manifests`/`recovery_runs` 对象。
- 测试协调 `LISTEN/NOTIFY` 仅在本地实例内，不外发。

---

## 6. 环境销毁与失败恢复

### 6.1 正常销毁
```bash
pg_ctl -D "$O4A_PGDATA" stop -m fast
rm -rf "$O4A_PGDATA"        # 一次性临时卷，直接删除即彻底销毁
```
- 因全程隔离实例，无需「回滚生产」；所有证据已落盘于 `evidence/` 目录（见 06）。

### 6.2 失败恢复
| 故障 | 处理 |
|---|---|
| 初始化 DDL 报错 | `ON_ERROR_STOP` 已整体回滚；查看 `log`，修正脚本后重跑（开头 `DROP SCHEMA CASCADE` 幂等）；执行清零脚本见 `03-cleanup.sql` |
| 某测试会话挂死/屏障超时 | 屏障 deadline=45s 抛 `TimeoutError` → `verdict=TIMEOUT`；monitor 可 `pg_terminate_backend(pid)`；绝不记 success（见 04c §4） |
| 通知丢失 | `notifies(timeout=5s)` 到期重读真值表，`notify_missed` 计数；不永久阻塞（见 04c §2.2） |
| 实例崩溃 | 重启 → 重新 init（合成数据）→ 新 run_id 重跑；已写结果未 COMMIT 自动丢弃 |
| 证据文件落盘失败 | 与数据库事务失败**分开处理**：DB 事务结果照常记录；落盘异常写 stderr 并令该用例 `verdict=ABORT`（证据不完整），不静默 PASS |
| 不同运行互相覆盖 | 证据写入 `evidence/<run_id>/`（时间戳+随机串），每次运行独立目录，绝不覆盖历史运行 |

---

## 7. 准入预检清单（执行前逐项核对 → 见 `09-完整交付报告.md` §准入表）

- [ ] 依赖完整（01 §5 六项全绿）
- [ ] 初始化脚本真正可执行（`03-init-cleanup.sql` 全为可执行 SQL、无手工去注释；三闸门 + ON_ERROR_STOP + 单事务；`11-静态验证.py` 49/49）
- [ ] 角色 DSN 与套件一致（5 角色环境变量齐全；无单角色回退）
- [ ] 测试脚本完整（04 覆盖 22 场景：T01~T16 + T12A~F + T13~T16；七不变量 + SQL-A~E 映射）
- [ ] 并发确定性（04c 四状态持久化屏障；LISTEN 先于 NOTIFY；无 sleep；psycopg≥3.2.4）
- [ ] T12 权限边界（6 类负向 + 正常入口；管理旁路单独登记）
- [ ] 七不变量均有测试（05 映射表）
- [ ] 证据采集完整（06 字段全；summary 识别 NO_RUN/TIMEOUT/ABORT/PARTIAL/FAIL）
- [ ] 输出目录隔离（`evidence/<run_id>/`，不互相覆盖）
- [ ] 清理/恢复完整（03-cleanup.sql + §6）
- [ ] 网络隔离明确（§5 / 07）
- [ ] 无未解决 P0/P1

---

## 8. 执行流程（授权后由编排器执行，本 Agent 不参与执行）

0. **本地静态验证（无需 PG）**：`python 11-静态验证.py`（当前 49/49）；此步只是结构断言，非 PG 实测。
1. 起隔离实例（§2）→ 建库 + 角色密码经 `-v` 注入（§3.1）。
2. 超级用户整文件执行 `psql -v O4A_AUTHORIZED=1 -v ..._pw=... -f 03-init-cleanup.sql`（§3.2）。
3. 设 5 角色 DSN（§3.4），跑套件：`python 04-并发测试套件.py --out evidence/`（自动建 `evidence/<run_id>/`）。
4. 逐用例产出 `evidence/<run_id>/Txx.json`（06 字段，含每会话 txid/PID/SQLSTATE/锁等待/事务结果/七不变量）。
5. 汇总 `evidence/<run_id>/summary.json`：识别 PASS/FAIL/TIMEOUT/ABORT/PARTIAL/NO_RUN，缺证据不记 PASS。
6. 视需要执行 `03-cleanup.sql` 原地清理；正常销毁用 `pg_ctl stop` + 删数据目录（§6.1）。
7. 将证据包与 `summary.json` 交付负责人做 O-4A 准入裁决。

> 本 Runbook 所列命令**仅为授权后执行说明**，第十轮未运行任何一条、未启动 PG、未执行 SQL。
