# 实施 B 后 · G9 五条复核与证据索引（2026-11-05）

> **性质**：对《G9五条验收核对报告.md》（设计态，2026-11-05 第一阶段）的**实施后复核**，不改历史设计稿判定、不代替负责人签字。
> **权威出处**：`产品方案/打字/Phase1.2.2-准入裁定补丁.md` §6.4 / §6.5。
> ⚠️ **状态更新（2026-11-05 18:16 (GMT+8)）**：G9 已标记 **CLOSED**、D9 **解除**（依据项目负责人本对话书面裁决）；以下总判定及 §四 结论为当时快照，最新状态见 `G9-负责人确认单.md`。
> **总判定（当时快照）：G9 仍不关闭**。补充的是技术证据，关闭闸门（五条全勾 + 书面记录 + 负责人确认）仍需人类完成。

---

## 一、逐条复核表

| # | 标准（§6.4） | 设计稿判定 | 实施 B 后 | 证据文件 / 位置 |
|---|---|---|---|---|
| 1 | 指定 `spellingErrorEvents` 落在哪个 Dexie 版本 + 写明该版本**完整 `stores()` 声明** | 部分满足 | **技术已具备，待书面确认** | `src/services/storage/web.ts:257-259` `version(14).stores({ spellingErrorEvents: '&event_id, owner, word_id, session_id, kind, occurred_at, status' })`；`src/domain/types.ts` 类型定义；`scripts/test_spelling_reliability.ts` 组 6 证明索引可用、行内字段不改 schema |
| 2 | 明确 v12 两种表述以哪份为准；`readings/annotations` 与 `spellingErrorEvents` 是同一 version 还是分版本 | 已满足（文本层） | **不变** | `web.ts` v12（5 表补 owner）/ v13 / v14 分版本；本轮零新增 `version()`、零改 `stores()`，原生 IDB 仍 140 |
| 3 | 明确 ×10 夹具基线、版本序列、维护人；确认夹具覆盖「全部 v11 表与索引」 | 部分满足 | **部分满足（夹具已有实测）** | `scripts/test_bookschema_migration.ts` v11→v14 迁移 25 项全绿（存量零丢失、v12 回填、v14 新表）；×10 映射见 `web.ts` 与前提卡；**具名维护人仍待指派** |
| 4 | 明确 `blocked`/`versionchange` 由谁落地、何时落地 + 升级窗口双标签写入的中断/恢复约定 | 未满足 | **技术前提已全部具备，待审核人书面确认** | 见下表「标准 4 证据链」 |
| 5 | 明确三文件合并顺序、冲突解决人，并指定结果与双方确认的记录位置 | 部分满足 | **不变** | 顺序/冲突解决人见 `v12-v13-v14-责任矩阵.md`；V1.2.11 收敛稿 §7.3 建议文本**未追加**，「双方确认」未发生 |

### 标准 4 证据链（本次补上的核心）

| 原缺失项 | 实施 B 落地 | 证据 |
|---|---|---|
| `spellingErrorEvents` 写逻辑未落地 | `submitAttempt` / `skip` 生产写路径真实接入 T-A→T-B→T-C | `src/domain/spellingSession.ts`；`scripts/test_spelling_reliability.ts` 组 5（9 项） |
| `drainPendingErrors()` 无启动钩子 | `main.tsx` `initStorage()` 后调用 `drainPendingEvents()`，渲染等其完成 | `src/main.tsx`；组 3 S1/S2 用例 |
| U16 恢复链未成文/未实现 | `resetAfterReconnect`（open→重读会话→取锁）+ drain + 解锁输入；`versionchange` 生命周期广播 | `src/domain/spellingLock.ts` / `web.ts`；组 4（9 项） |
| L2 写锁 D4 待批准 | 单表 CAS 锁 + fencing token + takeover/release/续期/过期/安全降级全部落地 | `src/domain/spellingLock.ts`；组 2（20 项） |
| 真机双标签升级窗口回归未通过 | Edge + puppeteer-core 隔离 profile，10/10 全过（含接管、旧标签被拒、升级事务回滚后重启） | `scripts/check_reliability_browser.mjs`；`练习/_reliability-browser/_reliability-browser-report.json` + 5 张截图 |

**仍未消除**：跨表 TOCTOU（U11）与 C09/T29 残留窗口（U1，降级未消除）；真机 4 项 N/A（in-flight 逐拍时序、升级中途 kill 进程、Chromium/Firefox 矩阵、移动端）。这些影响「恢复可靠性」的完整结论，**不改变 §6.4 五条的书面判定口径**，但必须在上线评估中如实列出。

---

## 二、D4 / D12 遗留裁定建议（提交负责人，不自行宣布生效）

