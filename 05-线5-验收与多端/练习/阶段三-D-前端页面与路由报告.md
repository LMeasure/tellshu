# 阶段三-D · 前端页面与路由 交付报告

- 日期：2026-10-21
- 范围：**只做阶段 D**（前端页面与路由）。不改阶段 A/B/C 的领域层、持久化层、测试。
- 基准：`练习/单词练习方案.md` V3.2 + 用户裁定的 D1–D6
- 状态：**已完成并通过四件套验证**。下文所有数字均为本次实测，未实测的明确标注「未验证」。

---

## 0. 先说三件必须说清的事

1. **修了一个真 bug**：`onResume()` 原来只做了「核对词条 + 补交 SRS」，**从来没调用 `resume()`**，
   暂停后点「继续默写」界面不会回到练习态（库里也仍是 PAUSED）。是 UI 测试场景 5 暴露出来的，
   静态检查没抓到（`noUnusedLocals: false`，`resume as resumeSessionApi` 导入后一直未被使用）。
2. **修了一个测试自身的设计缺陷**：「展示中文释义」原来硬编码「雏菊/抛弃/利益」白名单，
   而 `recent` 模式选哪 3 个词由排序决定（实测同一份种子数据两次跑出
   `daisy,benefit,cabbage` 和 `cabbage,daisy,abandon` 两种队列）——首词是 `cabbage` 时必然误报失败。
   已改为按库里真实队列首位断言。
3. **`src/App.tsx` 的 diff 不全是我的改动**：并行任务（SearchDock 改版）也改了同一个文件。
   详见 §6。我没有覆盖、没有还原它的任何一行。

---

## 1. 实际修改／新增的文件及目的

### 新增（未入版本控制，`git status` 显示 `??`）

| 文件 | 目的 |
| --- | --- |
| `src/pages/Spelling.tsx` | 默写练习页（路由 `/spelling`）。取词 → 收输入 → 调持久化层 → 按返回值渲染。**前端零判分逻辑** |
| `src/pages/SpellingResult.tsx` | 独立结果页（路由 `/spelling-result?id=`）。全部数字由 `aggregateSession()` 实时聚合 |
| `scripts/test_spelling_ui.ts` | 前端验收测试，jsdom + fake-indexeddb 真实渲染 + 真实持久化，**86 项断言** |

### 修改（已被版本控制跟踪）

| 文件 | 我的改动 | 是否混入并行任务改动 |
| --- | --- | --- |
| `src/pages/Review.tsx` | 「单词默写」入口卡片（D1/D4）：模式切换 + 「开始默写」按钮 | 否，diff 100% 是本功能 |
| `src/App.tsx` | 2 个 import + 2 条路由 | **是**，另含并行任务的 AppShell 改动（见 §6） |
| `package.json` | `test` 链追加第 25 套 `test_spelling_ui.ts`；新增 `test:spelling-ui` 脚本 | 否，diff 100% 是本功能 |

### 阶段 B/C 的产物（本轮未改动，仅列出以说明工作树全貌）

`src/domain/spelling.ts`、`src/domain/spellingSession.ts`（未跟踪）；
`src/domain/types.ts`、`src/services/storage/web.ts`、`src/services/storage/memory.ts`（Dexie v10 注册，已跟踪，diff 100% 属本功能）；
`scripts/test_spelling{,_session,_migration,_srs_handoff}.ts`（未跟踪）。

---

## 2. 实际路由与组件接入方式

### 路由（`src/App.tsx`）

```tsx
<Route path="/spelling"        element={<AppShell><Spelling /></AppShell>} />
<Route path="/spelling-result" element={<AppShell><SpellingResult /></AppShell>} />
```

- 两条都包 `<AppShell>`，**都不传 `showGlobalSearch`**（用默认 `true`，即保留底部全局搜索停靠）。
- 按核验要求使用当前真实契约：**没有**恢复已删除的 `showTopSearch`，**没有**引用已删除的 `TopSearchBar`。
- `/spelling-result` 是全新路由，**不复用也不改造** `/result`（那是占位结算页 `PracticeResult`）。

### 入口（`src/pages/Review.tsx`）

在「待复习队列」Card 之后、「学习路径」之前插入一张「单词默写」Card：

- 徽标「连对 3 次」（值来自 `DEFAULT_TARGET_CORRECT`，不写死数字）；
- 说明里直接显示当前 `studyBatchSize`，并注明「每轮词数在『设置』里调，学习和闯关共用」——
  **没有创建第二套批量数量设置**（D1）；
