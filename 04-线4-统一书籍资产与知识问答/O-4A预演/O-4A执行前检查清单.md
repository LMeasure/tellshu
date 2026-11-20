# O-4A 执行前检查清单（线4 主线第一部分 · 只读复核产出）

> 产出方：line4-rehearsal（task-2 · 线4 主线 O-4A 隔离 PG18 预演执行 Worker）
> 性质：只读复核产物。本轮仅 Read 全部资产并静态核对，未启动 PG18、未执行任何 SQL/DDL/DML、未连接 R2、未使用真实凭证、未触碰生产/共享库。
> 依据资产：02-O-4A-Runbook.md / 03-init-cleanup.sql / 03-cleanup.sql / 04-并发测试套件.py / 05-不变量测试映射.md / 06-证据采集规范.md / 07-网络与权限隔离.md / 11-静态验证.py 等。
> 状态：会签 B2 已于 2026-11-20（Asia/Shanghai）批准隔离预演；会签 B1 同日冻结线4静态文稿第 11 轮。批准不是启动 PostgreSQL、执行 SQL、连接 R2 或使用真实凭证的许可。两处套件阻断曾挡住执行，现已在套件内修复；本清单修订仍未起库、未执行 SQL。
> 纪律：证据六态 PASS/FAIL/NO_RUN/TIMEOUT/ABORT/PARTIAL；缺证据=ABORT，禁止默认 PASS；静态 351/351、49/49 或修复后的 51/51 都绝不当作真库验证。

---

## 0. 2026-11-20 授权记录（Asia/Shanghai）

- 会签 B2：Human 负责人于 2026-11-20（Asia/Shanghai）批准 O-4A 隔离 PG18 预演。
- 会签 B1：同日冻结线4静态文稿第 11 轮，不得另开静态文稿轮次。本记录只补执行前清单，不重写第 11 轮交付文稿。
- 执行曾被挡住：对 develop `0315707` 上 `04-并发测试套件.py` 的静态复核确认两处阻断（屏障会话顺序执行，首个 `arrive()` 会空等到 `BARRIER_DEADLINE`；`Barrier._await` 把 `notifies()` 返回的生成器再当作可调用对象）。在修复前不能开跑。
- 先前结论 A，以及静态 49/49 或 351/351，都不是 PostgreSQL 实测证据。修复后的静态计数同样不是。

---

## 一、复核结论摘要（三查 + 可执行性）

| # | 核对项 | 结论 |
|---|---|---|
| 1 | psql / python / psycopg3 命令与版本（02 ↔ 04） | ✅ 版本口径一致：psycopg>=3.2.4、退出码 90(缺 psycopg)/91(版本<3.2.4)/92(缺角色 DSN)；psql 三闸门 -v O4A_AUTHORIZED=1 + 6 个 *_pw 变量与 03 实际闸门一致。 |
| 2 | 5 角色 DSN 环境变量（02 §3.4 ↔ 04 ROLE_ENV） | ✅ 完全一致：O4A_DSN_FIXTURE_ADMIN / O4A_DSN_COLLECTOR / O4A_DSN_VERIFIER / O4A_DSN_MONITOR / O4A_DSN_APP，5 个，无单角色回退。 |
| 3 | 22 场景编号（02 ↔ 04 ↔ 05） | ✅ test_id 唯一且数量一致：T01~T16（16）+ T12A~T12F（6）= 22；19 个 builder 函数（复用 3 个）。存在少量文档级措辞/标注不对称（见 §六）。 |
| 4 | Runbook 可执行性（静态代码路径复核） | 两处阻断已在套件中修复（见 §二）。修复前它们挡住执行。静态复核与静态计数都不是 PG 实测。 |

---

## 二、执行前阻断项（已确认，并已在套件内修复）

> 下列现象对照 develop `0315707` 的源码成立，并曾挡住预演执行。修复只改套件与本目录内的静态验证/本清单，未启动 PostgreSQL，未执行 SQL。结论 A 与历次静态分数都不是 PG 证据。

### 阻断-1（P0）：04-并发测试套件.py 无并发实现，屏障场景将 TIMEOUT，无法真正测并发

