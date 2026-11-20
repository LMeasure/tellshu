# 单词默写 V2 · Phase 1.2.3.2 · 清除破坏范围与可执行契约补充审查

> **本轮性质**：纯设计、只读审计。**不实施源码，不迁移数据库，不修改 Git 暂存区 / 工作区已有文件，不修改前提卡，不决定 Dexie version，不解除 G9，不新增局部清除 API，不实施任何清除。**
> **交付物**：仅新增本报告 + 按保护流程追加一条工作日志。完成后停止，等待负责人审阅。

---

## 0. 承接关系、基线与证据标注

### 0.1 承接范围

本报告**只审查 Phase 1.2.3.1 遗留的四项**，按用户指定优先级排列：

| 序 | 遗留项 | 优先级 | 本报告章节 |
| --- | --- | --- | --- |
| 1 | 全局清除的破坏范围 | **最高** | 第 1 章 |
| 2 | `COVERED` 与异常分类的优先级 | P0 | 第 2 章 |
| 3 | `readSnapshot` 的可执行契约 | P0 | 第 3 章 |
| 4 | 统计口径与 UI 文案 | P0 | 第 4 章 |

**不重新审查** 1.2.3.1 已闭合的 epoch 三分支、结构校验门、混合快照成因、五类异常 UI 五问矩阵等结论。C01–C82 / T01–T105 的**编号与结论原文全部保留**，本轮新增编号从 **C83 / T106** 起。对既有设计条款的修订一律以**新增 D 项 + 新增测试编号**提出，**不改写、不覆盖旧编号**（旧编号作为历史设计记录留在案，是否收窄其适用范围须负责人批准）。

### 0.2 基线（沿用前轮只读记录）

| 项 | 状态 | 证据等级 |
| --- | --- | --- |
| Git HEAD | `760e999`；暂存区 6 个 `A`（B12 系列）未变；工作区存在并行 Agent 改动 | `【只读核实】`（沿用 Phase0 / 1.2.3.1 记录，**本轮未重新执行 git 状态命令，避免触碰索引**） |
| `产品方案/打字/` | 未跟踪目录，前 8 份报告未改；本报告为第 9 份新增 | `【只读核实】`（目录列举） |
| 源码最高 Dexie 版本 | `version(11)`（`wordLearningSessions`） | `【只读核实】` `web.ts` L33-34 / L78 |
| 并行架构规划 | V1.2.6 / V1.2.7 同时规划 v12 / v13，D3「待裁定」 | `【只读核实】`（沿用 1.2.2 / 1.2.3.1 记录，本轮未取得任何新协调结论） |
| 新表 / 新字段 | `spellingErrorEvents` / `applied_error_event_ids` / `lock_epoch` / `covered_event_ids` / `readSnapshot` **源码零落地** | `【只读核实】`（沿用 1.2.1 / 1.2.3.1 Grep 结论） |

### 0.3 五类证据标注（沿用）

`【只读核实】` = 本轮或前轮逐行读到的源码 / 文档事实；`【设计推导】` = 由事实推出的逻辑结论，未实测；`【待自动化】` = 需单测 / 集成测试验证；`【待真机】` = 需真实浏览器 / 双标签 / IndexedDB 验证；`【需批准】` = 产品语义或设计取舍，**本报告不自行裁定**。

---

## 1. P0-1（最高优先）· 全局清除的破坏范围

### 1.1 只读核实：`clearAll()` 到底清了什么

| # | 事实 | 源码位置 | 标注 |
| --- | --- | --- | --- |
| F1 | `INDEXED_FIELDS` 是 `Record<TableName, readonly string[]>`，共 **20 张表** | `web.ts` L56-79 | `【只读核实】` |
| F2 | `const TABLE_NAMES = Object.keys(INDEXED_FIELDS) as TableName[]` —— 清表清单**直接由索引白名单派生**，不是独立的「可清除表」清单 | `web.ts` L81 | `【只读核实】` |
| F3 | `clearAll() = await Promise.all(TABLE_NAMES.map((n) => db[n].clear()))` —— **逐表并发、无事务包裹、无失败汇总** | `web.ts` L289-291 | `【只读核实】` |
| F4 | `StorageSchema` 恰好也是 20 张表，与 `TABLE_NAMES` 一一对应 | `domain/types.ts` L374-401 | `【只读核实】` |
| F5 | 门面契约注释：「清空**全部本地学习数据**（设置页「清除数据」用）」 | `types.ts` L51-52 | `【只读核实】` |
| F6 | 全 `src/` Grep `clearAll(` 仅 5 处命中：3 处定义/声明（`web.ts` / `memory.ts` / `types.ts`）+ 2 处**页面局部 UI 状态清空**（`Import.tsx` L518、`ConvertPanel.tsx` L186）；**未找到任何 `storage.clearAll()` 调用点** | Grep 全 `src/` | `【只读核实】` |
| F7 | Grep `清除数据\|清空数据\|清除本地\|清空全部\|deleteDatabase` 未命中设置页按钮，只命中 `types.ts` L51 注释与两处无关注释 | Grep 全 `src/` | `【只读核实】` |
| F8 | memory 驱动 `clearAll()` = `for (const t of tables.values()) await t.clear()`，只遍历**已被 `tableOf()` 实例化过的表** | `memory.ts` L187-199 / L212-214 | `【只读核实】` |
| F9 | memory 与 web 的 `INDEXED_FIELDS` **不一致**：`vocab` / `reviewLog` / `readingTime` 三表在 web 侧有 `owner` 索引，memory 侧**没有** | `web.ts` L57-60 vs `memory.ts` L21-24 | `【只读核实】` |

> **F6 / F7 的准确表述**：当前工作树中 `clearAll()` 是一个**已定义、尚无页面调用**的门面 API，注释把它定位为「设置页的全局清除」。因此若把它挂到错词本异常横幅上，等于**新开一个此前不存在的高危入口**，且不是「复用现有设置页按钮」。不得把注释写成「设置页已有该按钮」。

### 1.2 20 张表的业务影响清单

`TABLE_NAMES` 覆盖 `StorageSchema` 全部 20 张表。逐表列出被 `db[n].clear()` 清空后**丢失什么**（表名 / 类型来自 `domain/types.ts` L374-401，字段级事实来自该文件的类型定义）：

