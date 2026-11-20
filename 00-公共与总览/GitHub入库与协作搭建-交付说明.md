# 述树 GitHub 入库与协作搭建 · 交付说明

> 时间：2026-11-20 ｜ 仓库：`https://github.com/LMeasure/tellshu`（公开）

---

## 一、改了什么

1. **全量入库**：本地 401 个文件（源码 + 脚本 + 配置 + 六条线交付文档 + 验收证据）提交并推送到远端 `main`。
   - 首个提交 `6531169`（401 files, 100014 insertions），协作规范提交 `b8965fe`。
   - 105 个源码/脚本文件（src / server/src / scripts），72 个二进制（70 PNG + 2 ICO，验收截图）均完整上传。
2. **分支统一**：本地 `master` → `main`，与 GitHub 默认分支一致，并设置 upstream 跟踪。
3. **协作规范**：新增 `CONTRIBUTING.md`（108 行）——分支策略（main/develop/feature/lineN）、提交规范、四件套验证、八条红线、Issues 用法、共享仓库纪律。
4. **Issues 看板**：建立 8 个 Issue（全部来自真实在库文档，非编造）：

| # | Issue | label |
|---|---|---|
| 1 | [META] 协作总览·六条线与破局调度 | documentation, good first issue |
| 2 | [line6][decision] 打通结构性断点 | line6, decision |
| 3 | [line4][decision][blocked] O-4A 执行授权 | line4, decision, blocked |
| 4 | [line3][blocked] 打字V2 上线门禁（真机/跨内核/备份） | line3, blocked |
| 5 | [line4] 知识库/AI 问答落地 | line4, decision |
| 6 | [line2] 6书11,328块 chapter_title NULL | line2 |
| 7 | [decision] 卡C 真资源立项 | decision |
| 8 | [META] develop 分支与协作者权限 | good first issue |

---

## 二、验证了什么

- **本地**：`git status -sb` 显示 `main...origin/main` 同步，`git rev-parse main origin/main` 均为 `6531169`（后为 `b8965fe`）。
- **远端**：GitHub API 列目录确认 `src/`/`server/`/`scripts/`/`public/`/`package.json` 及全部文档存在；401 文件完整。
- **令牌安全**：`git check-ignore -v server/.env` 确认被 `server/.gitignore` 排除；暂存区扫描无 `.env`/令牌文件；只有 `.env.example` 等示例入库。
- **无超大文件**：无 >50MB 文件（GitHub 单文件上限 100MB）。
- **未跑四件套**：本次为入库 + 文档操作，未改任何源码内容，故不触发四件套。

---

## 三、必须坦白的一点（失误与处置）

- **失误**：验证 MCP 推送通道时，误将字面内容「占位」写到了远端 `CONTRIBUTING.md`（测试提交 `1900752`）。
- **处置**：随后用本地 git `push --force` 以完整历史覆盖，`1900752` 已被丢弃；再以正式内容重新提交 `b8965fe`。**远端现在是干净的，无「占位」残留**。
- **风险提示**：本次 force push 覆盖了 _我自己_ 刚建的测试提交，未触及任何他人工作；但 force push 是破坏性操作，特此留痕。

---

## 四、需要你决策/操作什么

1. **按你的裁决纳入了 6 个他人 B12 暂存文件**：这与项目原红线「勿裹他人暂存文件」相悖。你本轮明确选择「全部含他人暂存文件」，我照办并在提交信息里记录。若这 6 个文件属于其他在途会话、不应公开，请告知，我可单独处理（但它们已在公开仓库，需尽快决定）。
2. **公开仓库**：`LMeasure/tellshu` 当前是 public。若源码不宜公开，请改为 private。
3. **协作基础设施**（AI 无法代做，需你在 GitHub 设置里操作）：
   - Settings → Collaborators：添加成员并分配权限；
   - Settings → Branches：给 `main` 加保护规则（require PR + 检查通过）。
4. **develop 分支**：Issue #8 待认领；你确认后我可从 `main` 切出 `develop`。
5. **前提卡**：`产品前提卡-给协作方.md` 正本在上层目录（不在本仓库内），本次入库的是仓库内的同名文件（已被删除状态），**未改动正本**。前提卡「在线地址」字段记录的旧网址需不需要更新为新 GitHub 地址，请你决定（我不擅自改）。

---

## 五、还有什么没做

- 未建 `develop` 分支、未加分支保护（等你确认）。
- 未添加任何协作者（需你在 GitHub 设置操作）。
- 未改任何产品源码 / 数据库 / 密钥 / 前提卡正本。
- 网络备注：本地 git 直连 GitHub 不通，必须走代理 `127.0.0.1:62789`；默认 schannel SSL 后端与代理冲突，需用 `GIT_SSL_BACKEND=openssl`。日后推送若报 `schannel ... close_notify` 或代理 502，按此处理或重试。
