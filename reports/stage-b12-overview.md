# B.12 概览 —— PG 缓冲池调优执行结果

> 完整版见 `reports/stage-b12-execution-report.md`（由 `server/src/scripts/make-b12-execution-report.py`
> 从 `server/.crawl-cache/_b1*.json` 生成，无手打数字）。

## 一句话
**换 ONNX 治 encode（115→21ms），调 `shared_buffers` 治 retrieve（30.8→8.4~8.9ms）。**
两件事互相独立 —— B.11 只做了前半件，B.12 补齐了后半件，**目标 retrieve P50 ≤15ms 达成**。

## 改了什么
`D:/Program Files/PostgreSQL/data/postgresql.conf`（已授权，回滚文件 `.bak-b11`）：

| 参数 | 改前 | 改后 |
|---|---|---|
| `shared_buffers` | 128MB | **2GB** |
| `effective_cache_size` | 4GB | **8GB** |

## 实测（同机、同批 20 条 counted query、ONNX 逐通道后端不变）

| 指标 | B.11（128MB） | B.12（2GB） | 判定 |
|---|---|---|---|
| retrieve P50（稳态） | 30.80 ms | **8.44 ~ 8.87 ms** | ✅ ≤15ms |
| retrieve P50（冷启动首轮） | — | 12.61 ~ 12.93 ms | ⚠ 未消除 |
| e2e P50 | 52.02 ms | 27.15 ~ 28.34 ms | ✅ |
| encode P50 | 21.01 ms | 18.2 ~ 19.2 ms | 符合预期（未动） |
| HNSW 节点 read / 命中率 | 3387 / 51.7% | **0 / 100%** | ✅ 因果闭环 |
| 回归 EXACT P50 / 状态 | 207.30 ms / WARN | **167.53 ms / OK** | ✅ |

## 为什么这次对症
B.11 的原始执行计划显示：单次 HNSW 扫描要摸 ~7000 块（56MB），而缓冲池只有 128MB ——
**一次查询吃掉半个池**，每条新 query 都要重新灌。调优后 `read` 从 3387 **降到 0**，
全部命中，症状消失。这不是猜的，是 EXPLAIN 逐节点数出来的。

## 需要注意
- **冷启动首轮仍有 12.6~12.9ms**（最坏观测 62.31ms）。低频调用场景下体感会接近这个值。
- ~~**PG 目前是以 `pg_ctl` 直接起**，不在 Windows 服务管控下。~~
  **【2026-10-27 订正】此条已作废**：PG 自 2026-10-21 13:14:05 起由 **Windows 服务
  `postgresql-x64-18`（账户 `NT AUTHORITY\NetworkService`，控制进程 `pg_ctl.exe runservice`）**
  持续运行（截至 2026-10-27 01:32 实测仍在跑，已连续 5 天 12 小时 18 分 11 秒）。
  本次恢复**采用服务入口**；已完成的只是**启动控制权协调**，其他入口仍按冻结约定管理，
  并未确立系统级强制单入口机制。
- **2GB 是不是终点没实测**，只验了 128MB→2GB 一档；建议先观察一周稳态。

## 后续验证（2026-10-22 复测，服务方式恢复后）

| 口径 | 结果 | 达成 ≤15ms |
|---|---|---|
| 回归端点 HNSW P50（每条 3 次取后 2 次） | **7.39 ms** | ✅ |
| HTTP 压测第二轮 retrieve P50 / e2e | **9.27 ms** / 27.69 ms（B.11 30.80 ms，−69.9%） | ✅ |
| 空闲约 12h 后**单次**首触 retrieve | **73.02 ms** | ❌（单次观测，未建立冷态基线） |

缓冲区（本轮探针）：HNSW 节点 read **3387→0**，命中率 **51.7%→100%**，EXPLAIN exec **38.05→2.76 ms**。
⚠ 上表前两行**口径不同，不可互相替代**。详见 `B12-启动控制权核查报告.md` §17。

## 复现
```bash
export no_proxy=127.0.0.1,localhost,::1     # 本机有 http_proxy，不加会 502
C:/Python314/python.exe -u api/b12-verify-after-tuning.py --with-regression
C:/Python314/python.exe -u api/b12-buffer-probe.py --probes 12
C:/Python314/python.exe -u server/src/scripts/make-b12-execution-report.py
```

commit **bd39c47**。
