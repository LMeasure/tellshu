# Tellshu 单词默写 V2 · Phase 1.2.3.4 · 监控边界与拷贝语义补充审查

> **本轮性质**：纯设计、只读审查。**不实施源码，不迁移数据库，不修改 Git 暂存区 / 工作区已有文件，不修改前提卡，不覆盖并行 Agent 改动，不决定 Dexie version，不修改 `stores()` / schema / 表 / 索引，不解除 G9，不实施任何清除，不新增局部清除 API，不新增源码类型。**
> **交付物**：仅新增本报告 + 按保护流程追加一条工作日志。完成后停止，等待负责人审阅。

---

## 0. 承接关系、基线与证据标注

### 0.1 承接范围

本报告**只审查用户点名的四项**，顺序按用户指定：

| 序 | 问题 | 对应既有裁定 | 本报告章节 |
| --- | --- | --- | --- |
| 1 | D26：O1 rejection 监控边界 | D26 / U27 / C109·T132 | 第 1 章 |
| 2 | D26：错误类型统一 | D26 / 1.2.3.3 §2.3 | 第 2 章 |
| 3 | D23：两驱动 Promise 边界 | D23 / C1–C7 | 第 3 章 |
| 4 | memory 快照拷贝语义 | 1.2.3.2 §3.2 / C94·T117 / C95·T118 | 第 4 章 |

C01–C122 / T01–T145 的**编号与原结论全部保留**，不重编号、不改写旧报告。本轮新增编号从 **C123 / T146** 起。**D21–D27 状态一律不变**，新增裁定项使用 **D28–D30**。

### 0.2 基线（沿用前轮只读记录）

| 项 | 状态 | 证据等级 |
| --- | --- | --- |
| Git HEAD | `760e999`；暂存区 6 个 `A`（B12 系列）未变；工作区存在并行 Agent 改动 | `【只读核实】`（沿用 1.2.3.2 / 1.2.3.3 记录；**本轮未执行任何 git 命令**） |
| 源码最高 Dexie 版本 | `version(11)` | `【只读核实】`（沿用） |
| **G9 / D9 复核** | V1.2.7 L402「D3 \| B7 \| Dexie v12/v13 前进式升级 + `blocked`/`versionchange` 处理 \| **待裁定**」；L408-413 门禁结论「**暂不进入阶段 1B**」，D1–D7 全部待裁定；全仓 `*.md` Grep `spellingErrorEvents｜Phase 1.2.3｜打字输入.*v12｜书面协调结果` **只命中 `产品方案/打字/` 下本任务自己的 10 份报告**，无任何并行架构文档提及本任务的版本协调结论 | `【只读核实】`（本轮 Grep）→ **G9 仍阻塞** |
| 设计态能力零落地 | `src/` Grep `snapshotRows｜buildViewsSync｜readSnapshot｜Object.freeze｜isFrozen｜deepFreeze` → **零匹配**；`src/` Grep `unhandledrejection｜SnapshotContractError｜SnapshotError｜thenable` → **零匹配**（沿用 1.2.3.3 并本轮复核） | `【只读核实】` |
| 前端全局 rejection 监听 | `src/` **零落地**；`server/src/asr/sidecar.ts` L101-104 / L219-221 有注释与 `readyPromise.catch(() => undefined)` 实践；`述树VPS上线准备-安全可靠性复核报告.md` L58 记 `index.ts` 无 `uncaughtException`/`unhandledRejection` 处理器 | `【只读核实】`（作用域：旁路后端，**不是主 App 前端**） |

### 0.3 五类证据标注（沿用）

`【只读核实】` = 逐行读到的源码 / 文档事实；`【设计推导】` = 由事实推出的逻辑结论，未实测；`【待自动化】` = 需单测 / 集成测试；`【待真机】` = 需真实浏览器 / Worker / SW / Node 运行时；`【需批准】` = 产品语义或设计取舍，本报告不自行裁定。

> **运行环境行为说明**：第 1 章关于浏览器 / Node rejection 机制的条目，除明确标注 `【只读核实】` 的项目内证据外，均为依据运行时规范的 `【设计推导】`，**不是本轮实测**；不同引擎版本 / 启动参数 / 测试框架可能改变具体行为，一律标 `【待真机】` / `【待自动化】`。

### 0.4 决策来源分级（本轮）

| 类别 | 内容 |
| --- | --- |
| **用户已决定** | 本轮保护约束（纯设计只读、只新增一份报告、不实施清除、不解除 G9、不把 Agent 建议写成已批准、保留旧编号）；本轮四项审查范围；Phase 1 三项产品决策；清除边界硬约束（1.2.3.3 §1.1 B1–B3）；G9 继续阻塞、不决定 Dexie version |
| **Agent 建议** | 1.2.3.3 的 O1/O2/O3 选项内容、C1–C7 契约、G1–G7 / N1–N7 清单、`SnapshotError` 类型草案；1.2.3.2 §3.2 的五条 memory 拷贝「契约要点」；本报告的澄清建议、统一类型模型、最小伪代码、降级四候选 |
| **待批准提案** | D21–D27（状态不变）+ 新增 **D28 / D29 / D30**；Q2 / Q11 / Q12；本报告全部 `【需批准】` 条目 |

> **本报告未把任何 Agent 建议写成用户已批准**；用户本轮也未对 O1/O2/O3 或任何 D 项作出裁定。

---

## 1. P0-1 · D26：O1 rejection 监控边界

### 1.1 只读核实：O1 的原文与项目内证据

| # | 事实 | 位置 | 标注 |
| --- | --- | --- | --- |
| F1 | O1 原文：「**不处理** —— 只抛 `SnapshotContractError`，完全不触碰 `P`；**依赖全局 `unhandledrejection` 监控**」 | 1.2.3.3 §2.6 L232 | `【只读核实】` |
| F2 | O1 把「不处理 thenable」与「依赖监控」**写在同一句**，未区分主行为与配套观测 | F1 直读 | `【只读核实】` |
| F3 | C109/T132 断言原文：「O1 下 `unhandledrejection` 被全局监控捕获并记原因码」 | 1.2.3.3 §2.7 L243 | `【只读核实】` |
| F4 | 主 App 前端 `src/` **无任何** `unhandledrejection` 监听 | 本轮 Grep | `【只读核实】` |
| F5 | `server/src/asr/sidecar.ts` L101-104：「**Node 15+ 未处理拒绝默认致命**」；用 `this.readyPromise.catch(() => undefined)` 挂空 catch 防 `unhandledRejection`，且 `waitReady` 侧由 `Promise.race` 正常接住 | 本轮 Read | `【只读核实】`（旁路后端既有实践，可佐证「挂 handler」在项目里已有先例，**不构成对本任务 O2 的批准**） |
| F6 | `述树VPS上线准备-安全可靠性复核报告.md` L58：`index.ts` 仅有 `SIGINT`/`SIGTERM` 处理器，**无 `uncaughtException`/`unhandledRejection` 处理器** | 本轮 Grep | `【只读核实】`（旁路后端） |

