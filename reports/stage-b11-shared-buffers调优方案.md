# `shared_buffers` 调优方案（B.11 后续 · **待你拍板，我未执行任何改动**）

> 为什么单独出这份文档：B.11 已经把「换 ONNX 降不了 retrieve」证死了，
> 并把根因定位到 PG 自己的缓冲区。而这个根因的解法在 `postgresql.conf` 里，
> 属于项目纪律里「未经授权不得改动」的范围（不碰 `postgresql.conf` / `ALTER SYSTEM`）。
> 所以这里只给**可直接照抄执行**的方案、影响面和回滚路径，动手权在你。

---

## §1 结论先行

| 项目 | 内容 |
|---|---|
| 建议动作 | `shared_buffers` **128 MB → 2 GB**，重启 `postgresql-x64-18` 服务 |
| 预期收益 | retrieve P50 从 **30.8 ms（首次触碰）** 降到 **~7 ms（工作集驻留）** |
| 数据风险 | **零**（shared_buffers 是纯缓存，不持久化任何东西；崩溃恢复走 WAL，不受影响） |
| 服务风险 | 需停库重启，期间依赖 PG 的服务断连（影响面见 §5） |
| 失败回滚 | 还原 `postgresql.conf.bak` 再重启即可（数据目录在 `D:`，可直接编辑） |
| 不能保证的部分 | 系统内存若持续紧张，Windows 仍可能把 PG 共享内存换出（见 §6） |

---

## §2 实测依据（为什么是 shared_buffers，不是别的）

### 2.1 一次查询要摸多少块

```
Limit  Buffers: shared hit=3720 read=3407
  ->  Index Scan using discovered_book_chunks_embedding_hnsw_idx
        Filter: ((embedding IS NOT NULL) AND (chapter_title IS NOT NULL))
        Buffers: shared hit=3625 read=3387      ← 约 7000 块 ≈ 56 MB
  ->  Memoize / Index Scan discovered_books_pkey   Buffers: shared hit=4
Execution Time: 38.053 ms
```

**一次查询的工作集 ≈ 56 MB**，而 `shared_buffers = 128 MB` —— 两条查询就把缓冲池刷空一遍。

### 2.2 同一条 query 连跑 4~5 次（本次会话实测）

| 场景 | 第 1 次 | 第 2 次 | 第 3 次 | 第 4 次 | 第 5 次 |
|---|---|---|---|---|---|
| refs[17]（冷） | **1159.8 ms** | 6.8 ms | 6.8 ms | 6.9 ms | 7.6 ms |
| refs[19]（冷） | **955.9 ms** | 7.5 ms | 7.1 ms | 5.4 ms | — |
| refs[18]（半热） | 863.2 ms | 10.3 ms | 8.7 ms | 8.5 ms | — |

**工作集一旦驻留，检索就是 5.4~7.6 ms —— 比 15 ms 的目标还低。**
也就是说 ≤15 ms 这个目标是**可达的**，只是当前配置下拿不到。

### 2.3 延迟到底能摆多宽（四次独立测量，单位 ms）

| 状态 | retrieve P50 | 说明 |
|---|---|---|
| 工作集全驻留（同一条 query 第 2~5 次） | **5.4 ~ 7.6** | 上限就是目标值的一半 |
| B.11 HTTP 压测当时 | **30.80** | 页面在 OS 页缓存里、但不在 shared_buffers 里 |
| 刚跑完一批大模型加载后（本次会话补测） | **82.14** | PG 缓冲池被挤出物理内存，warmup 单条 199~486 ms |
| 内存压力后的首次触碰 | **956 ~ 1160** | Windows 把 PG 共享内存换出到页面文件 |

**同一个代码、同一个索引、同一批 query，retrieve 在 5.4 ~ 1160 ms 之间摆动（200 倍）。**
这个摆动幅度本身就是结论：retrieve 的耗时**不由查询逻辑决定，由工作集在不在缓冲池里决定**。
所以「把工作集装进缓冲池」是唯一对症的动作，其余都是边缘优化。

⚠ 顺带说明：上表第 3 行是刚用 `api/b12-verify-after-tuning.py` 补测的，
和 B.11 报告里的 30.80 ms 差了一倍多 —— **不是回归，是机器内存状态变了**。
比较两次压测数字之前，务必确认当时系统内存状态可比。

### 2.4 为什么换 ONNX 没用（B.11 已证）

HTTP A/B 同机同批：`retrieve` torch 31.62 ms vs ONNX 30.80 ms。
因为瓶颈在 **PG 缓冲池的大小**，不在 OS 有没有空闲物理内存 —— 腾内存没打到点上。

---

## §3 当前环境实测（照抄前请核对）

