# 阶段三-B 完成报告：Dexie 持久化层

> 基准：`练习/单词练习方案.md` V3.2 · 严格遵守 `产品前提卡-给协作方.md`
> 日期：2026-10-21 · 对应任务书「阶段 B（Dexie version(10) + 持久化层 + 幂等与多标签页）」

---

## 0. 结论先说

阶段 B 完成，四件套全绿。**两处源码 bug、一处测试自身错误**在收尾时被抓出并修掉；
新增了一个原计划里没有的**迁移测试**（v9→v10 存量数据不丢），因为这是唯一会**静默毁数据**的环节。

没有动：历史 migration、V3.2 已确认业务规则、任何第三方依赖、`server/`、任何正在运行的服务。

---

## 1. 交付物清单

| 文件 | 状态 | 内容 |
|---|---|---|
| `src/services/storage/web.ts` | 改（+18 行） | `version(10).stores({ spellingSessions: 'id, status, started_at, owner' })`；`ShushuDB` 加表声明；`INDEXED_FIELDS` 补索引；文件头补 v10 索引现状说明 |
| `src/domain/types.ts` | 改（+4 行） | `StorageSchema` / `PrimaryKeyMap` 加 `spellingSessions` |
| `src/services/storage/memory.ts` | 改（+3 行） | 内存驱动三张映射表同步补齐（`INDEXED_FIELDS` / `AUTO_INCREMENT` / `PRIMARY_KEY`） |
| `src/domain/spelling.ts` | 改（阶段二产物的修正） | `createSessionDraft` 改为自行完成选词过滤并返回 `available`；消除「双过滤」 |
| `src/domain/spellingSession.ts` | **新增**（约 450 行） | 持久化层：读库 → 调纯函数 → 整份写回 |
| `scripts/test_spelling_session.ts` | **新增** | fake-indexeddb 真实库测试，**112 项断言** |
| `scripts/test_spelling_migration.ts` | **新增** | v9→v10 迁移测试，**17 项断言** |
| `package.json` | 改 | test 链接入第 22/23 套；新增 `test:spelling-session` / `test:spelling-migration` 脚本 |

`git diff` 已核验：`package.json` / `types.ts` / `web.ts` / `memory.ts` 四个共享文件的改动**只有本次内容**，
未混入并行任务的未提交修改（工作树里另有约 30 个并行任务改动，本次一律未碰）。

---

## 2. 数据模型落地（任务书 B1）

`spellingSessions` 表，索引 `id, status, started_at, owner`：

- **单文档**：`queue`（词条状态数组）与 `processed_requests`（幂等键映射）**内嵌在会话行里**。
  理由：`TableService` 没有事务 API（`src/services/storage/types.ts` 已确认），
  只有「一次 `put()` 换整份文档」才能让「计数 + 状态 + 队列推进」原子生效。
- **不给 queue 内嵌字段建索引**：IndexedDB 不索引对象数组的内嵌属性，建了也不生效，
  反而误导后来人以为能按词条查。按词条查一律读整份会话文档（已在 `web.ts` 文件头写明）。
- **纯新增表，无 upgrade 函数**：存量库打开时自动建空表。

### 2.1 迁移安全性（原计划外补充）

方案只说「只新增 version(10)」，但**没人验证过打开存量 v9 库会不会丢老数据**。
这是整个阶段唯一可能静默毁数据的环节，所以补了 `scripts/test_spelling_migration.ts`：

1. 先用**只到 v9 的 schema**（照 `web.ts` version(1)~(9) 累积结果抄，故意不含 `spellingSessions`）
   建一个带真实数据的库并 `close()`；
2. **在此之后**才 `await import('../src/services/storage')` —— 单例构造时带 version(1)~(10)，
   打开时发现 verno=9 < 10，真正走升级分支；
3. 断言 vocab / reviewLog / readings / transcripts **一行不丢、字段不被改写**，
   新表为空、`status` 索引可用、升级后能直接建会话。

> 单独一个文件的原因：`test_spelling_session.ts` 顶部就 import 了 storage，
> 库会被直接建成 v10，根本走不到升级分支。放一起测等于没测。

---

## 3. 持久化层接口（任务书 B2）

方案 §6.4 定稿的 8 个接口全部落地，另加 5 个（加的理由见 3.2）：

```
createSession / getActiveSession / submitAttempt / skip / pause / resume / abandon / listHistory
+ getActiveSessions / getResumableSession / getSessionById / refreshAvailability / repairSrsHandoff
```