### 1.2 浏览器与 Node 的 rejection 行为差异

`【设计推导】` + `【待真机】`（规范行为，非本轮实测）

| 维度 | 浏览器（Window / WorkerGlobalScope） | Node |
| --- | --- | --- |
| 事件 / 钩子 | `unhandledrejection`（`PromiseRejectionEvent` 带 `promise` / `reason`）；后续被处理触发 `rejectionhandled` | `process.on('unhandledRejection', (reason, promise))` / `rejectionHandled` |
| 触发时机 | 宿主在一轮微任务检查点后，对仍无 handler 的 rejected **原生 Promise** 派发 | 事件循环末尾判定未处理 rejection |
| 默认后果 | 控制台警告 / 上报；`event.preventDefault()` 仅**抑制默认上报** | Node 15+ 默认 `throw`（未处理拒绝按未捕获异常处理，可能退出进程）；可配 `warn` / `strict` / `warnWithErrorCode` / `none` |
| 注册监听器的影响 | 不改变 Promise 状态；`preventDefault()` 不等于挂 handler | 注册 `unhandledRejection` 监听器会**改变默认 throw 行为**（不同版本 / 显式 `--unhandled-rejections` 配置下有差异） |
| 覆盖对象 | **仅原生 Promise**；自定义 thenable / Proxy thenable 不参与 Promise rejection tracking | 同样以原生 Promise 为主 |
| realm | 每个 realm（页面 / iframe / Worker / Service Worker）各有全局对象与微任务队列，**主页面监听器收不到其它 realm 的事件** | 单进程内监听器覆盖该进程；子进程 / worker_threads 独立 |
| 生命周期 | 页面卸载 / 导航 / SW 被终止前未到检查点的 rejection **丢失** | 进程退出前的 pending rejection 可能不触发 |
| 测试环境 | 浏览器 DevTools / 打包工具 error overlay 可能改变上报表现 | Vitest / Jest 常自带监听器，可能把 rejection 转成测试失败或吞掉 → **单测表现不能推断生产行为** |

### 1.3 O1 到底是什么：主行为与配套观测必须分开

`【设计推导】【需批准】`

1.2.3.3 §2.6 的 O1 定义把两件事捆在一起，容易被读成「因为有监控，所以不处理是安全的」。**澄清建议（D28，不改变选项集合、不裁定）**：

- **O1 的主行为 = 不处理 thenable**：只抛 `SnapshotContractError`，完全不触碰 `P`；不给 `P` 挂任何 handler、不等待、不 assimilate、不撤销。
- 「依赖全局监控」**不是处理动作**，只是**可选的事后观测 / 可观测性**；且 F4 已证实主 App 前端**当前没有这个监控**，需要先另立实现。
- 因此 O1 的正确表述应为「**不处理 + （可选）事后观测**」，而非「不处理 = 有监控兜底」。为便于审阅，可拆成表述变体 **O1a（不处理、无监控）/ O1b（不处理 + 事后观测）**，但**这只是措辞澄清，不新增、不替换、不裁定 O1/O2/O3**。

> **对旧编号的处理**：C109/T132 原文「O1 下 `unhandledrejection` 被全局监控捕获并记原因码」**保留不改**；其适用范围应理解为「**监控可覆盖的同一 realm、原生 Promise、监听器已先注册**」的窄场景。漏捕获场景由本轮新增 C124/T147、C125/T148 覆盖。`【需批准】`

### 1.4 监控只是事后观测，不能作为安全处理保证

`【设计推导】` 五条理由：

1. **时序滞后**：事件在 rejection 已发生、微任务检查点之后才派发；观测到时 t3 的副作用早已发生（1.2.3.3 §2.1 时序）。
2. **不改变 Promise 状态**：监听器 / `preventDefault()` 都不会让 `P` 变成 fulfilled，也不会给 `P` 挂上 handler；`P` 仍是 rejected。
3. **不撤销副作用**：监控不回滚、不补偿、不取消已发出的写 / 网络 / 定时器（N2）。
4. **不保证被观测**：见 1.5 漏捕获矩阵；跨 realm、自定义 thenable、配置静默等都会漏。
5. **不等于「已处理」**：即便监听器记了一条日志，也只是「记录到一次 rejection」，不是「Promise 已安全处理」。

**文案硬约束（D28）**`【需批准】`：禁止写「O1 由监控兜底」「rejection 已被安全处理」「记录到 rejection 即完成处置」「Promise 已妥善清理」；允许写「O1 不处理 thenable；如配置监控，仅作事后观测，不构成处理保证」。

### 1.5 哪些 rejection 可能无法由该监控捕获

`【设计推导】` + `【待真机】`

| # | 漏捕获场景 | 原因 |
| --- | --- | --- |
| M1 | 自定义 thenable / Proxy thenable 的 reject | 非原生 Promise，不参与 Promise rejection tracking（呼应 1.2.3.3 S4） |
| M2 | iframe / Worker / **Service Worker** 内的 rejection | 各 realm 独立全局对象与微任务队列；主页面监听器收不到；SW 还可能被终止 |
| M3 | 页面卸载 / 导航 / SW 终止前的窗口 | 未到检查点或 realm 已销毁 |
| M4 | Node `--unhandled-rejections=none` 或宿主 / 框架静默配置 | 完全静默；F6 亦显示旁路后端无全局处理器 |
| M5 | reader 自身已 `.catch` 吞掉的 rejection | 不构成 unhandled → 事件不触发；**但副作用仍在**（1.2.3.3 S2） |
| M6 | 监听器注册晚于该次 rejection 检查点 | 该次事件已过，不会被补发 |
| M7 | `queueMicrotask` / `setTimeout` 内**同步抛**的异常 | 属于 `error` / `uncaughtException`，不是 rejection 事件 |
| M8 | 测试框架接管监听器 | 观测语义被改写（转成测试失败 / 被吞），不能外推生产 |
| M9 | 多个监听器中前者 `stopImmediatePropagation` 或抛错 | 后续观测者收不到 |

