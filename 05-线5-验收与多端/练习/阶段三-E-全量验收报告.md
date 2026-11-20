# 单词默写 · 阶段 E 全量验收报告

- 日期：2026-10-22
- 范围：阶段 A–D 端到端验收。**以验收为主，未进入新一轮重构**，未修改任何产品代码。
- 所有结论基于**本次实测**的命令输出、DOM 状态与 IndexedDB 行，不复述历史交付报告。

---

## 1. 结论

### **有限通过（Limited Pass）**

必须区分三层，不能互相替代：

| 层面 | 结论 | 说明 |
| --- | --- | --- |
| **自动化通过** | ✅ 通过 | 四项命令退出码全 0；25 套测试 0 失败；新增阶段 E 业务验收 95 项断言全过 |
| **人工验收通过** | ✅ 通过（有 1 项未验证） | 真实 Edge 155 浏览器 64 项检查全过 + 路由补充 10 项全过；**真机软键盘弹出未验证** |
| **仍有已知限制** | ⚠️ 存在 3 项，均未修复 | ① SRS 交接是 at-least-once 不是恰好一次；② 多标签页非原子互斥（本次**已复现真竞态**）；③ 冲突提示不是实时的 |

**为什么不是「通过」**：三项已知限制全部在本轮被**实测复现**（不是文档推断），其中多标签页并发创建竞态是第一次在真实浏览器里撞出来。按任务书要求，阶段 E 不得将此描述为已修复。

---

## 2. 自动化结果（真实退出码）

| 命令 | 退出码 | 实测结果 |
| --- | --- | --- |
| `npx tsc --noEmit` | **0** | 零错误（无任何输出） |
| `npm test` | **0** | **25 套，0 失败**；断言行统计：通过 **1004**、失败 **0** |
| `npm run build` | **0** | 2196 modules；precache 15 entries / 1269.86 KiB |
| `python scripts/check_pwa.py` | **0** | **10 项全过** |

> ⚠️ **这四项命令验证的是「当前工作树」，不是「提交树」。两者是两个不同的验证结论，不得互换引用。**
>
> | 验证对象 | 结论 | 说明 |
> | --- | --- | --- |
> | **当前工作树**（含全部未提交代码） | ✅ 四命令全 0 | 上面这张表就是它 |
> | **提交树 / 全新 clone** | ❌ **未通过，且本轮未做该验证** | HEAD 有既存依赖缺失（见 §5 末尾），需单独梳理依赖闭包 |

本功能 5 套明细（全部在 `npm test` 链内）：

```
✅ 单词默写 P0 单测全部通过：127 项断言        （scripts/test_spelling.ts）
✅ 默写持久化层单测全部通过：112 项断言        （scripts/test_spelling_session.ts）
✅ v9 → v10 迁移测试全部通过：17 项断言        （scripts/test_spelling_migration.ts）
✅ SRS 交接与故障恢复测试全部通过：101 项断言  （scripts/test_spelling_srs_handoff.ts）
✅ 单词默写前端验收全部通过：86 项断言         （scripts/test_spelling_ui.ts）
                                    合计 443 项
```

本轮**新增**验收脚本（未接入 `npm test` 链，见 §7）：

```
✅ 阶段 E 业务验收全部通过：95 项断言   （scripts/test_spelling_acceptance_e.ts）
```

> 说明：新增脚本是**新增文件**，未改动任何既有断言。本轮唯一改过的测试代码是我自己这轮写错的断言（详见 §3.0）。
> 另注：`tsconfig.json` 的 `include` 只有 `["src", "vite.config.ts"]`，`scripts/` 下的测试脚本不在 `tsc --noEmit` 覆盖范围内——这与项目既有 24 套测试脚本一致，不是本轮新增的缺口。

---

## 3. 业务验收（各场景实际状态与持久化证据）

### 3.0 先说：本轮我自己写错并修正的 4 处断言

不改断言消失败的原则是针对**产品行为**的失败；这 4 处是我新写脚本的**夹具/取样**错误，已逐条定位并修正（不是把产品行为改小）：

1. A2 用错词的答案 —— 用 `w0` 的答案提交给 `w1`，导致「答错」其实是两次全错。改为 `answerOf(w1.word_id)`。
2. A4 把会话级 `processed_requests` 当成词级 —— 它是**会话级**映射表。改为三次采样：首次入表 +1、重复用同一 id 不新增。
3. B5 拿两次默认 `now` 的聚合 JSON 直接比 —— `duration_ms = (ended_at ?? now) - started_at`，未结束会话会随 `now` 增长（**这是正确行为**）。改为固定时间基准比对计数类指标。
4. C6 按 `word_id` 数 reviewLog —— 两个会话会选到同一个词（`recent` 排序确定、种子相同），条数会叠加。改为断言「两个会话各自的 `srs_reported` 都置真」。

### 3.1 练习与计数 ✅

