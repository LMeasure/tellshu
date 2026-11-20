# Tellshu 单词默写 V2 · Phase 1.2.3.5 · 内部访问路径与测试可控性补充审查

> **本轮性质**：纯设计、只读审查。**不实施源码，不迁移数据库，不修改 Git 暂存区 / 工作区已有文件，不覆盖并行 Agent 改动，不修改前提卡，不修改 Dexie version / `stores()` / schema / 表 / 索引，不解除 G9，不实施清除，不新增局部清除 API，不新增源码 API / 源码类型，不执行测试。**
> **交付物**：仅新增本报告 + 按保护流程追加一条工作日志。完成后停止，等待负责人审阅。

---

## 0. 承接关系、基线与证据标注

### 0.1 承接范围

本报告**只审查用户点名的三项**：

| 序 | 问题 | 对应既有裁定 / 编号 | 本报告章节 |
| --- | --- | --- | --- |
| 1 | memory 快照内部访问路径（新增问题） | U32 / 1.2.3.4 §3.2 伪代码 / 1.2.3.2 §3.2 | 第 1 章 |
| 2 | Promise 与 thenable 契约精确化 | C125·T148 / C130·T153 / D26 / D28 | 第 2 章 |
| 3 | memory 拷贝能力与测试可控性 | U32 / U35 / K1–K4 / D30 / C134–C136 | 第 3 章 |

C01–C136 / T01–T159、D1–D30、U1–U36、B1–B12 的**编号、原结论与原状态全部保留**，不重编号、不改写旧报告。本轮新增编号从 **C137 / T160**、**D31**、**U37** 起。

### 0.2 基线（沿用前轮只读记录）

| 项 | 状态 | 证据等级 |
| --- | --- | --- |
| Git HEAD | `760e999`；暂存区 6 个 `A`（B12 系列）未变；工作区存在并行 Agent 改动 | `【只读核实】`（沿用；**本轮未执行任何 git 命令**） |
| 源码最高 Dexie 版本 | `version(11)` | `【只读核实】`（沿用） |
| **G9 / D9 复核** | V1.2.7 **L402「D3 \| B7 \| Dexie v12/v13 前进式升级 + `blocked`/`versionchange` 处理 \| 待裁定」**、L408 门禁结论仍是「暂不进入阶段 1B」；全仓检索未见任何针对本任务的版本协调结论 | `【只读核实】`（本轮 Grep）→ **G9 仍阻塞** |
| 设计态能力零落地 | `src/` Grep `snapshotRows｜buildViewsSync｜readSnapshot｜Object.freeze｜deepFreeze` → **零匹配**（沿用 1.2.3.4 M8 并本轮复核） | `【只读核实】` |

### 0.3 五类证据标注（沿用）

`【只读核实】` = 逐行读到的源码 / 文档事实；`【设计推导】` = 由事实推出的逻辑结论，未实测；`【待自动化】` = 需单测 / 集成测试；`【待真机】` = 需真实浏览器 / Worker / SW / Node 运行时；`【需批准】` = 产品语义或设计取舍，本报告不自行裁定。

### 0.4 决策来源与「既有事实 / 新增提案」分级

| 类别 | 内容 |
| --- | --- |
| **用户已决定** | 本轮保护约束（纯设计只读、只新增一份报告 + 一条日志、不实施源码、不解除 G9、不把 Agent 建议写成用户批准、保留旧编号）；本轮三项审查范围；Phase 1 三项产品决策；清除边界硬约束；G9 继续阻塞 |
| **既有事实（只读核实）** | `rows` 为 private、`memoryStorage` 门面不能直接访问、`readSnapshot`/`buildViewsSync` 零落地、`canClone` 是模块级常量、测试框架为 `tsx` 脚本且无 Vitest/Jest、项目已有动态 import 打桩模式（详见各章 F 表） |
| **既有设计提案（状态不变）** | D1–D30 全部；O1/O2/O3、K1–K4、C1–C7 / G1–G7 / N1–N7、1.2.3.4 §3.2 最小伪代码、1.2.3.2 §3.2 五条拷贝契约要点 |
| **本轮新增设计提案（待批准）** | 第 1 章 P1/P2/P3a–P3e 访问路径候选、第 2 章契约精确化条款、第 3 章 T-A–T-F 测试方案比较；归 **D31 / D32 / D33** |

> **本报告未把任何 Agent 建议写成用户已批准**；用户本轮未对 O1/O2/O3、K1–K4 或任何 D 项作出裁定。

---

## 1. P0-1 · memory 快照内部访问路径

### 1.1 现状只读核实：封装边界清单

| # | 事实 | 位置 | 标注 |
| --- | --- | --- | --- |
| F1 | `MemoryTableService.rows` 是 `private readonly Map<string\|number, T>`；`memoryStorage` 门面**无法直接访问** | `memory.ts` L89-91 | `【只读核实】` |
| F2 | `tables` 是模块级 `Map<TableName, MemoryTableService<...>>`；`tableOf(name)` 是模块级**非导出**函数 | `memory.ts` L187-199 | `【只读核实】` |
| F3 | 唯一导出是 `memoryStorage` 对象，成员仅 `driver` / `table(name)` / `open()` / `clearAll()` | `memory.ts` L201-215 | `【只读核实】` |
| F4 | `TableService` 公开接口只有单表 CRUD + `whereIndex` / `whereStartsWith` / `clear`，**无快照方法** | `types.ts` L21-43 | `【只读核实】` |
| F5 | `StorageService` 门面只有 `driver` / `table` / `open` / `clearAll` | `types.ts` L45-53 | `【只读核实】` |
| F6 | `src/` Grep 快照 / 冻结相关标识符 → **零匹配**；`readSnapshot` 及任何内部快照副本实现源码零落地 | 本轮 Grep | `【只读核实】` |
| F7 | `src/services/storage/index.ts` 顶层**静态 import** `web.ts` 与 `memory.ts`，两个实现都会在加载时被求值 | `index.ts` L13-14 | `【只读核实】` |
| F8 | 1.2.3.4 §3.2 伪代码写 `views = buildViewsSync(tables)`，并注明「直接读内部快照副本，禁止 `await toArray()/get()`」 | 1.2.3.4 §3.2 L270-277 | `【只读核实】` |

