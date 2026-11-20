# 03 · 线3：单词默写 V2 / 逐字母打字

> **这是干什么的**：看中文释义写英文的默写练习。11-05 深夜主输入从「整词+回车」改为**逐字符即时判定**（1 字母 = 1 幂等事件）。底层是 v14 错词事件表 + `atomicBatch` 跨表事务 + 跨标签单写者锁。

## 现状：✅ 代码落地 · ⛔ 上线阻塞
G9 = CLOSED、D9 = 解除（11-05 负责人裁决）；四件套全绿、可靠性 118 项、真机 18 项（桌面 Edge）。

## 卡点（R1–R7，见 `交付与测试/打字V2-剩余问题与风险清单.md`）
| 项 | 状态 | 说明 |
|---|---|---|
| **R6 真机/跨内核/备份演练** | ⬜ N/A | **阻塞上线**：Android+iOS、Chrome/Firefox/Safari、备份导出回灌，不得用自动化替代 |
| R3 事件保留策略 | ⛔ 待裁定 | `processed_letters` 体积增长（46–77MB/年属待验证假设），未实施裁剪 |
| R1 D18 `EPOCH_AHEAD` / R2 reset 写入 / R4 租约 / R5 枚举 | 🟡 待裁定 | 卡 A/B 已给推荐值 |
| R7 全局清除 | ⛔ 待立项 | 独立立项，不挂普通按钮 |
| G9 关闭 ≠ 上线条件 | ⛔ 待确认 | 上线前负责人另行裁决 |

## 子目录
- `交付与测试/`：打字 V2 逐字母状态机交付、决策登记、浏览器验收、剩余问题清单。
- `G9与版本协调/`：Dexie v12→v14 协调、G9 关闭冲刺、负责人确认单、第一阶段设计稿。

## 相关源码（根目录原位，不可移动）
`src/domain/{spellingTyping,spellingErrorEvents,spellingErrorStats,spellingLock,spellingWrongBook,spellingSession}.ts` · `src/pages/Spelling.tsx` · `scripts/test_spelling_*.ts` · `scripts/check_reliability_*.mjs`

## 验收证据
见 `05-线5-验收与多端/验收证据/`（G9 / V2 本轮 / 逐字母 / 结果页共 19 份原始输出）。
