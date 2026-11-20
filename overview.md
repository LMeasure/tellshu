# 格式转换 V2 交付总览（2026-10-13）

## 一句话结论
在 V1 骨架基础上，打通了**首个真实转换引擎 PDF→PNG（PyMuPDF）**，补齐了**任务超时回滚**与**上传路由安全防线**，端到端闭环已可验证。其余 5 个方向仍诚实保持 `ConverterNotImplemented`，绝不伪造输出。

## 交付清单（按层）

### Python Worker（真实引擎 + 回滚 + 安全）
| 文件 | 关键内容 |
|---|---|
| `server/convert_worker/converters/pdf_to_png.py` | **真实引擎**：PyMuPDF 每页→`page_001.png`…，dpi 默认 150/clamp[72,600]，`max_pages` 防爆内存；`fitz` 懒加载 |
| `server/convert_worker/converters/base.py` | `convert(input, output_dir, **opts) -> list[str]`（支持多文件产出） |
| `server/convert_worker/converters/registry.py` | `("pdf","png")` 直接指向真实引擎 |
| `server/convert_worker/db.py` | 注入连接（可 SQLite 单测）；`reclaim_stale_tasks(timeout)`；多结果 `result_files` jsonb；`psycopg2` 懒加载 |
| `server/convert_worker/worker.py` | 每任务独立输出目录；处理完删源文件；每 `reclaim_every`(10) 轮回滚 |
| `server/convert_worker/config.py` | 新增 `reclaim_every` / `task_timeout` |
| `server/convert_worker/tests/test_reclaim.py` | 超时回滚 3 例（内存 SQLite） |
| `server/convert_worker/tests/test_e2e_pdf_to_png.py` | 引擎端到端（2 页 PDF→2 PNG + dpi clamp + max_pages） |

### 后端（安全防线）
| 文件 | 关键内容 |
|---|---|
| `server/sql/005_convert_result_files.sql` | `convert_tasks` 增 `result_files jsonb`（多页结果；幂等） |
| `server/src/http/errors.ts` | 新增 415 `unsupportedMediaType` |
| `server/src/routes/convert.ts` | `CONVERT_MAX_FILE_SIZE`(默认50MB→413)；扩展名+Content-Type 双白名单(→415)；文件名清洗；uuid 落盘；零 shell |

### 文档
- `格式转换-交付说明.md`：新增第六节「V2 交付」
- `产品前提卡-给协作方.md`：更新日志 + §8 红线 #9（PDF→PNG 已接入，其余 5 仍 NOT_IMPLEMENTED）+ 架构注
- `server/convert_worker/README.md`：PyMuPDF 安装 + `CONVERT_ENGINE_ENABLED=true` 启用流程

## 验证结果（诚实标注）
- ✅ Worker `py_compile` 全量通过
- ✅ Worker 单测 9 项：7 通过 / 2 跳过（沙箱默认未装 PyMuPDF）
- ✅ 引擎实跑：隔离 venv 装 `PyMuPDF==1.28.2` 后 e2e 2/2 通过（生成 2 张合法 PNG、dpi clamp、max_pages 生效），验证后已删除该 venv
- ✅ `convert.ts` / `errors.ts` 类型检查通过
- ⚠️ **既有无关错误（非本次引入，未动）**：`server/src/asr/providers/tencent.ts:27` 误从 `node:crypto` 导入 `deflateSync`（应为 `node:zlib`），导致 server 整体 typecheck/build 失败。属越界改动，已如实标注，待你拍板是否单独修。

## 红线守住情况
- 纯离线不受影响：转换是 `server/` 旁路服务，引擎默认关（`CONVERT_ENGINE_ENABLED=false`）时任务接口仍如实 503。
- 不编造：5 个未接入方向继续诚实 `failed` + 写回原因，无假文件。
- 未动无关文件：仅改 `convert_worker/*` 与 `convert` 相关 `server/src/*`；`tencent.ts` 等未触碰。

## 后续可选项
1. 修 `tencent.ts` 的 `deflateSync` 导入（一行，但越界，需你确认）。
2. 多页 PDF→PNG 的打包下载（ZIP），目前下载返回第一页。
3. 接入其余 5 个方向（文档 §8 已附推荐工具）。
