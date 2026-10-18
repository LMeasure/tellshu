# 格式转换 Worker（Python）

复用 `server/` 的 Postgres 连接与 `convert_tasks` / `convert_files` 两张表，
轮询 `waiting` 任务 → 调 Converter 插件 → 落结果文件 → 写回状态。

对应产品文档 [`格式转换.md`](../../格式转换.md) 的「任务系统 + Converter 插件体系 + Worker」思想。

## 与文档建议的差异（刻意收敛）

文档 §8 建议 Redis + Celery 作为队列。**本项目已有 pg 任务表与连接池**，
因此 Worker 直接轮询 pg（用 `UPDATE ... RETURNING` 原子认领），
不引入 Redis/Celery 等新依赖。这是用户拍板「复用现有 server/ + Python worker」后的最小实现。

## 目录结构

```
convert_worker/
├── worker.py                 # 入口：轮询循环 + 优雅退出
├── config.py                 # 环境变量（DATABASE_URL / CONVERT_*），不硬编码密钥
├── db.py                     # 认领任务 / 取源路径 / 写回结果 / 标记失败
├── converters/
│   ├── base.py               # Converter 抽象基类 + ConvertError 体系
│   ├── implementations.py    # 六个 V1 方向的插件骨架（均诚实抛 NotImplement）
│   └── registry.py           # (source,target) -> Converter 注册表
├── tests/test_registry.py    # 注册表单测（无需 DB）
└── requirements.txt
```

## 运行

前置：已执行 `server/sql/004_convert.sql` 建表；`server/.env` 含 `DATABASE_URL`
（Worker 会自动加载 `server/.env`）。

```bash
cd server
python -m venv .venv && source .venv/bin/activate   # 或 Windows: .venv\Scripts\activate
pip install -r convert_worker/requirements.txt

# 持续轮询（生产）
python -m convert_worker.worker

# 只跑一轮（测试 / 一次性处理积压）
python -m convert_worker.worker --once

# 自定义轮询间隔
python -m convert_worker.worker --poll-interval 5
```

### 依赖说明（V2 起）

`requirements.txt` 含 `PyMuPDF>=1.24,<2`——首个真实引擎 **PDF→PNG** 用它（纯库，无外部进程）。
安装后 `pdf_to_png.PdfToPngConverter` 才会真正渲染页面；若未安装，`import fitz` 在 `convert()` 内懒加载失败，
任务会被诚实标记 failed 并写回「PyMuPDF 未安装」原因（**绝不伪造输出**）。
> 注：`fitz` API 在较新 PyMuPDF 版本会提示 deprecated，未来可能需改用 `import pymupdf`；当前 `<2` 约束下 `import fitz` 仍可用。

### 启用真实转换

1. `pip install -r convert_worker/requirements.txt`（拿到 PyMuPDF，至少为一个方向提供能力）；
2. **后端** `server/.env` 设 `CONVERT_ENGINE_ENABLED=true`（否则 `/api/convert/tasks` 仍如实 503，前端显示未接入）；
3. 启动 Worker 轮询：任务会被 `UPDATE...RETURNING` 原子认领 → 调引擎 → 落结果 → 写回状态。
4. V2 已接入方向：**PDF→PNG**（PyMuPDF）；其余五个方向仍为 `ConverterNotImplemented`（诚实失败，不造假）。

环境变量（均可选，有默认值）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `DATABASE_URL` | 无（必填） | 与 server 同库；缺失则启动失败退出码 2 |
| `CONVERT_STORAGE_DIR` | `server/data/convert` | 结果文件落盘目录（仅用 uuid 命名，防路径穿越） |
| `CONVERT_POLL_INTERVAL` | `3` | 无任务时的轮询间隔（秒） |
| `CONVERT_MAX_FILE_BYTES` | `52428800` | 源文件上限（与 API 端 50MB 一致） |
| `CONVERT_TIMEOUT_SECONDS` | `300` | 预留：真实 Converter 应据此做超时保护 |
| `CONVERT_LOG_LEVEL` | `INFO` | 日志级别 |

## 当前状态（诚实声明）

**V2：首个真实引擎已接入 —— PDF→PNG（PyMuPDF）。** 其余五个方向
（PDF⇄DOCX / PNG·JPG→PDF / XLSX→PDF）的 `convert()` 仍诚实抛 `ConverterNotImplemented`
（附上文档 §8 推荐的落地工具），任务经 Worker 处理后诚实置为 `failed` 并写回原因，
**绝不伪造输出文件**——与「项目红线：不编造数据」一致。

前端在 `CONVERT_ENGINE_ENABLED=false`（默认）时，创建任务接口直接返回 `503`，
页面显示「格式转换服务未接入」，不会把请求发到 Worker。

## 如何新增一个真实转换方向

1. 在 `converters/implementations.py` 加一个子类，实现 `convert(input, output)`；
2. 在 `converters/registry.py` 的 `_REGISTRY` 登记 `("源", "目标")`；
3. 核心 `worker.py` 流程零改动。

真实实现注意（对应文档 §9 安全要求）：
- 用库 API 而非拼接 shell 命令处理用户文件；
- 大文件加超时（如 LibreOffice 用 `subprocess` + `timeout`）；
- `convert` 仅在确有结果时写文件，异常抛 `ConvertError`；
- 勿长期留存用户文件（失败半成品由 Worker `_cleanup` 删除）。

## 验收对照（文档 §13）

- ✅ 上传 / 创建任务 / 查询进度 / 下载：由 `server/src/routes/convert.ts` + 前端 `ConvertPanel` 闭环
- ✅ 转换失败有错误提示：Worker 写 `error_message`，前端展示
- ✅ 新增格式无需改核心流程：注册表插件化
- ⏳ Worker 异常不丢任务：认领即置 `processing`，失败置 `failed`；但 `processing` 长期卡死需监控（暂无自动重置，后续可加 `updated_at` 超时回滚）
- ❌ 实际转换能力：待按上面步骤接入真实引擎