| 验证项 | 实际证据 |
| --- | --- |
| 达目标后词条只完成一次 | 连对 5 次提交 → `status=COMPLETED`、`total_attempts=3`、`correct_attempts=3`、`consecutive_correct=3`；SRS 交接**恰好 1 次** |
| 错误答案判定 | `consecutive_correct → 0`、`total_attempts +1`、`wrong_attempts +1`、`correct_attempts` 单独累计 |
| 空答案 = invalid | `''` 与 `'   '` 提交后 `total_attempts` 不变（2 → 2）；且空答案**不打断**连对链（之后答对从 1 起算） |
| 重复 `request_id` | 同一 id 两次提交，`total_attempts` 只 +1、`processed_requests` 不新增键、回放的是原结果 |
| 终态无非法转换 | 对 `COMPLETED` 词再提交 → `terminal`，所有计数不变；`SKIPPED` / `UNAVAILABLE` 同理 |
| 当前题由持久化队列决定 | `currentWord()` 按 `current_position` 从库里队列取；刷新后位置与进度均与库一致 |

### 3.2 会话持久化与恢复 ✅

| 验证项 | 实际证据 |
| --- | --- |
| 新建后刷新恢复同一会话 | 同一 `id`、队列长度与 `current_position` 一致、已作答连对进度被保留（不是从 0 开始） |
| 暂停 → 继续 | 库里 `PAUSED` → `IN_PROGRESS`（`resume()` 返回值与库状态双证）；刷新后仍是 `PAUSED` |
| 放弃后不会意外恢复 | 库里 `ABANDONED`；`getResumableSession()` 返回 `null`；再调 `resume()` 抛 `NO_ACTIVE_SESSION`；再进默写页不会把它救回来 |
| 已完成词条不因恢复重算 | 暂停→继续前后 `total_attempts` / `correct_attempts` / `status` / `srs_reported` 全部不变 |
| 结果页重开统计一致 | 固定时间基准下两次独立读库聚合完全一致；计数类指标不随读取时间漂移；`total_attempts = Σ 队列逐词`（无独立汇总字段） |
| 边界处理 | 空词库 → 抛 `SESSION_CONFLICT` 且**不落空会话**；词条被删 → `UNAVAILABLE` + `reason=vocab-entry-deleted`（`removeFromVocab` 硬删除已确认）；会话不存在 → `null` |

### 3.3 SRS 交接 ✅（含 at-least-once 限制实测）

| 验证项 | 实际证据 |
| --- | --- |
| 第 1、2 次答对不交接 | 两次 `correct` 后：`reviewLog` 0 行、`consecutive_correct` 0、`srs_step` 0、`next_review` 未变 |
| `COMPLETED` 后产生义务 | 第 3 次后：恰好 1 行 `quiz_form='spelling'`、`srs_reported=true`、`pendingSrsWords` 归零、`consecutive_correct +1`、`last_quiz_form='spelling'` |
| UI 不直接调 `recordQuiz` | 静态核验：`Spelling.tsx` / `SpellingResult.tsx` **零处** import `recordQuiz` 或 `@/domain/learning`；`Review.tsx` 只 import 既有的 `getDueReviews/getLayerCounts/nextReviewLabel`；三个文件均无 `normalizeInput`/`judgeSpelling`/自行比对 —— **判分与交接全在领域层** |
| 交接失败不显示成功 | 注入 `vocab.get` 失败 → 答案仍 `correct`、词条仍 `COMPLETED`，但 `srs='failed'`（绝不为 `reported`）、`srs_reported` 保持 `false`、reviewLog 0 行（无伪造） |
| 结束/放弃后仍能发现义务 | 会话 `SESSION_COMPLETED` 后 `repairSrsHandoff()` 补交成功（阶段 B 曾在此永久丢积分）；`ABANDONED` 后义务仍在且可补交 |
| 批量恢复不漏其他会话 | 两份会话各有 1 个待交接词 → 一次 `repairSrsHandoff()` 覆盖两个会话（`sessions.length=2`、`reported.length=2`），双方 `srs_reported` 均置真 |

#### ⚠️ 已知限制（不可表述为已修复）

**当前保证 = 可恢复的至少一次交接（at-least-once），不是恰好一次。**

本轮重新复现（注入「`recordQuiz` 成功 → `srs_reported` 标记写库失败」）：

```
✓ E1 recordQuiz 其实已经成功写过 1 条
✓ E1 复现：补交后 reviewLog 变 2 条（多调度一次）
✓ E1 补交后标记最终落地（不会无限重试）
   实测副作用：reviewLog +1 行、consecutive_correct 2、srs_step 2
```

这组断言**故意断言「1 → 2 条」**，把它固化成可回归事实，防止后人误以为已修成恰好一次、或反过来把断言改成期望 1 条来「修绿」。

### 3.4 多标签页 ⚠️（本轮在真实浏览器里复现了竞态）