- `Segmented size="sm"` 做随机／最近新增／易错词切换；
- 「开始默写」→ `navigate('/spelling?mode=<mode>')`。

### 练习页数据流（`src/pages/Spelling.tsx`）

```
URL ?mode= ─┐
            ├─► bootstrap() ─► getActiveSessions()  ── 多于 1 份 ─► 冲突选择态（不自动裁决）
store.settings.studyBatchSize ─┘                    └─ 0/1 份 ─► enterSession()
                                                                    ├─ getResumableSession() 有 ─► 恢复
                                                                    │    ├─ refreshAvailability()  核对词条是否已删
                                                                    │    └─ repairSrsHandoff()     补交上次没落成的 SRS
                                                                    └─ 无 ─► sessionStorage 线索 ─► SESSION_COMPLETED 则跳结果页
                                                                              └─ 否则 createSession({ mode, count: batchSize })
```

出题永远走 `currentWord(session)`（按 `current_position` 从**持久化队列**取），
不依赖 React 内存里的题目列表；刷新后重新读库即回到同一个词。

### 交互与界面纪律

- 提交防重：`busy` 闸门 + 每次提交现生成 `uuid()` 作 `request_id`，领域层 `processed_requests` 幂等作双保险；
- 输入框 `autoCapitalize="off" autoCorrect="off" spellCheck={false} enterKeyHint="send"`；
- 提示只给**首字母 + 长度**（`c _ _ _ _ _ _ · 7 个字母`），不给音标、不出现完整答案；
- 终态反馈四态：`correct` / `wrong` / `invalid`（「空白不算一次提交」）/ `terminal`；
- 图标按钮全部 `aria-label` + `title`，容器带 `touch-target`（≥44px）；
- 空数据一律 `EmptyState`（空池／队列已出完／结果页找不到会话），**不编造**；
- 全部样式走设计令牌与既有组件（`Button`/`Card`/`CardBody`/`Badge`/`Segmented`/`Progress`/`EmptyState`/`ErrorState`），
  无写死色值；结果页数字块与「逐词明细」用同一套表面处理（`border + bg-card`），未加投影。

---

## 3. 阶段 B/C 接口复用情况

前端**只** import `@/domain/spellingSession` 一个文件，没有绕过持久化层、没有自己实现判分：

| 页面用到的接口 | 用途 |
| --- | --- |
| `getActiveSessions()` | 冲突检测（>1 份才提示，不自动裁决） |
| `getResumableSession()` | 判断有没有可恢复会话 |
| `refreshAvailability()` | 恢复时核对词条是否已从生词本删除 |
| `repairSrsHandoff()` | 恢复入口补交 SRS（阶段 C 修好的「扫全部会话」版本） |
| `createSession()` | 建新会话；`SESSION_CONFLICT` 且空池时走 `EmptyState` |
| `submitAttempt()` / `skip()` | 提交与跳过，返回 `{ session, result, srs }` |
| `pause()` / `resume()` / `abandon()` | 生命周期 |
| `currentWord()` / `sessionProgress()` / `aggregateSession()` / `isSessionStale()` / `STALE_PAUSE_MS` | 纯函数派生展示数据 |
| `SpellingSessionError` | 仅用于识别「空池」这一种非错误情况 |

**SRS 交接完全由持久化层负责**（D4）：页面只读 `submitAttempt()` 返回的 `srs` 字段，
失败时显示「有词的复习积分还没写进去，稍后打开默写页会自动重试」；
**从不在 UI 里自己调 `recordQuiz`**，也从不显示「已同步」这类不实状态。

---

## 4. 新增测试场景及实际结果

`scripts/test_spelling_ui.ts`，jsdom + `fake-indexeddb` + 真实 Dexie 驱动（首行断言 `storage.driver === 'dexie'`，防静默降级）。

