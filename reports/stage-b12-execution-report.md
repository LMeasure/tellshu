# B.11 / B.12 合并执行报告 —— ONNX 量化 + PostgreSQL 缓冲池调优

> 本文件由 `server/src/scripts/make-b12-execution-report.py` 生成，**不要手改**。
> 改证据就重跑脚本。所有数字均来自 `server/.crawl-cache/_b1*.json`。

## §1 结论

**目标「最终配置 retrieve P50 ≤ 15ms」达成。**

| 判定项 | 门槛 | 实测 | 结果 |
|---|---|---|---|
| retrieve P50（**稳态**） | ≤ 15 ms | 8.44 ~ 8.87 ms | ✅ 达成 |
| retrieve P50（冷启动首轮） | 仅供知情 | 12.61 ~ 12.93 ms | ⚠ 未消除 |
| 相对 B.11（30.80 ms） | 显著下降 | -71.2% | ✅ |
| 缓冲区 read（每次查询） | 降到 0 | 0 | ✅ |
| 召回 Top1（vs torch 49） | 下降 ≤ 2 | 47（Δ=-2） | ✅ 卡在阈值内 |
| 回归端点状态 | OK | OK | ✅ |

一句话：**换 ONNX 治的是 encode（115→21ms），调 shared_buffers 治的是 retrieve（30.80→8.44~8.87ms）。两件事互相独立，B.11 只做了前半件，B.12 补齐了后半件。**

## §2 本轮改动（PostgreSQL 配置）

文件：`D:/Program Files/PostgreSQL/data/postgresql.conf`

| 参数 | 改前 | 改后 | 行号 | 为什么 |
|---|---|---|---|---|
| `shared_buffers` | 128MB | **2GB** | 132 | 一次检索工作集 ~3800 块（≈30MB）+ 索引热区，128MB 装不下 |
| `effective_cache_size` | 4GB（默认，被注释） | **8GB** | 447 | 纯优化器代价估算，不分配内存；避免 planner 误选 Seq Scan |

回滚文件：`postgresql.conf.bak-b11`（改前逐字节副本，已用 `cmp` 校验一致）。
回滚方式：把 `.bak-b11` 覆盖回 `postgresql.conf`，重启 PG 即可。

生效验证（脚本直连 `SHOW`，不是读配置文件）：

```
  shared_buffers         = 2GB
  effective_cache_size   = 8GB
```

## §3 证据一：retrieve P50 全摆幅谱系

同一台机器、同一批 counted query、同一份索引。**唯一变量是缓冲池冷热**。

| 场景 | encode P50 | retrieve P50 | e2e P50 | 客户端 P50 |
|---|---|---|---|---|
| B.11 生产原状（torch + 128MB） | 115.28 | 31.62 | 145.24 | — |
| B.11 换 ONNX 后（128MB） | 21.01 | **30.80** | 52.02 | — |
| B.12 会话 A 第 1 轮（池在灌）（2GB） | 18.94 | **12.61** | 32.10 | 44.92 |
| B.12 会话 A 第 2 轮（2GB） | 18.87 | **8.87** | 27.74 | 44.54 |
| B.12 会话 A 第 3 轮（2GB） | 18.71 | **8.65** | 28.07 | 45.97 |
| B.12 会话 A 第 4 轮（2GB） | 18.41 | **8.72** | 27.16 | 38.59 |
| B.12 **会话 B 冷启动首轮**（2GB） | 18.45 | **12.93** | 32.02 | 45.52 |
| B.12 会话 B 第 2 轮（2GB） | 18.21 | **8.78** | 27.15 | 41.82 |
| B.12 会话 B 第 3 轮（2GB） | 19.18 | **8.44** | 28.34 | 45.41 |
| *PG 首次重启后首轮：崩溃恢复触发了 35.58s 的全目录 fsync，OS 页缓存被冲，缓冲池最冷。该轮 JSON 被后续轮次覆盖，数字取自执行日志，**不作为基线**，仅标出冷启动的上界量级。* | — | *62.31* | — | — |

读法：