Node 侧（存储层真实冲突态）：

- `getActiveSessions()` 不假定唯一，两份都暴露，按 `started_at` 倒序；
- 已存在活跃会话时 `createSession` 拒绝新建（`SESSION_CONFLICT`）；
- 裁决算法（循环 `abandon()` 直到选中那份变成最新）验证正确：选中那份 `IN_PROGRESS`、其余 `ABANDONED`、裁决后只剩 1 份活跃、可正常出题。

浏览器侧（两个真实标签页，同一 context 共享 IndexedDB）：

```
[证据] 并发创建尝试 6 次，每次库内会话数 = [1,1,1,2,1,1]，出现多份 1/6 次
```

**最小复现步骤**：清空会话 → 两个标签页 `Promise.all` 同时 `goto /spelling?mode=recent` → 库里出现 **2 份 `IN_PROGRESS`**，各写各的。

**实际数据结果**：不需要每次都撞中（1/6），窗口确实存在。写入前检查 + 写后复核挡住大部分时序，挡不住真正的并发。

**是否可能覆盖另一标签页状态 / 重复计数**（实测）：

- 顺序打开时：第二个标签页**不会**新建第二份，恢复同一会话 id；A 提交后 B 刷新读到同一 `current_position`，`total_attempts=1`（**没有重复计数**）；
- 注入两份冲突会话后重新进入：冲突提示出现、文案含「不保证」、列出 2 项、不自动裁决（无输入框）；
- 用户选择后：只剩 1 份 `IN_PROGRESS`（正是选中的那份）、另 1 份 `ABANDONED`；
- 另一标签页随后刷新：**仍是唯一一份活跃**，被放弃的 `conflict-second` 保持 `ABANDONED`（**没被复活，也没被冲成两份**）。

**本轮未引入**事务层、全局锁或 Dexie version(11)。修复方案见 §7。

---

## 4. 浏览器验收（真实渲染）

- **浏览器环境**：Microsoft Edge **Edg/155.0.4283.62**（系统已装，puppeteer-core 25.14.0 驱动，headless，`executablePath` 直指，未下载二进制）
- **基准地址**：`http://127.0.0.1:4174`（`npm run preview -- --port 4174 --strictPort`）
- **产物**：截图 17 张 + `_browser-report.json` + `_routes-report.json`，落在 `练习/_e-browser/`

| 场景 | 视口 | 结果 |
| --- | --- | --- |
| S1 `/review` 入口卡片 | 375×667 | ✅ 卡片与按钮可见；无横向溢出（375/375） |
| S2 练习页布局与界面规范 | 375×667 | ✅ 输入框/提交/长度提示齐全；**不含完整答案**；无溢出；本功能控件触摸目标均 ≥44px；纯图标按钮均带 aria-label+title |
| S4b 长释义与较长单词 | 375×667 | ✅ 当前词 `responsibility`（14 字母，释义 `n. 责任；职责；义务`）完整渲染且无溢出 |
| S3 软键盘 | 375×**420** | ✅ 高度收缩后输入框与提交按钮仍在可视区内、仍无溢出 |
| S4 答题反馈 | 375×667 | ✅ 答对「拼对！」/ 答错「不对，再试试」；空答案 `total_attempts` 2→2；空输入时提交按钮 `disabled` |
| S5 暂停/继续/放弃 | 375×667 | ✅ 库状态 `PAUSED → IN_PROGRESS → ABANDONED` 全对；刷新仍识别暂停态；放弃回 `/review`；再进默写页不会救回已放弃会话 |
| S6 完成与结果页 | 375×667 | ✅ 自动跳 `/spelling-result?id=…`；库里 `SESSION_COMPLETED`；刷新前后指标完全一致（完成=2 跳过=0 失效=0 提交=6 答对=6 正确率=100%）；返回入口可用；不存在会话给提示不伪造 |
| S7 桌面宽屏 | 1280×800 | ✅ `/review` 与练习页均无溢出；内容宽度受 `max-w-app` 约束（最宽卡片 343px） |
| S8 两个真实标签页 | 375×667（两页） | ✅ 13 项全过（含并发创建 6 次尝试、冲突提示、用户裁决、跨页不覆盖不复活） |
| S9 刷新恢复 | 375×667 | ✅ 不新开第二份、同一 id、`current_position` 保持、连对进度保留 |
| R1 `/review` 入口与刷新 | 375×667 | ✅ 入口稳定、刷新不漂移、存在进行中会话时也不会被带偏或自动跳转 |
| R2 `/result` 与 `/spelling-result` | 375×667 | ✅ 两条独立路由、文案互不交叉；`/result` 仍是占位页（显示 `— / —`、`0%`） |

**统计**：主脚本 **64 项检查全过**；路由补充脚本 **10 项全过**；观察 2 项；**未验证 1 项**。