| 分组 | 表 | 被清除的内容 | 可再生性 |
| --- | --- | --- | --- |
| **学习核心** | `vocab` | 词库全部词条 + **SRS 状态**：`layer` / `consecutive_correct` / `srs_step` / `next_review` / `in_wrong_pool` / `mastered_at` / `deleted_at` 墓碑 / `added_at` | ❌ 用户学习进度不可再生 |
| | `reviewLog` | 全部复习答题历史（`at` / `uid` / `owner`） | ❌ 历史不可再生 |
| | `readingTime` | 每日阅读时长统计 | ❌ 统计不可再生 |
| | `diagnose` | 诊断记录 | ❌ |
| **阅读资产** | `readings` | 用户导入的全部书籍正文（含 `on_shelf`） | ❌ 原文件需重新导入 |
| | `annotations` | 划线与想法批注 | ❌ |
| | `recitations` | 背诵记录 | ❌ |
| **词典缓存** | `dictEntries` / `dictToc` / `dictGrammar` / `dictMeta` | 词典扫描库缓存（词条 / 目录 / 语法 / 元数据） | ⚠️ 理论可重建，但离线 PWA 下重建依赖重新扫描/联网，**不能承诺可恢复** |
| **账号与同步** | `collections` | 收藏集与**既有 SRS 错题本**（`/collection/wrong` 所依赖的数据） | ❌ 与本任务「不复用 SRS 错题」是两套数据，但会被一并清掉 |
| | `settings` | 账号设置行 | ⚠️ 注意：默写四档 `target_correct` 在 zustand persist（localStorage `shushu-settings`），**不在本表** |
| | `session` | 登录态 | ⚠️ 需重新登录 |
| | `sync_queue` | **尚未同步的变更队列** | ❌ 清除即永久丢失未同步数据 |
| | `sync_meta` | 同步水位 / 元数据 | ❌ 丢失后可能与远端产生不一致 |
| **ASR / 学习稿** | `transcripts` | 字幕持久化记录 | ❌ **不可再生**（按 VPS Phase0.7 D2，ASR 媒体完成后即删） |
| | `studyNotes` | AI 学习稿 | ❌ 依赖字幕，字幕清掉后不可重建 |
| **会话** | `spellingSessions` | 默写会话文档与历史（含 `applied_error_event_ids` / `lock_epoch` 等设计态字段落地点） | ❌ 历史不可再生 |
| | `wordLearningSessions` | 单词学习进度（v11，2026-10-31 刚修复过进度重置问题） | ❌ 进度不可再生 |

`【设计推导】`：`clearAll()` 的作用域是**整个本地学习数据域**，不是「错词本域」。它一次清除用户词库、SRS 调度、阅读书与批注、词典缓存、登录态、未同步队列、不可再生的字幕/学习稿，以及两个会话表。

### 1.3 判断：从错词本异常提示触发全局清除是否误删

**结论：会，且破坏范围远超「修一个错词本异常」**。`【设计推导】`

| 维度 | 说明 |
| --- | --- |
| 用户意图 | 在错词本看到「N 条记录暂无法归类」，期望的是**解释 / 重试 / 忽略**，不是删除全部学习数据 |
| 实际操作 | `clearAll()` 清 20 张表，含 F-表之外的 SRS、词库、阅读、同步、字幕 |
| 1.2.3.1 §3.3 | 把「重新清除本地数据」写成错词本异常的**恢复入口之一**，并允许走 `clearAll()` + 二次确认 —— 这是把全局破坏性操作伪装成局部修复 |
| 不可逆 | F3 非事务、无备份、无回滚；清除后无法恢复 `vocab` 的 SRS 状态与 `transcripts` / `studyNotes` |
| 反噬 | 1.2.3 已认定「`clearAll()` 部分成功」是 **ORPHAN 的唯一现实成因**；F3 逐表并发、任一表 clear 失败即留下「会话表已清 / 事件表未清」的混合状态 → **把 clearAll 当恢复手段会制造更多 ORPHAN / 混合快照 / EPOCH_AHEAD**，形成「异常 → 清除 → 新异常」的循环 |
| 语义不实 | `clearAll()` **不删除 IndexedDB 数据库本身、不重置 Dexie 版本、不重置 localStorage（zustand persist / 四档设置）、不清 Service Worker 缓存**。因此即便二次确认写「恢复出厂设置」也是不实表述 |

**另一个驱动分叉（F8）**：memory 的 `clearAll()` 只清已实例化表，web 侧清固定 20 张表 → 单测里用 memory 驱动**无法复现** web 的完整破坏范围。这与 F9 的索引白名单分叉一起，构成新增未解决问题 **U22**。`【只读核实】【设计推导】`

### 1.4 非破坏性恢复入口设计（不新增局部清除 API，不实施清除）

**硬约束（用户给定，直接落实）**：错词本页面**不得**出现「清除本地数据 / 重新清除 / 清空数据」按钮；全局清除必须独立授权、明确列出影响范围，不能作为错词本普通恢复按钮。

错词本异常横幅可用的恢复入口，全部为**只读或零写入**：`【设计提案】【需批准】`

| 入口 | 行为 | 写入 | 适用异常 |
| --- | --- | --- | --- |
| 「刷新重试」 | 重新 `readSnapshot` + 重新 `classify`，展示重算结果 | **零** | `EPOCH_AHEAD`、部分 `ORPHAN`（会话文档恢复后可自愈） |
| 「查看明细」 | 只读展开分类计数与内部原因码（不向用户暴露字段名 / 用户标识） | **零** | 全部五类 |
| 「知道了 / 忽略」 | 仅关闭本次轻提示；常驻横幅不自动消失（数据未变） | **零**（UI 内存态） | 轻提示类 |
| 「继续练习」 | 照常使用正常活动错词列表，异常记录不阻塞练习 | **零** | 全部 |

**明确不做**：不自动重建会话文档、不自动补写凭证、不自动改 `lock_epoch`、不自动迁移 `owner`、不自动造数、不物理删历史行、**不新增「只清错词本」的局部清除 API**（用户明令禁止，且局部清除与 append-only / 永久幂等凭证模型冲突，须另立评审）。

> 1.2.3.1 §3.3 中的「重新清除本地数据」入口**本轮不改写其既有文字**（保留 C80–C82 / T103–T105 结论原样），而是以新增 **D21** 提出「错词本页不得挂载该入口」的设计约束；若 D21 获批，实施时收窄 §3.3 的适用范围，旧编号作为历史设计记录保留。`【需批准】`

### 1.5 全局清除的独立授权条件（仅设计约束，不实施）

