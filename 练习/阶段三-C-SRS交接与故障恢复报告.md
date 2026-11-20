# 阶段三-C 完成报告：SRS 交接与故障恢复

> 基准：`练习/单词练习方案.md` V3.2 · 严格遵守 `产品前提卡-给协作方.md`
> 日期：2026-10-21 · 对应任务书「阶段 C（SRS 交接语义、故障恢复、幂等边界及对应测试）」

---

## 0. 结论先说

阶段 C 完成，四件套全绿。**复现了 C2 的重复交接窗口**（不是理论上说说，是有断言的），
并**抓出阶段 B 遗留的一个真实缺陷**：会话自然结束后未交接的词永远等不到补交，SRS 积分静默丢失。

没有做：不改历史 migration、不新增 version(11)、不改 `StorageService` 抽象、不引入新依赖、不接页面。
**没有把交接标记成「恰好一次」** —— 测试里明确断言了「会重复」这一行为。

---

## 1. 真实调用时序（先实证，再谈窗口）

用调用记录器包住 `DexieTableService.prototype` 的全部读写方法，实测「第 3 次答对触发交接」的完整链路：

```
 1. spellingSessions.whereIndex(status=IN_PROGRESS)     ← mutate 读会话
 2. spellingSessions.whereIndex(status=PAUSED)
 3. spellingSessions.put(id=seq-1 type=spelling)        ← ① 写计数/状态/队列推进
 4. vocab.get(key=CET4:abandon)                         ← recordQuiz 开始
 5. reviewLog.add(quiz_form=spelling)                   ← SRS 副作用 1
 6. vocab.put(id=CET4:abandon)                          ← SRS 副作用 2
 7. sync_queue.put(...)                                 ← SRS 副作用 3
 8. sync_queue.toArray
 9. sync_queue.put(...)                                 ← SRS 副作用 4
10. sync_queue.delete
11. sync_queue.toArray
12. spellingSessions.put(id=seq-1 type=spelling)        ← ③ 写 srs_reported 标记
13. sync_queue.count
```

**故障窗口 = ③ 与 ①② 之间**：第 3 步到第 12 步之间任何时刻中断，
`reviewLog` / `vocab` / `sync_queue` 的副作用已经发生，而 `srs_reported` 还是 false。

另外实测确认：**第 1、2 次答对时整条链路没有任何 `reviewLog.add` / `vocab.put`** ——
未完成的词不产生交接，D2 的「仅 COMPLETED 才交接」是成立的。

---

## 2. C1–C4 测试结果

全部在 `scripts/test_spelling_srs_handoff.ts`（101 项断言），故障注入打在
`DexieTableService.prototype` 的**真实 IndexedDB 读写点**上（`get`/`put`/`add`），
不是 mock 业务函数 —— 否则分不出「写库失败」和「业务抛错」。

| 场景 | 注入点 | 结果 |
|---|---|---|
| **C1** 词条完成已持久化、`recordQuiz` 前中断 | `vocab.get` 抛错（`recordQuiz` 的第一个操作） | ✅ 词条保持 `COMPLETED`、`srs_reported=false`、reviewLog 0 行、`consecutive_correct`/`srs_step`/`next_review`/`layer`/`mastered_at` **全部未变**；`pendingSrsWords()` 能重新发现义务；补交后 reviewLog 恰好 1 行、`srs_step` +1、`last_quiz_form='spelling'`；二次补交 outcome=`none` 不再调度 |
| **C2** `recordQuiz` 成功后、标记保存前中断 | `spellingSessions.put` 第 2 次抛错 | ✅ outcome=`failed`（不谎报成功）；标记未落库；**但 `recordQuiz` 副作用已发生**；补交后 reviewLog **1→2 行**、`consecutive_correct` **+1→+2**、`srs_step` **+1→+2**、`next_review` 再次推后 |
| **C2b** 重复交接的最坏情况 | 同上 + 前置 `consecutive_correct=4` | ✅ **一次崩溃窗口让词从 `new` 连跳两级到 `mastered` 并写下 `mastered_at`**（4→5 时 new→apply，5→6 时 apply→mastered） |
| **C3** `markSrsReported()` 写入失败 | 补交路径上 `spellingSessions.put` 第 1 次抛错 | ✅ outcome=`failed`、`lost=[该词]`、`reported=[]`；返回值与库状态一致（`srs_reported=false`），**没有假报**；⚠ 但 `recordQuiz` 已生效，重试必然让 reviewLog 变 2 行、`consecutive_correct` 累计 +2 |
| **C4** 恢复时重复发现待交接词条 | 无注入，构造「一个已标记 + 一个未标记」 | ✅ 已标记词不被重复调度（reviewLog 恒 1 行）；未标记词进入待处理；`repairSrsHandoff` 连调 3 次后 outcome=`none`；`resume`/`pause` 本身**不触发任何交接** |

