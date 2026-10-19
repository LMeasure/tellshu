# Stage B.11 —— BGE-M3 ONNX 导出 + INT8 量化：召回、延迟、内存实测

生成时间：2026-10-19 09:53:15　（由 `server/src/scripts/make-b11-execution-report.py` 生成，数字全部取自 `.crawl-cache/_b11-*.json`）

---

## §1 结论摘要

| 项目 | 结果 | 判定 |
|---|---|---|
| ONNX 导出 | legacy TorchScript 导出器，opset 14，135ms，FP32 2162.4 MB | ✅ |
| INT8 动态量化 | 542.4 MB（普通）/ 543.4 MB（逐通道），耗时 7.3s / 2.9s | ✅ |
| 一致性（余弦 vs torch） | FP32 **1.000000**、INT8 0.9839、INT8 逐通道 **0.9898** | ✅（门槛 0.999 / 0.98） |
| 召回（100 条 counted） | torch 49 → **INT8 逐通道 47**（Δ=−2），Top10 70 → 69 | **分支 A**（阈值 Δ≤2） |
| 配对显著性 | McNemar 4/2，p=0.6875 → 不显著 | ✅ |
| **编码延迟** | torch 119.93 ms → **ONNX 23.07 ms（−80.8%）** | ✅ |
| **进程 RSS** | torch 1.95 GB → **1.31 GB（−0.64 GB）** | ⚠️ 未达 <1GB |
| **端到端 e2e P50** | 145.24 ms（torch）→ **52.02 ms（ONNX）** | ✅ ≤200ms |
| **retrieve P50（首次触碰）** | torch 31.62 ms vs ONNX 30.80 ms → **几乎无差** | ❌ 未达 ≤15ms |
| 全量回归（100 条） | HNSW P50 6.71（热态重复）/ EXACT P50 207.3 / 状态 WARN | 见 §7 |

**一句话**：ONNX 把「编码」彻底解决了（115→21 ms），但**没有解决 retrieve**。
B.10 归因的「内存不够 → 索引进不了页缓存」在本轮被进一步细化成了另一个更硬的约束，见 §8。

### 判定：走**分支 A**（只换 query 侧，库内 58,332 条 FP32 向量不动）

- 普通 INT8：Top1 45（Δ=−4）→ 超出阈值，落分支 B。
- **逐通道 INT8：Top1 47（Δ=−2）→ 正好卡在阈值内**，且 McNemar 4/2 p=0.69 不显著。
- FP32 ONNX 对照组 **Top1 49 / Top10 70，与 torch 逐条一致（McNemar 0/0）** ——
  这条把归因钉死了：ONNX 转换本身（tokenizer / 池化 / 图）**零损失**，
  −2 全部来自 INT8 量化误差，不是「向量不同源」。

---

## §2 环境与前提修正（两条与任务书不一致，先如实报）

1. **`onnxruntime` 是 1.31.0，不是任务书里写的 1.24.4**；且 B.10 记录的「PyPI 502 装不上」
   对 onnxruntime/onnx **已不成立**（两者都已在环境里）。所以 B.11 没有被依赖问题挡住。
2. **`onnxscript` 仍然装不上**（本轮又撞 PyPI 502）。它是 torch 2.9+ 默认 dynamo 导出器的
   硬依赖，所以**只能退回 legacy TorchScript 导出器**（`dynamo=False`）。
   这是本轮唯一的路径降级，后果是 `do_constant_folding` 在 2.14 里已被标记 deprecated
   （文档说 "always enabled"），我们仍显式传了 True。

另外两个踩到的坑（已绕开，写下来免得重踩）：

- **中文路径坑**：legacy 导出器写外置权重时由 C++ 侧拼路径，项目根目录含中文，
  实测报 `Could not open file or directory: .../述树交付包/bge-m3-onnx/Constant_755_attr__value`。
  → 导出目录改用 ASCII 路径（`B11_ONNX_DIR`，默认 `C:/Users/lagom/.cache/bge-m3-onnx`），
  导出完再把成品拷回项目根。**ONNX Runtime 读中文路径没问题**（实测 743ms 加载成功）。
