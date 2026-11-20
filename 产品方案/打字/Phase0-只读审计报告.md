# 单词默写 V2（打字输入改版 + 错词本）Phase 0 只读审计报告

- 审计时间：2026-11-04
- 需求来源：`产品方案/打字/打字输入需求.txt`（361 行，11 节）+ 用户提供的 Qwerty Learner 截图 2 张
- 审计范围：只读。未修改任何源码、未执行 git 写操作、未执行数据库迁移。
- 结论：**按要求停在 Phase 0，等待裁定后再进入 Phase 1**。报告中所有「未找到」均为全仓检索后确无证据，推断项显式标注为「待验证假设」。

---

## 0. 基线记录（需求 §11.1）

| 项 | 实测 |
| --- | --- |
| Git HEAD | `760e999` |
| 暂存区 | 6 个 `A`：`B12-前提卡补丁-已写入.md`、`B12-启动控制权核查报告.md`、`B12-恢复前置核验报告.md`、`B12-运行状态与回滚核验报告.md`、`api/b12-phase-b-verify.py`、`reports/stage-b12-overview.md`；另有 1 个 `D 产品前提卡-给协作方.md`（工作区副本被暂存删除） |
| 工作区（未暂存） | 51 files changed，`2438 insertions / 1673 deletions`；含 `src/App.tsx`、`src/services/storage/web.ts`、`src/domain/types.ts`、`src/index.css`、`src/main.tsx`、`src/pages/*` 等并行任务改动 |
| 前提卡正本 | `C:/Users/lagom/WorkBuddy/2026-10-02-10-40-40/shutree/产品前提卡-给协作方.md`（1101 行，上层目录，不在 git 内）。工作区内 `产品前提卡-给协作方.md` 只是副本且已被暂存删除；`.tmp_premise.md` 是下载报错残留，无前提内容 |
| 技术栈（`package.json`） | React 18.3 / TS 5.5 / Vite 5.4 / Tailwind 3.4 / zustand 4.5 / Dexie 4.4，纯前端离线 PWA |

**并行任务冲突预警（已实证）**：
- `src/services/storage/web.ts` 的 `v11 wordLearningSessions` 是**他人未提交改动**（`git diff` 可见 L30/72/100/190 四处增量）。任何 Dexie 版本升级必须以当前工作树为基线，不能拿 HEAD 版本覆盖。
- `src/App.tsx` 被他人改动（`/learn` 加 `showGlobalSearch={false}`）。
- Phase 1 开工前须重新记录三项状态；只按显式路径 `git add`，禁止 `git add .`。

---

## 1. 需求文档第二节要求的六项确认

### 1.1 当前页面真实交互与组件结构

`src/pages/Spelling.tsx`（621 行）：
- `export function Spelling()` L79；状态 L86-99（`session/loading/fatal/conflicts/dropped/available/input/feedback/busy/srsPending`），`inputRef` L101。
- 启动 L106-175：优先 `getResumableSession()` 恢复，否则 `createSession({mode, count: batchSize})`；`sessionStorage` 键 `spelling:lastSessionId` L67 仅作刷新线索。
- **当前是「独立输入框 + 提交按钮」的整词输入**：`<input id="spelling-input">` L518-537，`onKeyDown` 只处理 Enter L523-528，「提交」按钮 L577-583；`onSubmit` L201-223 → `submitAttempt({word_id, input, request_id: uuid()})` L208。
- 提示区 L503-512 只给「首字母 + 下划线 + 字母数」，明确注释「不泄露答案，也不给音标」。
- 反馈 L540-568（correct/wrong/invalid/terminal 文字），1600ms 自动清除 L179-183。
- 顶栏 L445-467：返回、`Progress`、`doneCount/p.total`、暂停；`word ?` 分支 L484；空态 L597-607。
- **未找到**：逐字母输入、全局键盘监听、Backspace 专门逻辑、显示/隐藏切换、眼睛/发音按钮、错误提示音、练习页实时统计、`sm:/md:/lg:` 断点类、本页发音调用。