### 1.2 前提缺口 U37：伪代码要求了一个当前不存在的合法读取点

`【设计推导】` 由 F1–F8 直接得出：

- 门面（F3）拿不到 `rows`（F1）；
- 公开 `TableService`（F4）没有任何快照 / 同步取全表副本的方法；
- `memoryStorage.table(name)` 返回的 `TableService` 只暴露 `toArray(): Promise<T[]>` 等异步方法；
- 模块级 `tableOf()`（F2）非导出，**门面实现所在的同一模块内**虽可调用，但 `rows` 仍是 private；
- `readSnapshot` / `buildViewsSync`（F6）零落地。

因此 **1.2.3.4 §3.2 的伪代码隐含了一个未声明前提：`buildViewsSync` 能以某种合法方式取到内部只读副本**。当前源码**不存在**这个读取点。该前提缺口登记为 **U37**；在 D31 裁定前，不得把伪代码表述为「可直接落地」。

### 1.3 先排除：用既有公开 API 组合（P3c）不可行

`【只读核实】` + `【设计推导】` 四条理由：

| # | 理由 | 依据 |
| --- | --- | --- |
| 1 | `table(name).toArray()` 返回 `Promise<T[]>`；不 `await` 拿不到值，`await` 会让出微任务队列 → 违反 1.2.3.4 P3「同步快照段不得引入 await / 微任务让出」 | `types.ts` L27；`memory.ts` L129-131 |
| 2 | `toArray()` 内部就是 `Promise.resolve(<同步求值>)`，即使不同步等待也无法从 Promise 中同步取值 | `memory.ts` L129-131 |
| 3 | `canClone=false` 时 `toArray()` 经 `copy()` 返回**原引用** → 违反只读副本契约（U32） | `memory.ts` L98-101 / L190 |
| 4 | `structuredClone` 抛 `DataCloneError` 时该写法**同步抛**而非 rejected Promise → 违反 P1/P2（U35） | `memory.ts` L103-105 / L129-131 |

> 结论：`【设计推导】` 既有公开 API 组合**不是合法访问路径**；这正是必须新增内部读取点的原因，也说明 U37 不是文字疏漏而是结构性缺口。

### 1.4 候选 P1：表实例内部受控快照方法

`【设计提案】【需批准】` 在 `MemoryTableService` 类内新增一个**内部**方法（如 `snapshotRows(): readonly T[]`），返回新数组 + 每行副本；`buildViewsSync` 通过 `tableOf(name)` 取实例后调用。

| 维度 | 评估 |
| --- | --- |
| 封装边界 | 方法在类内部可读 `rows`；只返回**新数组 + 行副本**，不返回 `Map`、迭代器、`rows.values()` 原数组、也不返回 `this.rows` 本身 |
| 引用泄漏风险 | **取决于实现**：若沿用 `copy()` 且 `canClone=false`，仍会把原引用交给 reader（U32 未闭合）；必须强制深拷贝或按 K1 拒绝服务。`readonly T[]` 只是 TS 类型，运行时不冻结（F6），需每次新副本 |
| 同步语义 | 纯同步、无 `await` → 满足 P3；调用链 `memoryStorage.readSnapshot` → `tableOf(name)` → `snapshotRows()` 全程同步 |
| 与 Dexie 一致性 | Dexie `toArray()` 天然返回结构化克隆副本；P1 可通过「强制深拷贝 + `DataCloneError` 统一为 `SnapshotError`」对齐，但两驱动的克隆失败传播需单独对齐（U35） |
| 对 `memory.ts` 并行改动影响 | 新增**类内部方法**（非 `TableService` 公开 API、不改 schema / 表 / 索引）；但落在并行改动文件，受 **G9 验收第 5 条**合并顺序与冲突解决人管辖 |
| 风险 | 方法一旦对门面可见，未来可能被误当公开 API 复用；需明确「内部专用」约束与测试 |

### 1.5 候选 P2：memory 驱动内部受控接口（回调式）

`【设计提案】【需批准】` 在模块级新增一个内部函数（如 `withSnapshotSync(tables, build, reader)`），由 `memoryStorage.readSnapshot` 调用；视图只在回调栈内存在，回调结束后丢弃。

| 维度 | 评估 |
| --- | --- |
| 封装边界 | **最强**：调用方拿不到持久视图引用；便于落实 1.2.3.3 C4「`views` 不缓存、不复用、不跨调用泄漏」；也可在模块内对 `reader` 返回值一并复制 / 冻结，缓解「`T` 引用 `views`」泄漏 |
| 引用泄漏风险 | 仍需内部强制深拷贝，否则与 P1 同样受 U32 影响；但回调式可在模块内统一收口拷贝策略与失败丢弃 |
| 同步语义 | 整段同步；与 Dexie 的 `db.transaction('r', tables, callback)` **结构对称**，两驱动 `readSnapshot` 签名与生命周期更容易对齐 |
| 与 Dexie 一致性 | 结构上最易对齐；但 Dexie 回调是 `async`（需 `await buildViews`），memory 回调必须严格同步 → 两侧回调签名不能字面相同，需在门面层统一 |
| 对 `memory.ts` 并行改动影响 | 模块级内部函数 + 门面方法，改动面**略大于 P1**，仍单文件、受 G9 管辖 |
| 风险 | 回调式要求 `reader` 在同步段内执行；实现若不慎混入 `await` 会破坏 P3，需 lint / C131·T154 类静态检查约束 |

