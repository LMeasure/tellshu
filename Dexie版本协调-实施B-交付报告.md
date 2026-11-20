# Tellshu Dexie 版本协调 · 实施 B 交付报告（2026-11-05）

> **依据**：《Tellshu 项目全面推进授权书》（八阶段全面授权）。
> **性质**：源码实施 + 自动化测试 + 真机回归的**执行记录**，不是设计建议。
> ⚠️ **状态更新（2026-11-05 18:16 (GMT+8)）**：G9 已由项目负责人本对话书面裁决标记 **CLOSED**、D9 **解除**；本行以下「G9 仍不关闭 / D9 阻塞」为当时快照，最新状态见 `G9-负责人确认单.md` 与 `Dexie版本协调-G9-D9-结论.md` §十三。
> **总判定**：版本协调正确、跨标签单写者锁与 U16 恢复链已落地、错词事件写入/幂等结算/启动 drain 已打通，四件套 + 77 项新断言 + 10 项真机回归全绿。**G9 仍不关闭、D9 保持阻塞** —— 关闭闸门需要项目负责人书面确认与签字，本轮不代签、不伪造。
> **未触碰**：生产数据库、真实用户数据、密钥、Git 写操作（无 add/commit/push）。

---

## 〇、一句话总览

把「第一阶段只写在纸上的锁与恢复协议」真正接进了代码和页面：存储层补单表原子 CAS，会话写入全部改为 CAS + 锁守卫，错词事件按 T-A→T-B→T-C 落盘并可被启动 drain 幂等重放，`main.tsx` 挂上恢复钩子，页面加取锁闸门/心跳/冲突面板/显式接管。真机 Edge 双标签实测：接管后旧标签写入被拒，升级事务回滚再重启后事件不丢、无重复结算。

---

## 阶段一 · 核实当前真实源码与历史实施记录

**实际完成**
- 读《产品前提卡-给协作方.md》正本、`.workbuddy/memory/2026-11-05.md` 及 11-04 日志、`git status` / `git log` / 暂存区、6 份「第一阶段交付」设计稿、打字链路 `Phase1.2.x` 索引、`Dexie版本协调-G9-D9-结论.md` §十。
- 逐文件核实：`src/services/storage/{web,memory,types}.ts`、`src/domain/{types,spelling,spellingSession}.ts`、`src/main.tsx`、`src/pages/Spelling.tsx`、`scripts/test_bookschema_migration.ts`、`package.json`。
- **避免重复实施**：确认 v12（5 表补 `owner` 索引 + 存量回填）、v13（`blocked`/`versionchange` 注册）、v14（`spellingErrorEvents` 建表）已由「实施 A」落地，v×10 映射与 `stores()` 声明未变，原生 IDB 版本仍为 140。本轮**未新增任何 `version()`、未改 `stores()`**。
- **关键事实澄清**：设计稿的 `updateAtomic` / `insertIfAbsent` / `cc` / `applied_error_event_ids` 属于尚未实现的打字链路「单词默写 V2」；当前源码是 V1（`spellingSession.ts`，一次 `put()` 整份覆盖）。设计稿里的原语在源码中 Grep 零匹配。因此不能照搬 V2 状态机，改为把可靠性层叠加到 V1。

**基线测试**：改动前 `npx tsc --noEmit` = 0；`npm test` 退出 0（既有 28 套）；`dataClient` 的 `Invalid URL` 噪声为基线既有，非本轮引入。

**尚存风险**：设计稿与 V1 语义差异较大，V2 业务效果（连对归零 / SRS）本轮明确不实现，保留注入点。

---

## 阶段二 · 修复 v12/v13/v14 版本协调

**实际完成**
- 核实结论：**版本协调本身没有缺陷，无需重复实施**。v12/v13/v14 分版本、不合并，`version(12)` 5 表 `owner` 索引 + 回填 `'guest'`、`version(13)` 同 schema + 生命周期注册、`version(14)` 纯新增表，均与裁定一致。
- 本轮新增的 `tab_id` / `lock_epoch` / `lock_held_at` / `applied_error_event_ids` / `settled_at` / `settle_reason` **全部是行内可选字段**，不进 `stores()`、不触发版本升级；`scripts/test_spelling_reliability.ts` 组 6 实测「新增行内字段后 `status` / `session_id` 索引仍可用」。
- 完善 `blocked` / `versionchange`：从「只打日志 + `db.close()`」升级为**向应用层广播生命周期事件**（`subscribeLifecycle`），`open()` 成功后广播 `ready`；锁模块订阅后丢弃内存态并进入只读。

