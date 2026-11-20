# 阶段 ③ · 全新 clone 独立构建与依赖闭包审计报告

**执行方式：只审计，不修复。** 未修改正式工作区，未启动/停止服务，未触碰 `.env` 与数据库，
未在任何仓库执行 `git add` / `commit` / `reset` / `checkout`，未从工作区向 clone 复制任何源码。

执行时间：2026-10-27 03:05–03:12（GMT+8）｜审计对象：正式提交 `dbabf84`

---

## 1. Clone 基线与环境

| 项目 | 实测值 |
| --- | --- |
| clone 路径 | `C:\Users\lagom\AppData\Local\Temp\shushu-clone-audit`（独立临时目录，非原工作区） |
| clone 方式 | `git clone --single-branch --branch master <原仓库> <临时目录>` |
| **HEAD** | `dbabf849b00df78bf0a9bbb492db304a6d2bdacf`（`dbabf84`） |
| **父提交** | `28b957ebe6886c7048d982c512e1668f69ec6850`（`28b957e`）✅ 未 amend、未重写历史 |
| 工作区状态 | **干净**（`git status --porcelain` 无任何输出） |
| 分支 | `master` |
| Node | **v22.22.2** |
| npm | **10.9.7** |
| Python | **3.13.14** |
| registry | `https://registry.npmmirror.com` |
| 锁文件 | `package-lock.json`，291,993 字节，**存在且与 package.json 同步**（`npm ci` 通过） |
| 磁盘可用 | 131 GB（充足） |

---

## 2. 本地导入依赖闭包清单

扫描工具：临时脚本（放在 `/tmp`，不在 clone 内），扫描 clone 中 **177 个** `.ts/.tsx/.mjs` 文件
（`src/**` 与 `scripts/**`），成功解析本地引用 **581 处**，外部包引用去重后 13 个。

### 2.1 ❌ 被引用但在 `dbabf84` 中不存在的本地模块（7 处引用 → 5 个模块）

| # | 缺失模块 | 引用位置 | 影响面 |
| --- | --- | --- | --- |
| 1 | `@/lib/download`（`src/lib/download.ts`） | `src/components/transcript/MediaTranscriptImport.tsx:8` | tsc 失败 |
| 2 | `@/services/asr`（目录，`src/services/asr/index.ts`） | `src/components/transcript/MediaTranscriptImport.tsx:10` | tsc 失败 |
| 3 | `@/domain/transcript/validate`（`src/domain/transcript/validate.ts`） | `src/components/transcript/MediaTranscriptImport.tsx:11`<br>`scripts/test_transcript.ts` | tsc 失败 + 测试失败 |
| 4 | `@/domain/transcript/subtitle`（`src/domain/transcript/subtitle.ts`） | `src/components/transcript/MediaTranscriptImport.tsx:13`<br>`scripts/test_transcript.ts` | tsc 失败 + 测试失败 |
| 5 | `../src/domain/convert`（`src/domain/convert.ts`） | `scripts/test_convert.ts` | 仅测试失败（`scripts/` 不在 tsconfig include） |

### 2.2 ✅ 澄清：先前报告提到的另两个模块**不在闭包内**

阶段 E 报告曾提到 `src/components/convert/` 与 `src/services/convert/`。本次实测订正：

- 二者只被**工作树版**的 `src/pages/Import.tsx` 引用；该改动尚未提交，
  **HEAD/commit 版的 `Import.tsx` 不含任何 convert 引用**。
- 因此在 `dbabf84` 的 clone 里，扫描器**完全没有**检测到对它们的引用 ——
  它们**不影响**本次独立构建。（但将来若提交那份工作树版 `Import.tsx`，会立刻变成新缺口。）

### 2.3 ✅ 单词默写本功能：闭包完整，零缺失

`src/domain/spelling.ts`、`spellingSession.ts`、`src/pages/Spelling.tsx`、`SpellingResult.tsx`、
`Review.tsx` 入口改动、Dexie v10 存储改动、两条路由 —— **全部已提交，无任何悬空引用**。
5 套默写测试在 clone 中逐一跑过，**全部通过**（见 §3.2）。