| # | 场景 | 断言数 | 结果 |
| --- | --- | --- | --- |
| 1 | `/review` 入口与路由（卡片、模式切换、沿用批量设置、点击后 URL + query） | 7 | ✅ |
| 2 | 出题来自持久化队列（库里 1 份会话、队列长度、`current_position`、不泄露答案、展示释义、首字母提示） | 8 | ✅ |
| 3 | 提交反馈／判分／空答案／跳过／完成（含完成后自动跳结果页、库状态、完成/跳过计数） | 15 | ✅ |
| 4 | 刷新后恢复会话（同一会话、连对进度保留、出题位置不变、跨刷新累计到 COMPLETED） | 6 | ✅ |
| 5 | 暂停／继续／放弃（库状态 PAUSED→IN_PROGRESS→ABANDONED、刷新后仍识别为暂停态、放弃回 `/review`） | 11 | ✅ |
| 6 | 多标签页冲突提示（提示文案含「不保证」、列出两份、不自动裁决、保留选中的、放弃其余、UI 恢复的就是选中的那份） | 10 | ✅ |
| 7 | SRS 交接待重试（交接失败提示待重试、不显示「已同步」、词条仍 COMPLETED、`srs_reported` 仍 false、无伪造记录、重进页面补交成功且恰好 1 条、提示消失） | 10 | ✅ |
| 8 | 快速重复提交不重复计数（连点 5 次只计 1 次、`processed_requests` 只 1 键、队列不重复推进） | 4 | ✅ |
| 9 | 结果页（完成数、逐词明细、失效原因、正确率 4 提交 3 对 = 75%、用时、刷新后一致、会话不存在给提示、缺 id 不伪造） | 9 | ✅ |
| 10 | 空池空态（走空态、不出现输入框、不落空会话占位） | 3 | ✅ |
| — | **合计** | **86** | **86/86 通过** |

测试手法说明（保证断言落在真实状态上，不是 mock 调用）：

- 每个场景用**全新的 React root**（旧 root 先 unmount），保证 `useEffect` 真的重跑；
- 导航用 `MemoryRouter` + `useLocation()` 探针验证 URL 变化，**不 mock `navigate`**；
- 受控输入走原生 `value` setter + `input` 事件 + `Enter` keydown；
- 故障注入直接打 `storage.table(...)` 的原型方法（场景 7 拦 `vocab.get` 让 `recordQuiz` 失败）；
- 场景 6 直接往库里塞两份 `IN_PROGRESS` 会话——这是存储层**真实**的冲突态。

### 本轮发现并修掉的两个问题（都是实测暴露，不是推测）

**① 真 bug：`onResume()` 没调 `resume()`**

场景 5 失败输出：

```
✓ 找到「继续默写」按钮
✗ 继续后回到练习态
✗ 库里回到 IN_PROGRESS
```

根因：`onResume` 只做了 `refreshAvailability()` + `repairSrsHandoff()`，两者返回的都还是 PAUSED 会话，
`resume as resumeSessionApi` 导入后从未被调用（`noUnusedLocals: false` 所以 tsc 没报）。
已改为三步顺序执行：核对词条 → `resume()` → 补交 SRS，最后 `setSession(repaired ?? resumed)`。

**② 测试设计缺陷：「展示中文释义」白名单过硬**

全量 `npm test` 里失败 1 项，单独跑却通过。加诊断打出真实队列后确认：

```
run 1: 队列 = daisy,benefit,cabbage   当前 = daisy    ✓ n. 雏菊
run 3: 队列 = cabbage,daisy,abandon   当前 = cabbage  ✗ （旧白名单不认「卷心菜」）
```

根因是断言硬编码了 4 个种子里 3 个词的释义，而 `recent` 选词在时间戳相同时排序不稳定。
已改为 `stored.queue.find(w => w.position === stored.current_position)` 后断言其 `definition_zh` 出现在页面上。
修完连跑 3 次全绿。

---

## 5. 四项验证命令真实结果

全部在**改动后的当前工作树**上执行，命令与退出码如实记录：

| 命令 | 退出码 | 实际输出要点 |
| --- | --- | --- |
| `npx tsc --noEmit` | **0** | 无任何输出（无错误） |
| `npm test` | **0** | 25 套全部通过，**0 失败** |
| `npm run build` | **0** | 2196 modules，`index-*.js` 793.38 kB（gzip 254.45 kB），PWA precache 15 entries |
| `python scripts/check_pwa.py` | **0** | 10 项全过（SW 无悬空标识符、18 个 URL 分流正确、预缓存 15 项全为外壳、manifest 3 图标含 maskable） |

`npm test` 明细（**25 套，0 失败**；本功能 5 套共 443 项断言）：