### 1.6 其它「不暴露原始 Map / 行引用」的方案

`【设计提案】【需批准】` 列出但不穷尽：

| 候选 | 做法 | 评估 |
| --- | --- | --- |
| **P3a 影子快照** | 模块内维护一份与 `rows` 同步的只读影子副本，写入时重建 / 更新；视图只读影子 | 封装强，但**双份内存 + 写放大**，且须改 `put`/`add`/`bulkPut`/`delete`/`clear` 全部写入路径（改动面最大）；影子与 `rows` 一致性需额外保证，与「已写好代码不顺手改」红线张力大 |
| **P3b 序列化屏障** | 整体 `structuredClone([...rows.values()])` 作为拷贝策略 | **不是独立访问路径**：仍需 P1/P2 提供读取点，只是拷贝策略不同；`structuredClone` 缺失 / 抛错时回落 K1–K4 |
| **P3c 既有公开 API 组合** | `table(name).toArray()` 等 | **不可行**，见 1.3 |
| **P3d 下沉到表服务层** | 把 `readSnapshot` 挂到 `TableService` | **不可行**：跨表快照需同时看多张表，单表服务无此能力（1.2.3.1 §2.3(a) 已论证） |
| **P3e WeakMap 私有桥接** | 把 `rows` 移到模块级 `WeakMap<MemoryTableService, Map>`，避免在类上加方法 | 封装略强，但 TS `private` 运行时本就是普通属性，**无实质安全收益**；可读性下降，改动面不小于 P1 |

### 1.7 六维比较表

`【设计推导】`

| 维度 | P1 表实例方法 | P2 驱动内部回调 | P3a 影子快照 | P3e WeakMap |
| --- | --- | --- | --- | --- |
| 封装边界 | 中（类内方法） | **强**（视图仅在回调栈） | 强 | 中偏强 |
| 引用泄漏风险 | 取决于拷贝策略 | 取决于拷贝策略，但收口更集中 | 取决于影子拷贝 | 同 P1 |
| 同步语义 | 同步 ✅ | 同步 ✅ | 同步 ✅（写入侧变重） | 同步 ✅ |
| 与 Dexie 一致性 | 需对齐克隆失败传播 | 结构最对称，签名需门面统一 | 语义偏离（多一份状态） | 同 P1 |
| 对 `memory.ts` 改动面 | 小（类内一方法） | 中（模块函数 + 门面） | **大**（全部写入路径） | 中（rows 存储方式重写） |
| 测试可控性 | 需能触达类实例 | 需能触达模块级函数 | 需验证影子一致性 | 需能触达 WeakMap |
| 共同前提 | **U32 未闭合**：`canClone=false` / `DataCloneError` 处理未定（K1–K4 待批准） | 同 | 同 | 同 |

> `【设计推导】` 无论选哪个候选，**都绕不开 U32**：拷贝策略（K1–K4）与内部读取点是两个正交问题，选定访问路径不等于闭合拷贝语义。

### 1.8 不选定方案、归 D31

`【需批准】` 用户明确要求「不得自行选定方案」，故本报告**只比较、不推荐、不裁定**，全部归 **D31**。补充两条边界：

- 所有候选都落在 `memory.ts`（并行改动文件）→ 实施须 **G9 关闭后**按验收第 5 条确定合并顺序与冲突解决人；本轮不改任何文件。
- 所有候选均**不新增 `TableService` 公开 API、不新增表 / 索引 / schema、不触发版本升级**；但「新增源码 API」这一动作本身需 D31 批准，本轮**不新增**。

### 1.9 新增测试设计（C137–C140 / T160–T163）

| # | 场景 | 断言要点 | 层级 |
| --- | --- | --- | --- |
| **C137/T160** | P3c 不可行回归 | 断言通过 `toArray()/get()` 构造视图必然引入 `await` 或 `Promise.resolve` 求值；`canClone=false` 时返回原引用；`DataCloneError` 时同步抛；记录为排除依据 | `【待自动化】` |
| **C138/T161** | P1 封装与泄漏 | 按选定候选（未批准前不断言具体形态）：断言视图不返回原始 `Map` / 迭代器 / `rows` 引用；`canClone=false` 下 reader 修改不污染 `rows`；深拷贝或 K1 拒绝服务二选一由 D30/D31 决定 | `【待自动化】` |
| **C139/T162** | P2 同步段与视图生命周期 | 断言回调期间无 `await` / 微任务让出；回调结束后视图不可再被引用；快照失败后二次调用得到全新视图、无上次引用（联动 C136/T159） | `【待自动化】` |
| **C140/T163** | 两驱动一致性与改动面静态核对 | 断言两驱动 `readSnapshot` 对外签名 / 错误字段一致；静态检查未新增 `TableService` 公开方法、未改 `stores()` / schema / 索引；记录 `memory.ts` 改动行范围供 G9 合并顺序使用 | `【待自动化】` |

---

## 2. P0-2 · Promise 与 thenable 契约精确化

### 2.1 C130 补充：不应只依赖 `instanceof Promise`

`【只读核实】` 1.2.3.4 §3.6 L340 的 C130/T153 原文断言 `readSnapshot(...) instanceof Promise`。

`【设计推导】` 该判据的漏检面：跨 realm（iframe / Worker / Service Worker）的 Promise 不是当前 realm 的 `Promise` 实例；`Object.create(Promise.prototype)`、自定义 thenable、Proxy 包装、子类实例亦可能不通过或误通过。**精确化要点**：

