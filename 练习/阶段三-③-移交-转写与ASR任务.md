# 阶段 ③ 移交 · 转写 / ASR 任务

> **移交性质：只读审计结果，未修改任何源码，未执行 add / commit / reset / checkout。**
> 来源：单词默写功能阶段 ③「全新 clone 独立构建与依赖闭包审计」（2026-10-27）。
> 完整审计：`练习/阶段三-③-全新clone依赖闭包审计报告.md`

---

## 1. 一句话结论

从正式提交 `dbabf84` 做的**全新 clone 无法通过 `tsc --noEmit`**，
根因是**已跟踪**的 `src/components/transcript/MediaTranscriptImport.tsx`
引用了一批**尚未提交**的源码；同时 `scripts/test_transcript.ts` 也依赖其中两个文件导致测试失败。

按推断得出的归属，这批文件属于「转写 / ASR」任务，共 **7 个**。
**归属与提交范围请由该任务负责人确认。**

---

## 2. 缺失文件清单（7 个）

| # | 文件 | 对外导出的符号（依据引用方的用法推断） | 在原工作区的 Git 状态 |
| --- | --- | --- | --- |
| 1 | `src/lib/download.ts` | `downloadTextFile` | `??` 未跟踪 |
| 2 | `src/domain/transcript/validate.ts` | `validateMediaFile`、`MAX_MEDIA_BYTES` | `??` 未跟踪 |
| 3 | `src/domain/transcript/subtitle.ts` | `toSrt`、`toTxt`、`toVtt`、`formatTimecode` | `??` 未跟踪 |
| 4 | `src/services/asr/index.ts` | `asrService`、`isAsrSupported`、类型 `PickedMedia` | `??` 未跟踪 |
| 5 | `src/services/asr/noop.ts` | （降级实现，由 index 按平台能力选择） | `??` 未跟踪 |
| 6 | `src/services/asr/types.ts` | ASR 服务接口类型 | `??` 未跟踪 |
| 7 | `src/services/asr/web.ts` | Web 端实现（平台 API 落在此文件，符合项目红线） | `??` 未跟踪 |

**传递闭包已核对**：这 7 个文件之间只互相引用（`./types` 等），以及 `subtitle.ts → ./types`（**`./types` 已跟踪**）。
即**不会再拖出第 8、第 9 个缺失文件**。

> ⚠️ 上表「导出符号」是从**引用方**的 usage 反推的，不是读源文件的结论。
> 请以源文件实际内容为准。

---

## 3. 引用位置（精确到行）

### 3.1 生产代码：`src/components/transcript/MediaTranscriptImport.tsx`

```tsx
 8:  import { downloadTextFile } from '@/lib/download'
10:  import { asrService, isAsrSupported, type PickedMedia } from '@/services/asr'
11:  import { validateMediaFile } from '@/domain/transcript/validate'
13:  import { toSrt, toTxt, toVtt } from '@/domain/transcript/subtitle'
```

> ℹ️ 该文件已被提交，但目前**是孤儿组件**——
> `grep -rn "MediaTranscriptImport" src/` 除自身外**零命中**，
> 所以这些坏引用不会让 `vite build` 失败，只让 `tsc --noEmit` 失败。

### 3.2 测试脚本：`scripts/test_transcript.ts`

```ts
11: import { formatTimecode, toSrt, toTxt, toVtt } from '../src/domain/transcript/subtitle'
12: import { MAX_MEDIA_BYTES, validateMediaFile } from '../src/domain/transcript/validate'
```

---

## 4. 失败现象与日志原文

### 4.1 `npx tsc --noEmit` → exit **2**

```
src/components/transcript/MediaTranscriptImport.tsx(8,34):  error TS2307: Cannot find module '@/lib/download' or its corresponding type declarations.
src/components/transcript/MediaTranscriptImport.tsx(10,62): error TS2307: Cannot find module '@/services/asr' or its corresponding type declarations.
src/components/transcript/MediaTranscriptImport.tsx(11,35): error TS2307: Cannot find module '@/domain/transcript/validate' or its corresponding type declarations.
src/components/transcript/MediaTranscriptImport.tsx(13,37): error TS2307: Cannot find module '@/domain/transcript/subtitle' or its corresponding type declarations.
```

日志：`/tmp/clone_tsc.log`

### 4.2 `npm run build` → exit **2**

卡在前置 `tsc --noEmit` 阶段，**`vite build` 根本没跑到**。日志：`/tmp/clone_build.log`

### 4.3 `scripts/test_transcript.ts` → exit **1**

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module
  '…\shushu-clone-audit\src\domain\transcript\subtitle'
  imported from '…\shushu-clone-audit\scripts\test_transcript.ts'
  code: 'ERR_MODULE_NOT_FOUND'
```

日志：`/tmp/one_test_transcript.log`
（在完整 `npm test` 里这套件本来会被更早失败的 `test_convert.ts` 遮住；
我是逐套单独跑才挖出来的。）

### 4.4 不受影响的（`vite build` 单独跑 → exit **0**）

```
✓ 2179 modules transformed
dist/assets/index-a6-a2tpA.js  751.77 kB │ gzip: 241.50 kB
✓ built in 4.11s
```

原因见 §3.1 的「孤儿组件」说明。

---

## 5. 独立 clone 复现方法（可直接照抄）

```bash
# 0) 前提：Node v22.22.2 / npm 10.9.7（本机实测版本）
# 1) 干净 clone（换成你要验证的提交即可）
rm -rf <临时目录>/shushu-clone-audit
git clone --single-branch --branch master \
  "C:/Users/lagom/WorkBuddy/2026-10-02-10-40-40/shutree/述树交付包" \
  <临时目录>/shushu-clone-audit
cd <临时目录>/shushu-clone-audit

# 2) 核对基线
git rev-parse HEAD          # 期望 dbabf849b00df78bf0a9bbb492db304a6d2bdacf
git status --porcelain      # 期望：空

# 3) 安装依赖（走锁文件）
npm ci                      # 期望 exit=0，478 packages

# 4) 跑四项
npx tsc --noEmit            # 当前 exit=2（本节描述的 4 条 TS2307）
npm test                    # 当前 exit=1（先断在 test_convert.ts）
npm run build               # 当前 exit=2（卡在 tsc 前置）

# 5) 把被 && 链遮住的套件挖出来
npx tsx scripts/test_transcript.ts   # 当前 exit=1
```

> ⚠️ **只有全新 clone 的实际结果才能作为「能否独立构建」的结论**；
> 原开发机工作区跑通不能替代它（工作区里有这批未跟踪文件在兜底）。

---

## 6. 需要负责人确认的三件事

1. **归属确认**：上述 7 个文件是否确实属于转写 / ASR 任务？（我按路径与引用方推断，**非实测**）
2. **提交范围**：一次性全提交，还是按功能拆多次提交？建议逐路径 `git add <path>`（**不要 `git add .`**）。
3. **孤儿组件去留**：`MediaTranscriptImport.tsx` 现在没人 import，处于「已提交但不可达」状态。
   若将来接入路由，它会立刻把 `vite build` 打成失败 —— 请在提交这批文件时一并确认该组件的归属与去留。

---

## 7. 明确的非承诺

- ❗ **「补齐这 7 个文件后能否全绿」尚未验证。** 本次审计按纪律**没有**从工作区向 clone 复制任何源码来凑通过结果。
  请在提交后**重做一次全新 clone 审计**（§5）验证。
- ❗ 本次未接触并行任务的暂存区与工作区；未在任何仓库执行 add / commit / reset / checkout。