`src/pages/SpellingResult.tsx`（229 行）：`?id=` → `getSessionById` L50 → `aggregateSession(session)` L90 + `sessionProgress` L91；字段为完成/跳过/失效 L116-118、提交次数/答对/正确率 L121-126、完成率/剩余/用时 L131-134。

路由（`src/App.tsx`）：`/spelling` L120-127、`/spelling-result` L128-135、`/collection/:id` L152-159。入口在 `src/pages/Review.tsx` L117-143（模式 `random/recent/wrong` L31，跳 `/spelling?mode=` L139）。

### 1.2 当前答题状态机与持久化

`src/domain/spelling.ts`（665 行，纯函数）：
- `DEFAULT_TARGET_CORRECT = 3` L37；`VALID_ANSWER_RE` L47（只允许字母 + 内部连字符/撇号，**空格不是合法答案字符**）。
- 状态 L51-62：`PENDING/IN_PROGRESS/COMPLETED/SKIPPED/UNAVAILABLE`，会话 `IN_PROGRESS/PAUSED/SESSION_COMPLETED/ABANDONED`。
- `SpellingWordState` L84-103：`word`（答案快照）、`definition_zh`、`ipa?`、`pos?`、`consecutive_correct`、`target_correct`、`wrong_attempts` L98、`last_attempt_at` L99、`srs_reported` L102。
- `SpellingSession` L131-148：单文档，`selection_mode: 'random'|'recent'|'wrong'` L137、`queue` L145、`processed_requests: Record<string, AttemptResult>` L147。
- `applyAttempt` L505-547：`request_id` 命中即原样回放 L510-511；正确 L525-533（`consecutive_correct+1`，达标置 `COMPLETED`，`advance()` 推进队列）；错误 L534-541（`wrong_attempts+1`、`consecutive_correct=0`、**不推进**）；空白 `invalid` 不计入分母 L523-524。
- `srs_due` 在 `buildResult` L489 产生（`correct && COMPLETED && !srs_reported`）；`markSrsReported` L613-625；`aggregateSession` L381-413。
- `selectWords` L264-305：`wrong` 模式按 `reviewLog` 错误次数 + `in_wrong_pool` 排序 L294-300 —— 这是**「易错词选词模式」，不是错词本**。

`src/domain/spellingSession.ts`（510 行）：
- `SESSIONS = storage.table('spellingSessions')` L49；`mutate` L166-183 为「读 → 纯函数 → 一次 `put()`」。
- `createSession` L197-247：**已有活跃会话即抛 `SESSION_CONFLICT`** L205-211；写后重读复核 L235-244。
- `submitAttempt` L253-265 → `fulfillSrsHandoff` L433-477，L445 `await recordQuiz(w.word_id, true, 'spelling')`。
- 文件注释 L391-410 明确：`recordQuiz()` 不幂等、与标记写入无法原子提交，交接语义是 **at-least-once，非恰好一次**；`repairSrsHandoff` L350-365 负责补交。

### 1.3 现有生词本、错词记录与复习入口

- **数据**：`src/domain/types.ts` `VocabEntry` L28-53（`word_id/word/book?/ipa?/definition_zh?/pos?/layer/consecutive_correct/srs_step/next_review/in_wrong_pool/last_quiz_form`）；`StorageSchema` L374-401、`TableName` L403。
- **SRS**：`src/domain/learning.ts` `SRS_INTERVALS` L69-78、`PASS_THRESHOLD=5` L79、`getWrongPool` L192-195、`recordQuiz` L213-248（**无 `request_id` 参数，每次调用必写一条 reviewLog，语义不可改**）。
- **现有「错题本」页面**：`/collection/wrong` → `src/pages/CollectionDetail.tsx`，`TITLES.wrong='错题本'` L10，`getWrongPool()` L25；列表只展示 `word/pos/ipa/definition_zh` L63-70 + 点读按钮 L72-78。**无错误次数、无最近错误时间、无移除、无再次练习**。它是闯关/SRS 的 `in_wrong_pool` 错题，与本轮「默写错词本」不是同一实体。
- 其它入口：`src/pages/Home.tsx` L69 `navigate('/collection/wrong')`、`src/pages/Collections.tsx` L23、`src/pages/Review.tsx` L78 错题统计、`src/pages/Profile.tsx` L205。
- **未找到**：独立错词表、错误次数字段、最近错误时间字段、正确答案持久化字段、错词维度合并去重逻辑。会话内嵌的 `wrong_attempts` / `last_attempt_at` 是跨会话可用的近似物，但不是错词本（数据随会话文档分散、无合并去重）。