| # | 补充断言 | 说明 |
| --- | --- | --- |
| A1 | **awaitability 判据** | 用 `typeof (p as { then?: unknown })?.then === 'function'`（thenable 定义）判断「可 await」，而非 `instanceof Promise` |
| A2 | **同步 throw 转 rejection** | `let p; let syncThrew = false; try { p = readSnapshot(...) } catch { syncThrew = true }` → 断言 `syncThrew === false`，再断言 `await p` 进入 rejection 分支且错误为 `SnapshotError` |
| A3 | **错误类型与字段一致** | `phase` / `reason` / `driver` / `requestId` /（规范化后的）`code` 与 `message` 两驱动一致；UI 只见规范化结构、无堆栈；日志不含行内容与隐私（联动 C113/T136、C129/T152） |
| A4 | **五路径逐项覆盖** | 参数非法 / `tables` 越界 / `buildViewsSync` 抛错 / `reader` 抛错 / `assertNotThenable` 抛错，每条都要过 A1–A3 |

> **方向必须区分**`【设计推导】`：`assertNotThenable` 要求 **reader 的返回值不得是 thenable**；`readSnapshot` 的**返回值必须是 Promise / thenable**。两者判据方向相反，测试不得混用同一辅助函数，否则会写出自我矛盾的断言。旧 C130 原文保留，补充由 C141/T164 覆盖。

### 2.2 C125 精确化：环境矩阵，而非「一律必然无事件」

`【只读核实】` 1.2.3.4 §1.8 L142 的 C125/T148 原文写「断言 M1–M9 逐项……**不产生**可依赖的观测」。

`【设计推导】` 用户本轮指出：M1–M9 是「**在指定环境下监控不能提供完整覆盖保证**」，不是「所有环境必然无事件」。逐项给出正确的期望：

| 项 | 1.2.3.4 场景 | 精确化后的期望（允许出现事件，但不可作为保证） |
| --- | --- | --- |
| M1 | 自定义 thenable | 自身不触发；若内部包了未处理的**原生 Promise** 并 reject，该 Promise **会**触发事件 → 断言「不能依赖自定义 thenable 本身被观测」 |
| M2 | 跨 realm / iframe / Worker / SW | **主页面**监听收不到；该 realm 自带监听器**会**收到 → 断言「主页面不是统一观测点」 |
| M3 | 页面卸载 / 导航 / SW 终止 | 可能丢失，不保证发生；断言「存在不可观测窗口」 |
| M4 | Node `--unhandled-rejections=none` | `none` 静默；`warn` 会打印；`throw` 会致命 → **依配置**，断言按模式分别记录 |
| M5 | reader 自身已 `.catch` | 该链不触发；同一 reader 启动的其它未处理链**仍可能**触发 |
| M6 | 监听器晚注册 | 该次不触发；后续 rejection 可能触发 |
| M7 | 同步抛异常 | 走 `error` / `uncaughtException`，**不是 rejection 事件**（但仍有其它类型事件） |
| M8 | 测试框架接管 | 可能触发，但语义被改写（转测试失败 / 被吞）→ 不能外推生产 |
| M9 | 多监听器拦截 | 取决于注册顺序与 `stopImmediatePropagation` |

**结论**`【需批准】`：C125 的断言应改为「**在指定环境 / 配置下，验证监控不能提供完整覆盖保证**」，形式改为「环境矩阵 × 实际观测结果 × 是否可作为保证」三列；**允许**断言中出现事件，但任何一次观测都**不得**被写成「Promise 已安全处理」（呼应 D28 §1.6）。旧 C125 原文保留，精确化由 C142/T165 覆盖。

### 2.3 `assertNotThenable`：读取次数、阶段分离与不调用 `then`

`【只读核实】` 1.2.3.2 §3.1 L201-212 骨架：`then = (value as { then?: unknown } | null)?.then` 是**一次**属性读取；`typeof then === 'function'` 只判断、不调用。

`【设计提案】【需批准】` 可执行契约：

| # | 条款 | 理由 |
| --- | --- | --- |
| B1 | 检测阶段**最多一次**属性读取 | 两次读取会让 Proxy `get` trap 按次数返回不同值（先非函数绕过、后函数命中），行为不可预测（U28 / U40） |
| B2 | **不调用 `then`**、不 `Promise.resolve(value)`、不构造任何 Promise | 调用 `then` 会触发 assimilation 与用户代码副作用；`Promise.resolve` 本身就会读取并调用 `then` |
| B3 | O2/O3 的「挂 no-op rejection handler」必须作为**独立阶段**（`discard` / `finalize`），与 `assert` 分离，单独记 `phase` 与原因码 | 否则同一次处理中读取次数从 1 变 2+，且与 `THEN_HANDLER_THREW` 混淆（U40） |
| B4 | 原型污染处理须二选一并固定 | 一次读取沿原型链，`Object.prototype.then` 可致误报；改读自有属性则 `getOwnPropertyDescriptor` trap 又是一次带副作用的交互 → 两难，标 `【需批准】` |
| B5 | 检测阶段抛错统一归 `THEN_PROBE_FAILED`（建议名，旧 `THEN_READ_FAILED` 不改写）契约违反，保留 `cause`，日志不记 `value` 内容 | 与 1.2.3.4 §2.3 的歧义检查衔接 |

### 2.4 `then` getter / Proxy trap 的异常传播与可能副作用

`【设计推导】`（沿用 1.2.3.3 S3/S4、1.2.3.4 U28，本轮补「次数 / 阶段」）