### 2.4 传递闭包（用于确定最小修复集）

| 缺失模块 | 其自身的本地 import | 是否又拖新的缺失 |
| --- | --- | --- |
| `src/lib/download.ts` | 无 | 否 |
| `src/domain/convert.ts` | 无（仅注释里提到 `services/convert`，非真实 import） | 否 |
| `src/domain/transcript/validate.ts` | 无 | 否 |
| `src/domain/transcript/subtitle.ts` | `./types`（**已跟踪**） | 否 |
| `src/services/asr/index.ts` | `./web` `./noop` `./types` | 否（同目录内部） |
| `src/services/asr/web.ts` | `./types` | 否 |
| `src/services/asr/noop.ts` | `./types` | 否 |
| `src/services/asr/types.ts` | 无 | 否 |

---

## 3. 四项检查的退出码、关键错误与失败阶段

### 3.1 依赖安装（前置）

```
npm ci  →  exit=0     added 478 packages in 22s
```

结论：依赖安装与锁文件**没有问题**，无需外网异常说明以外的额外条件。

### 3.2 四项检查

| # | 命令 | 退出码 | 结果 | 失败阶段 |
| --- | --- | --- | --- | --- |
| 1 | `npx tsc --noEmit` | **2** | ❌ 失败 | 类型检查，4 个 TS2307 |
| 2 | `npm test` | **1** | ❌ 失败 | **第 13 套 `test_convert.ts`** 处中止（`&&` 链断裂），后续 12 套未执行 |
| 3 | `npm run build` | **2** | ❌ 失败 | **前置 `tsc --noEmit` 阶段**中止，`vite build` 根本没跑到 |
| 4 | `python scripts/check_pwa.py` | **0** | ⚠️ 仅在本报告手动补跑 `vite build` 生成 `dist/` 后才通过，见 §3.4 | — |

**① tsc 的完整错误输出（4 条，全部集中在同一个文件）**

```
src/components/transcript/MediaTranscriptImport.tsx(8,34):  error TS2307: Cannot find module '@/lib/download' or its corresponding type declarations.
src/components/transcript/MediaTranscriptImport.tsx(10,62): error TS2307: Cannot find module '@/services/asr' or its corresponding type declarations.
src/components/transcript/MediaTranscriptImport.tsx(11,35): error TS2307: Cannot find module '@/domain/transcript/validate' or its corresponding type declarations.
src/components/transcript/MediaTranscriptImport.tsx(13,37): error TS2307: Cannot find module '@/domain/transcript/subtitle' or its corresponding type declarations.
```

**② npm test 的中止点**

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module
  '…\shushu-clone-audit\src\domain\convert' imported from
  '…\shushu-clone-audit\scripts\test_convert.ts'
