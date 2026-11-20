# O-4A 第九轮 · SQL 完整依赖清单与缺陷登记

> 配套：`O-4A-Runbook.md`、`03-init-cleanup.sql`、`04-并发测试套件.py`。
> 性质：**静态设计资产核验**，未连接 / 未启动 PostgreSQL，未执行任何 DDL/DML/迁移，未连接 R2，未使用任何真实凭证。
> 依据：本轮重读 `WP-02-隔离SQL草稿-禁止执行.sql.draft`、`WP-02-语义修正设计资产-禁止执行.sql.draft`（两文件头部均标注 `DO NOT EXECUTE`）；`V1.2.30` §5.1 / §7.4 / §9 / §14；`stage_evidence_registry.json`（`wp02_objects` / `wp02_triggers` / `wp02_functions`）。

---

## 0. 结论速览

| 项 | 结论 |
|---|---|
| SQL-A~E 能否组成可执行测试闭环 | ✅ 能。最小闭包 = `app.object_outbox`（基线）+ `evidence_signing_key`(OBJ-02) + `r2_evidence_record`(OBJ-03) + `r2_evidence_verification`(OBJ-04) + `r2_evidence_consumption`(OBJ-05) + `TRG-01`。 |
| 是否发现 SQL 设计缺陷 | ⚠ 第九轮：1 项 P2 + 2 项 P3（已修）；**第十轮新增 D5(P0)/D6(P1)/D7(P1) 三项执行阻断，均已修正**（见 §6）。当前无未解决 P0/P1。 |
| 是否可带着已知缺陷进入预演 | 否。全部已知缺陷已修正；D5 的 DEFINER 行为与 D6 的语法修复须在授权后真机验证 `[待PG]`。 |
| 正式迁移链是否被修改 | 否。仅编辑 `.sql.draft` 设计文本，未触碰 `server/sql/*`、产品代码、前提卡、V1.2.30。 |

---

## 1. 表与字段（完整清单）

### 1.1 本次预演闭环仅需要的最小对象集（SQL-A~E 闭包）

| 对象 | 来源 | 关键字段 | 主键 | 外键 / 引用 | 约束 |
|---|---|---|---|---|---|
| `app.object_outbox` | **基线（既有，不在本仓迁移链）** | `outbox_id uuid` 等 | `outbox_id` | — | 仅作 FK 目标，闭环内只需 `outbox_id` 一列最小桩 |
| `shutree_sec.evidence_signing_key` (OBJ-02) | 新 | `key_id, subject_id, subject_type, public_key bytea, org_unit, valid_from, valid_to, revoked_at, compromised_at, created_at` | `key_id` | — | `CHECK(valid_to IS NULL OR valid_from<valid_to)`；`CHECK(revoked_at IS NULL OR revoked_at>=valid_from)`；append-only（REVOKE UPDATE/DELETE/TRUNCATE） |
| `shutree_sec.r2_evidence_record` (OBJ-03) | 新 | `evidence_record_id, evidence_snapshot_id, channel, op_type, bound_outbox_id, bound_request_id, bound_attempt_no, bound_lease_epoch, bound_worker_id, bound_environment, bound_bucket, bound_canonical_key, r2_operation_id, evidence_version, collected_at, collector_id, collector_role, collector_org_unit, collector_key_id, collector_signature, payload, payload_sha256, signature, signature_key_id, created_at` | `evidence_record_id`（默认 `gen_random_uuid()`） | `bound_outbox_id → app.object_outbox(outbox_id)`；`signature_key_id → evidence_signing_key(key_id)` | `CHECK(channel IN ('C1'..'C6'))`；`UNIQUE(evidence_snapshot_id, channel, op_type)`；`UNIQUE(bound_request_id, bound_attempt_no, bound_lease_epoch, op_type, bound_environment, bound_bucket, bound_canonical_key, payload_sha256)`；append-only |
| `shutree_sec.r2_evidence_verification` (OBJ-04) | 新 | `verification_id, evidence_record_id, verifier_id, verifier_role, verifier_key_id, verifier_signature, verifier_org_unit, verified_at, review_method, verification_result, verified_payload_sha256` | `verification_id` | `evidence_record_id → r2_evidence_record(evidence_record_id)` | `CHECK(verification_result IN ('confirmed','contradicted','insufficient'))`；`UNIQUE(evidence_record_id, verifier_id)`；append-only |
| `shutree_sec.r2_evidence_consumption` (OBJ-05) | 新 | `evidence_snapshot_id, state, created_at, verified_at, consumed_at, consumed_by_*, consumption_txid xid8, consumption_db_role, rejected_at, reject_reason` | `evidence_snapshot_id` | — | `CHECK(state IN ('created','verified','consumable','consumed','rejected'))`；`CHECK(state='consumed' ⇒ 四字段非空)`；`CHECK(NOT(state<>'consumed' AND consumed_at IS NOT NULL))`；唯一可变槽位 |

