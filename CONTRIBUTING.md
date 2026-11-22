# 述树（tellshu）协作规范

> 版本：v1.0 ｜ 建立：2026-11-20 ｜ 适用仓库：`LMeasure/tellshu`
> 目标：支持多人分工协作，同时守住述树的产品红线（数据真实性、离线优先、令牌安全）。

---

## 1. 分支策略

| 分支 | 用途 | 规则 |
|---|---|---|
| `main` | 稳定主线，随时可构建的交付基线 | **保护分支**：禁止直接 push，只接受 PR 合并；合并前四件套全绿 |
| `develop` | 集成分支，各功能分支汇入处 | 允许 Feature 合入；保持可构建 |
| `feature/<线>-<简述>` | 功能开发 | 从 `develop` 切出，一人一分支，做完开 PR |
| `fix/<简述>` | 缺陷修复 | 同上 |
| `docs/<简述>` | 文档 / 规划 / 决策登记 | 同上 |

**分支命名对应六条线**（与《述树-六条线关键文档清单.md》一致）：
- `feature/line1-pwa-*` 主产品离线 PWA
- `feature/line2-server-*` 旁路后端
- `feature/line3-spelling-*` 单词默写 V2
- `feature/line4-assets-*` 统一书籍资产 / 知识问答 / VPS
- `feature/line5-verify-*` 验收 / 多端 / 入库
- `feature/line6-booklink-*` 结构性断点打通

**标准流程**：
```
develop → feature/xxx →（开发+自测）→ PR → develop →（集成验证）→ PR → main
```

---

## 2. 提交规范

格式：`<type>: <一句话说明>`

| type | 用途 |
|---|---|
| `feat` | 新功能 |
| `fix` | 缺陷修复 |
| `docs` | 文档 / 规划 / 决策 |
| `refactor` | 重构（不改变行为） |
| `chore` | 杂项 / 配置 / 入库 |

提交前自检：**不裹他人暂存文件**——`git add` 一律按显式路径，提交前先看 `git diff --cached --name-status`。

---

## 3. 合并前验证（必过，全绿才准合并）

在仓库根目录跑：
```bash
npx tsc --noEmit
npm test
npm run build
python3 scripts/check_pwa.py
```

第四项必须写成 `python3 scripts/check_pwa.py`。只提供 `python3`、PATH 上没有 `python` 时，`python scripts/check_pwa.py` 在脚本启动前就以 127 退出。`scripts/check_pwa.py` 的 shebang 已是 `#!/usr/bin/env python3`，十项体检不因调用名改变。`npm run check:pwa` 调用 `python3 scripts/check_pwa.py`，与上面这一行相同。

改动 `server/` 时另在 `server/` 目录跑：
```bash
npm run typecheck
npm test
npm run build
```

预览固定端口：`npm run preview -- --port 4174 --strictPort`（换端口 SW/Cache/IndexedDB 全作废）。

---

## 4. 述树红线（协作时人人遵守）

1. **绝不编造数据**：词条/释义/音标/例句必须来自真实语料，查不到显示「未收录」；代码里硬编码示例数据视为违规。
2. **空数据走 `EmptyState`**，不用假数据兜底。
3. **平台 API 只在 `src/services/{storage,speech,recording}/web.ts`**；页面禁止直接调 dexie / speechSynthesis / MediaRecorder / getUserMedia；旁路后端统一走 `src/data/dictClient.ts`。
4. **令牌只在 `server/.env`**（已被 `.gitignore` 排除）；前端代码、`import.meta.env`、`dist/` 产物一律不许出现令牌；**永不提交、永不贴进聊天**。
5. **技术栈版本锁死**：React 18.3 + TS 5.5(strict) + Vite 5.4 + Tailwind 3.4 + zustand 4.5 + Dexie 4.4，不擅自升级。
6. **已写好的代码不要动**：只改指定范围，不顺手重构无关文件。
7. **图标按钮带 `aria-label` + `title`**；触摸目标 ≥44px；空数据空态；375px 不横向溢出。
8. 未接入的服务（翻译/OCR/格式转换/AI）如实显示「未接入」，503 走错误态或空态引导，绝不伪造结果。

---

## 5. 前提卡与文档

- 权威《产品前提卡-给协作方.md》正本在上层目录 `shutree/产品前提卡-给协作方.md`（本地，高频改写）。
- 改动影响页面清单 / 数据来源 / 红线 / 技术栈 / 实测事实 → 同步更新前提卡及顶部日期；纯样式 / 内部实现 → 不动。
- 发现前提卡有过时或错误 → 在交付说明指出，不擅自改。

---

## 6. Issues 看板用法

仓库 Issues 按六条线 + 决策分级打 label：
- `line1` ~ `line6`：所属产品线
- `decision`：需负责人拍板的决策项（卡 B / 卡 C）
- `blocked`：被授权 / 资源阻塞
- `good first issue`：适合新成员上手

**认领方式**：在 Issue 下 comment 声明认领，然后开 `feature/lineN-*` 分支开发，PR 里关联 `Closes #<编号>`。

---

## 7. 冲突与共享仓库纪律

本仓库历史上是多会话共享、曾长期未入库。约定：
- 提交前必看 `git diff --cached --name-status`，确认没有别人的文件被误裹。
- 遇到他人未完成的暂存文件，**原样保留**，不要 `reset` / `checkout` / `clean`。
- 不确定归属时，先问，再动。