### ❌ 未验证（不得标为通过）

- **真机软键盘弹出**：本环境无法调起真实输入法，以**视口高度收缩到 375×420** 近似。已验证「输入框与提交按钮仍在可视区内、无溢出」，但**真机键盘遮挡/滚动行为未经验证**。

### 🔍 观察项（不计入通过/失败）

1. **`AppShell` 里的 `SyncIndicator`（「本地数据」chip）实测 88×24，低于 44px 触摸目标**。来源 `src/components/layout/AppShell.tsx:39` → `src/components/sync/SyncIndicator.tsx`，**属并行任务的全局组件，非本功能**。按红线 2「已写好的代码不要动」本轮未改，已把断言范围收回到本功能自己的控件。
2. **多标签页并发创建竞态已复现（1/6）** —— 详见 §3.4。

---

## 5. Git 审查

### 工作树

`git status --short` 共 **104 条**（28 个已跟踪改动 + 76 个未跟踪条目）。本功能相关：

**新增（未跟踪）**
```
src/domain/spelling.ts
src/domain/spellingSession.ts
src/pages/Spelling.tsx
src/pages/SpellingResult.tsx
scripts/test_spelling.ts  test_spelling_session.ts  test_spelling_migration.ts
scripts/test_spelling_srs_handoff.ts  test_spelling_ui.ts
scripts/test_spelling_acceptance_e.ts          ← 本轮新增
scripts/check_spelling_browser.mjs             ← 本轮新增
scripts/check_spelling_routes_browser.mjs      ← 本轮新增
练习/  （方案 + 阶段一/二/三-B/C/D/E 报告 + _e-browser 截图与 JSON）
```

**修改（已跟踪）**：`src/App.tsx`、`src/pages/Review.tsx`、`package.json`、`src/domain/types.ts`、`src/services/storage/web.ts`、`src/services/storage/memory.ts`

### 逐文件归属核验（实测 diff，非推测）

| 文件 | 本功能 | 并行任务 | 可安全单独暂存 |
| --- | --- | --- | --- |
| `src/pages/Review.tsx` | 单词默写入口卡片 | 无 | ✅（需与 `spelling*.ts` 一起，因 import 依赖） |
| `package.json` | test 链 + 5 个 spelling 脚本 | 无 | ✅ |
| `src/services/storage/web.ts` | `version(10).stores(...)` + 表声明 | 无 | ✅ |
| `src/services/storage/memory.ts` | 三张映射表补 `spellingSessions` | 无 | ✅ |
| **`src/domain/types.ts`** | `import SpellingSession` + `StorageSchema` + `PrimaryKeyMap` 三处 | **有 3 处属「转写→阅读器」链路**：`TranscriptSegment` import、`ReadingType += 'transcript'`、`ReadingDoc.segments?` | ⚠️ **整文件不可暂存**（已用手术式暂存只取拼写 3 处） |
| **`src/App.tsx`** | 2 个 import + `/spelling`、`/spelling-result` 两条路由 | **5 处 `showTopSearch={false}` 删除 + `/search` 改 `showGlobalSearch={false}`** | ❌ **不可单独暂存**（按裁定 A 暂缓） |

> ⚠️ 修正：初版报告把 `types.ts` 记成「无并行任务改动」，本次逐 hunk 复核发现它混了转写→阅读器链路的 3 处改动。
> 已改为「基于 HEAD 版本只叠加拼写 3 处」的手术式暂存（见下）。

### ⚠️ `src/App.tsx` 无法安全拆分 —— 按任务书要求先报告

实测证据：

```
HEAD:src/components/layout/AppShell.tsx  → 只有 showTopSearch，没有 showGlobalSearch
HEAD:src/components/layout/TopSearchBar.tsx → 存在
HEAD:src/App.tsx → 5 处 showTopSearch
工作树 App.tsx   → 含 <AppShell showGlobalSearch={false}>（并行任务的改动）
```

即：只把 `src/App.tsx` 按路径 `git add`，会连带把并行任务那 5 处 prop 改动一起暂存；而这些改动**依赖并行任务尚未提交的 `AppShell.tsx` / `SearchDock.tsx` / `TopSearchBar` 删除**——三者不在暂存区时，索引里的 `App.tsx` 引用了 `AppShell` 不存在的 prop，**索引无法编译**。

结论：**不整文件盲目暂存**。三个选项供裁决：

- A. 暂不提交 `src/App.tsx`，其余文件按路径提交；
- B. 等并行任务先落 `AppShell` / `SearchDock` / `TopSearchBar` 删除，再按路径提交 `App.tsx`；
- C. 用户用 `git add -p src/App.tsx` 交互挑 hunk（我无法非交互地保证挑得干净）。

### ✅ 用户裁定（2026-10-25，5 项全部维持现状）