| 编号 | 建议裁定 | 依据 |
|---|---|---|
| **D4** | 裁定「采纳 L2 跨标签单写者锁（α）」为生效方案；并批准锁过期 30s / 后台 120s / 心跳 10s / 安全降级只读四项实施参数 | 授权清单 Q3/Q5 已裁定 α；参数为本轮新增实施取值，尚无产品裁定 |
| **D12** | 裁定「`lock_epoch` + 事件 `tab_id`/`lock_epoch` + `applied_error_event_ids` 凭证 + stale 计入错词本但不归零」为已批准；接受 U1 残留（可能多一条 `settled_skipped`） | 组 3 stale 用例 + 真机 R5/R7b 实测 |
| **新增** | 确认 `SpellingErrorEventStatus` 增加 `'settled_skipped'`；确认 `applied_error_event_ids` 的长期保留策略 | 本轮枚举扩展 |

---

## 三、G9 关闭所需的人类动作（本轮未做、不代签）

1. 项目负责人 + 并行架构负责人对 §6.4 五条**逐项勾选并书面留痕**。
2. 架构负责人书面确认 v14 完整 `stores()` 声明与 `kind/status` 枚举取值（标准 1 缺失项）。
3. 项目负责人指派 §三责任矩阵中的具名执行人/审核人/维护人（标准 3 缺失项）。
4. 授权将结论 §5.2 建议文本追加进 V1.2.11 收敛稿 §7.3，并取得双方确认（标准 5 缺失项）。
5. 审核人对标准 4 的恢复约定书面确认（U16 生效协议）。
6. 上述完成后方可关闭 G9、解除 D9 阻塞。

> **本复核只提供证据与建议，不宣称 G9 关闭、不伪造任何签字、确认或账号权限。**


---

## 四、实施 C（G9 关闭冲刺）后复核 · 2026-11-05 傍晚

> 依据：《Tellshu 项目全面推进授权书》与 G9 冲刺指令。本节只追加，不改写上文设计态判定。

| # | 实施 B 后 | 实施 C 后 | 本轮新增证据 |
| --- | --- | --- | --- |
| 1 | 技术已具备，待书面确认 | **不变**（技术证据更充分，仍待架构负责人书面确认） | `web.ts` `stores()` 两轮零改动；`status` 新增 `'settled_skipped'` 待确认；`scripts/test_spelling_reliability.ts` 组 6 证明行内字段不改 schema |
| 2 | 已满足（文本层） | **不变** | `web.ts` version 仍为 10–14，本轮零新增 version |
| 3 | 部分满足（夹具已有实测） | **部分满足**：夹具与并发/迁移证据加强 | v11→v14 迁移 25 项；本轮原子批回滚/并发 118 项断言；**具名维护人仍待指派** |
| 4 | 技术前提已具备，待审核人确认 | **技术证据已完整**（U11/U1 消除、事务 abort、versionchange、重启 drain、双标签真机） | 见下方「标准 4 补充证据链」；仍待审核人书面确认 |
| 5 | 部分满足（记录位置未追加、双方确认未发生） | **记录位置已具备**（V1.2.11 §7.3 已追加 §7.4 状态更新）；**双方确认仍缺** | `V1.2.11-…收敛稿.md` §7.4；`G9-五条证据索引.md` |

### 标准 4 补充证据链（本轮）

| 验证目标 | 证据 |
| --- | --- |
| U11 跨表 TOCTOU 消除 | `src/services/storage/{types,web,memory}.ts` 新增 `atomicBatch`；`src/domain/spellingSession.ts` `atomicSubmit` 把锁校验/事件/凭证放进同一事务；`src/domain/spellingErrorEvents.ts` `settleErrorEvent` 同事务 |
| U1 / C09/T29 残留窗口消除 | 失败测试原始输出 `验收证据/U11-U1-竞态失败测试-实施前原始输出.txt`（2 项失败）→ 原子化后 `验收证据/U11-U1-原子化后测试原始输出.txt`（118 项全过，组 7 全绿） |
| 事务 abort / 并发串行化 / 重复 event_id | `test_spelling_reliability.ts` 组 8（commit / rollback / 抛错回滚 / 双驱动 / 并发两事务 / 幂等重放） |
| versionchange、重启 drain、takeover | 组 4 + 组 8.5/8.6/8.7；真机 R7a/R7b、R8/R9 |
| 进程 kill / 渲染进程崩溃 | `scripts/check_reliability_recovery_browser.mjs` R8（CDP `Page.crash`）+ R9（`SIGKILL` 后同 profile 重启），8/8 全过 |
| 未覆盖（N/A） | IDB 事务逐拍 in-flight 时序、跨内核矩阵（无 Chrome/Firefox）、真实移动设备（无 adb/真机，R11 仅视口模拟） |

### D4 / D12 裁定状态

- 本轮把「建议裁定」推进为**技术实现完成**，但**裁定本身仍需负责人签发**；文档不自行宣布 D4 / D12 生效。
- 新增待裁定项：`SpellingErrorEventStatus` 的 `'settled_skipped'`；租约参数（30s / 120s / 10s）；事件表与凭证的保留/清理策略。

> **总判定：G9 仍不关闭、D9 保持阻塞。** 五条证据中标准 1/3/5 的书面确认、双方确认、负责人确认仍缺失；本轮不代签、不伪造。
