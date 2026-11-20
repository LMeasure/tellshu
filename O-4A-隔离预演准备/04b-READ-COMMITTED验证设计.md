# O-4A 第十轮 · READ COMMITTED 真实行为验证设计

> 配套：`03-init-cleanup.sql`（SQL-A~E 函数体，第十轮已可执行化 + TRG-01 改 SECURITY DEFINER）、`04-并发测试套件.py`、`04c-屏障状态机设计.md`、`06-证据采集规范.md`。
> 红线：本轮**零 PG 连接**，所有「观测」列标记为 `[待PG]`；**不得将普通 READ COMMITTED 规则直接当作触发器内部所有 SQL 的证明**（任务书 任务四 明示）。
> 依据：PostgreSQL 18 官方文档「READ COMMITTED 隔离级别」「MVCC / 快照」「FOR UPDATE 行为」「函数易变性（VOLATILE/STABLE）」。
> 第十轮变更：① TRG-01 改 `SECURITY DEFINER + search_path=pg_catalog,pg_temp`（权限修复，不改变快照语义，但须在真机验证 DEFINER 下 SPI 读仍遵守 READ COMMITTED）；② 每个场景的三类映射（SQL-A~E / spi_snapshot / channel_check）已写入 04 `ScenarioDef` 字段并落入证据。

---

## 1. 关键前提：READ COMMITTED 的快照语义

- READ COMMITTED 下，**每条 SQL 语句**在语句**开始时**取得独立快照；同一事务内后续语句可看到其他事务**已提交**的变更。
- 触发器函数（TRG-01）在 `INSERT ... r2_evidence_verification` 语句执行期间、于**同一事务**内运行；其体内 SQL-A/SQL-C/SQL-D/SQL-E 各为独立语句，**各自取语句开始快照**。
- `NEW` 伪记录是内存元组，**不经快照**，由触发器直接可见（INSERT 的本事务未提交写）。

> ⚠ 证明义务：触发器内每条 SQL 的可见性必须**逐条**依据上述规则推导，不能笼统写「READ COMMITTED 可见」。

---

## 2. 逐 SQL 理论预期 ↔ 真实 PG 观测对应表

| SQL | 语句类型 | 快照时机 | 见本事务未提交写 | 见他事务已提交写（截至语句开始） | FOR UPDATE / 锁 | VOLATILE/STABLE 影响 | 理论预期 | PG 观测（本轮 `[待PG]`） |
|---|---|---|---|---|---|---|---|---|
| **触发命令** INSERT verification | DML（触发源） | 语句开始 | — | — | 对 r2_evidence_verification 新行加行锁（本事务持有） | — | NEW 在内存可用 | `[待PG]` |
| **SQL-A** SELECT r2_evidence_record WHERE evidence_record_id=NEW.id | 普通 SELECT | 语句开始 | 是（同事务若已写 record 可见） | 是（其他事务已提交 record 可见） | 无 | 无（只读快照） | 取到该 record 的 collector_id/collector_org_unit/payload_sha256 | `[待PG]` |
| **SQL-B** IF 闸门（无查询，纯比较 NEW 字段） | 控制流 | — | — | — | — | — | 比对 NEW 与 SQL-A 取法变量；不符 RAISE | `[待PG]` |
| **SQL-C** SELECT … consumption … FOR UPDATE | SELECT + 行锁 | 语句开始；FOR UPDATE 等待他事务释放后读**最新锁定版本** | 是（本事务若已写该 slot 可见） | 是（他事务已提交 slot 可见；未提交则阻塞等待） | **关键**：对他事务持有冲突锁的行阻塞，获锁后读最新已提交版 | 无 | 取 v_state；若他事务正改该行则等待其提交/回滚后再读 | `[待PG]` 须实测等待图与可见值 |
| **SQL-D** UPDATE consumption SET state='verified' WHERE sid AND state='created' | DML + GET DIAGNOSTICS | 语句开始（WHERE 用当前行快照+锁） | 是 | 是 | 行已 FOR UPDATE 锁定（SQL-C 取得），无他事务竞争 | 无 | 影响 0 或 1 行；v_rows>1 RAISE | `[待PG]` |
| **SQL-E** SELECT COUNT(DISTINCT channel) JOIN verification | 聚合 SELECT | 语句开始 | 是（本事务已提交的 verification 不可见，仅见已提交+本事务未提交） | 是（他事务已提交 verification 可见，截至本语句开始） | 无（只读） | 无 | 计 distinct channel；=6 ⇒ UPDATE consumable | `[待PG]` 须实测并发下 COUNT 时机 |

> 注：`SQL-B` 非查询，不参与快照讨论；其比较对象来自 `NEW`（触发行）与 `SQL-A` 取法变量，均为本事务确定值。

---

## 3. 六项重点验证（任务书 任务四 六点）