> 与项目的关联`【设计推导】`：主 App 是离线 PWA，`readSnapshot` 可能在页面或 Worker 中被调用；若落在 SW / Worker，M2 直接影响 O1 的可观测性。此处**不假定**当前实现用了 Worker，仅列为需真机确认的场景。

### 1.6 「记录到 rejection」≠「Promise 已安全处理」

`【需批准】` 给出三条必须写入契约 / 验收文档的判据：

- 日志字段只能是 `event: 'observed_unhandled_rejection'`、`reason_code`、`requestId`、`realm`；**不得**出现 `handled: true` / `resolved: true` / `cleaned: true` 之类字段。
- 监控回调内**不得**写「已处理」「已清理」「已恢复」文案；UI 不因监控触发而改变错误提示。
- O1 的风险接受必须显式：未处理 rejection 的控制台噪声、Node 默认致命行为、跨 realm 漏观测，均由负责人签字接受；**不得**以「有监控」为由免除。

### 1.7 O1 / O2 / O3 仍是待批准选项

`【需批准】` 本轮**不裁定**、不新增选项、不改变 D26 状态。补充两点供审阅：

- F5 显示「挂空 catch 防未处理拒绝」在**旁路后端**已有实践，可作为 O2 可行性的参考，但**作用域不同、不构成本任务批准**。
- O3 的 `instanceof Promise` 判定在跨 realm（iframe / Worker）下不可靠，与 1.5 M2 叠加，漏捕获面比 1.2.3.3 §2.6 描述的更大。

### 1.8 新增测试设计（C123–C126 / T146–T149）

| # | 场景 | 断言要点 | 层级 |
| --- | --- | --- | --- |
| **C123/T146** | O1 定义与文案静态检查 | 文档 / 实现中 O1 主行为为「不处理」；监控标注为「事后观测」；断言无「监控兜底 / 已安全处理 / handled:true」类表述；O1/O2/O3 状态均为待批准 | `【待自动化】` |
| **C124/T147** | 浏览器事件边界 | 真机触发一次未处理 rejection：断言事件在检查点后派发、`preventDefault()` 只抑制上报而不改变 `P` 状态、副作用探针仍已执行；断言「记录到事件」不改写 Promise | `【待自动化】` + `【待真机】` |
| **C125/T148** | 漏捕获矩阵 | M1–M9 逐项：断言自定义 thenable / 跨 realm / SW / 卸载窗口 / `none` 模式 / 已 catch / 晚注册 / 同步抛 / 框架接管下**不产生**可依赖的观测；记录为已知限制 | `【待自动化】` + `【待真机】` |
| **C126/T149** | Node 与测试环境差异 | `throw` / `warn` / `none` 三模式 + 注册监听器 + Vitest/Jest 接管分别断言；对照 F5 既有实践；断言单测结论**未**被外推为生产保证 | `【待自动化】` + `【待真机】` |

---

## 2. P0-2 · D26：错误类型统一

### 2.1 只读核实：三处定义互不一致

| # | 位置 | 定义 / 用法 | 问题 |
| --- | --- | --- | --- |
| E1 | 1.2.3.2 §3.1 L201-212 | `new SnapshotContractError('reader 返回值读取 then 失败', { cause: e })` —— **两参构造** `(message, options)` | 与 E3 的六参构造不兼容 |
| E2 | 1.2.3.2 §3.3 L264-268 | `SnapshotContractError`、`DatabaseClosedError` / `AbortError`（Dexie 原生）、`DataCloneError`（原生）混用 | 原生错误与设计态类型并列，无归一规则 |
| E3 | 1.2.3.3 §2.3 L161-181 | `class SnapshotError extends Error`，构造 `(phase, reason, driver, requestId, message, options?)`，只读字段；`SnapshotPhase` 5 值、`SnapshotReason` 8 值 | 只定义了**基类**，未定义子类 |
| E4 | 1.2.3.3 §2.3 C2 L186 | 「检测只产生 `SnapshotContractError`」 | 名称与 E3 基类不一致、无继承关系 |
| E5 | 1.2.3.3 §2.3 C7 L191 | 「→ `SnapshotTransactionError`」 | 同样无定义、无继承关系 |
| E6 | 1.2.3.3 §2.7 C108/T131、C112/T135 | 断言「抛 `SnapshotContractError`」「类型化错误字段一致」 | 未说明断言的是基类还是子类，测试口径不一 |

`【只读核实】` 结论：**`SnapshotError` / `SnapshotContractError` / `SnapshotTransactionError` 三个名称分散在两轮报告中，无继承关系、构造签名不兼容、`cause` 传递方式不一致** → 登记为 **U34**。

### 2.2 统一类型模型（设计建议，不新增源码类型）

`【设计提案】【需批准】` 两个候选并列，**不裁定**，归 D29。

**候选 A：基类 + 子类树**（`instanceof` 判别直观）

```ts
Error
 └─ SnapshotError                       // 基类：phase / reason / driver / requestId / cause
     ├─ SnapshotContractError           // 契约违反：调用方传错表、reader 返回 thenable、then 探测失败
     ├─ SnapshotReaderError             // reader 自身抛错（保留原始 cause）
     ├─ SnapshotBuildError              // buildViews / 深拷贝 / 表读取失败
     └─ SnapshotTransactionError        // Dexie 事务 abort / db.close / 升级中断
```

**候选 B：单类 + `reason` 判别联合**（类型面更小，判别靠 `switch (e.reason)`）

```ts
class SnapshotError extends Error { /* phase, reason, driver, requestId, cause */ }
// 调用方：switch (e.reason) { case 'THENABLE_RETURNED': ... }
```

| 维度 | A 子类树 | B 单类 |
| --- | --- | --- |
| 调用方判别 | `instanceof` 直观、可分组 | `switch(reason)` 精确但易漏分支 |
| 类型数量 | 5 个 | 1 个 |
| 与「不新增源码类型」约束 | 设计态类型多，实施面大 | 更小 |
| 两驱动一致性 | 需两驱动抛同一子类 | 只需同一 reason |

> 无论选 A/B，构造签名必须**统一为一个**（建议 `(init: { phase, reason, driver, requestId, cause?, message? })`），`message` 由 `reason` 映射生成，避免 E1 与 E3 的两参/六参不兼容。**本报告只给设计建议，不新增源码类型、不落地。**

### 2.3 `phase` / `reason` 的合法值与映射