| 情形 | 后果 | 契约要求 |
| --- | --- | --- |
| getter / trap **抛错** | 检测阶段异常 | 归契约违反（B5），**不得**当成 reader 结果错误或静默放行；`cause` 传给 `toSnapshotError` |
| getter / trap **有副作用** | 写全局、发请求、改计数、递增版本号、返回不同值绕过检测 | 承认检测本身执行用户代码；写入「不保证」清单（N4/N5）；不得声称「检测过程无副作用」 |
| getter 返回非函数 | 检测放行，但对象内部仍可能藏 Promise（L2 / S6） | 归入不保证清单，不写成「检测成功」 |
| `Object.prototype.then` 污染 | 普通对象误判为 thenable → 误报 | 按 B4 选定的自有属性策略处理并记录误报用例 |

### 2.5 `toSnapshotError` 自身抛错是否会逃出统一错误类型（U38）

`【只读核实】` 1.2.3.4 §3.2 伪代码：`catch (e) { throw toSnapshotError(e, { phase: 'buildViews', driver: 'memory' }) }`。

`【设计推导】` `toSnapshotError(e)` 是 `throw` 的**操作数，先求值**；若它自己抛错，抛出的就是**非 `SnapshotError`** 的对象：

| 触发条件（举例） | 后果 |
| --- | --- |
| `e` 是 Proxy，访问 `e.message` / `e.stack` 触发 trap 抛错 | 归一失败 |
| `e.message` 是抛错的 getter | 归一失败 |
| `cause` 循环引用 / 不可克隆，实现尝试深拷贝 | 归一失败 |
| `requestId` 生成失败、`super(message, options)` 对非法 options 抛错 | 归一失败 |

在 `async` 函数内，它仍会变成 rejected Promise（「恒返回 Promise」侥幸成立），但**错误类型与字段不一致** → 1.2.3.3 C6、G1、G4 全部失效；若抛出的还是 thenable，全局处理器可能误判。**结论：`toSnapshotError` 是统一错误契约的关键依赖，登记 U38。**

`【设计提案】【需批准】` 明确契约：

1. **总函数（total function）**：对任意输入（`null` / `undefined` / 原始值 / Proxy / 抛 getter 的对象 / 循环引用 / thenable / `Symbol`）都返回一个 `SnapshotError` 实例，**永不抛错**。
2. **实现约束**：不直接访问 `e.message` / `e.stack`（用安全降级或内层 `try/catch`）；不深拷贝 `cause`；不调用用户提供的任何方法；`requestId` 由外部注入或安全生成，失败用**内部固定占位常量**（仅诊断，不展示给用户，不编造业务数据）。
3. **兜底**：最坏情况返回 `reason: 'ERROR_NORMALIZATION_FAILED'` 的 `SnapshotError`（**建议新增 reason，待批准；不新增源码类型**）。
4. **日志边界**：不记 `cause` 内容、不记原始错误对象、不记行内容 / 隐私。
5. **验收条件**：C145/T168 通过前，不得声称「错误类型已统一」。

### 2.6 新增测试设计（C141–C145 / T164–T168）

| # | 场景 | 断言要点 | 层级 |
| --- | --- | --- | --- |
| **C141/T164** | C130 精确化 | 五路径 × A1–A4：用 awaitability 而非 `instanceof Promise`；断言无同步抛、rejection 为 `SnapshotError`、字段两驱动一致；跨 realm Promise 通过；断言检测方向与返回方向未混用 | `【待自动化】` |
| **C142/T165** | C125 环境矩阵 | M1–M9 逐项记录「环境 / 实际观测 / 是否可作为保证」；断言**允许**出现事件但不得被写成「已安全处理」；断言不存在「所有环境必然无事件」的布尔断言 | `【待自动化】` + `【待真机】` |
| **C143/T166** | 检测读取次数与阶段 | 计数 Proxy `get` trap：断言检测阶段 `then` 读取恰 1 次、`then` 未被调用；O2/O3 的 handler 挂接发生在独立阶段且单独记 phase；`Object.prototype.then` 污染按 B4 选定策略断言 | `【待自动化】` |
| **C144/T167** | getter / trap 异常与副作用 | getter 抛错 / 有副作用 / 返回非函数 / Proxy 按次数变化：断言归 `THEN_PROBE_FAILED` 契约违反、保留 `cause`、日志不含 `value` 内容；已知绕过记为限制 | `【待自动化】` |
| **C145/T168** | `toSnapshotError` 总函数 | 注入 `null` / 原始值 / 抛 getter / Proxy / 循环引用 / thenable / `Symbol` 作为 `cause`：断言恒返回 `SnapshotError`、字段齐全、无同步抛、日志不含内容；断言 `ERROR_NORMALIZATION_FAILED` 兜底可达 | `【待自动化】` |

---

## 3. P0-3 · memory 拷贝能力与测试可控性

### 3.1 只读核实：`canClone` 与测试框架

| # | 事实 | 位置 | 标注 |
| --- | --- | --- | --- |
| G1 | `const canClone = typeof structuredClone === 'function'` —— **模块级常量，模块加载时求值一次**；注释「structuredClone 在 Node 18+ / 所有现代浏览器都有；缺失则退化为引用共享」 | `memory.ts` L189-190 | `【只读核实】` |
| G2 | `tableOf(name)` 在表首次实例化时把 `canClone` 作为 `clone` 构造参数固化；`tables` 是模块级 Map，跨用例共享 | `memory.ts` L192-199 | `【只读核实】` |
| G3 | `copy(row)` 用 `this.clone`，运行期不再读全局 | `memory.ts` L98-101 | `【只读核实】` |
| G4 | `index.ts` 顶层静态 import `web.ts` 与 `memory.ts`，两实现加载时即被求值 | `index.ts` L13-14 | `【只读核实】` |
| G5 | `package.json` 的 `test` = 26 个 `tsx scripts/test_*.ts` 脚本；`devDependencies` **无 vitest / jest**；Glob `vitest｜jest｜playwright.config.*` → **零匹配** | `package.json` L11 / L45-59；本轮 Glob | `【只读核实】` |
| G6 | `scripts/test_storage.ts` 顶层静态 import `storage`，手写 `assert()` / `expectReject()`，无 mock 框架 / 模块重置 API | `test_storage.ts` L11-45 | `【只读核实】` |
| G7 | 项目**已有**全局打桩 + 动态 import 模式：`check_vocab_senses_ui.ts` L26-33 用 `Object.defineProperty(globalThis, key, { configurable: true, writable: true })`；L142-149 注释「依赖按序加载（fake-indexeddb 先于 storage）」并 `await import('fake-indexeddb/auto')` 后才 `await import('../src/services/storage')` | `check_vocab_senses_ui.ts` | `【只读核实】` |
| G8 | `@types/node ^20.14.0` → 测试运行在 Node 20；`memory.ts` L189 自述现代浏览器均支持 `structuredClone` | `package.json` L46 / `memory.ts` L189 | `【只读核实】` |