若未来确需从**设置页**提供全局清除，最低前置条件（独立于本任务范围，须另行评审）：`【设计提案】【需批准】`

1. **独立入口**：只在设置页，不与错词本 / 默写 / 任何异常提示共用按钮或确认弹窗。
2. **独立授权**：显式二次确认 + 用户主动输入确认（或等价强度），不能用「确定 / 取消」一键完成。
3. **明确列出影响范围**：按 1.2 的分组**逐项列出**将丢失的数据（词库与 SRS 进度、复习历史、导入书与批注、词典缓存、登录态、**未同步队列**、字幕与学习稿、默写与单词学习会话），并单列「不可再生」项。
4. **如实说明**：「操作不可恢复，建议先导出备份」；「逐表清除、非事务，可能部分成功，届时需重试」；「不会重置浏览器本地设置与离线缓存」。
5. **并发协调**：清除期间其它标签可能持有 L2 写锁或正在写入 → 须先释放 / 接管锁并阻止写入，属 U16 升级/中断恢复链范畴，**不得在未设计前宣称安全**。
6. **失败可见**：F3 的 `Promise.all` 任一 reject 必须如实报错并列出可能已清的表，**禁止**吞错或假报成功。

### 1.6 新增测试设计（C83–C87 / T106–T110）

| # | 场景 | 断言要点 | 层级 |
| --- | --- | --- | --- |
| **C83/T106** | `clearAll()` 破坏范围清单 | web 驱动 20 张表逐表断言被清空；特别断言 `vocab.srs_step` / `next_review` / `in_wrong_pool`、`transcripts`、`studyNotes`、`sync_queue` 数据不可恢复（测试用副本库，不触生产库） | `【待自动化】` + `【待真机】` |
| **C84/T107** | 非事务部分成功 | 注入第 k 张表 `clear()` reject；断言 `Promise.all` 抛错、已清表与未清表并存、产生 `ORPHAN` / 混合快照；断言无静默吞错 | `【待自动化】` + `【待真机】` |
| **C85/T108** | 错词本页无全局清除入口 | 静态检查 + 渲染断言：错词本异常横幅不含 `storage.clearAll()` 调用、不含「清除本地数据 / 重新清除」文案；四个非破坏性入口均为零写入 | `【待自动化】` |
| **C86/T109** | 独立授权文案矩阵 | 若 D21 获批且未来实现设置页入口：断言 20 表影响清单、不可再生项、不可恢复、非事务、不重置 localStorage/SW、并发锁协调提示全部出现 | `【待自动化】` |
| **C87/T110** | 两驱动 `clearAll()` 范围分叉 | 断言 memory 只清已实例化表、web 清固定 20 表；单测记录该分叉，禁止把 memory 结果当作 web 结论 | `【待自动化】` |

---

## 2. P0-2 · `COVERED` 与异常分类的优先级

### 2.1 只读核实：当前 `COVERED` 确实遮蔽全部异常

1.2.3.1 §1.3 分类表把 `covered.has(E.event_id)` 列为**第 1 优先级**（L63），§1.4 伪码首行即 `if (covered.has(E.event_id)) return 'COVERED'`（L104），且在结构校验门（L105-109）**之前**。§1.3 状态转换图（L165-167）也明确画了 `EPOCH_AHEAD / OWNER_MISMATCH / INVALID_EPOCH --> COVERED : reset 覆盖`。`【只读核实】`

由此得出**遮蔽矩阵**：`【设计推导】`

| 事件真实状态 | `covered` 未命中 | `covered` 命中（被某次 reset 覆盖） | 后果 |
| --- | --- | --- | --- |
| `OWNER_MISMATCH` | 常驻横幅（隔离破坏） | `COVERED`，**不提示** | **隔离破坏信号被静默抹除**，且 reset 可能来自错配的 owner scope |
| `INVALID_EPOCH` | 常驻横幅（脏数据） | `COVERED`，不提示 | 脏数据不再被识别 |
| `EPOCH_AHEAD` | 轻提示 + 刷新重试 | `COVERED`，不提示 | 会话落后信号丢失 |
| `ORPHAN` | 轻提示 | `COVERED`，不提示 | 会话文档缺失信号丢失 |
| `UNCLASSIFIABLE` | 常驻横幅 | `COVERED`，不提示 | 结构异常信号丢失 |

> `covered_event_ids` 由 D11 的 T-R 事务 `appendFromSnapshot(scope, build)` 在**单表快照**内冻结（1.2.1），`scope` 含 `owner` / `word_id`。`【设计推导】` 若事件行的 `owner` 本身非法或与会话错配，`build` 的过滤判据未定义 → 「covered 证据本身的合法性」目前**无门**，跨 owner 的 reset 是否可覆盖别 owner 的事件也未定义。这属于隔离完整性缺口，记为 **U23**。

### 2.2 区分两个正交问题（不得混为一谈）

`【设计推导】【需批准】`

- **问题 A（活动列表）**：这条事件是否应出现在错词本 / 重练列表？`COVERED` 的既有语义「reset 后移出活动错词本」回答的是这个问题，**本身没有错**。
- **问题 B（数据完整性）**：这条事件是否携带 `OWNER_MISMATCH` / `INVALID_EPOCH` / `EPOCH_AHEAD` / `ORPHAN` 等异常信号，需要被识别、计数、审计或提示？**这是独立维度，不应被问题 A 的答案抹掉**。

1.2.3.1 把二者压进单一 `StatClass` 枚举（`COVERED` 与异常类互斥），才导致「reset 一覆盖，隔离异常信号永久消失」。用户要求「不因 reset 覆盖而丢失隔离异常信号」，本质是要求**拆分这两个维度**。

### 2.3 待批准选项（本报告不自行裁定）

`【需批准】` 三个选项并列，附代价；**没有默认结论，全部待 D22 裁定**。