- **protobuf 2GB 硬上限**：模型 2.27GB > 2GB，必须外置权重。
  legacy 导出器在 `f` 传字符串路径时会**自动**切换外置格式（逐个张量落盘，172 个文件）。

### 模型结构实测（不是猜的）

```
modules: Transformer(feature-extraction, output=last_hidden_state)
       → Pooling{"pooling_mode": "cls", "embedding_dimension": 1024}
       → Normalize
backbone = XLMRobertaModel   max_seq_length = 8192
```

`config.json` 的 `architectures = ["XLMRobertaModel"]` —— **是纯骨干，没有 trust_remote_code
的自定义 forward**，所以导出骨干即可，不需要搬 `model.model` 那套兜底。

---

## §3 导出与量化产物

| 产物 | 体积 | 生成耗时 | 说明 |
|---|---|---|---|
| `model_fp32.onnx` + 172 个外置权重 | **2162.4 MB** | 135 ms | opset 14，`do_constant_folding=True`，batch/seq 动态轴 |
| `model_int8.onnx` | **542.4 MB** | 7335 ms | `quantize_dynamic(weight_type=QInt8)`，逐张量单一 scale |
| `model_int8pc.onnx` | **543.4 MB** | 2859 ms | 同上 + `per_channel=True` ← **生产选用** |

体积压缩 **2162.4 → 543.4 MB（−74.9%）**；逐通道只比普通 INT8 多 **1.0 MB**。

---

## §4 一致性（余弦 vs torch 参考向量，v3 前 20 条真实 query）

| 引擎 | min | p05 | mean | max |
|---|---|---|---|---|
| FP32 ONNX | 0.999999 | 1.000000 | 1.000000 | 1.000000 |
| INT8 ONNX | 0.980459 | 0.981071 | 0.983864 | 0.987012 |
| INT8 逐通道 | 0.986855 | 0.987936 | 0.989805 | 0.991474 |

判定：FP32 **>0.999 达标（实测 1.000000）**；INT8 **>0.98 达标**；逐通道 INT8 更宽裕（0.9869）。

### 池化方式的交叉验证（这条必须留证据）

同一个 ONNX 模型，用 mean 池化再和 torch 参考比：余弦只有 **0.738089 ~ 0.832272**，
而 CLS 池化是 **1.000000**。
→ 两边互证：torch 参考用的**就是 CLS**，`pipeline.json` 里的 `pooling_mode=cls` 不是默认值兜底，是真的。
（tokenizer 同理：ONNX 侧用 `AutoTokenizer` 从**同一个本地快照**加载，与 sentence-transformers 同源。）

---

## §5 延迟与内存对照

### 5.1 进程内编码（20 条真实 query，P50）

| 引擎 | 会话加载 | encode P50 | encode P95 | 进程 RSS | 载入前/后可用内存 |
|---|---|---|---|---|---|
| torch（参考） | ~4.8 s | 110.70 ms | — | 1.95 GB | — |
| FP32 ONNX | 1787 ms | 48.40 ms | 56.17 ms | 1.90 GB | 6.44 → 4.58 GB |
| INT8 ONNX | 820 ms | 18.58 ms | 22.51 ms | 1.31 GB | 6.37 → 5.18 GB |
| **INT8 逐通道** | 787 ms | **16.31 ms** | 18.30 ms | **1.31 GB** | 7.61 → 6.29 GB |

⚠ RSS 口径说明：`private_gb`（提交量）明显大于 RSS，是 ONNX Runtime / torch 预留的虚拟 arena，
**衡量「占了多少物理内存」请只看 RSS**（RSS 的变化量与系统 `avail_gb` 的下降量互相印证）。