- 现象（修复前源码，develop `0315707`）：04-并发测试套件.py 仅 import argparse/json/os/sys/time/uuid/dataclasses/typing/psycopg/re，无 threading / asyncio / multiprocessing / concurrent.futures（grep 全部命中为 0，concurrent/await 命中仅命名与文档字符串）。
- run_scenario() 阶段2（第 689~743 行）用顺序 for 循环逐会话执行：connect → arrive → 执行 SQL → commit → 下一会话，全程单线程。
- 屏障语义（Barrier.arrive 第 268~287 行）：非最后到达者 _await(released) 阻塞等待；而 released 仅当 reached==total 时由最后到达者置位。顺序执行下第 1 个会话 arrive() 即 reached=1<total 进入阻塞，因循环无法推进到其余会话 → 命中 BARRIER_DEADLINE=45s → TimeoutError → 整场景 verdict=TIMEOUT。
- 受影响场景（使用 barrier="all_arrived"）：T02、T10、T11、T16（共 4 个并发场景）。预期后果：summary.json 得 4 个 TIMEOUT，main() 返回非零退出码，且并发锁争用从未被真正测到。
- 处置：`ThreadPoolExecutor(max_workers=会话数)`，一会话一线程；监听连接与业务连接都在该线程内创建。`arrive()` 与业务 SQL 因此重叠。语句结束后、COMMIT 前停住，直到监控侧看见锁等待图（或全部语句已结束）。放行用 `threading.Event`，不用 `time.sleep`。无屏障场景仍顺序执行。

### 阻断-2（P1）：conn.notifies() 生成器被误调用 gen(timeout=..., stop_after=1)

- 现象（修复前源码，develop `0315707`）：04 第 248 行 gen = conn.notifies()（不传参）；第 235 行 for _n in gen(timeout=min(NOTIFY_TIMEOUT, remaining), stop_after=1): —— 把生成器对象当函数调用。
- 依据：项目自身 04c §6 引用官方签名 notifies(*, timeout=None, stop_after=None)，timeout/stop_after 是 notifies() 方法参数，返回值为生成器（不可调用）。正确用法为 conn.notifies(timeout=..., stop_after=...)。
- 后果：gen(...) 抛 TypeError，被 _await 内 except Exception: woke=False 吞掉 → 每次等待都记 notify_missed+=1 且不阻塞 → 屏障退化为忙轮询（反复读真值表），notify_missed 证据字段虚增、违反「事件驱动/无轮询」确定性声明、对 DB 施加高频查询负载。
- 影响范围：Barrier._await 被 wait_listeners / arrive / 完成等待共用，故所有屏障等待路径均受影响（与阻断-1 叠加）。
- 处置：`_await` 改为 `listener.notifies(timeout=..., stop_after=1)`，生成器耗尽后再读真值表；不再吞掉 `TypeError`。`11-静态验证.py` 用语法树要求每一处 `notifies()` 都带这两个关键字，并拒绝把 `timeout`/`stop_after` 传给生成器变量。子串 `notifies(` 与 `timeout=` 不再单独算通过。

---

## 三、起库环境前置（逐项勾选，缺一不可）

- [ ] PG18 就绪：initdb/pg_ctl/createdb/psql 在 PATH；目标 server_version 必须 = 18（证据采集强制记录，非 18.x 整批证据无效）。
- [ ] psycopg 就绪：隔离环境预装 psycopg[binary]>=3.2.4（推荐 3.2.10+）；自检 python -c "import psycopg; print(psycopg.__version__)"；不足则套件退出码 91。
- [ ] 端口/绑定：专用端口默认 5433（避开生产 5432），仅绑定 127.0.0.1，防火墙拒绝非本机来源。
- [ ] 数据目录：一次性临时卷 O4A_PGDATA（如 /tmp/o4a_pgdata），不挂载任何生产数据目录；1 vCPU/2GiB 即可。
- [ ] 授权变量：O4A_AUTHORIZED=1；6 个密码环境变量 COLLECTOR_PW / VERIFIER_PW / FIXTURE_PW / MONITOR_PW / APP_PW / ADMIN_PW（经 env/secret 注入，绝不向负责人索取、绝不入库/入聊天）。
- [ ] 5 角色 DSN 环境变量：O4A_DSN_FIXTURE_ADMIN / O4A_DSN_COLLECTOR / O4A_DSN_VERIFIER / O4A_DSN_MONITOR / O4A_DSN_APP（host=127.0.0.1 port=5433 dbname=shutree_o4a user=<对应最小权限角色> password=...），缺一 → 套件退出码 92。
- [ ] 运行载体：Runbook 命令为 POSIX shell 形态；Windows 原生下需改 pwsh（$env:NAME）或使用 WSL2/容器/独立 Linux；由 Orchestrator 确定，本清单按 Runbook 原样转述。
- [ ] 静态验证先跑（无需 PG）：python 11-静态验证.py 当前结构断言为 PASS=51 FAIL=0（修复后新增调用形态检查；旧文稿中的 49/49 是第 11 轮历史计数）。此仅为结构断言，非 PG 实测。