| 选项 | 设计 | 对问题 A | 对问题 B | 代价 / 风险 |
| --- | --- | --- | --- | --- |
| **A** 保持现状 | 单一枚举，`COVERED` 最高优先、遮蔽全部异常 | 移出活动列表 | 异常信号**丢失**，不计数、不提示、不审计 | 隔离破坏被 reset 掩盖；审计不可见；与用户本轮要求冲突 |
| **B** 双轴分类（**设计倾向，非裁定**） | 拆成 `lifecycle`（活动列表判据，含 `COVERED`）与 `integrity`（异常原因码）两个独立输出；`integrity` 在 `covered` 判定**之前**计算且不受其遮蔽；`abnormal_counts` 含被覆盖的异常 | 移出活动列表（不变） | 识别 / 计数 / 审计，UI 显示「另有 N 条历史记录存在数据异常（已移出错词本）」 | 需修订 1.2.3.1 §1.3 / §1.4 / §3.1 / D18 / D20；`abnormal_counts` 定义与展示位置需产品确认；异常横幅在 reset 后是否仍常驻需确认 |
| **C** 异常优先于 covered | 重排优先级：异常类 > `COVERED`；异常事件不计入 active、仍显示异常横幅 | 移出活动列表 | 识别且横幅不因 reset 消失 | reset 后横幅常驻，可能违反用户对「移除错词」的预期；需产品确认常驻时长 |

**设计倾向说明（不构成裁定）**：选项 B 能同时满足「活动列表无需展示」与「完整性异常仍须被识别、统计或审计」，且不改变 `active_wrong_count` / `total_error_events` 的既有定义，对 1.2.3.1 已闭合的 epoch 三分支与结构门改动最小。但「是否向用户展示被覆盖的异常」「日志保留多久」属产品语义，**本报告不决定**。

> 无论选哪项，都需补一条 **covered 证据合法性门**：仅当 reset 行的 `owner` / `session` scope 与事件合法匹配时才承认覆盖；非法 reset 行不得覆盖任何事件，且自身应计入异常计数。`【设计提案】【需批准】`

### 2.4 冲突测试用例（C88–C90 / T111–T113）

| # | 场景 | 断言要点 | 层级 |
| --- | --- | --- | --- |
| **C88/T111** | 遮蔽矩阵全组合 | `COVERED` × 五类异常 × 未覆盖，共 10 组合；逐组合断言 `active` / `total` / 重练列表 / 提示 / `abnormal_counts`；按 D22 选定选项断言，未批准前**不得写死期望值** | `【待自动化】` |
| **C89/T112** | covered 证据合法性门 | 构造 `owner` 非法 / 跨 owner / `covered_event_ids` 含非字符串 / reset 行缺 scope 四类；断言不产生覆盖、异常被识别、无自动迁移 | `【待自动化】` |
| **C90/T113** | 双轴分类下的 UI 与统计 | 被 covered 的 `OWNER_MISMATCH` 不计入 active、计入 total、不进重练、出现在异常计数与提示中；断言「已移出错词本」文案；断言 `total>0 && active=0` 仍不走 `EmptyState` | `【待自动化】` + `【待真机】` |

---

## 3. P0-3 · `readSnapshot` 的可执行契约

### 3.1 运行时检测 `reader` 返回 Promise / thenable

**问题**：1.2.3.1 §2.3 的签名 `reader: (views: SnapshotViews) => T` 配 `readSnapshot<T>(...): Promise<T>`，`【只读核实】` 该报告 L246-249。**TypeScript 类型挡不住异步 reader**`【设计推导】`：

- 传 `async` reader 时，`T` 被推断为 `Promise<X>`，签名合法，编译无错；`readSnapshot` 返回 `Promise<Promise<X>>`（`await` 时会被展开），类型系统不会报错。
- TS 无法约束 `reader` **内部**是否 `void fetch(...)`、`setTimeout(...)`、`queueMicrotask(...)` 或启动任何未被等待的异步副作用。
- 因此**必须**有运行时检测，但检测也有边界。

**最小检测骨架**`【设计提案】【需批准】`：

```ts
function assertNotThenable(value: unknown): void {
  let then: unknown
  try {
    then = (value as { then?: unknown } | null)?.then
  } catch (e) {
    throw new SnapshotContractError('reader 返回值读取 then 失败', { cause: e })
  }
  if (typeof then === 'function') {
    throw new SnapshotContractError('reader 必须返回同步值，不得返回 Promise / thenable')
  }
}

async function readSnapshot<T>(tables: readonly TableName[], reader: (views: SnapshotViews) => T): Promise<T> {
  return db.transaction('r', tables, async () => {
    const views = await buildViews(tables)   // 仅 await 本事务内、同 db 的表操作
    const result = reader(views)             // 同步调用；此后不得再 await
    assertNotThenable(result)                // 运行时兜底
    return result
  })
}
```

**检测边界（必须如实列出）**`【设计推导】`：

| # | 边界 | 说明 |
| --- | --- | --- |
| L1 | `then` getter 有副作用 / 抛错 | 读取 `then` 本身可能触发副作用；需 `try/catch` 并转成契约错误，不能静默放行 |
| L2 | `then` 非函数但对象仍是「伪 thenable」 | 不构成 thenable，检测放行；但对象内部仍可能持有未等待的 Promise 字段（嵌套 Promise 不被检测） |
| L3 | Proxy / 动态 `get` | `then` 可按访问次数返回不同值，检测可被绕过 |
| L4 | **未返回的 fire-and-forget 异步副作用** | `reader` 内 `void someAsync()` / `setTimeout` / 未 await 的 Promise：**返回同步值，检测完全捕获不到** |
| L5 | 事务上下文失效 | Dexie `r` 事务内一旦 `await` 非本事务 Promise，事务可能已结束；检测只查返回值，**无法证明 reader 执行期间始终处于事务上下文** |
| L6 | `Object.prototype.then` 污染 | 原型链上被挂 `then` 会让普通对象误判为 thenable → 检测应只读**自有属性**或明确规定，避免误报 |

> **明确结论**：`【设计推导】` 运行时 thenable 检测是**兜底**，不是证明。**同步纯函数约束不能证明不存在未等待的异步副作用**（L4 直接给出反例）；也不能仅凭 TypeScript 类型声称运行时同步。要收紧 L4/L5，只能靠：① `reader` 参数只暴露 `SnapshotViews` 同步方法、`views` 不注入任何返回 Promise 的 API；② lint / 代码审查禁止 `async` reader 与 `void promise`；③ 在两驱动注入「写入探针」做行为测试（C92/T115）；④ 明确声明这些手段**降低风险但不构成形式化证明**。

### 3.2 memory 驱动内部 `rows` 的访问、拷贝与引用泄漏

`【只读核实】` 逐条：