### 2.1 C2 与 C3 是同一个窗口

任务书把两者分开列，实测结论是：**从持久化状态看它们完全等价**，
差别只在触发原因（进程崩溃 vs. 写库报错）。恢复路径、重复副作用的量、修复方案都相同。
这一点写在这里，避免后来人以为修了 C3 就顺带修了 C2。

---

## 3. 阶段 B 遗留缺陷（本轮已修）

**缺陷**：`repairSrsHandoff()` 原先只查 `IN_PROGRESS` / `PAUSED` 会话
（走 `getResumableSession()`）。会话**自然结束**（`SESSION_COMPLETED`）后返回 null，
直接抛 `NO_ACTIVE_SESSION`。

**触发路径**：一个多词会话里，**最后一个词**完成时交接失败（`recordQuiz` 抛错）。
此时会话变成 `SESSION_COMPLETED`，那个词停在 `COMPLETED` + `srs_reported=false`，
**没有任何代码路径会再调度它** —— SRS 积分静默丢失，界面上也看不出异常。

**为什么阶段 B 没发现**：批量清扫特性把它遮住了。`fulfillSrsHandoff` 扫的是**整份队列**，
所以只要后面还有别的词完成，遗留的未标记词会被顺带补上（这条特性本轮也固化成测试了）。
只有「最后一个词」这一种情况会露出来。

**修复**：`repairSrsHandoff()` 改为扫描**全部会话**（含 `SESSION_COMPLETED` / `ABANDONED`）。
理由：D2 的义务在词条转 `COMPLETED` 的那一刻就产生了，不因会话结束而消失。
代价是一次补交可能横跨多个历史会话，量级个位到几十，可接受。

**回归证明**：临时把修复回退成旧行为，缺陷测试 **8 项失败**；恢复修复后全绿。测试是有效的，不是摆设。

---

## 4. 交接保证级别（方案评估）

### 方案 A：保持当前结构 —— **已采用**

**能保证**：
- 义务不丢：任何 `COMPLETED` + 未标记的词，最终都会被补交（批量清扫 + 全会话扫描 + 恢复入口）。
- 不会漏调度：宁可重复也不少调度。
- 不假报成功：写入失败一律降级为 `failed`/`partial`，返回值与库状态一致。
- 幂等键（`request_id`）保证的是**答题计数**不重复，与 SRS 交接无关 —— 这一点没有混为一谈。

**不能保证**：
- **恰好一次**。C2/C3 窗口内中断 ⇒ 重复交接，影响面见 §2 表格。
- 跨标签页互斥（任务书明确不宣称）。

**结论**：当前实现的上限是**可恢复的至少一次调度（at-least-once）**。
这与「恰好一次」的差距就是那一个 `srs_reported` 标记的写入缝隙。

### 方案 B：独立交接流水表 —— 需要 version(11)，未实施

若要做到「记录意图 → 执行 → 确认」三段可对账，最小字段集：

| 字段 | 用途 |
|---|---|
| `id` | 主键 |
| `word_id` | 交接对象 |
| `session_id` | 来源会话 |
| `idem_key` | **幂等键**，如 `${session_id}:${word_id}`，唯一索引 |
| `status` | `pending` → `done` / `dropped` |
| `attempts` | 重试计数 |
| `last_error` | 最近一次失败原因 |
| `created_at` / `updated_at` | 对账与清理 |

关键点：**光有幂等键不够**。`recordQuiz()` 本身不读任何键，
所以必须在调用前 `put({status:'pending', idem_key})`、调用后 `put({status:'done'})`，
恢复时只补 `pending` 的行 —— 这仍然有「调用后、置 done 前」的缝隙。
要真正消除，得让 `recordQuiz` 接受一个调用方提供的 `uid` 并按 `uid` 去重
（`reviewLog` 已有 `uid` 字段，但**没有唯一索引，加索引属于改历史表结构，方案禁止**）。