> **本轮修正点**：OBJ-03 已补 `collector_org_unit text NOT NULL`（见 §6-D1），使 §1 TRG-01 的「org_unit 相异」三主体分离可由 SQL-B 强制。

### 1.2 预演闭环**不**需要、但草稿定义的其余对象（登记，不进 SQL-A~E 闭包）

`cross_gen_adjudication`(OBJ-06, ALTER 加唯一键)、`cross_gen_decision_slot`(OBJ-07, ALTER 加 FK)、`cross_gen_revocation`(OBJ-08, 新表)、`backup_manifests`(OBJ-09, 新表)。这些属于 T-TERMINALIZE / 跨代裁定 / 恢复协议路径，**不在 SQL-A~E 测试范围内**；若后续扩展预演再按需启用。

### 1.3 触发器（9 个）

| 触发器 | 时机/对象 | 闭环相关性 |
|---|---|---|
| `TRG-01` trg_evidence_verification | AFTER INSERT ON `r2_evidence_verification` | ✅ **核心**，SQL-A~E 即其函数体 |
| `TRG-02`..`TRG-09` | BEFORE/AFTER 于 object_outbox / cross_gen_* | ❌ 不在闭环内 |

### 1.4 受控函数（6 个，SECURITY DEFINER + `search_path=pg_catalog,pg_temp` + OWNER `shutree_fn_owner`）

`sp_evidence_collect` / `sp_evidence_verify` / `sp_recovery_precheck` / `sp_verify_recovery_manifest` / `sp_recovery_certify` / `terminalEvidenceAuthentic|Consumable|ProvenState`。其中仅 `sp_evidence_collect` / `sp_evidence_verify` 与闭环相关（分别是 record / verification 的受控写入入口）。

### 1.5 角色与权限（最小权限，详见 `07-网络与权限隔离.md`）

`shutree_app` / `shutree_worker` / `shutree_evidence_collector` / `shutree_evidence_verifier` / `shutree_terminality_exec` / `shutree_fn_owner`(NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOLOGIN) / `shutree_admin`(超级用户旁路，仅审计)。闭环内：`collector` 经 `sp_evidence_collect` 写 record+consumption(created)；`verifier` 经 `sp_evidence_verify` 写 verification（触发 TRG-01）。

---

## 2. 主键 / 外键 / 唯一约束 / CHECK / 索引

- **PK**：每表均显式 PK（见 §1.1）。
- **FK（闭环内）**：
  - `r2_evidence_record.bound_outbox_id → app.object_outbox(outbox_id)` → 需基线 object_outbox 行。
  - `r2_evidence_record.signature_key_id → evidence_signing_key(key_id)` → 需先 INSERT key 行。
  - `r2_evidence_verification.evidence_record_id → r2_evidence_record(evidence_record_id)` → 需先 INSERT record 行。
- **UNIQUE（闭环关键）**：`r2_evidence_record(evidence_snapshot_id, channel, op_type)` 保证同 sid 下 channel 不重复 → **I2「6 个 channel 真实不同」双重保证之一**。`r2_evidence_verification(evidence_record_id, verifier_id)` 去重。
- **CHECK**：channel 取值域、state 取值域、consumed 四字段非空、valid_from<valid_to 等（见 §1.1）。
- **索引**：草稿 OBJ-06/07 含 `uq_cg_audit_quad`、`uq_cg_one_final_decision`（部分唯一索引，依赖 `phase NOT NULL`）；闭环内无额外索引需求，`evidence_record_id` / `evidence_snapshot_id` 主键索引已足够。

---

## 3. 触发器 / PL-pgSQL 函数调用关系

```
sp_evidence_collect()            -- collector 角色
  └─ INSERT r2_evidence_record          (FK→object_outbox, evidence_signing_key)
  └─ INSERT r2_evidence_consumption(state='created')   ← 预置槽位行（闭环必需）

sp_evidence_verify()             -- verifier 角色
  └─ INSERT r2_evidence_verification
        └─ [AFTER INSERT] TRG-01 (SQL-A→SQL-B→SQL-C→SQL-D/SQL-E)
              SQL-A: SELECT r2_evidence_record (collector_id, collector_org_unit, payload_sha256)
              SQL-B: 三主体 + confirmed + hash 闸门 → RAISE 否则继续
              SQL-C: SELECT r2_evidence_consumption … FOR UPDATE   (LO-1 行锁)
              SQL-D: state created→verified  (CAS, ROW_COUNT 允许 0)
              SQL-E: COUNT(DISTINCT channel)=6 ⇒ state verified→consumable (CAS, ROW_COUNT=1)
```