```

### 3.3 逐套诊断（把被 `&&` 链遮住的部分挖出来）

链断在第 13 套后，我**逐套单独跑**了剩余 12 套（`npx tsx scripts/*.ts`）：

| 套件 | 结果 | 断言/备注 |
| --- | --- | --- |
| `test_transcript` | ❌ FAIL | `ERR_MODULE_NOT_FOUND`（subtitle / validate） |
| `test_transcript_store` | ✅ PASS | — |
| `test_study_note_generate` | ✅ PASS | — |
| `test_study_note_dict` | ✅ PASS | — |
| `test_irregular` | ✅ PASS | — |
| `test_vocab_senses` | ✅ PASS | — |
| `test_discover` | ✅ PASS | — |
| **`test_spelling`** | ✅ PASS | **127 项断言** |
| **`test_spelling_session`** | ✅ PASS | **112 项断言** |
| **`test_spelling_migration`** | ✅ PASS | **17 项断言** |
| **`test_spelling_srs_handoff`** | ✅ PASS | **101 项断言** |
| **`test_spelling_ui`** | ✅ PASS | UI 套全通过 |

汇总：**25 套中 23 套通过，2 套失败**（`test_convert` 是把 `&&` 链打断的那套，`test_transcript` 是单独诊断出的第二套）。

### 3.4 ⚠️ 一个重要发现：`vite build` 单独跑是成功的

```
npx vite build  →  exit=0
  ✓ 2179 modules transformed
  dist/assets/index-a6-a2tpA.js  751.77 kB │ gzip: 241.50 kB
  precache 15 entries (1226.22 KiB)
  ✓ built in 4.11s
```

原因核实：`grep -rn "MediaTranscriptImport" src/` **零命中**（除自身）⇒ 该组件是**孤儿文件**，
没有任何路由或组件 import 它 ⇒ Rollup 根本不会去解析它 ⇒ 打包不受影响。

**这意味着**：缺失模块破坏的是「类型检查」这条防线，而**不是**运行时产物。
`check_pwa.py` 之所以能跑出 exit=0，是因为我手动补了 `vite build`；
若按仓库定义的 `npm run build` 顺序，产物根本生成不出来。

> 说明：我**没有**从原工作区复制任何未提交源码到 clone 里来验证「补上文件后是否通过」。
> 因此「补上 §5 清单即可全绿」目前是**待验证假设**，需在实施修复后实测确认。

---

## 4. 问题分类

| 类别 | 结论 | 明细 |
| --- | --- | --- |
| **① 正式提交确实缺失的源码** | ⚠️ **存在，8 个文件** | `src/lib/download.ts`、`src/domain/convert.ts`、`src/domain/transcript/{validate,subtitle}.ts`、`src/services/asr/{index,noop,types,web}.ts`。原工作区里它们全是 `??` 未跟踪状态 ⇒ 属**其他会话从未提交**。 |
| **② 包或锁文件问题** | ✅ **无** | `npm ci` exit=0，478 包 22 秒装完，锁文件与 `package.json` 一致。 |
| **③ 环境 / 网络限制** | ✅ **无阻断** | 走内网 registry 正常；未访问 `.env`、数据库或任何外部服务。唯一的「环境依赖」是 `check_pwa.py` 需要 Python（本机 3.13.14 可用）。 |
| **④ 与本功能无关的既有问题** | ⚠️ **是，且这是本次全部失败的唯一原因** | 4 条 tsc 错误 + 2 套测试失败，**100% 指向转写/ASR/格式转换那批未提交源码，与单词默写毫无关系**。反之，单词默写的源码、路由、5 套测试在干净 clone 里全部完好通过。 |

### 补充：一处可维护性风险（不属于构建失败，但值得记录）

`src/components/transcript/MediaTranscriptImport.tsx` 当前是**孤儿文件**——
它已被提交、引用了不存在的模块，但因为没人 import 它，`vite build` 不会报错。
**只要将来有人把它挂到路由上，`vite build` 会立刻从「成功」翻转为「失败」。**
即现在是个被树摇掩盖的定时炸弹，建议在补 8 个文件时一并确认该组件的去留。

---

## 5. 最小修复建议与涉及文件清单（**本阶段不实施**）

### 5.1 最小集：8 个文件（按所属任务分组）

| 所属任务 | 缺失文件 | 判定依据 / 归属说明 |
| --- | --- | --- |
| **转写 / ASR 任务** | `src/lib/download.ts` | 导出 `downloadTextFile`，被 `MediaTranscriptImport.tsx` 用于五格式导出（TXT/SRT/VTT/CSV/JSON） |
| **转写 / ASR 任务** | `src/domain/transcript/validate.ts` | 导出 `validateMediaFile`，媒体文件校验；`scripts/test_transcript.ts` 也依赖它 |
| **转写 / ASR 任务** | `src/domain/transcript/subtitle.ts` | 字幕文本处理；被 `MediaTranscriptImport.tsx` 与 `scripts/test_transcript.ts` 共同依赖 |
| **转写 / ASR 任务** | `src/services/asr/index.ts`<br>`src/services/asr/noop.ts`<br>`src/services/asr/types.ts`<br>`src/services/asr/web.ts` | ASR 服务适配层（平台 API 落在 `web.ts`，符合「平台 API 只准出现在 services/**/web.ts」红线） |
| **格式转换任务** | `src/domain/convert.ts` | 只被测试脚本 `scripts/test_convert.ts` 引用；`src/` 内无引用 ⇒ 不影响打包与 tsc，仅让 `npm test` 断链 |