公共写入口 `mutate()`：读可恢复会话 → 校验 `IN_PROGRESS` → 交纯函数 → **一次 put**。
任何一步失败都抛 `SpellingSessionError`，**不返回成功**（方案 §8「不假报成功」）。

错误码：`NO_ACTIVE_SESSION` / `SESSION_CONFLICT` / `WORD_NOT_IN_QUEUE` / `SESSION_NOT_ACTIVE` / `WRITE_FAILED`。

### 3.1 本轮抓出并修掉的两个真 bug

**bug 1：双过滤，用户看不到被排除的词**
`createSession` 先自己调 `selectWords` 过滤一遍，再把**已过滤**的结果传给 `createSessionDraft`
（内部又过滤一次）。后果：`dropped` 恒为空数组 —— 用户问「我 22,791 个词怎么只出 3 个」时，
界面没有任何可展示的原因。
修法：过滤只在 `createSessionDraft` 内发生一次，调用方必须传**全量** entries（已加注释警告）。

**bug 2：交接标记写失败会把异常抛穿 `submitAttempt`**
`fulfillSrsHandoff` 末尾那次 `SESSIONS.put(current)` 在 try/catch **之外**。
后果：答案其实已经正确落库（`mutate` 的 put 成功了），用户却收到一个异常 —— 交互体感是「我白答了」。
修法：标记落库失败不再上抛，而是如实降级 —— 相关词重新记为待重试、返回与库一致的未标记会话，
outcome 报 `failed`，下次恢复由 `repairSrsHandoff` 补交。**绝不返回成功。**

### 3.2 多出来的 5 个接口，各自解决什么

| 接口 | 为什么必须加 |
|---|---|
| `getActiveSessions` | 并发边界见 §4。只返回「最新一份」会把另一份藏起来，UI 需要能告诉用户「有 2 份，选哪个」 |
| `getResumableSession` | `getActiveSession` 只返回 `IN_PROGRESS`；暂停后要能恢复，必须含 `PAUSED` |
| `getSessionById` | 测试与恢复流程需要按 id 精读；`getActiveSession` 做不到 |
| `refreshAvailability` | `removeFromVocab` 是**硬删除、无墓碑**，恢复时只能靠「查不到」判定词条是否已不在生词本 |
| `repairSrsHandoff` | 阶段 C 的恢复入口：补做上次没落成标记的 SRS 交接 |

---

## 4. 幂等与多标签页（任务书 B3）—— 能做到哪一步，说清楚

### 4.1 能做到的（有测试证明）

- **`request_id` 幂等**：命中 `processed_requests` 时**原样回放原结果**，
  不计数、不推进队列、不重复触发 SRS。测试验证了时间戳、计数、队列三重不变。
- **单文档写入原子**：一次 `put()` 内完成「计数 + 状态 + 队列推进」，写失败即什么都没发生。
- **写前检查 + 写后复核**：`createSession` 写完立刻重读，校验 id / status / 队列长度 / started_at，
  不一致就抛 `SESSION_CONFLICT`。

### 4.2 做不到的（不包装成「已实现互斥」）

任务书明确要求「不得通过虚假的写前/写后检查宣称实现了严格互斥」。如实说明：

- 两个标签页可能**各读到**「无活跃会话」，然后**各写一份不同 id** 的会话 → 库里出现 2 份活跃会话。
  写后复核挡得住「同 id 被覆盖」，挡不住这一种。
- 同一 id 的并发 `put()` 是 last-writer-wins，后写者覆盖先写者。

本层对策是把冲突**变成用户可见的选择**而不是静默数据丢失：
`createSession` 在有活跃会话时直接抛 `SESSION_CONFLICT`（挡住绝大多数情况），
同时 `getActiveSessions()` 暴露全部活跃会话供 UI 提示二选一。
文件头长注释已写明「这不是互斥锁，也不宣称是」。

**为什么不上真互斥**：需要改 `StorageService` 抽象加事务能力，影响全部既有表，超出本轮范围；
已列入待用户裁决。

---

## 5. SRS 交接（D2）与阶段 C 预告

实现落在 `fulfillSrsHandoff()`，规则严格按 D2：
**仅** `status === 'COMPLETED'` 且 `srs_reported === false` 的词条产生义务；
SKIPPED / UNAVAILABLE / 过程中的单次对错都不交接。