`【设计提案】【需批准】`

**`phase` 现有 5 值的问题**`【设计推导】`：

| 值 | 问题 | 建议 |
| --- | --- | --- |
| `'open'` | memory 驱动无「事务开启」阶段 → 两驱动语义不对齐（U36） | 并入 `'setup'`，或由 `reason` 表达 |
| `'commit'` | 只读事务没有写入提交语义，易被误解为「写入已提交」 | 改名 `'finalize'`，明确只表示「事务正常结束 / 返回值封装」 |
| `'buildViews'` / `'reader'` / `'assert'` | 无歧义 | 保留 |

建议合法值：`'setup' | 'buildViews' | 'reader' | 'assert' | 'finalize'`，并给两驱动映射表（memory 的 `setup` = 参数校验 + 表声明检查；`finalize` = 返回值封装）。

**`reason` 合法值与歧义检查（现有 8 值）**：

| reason | 归属 phase | 归类 | 重复 / 歧义检查 |
| --- | --- | --- | --- |
| `TABLE_NOT_DECLARED` | `setup` | 契约违反 | 与 `BUILD_VIEWS_FAILED` 层级不同：前者是**调用方传错表**（契约），后者是**读失败**（环境），须分开 |
| `BUILD_VIEWS_FAILED` | `buildViews` | 构建错误 | 同上 |
| `CLONE_FAILED` | `buildViews` 或 `finalize` | 构建错误 | 若 reader 自己调用 `structuredClone` 抛错，会被 `READER_THREW` 吞掉 → 规定「reader 抛错一律 `READER_THREW` 并保留 `cause`；原语内部克隆失败才用 `CLONE_FAILED`」 |
| `READER_THREW` | `reader` | reader 错误 | 需规定「reader 抛出的对象即使是 thenable，也**不检查其返回值**，一律归此类」 |
| `THENABLE_RETURNED` | `assert` | 契约违反 | 语义 = 「读到 `then` 是函数」，与下一条不同 |
| `THEN_READ_FAILED` | `assert` | 契约违反 | 名称易误读为「thenable 读取失败」；建议改名 `THEN_PROBE_FAILED` / `THEN_GETTER_THREW`（**仅建议，不改写旧编号**） |
| `TRANSACTION_ABORTED` | `setup` / `finalize` | 事务中断 | 与 `DATABASE_CLOSED` 可能同时成立 → 规定优先级 **`DATABASE_CLOSED` > `TRANSACTION_ABORTED`**（根因优先），否则同一场景两驱动可能给不同 reason |
| `DATABASE_CLOSED` | `setup` / `finalize` | 事务中断 | 同上 |

**建议新增值（设计建议，待批准）**：`UNSUPPORTED_CLONE_ENV`（不支持 `structuredClone` 且无法提供副本，见第 4 章）、`THEN_HANDLER_THREW`（O2 挂 handler 时 `then` 抛错）、`VIEW_REUSED`（内部一致性断言，仅测试用）。

**映射规则**`【设计推导】`：每个 `reason` **唯一归属一个 `phase`**（`CLONE_FAILED` 允许两个 phase 但须在错误对象里记录实际发生点）；`reason → 错误类别 → 调用方处置` 三列形成唯一映射表，避免两驱动各自解释。

### 2.4 调用方如何区分三类情况

`【设计提案】【需批准】`

| 错误类别 | 判别 | 调用方处置 | 禁止 |
| --- | --- | --- | --- |
| **契约违反** | `instanceof SnapshotContractError` 或 `reason ∈ {TABLE_NOT_DECLARED, THENABLE_RETURNED, THEN_PROBE_FAILED}` | **不重试**（等价于 4xx）；记结构化日志；开发期断言修复 reader；UI 显示规范化「数据读取失败，请重试」 | 自动重试、自动改 reader 返回值、静默吞掉 |
| **reader 错误** | `SnapshotReaderError` / `READER_THREW` | 保留 `cause` 记日志；**不自动重放** reader（副作用可能已发生，N2）；交由调用方决定是否走 U16 | 把 `cause` 当契约违反、丢掉原始错误 |
| **构建 / 克隆错误** | `SnapshotBuildError` / `BUILD_VIEWS_FAILED` / `CLONE_FAILED` / `UNSUPPORTED_CLONE_ENV` | 按 `reason` 分流；`UNSUPPORTED_CLONE_ENV` 走第 4 章降级策略 | 静默回退引用共享（1.2.3.2 §3.2 第 4 条） |
| **事务中断** | `SnapshotTransactionError` / `DATABASE_CLOSED` / `TRANSACTION_ABORTED` | **交 U16 恢复链**（重新 open → 重新取锁 → 重新聚合），**原语内不重试** | 简单「5xx 重试 3 次」式自动重试 |

> `【设计推导】` 特别澄清：expert 规范里的「4xx 不重试 / 5xx 自动重试最多 3 次」是**前端 HTTP API 错误映射规则**，**不适用于本地快照原语**。本地事务中断有独立的 U16 恢复链，不能被套用成通用重试。

**全局规范化边界（沿用 1.2.3.3 §2.3）**：客户端只见 `{ code: reason, message: '数据读取失败，请重试', requestId }`，绝不返回堆栈 / 内部细节；结构化 JSON 日志 `{ level, event:'snapshot_error', requestId, driver, phase, reason, tables }`，**不记 reader 返回值、不记行内容、不记 `owner` / `word_id` 明文**。

### 2.5 新增测试设计（C127–C129 / T150–T152）

| # | 场景 | 断言要点 | 层级 |
| --- | --- | --- | --- |
| **C127/T150** | 继承 / 判别一致性 | 按 D29 选定模型：A 下四子类均 `instanceof SnapshotError` 且互不误判；B 下 `reason` 联合穷尽；两驱动抛同一类型；构造签名统一 | `【待自动化】` |
| **C128/T151** | phase / reason 映射与歧义回归 | 8 个现有 reason + 建议新增值逐项断言唯一 phase；`DATABASE_CLOSED` 优先于 `TRANSACTION_ABORTED`；`THEN_READ_FAILED` 与 `THENABLE_RETURNED` 不混淆；reader 抛出 thenable 对象时归 `READER_THREW`；`CLONE_FAILED` 不被 reader 内部克隆吞掉 | `【待自动化】` |
| **C129/T152** | 调用方分支与错误边界 | 四类错误分别断言处置（不重试 / 不重放 / 交 U16 / 保留 cause）；断言 UI 无堆栈、日志不含行内容与隐私；断言未套用 HTTP 5xx 重试规则 | `【待自动化】` |

