# Stage B 收尾 · Git 待提交清单

> 本轮**未执行任何提交**。当前 HEAD 仍为 `f2174ba chore: 建立项目初始基线（述树 ShuShu 交付包）`。
> 生成日期：2026-10-10
> 规则提醒：禁止 `git add .`，一律按显式路径 add。

---

## A. 修改原因 → 是否建议提交

### A1. 文档（建议提交）

| 文件 | 修改原因 | 建议 |
|---|---|---|
| `StageB-资产冻结检查报告.md` | 新增：本轮资产冻结只读检查结论（PASS） | ✅ 提交 |
| `发现书籍链路-StageB最终报告.md` | 新增：按修正后分母口径重算的阶段 B 最终报告 | ✅ 提交 |
| `产品前提卡-发现书籍数据源-合并diff.md` | 新增：前提卡合并 diff（只出 diff，未覆盖原文件） | ✅ 提交 |
| `StageB-Git待提交清单.md` | 新增：本清单 | ✅ 提交 |
| `发现书籍链路-Stage2-阶段B-HNSW参数实验报告.md` | 上一轮产出：阶段 B 首轮报告。分母口径以**最终报告**为准 | ⚠️ 建议提交但需加注「已被《StageB最终报告》取代」 |
| `发现书籍链路-批次A-候选书单.md` | 上一轮产出：A 组 20 本候选，等用户拍板后才有意义 | ⏸ 暂缓（待阶段 C 决策） |
| `产品前提卡-合并对照-发现书籍数据源与数据治理.md` | 上一轮中间稿 | ⏸ 暂缓（以最终合并 diff 为准） |
| `产品前提卡-最终合并差异-发现书籍数据源与数据治理.md` | 上一轮中间稿，已被新的合并 diff 取代 | ⏸ 暂缓（建议合并完成后删除） |
| `发现书籍链路-Stage2前置召回实验方案.md` | **唯一被修改的已跟踪文件**（上一轮加 §4.0 指标口径，+52/−12） | ✅ 提交（与阶段 B 口径一致） |

### A2. 脚本（建议提交）

| 文件 | 修改原因 | 建议 |
|---|---|---|
| `server/src/scripts/hnsw-experiment.py` | 本轮修统计口径（探针计入分母 bug）+ 实验对象打 COMMENT 标记 | ✅ 提交 |
| `server/src/scripts/test_hnsw_counted.py` | 新增：分母判据单元测试（9 项全过） | ✅ 提交 |
| `server/src/scripts/make-stageb-report.py` | 新增：最终报告生成器（保证报告可复现） | ✅ 提交 |
| `server/src/scripts/discover-queries-stage2.txt` | 上一轮新增：统一查询集（16 条） | ✅ 提交 |
| `server/src/scripts/summarize-hnsw-exp.py` | 上一轮新增：阶段 B 汇总脚本 | ✅ 提交 |
| `server/src/scripts/render-candidates.py` | 上一轮产物，未在本次核对范围内 | ⏸ 暂缓（待确认用途） |

### A3. 数据与临时产物（不建议提交）

| 文件 | 修改原因 | 建议 |
|---|---|---|
| `server/.hnsw-exp-matrix.json` | 54 组原始结果，**14.1 MB** | ❌ 不提交（体积大、可由脚本重跑） |
| `server/.hnsw-smoke.json` | 连通性验证产物，988 KB | ❌ 不提交 |
| `server/.hnsw-summary.txt` | 汇总文本（旧口径） | ❌ 不提交 |
| `server/.hnsw-exp-probe.json` | 探针验证产物 | ❌ 不提交 |
| `server/.exact-baseline-latency.json` | 精确基线延迟补测结果 | ⚠️ 数据小但属派生数据，建议不提交（已固化进最终报告） |
| `server/.tmp_analyze_hnsw.py` | 临时分析脚本 | ❌ 不提交 |
| `server/.tmp_asset_freeze_check.py` | 临时只读检查脚本 | ❌ 不提交 |
| `server/.tmp_exact_latency.py` | 临时补测脚本 | ❌ 不提交 |
| `server/src/scripts/__pycache__/` | Python 字节码缓存 | ❌ 不提交（且应忽略） |
| `server/.candidate-render.md` | 上一轮候选渲染中间稿 | ❌ 不提交 |

---

## B. ⚠️ 当前 .gitignore 的缺口（建议补，等确认再动）

实测 `git check-ignore` 结果：以下文件**目前未被忽略**，一旦执行 `git add .` 就会被误提交：

| 路径 | 风险 |
|---|---|
| `server/.hnsw-exp-matrix.json` | 14 MB 实验数据 |
| `server/.hnsw-smoke.json` / `.hnsw-summary.txt` / `.hnsw-exp-probe.json` | 派生产物 |
| `server/.exact-baseline-latency.json` | 派生产物 |
| `server/.tmp_*.py` | 临时脚本（现 .gitignore 只有 `.tmp_*.md`） |
| `server/src/scripts/__pycache__/` | 字节码缓存 |
| `.crawl-cache/` | 抓取原始缓存（含全文，按 §6A.4 不进 git） |
| `.candidate-plan.json` / `.eval-*.json` | 候选与评测中间产物 |

**建议新增的忽略规则**（未执行，等你点头）：

```gitignore
# ── 发现书籍链路：实验与中间产物 ──────────────────────────
.hnsw-*
.exact-baseline-latency.json
.tmp_*.py
.crawl-cache/
.candidate-plan.json
.eval-*.json
__pycache__/
```

---

## C. 建议的提交顺序（等你批准后执行）

```bash
# 1) 先补 .gitignore 缺口（可选，建议）
# 2) 按显式路径提交文档
git add StageB-资产冻结检查报告.md 发现书籍链路-StageB最终报告.md \
        产品前提卡-发现书籍数据源-合并diff.md StageB-Git待提交清单.md
# 3) 提交脚本
git add server/src/scripts/hnsw-experiment.py \
        server/src/scripts/test_hnsw_counted.py \
        server/src/scripts/make-stageb-report.py \
        server/src/scripts/discover-queries-stage2.txt \
        server/src/scripts/summarize-hnsw-exp.py
# 4) 提交上一轮遗留的已跟踪文件改动
git add 发现书籍链路-Stage2前置召回实验方案.md
# 5) 提交后再复核：确认没有任何 .hnsw-* / .tmp_* 被带进去
git status --porcelain
```

**注意：本轮未执行上述任何命令。**