### 5.2 HTTP 端到端 A/B（同机同批 query，各 8 次 warmup + 20 条）

| 引擎 | encode P50 | retrieve P50 | e2e P50 | e2e P95 | HTTP 开销 P50 | ≥8 行 | 空结果 |
|---|---|---|---|---|---|---|---|
| torch（local） | 115.28 ms | 31.62 ms | 145.24 ms | 182.61 ms | 3.50 ms | 20/20 | 0 |
| **ONNX 逐通道** | **21.01 ms** | 30.80 ms | **52.02 ms** | 73.53 ms | 3.46 ms | 20/20 | 0 |

**e2e 从 145.24 → 52.02 ms（−64.2%），全部来自编码段。retrieve 两段同量级（31.62 / 30.80 ms）。**

---

## §6 召回影响（100 条 counted v3 query，ef=800 + strict_order + 排除 front matter + top_k=10）

| 引擎 | 余弦 mean | 余弦 min | Top1 | Top10 | encode P50 | retrieve P50 | RSS |
|---|---|---|---|---|---|---|---|
| torch（现生产） | 1.000000（定义） | — | 49 | 70 | 119.93 | 50.05 | 1.95 |
| FP32 ONNX | 1.000000 | 0.999999 | 49 | 70 | 58.41 | 30.16 | 1.90 |
| INT8 ONNX | 0.983864 | 0.980459 | 45 | 70 | 21.19 | 30.86 | 1.31 |
| INT8 逐通道 | 0.989805 | 0.986855 | 47 | 69 | 23.07 | 49.50 | 1.31 |

### 配对 McNemar（以 torch 为 A，实验组为 B）

| 实验组 | B(Top1) | A(Top1) | Δ | b（A中B不中） | c（A不中B中） | p 值 | 结论 |
|---|---|---|---|---|---|---|---|
| INT8 ONNX | 45 | 49 | -4 | 8 | 4 | 0.3877 | 不显著 |
| INT8 逐通道 | 47 | 49 | -2 | 4 | 2 | 0.6875 | 不显著 |
| FP32 ONNX | 49 | 49 | +0 | 0 | 0 | 1.0000 | 不显著 |

### 判定过程（不跳步）

1. 普通 INT8 **45**（Δ=−4）→ 按任务书阈值「Δ>2」落**分支 B**。
2. 但 McNemar **8/4, p=0.3877 不显著** —— 100 条样本分辨不出 4 条的差异，
   这个「超阈值」有可能是噪声。所以没有直接认分支 B，而是**先试着把精度捞回来**。
3. 逐通道量化（`per_channel=True`）：余弦 0.9839 → **0.9898**，体积 +1.0 MB，延迟几乎不变，
   召回回到 **47**（Δ=−2，McNemar 4/2 p=0.69）。
4. FP32 对照组 49 / 70 与 torch **逐条完全一致** → 证明链路无损，−2 是纯量化误差。

→ **采分支 A：只把 query 侧换成 INT8 逐通道 ONNX，库内 58,332 条 FP32 向量一根不动。**

⚠ 诚实边界：47 vs 49 的 Δ=−2 在统计上**也分辨不出**（p=0.69）。
准确说法是「没有证据表明有损失」，而不是「证明无损失」。
要真正确认 Δ=2 量级，100 条样本不够，需要扩 query 集——见 §9。

---

## §7 API 集成（任务 2）与验收逐项

改动：`api/embed.py` 新增 `OnnxBackend`；`api/config.py` 移除 onnx 启动拒绝、
新增 `ONNX_MODEL_PATH` / `ONNX_THREADS`；`api/main.py` 的 `latency_profile` 增加
**按编码后端匹配**（`_engine_of`），避免拿 torch 的 115ms 当 onnx 的预算。

启动方式：
```
$env:EMBEDDING_BACKEND="onnx"
C:/Python314/python.exe -m uvicorn main:app --app-dir api --host 127.0.0.1 --port 8000
```