### 3.2 三种目标状态与默认漏测风险（U39）

`【设计推导】`

| 状态 | `structuredClone` | `canClone` | `copy()` 行为 | 默认测试是否覆盖 |
| --- | --- | --- | --- | --- |
| **A 基线** | 存在且正常 | `true` | 深拷贝 | ✅ 默认覆盖 |
| **B 缺失降级** | `undefined` / 非函数 | `false` | **返回原引用**（引用共享） | ❌ 默认不覆盖 |
| **C 克隆失败** | 存在但抛 `DataCloneError` | `true` | 抛错；且因 `Promise.resolve(<同步求值>)` 而**同步抛**（U35） | ❌ 默认不覆盖 |

**关键推论**`【设计推导】`：

- G1 + G2 + G4：`canClone` 在模块首次加载时固化到每个表实例；`test_storage.ts`（G6）顶层静态 import 又让加载发生在任何测试代码之前 → **运行时再改 `globalThis.structuredClone` 完全无效**。
- G5：无 Vitest / Jest，故**不存在** `vi.resetModules()` / `jest.resetModules()` 这类现成隔离能力。
- G8：Node 20 与现代浏览器天然支持 `structuredClone` → 默认 `canClone === true`，**状态 B 与 C 永远不会被执行**。
- 结论：若不隔离模块加载并主动打桩，**降级路径 100% 漏测**；C134–C136 / T157–T159（1.2.3.4）依赖能控制 `canClone`，若做不到则 **U32 无法闭合、K1–K4 无法验证**。登记 **U39**。

### 3.3 测试方案比较（不修改源码、不执行测试）

`【设计提案】【需批准】` 六方案并列，**不选定**，归 D33。

| 方案 | 做法 | 改源码？ | 能否覆盖 B/C | 代价 / 边界 |
| --- | --- | --- | --- | --- |
| **T-A 子进程隔离** | 每个用例 spawn 独立 `tsx` 进程，进程启动前用预加载脚本 patch `globalThis.structuredClone`，再动态 import `memory.ts` | **否** | ✅ 最可靠 | 慢；需新增测试脚本（非源码）；进程通信 / 退出码 / 全局状态天然隔离 |
| **T-B 动态 import + cache-busting** | `Object.defineProperty(globalThis, 'structuredClone', ...)` 后 `await import('../src/services/storage/memory.ts?case=B')` | **否** | 需 `【待自动化】` 验证 | Node ESM / tsx 对 `.ts?query` 是否生成新模块实例未知；且**须直接 import `memory.ts` 绕过 `index.ts`**（G4 会连带加载）；`tables` Map 仍可能串味 |
| **T-C 依赖注入** | 给 `MemoryTableService` / `memoryStorage` 加可注入 `clone` 开关（仅测试用） | **是** | ✅ 最直接 | 违反本轮「不修改源码 / 不新增源码 API」；属 D31 / G9 范畴，只能列为未来实施候选 |
| **T-D 直接构造表实例** | 测试里 `new MemoryTableService(name, false)` | **是**（类非导出，需导出） | ✅ | 同样需改源码；且绕过了 `tableOf` 的真实路径 |
| **T-E 静态契约审查** | 只读检查 `canClone` 定义与 `tableOf` 传参，人工确认降级路径存在 | **否** | ❌ 不能替代运行时 | 只能补充，不足以闭合 U32 |
| **T-F 真机浏览器矩阵** | 在目标浏览器确认 `structuredClone` 可用性 | **否** | 现代浏览器基本都有 → B 不可达 | 只能证明状态 A，不能覆盖 B/C |

**组合结论（比较，非选定）**`【设计推导】`：最小可行组合 = **T-A（或经 `【待自动化】` 验证可用的 T-B）+ 三态打桩（A/B/C）**；可复用 G7 的 `Object.defineProperty` 与「依赖按序 `await import`」既有模式；每个用例须 `try/finally` 恢复全局、使用独立进程 / 模块实例避免 `tables` Map 串味；断言状态 C 用「同步抛」而非 `rejects`（U35）。T-C/T-D 因需改源码，本轮**不采用、不实施**。

### 3.4 与 U32 / K1–K4 的依赖关系

`【设计推导】`

```text
D31（内部访问路径） ─┐
D30（K1–K4 拷贝降级）├─→ C134–C136 / T157–T159 可设计 ─→ U32 闭合
D33（canClone 可控） ─┘         ▲
                                └── 若 D33 未落地，B/C 状态不可达 → U32 保持未闭合
```

> 因此 **U39 是 U32 的前置依赖**：在 D33 裁定且 C146–C148 / T169–T171 通过前，不得把 U32 改写为「已闭合」，也不得把 K1–K4 中任何一项写成「已验证」。`【需批准】`

### 3.5 新增测试设计（C146–C148 / T169–T171）