---

## 四、逐步执行命令序列（仅授权后由编排器执行，本 Worker 收到 GO 后照此执行）

> 阶段 0 无 PG；阶段 1~6 均在独立隔离 PG18 实例，绝不连生产/共享库、绝不连 R2、绝不用真实凭证。

### 阶段 0 · 本地静态验证（无 PG）
~~~bash
python 11-静态验证.py        # 当前 PASS=51 FAIL=0（结构断言，非 PG 实测；49/49 与 51/51 都不是真库证据）
~~~

### 阶段 1 · 起隔离实例（Runbook §2）
~~~bash
export O4A_PGDATA=/tmp/o4a_pgdata
export O4A_PORT=5433
initdb -D "$O4A_PGDATA" --auth=trust --username=o4a_admin   # 仅隔离实例，trust 限定 127.0.0.1
pg_ctl -D "$O4A_PGDATA" -o "-p $O4A_PORT -c listen_addresses='127.0.0.1' -c fsync=on" -l "$O4A_PGDATA/log" start
createdb -p "$O4A_PORT" -U o4a_admin shutree_o4a
~~~

### 阶段 2 · 整文件执行初始化（Runbook §3.2；真可执行，无手工去注释）
~~~bash
psql -v O4A_AUTHORIZED=1 -v collector_pw="$COLLECTOR_PW" -v verifier_pw="$VERIFIER_PW" -v fixture_pw="$FIXTURE_PW" -v monitor_pw="$MONITOR_PW" -v app_pw="$APP_PW" -v admin_pw="$ADMIN_PW" -h 127.0.0.1 -p "$O4A_PORT" -U o4a_admin -d shutree_o4a -f 03-init-cleanup.sql
~~~
- 三闸门：O4A_AUTHORIZED=1 + 6 个 *_pw 缺一即退出（quit）；ON_ERROR_STOP on（失败即停）；单事务，失败整体回滚；开头 DROP SCHEMA CASCADE 幂等。

### 阶段 3 · 设 5 角色 DSN（Runbook §3.4）
~~~bash
export O4A_DSN_FIXTURE_ADMIN='host=127.0.0.1 port=5433 dbname=shutree_o4a user=shutree_fixture_admin password=...'
export O4A_DSN_COLLECTOR='... user=shutree_evidence_collector password=...'
export O4A_DSN_VERIFIER='... user=shutree_evidence_verifier password=...'
export O4A_DSN_MONITOR='... user=shutree_monitor password=...'
export O4A_DSN_APP='... user=shutree_app password=...'
~~~

### 阶段 4 · 跑套件（Runbook §8 步骤3；产出 evidence/<run_id>/）
~~~bash
python 04-并发测试套件.py --out evidence/      # 自动建 evidence/<run_id>/，防跨运行覆盖
~~~

### 阶段 5 · 采证据与汇总
- 逐用例：evidence/<run_id>/Txx.json（含 pg_version/psycopg_version/started_at/ended_at/每会话 txid/PID/SQLSTATE/锁等待/事务结果/七不变量）。
- 汇总：evidence/<run_id>/summary.json，按六态 PASS/FAIL/NO_RUN/TIMEOUT/ABORT/PARTIAL 计数；缺证据=ABORT；禁止默认 PASS。