> ⚠️ **归属是我依据「文件路径 + 引用方 + 项目既有文档」作出的推断，不是实测**，
> 最终以对应任务负责人确认为准。移交文档见
> `阶段三-③-移交-转写与ASR任务.md` / `阶段三-③-移交-格式转换任务.md`。

这 8 个文件已在 §2.4 核过传递闭包：**它们不再拖入任何新的缺失模块**，
可以直接用 `git add <path>` 逐个路径提交（**不要 `git add .`**）。

### 5.2 ❗ 明确不作为结论陈述的一件事

**「补齐这 8 个文件后能否全绿」尚未验证。**

按本阶段纪律，我没有从工作区向 clone 复制任何未提交源码来凑出通过结果，
因此这点目前仍是**待验证假设**，必须在补完后**重做一次全新 clone 审计**才能下结论。
本报告不把推测性修复方案写成已验证结论。

### 5.2 建议的执行方式

1. **归属确认**：这 8 个文件分属「转写 / ASR」与「格式转换」两个别的任务。
   按既定纪律——*不得把它们塞进本功能的提交*，建议由对应任务自行提交，
   或经用户授权后由我按路径显式提交，并在提交信息里写明来源任务。
2. **验证方式**：提交后，**重做一次全新 clone 审计**（重跑本报告 §3 的四项），
   以 clone 结果为准，不以原工作区结果为准。
3. **孤儿组件一并确认**：同时决定 `MediaTranscriptImport.tsx` 是接入还是移除，
   避免它在未来把 `vite build` 打成失败（见 §4 补充）。

### 5.3 明确不在本阶段做的事

- ❌ 不提交上述 8 个文件（本阶段只审计）
- ❌ 不向 clone 复制任何工作区源码来制造通过结果
- ❌ 不 amend `28b957e` 或 `dbabf84`
- ❌ 不改动并行任务的暂存区或工作区

---

## 6. 阶段 ③ 结论

| 结论 | 判定 |
| --- | --- |
| **全新 clone 能否独立构建** | ❌ **不能**（`npm run build` exit=2，卡在 `tsc --noEmit`） |
| **失败根因** | 正式提交缺失 8 个别的任务的源码文件，导致 4 条 TS2307 |
| **依赖与锁文件** | ✅ 无问题 |
| **环境/网络** | ✅ 无阻断 |
| **单词默写本功能在 clean clone 中的状态** | ✅ **完整且自洽**：源码、路由、5 套测试（127+112+17+101+UI）全部通过，无任何悬空引用 |
| **产物能否生成** | ⚠️ 能，但需绕过 `npm run build` 的 tsc 前置直接跑 `vite build` —— 缺失文件在孤儿组件里，被摇树掩盖 |

**本次验证才是「独立构建」的真实结论；原工作区四件套全绿不能替代它。**

> ⚠️ **边界提示（不可扩大解读）**：单词默写 5 套测试在干净 clone 中通过，
> 只说明**本功能自身闭包完整**，**不能据此宣称整个仓库已可独立构建** ——
> 仓库级构建仍因 §5.1 的 8 个缺失文件而失败。

---

## 7. 审计现场保全（供复核）

按用户指示**暂不删除**临时 clone，现场完整保留。

### 7.1 现场位置与状态

| 项目 | 值 |
| --- | --- |
| clone 路径 | `C:\Users\lagom\AppData\Local\Temp\shushu-clone-audit`（≈223 MB，含 `node_modules/` 与 `dist/`） |
| HEAD | `dbabf849b00df78bf0a9bbb492db304a6d2bdacf` |
| HEAD^ | `28b957ebe6886c7048d982c512e1668f69ec6850` |
| 分支 | `master` |
| 工作区 | **干净**（`git status --porcelain` 无输出；`dist/`、`node_modules/` 已被 `.gitignore:5` / `.gitignore:2` 忽略） |
| 审计时点 | 2026-10-27 03:05–03:15（GMT+8） |

