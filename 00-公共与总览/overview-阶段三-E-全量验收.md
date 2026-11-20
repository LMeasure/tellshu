# 单词默写 · 阶段 E 全量验收概览

**结论：有限通过（Limited Pass）** —— 三层分开看，不能互相替代。

| 层面 | 结论 |
| --- | --- |
| 自动化通过 | ✅ 四命令退出码全 0；25 套测试 0 失败（1004 通过断言）；新增业务验收 95 项全过 |
| 人工验收通过 | ✅ 真实 Edge 155 浏览器 64 项 + 路由补充 10 项全过；**真机软键盘未验证** |
| 仍有已知限制 | ⚠️ 3 项均未修复（SRS at-least-once / 多标签页非原子互斥 / 冲突提示非实时） |

## 自动化（真实退出码）

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `npx tsc --noEmit` | 0 | 零错误 |
| `npm test` | 0 | 25 套、1004 通过断言、0 失败 |
| `npm run build` | 0 | 2196 modules，precache 15 entries |
| `python scripts/check_pwa.py` | 0 | 10 项全过 |

本功能 5 套：127 + 112 + 17 + 101 + 86 = **443 项断言**。本轮新增 `test_spelling_acceptance_e.ts`（95 断言，未接入 npm test 链）。

## 🔴 三条最重要的发现

1. **多标签页并发创建竞态在真实浏览器里复现了** —— 两个标签页同时 `goto /spelling`，库里出现 **2 份 IN_PROGRESS**（6 次尝试命中 1 次，结果会飘）。**但不会互相覆盖也不会重复计数**：顺序打开恢复同一会话、A 提交后 B 刷新进度一致且 `total_attempts=1`、裁决后另一页刷新也没复活被放弃的那份。

2. **冲突提示不是实时的（新发现）** —— 两份会话并存期间两个页面都照常练习、互不知情，**只有下次进入（刷新/导航）才弹冲突选择**。已列后续建议，本轮未引入任何锁/事务/version(11)。

3. **`src/App.tsx` 无法安全拆分暂存** —— 实测 HEAD 版 AppShell 只有 `showTopSearch`、TopSearchBar 存在；工作树 App.tsx 已含 `showGlobalSearch={false}`（并行任务）。按路径 `git add src/App.tsx` 会拖走并行任务改动，而这些改动依赖**尚未提交**的 AppShell/SearchDock/TopSearchBar 删除 ⇒ 三者不在暂存区时**索引无法编译**。已先报告、未暂存，给出三个选项。

## 浏览器验收

- 环境：Microsoft Edge **Edg/155.0.4283.62** + puppeteer-core 25.14.0，基准 `http://127.0.0.1:4174`
- 视口：375×667（窄屏）、375×420（软键盘模拟）、1280×800（宽屏）
- 覆盖：入口卡片、练习页布局与触摸目标、长释义/长单词、答题反馈、暂停/继续/放弃、完成与结果页、宽屏布局、双标签页冲突、刷新恢复、路由兼容
- 产物：**18 张截图 + 2 个 JSON** 在 `练习/_e-browser/`
- **未验证**：真机软键盘弹出（本环境无法调起输入法，以视口收缩近似）
- **观察**：`AppShell → SyncIndicator` 的「本地数据」chip 实测 88×24，低于 44px；属并行任务全局组件，按红线 2 未改

## Git 审查（2026-10-25 已按裁定执行提交）

**提交 `28b957e`**：17 个文件，+6477 / -3（12 新增 + 5 修改，全部为本功能）。

- 可安全按路径暂存：`Review.tsx`、`package.json`、`web.ts`、`memory.ts`（diff 100% 属本功能）
- **手术式暂存**：`src/domain/types.ts` 混有「转写→阅读器」链路 3 处改动，未整文件 add，
  改为基于 HEAD 版本只叠加拼写相关 3 处（`scripts/_stage_types_spelling_only.py`），工作树文件未动
- **未暂存**：`src/App.tsx`（裁定 A —— 混有并行任务 `SearchDock` / `showGlobalSearch` 改动且编译耦合），
  等并行任务合并后补 `git add src/App.tsx` 即可

⚠️ **提交树不能独立构建**（既有问题，非本次引入）：`HEAD` 就已断链——已跟踪的
`MediaTranscriptImport.tsx` import 了尚未提交的 `src/lib/download.ts`、`src/services/asr/`、
`src/domain/transcript/{validate,subtitle}.ts`。修好需补提交那批属于别的任务的源码，本轮未动。

## 用户 5 项裁定（全部维持现状）

1. `App.tsx` → **A. 先不暂存**，其他按路径 add
2. 多标签页实时冲突提示 → **本轮不上**，维持下次进入才提示
3. version(11) 交接流水表 → **不上**
4. `/result` 占位页 → **不动**
5. 验收脚本接入 npm test 链 → **不接**

完整报告：`练习/阶段三-E-全量验收报告.md`
