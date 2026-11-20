# 发现书籍链路 · Stage 2 阶段 B：HNSW 参数实验报告

> 日期：2026-10-10
> 范围：仅在**实验副本表** `discovered_book_chunks_exp` 上跑 9 组索引参数 × 3 个 ef_search × 2 种检索模式 = **54 组测量**
> 边界：**未抓书、未重算 embedding、未重建正式索引、未写任何 API / 前端**（按授权执行）
> 结论先行：**当前 24,244 chunk 规模下，HNSW 近似检索换不到召回率，建议维持产线的精确检索口径，暂不上 ANN。**

---

## 0. 一句话结论

| 口径 | Top1 命中 | 与精确检索的 Top10 重合率 | P50 / P95 |
|---|---|---|---|
| **精确检索基线**（禁用索引，全表扫描） | **10/13 = 77%** | 100%（定义上） | 72 / 85 ms |
| **最优 ANN**（m=16 / efC=256 / efS=200，真走索引） | **9/13 = 69%** | **88.0%** | 1.3 / 7.8 ms |
| **产线现状**（m=16 / efC=64，`ef_search=100`） | 10/13 = 77% | 100% | 72 / 85 ms |

**产线现状的 `ef_search=100` 在 24k 规模下已被优化器判定为「不如全表扫」，直接退化为 Seq Scan —— 也就是说我们现在跑的其实已经是精确检索。** 阶段 B 想回答的是「能不能用 HNSW 换到 8ms 级延迟」，答案是：**能换到 8ms，但要丢 1 条命中（77%→69%），且 Top10 重合率只有 88%。规模没到，不划算。**

---

## 1. 实验执行与资产安全核对

- 数据集：实验副本 `discovered_book_chunks_exp`，**24,244 行**（从主表 `discovered_book_chunks` 复制，复制时逐个校验向量内积 = 1.0）
- 查询集：`server/src/scripts/discover-queries-stage2.txt`（6 条固定 A1–A6 + 8 条新增 N1–N8 + 2 条探针 F1/F2 + 1 条负对照 CTRL）
- 分母口径：**过滤开启时为 13**（14 条定向 Query，扣除 N3；探针 F1/F2 与负对照 CTRL 不计入）
  - N3（斯威尼·托德）的锚点全部落在无章节块里，过滤开启时整书不可召回，**这是设计上的已知排除，不是召回失败**
- 过滤：`chapter_title IS NOT NULL`；迭代扫描 `hnsw.iterative_scan = relaxed_order`
- 延迟：每条 Query 重复 5 次取 P50/P95，冷样本（首个 Query）单列统计
- 耗时：约 5 分 12 秒

**指纹核对（实验前 → 实验后）：差异 0 项**

| 项目 | 前 | 后 |
|---|---|---|
| 主表行数 / embedding 数 | 24,244 / 24,244 | 24,244 / 24,244 |
| 主表 recipe | `v2-title-author-chapter` ×24,244 | 同左 |
| 主表内容指纹 | `5341e1b810d0b1e69aa7f2673b2608a3` | 同左 |
| 无章节块数 | 7,203 | 7,203 |
| 正式 HNSW 索引 | 1 个 / 198,615,040 B | 1 个 / 198,615,040 B |
| v1 备份表 `discovered_book_chunks_emb_v1` | 24,244 行 | 24,244 行 |

**正式索引、正式向量、v1 备份表全程未被修改。**

---

## 2. 精确检索基线（能力上限）

禁用索引后全表扫描，代表「embedding + 语料」在当前查询集上能达到的最好结果。

### 2.1 过滤开启（分母 13）—— Top1 10/13（77%）

| ID | Query 摘要 | 期望 | 实际 Top1 | score | 结果 |
|---|---|---|---|---|---|
| A1 | 拉斯柯尔尼科夫为证明理论而杀人 | Crime and Punishment | Crime and Punishment | 0.5861 | OK |
| A2 | 家庭教师被雇去照顾孩子，阴森大宅 | Jane Eyre | Jane Eyre: An Autobiography | 0.5518 | OK |
| A3 | 关于爱情与阶级的英文小说 | Pride and Prejudice | Pride and Prejudice | 0.5576 | OK |
| A4 | Odysseus returns home and takes revenge | The Odyssey | The Odyssey, Rendered into English | 0.5846 | OK |
| A5 | two young lovers from feuding families | Romeo and Juliet | Romeo and Juliet | 0.5495 | OK |
| A6 | a governess hired to teach a girl | Jane Eyre | Jane Eyre: An Autobiography | 0.5572 | OK |
| N1 | 孤儿女孩在慈善学校忍饥挨冻后做家庭教师 | Jane Eyre | Jane Eyre: An Autobiography | 0.5776 | OK |
| N2 | 孤女被亲戚囚禁在阴森古堡 | The Mysteries of Udolpho | The Mysteries of Udolpho | 0.5477 | OK |
| N4 | 拉斯柯尔尼科夫向索尼娅坦白 | Crime and Punishment | Crime and Punishment | 0.5509 | OK |
| N5 | a young Englishwoman travels to Italy | A Room with a View | **Jane Eyre: An Autobiography** | 0.5866 | **MISS** |
| N6 | a man returns after many years to his home | The Odyssey | **The Man Who Was Thursday** | 0.5400 | **MISS** |
| N7 | Mr Darcy and the grand estate of Pemberley | Pride and Prejudice | Pride and Prejudice | 0.5926 | OK |
| N8 | a masked ball in Verona where two lovers meet | Romeo and Juliet | **A Room with a View** | 0.5007 | **MISS** |
| N3 | 斯威尼·托德在舰队街理发店 | The String of Pearls | *（不计入分母）* | 0.4416 | 已知排除 |