### 7.2 检查日志清单

| 日志 | 路径 | 内容 |
| --- | --- | --- |
| `npm ci` | `/tmp/clone_npmci.log`（94 B） | 478 包安装成功 |
| `npx tsc --noEmit` | `/tmp/clone_tsc.log`（631 B） | 4 条 TS2307 |
| `npm test` | `/tmp/clone_test.log`（46,747 B） | 链断在第 13 套 |
| `npm run build` | `/tmp/clone_build.log`（687 B） | 卡在 tsc 前置 |
| `npx vite build`（诊断） | `/tmp/clone_vitebuild.log`（1,265 B） | exit=0 |
| `python scripts/check_pwa.py` | `/tmp/clone_pwa.log`（853 B） | 10 项通过 |
| 依赖扫描摘要 | `/tmp/clone_scan.txt` | 177 文件 / 581 处解析 / 7 处缺失 |
| 缺失清单（机器可读） | **`C:\tmp\audit_missing.json`**（654 B） | ⚠️ 注意见下方说明 |
| 逐套诊断日志 | `/tmp/one_test_*.log`（12 个） | 被 `&&` 链遮住的后续套件结果 |

> ⚠️ **路径坑**：扫描脚本用 Python 写 JSON，Windows 版 Python 把 `/tmp/...` 解析为
> `C:\tmp\...`，而 bash 重定向写出的日志落在 git-bash 的 `/tmp`
> （= `AppData\Local\Temp`）。两边不是一个目录，找证据时别搞混。

### 7.3 `audit_missing.json`（缺失清单原文）

```json
{
  "@/lib/download":                ["src:src/components/transcript/MediaTranscriptImport.tsx"],
  "@/services/asr":                ["src:src/components/transcript/MediaTranscriptImport.tsx"],
  "@/domain/transcript/validate":  ["src:src/components/transcript/MediaTranscriptImport.tsx"],
  "@/domain/transcript/subtitle":  ["src:src/components/transcript/MediaTranscriptImport.tsx"],
  "../src/domain/convert":         ["scripts:scripts/test_convert.ts"],
  "../src/domain/transcript/subtitle": ["scripts:scripts/test_transcript.ts"],
  "../src/domain/transcript/validate": ["scripts:scripts/test_transcript.ts"]
}
```

### 7.4 对正式工作区零影响（已复核）

| 核验项 | 实测 |
| --- | --- |
| 正式工作区 HEAD | `dbabf849b00df78bf0a9bbb492db304a6d2bdacf`（**未变**） |
| 是否执行 add / commit / reset / checkout | **否**（全程未在任何仓库执行） |
| 他人暂存区 | 6 个 B12 文件仍为 `A`，**原封不动** |
| 本会话改动的源文件 | **无**；工作树里 `src/domain/types.ts` 仍是审计开始前的并行任务改动状态 |
| 是否复制工作区源码进 clone | **否**（这是本报告结论可信度的前提） |
| 是否启停服务 / 改 `.env` / 碰数据库 | **否** |

> 注：`git diff --stat -- src/pages/` 会看到 `Profile.tsx`、`Reader.tsx` 等文件的差异，
> 那是**其他既有并行任务的工作树改动**，与本阶段无关，本阶段未触碰。

---

## 8. 本阶段文档变更与移交

| 文档 | 作用 |
| --- | --- |
| `练习/阶段三-③-全新clone依赖闭包审计报告.md` | 本报告（含第 7 节现场保全） |
| `练习/阶段三-③-移交-转写与ASR任务.md` | 向转写/ASR 任务移交 7 个缺失文件 |
| `练习/阶段三-③-移交-格式转换任务.md` | 向格式转换任务移交 1 个缺失文件 |
| `练习/阶段三-E-全量验收报告.md` | 已追加 §11「四类验证结果口径区分」 |