---

## 3. P0-3 · D23：两驱动 Promise 边界

### 3.1 五条硬约束

`【设计提案】【需批准】`

| # | 约束 | 说明 |
| --- | --- | --- |
| P1 | **对外恒返回 Promise** | `readSnapshot(...): Promise<T>`，任何路径（参数校验、`tables` 越界、`buildViewsSync`、`reader`、检测器、克隆、事务中断）都不得同步抛错 |
| P2 | **同步异常统一转 rejection** | 所有同步异常经 `toSnapshotError(...)` 归一后由 `async` 函数包装为 rejected Promise |
| P3 | **memory 同步快照段不得引入 `await` / 微任务让出** | `buildViewsSync` + `reader` + `assertNotThenable` 必须在**同一同步段**完成；不得 `await this.toArray()/get()`（`memory.ts` L103-105 / L129-131 是 `Promise.resolve`，`await` 会让出微任务队列） |
| P4 | **禁止 `Promise.resolve(reader(views))`** | 见 3.4 |
| P5 | **Promise 包装不能撤销已启动的异步副作用** | 见 3.5；与 1.2.3.3 N2 一致 |

### 3.2 最小伪代码（设计态，不落地）

```ts
// ── memory.ts（门面）：整个函数体无 await ──────────────────────────
async readSnapshot<T>(
  tables: readonly TableName[],
  reader: (views: SnapshotViews) => T,
): Promise<T> {
  let views: SnapshotViews
  try {
    assertTablesDeclared(tables)              // 同步；抛错也由 async 转 rejection
    views = buildViewsSync(tables)            // 直接读内部快照副本，禁止 await toArray()/get()
  } catch (e) {
    throw toSnapshotError(e, { phase: 'buildViews', driver: 'memory' })
  }

  let result: T
  try {
    result = reader(views)                    // 同步调用；此后不得再 await
  } catch (e) {
    throw toSnapshotError(e, { phase: 'reader', driver: 'memory' })
  }

  try {
    assertNotThenable(result)                 // 检测；抛错同样转 rejection
  } catch (e) {
    throw toSnapshotError(e, { phase: 'assert', driver: 'memory' })
  }
  return result                              // async 包装为 Promise<T>
}

// ── web.ts：Dexie r 事务 ──────────────────────────────────────────
readSnapshot<T>(tables, reader): Promise<T> {
  return db.transaction('r', tables, async () => {
    const views = await buildViews(tables)   // 仅 await 本事务内、同 db 的表操作
    const result = reader(views)             // 同步调用；此后不得再 await
    assertNotThenable(result)
    return result
  })
}
```

### 3.3 `async` 包装与「不引入微任务让出」的精确语义

`【设计推导】` 这是最容易混淆的一点，必须写清：

- `async` 函数在**没有 `await`** 时，其函数体从进入到 `return` **全程同步执行**；抛出的异常由语言自动包装成 rejected Promise（满足 P1/P2），**不会在 `reader` 执行期间让出微任务队列**（满足 P3）。
- `async` 带来的「微任务」只发生在**返回值被 Promise 化 / 调用方 `await`** 时，此时 `reader` 早已执行完毕；它**不切分同步快照段**。
- 因此「用 `async` 包装」与「同步段不被打断」**不矛盾**；矛盾的是在同步段内插入 `await`（P3 禁止）或先求值再包装（P4 禁止）。
- 一致性边界仍为 1.2.3.1 §2.3(c)：**快照内部非混合但允许稍旧**。

### 3.4 为什么禁止 `Promise.resolve(reader(views))`

`【只读核实】` + `【设计推导】`

1. **求值顺序**：`reader(views)` 是 `Promise.resolve` 的**实参**，先同步求值。若 `reader` 抛错，异常发生在 `Promise.resolve` 被调用之前 → 在普通函数中**同步抛给调用方**，直接违反 P1/P2。
2. **无法统一归一**：该写法把 `reader` 放在 `try/catch` 之外（除非再包一层），错误无法经 `toSnapshotError` 归一，两驱动错误类型会分叉（违反 1.2.3.3 C6）。
3. **项目内已有同类分叉证据（新增 U35）**：`memory.ts` L129-131 `toArray()` = `Promise.resolve([...this.rows.values()].map((r) => this.copy(r)))`；`memory.ts` L103-105 `get()` = `Promise.resolve(row ? this.copy(row) : undefined)`。若 `this.copy(r)` 的 `structuredClone` 抛 `DataCloneError`，异常在**实参求值阶段同步抛出**，而不是返回 rejected Promise。`【只读核实】` 这正是「先执行再包装」造成的 Promise 边界分叉，`readSnapshot` 不得重蹈。
4. 另外，1.2.3.1 §2.3(d) 的 memory 骨架 `return Promise.resolve(reader(views))` 已在 1.2.3.2 §3.3 被指出会让同步抛错变成函数同步抛出；本轮以伪代码给出替代写法，**旧编号与旧结论保留不改**。

### 3.5 Promise 包装不撤销 reader 已启动的异步副作用

`【设计推导】` 包装只改变「错误如何传播到调用方」，不改变 1.2.3.3 §2.1 的 t3：

| 包装能做的 | 包装不能做的 |
| --- | --- |
| 把同步异常变成 rejection | 结束 `P`、改变 `P` 的状态 |
| 统一错误类型 / 字段 / 日志 | 撤销 t3 已发生的写 / 网络 / 定时器 |
| 保证恒返回 Promise | 阻止 `P` 后续 reject 或 unhandled rejection |
| 保证失败不返回视图 | 阻止 reader 通过外部句柄发起的操作 |

> `【设计推导】` 推论：`await readSnapshot(...)` **成功**也不代表 reader 的异步副作用已结束；两者的时序解耦。此结论须写入验收文档（N2 / N7），**不得**写成「包装后已安全」。

### 3.6 新增测试设计（C130–C133 / T153–T156）