### 2.2 过滤关闭（分母 14）—— Top1 12/14（86%）

放开过滤后 N8 命中（0.5128）、N3 命中（0.5730），N5/N6 仍 MISS。
**注意：过滤关闭不等于更好 —— 它把 7,203 个前言/版式块放回竞争池，N3 之所以能召回正是因为那些块。真正的取舍是「要不要让无章节的书可被搜到」，不是单纯的准确率问题。**

---

## 3. 命中矩阵（只列真正走 HNSW 索引的组）

54 组里有 14 组 `mode=auto` 被优化器判成 Seq Scan（那些组本质是精确检索，重合率必然 100%，不代表 ANN 能力）。**下表只排真正走 Index Scan 的 40 组前 12 名：**

| # | m | efC | efS | mode | 计划 | Top1 | 重合率 | P50 | P95 | 构建s |
|---|---|---|---|---|---|---|---|---|---|---|
| 29 | 16 | 256 | 200 | auto | Index Scan | **9/13** | **88.0%** | 1.3 | **7.8** | 15.9 |
| 30 | 16 | 256 | 200 | forced_index | Index Scan | 9/13 | 88.0% | 1.5 | 8.7 | 15.9 |
| 41 | 32 | 128 | 200 | auto | Index Scan | 9/13 | 88.0% | 2.4 | 10.8 | 27.2 |
| 42 | 32 | 128 | 200 | forced_index | Index Scan | 9/13 | 88.0% | 2.5 | 10.9 | 27.2 |
| 35 | 32 | 64 | 200 | auto | Index Scan | 9/13 | 85.3% | 2.4 | 15.3 | 24.7 |
| 28 | 16 | 256 | 100 | forced_index | Index Scan | 9/13 | 84.7% | **1.0** | 8.5 | 15.9 |
| 12 | 8 | 128 | 200 | forced_index | Index Scan | 9/13 | 75.3% | 1.7 | 11.0 | 6.9 |
| 17 | 16 | 64 | 200 | auto | Index Scan | 9/13 | 74.0% | 2.1 | 8.8 | 8.6 |
| 22 | 16 | 128 | 100 | forced_index | Index Scan | 9/13 | 72.0% | 1.2 | 8.1 | 11.2 |
| 19 | 16 | 128 | 40 | auto | Index Scan | 9/13 | 69.3% | 0.8 | 8.9 | 11.2 |
| 25 | 16 | 256 | 40 | auto | Index Scan | 9/13 | 65.3% | 0.9 | 9.1 | 15.9 |
| 13 | 16 | 64 | 40 | auto（产线现状 efS） | Index Scan | 9/13 | 59.3% | 1.2 | 8.6 | 8.6 |

**最差组**：m=8 / efC=64 / efS=40 → 5/13（38.5%），重合率 48.7%。
**走索引组的 Top1 命中区间：5 ~ 9 / 13（38% ~ 69%），没有一个追平精确基线的 10/13。**

---

## 4. 三个必须记录的观测

### 4.1 索引参数的效果在 m 和 ef 上都**非单调**

- m=32 / efC=64 / efS=40 → **5/13**（最差之一）；m=8 / efC=128 / efS=200 → 9/13
- ef_search 40→100→200 在同一索引下的重合率：59.3% → 62.7% → 74.0%（m=16/efC=64），但 m=16/efC=128 是 69.3% → 72.0% → 79.3%，而 m=32/efC=256 是 72.3% → 80.0% → 81.5%
- **结论：不存在「把 m / ef 调大就一定更好」的规律。继续调参的边际收益已经为零，按方案 §4 的约定停止调参。**