启动自检实测：`ef_search=800 iterative_scan=strict_order rows=10/10 plan=HNSW(discovered_book_chunks_embedding_hnsw_idx)`，`startup_check.ok=true`。

### 验收逐项

| 验收项 | 目标 | 实测 | 判定 |
|---|---|---|---|
| 模型 RSS | < 1 GB | **1.31 GB**（torch 1.95 GB，省 0.64 GB） | ❌ |
| 空闲内存 | > 2.5 GB | 6.0 GB | ✅ |
| retrieve P50（未预热） | ≤ 15 ms | **30.80 ms** | ❌ |
| e2e P50 | ≤ 200 ms | **52.02 ms** | ✅ |
| Top1 | ≥ 47/100 | **47/100** | ✅ |
| HTTP 开销 P50 | < 10 ms | 3.46 ms | ✅ |
| 返回行数 / 空结果 | 20/20，0 空 | 20/20，0 空 | ✅ |

### 全量回归（100 条，完整模式）

| 指标 | 实测 | 对照 |
|---|---|---|
| HNSW P50 / P95 | **6.71 / 18.46 ms** | 热态口径（每条 3 次取后 2 次） |
| EXACT P50 / P95 | 207.30 / 220.16 ms | B.9 232.5、B.8 475.32 → 继续回落 |
| 两点拟合斜率 | 3.9337 ms/1k 行 | 截距 -22.16 |
| N*（400ms 预算） | short 84148 / long 62080 | 现状 58,332 行 |
| headroom / 状态 | 0.94 / **WARN** | 与 B.9 一样卡在 WARN/ALERT 边界 |

⚠ **口径必须对齐**：回归端点的 HNSW 6.71 ms 是**热态重复**口径（B.6 起就这么算），
HTTP 实测的 30.80 ms 是**首次触碰**口径。两个数都对，但不能互相替换着用 ——
B.10 已经因为混口径吃过一次亏。

---

## §8 任务 3：pg_prewarm 的红线判断 —— **不装**，并给出真正的根因

检查结果：`pg_prewarm` **可用**（v1.2，未安装），`shared_buffers = **128 MB**`，
HNSW 索引 **456 MB**，当前用户是 superuser，`effective_cache_size = 4GB`。

### 判断：不安装。三条理由

1. **它解决不了这个问题**。pg_prewarm 默认 `buffer` 模式把页面读进 **shared_buffers**，
   而 shared_buffers 只有 128 MB，索引有 456 MB —— 预热完的结果是「最后 128 MB 留住了，
   前面的全被挤掉」，甚至可能把 HNSW 的入口点和上层图挤出去（那部分在索引文件靠前的位置）。
   净收益接近零，且有明确副作用。
2. `prefetch` 模式依赖 `posix_fadvise`，**Windows 构建上不可用**，本机是 Windows。
3. 它要 `CREATE EXTENSION`，是**对生产库的写操作**。在「只读优先、不碰正式资产」的纪律下，
   一次预期无收益且带副作用的写库，不该由我自己拍板放行。

→ 如果你要实测证据，一句话就能装（`CREATE EXTENSION pg_prewarm;` + `SELECT pg_prewarm('discovered_book_chunks_embedding_hnsw_idx');`），
   说一声我就跑，跑完可以 `DROP EXTENSION`。

### 真正的根因（本轮最重要的发现，比 B.10 更具体）

一次查询的完整执行计划（ef=800 + strict_order + 排除 front matter）：

```
Limit  Buffers: shared hit=3720 read=3407
  ->  Index Scan using discovered_book_chunks_embedding_hnsw_idx
        Filter: ((embedding IS NOT NULL) AND (chapter_title IS NOT NULL))
        Buffers: shared hit=3625 read=3387      ← 约 7000 块 ≈ 56 MB
  ->  Memoize / Index Scan discovered_books_pkey  Buffers: shared hit=4
Execution Time: 38.053 ms
```