- **稳态（池灌满后的 5 轮）retrieve 稳定在 8.44~8.87 ms**，相对 B.11 的 30.80 ms 降 -71.2%，目标 ≤15ms 达成。
- **冷启动首轮仍要 12.61~12.93 ms**（两次重启实测），最坏观测到过 62.31ms —— 调优没有消除冷启动，只是让稳态变得可预期。
- **encode 与 retrieve 是两件事**：换 ONNX 把 encode 从 115.28 压到 21.01 ms；调 shared_buffers 完全没动 encode（两轮都在 18~19ms）。

## §4 证据二：缓冲区对账（这是「为什么对症」的直接证据）

| 指标（HNSW 索引扫描节点） | B.11（128MB） | B.12（2GB） | 变化 |
|---|---|---|---|
| 每次 hit | 3625 | 3791.5 | +4.6% |
| 每次 read | 3387 | **0.0** | **降到 0** |
| 每次总块数 | 7012 | 3791.5 | — |
| 缓冲区命中率 | 51.7% | **100.0%** | ✅ |
| EXPLAIN 执行时间 | 38.05 ms | 2.73 ms | -92.8% |
| 整条查询总 hit（含 join） | 3720 | 3883.5 | — |

**read 从 3387 降到 0** —— 一次查询要摸的 3792 个块现在全部在 shared_buffers 里，不再需要往池子里灌。这正是 B.11 推断的根因，调优后症状消失，因果闭环。

探针口径：`api/b12-buffer-probe.py`，12 次 EXPLAIN (ANALYZE, BUFFERS)，探针向量 = 库内 3 条真实 embedding 求平均后归一化（不加载模型，避免挤内存污染测量）。

## §5 证据三：ONNX 量化前后对照（B.11 复述，判定阈值不变）

| 引擎 | 余弦 vs torch（mean / min） | Top1 | Top10 | encode P50 | RSS |
|---|---|---|---|---|---|
| torch（生产原状） | —（基准） | 49 | 70 | 115.28 ms | 1.95 GB |
| FP32 ONNX | 1.000000 / 0.999999 | 49 | 70 | 48.40 ms | 1.90 GB |
| INT8 | 0.983864 / 0.980459 | 45 | 70 | 18.58 ms | 1.31 GB |
| **INT8 逐通道** | 0.989805 / 0.986855 | 47 | 69 | 16.31 ms | 1.31 GB |

判定：

- FP32 余弦 **1.000000 / 0.999999** > 0.999 ✅ —— ONNX 转换零损失；
- INT8 余弦 0.9839 > 0.98 ✅，逐通道 **0.9898** 更宽裕；
- Top1 召回 torch 49 → 逐通道 47，**Δ=-2 正好卡在阈值内**（McNemar 4/2，p=0.6875，不显著）；
- 体积 2162.4 → 543.4 MB（-74.9%）；
- **最终采分支 A：只换 query 侧，库内 58,332 条 FP32 向量一根不动。**

⚠ 关键认知：**换 ONNX 只改 encode，不改 retrieve**。B.11 HTTP A/B 同机同批实测：retrieve 31.62 ms（torch） vs 30.80 ms（ONNX），几乎无差。别指望换推理后端能改善检索延迟。

## §6 证据四：全量回归（热态口径）

| 指标 | B.9 | B.11 | B.12 | 说明 |
|---|---|---|---|---|
| HNSW P50 | — | 6.71 ms | 6.84 ms | 热态口径（每条 3 次取后 2 次） |
| EXACT P50 | 232.5 ms | 207.30 ms | **167.53 ms** | 持续回落 |
| 状态 | — | WARN | **OK** | headroom 0.94 → **0.76** |

⚠ 口径铁律：回归端点的 HNSW 是**热态重复**口径，§3 的 HTTP 数是**首次触碰**口径，两个数不能互换使用（B.10 已因混口径吃过亏）。

## §7 本轮踩过的坑（都写进代码注释了）