| # | 事实 | 位置 |
| --- | --- | --- |
| M1 | `MemoryTableService.rows` 是 `private readonly Map<string|number, T>`；`memoryStorage` 门面**无法直接访问** | `memory.ts` L89-91 |
| M2 | `copy(row)` = `this.clone ? structuredClone(row) : row`；`clone` 由模块级常量 `canClone = typeof structuredClone === 'function'` 决定 | `memory.ts` L98-101 / L190-199 |
| M3 | 文件头注释 L13-14 仍写「**存引用而非深拷贝**……对象是共享的」，与 M2 的 `structuredClone` 实现**不一致** —— 注释已过时，实际行为取决于运行环境 | `memory.ts` L9-15 |
| M4 | `get` / `toArray` / `bulkGet` / `whereIndex` 都是「同步构造 + `Promise.resolve(...)`」；`await` 会让出微任务队列 | `memory.ts` L103-105 / L129-131 / L133-140 / L151-163 |
| M5 | `put` / `add` / `bulkPut` 写入时也走 `copy(value)` | `memory.ts` L108-121 / L142-145 |
| M6 | `clearAll()` 遍历 `tables.values()`，只清已实例化表 | `memory.ts` L212-214 |

`【设计推导】` 由此得到的可执行契约要点：

1. **rows 访问**：`readSnapshot` 落在 `memoryStorage` 门面（1.2.3.1 §2.3(a)），但 `rows` 是 private → 实现上需要给 `MemoryTableService` 新增一个**内部**只读快照方法（如 `snapshotRows(): readonly T[]`），或把 `buildViewsSync` 提升为模块级函数并通过 `#private` 之外的受控访问。**这是新增内部方法，不是新增 `TableService` 公开 API、不是新增表/索引/schema**，但仍落在 `memory.ts` 这个并行改动文件 → 受 G9 验收第 5 条合并顺序管辖。
2. **深浅拷贝**：`structuredClone` 可用时是深拷贝；不可用时（老环境 / 被 polyfill 移除）`copy()` **退化返回原引用** → `views.all()` 若直接返回 `rows.values()` 的数组，业务层修改会**直接污染驱动内部状态**，且两驱动语义分叉（Dexie 侧 `toArray()` 天然是结构化克隆副本）。因此 `buildViewsSync` **不得**依赖 `copy()` 的运行时取值，必须自行做一次确定的深拷贝或冻结，并在 `canClone=false` 环境显式降级且报警。
3. **可变引用泄漏**：`views.all()` 返回 `readonly T[]` 只是 TS 类型，**运行时不冻结**；浅冻结数组不保护数组内对象。契约应规定：`all()` / `byKey()` 每次调用返回**新副本**（不缓存共享数组），并对返回值与 `reader` 的返回值 `T` 一并处理。
4. **`structuredClone` 抛错**：行内若含函数 / `Symbol` / DOM 节点 / Proxy，`structuredClone` 抛 `DataCloneError` → 需在 `readSnapshot` 内按契约错误向上传播，**不得静默回退到引用共享**（回退会让 2 的泄漏在无声中发生）。
5. **返回值不可变性**：`reader` 的返回值 `T` 可能引用 `views` 内的对象。若只冻结 `views`，`T` 仍可变且可能与视图共享引用。设计上二选一（**待批准**）：(a) 规定 `reader` 必须返回新构造的纯值（可序列化、无共享引用），由 `readSnapshot` 用 `structuredClone` 复制后 resolve；(b) 由 `readSnapshot` 对 `views` 与 `T` 做深冻结。两者都要在 C95/T118 里断言「业务层修改返回值不污染驱动、二次读取不变」。

### 3.3 Dexie / memory 的错误传播、事务中断与一致性

`【设计提案】【需批准】`

| 场景 | Dexie 侧 | memory 侧 | 两驱动一致性要求 |
| --- | --- | --- | --- |
| `reader` 同步抛错 | `db.transaction('r', ...)` reject，事务回滚（只读事务无写入） | 1.2.3.1 §2.3(d) 骨架 `return Promise.resolve(reader(views))` 会让 **reader 同步抛错变成函数同步抛出**，而不是返回 rejected Promise → **语义分叉** | 必须 `try/catch` 后 `return Promise.reject(e)`，或把实现声明为 `async`（无 `await` 时仍在同段同步执行，不引入微任务让出）。断言两驱动都是 rejected Promise |
| `reader` 返回 thenable | 运行时检测抛 `SnapshotContractError` | 同 | 错误类型 / 消息一致；断言零写入、事务已结束 |
| `buildViews` 抛错（`tables` 越界、取数失败） | 事务 reject | 同步抛 → 同样需包装为 rejected Promise | 都不静默读到事务外数据 |
| `db.close()` / 版本升级中断 | 事务抛 `DatabaseClosedError` / `AbortError` 一类错误；**原事务不可声称继续**，交 U16 恢复链，原语内**不重试** | 无对应概念，**不得伪造成功** | memory 单测只验证「不静默吞错 + 错误传播」；真实性在 Dexie / 真机验证（C97/T120） |
| `structuredClone` 失败 | Dexie 侧 `toArray` 不触发（IndexedDB 自身克隆已在写入时完成） | memory 侧抛 `DataCloneError` | 按契约错误传播，**禁止回退引用共享** |
| 事务期间并发写 | `r` 事务持有表期间不被其它写事务插入 | 单 JS 线程 + 整段同步不 `await` | 「快照内部非混合但允许稍旧」边界不变（1.2.3.1 §2.3(c)） |

> 与 G9 的关系重申：`readSnapshot` **不新增表 / 索引、不改 `stores()`、不触发版本升级**（1.2.3.1 §2.3(g)）；但实现落在 `types.ts` / `web.ts` / `memory.ts` 三个并行改动文件 → **实施须 G9 关闭后按验收第 5 条确定合并顺序与冲突解决人**。本轮不解除 G9。

### 3.4 新增测试设计（C91–C98 / T114–T121）