| # | 议题 | 裁定 | 我的落地 |
| --- | --- | --- | --- |
| 1 | `App.tsx` 暂存策略 | **A. 先不暂存** `App.tsx`，其他文件按路径 add | ✅ 已执行，`App.tsx` 仍留在工作树，等并行任务合并后补 `git add src/App.tsx` |
| 2 | 多标签页实时冲突提示 | **本轮不上**，维持「下次进入才提示」 | ✅ 保持现状，已写入 §6 已知风险与 §7 后续建议 |
| 3 | version(11) 交接流水表 | **维持现状（不上）** | ✅ 保持 at-least-once，不做迁移 |
| 4 | `/result` 占位页去留 | **维持现状（不动）** | ✅ 未触碰公共路由 |
| 5 | 验收脚本接入 `npm test` 链 | **维持现状（不接）** | ✅ 未改动 `package.json` 的 test 链 |

裁定 1 的理由（你的原话）已核对成立：并行任务的 `AppShell` / `SearchDock` / `TopSearchBar` 删除尚未落地，
`App.tsx` 的改动依赖这些文件，强行暂存会导致索引编不过。

### 暂存与提交结果

**提交 `28b957e`** —— 17 个文件，+6477 / -3：

```
新增（12）
  src/domain/spelling.ts            src/domain/spellingSession.ts
  src/pages/Spelling.tsx            src/pages/SpellingResult.tsx
  scripts/test_spelling.ts          scripts/test_spelling_session.ts
  scripts/test_spelling_migration.ts scripts/test_spelling_srs_handoff.ts
  scripts/test_spelling_ui.ts       scripts/test_spelling_acceptance_e.ts
  scripts/check_spelling_browser.mjs scripts/check_spelling_routes_browser.mjs
修改（5）
  package.json  src/domain/types.ts  src/pages/Review.tsx
  src/services/storage/web.ts  src/services/storage/memory.ts
```

**未暂存**：`src/App.tsx`（裁定 A）、以及 `types.ts` 里属于转写→阅读器链路的 3 处 hunk（仍在工作树，未丢）。

### 🔧 `types.ts` 的手术式暂存

`types.ts` 是唯一「同一文件混两组改动」的情况，按路径整文件 add 会把并行任务改动一起拖进提交，
所以没有走 `git add`，而是**基于 HEAD 版本只叠加拼写相关 3 处**，写成一个新 blob 塞进索引：

- A1 `import type { SpellingSession } from './spelling'`
- A2 `StorageSchema` 加 `spellingSessions: SpellingSession`（含 v10 注释）
- A3 `PrimaryKeyMap` 加 `spellingSessions: string`

工具：`scripts/_stage_types_spelling_only.py`（临时脚本，用 `git hash-object -w` + `git update-index --cacheinfo`）。
每处替换都做了「出现次数必须恰为 1」的断言，不匹配就直接退出而不是静默改错。
**工作树文件一个字节都没动**——`git diff -- src/domain/types.ts` 仍能看到并行任务那 3 处改动完好留在工作树。

### ⚠️ 提交树不能独立构建（既有问题，非本次引入）

实测证据——以下**已跟踪**文件 import 了**尚未提交**的模块：

```
src/components/transcript/MediaTranscriptImport.tsx
  → @/lib/download, @/domain/transcript/validate, @/domain/transcript/subtitle
src/pages/Import.tsx（工作树版）
  → @/components/convert/
```

也就是说 `HEAD` 本身就已经编不过，本次提交只是叠在上面，**没有让情况变糟**。
要真正修好需要提交那批未跟踪源码（`src/lib/download.ts`、`src/services/asr/`、`src/domain/transcript/{validate,subtitle}.ts`、
`src/domain/convert.ts`）——**这些属于别的任务，我没有动**。

> ✅ **本节已被阶段 ③ 的全新 clone 审计取代/订正**（2026-10-27，见 `阶段三-③-全新clone依赖闭包审计报告.md`）：
> - `@/components/convert/` 与 `@/services/convert/` 只被**工作树版** `Import.tsx` 引用，
>   `HEAD` 版 `Import.tsx` 完全没有 convert 引用 ⇒ **它们不在 committed 树的依赖闭包里**，
>   不影响全新 clone 构建。上面把两者列为必需是不准确的。
> - 真实最小缺口是 **8 个文件**（含 `src/services/asr/` 内 4 个），详见该报告 §5.1。
你若要「全新 clone 可构建」，需要单独下指令让我按路径补提交这批文件。

---

## 6. 已知风险

1. **SRS 交接 = at-least-once，不是恰好一次**（本轮复现，§3.3）
   - 影响：崩溃/写库失败窗口内一个词可能被多调度一档；最坏情况 `consecutive_correct=4` 时重复交接会 new→apply→mastered 连跳两级并写 `mastered_at`。
   - 当前缓解：只可能多、不可能少（不会漏调度）。