> 函数调用关系清晰、无环：`sp_evidence_verify` → trigger → 仅读写闭环三表，不回调其他函数。

---

## 4. 事务边界（闭环相关）

| 事务 | 边界 | 原子性来源 |
|---|---|---|
| `sp_evidence_collect` | BEGIN → INSERT record + INSERT consumption → COMMIT | 单事务，record 与 consumption(created) 同生共死 |
| `sp_evidence_verify`（每一条复核） | BEGIN → INSERT verification → TRG-01 体内 SQL-C/D/E → COMMIT | 复核 INSERT 与状态推进同事务；任一 RAISE ⇒ 整事务 ROLLBACK（**I7**） |

> 锁顺序：闭环内仅 LO-1（槽位行 `FOR UPDATE`），无多锁顺序，故无死锁环（与 §9.2 LW-02 一致）。

---

## 5. SQL-A~E 闭环可执行性判定

| 检查点 | 结果 |
|---|---|
| 触发器入口对象存在 | ✅ `r2_evidence_verification` 存在 |
| 触发器读取对象存在 | ✅ `r2_evidence_record`、`r2_evidence_consumption` 存在 |
| FK 前置数据可构造 | ✅ object_outbox 桩行 + evidence_signing_key 行 + record 行均可合成 |
| channel 唯一约束可强制 I2 | ✅ `UNIQUE(sid,channel,op_type)` |
| CAS / RETURNING 严格检查存在 | ✅ SQL-D/E 用 `GET DIAGNOSTICS ROW_COUNT`，0/多行均 RAISE |
| 失败整事务回滚可达 | ✅ SQL-B/D/E 任意 RAISE ⇒ 触发函数随 INSERT 事务回滚 |
| 最小闭包自洽 | ✅ 5 对象 + 1 触发器即可完整复现十场景 |

---

## 6. 缺陷登记与修正

### D1（P2，设计漂移 → 已修正）`org_unit` 三主体分离未被 SQL-B 强制
- **现象**：§1 TRG-01 描述要求 `verifier_id != collector_id ∧ org_unit 相异 ∧ …`，但 §9.4 SQL-B 仅校验 `verifier_id`、`verification_result`、`verified_payload_sha256`，**漏校验 `org_unit`**。`r2_evidence_record` 原亦无 `collector_org_unit` 列，导致该闸门物理不可实现。
- **影响**：I4 不变量原仅覆盖 `verifier_id != collector_id`，「org_unit 独立性」未被 DB 强制，属三主体分离的部分缺失。
- **修正**：① OBJ-03 补 `collector_org_unit text NOT NULL`；② SQL-A 增补 `collector_org_unit` 取数；③ SQL-B 增补 `NEW.verifier_org_unit IS DISTINCT FROM v_collector_org` 闸门；④ I4 文案同步。以上均在两份 `.sql.draft` 内完成，未触碰正式迁移/代码。
- **闭环影响**：无阻断；修正后测试夹具须在 record/verification 上分别给**不同** `collector_org_unit`/`verifier_org_unit`（测试套件已纳入）。

### D2（P3，文档矛盾 → 已修正）§1 与 §9.4 推进措辞不一致
- **现象**：§1 写「六通道齐备时再推进 …（NOT EXISTS 检查）」，但 SQL-E 实际用 `COUNT(DISTINCT channel)=6`，非 NOT EXISTS。
- **修正**：§1 措辞改为「（COUNT(DISTINCT channel)=6 检查，对应 §9.4 SQL-E，非 NOT EXISTS）」。

### D3（P3，文档矛盾 → 已修正）§7 场景 9 标签自相矛盾
- **现象**：标题「同 sid 争同一槽位」但正文写「两个不同 sid 的复核事务都试图对【同一槽位行】FOR UPDATE」。槽位行 PK=evidence_snapshot_id，不同 sid 不可能映射同一行，故正文矛盾。
- **修正**：正文改为「同一 sid 下两个不同复核事务（不同 evidence_record_id / 多 snapshot）都试图对【同一槽位行】FOR UPDATE」，并加【第九轮修正】注。