交接结果分五档（而不是简单的成功/失败，避免把「无对象」说成「失败」）：

| outcome | 含义 |
|---|---|
| `none` | 没有待交接词条 |
| `reported` | 全部交接成功并已落标记 |
| `dropped` | 全部无交接对象（词条已删），已落标记、不会重试 |
| `partial` | 一部分成功、一部分没成功 |
| `failed` | 一个都没成功，且存在写入失败（会重试） |

### 5.1 已经用测试钉住的边界

`scripts/test_spelling_session.ts` 最后一组**如实验证了「可能多调度一次」**，而不是宣称恰好一次：

1. 注入故障，只打断「会话表」的第 2 次 put（即写 `srs_reported` 标记那次）；
2. 断言 `outcome === 'failed'`、`srs_reported` 没落库、**同时** `recordQuiz` 的副作用已经发生了
   （reviewLog 有 1 行、`consecutive_correct` 已经 +1）；
3. 再调 `repairSrsHandoff()` 补交 → 断言 reviewLog 变成 **2 行**、`consecutive_correct` 变成 2。

第 3 步的断言是**故意写成「多了一次」**的：它把设计文档里承认的风险变成可回归的可见事实，
防止后来人误以为已经修好了。影响面可量化：该词 `consecutive_correct +1`、`srs_step` 前进一档、
`next_review` 推后一档、reviewLog 多一行；在首档 10min 的情况下等于 10min → 1h。

### 5.2 阶段 C 还要补的

- 另外三种中断场景的测试（完成词条后 SRS 写入前退出 / SRS 写入成功标记保存前退出 / 标记保存失败 / 恢复时重复发现待交接词条）；
- 故障注入手段目前是 patch `DexieTableService.prototype.put`（`storage.table()` 每次返回新实例，
  只能从原型入手），阶段 C 需要覆盖 `recordQuiz` 自身抛错的路径；
- 向用户报告「不宣称恰好一次」的完整边界与三种更重替代方案（改 `StorageService` 抽象加事务 /
  给 reviewLog 建唯一索引做幂等键——属改历史表结构，方案禁止 / 独立交接流水表需 version(11)）。

---

## 6. 验证记录（四件套，全部实测）

| # | 命令 | 结果 |
|---|---|---|
| 1 | `npx tsc --noEmit` | exit 0，**0 error**（日志 0 行） |
| 2 | `npm test` | exit 0，**23 套全绿**。其中 `test_spelling.ts` 127 项断言、`test_spelling_session.ts` 112 项、`test_spelling_migration.ts` 17 项 |
| 3 | `npm run build` | exit 0，16.52s，`dist/sw.js` + workbox 正常产出，15 项预缓存 |
| 4 | `python scripts/check_pwa.py` | exit 0，10 项体检通过 |

测试过程中实际抓到的问题（都已修）：

1. `current_position` 断言写错 —— 我按「abandon 是 position 0」推的，但 `recent` 模式按
   `added_at` 倒序，abandon 是**最早加入的**，实际排最后。改为断言「current_position 指向的词是 PENDING」，
   与选词模式解耦。
2. `fulfillSrsHandoff` 末尾 put 在 try 之外（见 §3.1 bug 2）。
3. 测试里「第 3 次对后 COMPLETED」的序列本身算错：对/错/对/对 = 连续 2 不是 3，补了第 5 次提交。

---

## 7. 待用户裁决 / 下一步

1. **并发互斥要不要做真方案**（改 `StorageService` 抽象加事务能力，影响全部既有表）—— 超出本轮范围，未擅自实施。
2. **SRS 恰好一次要不要做重方案**（reviewLog 唯一索引属改历史表结构，方案禁止；独立流水表需 version(11)）。
3. **阶段 D 前端**：`/review` 卡片 + `/spelling` 练习页 + `/spelling-result` 结果页。
   注意：并行任务已把 `AppShell` 契约从 `showTopSearch` 改成 `showGlobalSearch`、
   撤掉 `TopSearchBar` 改 `SearchDock`，阶段 D 加路由时须按**新**契约，且只追加不改他人部分。
4. 方案 V3.2 不需要更新——本轮实现与 §6.3/§6.4 契约一致（「由调用方（阶段三）执行」即持久化层，
   已在 `fulfillSrsHandoff` 注释里把这个读法写明，避免后来人误解成页面负责）。