2. **多标签页非原子互斥**（本轮在真实浏览器里复现，1/6）
   - 影响：两个标签页同时开始会各写一份会话。
   - 当前缓解：读取时不假定唯一 → 冲突暴露给用户二选一；文案明说「不保证」。
3. **冲突提示不是实时的**（本轮新发现）
   - 两份会话已经并存期间，两个页面都照常练习且互不知情；只有**下次进入**（刷新/导航）才弹冲突选择。实测：并发创建后当前页不弹提示，刷新后才弹。
4. **真机软键盘未验证**（本环境无法调起输入法）
5. **`AppShell` → `SyncIndicator` 触摸目标 88×24**（并行任务组件，本轮未改）
6. **`/result` 与 `/spelling-result` 定位相近**：文案互不交叉不会混淆，但用户从底部导航误入 `/result` 会看到占位数。本轮未改。
7. **`scripts/` 不在 `tsconfig include` 内**：新增验收脚本未纳入 `tsc --noEmit`（与项目既有 24 套测试脚本一致）

---

## 7. 后续建议（只列实际发现的问题，不扩张范围）

> 📌 **2026-10-25 用户已就全部 5 项作出裁定，均维持现状。** 下列条目转为「待未来迭代时重新评估」，
> 本轮不再推进，也不因此改动任何代码。

| # | 建议 | 裁定 | 现状 |
| --- | --- | --- | --- |
| 1 | 多标签页实时冲突提示（轮询 `getActiveSessions()` / IndexedDB 变更监听 / storage 事件） | **本轮不上** | 维持「下次进入页面才提示」；已确认竞态结果安全（不覆盖、不重复计数） |
| 2 | SRS 交接改恰好一次（需 version(11) + 改 `recordQuiz` 签名 + `reviewLog` 唯一索引） | **维持现状** | 保持 at-least-once；限制已写入 §6 与本报告，未做迁移 |
| 3 | `AppShell` → `SyncIndicator` 触摸目标 88×24 偏小 | **维持现状** | 属并行任务组件，转给该任务，我不动 |
| 4 | 新增验收脚本接入 `npm test` 链 | **维持现状** | 未改动 `package.json`；`check_spelling_browser.mjs` 依赖 preview 服务，建议长期保持手动 |
| 5 | `/result` 占位页去留（是否改名/合并进 `/spelling-result`） | **维持现状** | 涉及既有公共路由，未顺手扩展；如需改动请先定范围与风险 |

**跨条目共同前提**：若要动上面任何一项，建议先解决 §5 末尾的「提交树不能独立构建」问题
（补提交那批别的任务的未跟踪源码），否则任何新提交都无法在新 clone 上编过。

---

## 8. 本轮实际新增/改动的文件

| 文件 | 用途 |
| --- | --- |
| `scripts/test_spelling_acceptance_e.ts` | 阶段 E 业务验收，95 项断言（未接入 npm test 链） |
| `scripts/check_spelling_browser.mjs` | 真实浏览器验收，64 项检查 + 15 张截图 |
| `scripts/check_spelling_routes_browser.mjs` | 路由与兼容性补充核验，10 项 + 2 张截图 |
| `练习/阶段E-只读冻结与审查清单.md` | §2 只读审查清单（文档） |
| `练习/阶段三-E-全量验收报告.md` | 本报告 |
| `练习/_e-browser/` | 17 张截图 + 2 个 JSON（可人工复核） |

**未修改任何产品代码，未修改任何既有测试断言。**

---

## 9. 提交审查裁决（2026-10-27）与下一阶段顺序

### 9.1 审查结论：本轮提交可接受

| 项目 | 当前结论 | 处置 |
| --- | --- | --- |
| 核心功能提交 | `28b957e`，17 个文件 | 保留 |
| `types.ts` 混合改动 | 拼写相关内容已单独进入提交，其余留在工作树 | 保留现状 |
| `/spelling`、`/spelling-result` 路由 | `App.tsx` 尚未提交 | 等并行任务稳定后再接入 |
| 四项自动化验证 | 按本报告均通过（**仅对当前工作树成立**） | 保留验证记录 |
| 全新 clone 独立构建 | **尚未通过验证**，HEAD 有既存依赖缺失 | 单独梳理依赖闭包 |
| 前提卡 `showTopSearch` 过时描述 | 已发现，属并行任务范围 | 转交对应任务 |

### 9.2 两条硬性纪律（本阶段及后续均适用）

1. **不 amend `28b957e`。** 也不为了让提交树「暂时能构建」而把整批 ASR / 转写 / 阅读器文件塞进提交——
   那是别的任务的代码，按依赖关系处理时不得混入。
2. **两个构建结论分开表述，不得互换引用。**「当前工作树构建通过」与「HEAD / 提交树独立构建失败」
   是两个不同的验证对象；前者不能作为后者的证据。

### 9.3 下一阶段顺序（已确认）