| # | 场景 | 断言要点 | 层级 |
| --- | --- | --- | --- |
| **C146/T169** | 模块隔离覆盖状态 B | 按选定方案隔离加载后令 `structuredClone` 缺失：断言 `canClone === false`、`copy()` 返回原引用、`put/get/toArray` 共享引用；`readSnapshot` 按 K1–K4 选定策略行为一致（未批准前不断言具体策略） | `【待自动化】` |
| **C147/T170** | 三态打桩 A/B/C | A 深拷贝、B 引用共享、C `DataCloneError` 且**同步抛**（U35）；三类均断言 `readSnapshot` 恒返回 Promise、错误为 `SnapshotError`、无静默回退引用共享 | `【待自动化】` + `【待真机】` |
| **C148/T171** | 默认环境漏测检测与全局恢复 | 断言默认 Node/tsx 环境 `canClone === true`（记录为「默认漏测 B/C」证据）；注入「若不隔离就打桩无效」的反例探针；每个用例 `try/finally` 恢复 `globalThis.structuredClone`，断言无跨用例污染、无 `tables` Map 串味 | `【待自动化】` |

---

## 4. 测试矩阵增量汇总

| 编号区间 | 来源 | 数量 | 状态 |
| --- | --- | --- | --- |
| C01–C136 / T01–T159 | Phase 1 ～ 1.2.3.4 | 136 / 159 | **全部保留，编号与原结论不变** |
| **C137–C148 / T160–T171** | **本报告新增** | **12 / 12** | **新编号，不占用任何旧编号** |

分布：第 1 章 C137–C140 / T160–T163（4）、第 2 章 C141–C145 / T164–T168（5）、第 3 章 C146–C148 / T169–T171（3）。全部为 `【待自动化】` / `【待真机】` 设计，**本轮未执行任何一项测试**。

---

## 5. D 项与审批状态

| 项 | 内容 | 状态 |
| --- | --- | --- |
| D1–D27 | 沿用 1.2.3.3 §5 | **状态一律不变**（待批准 / 待确认 / 需批准 / 阻塞中） |
| **D28** | O1 监控边界澄清 | **继续保持需批准** |
| **D29** | 统一错误类型模型 | **继续保持需批准** |
| **D30** | memory 拷贝语义未闭合与降级候选 **K1–K4** | **继续保持需批准** |
| **D26 的 O1 / O2 / O3** | thenable 后续 rejection 处置 | **仍待批准，本轮未裁定** |
| Q2 / Q11 / Q12 | 沿用 | **待确认 / 待批准** |
| **D31（新增）** | memory 快照内部访问路径候选 P1 / P2 / P3a–P3e 的选型与封装边界；U37 前提缺口的闭合方式 | **需批准**（本报告不选定方案） |
| **D32（新增）** | Promise / thenable 契约精确化：C130 awaitability 与同步 throw 断言、C125 环境矩阵、`assertNotThenable` 读取次数与阶段分离、`toSnapshotError` 总函数契约 | **需批准** |
| **D33（新增）** | `canClone` 测试可控性方案 T-A–T-F 比较与选型；U39 作为 U32 前置依赖的闭合条件 | **需批准**（本报告不选定方案、不修改源码、不执行测试） |

> **补充报告 ≠ 批准**。用户本轮未裁定任何 D 项；**D28–D30、O1/O2/O3、K1–K4 全部仍待批准**。**全表无一被标记为已批准 / 已确认 / 已解除。**

---

## 6. 未解决问题增量

| 编号 | 问题 | 影响 | 状态 |
| --- | --- | --- | --- |
| U1–U36 | 沿用 1.2.3.4 第 7 章 | —— | 状态不变 |
| **U37（新增）** | 1.2.3.4 §3.2 伪代码隐含「`buildViewsSync` 能取到内部只读副本」，但 `rows` 为 private、门面不可访问、公开 `TableService` 无快照方法、快照实现零落地 → **当前无合法内部读取点** | 伪代码不可直接落地；内部访问路径未定（D31） | `【只读核实】` + `【需批准】` D31 + C137–C140 |
| **U38（新增）** | `toSnapshotError` 若是非总函数，自身抛错会让非 `SnapshotError` 逃出统一错误类型，导致 C6 / G1 / G4 失效 | 错误类型统一无法保证 | `【设计推导】` + `【需批准】` D32 + C145 |
| **U39（新增）** | `canClone` 模块级常量 + `index.ts` 顶层静态 import + Node 20 天然支持 `structuredClone` + 无 Vitest/Jest → **降级状态 B/C 默认 100% 漏测**；为 U32 的前置依赖 | U32 无法闭合、K1–K4 无法验证 | `【只读核实】` + `【需批准】` D33 + C146–C148 |
| **U40（新增）** | `assertNotThenable` 检测阶段与 O2/O3 的 handler 挂接阶段若混同，`then` 读取次数从 1 变 2+，Proxy 可按次数改变返回值，行为不可预测 | 检测可绕过、副作用不可控 | `【设计推导】` + `【需批准】` D32 + C143–C144 |

---

## 7. 准入状态、G9 复核、保护自检与剩余阻塞项

### 7.1 准入状态与 G9 复核

> **未获准入。** 本轮重新核实：`述树统一书籍资产与知识问答架构设计-V1.2.7-阶段1B最终实施门禁审查版.md` **L402 D3 仍「待裁定」**、L408 起门禁结论仍「暂不进入阶段 1B」；v12 / v13 仍同时被规划，全仓检索未见任何针对本任务的版本协调结论。
> **G9 / D9 继续阻塞**；本轮**未决定 Dexie version、未解除 G9、未修改 `stores()` / schema / 表 / 索引**。D1–D27 状态不变，D28–D30 继续需批准，D31–D33 新增需批准，无一被标为已批准。