### 1.4 发音功能及音频资源现状

- `src/services/speech/web.ts`：Web Speech API **TTS**，非音频文件。`speak` L171-190（先 `cancel()` 清队列 L176，再 `resume()`、`speak()`）；`buildUtterance` L117-149 支持 `en-GB/en-US` 精确选嗓音 L122-132。
- 偏好：`src/store/useAppStore.ts` `SettingsState.accent` L16 及 `speed`；`src/pages/Settings.tsx` L115-121 有 accent 选项；`src/lib/speech.ts` 的 `speakFocused` 已在 `CollectionDetail.tsx` L73 等处使用。
- `src/lib/audioBus.ts` 有 `AudioArbiter` 单音源仲裁可复用。
- `src/data/types.ts` `ContentWord.audio_path?` L67 字段存在，但**未找到任何实际打包的音频资源**。
- **未找到**：错误提示音（无 `AudioContext`/`oscillator`/`beep`/音频文件）、发音或提示音的播放防抖/播放锁（`WordCard.tsx` 的 `speaking` 只是动画态）。
- 前提卡红线（正本 L951、L593-595）：内置词库 `ipa` **只有英音**，美音音标无任何数据来源，「英/美切换按钮移除」，TTS 朗读口音跟随既有 `accent` 设置。截图工具栏里的「美音」字样若落地，只能表示 TTS 口音，音标须标英音或「未收录」，**不得拿英音标冒充美音**；需求正文并未要求新增口音切换入口，建议不新增。

### 1.5 手机端 / PC 端现有断点与布局

- `tailwind.config.js` L1-62 **无自定义 screens** → Tailwind 默认 `lg = 1024px`；`src/hooks/useIsDesktop.ts` L6-8、L18-50 用 `matchMedia('(min-width:1024px)')`，与 `lg` 对齐。
- `src/components/layout/AppShell.tsx` L35-78：≥1024 走 `SideNav + DesktopTopBar + max-w-[1200px]`，不渲染底部导航；<1024 走 `safe-top/safe-bottom + SearchDock + BottomTabBar`。
- `index.html` L5 `viewport-fit=cover, maximum-scale=1.0`；`src/index.css` L85-91 `.safe-top/.safe-bottom` 用 `env(safe-area-inset-*)`；`src/hooks/useKeyboardInset.ts` L19-52 基于 `visualViewport` 写 `--kb-inset`，`AppShell.tsx` L70 已消费。
- `Spelling.tsx` 本身**只有 `px-4` / `flex-1` / `touch-target`，无任何断点类**，页面走 AppShell 默认壳。
- 已有真实浏览器脚本 `scripts/check_spelling_browser.mjs`（S1-S9，含 375px 窄屏、软键盘、1280px 桌面、双标签页、刷新恢复）与 `scripts/check_spelling_ui.ts`（L653-654 自述 jsdom 无布局引擎、响应式未验证）—— Phase 5 应复用扩展，不另起炉灶。

### 1.6 已存在 / 需新增