```
✅ 单词默写 P0 单测全部通过：127 项断言        （scripts/test_spelling.ts）
✅ 默写持久化层单测全部通过：112 项断言        （scripts/test_spelling_session.ts）
✅ v9 → v10 迁移测试全部通过：17 项断言        （scripts/test_spelling_migration.ts）
✅ SRS 交接与故障恢复测试全部通过：101 项断言  （scripts/test_spelling_srs_handoff.ts）
✅ 单词默写前端验收全部通过：86 项断言         （scripts/test_spelling_ui.ts）  ← 本轮新增
```

另有 `npm run preview -- --port 4174 --strictPort` 冒烟：`/`、`/spelling`、`/spelling-result`、`/review`
四条路径均返回 **200**，index.html 含 `<div id="root">`、manifest 链接与 SW 注册脚本（已设 `no_proxy` 避开本机代理）。
测完已关闭该预览服务。

> 注：`npm test` 日志里有一条 `[dataClient] 拉取失败 /data/linguabase/v1/catalog.json TypeError: Failed to parse URL`。
> 这是 `/review` 页「学习路径」卡片在 jsdom 里 fetch 相对地址导致的既有噪声，与本功能无关，
> 该套测试本身通过（仓库里其他 UI 测试也有同样输出）。

---

## 6. 实际 Git diff 检查结果

工作树当前有约 **99 个并行任务改动**（未提交），本功能一律**未触碰**。逐一核对结果：

### 本功能实际改动

- 新增未跟踪：`src/pages/Spelling.tsx`、`src/pages/SpellingResult.tsx`、`scripts/test_spelling_ui.ts`
- 修改已跟踪：`src/pages/Review.tsx`、`src/App.tsx`、`package.json`
- （阶段 B/C 遗留、本轮未再改：`src/domain/spelling.ts`、`src/domain/spellingSession.ts` 未跟踪；
  `src/domain/types.ts`、`src/services/storage/web.ts`、`src/services/storage/memory.ts` 已跟踪，diff 经核对 **100% 是 Dexie v10 注册**，无其他内容）

### ⚠️ 共享文件：`src/App.tsx` 的 diff **同时包含并行任务的改动**

并行任务（SearchDock 改版：删 `TopSearchBar`、改 `AppShell` 契约）也改了 `src/App.tsx`。
该文件 diff 中**不属于我**的部分：

```
/search:    <AppShell>                → <AppShell showGlobalSearch={false}>   （并行任务）
/learn:     <AppShell showTopSearch={false}> → <AppShell>                      （并行任务）
/challenge: 同上                                                                            （并行任务）
/result:    同上                                                                            （并行任务）
/recitations、/dict-ingest: 同上                                                            （并行任务）
```

属于我的部分只有：2 个 `import { Spelling }` / `{ SpellingResult }`，以及末尾两条 `/spelling`、`/spelling-result` 路由（带 2026-10-21 注释）。
**我没有覆盖、还原或修改并行任务的任何一行**，我的改动是纯追加、且与它改的位置不重叠。

### 明确未覆盖的并行任务改动（本次完全未读、未改、未验证）

已跟踪文件：`src/components/layout/AppShell.tsx`、`BottomTabBar.tsx`、`TopSearchBar.tsx`（删除）、
`SearchDock.tsx`（新增）、`src/components/reader/*`（5 个）、`src/components/learning/InlineDictation.tsx`、
`src/components/fx/FireworkBurst.tsx`、`src/components/icons/shushu.tsx`、`src/data/repository.ts`、
`src/index.css`、`src/store/useAppStore.ts`、`src/pages/{Home,Import,LearningFlow,Profile,Reader}.tsx`、
`src/hooks/*`、`src/lib/*`、`src/domain/{convert,transcript/*}.ts`、`src/services/{asr,convert}/*`、
`scripts/test_{reader_v2,word_detail}.ts`、`server/**`、以及若干 `.md` 交付文档与 `练习/` 目录外的方案文档。

> 建议：提交时**按路径显式 `git add`**（`src/pages/Spelling.tsx src/pages/SpellingResult.tsx src/pages/Review.tsx src/App.tsx package.json scripts/test_spelling*.ts src/domain/spelling*.ts src/domain/types.ts src/services/storage/web.ts src/services/storage/memory.ts`），
> 不要 `git add .`，否则会把并行任务的未完成工作一起提交。

---

## 7. 已知限制（不做虚假承诺）