| # | 场景 | 断言要点 | 层级 |
| --- | --- | --- | --- |
| **C91/T114** | thenable 检测 | `reader` 返回 `Promise` / 自定义 thenable / 带 `then` getter 抛错对象 / Proxy → 抛 `SnapshotContractError`；两驱动错误类型一致；零写入 | `【待自动化】` |
| **C92/T115** | 检测边界反例 | `reader` 内 `void Promise.resolve().then(写入探针)` 但返回同步值 → 断言**检测捕获不到**；记录为已知限制；探针结果用于证明「同步约束 ≠ 无异步副作用」 | `【待自动化】` |
| **C93/T116** | memory 同步段 | 断言实现未 `await this.toArray()/get()`；`reader` 执行期间注入写入探针，断言无写入插入；`async reader` 被拦截 | `【待自动化】` |
| **C94/T117** | rows 访问与拷贝 | 断言 `buildViewsSync` 不触 `TableService` 公开 API；`canClone=true/false` 两种环境分别断言深拷贝 / 显式降级；`canClone=false` 时业务层修改不污染 `rows` | `【待自动化】` |
| **C95/T118** | 不可变性 | `views.all()` 两次调用返回不同数组；修改返回数组 / 数组内对象 / `reader` 返回值后，驱动内部状态与二次读取不变；断言浅冻结不足的用例被覆盖 | `【待自动化】` |
| **C96/T119** | 错误传播一致性 | `reader` 抛错 / `buildViews` 抛错 / `tables` 越界 → 两驱动**都返回 rejected Promise**（不是 memory 同步抛）；错误零写入 | `【待自动化】` |
| **C97/T120** | 事务中断 | `db.close()` / `versionchange` 期间调用 → 事务抛错、无静默成功、原语内无重试、交 U16 恢复链；memory 侧断言不伪造事务中断成功 | `【待自动化】` + `【待真机】` |
| **C98/T121** | `DataCloneError` | memory 行内含不可克隆值 → 抛契约错误并传播；断言**未**静默回退引用共享 | `【待自动化】` |

---

## 4. P0-4 · 统计口径与 UI 文案

### 4.1 `total_error_events` 查询范围：现有两处表述存在歧义

`【只读核实】`

- 1.2.3.1 §1.4 L126 伪码：`const total_error_events = errors.length  // 恒为 kind='error' 行数，与分类解耦`，但 `errors` **未定义来源**（是 `views.all('spellingErrorEvents')` 全表？还是 `whereIndex('owner', currentOwner)`？）。
- 1.2.2 U11：`total_error_events` = 历史错误事件行数，按 `(owner, word_id)` 聚合事件行数。
- 1.2.3 §4：`total_error_events` = 历史错误事件行数（文案「历史错误记录 N 条」）。

`【设计推导】` 三者可能给出**不同数字**：若 `errors` 走 owner 索引查询，则「与分类解耦」不成立（分类要读会话与 reset，可能来自别 owner 的行）；若走全表，则「历史」二字容易被误读为「全部历史记录」。

**待批准口径（D24，本报告不裁定）**：`total_error_events` = **当前 owner 视图内的 `kind='error'` 事件行数**，且必须与 `active_wrong_count` 取自**同一个 `readSnapshot`、同一份 `errors` 集合**，即 `total = errors.length`、`active = errors.filter(...)`。理由：两指标严格同域，避免「total 含别 owner、active 不含」的口径漂移；`classify` 只改变 `active`，不改变 `total`，与 1.2.3「统计不再等待 T-B」结论一致。

### 4.2 owner 过滤边界与「索引漏行」

`【只读核实】` `web.ts` L248-257：`whereIndex` 用 `this.table.where(field).equals(value).toArray()`，基于 IndexedDB 索引；`【只读核实】` `memory.ts` L151-163：`whereIndex` 是 `[...rows.values()].filter(r => r[field] === value).map(copy)`。

`【设计推导】` 由此产生的边界问题：

| 记录类型 | `whereIndex('owner', currentOwner)` 结果 | 处置要求 |
| --- | --- | --- |
| `owner` 合法且等于当前 owner | ✅ 命中，计入统计 | 正常 |
| `owner` 合法但属于其它 owner | ❌ 排除 | 正常隔离，**不报警** |
| `owner` 缺失 / `undefined` / 空串 / 非字符串 / `null` | ❌ **不命中索引，被静默排除** | **必须单独计数并提示**，不得当作不存在；禁止自动补 `guest` / 自动迁移 |
| `owner` 字段未建索引 | 两驱动都抛错（web L250-255 / memory L153-159）；且 F9 已证实两驱动索引白名单**本来就不一致** | 不得依赖索引查询作为统计路径 |

> 另有一个两驱动分叉：`【设计推导】` 当查询值本身为 `undefined` 时，memory 的 `r[field] === undefined` 会**匹配缺失字段的行**，而 Dexie 索引等值查询不会 → 同一段业务代码在两个驱动下得到不同行数。这使 `whereIndex` 更不适合作为统计口径的基石。

**推荐实现路径（待批准）**：`【设计提案】【需批准】` 在 `readSnapshot` 内用 `views.all('spellingErrorEvents')` 取**全表副本**，再由同步纯函数按 owner **三分区**：合法当前 owner → 进入 `errors`；合法其它 owner → 排除且不报警；非法 / 缺失 owner → 计入 `unindexed_count` 并提示「另有 N 条记录归属信息异常，未纳入统计」。如此两驱动一致（都基于全表副本 + 同一纯过滤），且异常不会被索引静默吞掉。

> 代价：全表读而非索引查询。本地事件表容量、聚合耗时、IndexedDB 配额**仍无实测**（U3 / U14，7–11 MB/年只是估算，不得引用为事实），须 T45 / C22 压测后再定是否加索引；**本轮不新增索引、不改 schema**。记为 **U24**。

### 4.3 三个计数必须区分

`【设计提案】【需批准】`

| 指标 | 定义 | 单位 | 说明 |
| --- | --- | --- | --- |
| `active_wrong_count` | `errors` 中 `classify ∈ {PENDING_CURRENT, SETTLED_ZEROED}` 的行数 | **事件条数** | 一个词错 3 次 = 3 条，不是 3 个词 |
| `total_error_events` | 同一 `errors` 集合的行数 | **事件条数** | 含 stale / covered / 异常类；与分类解耦 |
| `distinct_word_count` | `new Set(errors.map(E => E.word_id)).size` | **单词数** | 仅在同一 owner 视图内；用于「错词本涉及 N 个单词」 |
| `abnormal_counts` | 按原因码分组的异常行数 | **异常记录条数** | 是否含被 `COVERED` 遮蔽的异常，取决于 D22 裁定 |

**产品口径红线（用户已确认，逐字遵守）**：`【只读核实】`（沿用 Phase 1 产品决策）**每个真实错误字母计一个错误事件**。因此：
- 不得把同一词的多次错误合并成 1 条（合并去重是「错词本条目」的展示口径，不是事件计数口径）；
- 不得因重试 / 重复 drain / 分类重算 / reset 覆盖而**增加**事件行数（`event_id` 主键保证 `insertIfAbsent` 幂等）；
- 不得把 `abnormal_counts` 或 `distinct_word_count` 当作事件数展示。