⇒ 方案 B 需要 version(11) + 改 `recordQuiz` 签名 + 改 `reviewLog` 索引，
**超出本轮范围，未实施**。

### 方案 C：最小改造 —— 评估后认为收益有限

想过「把 `recordQuiz` 的 `uid` 由会话侧生成并先落库」：
- 原子性依据：`reviewLog` 的 `uid` 若唯一，重复 add 会被拒。但**当前没有唯一索引**，
  `add` 不会失败，只会插入第二行 —— 所以这个方案**依赖改历史表结构**，与 B 同等代价。
- 失败窗口：与现状相同（仍有两个写操作）。
- 迁移成本：version(11) + `recordQuiz` 签名变更 + 全部既有调用点（`learning.ts` 内多处）回归。

⇒ 方案 C 在当前约束下**退化成方案 B**，没有更便宜的路。

---

## 5. 验证记录（四件套，全部实测）

| # | 命令 | 退出码 | 结果 |
|---|---|---|---|
| 1 | `npx tsc --noEmit` | 0 | 0 error |
| 2 | `npm test` | 0 | **24 套全绿**。`test_spelling.ts` 127 断言 / `test_spelling_session.ts` 112 / `test_spelling_migration.ts` 17 / `test_spelling_srs_handoff.ts` **101** |
| 3 | `npm run build` | 0 | precache 15 项 1242.69 KiB |
| 4 | `python scripts/check_pwa.py` | 0 | 10 项体检通过 |

测试过程中我自己写错 3 处布置（都改了，值得记下来防止重犯）：
1. C3 只提交了 2 次，词根本没完成 ⇒ 没有待交接词，outcome 自然是 `none`。
2. 缺陷回归测试里拦 A 的 `recordQuiz`，结果 B 完成时被**批量清扫**补上了，造不出目标状态
   ⇒ 改成拦**最后一个词**。
3. 测试助手用 `vocab.get` 取答案，和 `recordQuiz` 内部的 `vocab.get` 撞在同一个注入点上
   ⇒ 改为启动时缓存词表，助手不再读库。

---

## 6. 需要你裁决的事

1. **要不要上 version(11) 做交接流水表（方案 B）**。当前是 at-least-once；
   上 B 能把这个窗口从「可能重复一档 SRS」压到「有对账依据的可补偿」，但代价是
   改 `recordQuiz` 签名 + 全部既有调用点回归。**我的建议：先不上** ——
   重复交接的最坏后果是「一个词多推一档复习间隔 / 极端情况连跳两级到 mastered」，
   而为了消灭它要动的是主学习链路的核心函数。
2. **「放弃会话」是否补交**。当前策略：补交（D2 义务不随放弃消失）。
   若产品侧认为「放弃 = 丢弃本轮积分」，改 `repairSrsHandoff` 的过滤条件一行即可，我已加测试记录当前策略。
3. **阶段 D 前端**仍待开始（`/review` 卡片 + `/spelling` + `/spelling-result`）。
   注意并行任务已把 `AppShell` 契约从 `showTopSearch` 改成 `showGlobalSearch`、
   撤掉 `TopSearchBar` 改 `SearchDock`，加路由须按新契约。

---

## 7. 修改文件

| 文件 | 改动 |
|---|---|
| `src/domain/spellingSession.ts` | 改：`fulfillSrsHandoff` 拆出 `SrsHandoffWork` 明细 + `handoffOutcome()` 纯函数；`repairSrsHandoff` 改为扫描全部会话并返回 `SrsRepairResult`（含 `reported`/`dropped`/`lost` 明细）；新增 `getAllSessions()`；`listHistory` 改为委托它；文件头补阶段 C 说明 |
| `scripts/test_spelling_srs_handoff.ts` | **新增**，101 项断言：调用时序实测 + C1/C2/C2b/C3/C4 + 缺陷回归 + 放弃策略 + 批量清扫 |
| `package.json` | 改：test 链接入第 24 套；新增 `test:spelling-srs` 脚本 |

未动：历史 migration、`StorageService` 抽象、`recordQuiz`、任何页面、任何依赖、`server/`。