**修改文件**
| 文件 | 变更摘要 |
|---|---|
| `src/services/storage/web.ts` | 新增生命周期监听器集合与广播；`blocked`/`versionchange` 广播 + 让出连接；`open()` 广播 `ready`；新增 `updateAtomic` / `insertIfAbsent` / `subscribeLifecycle` |
| `src/services/storage/types.ts` | `AtomicUpdate` / `AtomicResult` / `AtomicAbortError` / `StorageLifecycleEvent`；`StorageService` 契约扩 3 个方法 |
| `src/services/storage/memory.ts` | 镜像 3 个方法；新增 `atomicSync` 同步读改写 |
| `src/domain/types.ts` | `SpellingErrorEvent` 扩 4 个行内字段；`status` 增 `'settled_skipped'` |
| `src/domain/spelling.ts` | `SpellingSession` 扩 4 个行内可选字段（锁 + 凭证） |

**测试**：`tsc` 0；v11→v14 迁移既有 25 项断言继续通过；新测试组 6（4 项）。

**尚存风险**：`applied_error_event_ids` 随错误数线性增长，长期存档会膨胀，尚无归档/清理策略（需产品裁定）。

---

## 阶段三 · L2 跨标签单写者锁与 U16 恢复链

**实际完成**（新文件 `src/domain/spellingLock.ts`）
- `TAB_ID`：标签生命周期内稳定（复用 `sessionStorage`，刷新不变、新标签独立；不可用时退化）。
- **fencing token**：`lock_epoch` 在 `takeover` / 租约过期强制接管时原子 `+1`；事件行冻结写入时的 `tab_id` + `lock_epoch`。
- **锁变更全部走单表 CAS**：`acquireSessionLock` / `takeoverSessionLock`（须 `confirmed:true`）/ `releaseSessionLock`（旧标签 `skip` 不写回）/ `renewSessionLock`（心跳）/ `assertSessionLock`（T-A 写前校验，重读 epoch）。
- **锁过期**：软租约前台 30s / 后台 120s，只用于「允许强制接管」；时钟回拨 `now <= heldAt` 一律不判过期。
- **安全降级**：`blocked` / `versionchange` → `invalidateLocalLocks()` → 所有写入被 `LOCK_UNAVAILABLE` 拒绝；须走 `resetAfterReconnect`（open → 重读会话 → 重新取锁）才能解除。
- **U16 五步链**：页面 `recoverSession()` = `resetAfterReconnect` → `drainPendingEvents` → `inputEnabled=true`；取锁前输入框/提交/跳过/暂停全部禁用。
- **九路径接入**：`spellingSession.ts` 的 `mutate`（提交/跳过/暂停）、`createSession`、`resume`、`abandon`、`refreshAvailability`、`fulfillSrsHandoff` 全部改为 CAS + `mergeLockState` 守卫；事件写入与结算各自校验锁；`takeover` / `release` 为独立命令。

**测试**：新测试组 2（20 项）、组 4（9 项）全过；真机 R3/R4/R4b/R5 全过。

**尚存风险**
- T-A（事件表）与 T-B（会话表）仍是**两个独立单表请求**，跨表 TOCTOU 窗口（U11）如实存在；正确性靠 `event_id` 主键 + 凭证幂等 + epoch fencing，不靠跨表原子性。
- C09/T29 残留窗口（U1）**降级未消除**：旧代次事件会被记为 `settled_skipped`（计入错词本、不归零、不触发 SRS、不无限重放）。彻底消除需 L3 跨表事务。
- 租约 30s/120s 为实施取值，**未经产品裁定**。

---

## 阶段四 · v14 事件写入、幂等结算、启动 drain