| # | 场景 | 断言要点 | 层级 |
| --- | --- | --- | --- |
| **C130/T153** | 恒返回 Promise（五路径） | 参数非法 / `tables` 越界 / `buildViewsSync` 抛错 / `reader` 抛错 / `assertNotThenable` 抛错：逐项断言 `readSnapshot(...) instanceof Promise` 且 `rejects.toBeInstanceOf(SnapshotError)`；**断言无任何同步抛出** | `【待自动化】` |
| **C131/T154** | 禁止先求值再包装 + 无微任务让出 | 静态 / AST 检查无 `Promise.resolve(reader(...))`；memory 实现内无 `await`；在同步段注入 `queueMicrotask` 探针断言计数为 0；spy 断言未调用 `toArray()/get()` | `【待自动化】` |
| **C132/T155** | 两驱动错误字段一致 | Dexie / memory 对同一输入给出相同 `phase` / `reason` / `driver` 除外的字段；`requestId` 贯穿；`async` 包装不引入同步段让出（与 C131 联动） | `【待自动化】` |
| **C133/T156** | 包装不撤销副作用 | reader 启动写入探针后抛错 / 返回 thenable：断言探针仍执行、`P` 状态未被改变、无「副作用已回滚 / 已安全处理」文案；断言 `readSnapshot` 的 resolve/reject 时机与探针时机解耦 | `【待自动化】` + `【待真机】` |

---

## 4. P0-4 · memory 快照拷贝语义（恢复为待解决问题）

### 4.1 重新核实的源码事实

`【只读核实】`（本轮重读 `memory.ts` L89-215）

| # | 事实 | 位置 |
| --- | --- | --- |
| M1 | `rows` 是 `private readonly Map<string\|number, T>`；`memoryStorage` 门面**无法直接访问** | L89-91 |
| M2 | `copy(row)` = `this.clone ? structuredClone(row) : row` | L98-101 |
| M3 | 注释明确：「**结构化克隆不可用时退化为引用**；避免在 Node 单测里引入额外依赖」 | L98 |
| M4 | `canClone = typeof structuredClone === 'function'`（模块级常量），`tableOf()` 用其构造每个表 | L189-199 |
| M5 | `put` / `add` / `bulkPut` 写入时**也**走 `copy(value)`；`get` / `toArray` / `bulkGet` / `whereIndex` / `whereStartsWith` 读出时走 `copy(row)` | L103-179 |
| M6 | 头注释 L13-14「**存引用而非深拷贝**……对象是共享的」、L189「缺失则退化为**引用共享**」 | L9-15 / L189 |
| **M7（新增）** | `get` / `toArray` 等写成 `Promise.resolve(<同步求值>)`；`structuredClone` 抛 `DataCloneError` 时异常在**实参求值阶段同步抛出**，不是 rejected Promise | L103-105 / L129-131 |
| **M8（新增）** | `src/` Grep `snapshotRows｜buildViewsSync｜readSnapshot｜Object.freeze｜deepFreeze` → **零匹配**；`readSnapshot` 及任何快照副本 / 冻结实现**源码零落地** | 本轮 Grep |

> **M3 / M6 的准确含义**：`canClone=false` 时共享引用是**既有驱动的有意设计**，不是偶发 bug。头注释与 L189 措辞虽与 L98-101 的 `structuredClone` 实现在「默认是否深拷贝」上不一致（1.2.3.2 M3 已记），但对「降级 = 引用共享」的描述是**一致的**。

### 4.2 四问逐答

`【只读核实】` + `【设计推导】`

| 问题 | 回答 | 依据 |
| --- | --- | --- |
| **Q1 是否可能把原引用交给 reader？** | **可能。** ① `canClone=false` 时 `copy()` 返回原引用，`get/toArray` 直接把 `rows` 内对象引用交给调用方；② `readSnapshot` / `buildViewsSync` **零落地**（M8），若实现为「直接 `[...rows.values()]`」而不自行深拷贝 / 冻结，就会把原引用交给 reader。目前**没有任何实现证据排除** | M2/M4/M5/M8 |
| **Q2 reader 是否可能通过视图引用修改 memory 内部 `rows`？** | **可能。** `canClone=false` 时读出的对象与 `rows` 内对象是同一引用，修改即污染；写入侧 `put(value)` 也把调用方对象引用直接存入 `rows`，之后调用方修改同样污染。`readonly T[]` 只是 TS 类型，`Object.freeze` 零落地（M8），运行时不冻结 | M2/M5/M8 |
| **Q3 快照失败后是否可能跨调用复用引用？** | **可能。** 1.2.3.3 C4 规定「`views` 不缓存、不复用」，但那是**设计契约**、无实现证据；若实现为性能缓存 `views` 且失败路径未丢弃缓存，下一次调用会复用含原引用的视图。C95/T118 仍为 `【待自动化】` | M8 + 1.2.3.3 C4 / C95·T118 |
| **Q4 不支持 `structuredClone` 的环境如何处理？** | **现状 = 引用共享**（M3/M4/M6），且代码注释说明是有意降级。若 `readSnapshot` 沿用此降级，就违反「只读副本」契约（1.2.3.2 §3.2 第 2 条）。**当前没有已批准的处置方案** | M3/M4/M6 |

### 4.3 此前证据是否足以判定「已闭合」→ 否，恢复为待解决问题 U32

`【只读核实】` + `【设计推导】`

- 1.2.3.2 §3.2 的五条是 `【设计推导】` 的**可执行契约要点**，措辞为「必须」「契约应规定」「设计上二选一（**待批准**）」；C94/T117、C95/T118 标 `【待自动化】`；1.2.3.3 C4 亦为设计契约。**此前报告没有写「已闭合」，但也没有把「未闭合」登记为 U 项。**
- 结合 M8（零落地）、M1（private 无法直接访问）、M7（既有同步抛分叉）、Q1–Q4 四问，**不存在任何实现或实测证据**能证明「原引用不会交给 reader」「rows 不会被污染」「失败后不复用」「无 structuredClone 环境已妥善处理」。
- **结论**：本轮明确把 **memory 快照拷贝语义登记为未解决问题 U32**，状态 `【需批准】` + `【待自动化】` + `【待真机】`。**不得沿用或引申为「已闭合 / 已解决 / 已修复」表述**；1.2.3.2 §3.2 五条应被理解为**待落地的设计提案**，C94/T117、C95/T118 的结论在测试通过前不得改写。
- 旧编号 C94/T117 / C95/T118 原文保留不改；本轮以新增 C134–C136 / T157–T159 覆盖未闭合场景。

### 4.4 不支持 `structuredClone` 环境的处置候选（待批准，不裁定）

`【需批准】` 四候选并列，归 D30。