### 阶段 6 · 清理与销毁（Runbook §6）
- 首选销毁（推荐）：pg_ctl -D "$O4A_PGDATA" stop -m fast + rm -rf "$O4A_PGDATA"。
- 原地清理重建（可选）：psql -v O4A_AUTHORIZED=1 -h 127.0.0.1 -p "$O4A_PORT" -U o4a_admin -d shutree_o4a -f 03-cleanup.sql。

### 阶段 7 · 交付
- 将 evidence/<run_id>/ 证据包 + summary.json 交付负责人做 O-4A 准入裁决；产出《O-4A准入裁决证据包》。

---

## 五、证据六态采集要点（06 规范）

| 判定优先级 | 条件 | verdict |
|---|---|---|
| 1 | evidence_complete=False（缺字段/会话数不符/无 PID 或 outcome） | ABORT（缺证据绝不 PASS） |
| 2 | 屏障/等待超时 | TIMEOUT |
| 3 | 执行器异常 | ABORT |
| 4 | 七不变量任一 false | FAIL |
| 5 | 任一会话 outcome 以 ABORT 开头 | ABORT |
| 6 | 屏障 completed<total（参与者崩溃） | PARTIAL |
| 7 | 全部通过 | PASS |

- 未执行用例 = NO_RUN，绝不计入 PASS；pg_version 非 18.x ⇒ 整批证据无效需重建实例。

---

## 六、次要一致性备注（非阻断，建议准入前对齐）

1. Runbook §7 措辞冗余：第 128 行「T01~T16 + T12A~F + T13~T16」中 + T13~T16 与 T01~T16 重复（T13~T16 已含于 T01~T16）；正确表述为「T01~T16 + T12A~F」。数量 22 无误。
2. 03-init-cleanup.sql 头部注释 stale：第 12 行写「四个 *_pw 变量」，实际闸门为 6 个（collector/verifier/fixture/monitor/app/admin）；实际 if 闸门正确，仅注释文案需改「六个」。
3. 05 ↔ 04 不变量标注不对称（文档级，不影响判定）：run_scenario 对每场景统一执行 check_invariants 全七项，ScenarioDef.invariant 仅为注释性标注。差异点：05 将 T05 归入 I2/I3 但 04 T05.invariant 仅 I6；05 I1 未列 T06 但 04 T06.invariant 含 I1；05 I1 列 T12E 但 04 T12E.invariant 仅 I7。建议对齐 05 映射表与 04 标注。
4. 04 代码味道（无害，修复后仍在）：from psycopg import pq 未使用；import re 置于函数定义之后（调用前已导入，可运行）。原先 listener() 重复返回 gen 的解包已随生成器调用缺陷一并去掉，open_listener() 只返回 (conn, pid)。
5. T16 的数据准备仍未按注释实现。`b_diff_sid` 写着「各会话自建 sid（见 runner 的 per_session_sid 开关）」，但两个计划共用 builder 收到的同一个 `ctx.sid`，源码里没有 `per_session_sid`，且 `test_id == "T16"` 时跳过 record 与 consumption 预置。本次只修屏障重叠和 notifies 调用形态，没有补这处。真库上 T16 仍可能因缺少 record 而失败；这不是 PG 实测结论。

---

## 七、红线复核（本 Worker 硬约束，全程遵守）

- [x] 只在隔离 PG18 实例执行（默认 5433，仅 127.0.0.1，一次性临时卷）。
- [x] 绝不连生产/共享库（不连 DB-A/DB-B，不建 cross_gen_*/backup_manifests/recovery_runs）。
- [x] 绝不用真实 R2 凭证、绝不碰真实数据；fixture 全为合成值，由 psycopg 参数化生成，不硬编码于 .sql。
- [x] 严格按资产执行：02-Runbook / 03-init-cleanup.sql（真可执行，勿手工去注释）/ 04-并发测试套件.py（psycopg3>=3.2.4）/ 03-cleanup.sql。
- [x] 证据六态 PASS/FAIL/NO_RUN/TIMEOUT/ABORT/PARTIAL；缺证据=ABORT，禁止默认 PASS；静态 49/49 与修复后的 51/51 都不当作真库验证。
- [x] 本轮（PREP）已遵守：未起 PG、未执行 SQL、未连 R2、未用真实凭证。