### D4（P1 → 已消解，转为预演准入前置）引用「既有表」不在本仓迁移链
- **现象**：草稿引用 `app.object_outbox`、`cross_gen_*`、`shutree_sec` schema、角色 `shutree_app/shutree_worker` 等为「既有」，但本仓 `server/sql/001~005` 迁移链**不包含**这些对象（仅含 `entries/toc/words/discovered_books/convert_*` 等）。经全仓 Grep 确认这些对象仅存在于 V1.2.x 设计文档与 `stage_evidence_registry.json` 中，**本仓无其 DDL**。
- **影响**：若在**本仓**启动隔离 PG 并仅跑 `server/sql/*`，会因 FK 目标/`shutree_sec` schema 缺失而失败 → **无法直接复用现有迁移链作为闭环前置**。
- **处置（非缺陷，属预演工程决策）**：隔离预演 init 脚本（`03-init-cleanup.sql`）**自包含**提供最小基线桩——`CREATE SCHEMA shutree_sec` + `app.object_outbox(outbox_id)` 最小列 + 闭环所需角色——**不修改**正式迁移链；跨代/恢复相关对象（cross_gen_*、backup_manifests）按需在扩展预演中追加。此项已记入 Runbook §3.2 与准入表「初始化脚本是否完整」。

### D5（P0，执行阻断 → 第十轮已修正）TRG-01 SECURITY INVOKER 权限缺口
- **现象**：第九轮 `03-init-cleanup.sql` 的 TRG-01 为默认 `SECURITY INVOKER`，以调用者 verifier 身份执行；但 verifier 未被授予 `r2_evidence_consumption` 的 `UPDATE` 权限 → 触发器内 SQL-D/E 的 `UPDATE` 会以 `42501 insufficient_privilege` 失败，六通道推进全线不可用。
- **两难**：若直接给 verifier 补授 consumption UPDATE，则 T12「普通角色不可直改消费状态」失去证明力（可绕过受控入口）。
- **修正**：TRG-01 改 `SECURITY DEFINER + SET search_path=pg_catalog,pg_temp + OWNER=shutree_fn_owner`；fn_owner 为 consumption 属主，触发器以其身份在临界区合法推进；verifier 仍无 consumption UPDATE（T12/T12A~F 负向成立）；并 `REVOKE ALL ON FUNCTION ... FROM PUBLIC` 收敛 DEFINER 默认执行权。改后 T12F 正向入口仍可推进。
- **闭环影响**：无阻断；反而是闭环可执行的必要条件。SPI 快照语义不变，但须在真机验证 DEFINER 下行为（见 04b）。

### D6（P1，初始化语法错误 → 第十轮已修正）REVOKE 缺 ON 子句
- **现象**：第九轮脚本第 102/119 行 `REVOKE UPDATE, DELETE, TRUNCATE FROM PUBLIC, ...` 缺 `ON <table>`，psql 直接报语法错误，初始化失败。
- **修正**：第十轮重写为 `REVOKE ALL ON ALL TABLES IN SCHEMA ... FROM PUBLIC` + 逐对象精确 GRANT（见 03 段 F、07 §2.1）。
- **闭环影响**：无残留；`11-静态验证.py` 检查对象顺序与授权语句闭合。

### D7（P1，可执行性阻断 → 第十轮已修正）初始化 SQL 大量被注释
- **现象**：第九轮 `03-init-cleanup.sql` 全部 DDL 以 `--` 前缀注释，Runbook 要求「去注释后执行」，违背「真正可执行」要求，且人工去注释易漏。
- **修正**：第十轮重写脚本——所有 SQL 为可执行语句，说明外移，三闸门 + ON_ERROR_STOP + 单事务 + 幂等重置；清理脚本独立为 `03-cleanup.sql`。静态验证确认「零注释掉的可执行语句」。

---

## 7. 闭环最小对象清单（供 init 脚本与测试套件引用）

```
CREATE SCHEMA IF NOT EXISTS shutree_sec;
CREATE SCHEMA IF NOT EXISTS app;

-- 基线桩（最小列，仅满足 FK）
app.object_outbox(outbox_id uuid PRIMARY KEY);

-- OBJ-02 / 03 / 04 / 05 + TRG-01  + 角色/授权  → 见 03-init-cleanup.sql
```

> 本清单即 `03-init-cleanup.sql` 的「闭环子集」；`cross_gen_*` / `backup_manifests` / `TRG-02..09` 为「扩展子集」，默认注释停用，避免扩大预演面。