**每查一条要摸 ~7000 个块（56 MB）**，而 `shared_buffers` 只有 128 MB ——
一次查询就吃掉一半缓冲区。所以：

- 不是「索引整体进不了内存」（456 MB 在 4.7 GB 空闲的机器上 OS 页缓存装得下）；
- 是 **PG 的 128 MB 缓冲池装不下一次查询的工作集**，于是每条新 query 都要重新
  往 shared_buffers 里灌 56 MB（这些块大多命中 OS 页缓存，所以不是磁盘 I/O 慢，
  是搬运 + 元数据的开销）。
- 这也解释了 B.10 看到的「每条新 query 冷读 ~4000 块」。

**因此：换 ONNX 腾出的 0.64 GB 物理内存，对这个瓶颈没有作用** ——
瓶颈在 PG 自己的缓冲区大小，不在 OS 有没有空闲内存。这与任务书的假设不符，如实报告。

### 能真正打到这个点的三个方向（都需要你拍板，我都没动）

1. **`shared_buffers` 128 MB → 1~2 GB**（最有针对性）。
   属于 `postgresql.conf` 改动 + 重启 PG —— 按纪律我没碰，等你决定。
2. **降低 ef_search**：能直接减少摸的块数，但 B.6 实测 ef 下降会掉召回
   （ef=80 → Top1 40/100），且 160~400 是「退化区」。得不偿失。
3. **把 `chapter_title` 过滤从检索路径上拿掉**（改成建索引时就不收 front matter，
   或把过滤条件下推）。这需要改数据口径，属于另一条决策链。

---

## §9 遗留事项与下一步

1. **RSS 未达 1 GB**：1.31 GB。想再压可以试 `ORT_DISABLE_ALL` 图优化或降低
   `ONNX_THREADS`，代价是延迟。当前 4 线程是实测过的平衡点。
2. **retrieve 未达 15 ms**：见 §8，需要调 `shared_buffers`（你拍板）。
3. **Δ=−2 的统计功效不足**：100 条样本分辨不出 2~4 条的差异（两次 McNemar 都是 p>0.38）。
   若要「确认无损失」，需要把 query 集扩到 300~500 条。
4. **`regression` 端点的 `encode_latency_ms` 仍是 B.6 的 torch 数**（91.15 / 177.96），
   在 ONNX 下已过期（实测 21 ms）。它只影响 N* 的推导，不影响 HNSW/EXACT 实测值；
   要不要让端点读实时后端延迟，留给你决定。
5. **ONNX 模型目前落在 `bge-m3-onnx/`（已 gitignore）**，是逐通道 INT8 那一份。
   重新生成：`api/b11-onnx-export.py --stage export --legacy`
   → `api/b11-onnx-eval.py --stage quantize --per-channel`。
6. **FP32 ONNX 是零损失通道**（余弦 1.000000、召回与 torch 逐条一致）。
   如果哪天出现「宁可慢也要零损失」的场景，它是现成的备选（编码 48 ms、RSS 1.90 GB）。

---

## 附：本轮产出的文件

| 文件 | 作用 |
|---|---|
| `api/b11-onnx-export.py` | FP32 ONNX 导出 + torch 参考向量留样（torch 进程） |
| `api/b11-onnx-eval.py` | 一致性 / 量化 / 召回 / McNemar 四阶段（无 torch 进程） |
| `api/b11-torch-recall.py` | torch 召回**配对基线**（McNemar 需要逐条对应） |
| `api/b11_common.py` | 共用：检索 SQL（逐字复制自 api/retrieve.py）、GUC、内存快照、McNemar |
| `api/embed.py` / `api/config.py` / `api/main.py` | `EMBEDDING_BACKEND=onnx` 实现与画像修正 |
| `server/src/scripts/make-b11-execution-report.py` | 本报告生成器 |
| `.crawl-cache/_b11-*.json` | 全部实测证据（导出/量化/一致性/召回/压测/回归） |