| 能力 | 现状 | 证据 |
| --- | --- | --- |
| 整词输入 + 提交、Enter 提交 | 已存在 | `Spelling.tsx` L518-537、L577-583 |
| 连对 3 次 / 错误归零 / `COMPLETED` / 跳过 / 失效 | 已存在，语义冻结 | `spelling.ts` L37、L505-547 |
| `request_id` 幂等（整词提交级） | 已存在 | `spelling.ts` L510-511、L545；`Spelling.tsx` L206-208 |
| 会话单文档持久化、刷新恢复、暂停/继续/放弃、多标签冲突人工裁决 | 已存在 | `spellingSession.ts` L49、L197-247；`Spelling.tsx` L106-175 |
| SRS 仅 `COMPLETED` 交接、失败补交（at-least-once） | 已存在 | `spellingSession.ts` L433-477、L391-410 |
| 结果页聚合统计（提交次数/答对/正确率/用时） | 已存在 | `SpellingResult.tsx` L90-91 |
| 发音 TTS（英/美口音） | 已存在 | `speech/web.ts` L117-190 |
| 「易错词」选词模式 | 已存在（非错词本） | `spelling.ts` L49、L294-300 |
| 逐字母打字 / 单词即输入区 / 逐字母颜色 / 自动切词 | **需新增** | 全仓未找到 |
| 显示/隐藏单词 + 偏好持久化 + 眼睛按钮 | **需新增** | 全仓未找到 |
| `Space+G` / `Space+H` 组合键、按键状态机 | **需新增** | 全仓未找到 |
| 错误提示音 + 播放防抖 | **需新增** | 全仓未找到 |
| 练习页实时统计（时间/输入数/WPM/正确数/正确率） | **需新增**（结果页统计口径不同） | `Spelling.tsx` 未找到 |
| 独立错词本（错误次数/最近错误时间/正确答案/合并去重/移除/再练） | **需新增** | 全仓未找到独立实体 |
| 移动端发音/眼睛图标、≥44×44 触控区 | **需新增** | 全仓未找到 |
| PC 1024~1920 充分利用空间 | **需新增**（当前页面无断点类） | `Spelling.tsx` L444 起 |

---

## 2. 组件契约与数据模型小结（供 Phase 1 对齐）

- UI → 领域层的唯一写入口：`submitAttempt({word_id, input, request_id})` / `skip(...)` / `pause/resume/abandon`；UI **永不直接调 `recordQuiz`**（前提卡 L919）。
- 领域层判分是**整字符串全等比对**（`judgeSpelling(trimmed, word.word)` L525），不是逐字符流。
- 持久化：Dexie `shushu-learn` 当前 **v11**（`web.ts` L198-200）；v10 `spellingSessions: 'id, status, started_at, owner'` L190-192；`INDEXED_FIELDS` L56-79 是索引白名单；`queue` 内嵌数组不建索引；`web.ts` L186-189 注释明确 **TableService 没有事务 API**，所以「计数 + 状态 + 队列推进」靠一次 `put()` 换整份文档保证原子。
- 偏好：`zustand persist` 键 `'shushu-settings'`（`useAppStore.ts` L277），Dexie `settings:'owner'` 表 v8 已定义但**未找到实际读写**。
- 平台 API 红线（前提卡 L649-654）：页面只调 domain/services 公开 API；`src/services/storage/web.ts` 是唯一 import dexie 的地方。

---

## 3. 风险与必须先裁定的问题

### 🔴 R1：错误事件语义死锁（最高优先级）

需求同时要求：
- §3.2「错误字母**不写入答案、不推进输入位置**」「用户无需退格，只需重新输入当前应输入的字母」；
- §3.2「错误时连续正确次数归零」「错误记录按现有答题状态机和错词本规则处理，不得把一次错误按键误算成多次完整答题」；
- §7.1「当用户完成一次错误拼写时加入错词本」，且「不要将**单个错误按键**、退格修正或尚未完成的输入记入错词本」；
- §3.3 / §7.4「不得修改原有答题状态机和 SRS 语义」。

但现有 `applyAttempt` 的 `wrong` 分支只在**整词字符串判错**时触发（L534-541）。若逐字母模式只接受正确字母，理论上**永远不会提交一个错误整词** → `wrong_attempts` 恒为 0、连对归零没有事件源、错词本没有触发源。四条约束无法同时成立。