### 4.2 同一个索引两次独立构建，结果差 13 个百分点

矩阵第 9 组是第 3 组（m=16 / efC=64，产线参数）的**刻意重复**，用来测 HNSW 构建随机性：

| 组别 | efS | 计划 | Top1 | 重合率 | P95 |
|---|---|---|---|---|---|
| 第 3 组 | 40 | Index Scan | 9/13 | 59.3% | 8.6 |
| 第 9 组 | 40 | Index Scan | 8/13 | **72.0%** | 12.9 |
| 第 3 组 | 100（forced） | Index Scan | 9/13 | 62.7% | 7.7 |
| 第 9 组 | 100（forced） | Index Scan | 8/13 | **76.7%** | 16.4 |
| 第 3 组 | 200 | Index Scan | 9/13 | 74.0% | 8.8 |
| 第 9 组 | 200 | Index Scan | 8/13 | **86.7%** | 19.9 |

**同样的参数，只是重建一次索引，重合率就能差 12.7pp、Top1 差 1 条。**
→ **读数小于 ~15pp 的组间差异不可信。** 上表里第 1 名和第 5 名的 88.0% vs 85.3% 属于噪声范围内，不应据此选参数。

### 4.3 `auto` 模式下优化器的计划选择在 ef_search 上跳变

| ef_search | 走索引 | 退化 Seq Scan |
|---|---|---|
| 40 | 6 组 | 3 组 |
| **100** | **0 组** | **9 组** |
| 200 | 7 组 | 2 组 |

ef=100 时九组全部退化为 Seq Scan，ef=200 时又多数回到索引 —— **计划选择不可预测。产线如果要靠索引，必须显式控制（forced 或调整成本参数），不能交给优化器。**

---

## 5. 逐条 Query 失手率（区分「索引的锅」和「embedding 的锅」）

在 40 个走索引的组里统计每条 Query 的失手频率：

| ID | 失手率 | 期望 | 精确检索下 | 归因 |
|---|---|---|---|---|
| **N5** | 87.0% | A Room with a View | **MISS** | 语料/embedding 上限 |
| **N6** | 87.0% | The Odyssey | **MISS** | 语料/embedding 上限 |
| **N8** | 85.2% | Romeo and Juliet | **MISS** | 语料/embedding 上限 |
| A2 | 74.1% | Jane Eyre | OK | **索引能救** |
| A6 | 44.4% | Jane Eyre | OK | **索引能救** |
| N1 | 14.8% | Jane Eyre | OK | 索引能救 |
| N7 | 13.0% | Pride and Prejudice | OK | 索引能救 |
| A3 | 11.1% | Pride and Prejudice | OK | 索引能救 |
| N4 | 9.3% | Crime and Punishment | OK | 索引能救 |
| A4 / A5 | 7.4% | The Odyssey / Romeo and Juliet | OK | 索引能救 |
| A1 / N2 | 0.0% | Crime and Punishment / Udolpho | OK | 稳定命中 |

**清晰的分解：**
- **N5 / N6 / N8 这 3 条，精确检索也打不中** —— 这是 embedding 表达能力和查询措辞的问题，**调任何索引参数都救不回来**。想改善只能改 embedding 方案或换查询集，不属于阶段 B 范畴。
- 剩下 10 条里，ANN 最好能保住 9 条 —— **索引参数最多只丢 1 条，代价是 72ms→8ms。**

---

## 6. 稳定性 / 延迟 / 过滤 / 空结果

| 指标 | 结果 |
|---|---|
| 不稳定组数（5 次重复结果不一致） | **0 / 54** |
| 空结果判定 | **918 次全部 `ok`**，无静默空结果 |
| 过滤泄漏（TopK 里混入无章节块） | **0 次**（应为 0） |
| 冷样本记录 | 54 组全部记录；49/54 组含冷读（`shared_read>0`） |
| 索引扫描延迟 | P50 0.6–5.2 ms，P95 2.3–21.0 ms |
| Seq Scan 延迟（过滤开） | P50 ~72 ms，P95 78–107 ms |
| Seq Scan 延迟（过滤关，24,244 块全扫） | P50 **195 ms**，P95 **233 ms** |
| 索引体积 | **8 种配置全部 198,615,040 B（189 MB），取值数 = 1** |
| 索引构建耗时 | m=8: 4.7–6.9s；m=16: 8.6–15.9s；m=32: 24.7–32.8s |

**索引体积不随 m 变化**已复核为真实观测（`reloptions` 生效、构建耗时随 m 从 4.7s 涨到 32.8s，说明参数确实生效了），不是测量错误。

---

## 7. 对方案 §4.0 初始门槛的校验结果

