# 阶段三-D 交付概览：单词默写前端页面与路由

**状态：已完成，四件套验证全绿（tsc=0 / test=0 / build=0 / check_pwa=0）**

> 说明：根目录 `overview.md` 属并行任务（格式转换 V2 交付总览），本概览另起文件名，未覆盖他人工作。

## 做了什么

按方案 V3.2 阶段 D 实现了「单词默写」的完整前端链路，**没有重写阶段 A/B/C 的任何模块**，
全部复用已测试的 `src/domain/spellingSession.ts` 接口：

| 环节 | 落地 |
| --- | --- |
| 入口（D1/D4） | `/review` 页内「单词默写」卡片：模式切换（随机/最近新增/易错词）+「开始默写」，每轮词数**沿用** `studyBatchSize`，不建第二套设置 |
| 练习页（D2） | `/spelling?mode=` —— 出题走 `currentWord(session)` 按 `current_position` 从**持久化队列**取，前端零判分逻辑 |
| 中断恢复（D3） | 刷新恢复 / 暂停-继续 / 放弃；多标签页冲突如实呈现给用户二选一，**不宣称原子互斥** |
| SRS 交接（D4） | 只读 `submitAttempt()` 返回的 `srs` 字段；失败显示「待重试」，**从不显示「已同步」**，从不在 UI 调 `recordQuiz` |
| 结果页（D5） | 独立新路由 `/spelling-result?id=`，**不复用 `/result`**；数字全部由 `aggregateSession()` 实时聚合 |

## 新增/修改文件

- 新增：`src/pages/Spelling.tsx`、`src/pages/SpellingResult.tsx`、`scripts/test_spelling_ui.ts`（86 断言）
- 修改：`src/pages/Review.tsx`（入口卡片）、`src/App.tsx`（2 条路由）、`package.json`（test 链第 25 套）

## 本轮抓出并修掉的两个真问题

1. **真 bug**：`onResume()` 从来没调用 `resume()` —— 暂停后点「继续」回不到练习态，库里也仍是 PAUSED。
   `noUnusedLocals: false` 所以 tsc 没报那个未使用的 import，**是测试暴露出来的**。
2. **测试自身缺陷**：「展示中文释义」硬编码了 4 个种子里 3 个词的释义白名单，
   而 `recent` 选词在时间戳相同时排序不稳定（实测两次跑出不同队列），首词换成 cabbage 就误报失败。
   表现为「单独跑通过、全量 `npm test` 失败 1 项」。已改为按库里真实队列首位断言。

## 验证结果（真实退出码）

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `npx tsc --noEmit` | 0 | 零错误 |
| `npm test` | 0 | **25 套全过，0 失败**（本功能 127+112+17+101+86 = 443 断言） |
| `npm run build` | 0 | 2196 modules，PWA precache 15 entries |
| `python scripts/check_pwa.py` | 0 | 10 项全过 |

另做 preview 冒烟：`/`、`/spelling`、`/spelling-result`、`/review` 四条路由均 200。

## 必须如实说明的限制

- **多标签页不是原子互斥**（`TableService` 无事务 API）—— UI 只把冲突呈现给用户选择，界面文案明说「不保证」。
- **SRS 交接是 at-least-once，不是恰好一次** —— 崩溃窗口内一个词可能被多调度一档；该窗口已由阶段 C 故障注入测试复现。
- **jsdom 无布局引擎** —— 375px 窄屏视觉需人工过一遍。
- **`src/App.tsx` 的 diff 混有并行任务改动**（SearchDock 改版），我的部分是纯追加、未覆盖未还原对方任何一行。

## 下一步

阶段 E（全量验收）。提交时请**按路径显式 `git add`**，不要 `git add .`（工作树有约 99 个并行任务改动）。

完整报告：`练习/阶段三-D-前端页面与路由报告.md`