需要裁定「一次错误拼写」的定义。候选（推荐 A）：
- **A（推荐）**：以「一次单词尝试」为错误单位。该词从开始输入到完成/放弃期间出现过 ≥1 次错误按键，则在**本次尝试结束**时用新 `request_id` 生成一次状态机 `wrong` 提交，同时写一条错词记录；同一次尝试内多次错误按键只记一次。
- **B**：每个错误按键即时生成一次 `wrong` 提交（会与「不得把一次错误按键误算成多次完整答题」冲突，且会把错误次数放大）。
- **C**：错词本完全脱离状态机，由 UI 独立事件驱动（需新幂等键，且仍要解决「连对归零」由谁触发）。

### 🔴 R2：「自动切词」与「连对 3 次」直接冲突

§3.1「完整输入正确：自动完成当前答题并**切换下一个单词**」vs §3.3「每个单词连续正确 3 次才完成……**完成反馈**短暂显示后自动切换下一个单词」。且需求明令不改状态机。

**建议（待确认）**：拼完一遍 = 一次 `correct` 提交；未达 3 次则**同一单词清空字母进度、立即再拼一遍**（不切词，UI 上用「连对 x/3」提示）；第 3 次 `COMPLETED` 时才切下一个词。这样 `applyAttempt` / `advance()` / SRS 交接一行不改。若用户本意是「拼对一次就切词」，则等于把 target 改成 1，与 §3.3 冲突，需书面确认改状态机语义。

### 🔴 R3：错词本落库 = Dexie v12 迁移，且跨表无事务

- 无独立错词表；新增表必然是 `version(12)`（`web.ts` 当前 v11，且 v11 是他人未提交改动）。需求 §7.5「如果需要数据库版本升级，必须**独立评审迁移方案和旧数据兼容性**」，§11.6「涉及数据库迁移时先提交设计与风险分析，不擅自升级版本」。
- `TableService` 无事务 API → 「答题计数（会话文档 put）」与「错词记录（另一张表 put）」**无法原子提交**。若沿用 `request_id` 作幂等锚点，需设计补偿/去重键，否则会出现「计数成功但错词漏记」或反之。
- 候选：**A（推荐）** 新增 `spellingMistakes` 表（`word_id` 主键合并、`wrong_count`、`last_wrong_at`、答案/释义快照、`source`），v12 纯新增、无 upgrade、旧数据零改动，独立评审后再动；**B** 零迁移，复用 `spellingSessions.queue[]` 聚合出派生视图（跨会话扫描、会话清理即丢数据）；**C** 复用 `vocab.in_wrong_pool` + `reviewLog`（但方案 V3.2 L317-319 明确「默写过程中的错误输入不落盘」，派生不到默写错误，且不得改 `recordQuiz` 语义）。

### 🟠 R4：新增页面路由 vs「不擅自修改 App.tsx」

需求 §11.5 禁止擅自改 `App.tsx`，但错词本页面需要入口。
**建议（待确认）**：复用现有 `/collection/:id` 路由（`App.tsx` L152-159 已注册），新增一个 id 分支（如 `spelling-wrong`）挂载新组件 —— 零 `App.tsx` 改动，且符合 §7.2「优先复用现有组件与数据访问层」。需用户批准改造 `src/pages/CollectionDetail.tsx`（或新建组件在同一路由下分派）。若坚持新建独立路由，需书面批准改 `App.tsx`。

### 🟠 R5：错词本专项练习的来源区分与会话互斥

- `selection_mode` 只有 3 值（L49），`createSession` 只接受 `mode`，无法表达「来自错词本」；需求 §7.3 要求来源可区分、不破坏原有会话。扩展枚举/加 `source` 字段会改 `SpellingSession` 类型与 `createSession` 签名（不改判分语义，但改数据结构与测试基线），需批准。
- `createSession` L205-211 遇到进行中会话直接抛 `SESSION_CONFLICT`。从错词本点「再次练习」时若已有活跃会话，必须定义 UX（恢复 / 放弃 / 提示排队），否则用户会撞到冲突空态。

### 🟠 R6：隐藏模式不能真的删掉 `<input>`