| 候选 | 做法 | 代价 / 风险 |
| --- | --- | --- |
| **K1 拒绝服务（设计倾向，非裁定）** | 检测 `canClone=false` → 抛 `UNSUPPORTED_CLONE_ENV` 类型化错误，memory 驱动在该环境不提供 `readSnapshot`，UI 走降级提示 | 该环境无法用 memory 驱动跑快照；但**不伪造只读副本**，语义最诚实 |
| K2 手写深拷贝 | 按 `StorageSchema` 逐类型递归复制 | 需覆盖 `Date` / `Map` / `Set` / `BigInt` / 循环引用；维护成本高，且落在 `memory.ts` 并行改动文件 |
| K3 深冻结 | 对 `views` 与返回值做递归 `Object.freeze` | 不改变引用共享事实（reader 仍持有 `rows` 内对象），只是禁止修改；与 Dexie 的结构化克隆语义不一致；冻结后业务层若需临时构造派生对象会受限 |
| K4 JSON 序列化 | `JSON.parse(JSON.stringify(...))` | 丢失 `undefined` / `Date` / `Map` / `Set` / `BigInt`，静默改数据，违反前提卡红线，**不推荐** |

> 共同约束`【设计推导】`：无论选哪项，都**不得静默回退到引用共享**（1.2.3.2 §3.2 第 4 条）；`DataCloneError` 必须按类型化错误传播（M7 显示既有 TableService 会同步抛，`readSnapshot` 须统一为 rejection）；`views` 失败后不得跨调用复用（1.2.3.3 C4）。

### 4.5 新增测试设计（C134–C136 / T157–T159）

| # | 场景 | 断言要点 | 层级 |
| --- | --- | --- | --- |
| **C134/T157** | `canClone=false` 引用共享复现 | 强制 `canClone=false`：断言 `put` 后修改调用方对象会改 `rows`、`get/toArray` 返回同一引用；构造 `readSnapshot` 探针，断言 reader 通过视图修改会污染 `rows`；记录为**未闭合证据** | `【待自动化】` |
| **C135/T158** | 克隆失败与静默回退 | 行内含函数 / `Symbol` / Proxy 触发 `DataCloneError`：断言既有 `toArray()/get()` **同步抛**（记录 U35 分叉）；断言 `readSnapshot` 返回 rejected `SnapshotError`；断言**未**静默回退引用共享、`views` 未被返回 | `【待自动化】` + `【待真机】` |
| **C136/T159** | 失败后不复用 + 降级候选 | 快照失败后再次调用：断言返回全新 `views`、无上次引用；`canClone=false` 下按 D30 选定候选断言（K1 抛 `UNSUPPORTED_CLONE_ENV` / K2 深拷贝 / K3 冻结 / K4 禁止）；断言文档未使用「已闭合」表述 | `【待自动化】` + `【待真机】` |

---

## 5. 测试矩阵增量汇总

| 编号区间 | 来源 | 数量 | 状态 |
| --- | --- | --- | --- |
| C01–C122 / T01–T145 | Phase 1 ～ 1.2.3.3 | 122 / 145 | **全部保留，编号与原结论不变** |
| **C123–C136 / T146–T159** | **本报告新增** | **14 / 14** | **新编号，不占用任何旧编号** |

分布：第 1 章 C123–C126 / T146–T149（4）、第 2 章 C127–C129 / T150–T152（3）、第 3 章 C130–C133 / T153–T156（4）、第 4 章 C134–C136 / T157–T159（3）。全部为 `【待自动化】` / `【待真机】` 设计，**本轮未执行任何一项**。

---

## 6. D 项与审批状态

| 项 | 内容 | 状态 |
| --- | --- | --- |
| D1–D20 | 沿用 1.2.3.1 / 1.2.3.2 全表 | **状态一律不变** |
| D21–D24 | 沿用 1.2.3.3 §5 | **继续保持待批准** |
| D25–D27 | 沿用 1.2.3.3 §5 | **继续保持需批准** |
| **D28（新增）** | O1 监控边界澄清：O1 主行为 = 不处理；监控仅事后观测不构成安全处理保证；「记录到 rejection」≠「已安全处理」；漏捕获矩阵；C109/T132 适用范围说明；O1/O2/O3 仍待批准 | **需批准** |
| **D29（新增）** | 统一错误类型模型（候选 A 子类树 / B 单类+reason）、统一构造签名、`phase`/`reason` 合法值与映射、歧义与优先级规则、调用方判别与处置；**只给设计建议，不新增源码类型** | **需批准** |
| **D30（新增）** | memory 快照拷贝语义**恢复为未闭合**（U32）；`canClone=false` / 无 `structuredClone` 环境的降级候选 K1–K4；禁止静默回退引用共享；不得沿用「已闭合」表述 | **需批准** |
| Q2 / Q11 / Q12 | 沿用 | **待确认 / 待批准** |

> **补充报告 ≠ 批准**。本轮用户未裁定任何 D 项，O1/O2/O3 与 K1–K4 亦未裁定。**全表无一被标记为已批准 / 已确认 / 已解除。**

---

## 7. 未解决问题增量

| 编号 | 问题 | 影响 | 状态 |
| --- | --- | --- | --- |
| U1–U31 | 沿用 1.2.3.3 第 6 章 | —— | 状态不变 |
| **U32（新增，恢复为待解决）** | **memory 快照拷贝语义未闭合**：`canClone=false` 可能把原引用交给 reader；reader 可能通过视图污染 `rows`；失败后可能跨调用复用引用；无 `structuredClone` 环境降级策略未定；`readSnapshot` / 冻结 / 快照副本**源码零落地** | 只读副本契约、返回值不可变性、两驱动一致性均无实现与实测证据；**不得沿用「已闭合」表述** | `【只读核实】` + `【需批准】` D30 + C134–C136 |
| **U33（新增）** | O1 全局监控为**事后观测**，跨 realm / 自定义 thenable / Node 配置 / 测试框架等场景漏捕获；监控不能作为安全处理保证 | 「有监控即安全」的误读；C109/T132 适用范围需收窄说明 | `【设计推导】` + `【需批准】` D28 + C124–C126 |
| **U34（新增）** | `SnapshotError` / `SnapshotContractError` / `SnapshotTransactionError` 三处名称分散、无继承关系、构造签名不兼容（两参 vs 六参）、`cause` 传递不一致 | 两驱动错误类型可能分叉；测试口径不一 | `【只读核实】` + `【需批准】` D29 + C127–C129 |
| **U35（新增）** | memory 既有 `get` / `toArray` 写成 `Promise.resolve(<同步求值>)`，`structuredClone` 抛 `DataCloneError` 时**同步抛**而非 rejected Promise | 既有 TableService 的 Promise 边界分叉；`readSnapshot` 若照抄会违反 P1/P2 | `【只读核实】` + `【待自动化】` C135 |
| **U36（新增）** | `SnapshotPhase` 的 `'open'` / `'commit'` 对 memory 驱动无对应语义、对只读事务易生歧义 | 两驱动 `phase` 语义不对齐 | `【设计推导】` + `【需批准】` D29 |