```
① 等并行任务的 AppShell / SearchDock / App.tsx 契约稳定
        ↓
② 核对并提交路由改动（/spelling、/spelling-result）
        ↓
③ 单独处理全新 clone 的依赖闭包
```

**步骤 ② 提交前必须至少确认这四件事：**

- `/spelling?mode=` 可直接访问、刷新、恢复；
- `/spelling-result?id=` 可直接访问并正确读取结果；
- `/review` 的入口与路由接入一致；
- **不覆盖并行任务对全局搜索的修改**（`SearchDock` / `showGlobalSearch`）。

### 9.4 ⚠️ 文档登记 ≠ 功能生效

前提卡（`../产品前提卡-给协作方.md`）已登记 `/spelling` 与 `/spelling-result` 两条路由，
但**路由注册尚未提交**——文档登记不代表功能已在正式代码路径中生效。
已在前提卡的路由表两行与更新日志中同步标注「路由注册尚在工作树未提交」。

> ✅ **本节已于 2026-10-27 关闭**：路由随 `dbabf84` 正式接入，前提卡上的「未提交」标注已同步撤销。详见 §10。

### 9.5 三条已知限制继续保留

SRS 交接 at-least-once、多标签页非原子互斥、冲突提示非实时 —— **不因阶段 E 自动化通过而移除**。
三项在本轮均被实测复现，判定为「已知限制」而非「已修复」。

---

## 10. 阶段 ②：路由接入已完成（2026-10-27）

### 10.1 前置：并行任务契约已稳定

本次开工前实测确认并行任务已落地，不再是 blocker：

| 核验 | HEAD 实测 |
| --- | --- |
| `AppShell.tsx` 是否已有 `showGlobalSearch` | ✅ 有（`showGlobalSearch = true` 默认 + `<SearchDock />`） |
| `TopSearchBar.tsx` 是否还在 | ✅ 已删除 |
| `SearchDock.tsx` 是否已纳入跟踪 | ✅ 已跟踪 |

再次核验 `git diff -- src/App.tsx` —— **只剩本功能的两条路由**（2 个 import + 2 个 `<Route>`），
`showTopSearch` / `showGlobalSearch` 零残留 ⇒ 可以按路径安全暂存了。

### 10.2 四项接入条件核验（真实浏览器，24 项全过）

脚本：`scripts/check_spelling_route_integration.mjs`（Edge 155 + puppeteer-core，375×667）

| 组 | 内容 | 结果 |
| --- | --- | --- |
| **G1** `/spelling?mode=` 直访 / 刷新 / 恢复 | 会话 id 不变、`current_position` 不回退、重渲染不重复计数（1 → 1）、URL 可分享 | 6/6 ✅ |
| **G2** `/spelling-result?id=` 直访读结果 | 真实 id 读到「默写结果 + 逐词明细」；无 id / 坏 id 走空态提示不白屏不编造；不含占位页文案 | 7/7 ✅ |
| **G3** `/review` 入口与路由一致 | 点「开始默写」跳 `/spelling?mode=`；切模式 URL 参数联动；跳转后真的进入练习页 | 4/4 ✅ |
| **G4** 并行任务全局搜索未被覆盖 | `/spelling` 上仍有 SearchDock 入口且能展开全屏层、收起后输入框可命中无遮挡、`/search` 不重复挂入口 | 7/7 ✅ |

### 10.3 我自己写错并修正的两处（都是脚本/断言错，非产品错）

1. **漏了种词夹具** —— puppeteer 每次 launch 用全新临时 profile，IndexedDB 是空的；
   没有 vocab ⇒ 会话建不出来 ⇒ 练习页走 EmptyState（**这是正确行为**）。首跑 10 项失败全源于此。
   已补上与主验收脚本同一份种子词表。
2. **按会话顶层读 `total_attempts`** —— 实测会话文档**顶层没有该字段**，
   真实顶层字段是 `id/type/owner/status/selection_mode/target_correct/total_words/current_position/started_at/updated_at/queue/processed_requests`；
   答题计数在内嵌 `queue[i]`（`total_attempts` / `correct_attempts` / `wrong_attempts` / `consecutive_correct` / `srs_reported`）。
   已改为按队列聚合求和。**这条已写进前提卡，避免后来者重犯。**

### 10.4 ⚠️ 提交时踩到的并行任务冲突（已正确处理，未破坏他人状态）

执行 `git add src/App.tsx` 时，发现**暂存区里已经有别的任务的 6 个文件**（其他会话刚暂存、正在等他们自己提交）：

```
A  B12-前提卡补丁-已写入.md        A  B12-启动控制权核查报告.md
A  B12-恢复前置核验报告.md          A  B12-运行状态与回滚核验报告.md
A  api/b12-phase-b-verify.py        A  reports/stage-b12-overview.md
```

处置：**既没有把它们裹进我的提交，也没有动它们的暂存状态**，改用按路径的部分提交——

