# 阶段 E · 只读冻结与审查清单

- 执行时间：2026-10-22 00:20 前后
- 约束：**只读**。不恢复、不清理、不覆盖任何其他任务的未提交改动；不改任何代码或断言。

## 1. 文档基线（已读）

| 文档 | 位置 | 关键结论 |
| --- | --- | --- |
| 产品前提卡 §0 / §8 红线 | `产品前提卡-给协作方.md`（交付包内版，另有一份在 `../` 上级目录，非同一文件） | 红线 1 不编造数据；红线 2 不改已写好的代码/不顺手重构；平台 API 只在 `src/services/*/web.ts`；验证四件套全绿才算完 |
| 产品前提卡 §9 界面自查 | 同上 | 图标按钮 `aria-label`+`title`；触摸目标 ≥44px；空数据走 `EmptyState`；375px 不横向溢出 |
| 方案 V3.2 §2.1/§2.2/§2.3 | `练习/单词练习方案.md` | 计数规则、聚合口径、`normalizeInput = trim + toLowerCase`、连字符严格比对、空白提交 = invalid 不计数不清零 |
| 方案 V3.2 §3.1–3.4 | 同上 | 单词 5 态 / 会话 4 态 / 转换表 / 推进规则 |

## 2. Git 工作树（实测）

`git status --short` 共 **104 条**（28 个已跟踪文件改动 + 76 个未跟踪条目）。本功能相关：

- 已跟踪改动：`src/App.tsx`、`src/pages/Review.tsx`、`package.json`、`src/domain/types.ts`、`src/services/storage/web.ts`、`src/services/storage/memory.ts`
- 未跟踪新增：`src/domain/spelling.ts`、`src/domain/spellingSession.ts`、`src/pages/Spelling.tsx`、`src/pages/SpellingResult.tsx`、`scripts/test_spelling{,_session,_migration,_srs_handoff,_ui}.ts`、`练习/`

## 3. 共享文件 diff 归属核验（实测，非推测）

| 文件 | 本功能改动 | 并行任务改动 | 结论 |
| --- | --- | --- | --- |
| `src/App.tsx` | 2 import + `/spelling` `/spelling-result` 两条路由 | 5 处 `showTopSearch={false}` → 删除；`/search` 改 `showGlobalSearch={false}` | **混存**。并行任务改动经 grep 确认**完好无损**；本功能改动是纯追加、位置不重叠 |
| `src/pages/Review.tsx` | 「单词默写」入口卡片 | 无 | 100% 本功能 |
| `package.json` | test 链 + 5 个 spelling 脚本 | 无 | 100% 本功能 |
| `src/domain/types.ts` | `StorageSchema.spellingSessions` + `PrimaryKeyMap` | 无 | 100% 本功能（v10 注册） |
| `src/services/storage/web.ts` | `version(10).stores(...)` + 表声明 | 无 | 100% 本功能 |
| `src/services/storage/memory.ts` | 三张映射表补 `spellingSessions` | 无 | 100% 本功能 |

## 4. AppShell 契约核验（实测源码，不靠记忆）

- `src/components/layout/AppShell.tsx` 实际 props：`showGlobalSearch?: boolean`，**默认 `true`**（第 24 行 `showGlobalSearch = true`）。
- **不存在** `showTopSearch`；`TopSearchBar` 已被并行任务删除（git status 显示 ` D`）。
- 底部停靠组 `SearchDock` 已由并行任务接入并被 `AppShell` 引用（第 3、36 行）——**保留未动**。
- `/spelling`、`/spelling-result` 均用裸 `<AppShell>`（继承默认 true），未传任何已废弃 prop。✅

## 5. 阶段 A/B/C 真实导出接口（源码实测，非历史报告）

`src/domain/spelling.ts`（纯状态机，零 storage 依赖）实测导出 30 项，包含：
`normalizeInput` / `hasValidAnswer` / `judgeSpelling` / `isSelectable` / `selectWords` / `createSessionDraft` /
`sessionProgress` / `aggregateSession` / `applyAttempt` / `skipWord` / `markUnavailable` / `markSrsReported` /
`pendingSrsWords` / `pauseSession` / `resumeSession` / `abandonSession` / `isSessionStale` / `currentWord`，
常量 `DEFAULT_TARGET_CORRECT=3` / `STALE_PAUSE_MS` / `VALID_ANSWER_RE`，类型 13 个。

`src/domain/spellingSession.ts`（持久化层）实测导出 20 项：
`getAllSessions` / `listHistory` / `getActiveSession` / `getActiveSessions` / `getResumableSession` /
`getSessionById` / `createSession` / `submitAttempt` / `skip` / `pause` / `resume` / `abandon` /
`refreshAvailability` / `repairSrsHandoff` / `handoffOutcome` / `SpellingSessionError`，以及从 `./spelling` 的 21 项再导出。

**与阶段 D 前端 import 的符号逐一比对一致**（Spelling.tsx 导入 17 个、SpellingResult.tsx 导入 4 个，全部存在于上述导出中）。

## 6. 测试脚本清单（实测）

`npm test` 链共 **25 套**，其中本功能 **5 套**：
`test_spelling.ts` / `test_spelling_session.ts` / `test_spelling_migration.ts` / `test_spelling_srs_handoff.ts` / `test_spelling_ui.ts`。

## 7. 审查结论

可以进入自动化验收。三项注意：

1. `src/App.tsx` 是混存文件，**提交必须逐行拆分**，不能整文件 `git add`。
2. 本功能 5 套测试脚本均未入版本控制，提交时需显式按路径加入。
3. 阶段 E 只验收，不做重构；发现的问题单独列「后续建议」，不顺手改。