- iOS / Android 必须存在**可聚焦的真实输入元素**才能唤起软键盘；「不显示传统输入框边框」应实现为「视觉不可见但可聚焦的输入层」，配合 `beforeinput` / `compositionstart` 处理输入法组合期（需求 §5.8）。
- 隐藏模式要求「不得通过 DOM、无障碍标签或其他视觉提示泄露完整答案」：需同时检查 DOM 文本、`aria-label` / `title` / `alt`、`aria-live` 朗读内容。注意会话文档 `queue[].word` 仍存在于前端内存与 IndexedDB（数据模型决定，非安全边界）—— 需求约束的是视觉/DOM/无障碍提示，该范围内可满足，但**不能对外宣称「答案不可被查看」**。
- 已有 `useKeyboardInset` 的 `--kb-inset` 与 `AppShell` 底部处理可直接复用，避免虚拟键盘顶飞布局。

### 🟠 R7：实时统计口径未定义（涉及「不编造数字」红线）

练习页目前无实时统计；`aggregateSession` 是「提交次数」口径，与截图的「输入数 33 / 正确数 31 / 正确率 94% / WPM 1 / 时间 02:22」不是同一套量纲（31/33≈94% 说明是按键级计数）。WPM 的分母与「每词」定义未给；从截图反推 WPM=1 的口径属于**待验证假设**，不能据此写死。**建议**：明确「输入数=有效字母按键数」「正确数=正确字母按键数」「WPM = 正确字母数 / 5 / 分钟（或按完成单词数）」，且这些计数**只存在 UI 会话态、不进状态机、不落库**，避免污染既有结果页统计语义。

### 🟠 R8：发音与错误提示音

- 发音可直接复用 `speakFocused` / `webSpeechService`（TTS），Space+G 需「一次组合只播一次 + 释放后才能再触发」的按键状态机；现有 `speak` 的 `cancel()` L176 只清队列，不等于防重复触发。
- 错误提示音**无资源**：建议 WebAudio 生成短音（不引第三方依赖）+ 播放锁（或复用 `audioBus` 的 `AudioArbiter`），并做防抖，满足 §3.2「不得连续叠加播放」。
- 「美音」标签见 §1.4 前提卡红线，建议本轮不新增口音切换入口。

### 🟡 R9：显示/隐藏偏好的落点

建议扩 `useAppStore.ts` 的 zustand persist（键 `shushu-settings`）新增一个布尔字段，不碰已有字段、不启用 Dexie `settings` 表（该表无读写实现）。需确认是否纳入多端同步范围（现状 `partialize` L278-283 只含 settings/isGuest/wordDetail/searchHistory）。

### 🟡 R10：验收口径与并行任务

- `练习/阶段三-E-全量验收报告.md` 结论为 **Limited Pass**，三项已知限制（SRS 交接 at-least-once、多标签非原子互斥、冲突提示非实时）用户已裁定维持现状；真机软键盘未验证。
- 前提卡 L1033-1038 四件套：`npx tsc --noEmit` / `npm test` / `npm run build` / `python scripts/check_pwa.py`；E 报告 L29-34 强调「当前工作树通过 ≠ 提交树独立构建通过」（干净 clone 曾有 4×TS2307，源于其他任务 8 个未提交源码），且 `scripts/` 不在 `tsconfig include`。
- 需求 §10 要求真实浏览器验收（PC 4 档 / 手机 4 档 / 快捷键 / 虚拟键盘 / 刷新恢复 / 错词再练）；现有 `check_spelling_browser.mjs` 只覆盖部分，需扩展而非替换。

---

## 4. 预计改造文件清单（**尚未修改任何文件**）