### 7.2 保护范围自检

| 约束 | 是否遵守 | 说明 |
| --- | --- | --- |
| 不修改源码 / 配置 / 数据库 / 迁移 / Git 暂存区 / 工作区已有文件 | 是 | 全程 Read / Grep / Glob；**未执行任何 git 命令**；未 Write / Edit 到 `src/` / `server/` / `scripts/` |
| 不覆盖并行 Agent 改动、不修改前提卡 | 是 | 未触 |
| 不修改 Dexie version / `stores()` / schema / 表 / 索引 | 是 | 见 7.1 |
| G9 / D9 继续阻塞、不自行解除 | 是 | 本轮重新核实并如实记录 |
| 不实施清除、不新增局部清除 API | 是 | 零 `clearAll()` 调用 |
| 不新增源码 API / 源码类型 | 是 | 第 1 章候选、第 2 章契约、第 3 章方案均为设计态 |
| 不把 Agent 建议写成用户批准 | 是 | 0.4 分级表 + 第 5 章全表状态 |
| 保留 C01–C136 / T01–T159、D1–D30、U1–U36 原编号与原状态 | 是 | 新增自 C137 / T160 / D31 / U37 起；旧报告只读 |
| 仅新增一份报告 + 一条日志 | 是 | 本报告为唯一新增文档 |
| 全篇五类证据标注、区分既有事实与新增提案 | 是 | 0.4 分级 + 各章 F/G 表与 `【设计提案】` 标注 |
| 不把未测试写成已验证、报告完成后停止 | 是 | 全部新增测试标 `【待自动化】` / `【待真机】`；见末尾停止声明 |

### 7.3 剩余阻塞项（沿用 1.2.3.4 §8.3 B1–B12，新增 B13–B15）

| # | 阻塞项 | 类型 | 解除条件 |
| --- | --- | --- | --- |
| B1 | **G9 / D9**：v12、v13 均被并行任务规划，D3 待裁定 | **外部依赖，最高优先** | 并行架构负责人书面回复 1.2.2 §6.4 的 5 条验收标准并留痕 |
| B2–B12 | 沿用 1.2.3.4 §8.3（含 D28–D30 / U32 / 自动化与真机 / 容量压测） | —— | 状态不变 |
| **B13（新增）** | **D31**：memory 内部访问路径选型与 U37 前提缺口 | 设计裁定 | 从 P1/P2/P3a/P3e 中选定；确认封装边界与 `memory.ts` 合并顺序（G9 第 5 条） |
| **B14（新增）** | **D32**：Promise / thenable 契约精确化与 U38 / U40 | 设计裁定 | 批准 2.1–2.5；确认 `toSnapshotError` 总函数契约与新增 reason |
| **B15（新增）** | **D33 / U39**：`canClone` 测试可控性方案与 U32 前置闭合 | 设计裁定 + 验证 | 从 T-A–T-F 中选定；C146–C148 / T169–T171 自动化通过后方可改写 U32 表述 |

### 7.4 实施前置条件（累积）

1. B1 G9 关闭并取得书面版本协调结论；
2. D21–D33 与 B2–B12 全部裁定完成（含 O1/O2/O3、K1–K4、错误模型 A/B、P 路径、T 测试方案）；
3. C137–C148 / T160–T171 自动化用例落地并通过；
4. 真机矩阵通过：浏览器多 realm（页面 / iframe / Worker / SW）、Node 三种 `--unhandled-rejections` 模式、双标签与升级窗口、IndexedDB 配额压测（U3 / U14 / U24 / U30）；
5. **U37 闭合**：内部访问路径必须落地并与 `memory.ts` 并行改动按 G9 验收第 5 条确定合并顺序；
6. **U32 依赖 U39 先闭合**：`canClone` 三态可控且 C146–C148 通过后，方可验证 K1–K4 并改写 U32 表述；
7. 三份并行改动文件（`types.ts` / `web.ts` / `memory.ts`）按 G9 验收第 5 条确定冲突解决人；
8. 前提卡红线复核（绝不编造数据、空数据才走 `EmptyState`、已写好代码不顺手改）。

### 7.5 本轮未实测 / 未执行（如实列出）

- 未运行 `npx tsc --noEmit`、`npm test`、`npm run build`、`python scripts/check_pwa.py`；`npm run build` 会写 `dist/`，与本轮约束冲突。
- **未执行任何测试**（含 C01–C148 / T01–T171）；未做真机双标签、跨 realm / Worker / SW、Node rejection 模式验证；未实测 `structuredClone` 在目标环境的可用性与 `DataCloneError` 行为。
- 未验证 tsx / Node ESM 对 `import('...ts?query')` 是否生成新模块实例（T-B 的关键前提，标 `【待自动化】`）。
- 未执行任何 `clearAll()`、`db.transaction`、Dexie 版本升级或数据库迁移；未打开真实 IndexedDB。
- 未重新执行 `git status` 等可能刷新索引的命令；Git 基线沿用前轮只读记录。
- 未向并行架构负责人发送协调请求，未取得任何新的 v12 / v13 书面结论。
- 第 1 章候选、第 2 章契约、第 3 章测试方案**全部为 `【设计推导】` / `【设计提案】`**，未写代码、未验证可行性。

> **在 B13–B15 与自动化 / 真机验证完成前，不得声称**：「内部访问路径已确定」「伪代码可直接落地」「错误类型已统一」「`toSnapshotError` 已保证不逃逸」「C125/C130 断言已验证」「`canClone` 降级路径已覆盖」「U32 已闭合」「G9 已解除」。

---

> **已停止。** 本报告完成后不进入源码实施，不进入迁移，不解除 G9，等待负责人审阅与裁定。