---

## 8. 准入状态、G9 复核、保护自检与剩余阻塞项

### 8.1 准入状态与 G9 复核

> **未获准入。** 本轮重新核实：`述树统一书籍资产与知识问答架构设计-V1.2.7-阶段1B最终实施门禁审查版.md` **L402 D3 仍「待裁定」**、**L408-413 门禁结论「暂不进入阶段 1B」且 D1–D7 全部待裁定**；v12（五张表补 owner 索引，原生 120）/ v13（owner 可空默认 `'guest'`，原生 130）仍同时被规划。全仓 `*.md` Grep 显示 `spellingErrorEvents` / 打字输入版本协调 / 书面协调结果**只命中本任务自己的 10 份报告**，**未取得任何针对本任务的书面协调结论**。
> **G9 / D9 继续阻塞**；本轮**未决定 Dexie version、未解除 G9、未修改 `stores()` / schema / 表 / 索引**。D21–D27 状态不变，D28–D30 新增需批准，无一被标为已批准。

### 8.2 保护范围自检

| 约束 | 是否遵守 | 说明 |
| --- | --- | --- |
| 不修改源码 / 配置 / 数据库 / 迁移 / Git 暂存区 / 工作区已有文件 | 是 | 全程 Read / Grep / Glob；**未执行任何 git 命令**；未 Write / Edit 到 `src/` 或 `server/` |
| 不修改前提卡、不覆盖并行 Agent 改动 | 是 | 未触 |
| 不决定 Dexie version、不改 `stores()` / schema / 表 / 索引 | 是 | 见 8.1 |
| 不实施清除、不新增局部清除 API | 是 | 零 `clearAll()` 调用 |
| 不新增源码类型 | 是 | 第 2 章类型仅为设计态代码块 |
| 不把 Agent 建议写成用户已批准 | 是 | 0.4 分级表 + 第 6 章全表状态 |
| 保留 C01–C122 / T01–T145、不重编号、不改写旧报告 | 是 | 新增自 C123 / T146 起；旧报告只读 |
| 仅新增一份报告 + 追加一条日志 | 是 | 本报告为唯一新增文档 |
| 全篇五类证据标注 | 是 | 各章表格与段落逐项标注 |
| 完成报告后停止、不进入源码实施 | 是 | 见末尾停止声明 |

### 8.3 剩余阻塞项（沿用 1.2.3.3 §7.3 B1–B9，新增 B10–B12）

| # | 阻塞项 | 类型 | 解除条件 |
| --- | --- | --- | --- |
| B1 | **G9 / D9**：v12、v13 均被并行任务规划，D3 待裁定 | **外部依赖，最高优先** | 并行架构负责人书面回复 1.2.2 §6.4 的 5 条验收标准并留痕 |
| B2–B9 | 沿用 1.2.3.3 §7.3（D25 / D26 / D27 / 既有裁定集 / 自动化与真机 / U27·U28 / U29·U30·U31 / 容量压测） | —— | 状态不变 |
| **B10（新增）** | D28：O1 监控边界澄清、漏捕获残余风险接受 | 设计裁定 + 风险接受 | 批准 1.3–1.6；确认 C109/T132 适用范围说明 |
| **B11（新增）** | D29：错误类型模型（A/B）、`phase`/`reason` 映射与调用方判别 | 设计裁定 | 批准 2.2–2.4；确认不新增源码类型 |
| **B12（新增）** | D30 / U32：memory 拷贝降级候选 K1–K4 与未闭合项验证 | 设计裁定 + 验证 | 批准 4.4；C134–C136 / T157–T159 自动化与真机通过后才可改写表述 |

### 8.4 实施前置条件（累积）

1. B1 G9 关闭并取得书面版本协调结论；
2. D21–D30 与 B2–B9 全部裁定完成（含 O1/O2/O3、K1–K4、错误模型 A/B）；
3. C123–C136 / T146–T159 自动化用例落地并通过；
4. 真机矩阵通过：浏览器多 realm（页面 / iframe / Worker / SW）、Node 三种 `--unhandled-rejections` 模式、双标签与升级窗口、IndexedDB 配额压测（U3 / U14 / U24 / U30）；
5. 三份并行改动文件（`types.ts` / `web.ts` / `memory.ts`）按 G9 验收第 5 条确定合并顺序与冲突解决人；
6. 前提卡红线复核（绝不编造数据、空数据才走 `EmptyState`、已写好代码不顺手改）；
7. **U32 闭合**：memory 快照拷贝语义须有实现 + C134–C136 实测证据，方可从「未闭合」改写；在此之前所有相关表述保持「待解决」。

### 8.5 本轮未实测 / 未执行（如实列出）

- 未运行 `npx tsc --noEmit`、`npm test`、`npm run build`、`python scripts/check_pwa.py`；`npm run build` 会写 `dist/`，与本轮约束冲突。
- 未执行任何 `clearAll()`、`db.transaction`、Dexie 版本升级或数据库迁移；未打开真实 IndexedDB。
- 未执行 C01–C136 / T01–T159 中任何一项测试；**未观测真实 `unhandledrejection` 事件、未验证 Node 各 rejection 模式、未验证跨 realm / Worker / SW 行为、未实测 `structuredClone` 在目标浏览器的可用性与 `DataCloneError` 行为**。
- 未重新执行 `git status` 等可能刷新索引的命令；Git 基线沿用前轮只读记录。
- 未向并行架构负责人发送协调请求，未取得任何新的 v12 / v13 书面结论。
- 第 1 章的浏览器 / Node rejection 机制为 `【设计推导】`，**不是实测结论**；不同引擎版本 / 启动参数 / 测试框架可能改变行为。

> **本报告全部设计证明为 `【设计推导】`。在 B10–B12 与真机验证完成前，不得声称**：「O1 已由监控安全兜底」「错误类型已统一」「两驱动 Promise 边界已验证一致」「Promise 包装已消除异步副作用」「memory 快照拷贝语义已闭合」「G9 已解除」。

---

> **已停止。** 本报告完成后不进入源码实施，不进入迁移，不解除 G9，等待负责人审阅与裁定。