| 类别 | 文件 | 说明 |
| --- | --- | --- |
| 必改 | `src/pages/Spelling.tsx` | 主战场：单词即输入区、逐字母状态、颜色/错误反馈、显示隐藏、发音/眼睛按钮、快捷键接入、实时统计、响应式 |
| 拟新增 | `src/hooks/useSpellingTyping.ts`（或等价命名） | 逐字母输入状态机（UI 层，纯函数化便于单测） |
| 拟新增 | `src/hooks/useSpellingShortcuts.ts` | Space+G/H 按键状态管理（keydown/keyup/repeat/blur/composition） |
| 拟新增 | `src/domain/spellingMistakes.ts` | 错词记录服务（合并去重、幂等、移除、查询排序）—— **仅在 R3 获批后** |
| 拟改 | `src/pages/CollectionDetail.tsx` 或新组件 | 错词本列表（错误次数/最近时间/发音/移除/再练）—— 复用 `/collection/:id` 路由 |
| 拟改 | `src/store/useAppStore.ts` | 显示/隐藏偏好字段 |
| 拟改（需批准） | `src/domain/types.ts`、`src/services/storage/web.ts`、`src/services/storage/memory.ts` | 仅在批准 v12 新表后 |
| 拟改（需批准） | `src/domain/spelling.ts`、`src/domain/spellingSession.ts` | 仅在批准扩展 `selection_mode` / `source` 后；**判分与 SRS 语义不动** |
| 可能改 | `src/pages/Review.tsx` | 错词本入口 / 再练来源参数 |
| 测试 | `scripts/test_spelling*.ts`（新增逐字母、错词、快捷键用例）、`scripts/check_spelling_browser.mjs`（扩展 8 档设备 + 真机软键盘）、`scripts/test_spelling_ui.ts` | 沿用现有命名与 `package.json` 脚本登记 |
| **明确不改** | `src/App.tsx`（除非书面批准）、Reader / ASR / 转写 / 格式转换 / `server/` / 依赖版本 | 需求 §11.2、§11.5 与前提卡 L1008 |

---

## 5. Phase 1 建议的实现策略（待确认后执行）

1. **分层**：逐字母交互、快捷键、错词记录各拆成独立 hook / service；`Spelling.tsx` 只做编排与渲染，判分仍只调 `submitAttempt`。领域层状态机、`recordQuiz` 语义、SRS 交接一行不改。
2. **错误/幂等**：以 `request_id` 为跨 UI↔领域层唯一幂等锚；错误事件按 R1 裁定结果映射成状态机事件，UI 重渲染不得二次写入。
3. **偏好**：zustand persist 单点写入，会话恢复时读取，不重建会话、不触发 SRS。
4. **发音/提示音**：TTS 复用 `speech` 服务；提示音 WebAudio + 播放锁；快捷键用显式按键状态集合，处理 repeat / blur / composition / 非练习页不注册。
5. **响应式**：只用现有 `lg(1024px)` 与 `useIsDesktop()`，PC 加宽中央卡片、手机纵向布局；复用 `--kb-inset` 与 `safe-*`；触控区 ≥44×44。
6. **验证**：每阶段跑 `npx tsc --noEmit` 与相关 `npm test` 子集；Phase 5 跑完整四件套 + 真实浏览器验收，分别报告「当前工作树」与「提交树独立构建」结论。

---

## 6. 等待确认（确认后才进入 Phase 1）

1. **R1**：「一次错误拼写」采用 A / B / C 哪种定义？
2. **R2**：拼完一遍是否按「同词清空字母再拼，第 3 次才切词」执行？
3. **R3**：是否批准新增 Dexie v12 表（需另出迁移设计与旧数据兼容性评审）？还是先走零迁移派生方案？
4. **R4**：错词本页面复用 `/collection/:id` 路由（不改 `App.tsx`），还是批准新增独立路由？
5. **R5**：是否批准扩展 `selection_mode` / 新增 `source` 字段以区分错词本练习？已有活跃会话时的「再次练习」采用什么 UX？
6. **R7**：WPM 与「输入数 / 正确数」的统计口径按哪个定义？
7. **R8**：截图工具栏的「美音 / CET-4 第 6 章」是否属于本轮范围？（建议：不属于；本轮只做发音按钮，且不新增口音切换入口，以守住「美音音标无数据来源」红线）

其余次要项（R6 隐藏 input 技术路线、R9 偏好落点、R10 验收脚本复用）若未特别指示，按第 5 节建议执行。