| 项 | 值 |
|---|---|
| PostgreSQL | **18.6** on x86_64-windows（msvc），64 位 |
| 配置文件 | `D:/Program Files/PostgreSQL/data/postgresql.conf` |
| 数据目录 | `D:/Program Files/PostgreSQL/data` |
| 服务名 | **`postgresql-x64-18`**（状态 Running，启动类型 Automatic） |
| `shared_buffers` | **16384 × 8kB = 128 MB**（来源：configuration file） |
| `effective_cache_size` | 524288 × 8kB = **4 GB**（来源：default） |
| `max_connections` | 100 |
| `shared_memory_type` | windows |
| `huge_pages` | try（Windows 上无效，忽略） |
| 机器内存 | 15.19 GB；本次会话空闲在 **1.39 ~ 7.6 GB** 之间大幅波动 |
| 内存压力信号 | 观察到 **759 MB 「Memory Compression」** —— 系统确实在做内存压缩 |

### 库与对象大小

| 数据库 | 大小 | 说明 |
|---|---|---|
| **shutree** | 1287 MB | 唯一实际业务库 |
| dict | 7.9 MB | 词典 |
| postgres / template0 / template1 | 各 ~8 MB | 系统库 |

| 对象 | 大小 | 是否属于检索热路径 |
|---|---|---|
| `discovered_book_chunks`（堆表） | 808 MB | ✅ 过滤字段 `chapter_title` 在这里 |
| `discovered_book_chunks_embedding_hnsw_idx` | 456 MB | ✅ HNSW 索引本体 |
| `discovered_book_chunks_exp` + `exp_hnsw_idx` | 333 + 189 MB | ❌ 仅回归拟合用（B.8 两点拟合的小表） |
| `discovered_book_chunks_emb_v1` | 131 MB | ❌ 旧 embedding 备份 |

→ **检索热工作集 = 808 + 456 = 1264 MB**。这就是定 `shared_buffers` 的尺码依据。

---

## §4 三个档位（选哪个由你定，我推荐 B）

| 档位 | 值 | 能装下什么 | 适用 |
|---|---|---|---|
| A 保守 | **1 GB** | HNSW 索引 456 MB 全覆盖 + 约 570 MB 堆 | 想先小步验证，或担心内存余量 |
| **B 推荐** | **2 GB** | 索引 456 MB + 堆 808 MB **基本全覆盖**，还有 ~740 MB 余量 | **默认选这个** |
| C 激进 | 3 GB | 上面全部 + exp 表 522 MB 一起常驻 | 想连回归也一起加速；占内存更多 |

**为什么推荐 2 GB 而不是更大**：
shared_buffers 不是越大越好。它从 OS 手里拿走物理内存，太大反而挤压 OS 页缓存
（PG 的双缓存结构：shared_buffers + OS 页缓存）。本机 15 GB，2 GB 约占 13%，
是一个既能装下完整热工作集、又不至于把系统挤爆的平衡点。

---

## §5 执行步骤（PowerShell，**需要管理员权限**）

### 第 1 步：备份配置（必须）

```powershell
Copy-Item "D:\Program Files\PostgreSQL\data\postgresql.conf" `
          "D:\Program Files\PostgreSQL\data\postgresql.conf.bak-b11"
```

### 第 2 步：改配置（二选一）

**方式 1（推荐，改主配置文件，透明可查）**——用文本编辑器打开
`D:\Program Files\PostgreSQL\data\postgresql.conf`，找到 `shared_buffers` 那一行改成：

```conf
shared_buffers = 2GB          # was 128MB  —— B.11：单次查询工作集 56MB，128MB 装不下
```

（可选，同一份文件里）`effective_cache_size` 默认 4 GB 偏保守，它只影响优化器的代价估算、
不分配内存，可以顺势调大：

```conf
effective_cache_size = 8GB    # 只是给优化器的提示值，不占内存
```

**方式 2（`ALTER SYSTEM`，不碰主配置文件）**——连上库执行：

```sql
ALTER SYSTEM SET shared_buffers = '2GB';
-- 回滚：ALTER SYSTEM RESET shared_buffers;
```

⚠ 方式 2 会写进 `postgresql.auto.conf`（优先级高于主配置文件），
日后容易「明明主配置是 128MB 实际却是 2GB」这种找不到北的情况。
**我推荐方式 1**，改动看得见、`.bak` 就在旁边。

### 第 3 步：重启服务

```powershell
Restart-Service postgresql-x64-18
# 或：net stop postgresql-x64-18 ; net start postgresql-x64-18
```

### 第 4 步：验证（照抄即可）

```sql
SHOW shared_buffers;          -- 期望 2GB
SHOW effective_cache_size;    -- 期望 8GB（若改了）
```

```bash
# 1) 重启后先看 plan 是否还走 HNSW、行数是否还是 10
curl -s "http://127.0.0.1:8000/api/discover/health"        # 需先重启 API

