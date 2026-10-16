# Query 编码延迟实测

**结论先行**：线上单条 query 的 BGE-M3 编码，**短句约 91 ms、长句约 178 ms**。
这个数比库内检索本身还大——精确检索 P50 约 190–270 ms、HNSW 约 0.2–1 ms。
也就是说：**端到端延迟的大头是编码，不是向量检索**；讨论「要不要上 ANN」时，
ANN 省下来的 190 ms 会被编码的 91–178 ms 摊掉一半以上。

---

## 1. 测量条件

| 项 | 值 |
|---|---|
| 模型 | `BAAI/bge-m3`（本地缓存，`HF_HUB_OFFLINE=1`，`local_files_only=True`） |
| 模型标识（实测回读） | `BAAI/bge-m3` |
| sentence-transformers | `6.2.0.dev0` / torch `2.14.1+cpu` |
| 解释器 | `C:/Python314/python.exe`（Python 3.14.6） |
| 预热 | **12 次 × 2 条（短/长各一）**，全部丢弃，不进统计 |
| 正式计时 | **120 次 / 每条**，逐次单独 `encode([q])`（batch size = 1，模拟线上单 query） |
| 线程 | `OMP_NUM_THREADS=4`（本机同时还在跑 PostgreSQL 与 IDE，留了余量） |
| 归一化 | `normalize_embeddings=True`（与入库、与 `search-discover.py` 完全一致） |
| 测量时刻内存 | 物理内存 15,551 MB，可用 **1,690 MB**（负载 89%） |

## 2. 结果

| Query | 字符数 | min | **p50** | **p95** | **p99** | avg | max | RSS 峰值 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 短句 `一位侦探调查一桩离奇的命案` | 13 | 76.57 | **91.15** | **102.47** | **104.11** | **92.14** | 104.21 | 1,974.2 MB |
| 长句（多子句，68 字） | 68 | 132.77 | **177.96** | **204.07** | **209.95** | **173.32** | 212.14 | 1,974.8 MB |

单位：毫秒。样本量 120/条，warmup 已丢弃。

**读法**：

- 长 query 的编码成本约为短 query 的 **2 倍**（BGE-M3 按 token 计费，长句序列更长）。
  所以「发现页」如果用户会输入长句，延迟预算要按 180 ms 这一档算，不能拿短句糊弄过去。
- p99 与 p50 只差约 13%（短句 104 vs 91），说明**抖动很小**，CPU 侧不存在偶发长尾。
- RSS 峰值 **1.97 GB** —— 这是「常驻编码服务」的硬性内存成本，与检索方式无关。

## 3. 为什么不能用别的数据代替

| 数据 | 数值 | 为什么不能用 |
|---|---|---|
| 批量 ingest 吞吐 | 5.33 条/s ≈ 187 ms/条（Stage C 30 本实测） | 那是 **500 字符文档块**、batch=16；常量开销被摊薄，且序列长度完全不同 |
| 早期探针 benchmark | 168 ms/条 | 同上，同样是 batch 文档块口径 |
| **本次单条 query** | **91 / 178 ms** | batch size=1、真实的 query 长度，这才是线上形态 |

三者混用会得出完全相反的结论，本报告只用最后一行。

## 4. 一次必须记下来的失败（错误原文）

第一次测量在 **Git Bash（MSYS）** 下跑，直接崩：

```
[10:17:45] run start; avail=1969 MB, warmup=12, repeats=120
bash.exe: line 1:  150 Segmentation fault
   HF_HUB_OFFLINE=1 OMP_NUM_THREADS=4 "C:/Python314/python.exe" -u src/scripts/bench-query-embedding.py
EXITCODE=139
```

没有任何 Python traceback —— 进程是被信号杀掉的。进一步二分到最小用例：

```
HF_HUB_OFFLINE=1 python -u -c "import torch"
-> 无任何输出，RAW_EXITCODE=139（SIGSEGV）
```

当时的内存状态（不是内存不够，提交空间也够）：

```
物理内存   total=15551 MB  avail=1590 MB  load=89%
提交(分页) total=44317 MB  avail=15167 MB      ← 提交 headroom 还有 15 GB
CommitLimit=29149 MB  CommitTotal=44317 MB  （GetPerformanceInfo，字段顺序已核对）
ProcessCount=344
```

**根因**：不是内存不足，是 **Git Bash / MSYS 环境下的 DLL 冲突**。
同样的命令在 **PowerShell** 下正常：

```
torch OK 2.14.1+cpu
threads=16
```

**结论：本项目所有 torch / sentence-transformers 脚本必须在 PowerShell 下执行。**
（`stage-b5-experiment.py` 今天上午跑成功，也是因为在 PowerShell 下跑的；
后来几次「模型加载失败」的归因——内存不足——是错的，已更正。）

## 5. 边界与未测项

- 本次测的是**模型已常驻**（warm）的编码延迟。线上如果每次都冷启动，
  还要加上 **模型加载 2.3 s + import 19.5 s**（本机实测，含 torch 首次初始化）。
  这意味着编码服务必须常驻，绝不能按请求拉起。
- 内存是在 89% 负载下测的，空闲机器上可能更快；反过来，负载更高时会更慢。
- 只测了 `OMP_NUM_THREADS=4`。线程数对延迟的影响**未做扫描**（未测，不猜）。
- GPU 未参与，全部 CPU。

## 6. 复现

```bash
cd server
# 注意：PowerShell 下执行
$env:HF_HUB_OFFLINE = "1"
$env:OMP_NUM_THREADS = "4"
C:/Python314/python.exe -u src/scripts/bench-query-embedding.py --warmup 12 --repeats 120
```

产物：

- `server/.crawl-cache/_query-embedding-latency.json`（结构化结果）
- `server/.crawl-cache/_bench-run.log`（逐行日志）
- `server/.crawl-cache/_torchimport2.log`（PowerShell 下 import torch 成功的证据）