1. **`parse_plan` 取「最后一个 Buffers 行」是错的** —— 计划里每个节点都有 Buffers 行，末尾还有 `Planning:` 段。直接取最后一行会拿到 `discovered_books_pkey` 的 hit=2 或 Planning 的 hit=248，小两个数量级。已改为按「Index Scan using <HNSW 索引>」定位后取它下面那段缩进。**B.11 的 `_b11-recall-*.json` per_query.shared_hit 也中了这个招（中位数只有 5），不可采信**；B.11 报告里的 3625/3387 来自原始计划文本，是对的。
2. **`pg_statio` 增量恒为 0** —— 统计快照按事务缓存 + 落盘滞后，即使调 `pg_stat_clear_snapshot()` 也拿不到。已在脚本里标注不可采信，缓冲行为一律以逐节点 EXPLAIN 为准。
3. **本机环境有 `http_proxy`/`HTTP_PROXY`** —— curl 和 urllib 会把 `127.0.0.1` 也走代理，返回 502。所有本地压测命令必须先 `export no_proxy=127.0.0.1,localhost,::1`。
4. **命令行工具会在命令结束时清整棵进程树** —— 用普通方式起 PG，命令一结束 postmaster 就被带走。解决办法是把 `pg_ctl start` 放进后台常驻任务。
5. **`Start-Service` 需要管理员** —— 本机非管理员，服务方式重启走不通，改用 `pg_ctl` 直接启动（见 §8 遗留）。
6. **PG 重启后 API 连接池会残留失效连接** → 500。重启 PG 必须同时重启 API。

## §8 遗留与下一步

1. **PG 目前是以 `pg_ctl` 直接启动的进程，不在 Windows 服务管控下**（`postgresql-x64-18` 服务当前显示为已停止）。若要交还服务管控：以管理员身份 `Restart-Service postgresql-x64-18`（配置已是 2GB，服务起来即生效）。下次开机服务会自动拉起，同样吃 2GB。
2. **Windows 内存压缩风险仍在** —— `shared_memory_type=windows`，PG 共享段是 pagefile-backed，理论上可被系统压缩/换出。若后续观察到稳态 retrieve 又漂回几十 ms，优先查这个，而不是继续加 `shared_buffers`。
3. **`shared_buffers=2GB` 是不是终点，没有实测** —— 本次只验了 128MB → 2GB 这一档。要不要试 1GB（省内存）或 3GB（更热），需要你拍板：我建议**先观察一周稳态**，别急着加。
4. **pg_prewarm 仍未装**（B.11 判定的红线，未变）：buffer 模式受池大小限制且会挤走 HNSW 入口层，prefetch 依赖 `posix_fadvise`（Windows 不可用），且 `CREATE EXTENSION` 是写库操作。
5. **冷启动首轮 ~13ms（最坏 62ms）未消除** —— 如果线上是低频调用（每次调用间隔长到池子被别的库对象挤走），实际体感会接近冷启动值。要不要为此做预热，取决于真实流量形态，现在没有数据。

## §9 复现命令

```bash
export no_proxy=127.0.0.1,localhost,::1

# 1) 起 PG（放进后台常驻任务，否则命令结束进程被收走）
"/d/Program Files/PostgreSQL/18/bin/pg_ctl.exe" start \
    -D "D:/Program Files/PostgreSQL/data" -l <日志> -w -t 120

# 2) 起 API（ONNX 后端）
cd api && EMBEDDING_BACKEND=onnx HF_HUB_OFFLINE=1 \
  C:/Python314/python.exe -u -m uvicorn main:app --host 127.0.0.1 --port 8000

# 3) 前后对照（8 次 warmup + 20 条 counted query）
C:/Python314/python.exe -u api/b12-verify-after-tuning.py
C:/Python314/python.exe -u api/b12-verify-after-tuning.py --with-regression

# 4) 缓冲区探针（对账 hit/read）
C:/Python314/python.exe -u api/b12-buffer-probe.py --probes 12

# 5) 重出本报告
C:/Python314/python.exe -u server/src/scripts/make-b12-execution-report.py
```

---

生成时间：2026-10-20 00:15:19  ｜  只读操作：未写任何业务表，未改动库内向量