# 2) HTTP 端到端压测（B.11 基线：e2e P50 52.02ms、retrieve P50 30.80ms）
C:/Python314/python.exe -u api/b9-http-benchmark.py --run --n 20 --warmup 8 \
    --out "server/.crawl-cache/_b12-http-bench-2gb.json"

# 3) 全量回归（B.11 基线：HNSW P50 6.71ms 热态 / EXACT P50 207.3ms）
curl -s "http://127.0.0.1:8000/api/discover/regression?sample=100"
```

**判成功的标准**：HTTP 压测的 `retrieve P50` 从 30.80 ms 掉到 **≤ 15 ms**。
（注意别拿回归端点的 6.71 ms 来比 —— 那是「每条跑 3 次取后 2 次」的热态口径。）

### 第 5 步：回滚（若效果不达预期或服务起不来）

```powershell
Copy-Item "D:\Program Files\PostgreSQL\data\postgresql.conf.bak-b11" `
          "D:\Program Files\PostgreSQL\data\postgresql.conf" -Force
Restart-Service postgresql-x64-18
```

数据目录在 `D:` 盘、可直接编辑，**即使 PG 起不来也改得回来**，不存在「改坏了进不去」的死锁。

---

## §6 影响面与风险（如实列）

### 需要停库，影响谁

| 依赖方 | 停机期间影响 | 恢复 |
|---|---|---|
| 主学习链路（背单词 / 生词本 SRS / 阅读器） | **不受影响** —— 纯离线 PWA，IndexedDB 本地存储 | — |
| `api/`（发现书籍检索 · 只读） | 断连，请求失败 | 重启 API 即可 |
| `server/`（Node，OCR / 词典 / ASR） | 连接池掉线 | pg 驱动一般会自动重连；必要时重启 Node |
| 正在跑的抓取 / 编码任务 | 会中断 | 需要重跑 |

建议窗口：挑一个没有长任务在跑的时间点，停机约 **10~30 秒**（2 GB 缓冲池初始化比 128 MB 慢一点）。

### 风险逐项

1. **共享内存分配失败 → 服务起不来**：值设得过大、或当时系统内存不足时会发生。
   处理：还原 `.bak` 重启。不影响数据。
2. **OS 可用内存少 2 GB**：本机 15.19 GB，本次会话空闲在 1.39~7.6 GB 波动。
   **如果常规状态下空闲只有 1~2 GB，建议先选 A 档（1 GB）**。
3. ⚠ **Windows 可能把 PG 共享内存换出**（这条最容易被忽略）：
   `shared_memory_type = windows`，共享内存是页面文件支持的共享段。
   本次会话观察到 **759 MB Memory Compression**，说明系统确实在压缩内存 ——
   一旦 PG 的缓冲池被换出到页面文件，首触延迟会飙到 **956~1160 ms**（§2.2 实测）。
   → 所以**调 shared_buffers 是必要条件，不是充分条件**；要稳定在 10 ms 级，
     还得让系统有真实内存余量。
4. **数据风险：零**。shared_buffers 不持久化任何内容；WAL / 崩溃恢复与它无关。

### 与 ONNX 的关系（两者互补，不是二选一）

B.11 把常驻内存从 1.95 GB 压到 1.31 GB，**省下的 0.64 GB 正好缓解上面第 3 条**
（系统越不紧张，PG 的缓冲池越不容易被换出）。
所以推荐组合是：**ONNX（省内存）+ shared_buffers 2GB（装得下工作集）**。

---

## §7 需要你决策的三件事

1. **档位**：A 1GB / **B 2GB（我推荐）** / C 3GB
2. **是否同时调 `effective_cache_size`**（4GB → 8GB）：只影响优化器估算，不占内存，风险极低
3. **执行窗口**：什么时候停库；以及要不要我先把「重跑对比」的脚本准备好，
   你重启完直接一条命令就能拿到前后对照

---

## §8 如果你不想动 postgresql.conf：还有两条退路

1. **降 ef_search**：能直接减少摸的块数。但 B.6 实测 ef 下降会掉召回
   （ef=80 → Top1 40/100，ef=800 → 49/100），且 160~400 是「优化器改用 book_idx 全扫」的退化区。
   **代价太大，不推荐**。
2. **把 `chapter_title` 过滤从检索路径拿掉**（建索引时就不收 front matter，或改成分区/部分索引）：
   能砍掉大量堆表回查。但这要改数据口径（会影响「20.18% 无章节块」这个既有事实），
   属于另一条决策链，B.11 没有动它。