### 4.4 UI 文案表（增补 D17 文案表，不改写旧条目）

`【设计提案】【需批准】`

| 场景 | 推荐文案 | 禁止文案 |
| --- | --- | --- |
| 活动错词徽标 / 重练 | 「待重练错词 N 条」 | 「错了 N 次」「N 个错词」（N 是事件数） |
| 历史统计 | 「**当前账号**的历史错误记录 N 条」 | 「**全部历史记录** N 条」「累计犯错 N 次」「历史犯错 N 次」 |
| 涉及单词 | 「涉及 N 个单词」 | 与事件数混用 |
| 归属异常 | 「另有 N 条记录归属信息异常，未纳入统计」 | 静默不显示 / 显示「暂无数据」 |
| 被 covered 的异常（若 D22 选 B/C） | 「另有 N 条历史记录存在数据异常（已移出错词本）」 | 「已全部同步」「数据正常」 |
| `total>0 && active=0` | 「有 N 条历史记录暂无法归类，数据可能不完整」+ 入口 | `EmptyState`「暂无错词」、写 0、假报同步 |

**硬约束**：`【设计推导】` 不得把「当前 owner 视图内查询到的行数」表述成「全部历史记录」。理由：① 其它 owner 的记录按隔离口径被排除；② 非法 / 缺失 owner 的记录不命中索引；③ 被 `clearAll()` 或历史清理移除的行已不存在；④ 备份恢复 / 部分成功状态下行数本身可能不完整。文案必须带「当前账号」限定，且异常计数如实单列。

### 4.5 新增测试设计（C99–C104 / T122–T127）

| # | 场景 | 断言要点 | 层级 |
| --- | --- | --- | --- |
| **C99/T122** | 两指标同域同快照 | `total = errors.length`、`active = errors.filter(...)`；同一次 `readSnapshot` 内计算；两次聚合 `total` 恒等行数（reset / 接管不改变 total） | `【待自动化】` |
| **C100/T123** | owner 三分区 | 合法当前 owner / 合法其它 owner / 非法（缺失、空串、非字符串、`null`）逐类断言：进入统计 / 排除且不报警 / 计入 `unindexed_count` 且提示；断言无自动补 `guest` | `【待自动化】` |
| **C101/T124** | 索引漏行 vs 全表快照 | 同一批数据分别走 `whereIndex('owner', x)` 与全表纯过滤，断言两者差异被记录、统计采用后者；`value=undefined` 时两驱动分叉被断言为已知差异而非静默一致性 | `【待自动化】` |
| **C102/T125** | 三数区分与文案 | 构造「1 个词错 3 次 + 2 个其它 owner 事件 + 1 个非法 owner 事件」；断言事件数 / 单词数 / 异常记录数互不串用；逐项核对 4.4 文案与禁用词 | `【待自动化】` + `【待真机】` |
| **C103/T126** | 产品口径回归 | 每敲错 1 个字母恰生成 1 个 `event_id` 事件；重复 drain / 重试 / 分类重算 / reset 覆盖**不增加**行数；断言 `insertIfAbsent` 幂等 | `【待自动化】` |
| **C104/T127** | 文案静态检查 | 全错词本相关 UI 文案不含「全部历史记录」「犯错 N 次」「累计错误次数」；`total>0 && active=0` 不渲染 `EmptyState` | `【待自动化】` |

---

## 5. 测试矩阵增量汇总

| 编号区间 | 来源 | 数量 | 状态 |
| --- | --- | --- | --- |
| C01–C82 / T01–T105 | Phase 1 ～ 1.2.3.1 | 82 / 105 | **全部保留，编号与结论原文不变** |
| **C83–C104 / T106–T127** | **本报告新增** | **22 / 22** | **新编号，不占用任何旧编号** |

按章节分布：第 1 章 C83–C87 / T106–T110（5）、第 2 章 C88–C90 / T111–T113（3）、第 3 章 C91–C98 / T114–T121（8）、第 4 章 C99–C104 / T122–T127（6）。

> 所有新增测试均为 `【待自动化】` / `【待真机】` **设计**，本轮**未执行任何一项**。

---

## 6. 新增 D 项与审批状态

| 项 | 内容 | 状态 |
| --- | --- | --- |
| D1–D17、D18、D19、D20 | 沿用 1.2.3.1 第 5 章全表 | **状态一律不变**（待批准 / 待确认 / 需批准 / 阻塞中） |
| **D21（新增）** | 全局清除破坏范围：错词本页**不得**挂载 `clearAll()`；四个非破坏性恢复入口；全局清除须独立入口 + 独立授权 + 20 表影响清单 + 如实说明；不新增局部清除 API | **需批准** |
| **D22（新增）** | `COVERED` 与异常分类优先级：选项 A/B/C 取舍；是否拆双轴；`abnormal_counts` 口径；covered 证据合法性门 | **需批准**（本报告不自行裁定） |
| **D23（新增）** | `readSnapshot` 可执行契约：运行时 thenable 检测与六条边界、同步纯函数约束的证明边界、memory `rows` 内部访问与深/浅拷贝、错误传播 / 事务中断 / 返回值不可变性 | **需批准** |
| **D24（新增）** | `total_error_events` 查询范围与 owner 三分区、全表快照过滤路径、三数区分、UI 文案限定词与禁用词 | **需批准** |

> **补充报告 ≠ 批准**。新增 D21–D24 与既有 D1–D20、Q2 / Q11 / Q12 **无一被标记为已批准 / 已确认 / 已解除**。若 D21 获批，1.2.3.1 §3.3 的「重新清除本地数据」入口在**实施范围**上按 D21 收窄，旧编号结论仍保留在案。

---

## 7. 未解决问题增量