| # | 重点 | 设计验证手段（预演时执行） | 错误假设风险 |
|---|---|---|---|
| 1 | 触发器内部 SPI SQL 快照行为 | 在 TRG-01 体内嵌 `now()/clock_timestamp()` 与 `txid_current_snapshot()` 采样，确认 SQL-A/C/E 各取独立语句快照 | 误以为整触发器共享一个快照 |
| 2 | FOR UPDATE 等待前后可见性 | 场景 T11：他事务持 slot 行锁未提交 → 本事务 SQL-C 阻塞；他事务提交后本事务读到**新值**（verified） | 误以为 FOR UPDATE 读旧快照值 |
| 3 | SQL-A~E 命令快照 | 对比 `txid_current_snapshot()` 在 SQL-A 与 SQL-E 的值，确认随语句推进变化（非恒定） | 误把命令级快照当事务级 |
| 4 | READ COMMITTED 后续语句可见性 | 场景 T02：另一会话在 SQL-A 后、SQL-E 前提交第 6 个 confirmed verification → SQL-E 的 COUNT 应**包含**它 | 误以为看不到并发提交 |
| 5 | 函数 VOLATILE/STABLE 属性 | TRG-01 函数**默认 VOLATILE**（未声明 STABLE）；验证每次调用重取快照、计划不跨调用缓存 | 误声明 STABLE 导致快照/计划被缓存而读陈旧 |
| 6 | 触发器执行期间他事务提交的可见性 | 场景 T10/T11：触发器运行中途，监控连接提交竞争事务，验证 SQL-E/SQL-D 可见其已提交结果 | 误以为触发器对其启动前的提交「免疫」 |

---

## 4. 证明纪律（呼应 V1.2.30 §0.2 诚实边界）

- 每条「观测」须来自**真实 PG18 实例**运行证据（06 规范），本轮一律 `[待PG]`，**不得**以理论推导冒充实测。
- 触发器内 SQL 的可见性**逐条**记录（见 §2 表），不得合并为「READ COMMITTED 可见」一句结论。
- 若观测与理论预期不符（如 VOLATILE 误标、FOR UPDATE 可见性偏差），须记入证据 `sqlstates`/`lock_wait_evidence` 并触发该用例 `FAIL`，不得静默放过。

---

## 5. 与测试套件的衔接（第十轮：SQL-A~E 真实覆盖核验）

| 关注点（任务书任务五） | 覆盖场景 | 证据字段 | `[待PG]` 验证要点 |
|---|---|---|---|
| SQL-A/B 普通 SELECT 可见性 | T01,T06,T07,T08,T12F | `sql_ae_coverage` | SQL-A 取 record 三元组；SQL-B 三主体+org_unit+hash 闸门，错值 RAISE P0001 |
| SQL-C FOR UPDATE 等待前后 | T02,T10,T11,T16 | `lock_wait_evidence` + `spi_snapshot` | 获锁后读最新已提交 state；T11 等待图无环；T16 不同 sid 不互相阻塞 |
| SQL-D created→verified CAS + ROW_COUNT | T01,T05,T12F | `invariants.I6` | 幂等 0 行；多行 RAISE（触发器体 `GET DIAGNOSTICS`） |
| SQL-E COUNT(DISTINCT)=6 | T01,T02,T05,T15 | `channel_check` | 恰第六通道推进 consumable；T15 非法 C7 被 CHECK 挡在 SQL-E 前 |
| SPI 快照（READ COMMITTED） | T02,T10,T11 | `spi_snapshot` | DEFINER 下每条 SPI SQL 各取语句快照，非整触发器一个快照 |
| 同 sid 多事务争槽位 / 异 sid 独立 | T10,T11 / T16 | `lock_wait_evidence` | 同 sid 单边等待；异 sid 无共同锁 |
| 失败事务完整回滚 | T07,T08,T13,T14 | `sessions[].outcome` + `invariants.I7` | RAISE/唯一冲突后无 verification 残留、状态未推进 |
| 未确认/错hash/错org_unit/重复复核不推进 | T13/T08/T07/T14 | `sqlstates` + `invariants` | 均不得推进 consumable |
| channel 白名单与重复计数漏洞 | T03,T04,T15 | `channel_check` | UNIQUE(sid,channel,op_type) + CHECK(channel∈C1..C6) 双重保证 |

- 上述映射已程序化进 `04-并发测试套件.py` 的 `ScenarioDef`（`sql_ae_coverage`/`spi_snapshot`/`channel_check` 三字段），并逐场景落入证据 JSON。
- 预演时可在 TRG-01 内临时追加 `RAISE NOTICE` 输出 `txid_current_snapshot()` 采集 §3 #1/#3 证据（设计验证用、事后移除、不进产品 schema）。
- **纪律**：测试定义存在 ≠ 测试通过。所有 `[待PG]` 仅在授权后真机执行并由 `summary.json` 判定后才成立。