```bash
git commit -F - -- src/App.tsx scripts/check_spelling_route_integration.mjs
```

提交后复核：`dbabf84` 只含 2 个文件；`git diff --cached --name-status` 那 6 个仍是 `A`，别人的暂存原封不动。

### 10.5 提交 `dbabf84`

```
scripts/check_spelling_route_integration.mjs | 378 +++（新）
src/App.tsx                                  |  20 +
2 files changed, 398 insertions(+)
```

**未 amend `28b957e`。** 本次提交只含本功能 2 个文件，无其他任务代码混入。

### 10.6 前提卡已同步（不再有过期标记）

- 路由表两行：改为「2026-10-27 路由已随 `dbabf84` 接入正式代码路径」
- 顶部 10-26 条目里的「路由注册未提交」一句已更正
- 新增 2026-10-27 更新日志条目，含 24 项核验摘要与「会话文档顶层无 `total_attempts`」这条实测事实

### 10.7 剩余：阶段 ③

全新 clone 独立构建**已经实测完成**（2026-10-27）：结论是 ❌ **不能**
（`npm run build` exit=2，卡在 `tsc --noEmit` 的 4 条 TS2307）。

完整结果见 **`练习/阶段三-③-全新clone依赖闭包审计报告.md`**。要点：

- 失败 100% 源于别的任务未提交的 8 个源码文件，**与单词默写无关**；
  反过来本功能的源码、路由、5 套测试在干净 clone 里**全部通过**。
- 依赖安装与锁文件**无问题**（`npm ci` exit=0，478 包 22 秒）。
- 意外发现：`npx vite build` 单独跑 **exit=0** —— 因为缺失模块的宿主
  `MediaTranscriptImport.tsx` 是孤儿组件（没人 import），被摇树掩盖，
  所以目前只炸类型检查、不炸产物。
- 最小修复集 = 8 个文件，**本阶段不实施**。

---

## 11. 四类验证结果的口径区分（不可混用）

阶段 ③ 之后，本话题一共出现了四种「构建/验证结果」。**它们验证的是四个不同对象，
互相不能作为对方的证据。** 引用任何一个结果时必须同时说明它属于哪一类。

| # | 口径 | 验证对象 | 实测结果 | 能用来主张什么 |
| --- | --- | --- | --- | --- |
| **A** | 当前工作区四件套 | 原工作区磁盘内容（含全部未提交代码） | ✅ 全绿（tsc=0 / test=0 / build=0 / check_pwa=0） | 只能说「此刻开发机能跑」 |
| **B** | `dbabf84` 独立 clone 四件套 | 正式提交树（干净 clone，`npm ci` 后） | ❌ tsc=2 / test=1 / build=2 | **这是「能否独立构建」的唯一有效结论** |
| **C** | `npx vite build` 单独执行 | 跳过前置 `tsc` 的打包阶段 | ✅ exit=0（2179 modules，4.11s） | 只能说「产物此刻打得出来」，**不代表仓库构建通过** |
| **D** | `npm run build` | `tsc --noEmit && vite build` 完整链 | ❌ exit=2，中止在第一步 | 说明「类型缺失会连带卡住产物生成」 |

### 11.1 关于 `check_pwa.py` 的退出码（必须看注释）

在独立 clone 里 `check_pwa.py` 的退出码是 **0**，但这是我在**手动执行 `vite build` 生成 `dist/` 之后**
才跑出来的（即走的是 C 的路径，不是 D）。

> ❗ 因此**不能**把它表述为「完整构建链通过」，`dist/` 的来源必须一并说明。
> 正确表述：「在手动生成 `dist/` 的前提下，PWA 产物体检 10 项通过」。

### 11.2 为什么 B 和 C 的结论会打架

因为缺失模块的宿主 `src/components/transcript/MediaTranscriptImport.tsx` 是**孤儿组件**——
`grep -rn "MediaTranscriptImport" src/` 除自身外零命中，Rollup 不会去解析它。

- `tsc --noEmit` 按 `tsconfig.json` 的 `include: ["src", "vite.config.ts"]` **全量检查**，所以报错；
- `vite build` 只打包**入口可达**的模块，所以跳过。

**风险**：只要将来有人把这个组件挂上路由，C 会立刻从「成功」翻成「失败」。

### 11.3 单词默写的验收边界（不得外推）

✅ 本功能 5 套测试（127 + 112 + 17 + 101 + UI）在干净 clone 中**全部通过**，
证明**单词默写自身的依赖闭包完整、已正确提交**。

❌ **不得据此宣称整个仓库已可独立构建** —— 仓库级结果以口径 B 为准，
即 ❌ 不能，根因是 §10.7 提到的别的任务那 8 个未提交源码文件。

### 11.4 一句话总结

> 「功能自身的测试通过」⊂ 「仓库独立构建通过」的子集条件，**不能反推**。