| 编号 | 问题 | 影响 | 状态 |
| --- | --- | --- | --- |
| U1–U21 | 沿用 1.2.3.1 第 6 章 | —— | 状态不变 |
| **U22（新增）** | `clearAll()` 两驱动破坏范围分叉（web 固定 20 表 / memory 仅已实例化表），且两驱动 `INDEXED_FIELDS` 白名单本身不一致（F8 / F9） | memory 单测无法复现 web 的全局清除与索引行为；统计若依赖 `whereIndex` 会在两驱动下给出不同结果 | `【只读核实】` + `【需批准】`（是否统一，属并行改动文件，受 G9 管辖） |
| **U23（新增）** | `covered` 证据本身无合法性门，`scope` 含 owner 但跨 owner / 非法 reset 行的过滤判据未定义 | 隔离破坏可能被一次 reset 静默覆盖并永久消失 | `【需批准】` D22 + C89/T112 |
| **U24（新增）** | 全表快照过滤路径的性能 / 容量 / IndexedDB 配额无实测；7–11 MB/年仍为**估算** | 不能以「全表读」为既定结论，也不能引用估算为事实 | `【待真机】` T45 / C22 |
| **U25（新增）** | thenable 检测与 TS 类型都**不能证明** reader 内无未等待的异步副作用（L4/L5） | 需在 lint / 代码审查 / 探针测试之外明确接受残余风险，不得声称「已保证同步」 | `【设计推导】` + `【需批准】` D23 |
| **U26（新增）** | 非法 / 缺失 owner 的记录无法被索引查询命中，若不额外全表读就**根本不知道其存在** | 「另有 N 条异常」可能算不出来；口径漂移 | `【需批准】` D24 + C101/T124 |

---

## 8. 准入状态、保护自检与剩余阻塞项

### 8.1 准入状态

> **未获准入。** G9 / D9 仍为**阻塞中**：未取得并行架构负责人对 v12 / v13 的书面协调结果，V1.2.7 D3 仍「待裁定」；本轮**未决定 Dexie version、未解除 G9、未修改 `stores()` / schema / 表 / 索引**。全部 D / Q 项保持待批准 / 待确认 / 需批准，无一被标为已批准。

### 8.2 保护范围自检

| 约束 | 是否遵守 | 说明 |
| --- | --- | --- |
| 不修改源码 / 配置 / 数据库 / 迁移 | 是 | 全程 Read / Grep / Glob，无 Edit / Write 到 `src/` |
| 不修改 Git 暂存区 / 工作区已有文件 | 是 | 本轮未执行 git 写操作；**未重新执行 git 状态命令**以避免刷新索引；基线沿用前轮记录 |
| 不覆盖 `App.tsx` / `web.ts` / `domain/types.ts` / `memory.ts` 等并行改动 | 是 | 仅只读 |
| 不修改前提卡 | 是 | 未触 |
| 不运行会写工作区的验证 | 是 | 未跑 `tsc --noEmit` / `npm test` / `npm run build` / `check_pwa.py` |
| 只新增一份报告 + 追加日志 | 是 | 本报告为唯一新增文档 |
| 保留 C01–C82 / T01–T105 | 是 | 新增自 C83 / T106 起 |
| 不自行裁定产品语义 | 是 | 第 2 章三选项并列，仅给「设计倾向」并明确非裁定；全部归入 D22 |
| 不新增局部清除 API、不实施清除 | 是 | 1.4 明确不做，D21 仅为 UI / 授权设计约束 |
| G9 仍阻塞、不决定 version、不改 stores/schema | 是 | 见 8.1 / 3.3 / 4.2 |

### 8.3 剩余阻塞项（按优先级）

| # | 阻塞项 | 类型 | 解除条件 |
| --- | --- | --- | --- |
| B1 | **G9 / D9**：v12、v13 均被并行任务规划，D3 待裁定、门禁未通过 | **外部依赖，最高优先** | 并行架构负责人书面回复 1.2.2 §6.4 的 5 条验收标准并留痕 |
| B2 | **D21**：错词本页禁用全局清除、非破坏性恢复入口 | 产品 + 设计裁定 | 批准 1.4 / 1.5；确认是否收窄 1.2.3.1 §3.3 适用范围 |
| B3 | **D22**：`COVERED` 优先级 / 双轴分类 / covered 证据门 | 产品裁定 | 从 A/B/C 中明确选定，并裁定 `abnormal_counts` 口径 |
| B4 | **D23**：`readSnapshot` 可执行契约 | 设计裁定 | 批准 3.1–3.3；确认 thenable 检测边界与残余风险接受条件 |
| B5 | **D24**：统计口径 / owner 三分区 / 文案 | 产品 + 设计裁定 | 批准 4.1–4.4；确认全表快照路径与 U24 压测前置 |
| B6 | D1 / D2 / D4 / D10–D20 既有裁定集 | 设计裁定 | 逐项批准（沿用 1.2.3.1 B2–B6） |
| B7 | 所有 P0 证明仍为 `【设计推导】` | 验证 | C83–C104 / T106–T127 自动化 + 真机双标签 / Chromium+Firefox 矩阵 |
| B8 | U18 / U19 / U22–U26：升级窗口一致性、混合快照、两驱动分叉、异步副作用残余风险、索引漏行 | 验证 | C74–C77 / C87 / C91–C92 / C101 等真机与自动化 |
| B9 | 容量 / 聚合性能 / IndexedDB 配额无实测（U3 / U14 / U24） | 验证 | T45 / C22 压测；**7–11 MB/年仍为估算，不得引用为事实** |

### 8.4 实施前置条件（累积）

1. B1 G9 关闭并取得书面版本协调结论；
2. D21–D24 与 B6 全部裁定完成；
3. C83–C104 / T106–T127 自动化用例落地并通过；
4. 真机双标签 / 升级窗口 / IndexedDB 配额矩阵通过（含 U24 容量实测）；
5. 三份并行改动文件（`types.ts` / `web.ts` / `memory.ts`）按 G9 验收第 5 条确定合并顺序与冲突解决人；
6. 前提卡红线复核（绝不编造数据、空数据才走 `EmptyState`、已写好代码不顺手改）。

### 8.5 本轮未执行的验证（如实列出）

- 未运行 `npx tsc --noEmit`、`npm test`、`npm run build`、`python scripts/check_pwa.py`；`npm run build` 会写 `dist/`，与本轮「不写工作区」约束冲突。
- 未执行任何 `clearAll()`、`db.transaction`、Dexie 版本升级或数据库迁移；未打开真实 IndexedDB。
- 未执行 C01–C104 / T01–T127 中任何一项测试；未做真机双标签验证。
- 未重新执行 `git status` 等可能刷新索引的命令；Git 基线沿用前轮只读记录。
- 未向并行架构负责人发送协调请求，未取得任何新的 v12 / v13 书面结论。
- 本报告的全部设计证明为 `【设计推导】`，在 B7 / B8 验证完成前，不得声称「清除边界已闭合」「COVERED 优先级已解决」「readSnapshot 契约可执行」「统计口径已一致」。

---

> **已停止。** 本报告完成后不进入源码实施，不进入迁移，不解除 G9，等待负责人审阅与裁定。