**实际完成**（新文件 `src/domain/spellingErrorEvents.ts`）
- **T-A**：`appendErrorEventIfOwner` → 锁校验 → `insertIfAbsent`（主键冲突 = `false` = 幂等）。
- **T-B**：`settleErrorEvent` 在会话 CAS 内写 `applied_error_event_ids` 凭证；reducer 内**凭证二次检查**最高优先；`lock_epoch` 不符 → 写凭证 + `settled_skipped`，不归零、不 SRS。
- **T-C**：`markErrorEventStatus` 为非权威展示态，失败只告警，绝不回抛成「结算失败」。
- **V1 生产写路径真实接入**：`submitAttempt` 先做纯函数预演决定是否落事件 → T-A 先于会话 put 落盘 → `mutate` 把 T-B 凭证与 V1 状态在**同一次会话 CAS put** 内原子落库 → T-C 标记；预演与实写不一致时事件标 `aborted` 并告警，不静默留错账本。`skip` 同理。
- **启动 drain**：`main.tsx` 在 `initStorage()` 后调用 `drainPendingEvents()`，`render` 等它完成；只结算本标签能取到锁的会话，被其它活跃标签持锁的保留 `pending`（不抢、不丢、不假报成功）。
- **与 V2 的边界（不编造功能）**：结算业务效果通过 `applyEvent` 注入点预留；默认不改 V1 会话状态，因为 V1 的判错效果已由 `applyAttempt` 在同一次 put 内完成，重复施加会造成计数漂移。

**测试**：新测试组 3（18 项）、组 5（9 项）全过；真机 R2/R2b/R6/R7b 全过。

**尚存风险**：若 T-A 写入本身失败，`submitAttempt` 直接抛错不假报成功（V1 状态也未写，用户可重试）；「事件尚未落盘就被中断」不补造，如实记录。

---

## 阶段五 · 自动化测试与迁移回归

**实际完成**
- 新增 `scripts/test_spelling_reliability.ts`（**77 项断言**，fake-indexeddb 真实库，不 mock 服务层），6 组：存储原语 / L2 锁 / 事件链 / U16 恢复 / V1 生产写路径 / 行内字段与索引。
- 挂入 `package.json` `test` 链（现 **29 套**），并新增 `test:spelling-reliability` 单跑入口。
- 双驱动对照：Dexie 与 memory 均验证 `insertIfAbsent` 幂等与并发 CAS 串行化。
- 迁移回归：既有 `test_bookschema_migration.ts`（v11→v14，25 项）继续全绿。

**最终四件套（全绿）**
| 项 | 命令 | 结果 |
|---|---|---|
| 编译 | `npx tsc --noEmit` | 退出 0，0 错误 |
| 测试 | `npm test` | 退出 0，29 套 0 失败（含新增 77 项） |
| 构建 | `npm run build` | 退出 0，`index-D3PgzJGS.js` 827.68 kB，SW 重生成 |
| PWA | `python scripts/check_pwa.py` | 退出 0，10 项体检通过 |

**失败及修复记录（全部真实发生，不删除断言、不降低标准）**
| # | 失败 | 根因 | 修复 |
|---|---|---|---|
| 1 | 改动后 `npm test` 崩在 `LOCK_UNAVAILABLE` | `assertSessionLock` 误把「租约过期」当作拒绝持锁者的依据，测试的固定时间戳与 `Date.now()` 一比即误判 | 移除该检查；租约只用于 `decideAcquire` 的强制接管兜底 |
| 2 | memory 驱动并发两次 `+1` 只得到 1 | `await t.get()` 在微任务边界交错成 last-writer-wins | 新增 `atomicSync` 同步读改写，全程不 `await` |
| 3 | `AtomicUpdate` 闭包赋值触发 TS2367 | TS 不追踪闭包内对 `let` 的赋值 | 包一层 `state` 对象 |
| 4 | `as Record<string, unknown>` TS2352 / `atomicSync` 泛型过窄 | 接口无索引签名 / 从首个分支窄化 R | 改 `as unknown as` + 显式泛型参数 |
| 5 | 页面 JSX TS1003 语法错 | 批量替换时 `placeholder` 尾部多一个引号 | 精确修正 |
| 6 | 真机 R3/R4/R5 首次全失败 | **流程问题**：UI 改动后未重新 `npm run build`，preview 仍服务旧 bundle（两标签 JS hash 一致排除 SW 缓存） | 重新构建后 R3 通过 |
| 7 | 真机 R4 仍失败（`clicked=false`） | **真实产品缺陷**：接管按钮 `disabled={busy \|\| !session}`，恢复链失败时 React `session` 为 null → 按钮永远禁用，用户卡在只读 | 新增 `lockSessionId`（取自持久化层），按钮改用它，`onTakeover` 用 `sid` |