| 门槛 | 目标 | 实测最好 | 是否达标 |
|---|---|---|---|
| Top1 命中率 | ≥ 80% | 精确 77% / ANN 69% | ❌ **未达标** |
| Top3 命中率 | ≥ 90% | 精确 92%（12/13）/ ANN 85%（11/13） | ⚠️ 仅精确达标 |
| ANN Top10 重合率 | ≥ 80% | 88.0% | ✅ 达标 |
| P95 延迟 | ≤ 300 ms | 最高 233 ms（过滤关闭精确扫描） | ✅ 达标 |
| 静默空结果 | 0 | 0 | ✅ 达标 |

**Top1 ≥ 80% 这条门槛被实测证伪，但原因是分母太小：** 过滤开启后分母只有 13 条，1 条 Query 就是 7.7 个百分点，而单个索引重建的随机噪声就有 ±1 条（±7.7pp）。**在 10 本书 / 13 条 Query 的口径上，80% 这个数字本身就不可稳定测量。**

**建议：门槛推迟到 30~50 本规模、分母 ≥ 40 条时再定。** 这与方案 §4 的阶段 C 顺序一致，不额外增加工作量。

---

## 8. 建议（等拍板，不自行执行）

### 选项 1：维持现状 —— **推荐**
产线 `ef_search=100` 在 24k 规模下已经退化为精确检索，等于**拿 72ms 换来了 100% 正确的召回**。这个代价现在完全付得起。
- 优点：零改动、零风险、召回最好
- 缺点：规模涨到 61k chunk（30 本）后，Seq Scan 会线性变慢到 ~180ms+；过滤关闭场景现在就已经 195/233 ms 了

### 选项 2：只改会话参数，不动索引
把 `set_config('hnsw.ef_search', …)` 从 100 降到 **40**，让优化器真正走索引：P50 从 72ms → 1.2ms，代价是重合率 59%、Top1 9/13。
- **不推荐**：省下的 70ms 在离线检索场景没有体感，却实打实丢 1 条命中

### 选项 3：重建正式索引为 m=16 / ef_construction=256 + ef_search=200
重合率 88%、P95 7.8ms、构建 15.9s，是本次实测的 ANN 最优点。
- **现在不推荐**：会动正式资产（需重建 + REINDEX，按 Stage 1.5 的经验整表重写后必须 REINDEX，否则索引劣化 189→247MB），换来的是召回从 77% 掉到 69%
- **等到 30~50 本时再上**，届时精确扫描 180ms+ 已经不可接受，ANN 的收益才成立

### 我的建议
**阶段 B 到此为止，不重建正式索引、不改产线参数。** 理由：规模没到，ANN 换不到召回。把 m=16/efC=256/efS=200（88% / P95 7.8ms）记进方案 §4 作为「规模达标后的预设参数」，等阶段 C 扩到 30~50 本再实测复核。

---

## 9. 遗留与已知瑕疵

1. **实验脚本小 bug**：`hnsw-experiment.py` 把探针 F1/F2 的 `counted` 标记为 `True`，导致 `aggregate.denominator` 记成 15（应为 13）。已在汇总脚本 `summarize-hnsw-exp.py` 与本次分析中按 category 修正，命中数不受影响（探针从不命中）。建议后续把脚本里的 `counted` 判据补上 `category != 'probe'`。
2. **副本表仍存在**：`discovered_book_chunks_exp`（24,244 行，含 `exp_hnsw_idx` 索引）。**未删除**，是否清理请你决定 —— 我不自行 drop。
3. **产物留存**（均在 `server/` 下，已 gitignore）：
   - `.hnsw-exp-matrix.json`（54 组完整结果，含每条 Query 的 EXPLAIN ANALYZE BUFFERS 原文、Top10、5 次延迟、冷热）
   - `.hnsw-summary.txt`（汇总文本）
   - `.hnsw-matrix.log`（逐组日志）
   - `.hnsw-exp-probe.json` / `.hnsw-probe.log` / `.hnsw-smoke.json`（前期连通性与探针验证）
4. **本轮新增脚本与文档按你的指令未提交 Git**（`hnsw-experiment.py`、`summarize-hnsw-exp.py`、`discover-queries-stage2.txt`、本报告）。
5. 前提卡**最终合并差异稿**已产出、未覆盖原文件，等你确认后再合并。

---

## 10. 下一步待你拍板（我停在这里）

- [ ] 是否认可「阶段 B 结束、不重建正式索引」的结论
- [ ] 是否清理实验副本表 `discovered_book_chunks_exp`
- [ ] 前提卡最终合并差异稿是否合并进原文件
- [ ] 是否进入阶段 C（抓 A 组 20 本，凑 30 本后重测召回）—— **需要先抓书，等你明确授权才动**