1. **多标签页不是原子互斥。** `TableService` 没有事务 API，Dexie 实例不外泄，
   「检查活跃会话 → 创建会话」这一整套无法原子完成。两个标签页可能各读到「无活跃会话」各写一份。
   前端只把 `getActiveSessions()` 的结果**如实呈现给用户二选一**，界面文案明说「本地存储**不保证**多标签页互斥」。
   **没有实现分布式锁，也没有宣称实现。** 同 id 的并发 `put()` 是 last-writer-wins，这一层挡不住。
2. **SRS 交接是 at-least-once（可恢复的至少一次），不是恰好一次。** `recordQuiz()` 不幂等，
   且与会话文档写入无法原子提交。「recordQuiz 成功 → 标记落库」之间中断 ⇒ 下次补交**多调度一次**。
   最坏情况：该词原 `consecutive_correct = 4` 时，重复交接让它 new→apply→mastered 连跳两级并写下 `mastered_at`。
   该窗口已由阶段 C 的故障注入测试复现（`scripts/test_spelling_srs_handoff.ts`，101 项断言）。
   当前实现只保证**只可能多、不可能少**（不会漏调度）。
3. **jsdom 无布局引擎。** 375px 窄屏是否横向溢出、元素是否重叠遮挡、触摸目标实际命中区域，
   均**未经渲染验证**（测试文件头已声明）。代码侧做了针对性处理（`touch-target`、`min-w-0`+`truncate`、`flex-1`），
   但真机视觉效果需要人工过一遍。
4. **`sessionStorage` 只作线索。** `spelling:lastSessionId` 仅用于「刷新后判断上一次是不是刚结束」，
   状态本身一律以库里文档为准，不用它做任何判定。
5. **`recent` 选词在时间戳相同时排序不稳定**（实测同种子两次跑出不同队列）。不影响正确性，
   但意味着「最近新增」在批量同时入库时选子集不确定。

---

## 8. 尚未解决的问题及其影响

| # | 问题 | 影响 | 归属 |
| --- | --- | --- | --- |
| 1 | SRS 交接无法做到恰好一次（§7.2） | 崩溃窗口内一个词可能被多调度一档 | 待用户裁决：方案 B 需 version(11) + 改 `recordQuiz` 签名 + 给 `reviewLog` 建唯一索引（**改历史表结构，方案禁止**）；方案 C 退化成 B。阶段 C 报告已列 |
| 2 | 多标签页无原子互斥（§7.1） | 两个标签页同时开默写会产生两份会话，靠用户手动二选一 | 待用户裁决：引入事务能力要改 `StorageService` 抽象并影响全部既有表 |
| 3 | 真机视觉未验证（§7.3） | 375px 窄屏可能存在挤压/溢出 | 需要人工在设备或 DevTools 过一遍 |
| 4 | `recent` 选词排序不稳定（§7.5） | 批量同时入库时选子集不确定 | 低。可在 `selectWords` 加稳定次级排序键（如 `word` 字典序），但属阶段 A/B 范畴，本轮未动 |
| 5 | `/result`（`PracticeResult`）仍是占位页 | 与默写无关，但用户可能混淆 `/result` 与 `/spelling-result` | 既有问题，非本轮范围 |

---

## 9. 本轮明确**没有**做的事（对照任务书禁令自查）

- ❌ 没有改 `recordQuiz` 核心语义
- ❌ 没有新增 Dexie version(11)，没有建交接流水表
- ❌ 没有重构 `StorageService`，没有改历史迁移（v10 是阶段 B 做的，本轮一行未动）
- ❌ 没有修改无关业务模块
- ❌ 没有添加任何第三方依赖（`jsdom`/`fake-indexeddb`/`tsx` 早已在 `devDependencies`）
- ❌ 没有用 `git add .`，没有覆盖或还原并行任务的工作
- ❌ 没有把多标签页冲突检测说成原子锁，没有把至少一次交接说成恰好一次
- ❌ 没有修改阶段 A/B/C 的测试来迁就前端（只修了本轮自己新写测试里的一个错误断言）

---

## 10. 启动方式

```bash
npm run dev        # 开发
npm run preview -- --port 4174 --strictPort   # 预览（固定端口，换端口 SW/缓存全作废）
npm test           # 25 套全量
npx tsx scripts/test_spelling_ui.ts            # 只跑本轮前端验收（86 项）
```

页面路径：`/review`（入口卡片）→ `/spelling?mode=random|recent|wrong` → `/spelling-result?id=<会话id>`