---

## 阶段六 · 双标签并发、升级中断、崩溃恢复验证

**实际完成**：新增 `scripts/check_reliability_browser.mjs`，puppeteer-core + 系统 Edge，**独立 `userDataDir` 隔离 profile**（不触碰用户日常浏览器数据），端口严格 4174。

**真机结果：10 通过 / 0 失败**
| # | 场景 | 结果 |
|---|---|---|
| R1 | 单标签取锁成功后输入框启用 | PASS |
| R2 / R2b | 错误提交落 1 条 `settled` 事件；会话写入凭证与 `lock_epoch` | PASS |
| R3 | 第二真实标签页进入同一会话 → 冲突面板，不静默并发 | PASS |
| R4 / R4b | 用户显式接管 → 新标签可输入，`lock_epoch` 恰 0→1 | PASS |
| R5 | 旧标签继续写入被拒 → 只读冲突面板 | PASS |
| R6 | 刷新恢复链：输入启用、无遗留 `pending` | PASS |
| R7a | `versionchange` 触发且升级事务回滚（`error:AbortError`，未产生新版本） | PASS |
| R7b | 升级中断后重启：事件与会话不丢、无 `pending`、输入恢复；**事件数仍为 1**（旧标签没多写） | PASS |

**证据产物**：`练习/_reliability-browser/_reliability-browser-report.json` + 5 张截图（`r1` / `r3` / `r4` / `r5` / `r7`）。报告中记录两标签拥有独立 tab id、加载同一 bundle `index-D3PgzJGS.js`。

**明确未覆盖（如实标注，不伪造）**：`db.close()` 瞬间 in-flight 事务逐拍时序；升级中途 kill 浏览器进程；Chromium / Firefox 跨内核矩阵；真实移动端设备与软键盘。

---

## 阶段七 · G9 五条证据与 D4/D12 遗留裁定

**G9 五条逐条状态（证据详见《Dexie版本协调-第一阶段交付/实施B后-G9五条复核.md》）**

| # | 标准 | 实施 B 后 | 证据 |
|---|---|---|---|
| 1 | `spellingErrorEvents` 版本 + 完整 `stores()` 声明 | **技术已具备，待架构负责人书面确认** | `web.ts:258` v14 stores 字符串；新测试组 6 证明索引可用；`kind/status` 枚举仍为草案（新增 `settled_skipped`） |
| 2 | v12 表述 / 是否合并版本 | **已满足（文本层）** | 代码 v12/v13/v14 分版本，本轮未新增 version |
| 3 | ×10 基线、序列、维护人、夹具覆盖全部 v11 表 | **部分满足** | v11→v14 迁移测试 25 项全绿；具体自然人仍待项目负责人指派 |
| 4 | `blocked`/`versionchange` 归属 + 升级窗口中断/恢复约定 | **技术前提已全部具备，待审核人书面确认** | 生命周期广播 + 锁 + drain 钩子 + U16 恢复链落地；77 项自动化 + 10 项真机回归全绿 |
| 5 | 三文件合并顺序、冲突解决人、记录位置 | **部分满足** | 顺序/冲突解决人已明；V1.2.11 收敛稿 §7.3 建议文本**仍未追加**，「双方确认」未发生 |

**总判定：G9 不关闭。** §6.4 明文关闭条件为「五条全部勾选 + 书面记录 + 负责人确认」。本轮补齐的是**技术证据**，不等于负责人确认；不代签、不伪造签字或账号权限。

**D4 / D12 裁定建议（提交负责人，不自行宣布生效）**
- **D4（跨标签处置）**：建议裁定为「采纳 L2 单写者跨标签锁（α）」，并同步批准锁过期/心跳/休眠/安全降级四项实施参数（30s / 120s / 10s）。
- **D12（凭证与 stale 口径）**：建议裁定「`lock_epoch` + 事件 `tab_id`/`lock_epoch` + 凭证语义扩展 + stale 计入错词本但不归零」为**已批准**，并接受残留窗口 U1（错词本可能多一条 `settled_skipped`）。
- **新增待裁定**：`status` 枚举新增 `'settled_skipped'`；`applied_error_event_ids` 长期保留策略。

---

## 阶段八 · D9 上线风险与发布准备评估

**已具备**
- 版本协调正确（v12/v13/v14 分版本，原生 140，本轮零 schema 变更）。
- 迁移为 additive，v11→v14 存量零丢失有自动化证据；Dexie 不可就地降级，回滚方案 = 保留升级前库快照 + 回退代码版本后重新打开（**未做生产演练**）。
- 跨标签写入一致、升级中断可恢复、错词事件不丢不重，均有自动化 + 真机证据。
- 四件套全绿，PWA 产物可发布。

**上线前必须关闭的风险**
| 风险 | 等级 | 解除方式 |
|---|---|---|
| G9 未关闭 / D9 阻塞 | 高 | 项目负责人 + 并行架构负责人书面确认五条并留痕 |
| 具名责任人 Q1/Q8 未指派 | 中 | 组织侧指派（现有文档无自然人/账号，本轮不编造） |
| V1.2.11 收敛稿 §7.3 建议文本未追加 | 中 | 项目负责人授权后并入 |
| 真机 N/A 4 项 | 中 | 补 Chromium/Firefox、杀进程、移动端回归（需设备与时间窗） |
| V2 打字状态机业务效果未实现 | 中 | 产品决策是否实施；当前 `applyEvent` 注入点保留 |
| 生产数据备份 / 回滚演练未做 | 中 | 明确环境、备份策略与演练窗口后再上生产 |
| 事件表与凭证无清理策略 | 低 | 产品定保留期与归档方案 |
| 租约/心跳参数未经产品裁定 | 低 | D4 一并裁定 |

**发布准备结论**：**代码与本地验证层面具备候选发布条件；流程与生产层面尚不具备正式上线条件**。缺的是人类确认、签字、跨内核/杀进程真机矩阵与生产备份演练，不是代码实现。

**下一步具体执行指令**
1. 项目负责人书面确认 G9 五条（重点：标准 1 完整 `stores()` 声明、标准 5 记录位置与双方确认），并签发 D4/D12 裁定。
2. 授权把结论 §5.2 建议文本追加进 V1.2.11 收敛稿 §7.3；指派 Q1/Q8 具名责任人。
3. 需要跨内核/杀进程真机证据时，执行：`npm run build` → `npm run preview -- --port 4174 --strictPort` → `node scripts/check_reliability_browser.mjs`（扩展浏览器路径参数）。
4. 生产发布前：明确环境与备份、做一次 v14→代码回退演练、确认事件表保留策略。
5. 代码入库时按**显式路径** `git add`（本轮未执行任何 Git 写操作；仓库有其它会话的暂存文件，禁止 `git add .`）。

---

## 自检结果与置信度

| 维度 | 置信度 | 依据 |
|---|---|---|
| 源码实施与分层 | 高 | 逐文件可读；`tsc` 0；diff 773 增 / 80 删（已还原 LF 行尾，无噪声） |
| 自动化验证 | 高 | 29 套真实运行，新增 77 项断言，不 mock 服务层 |
| 真机双标签/升级中断 | 中高 | Edge headless + 隔离 profile，10/10；跨内核与进程 kill 未覆盖 |
| 迁移正确性 | 中高 | fake-indexeddb 真实 v11→v14 升级 25 项；未做生产库演练 |
| G9/D9 结论 | 中（事实）/ 低（裁定） | 证据充分，但人类确认与签字缺失，本轮明确不关闭 |
| 「已具备正式上线条件」 | **不成立** | 见阶段八风险表，不夸大 |

**纪律声明**：未删除任何既有断言、未降低验收标准、未伪造测试/构建/真机/生产结果、未编造自然人身份与签字、未触碰生产数据库与密钥、未执行 Git 写操作。
