# 述树 ASR Sidecar（faster-whisper 本地转录服务）

Node server（`server/`）的转录旁路：模型常驻、单推理串行、canonical JSON 输出。
默认由 Node 启动时自动 spawn；本文件同时支持独立启动调试。

> 迁移来源：本目录核心推理代码（`asr_core/`）抽取自 `shutree/语音识别` 项目 v0.5.0
> 的 backend（FastAPI + faster-whisper 完整产品），适配点：裁剪任务系统 / AI 后处理 /
> SSE / 前端，仅保留推理链路，队列从 SQLAlchemy DB 队列退化为进程内串行队列。

## 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 探针：`{status, model_loaded, device, compute_type, queue_depth, vad_filter}`；模型未加载时进程根本起不来（预加载失败即启动失败，不造假） |
| POST | `/transcribe` | 表单 `path`（必填，Node 已落盘的媒体路径）+ `job_id`（可选，与 Node JobStore 对齐）+ `language`（auto/zh/en）→ 202 `{job_id, status}` |
| GET | `/jobs/{job_id}` | `{job_id, status: queued/running/done/failed, transcript?, error?, duration_ms?}` |

结果双交付：`GET /jobs/{id}` 直接返回 canonical `{language, duration, segments:[{start,end,text}]}`；
同时原子落盘 `<out_dir>/<job_id>.json`（默认 `server/data/asr/out/`，Node 侧按文件读取）。

## 快速开始（本机开发）

```bash
# 1. venv（Python 3.12/3.13 均可；spike 实测 3.13.12）
cd server/asr_service
python -m venv venv
./venv/Scripts/pip install -r requirements-asr.txt      # Windows
# ./venv/bin/pip install -r requirements-asr.txt        # 其他平台

# 2. 模型（已在位则跳过）：Whisper small，约 461MB
#    从 hf-mirror 直下 4 个文件到 server/data/asr-models/whisper-small/
curl -L -o server/data/asr-models/whisper-small/model.bin \
  https://hf-mirror.com/Systran/faster-whisper-small/resolve/main/model.bin
curl -L -o server/data/asr-models/whisper-small/config.json \
  https://hf-mirror.com/Systran/faster-whisper-small/resolve/main/config.json
curl -L -o server/data/asr-models/whisper-small/tokenizer.json \
  https://hf-mirror.com/Systran/faster-whisper-small/resolve/main/tokenizer.json
curl -L -o server/data/asr-models/whisper-small/vocabulary.txt \
  https://hf-mirror.com/Systran/faster-whisper-small/resolve/main/vocabulary.txt

# 3a. 独立启动（调试用）
python -m uvicorn app:app --host 127.0.0.1 --port 8177

# 3b. 命令行冒烟（不走 HTTP，直接出 canonical JSON）
python -m asr_core.transcriber server/data/asr/in/demo/clip.mp4 --language auto
```

生产路径无需手动启动：Node server 启动时自动 spawn（`ASR_PYTHON_PATH` 指向 venv 的
python.exe，模型目录/端口走 `ASR_*` 配置），`/health` 就绪后才放行提交；
sidecar 未就绪 → 路由 503「转录服务未接入」，不排队假任务。

## 配置（环境变量，均有默认值）

| 变量 | 默认 | 说明 |
|---|---|---|
| `ASR_HOST` / `ASR_PORT` | `127.0.0.1` / `8177` | 仅监听回环；端口避开 8000/5173/4174/5432 |
| `ASR_MODEL_DIR` | `../../data/asr-models/whisper-small` | 本地模型目录优先；不存在则回退 `ASR_MODEL_SIZE` 走 HuggingFace |
| `ASR_MODEL_SIZE` | `small` | 回退时的模型名（需能访问 HuggingFace；交付环境用本地目录） |
| `ASR_DEVICE` / `ASR_COMPUTE_TYPE` | `cpu` / `int8` | GPU 主机可设 `auto`；有 CUDA 自动 float16，失败回退 CPU |
| `ASR_LANGUAGE` | `auto` | 默认语种；auto = 每次检测 |
| `ASR_BEAM_SIZE` | `5` | 束宽 1-10 |
| `ASR_VAD_FILTER` | `false` | silero VAD 过滤（Phase1.5 决策点 5：默认关；开需 onnxruntime） |
| `ASR_PRELOAD_MODEL` | `true` | 启动即加载模型（health 门控依赖；false 则首任务懒加载） |
| `ASR_MAX_FILE_MB` | `100` | 输入媒体上限（产品口径，与前端 `MAX_MEDIA_BYTES` 一致） |
| `ASR_SUPPORTED_EXTENSIONS` | wav/mp3/m4a/flac/ogg/aac/wma/amr/mp4/mkv/mov/webm/ts/flv/avi | 容器白名单（PyAV 内置 ffmpeg，spike 实测 flac/mp3/mkv/mp4 直收） |
| `ASR_OUT_DIR` | `../../data/asr/out` | canonical transcript 落盘目录 |
| `ASR_LOG_LEVEL` / `ASR_LOG_FORMAT` | `INFO` / `text` | 日志；json 供平台摄取 |

## 版本锁定（重要）

- `av==18.1.0`：**勿升级**。av 19 移除 `av.open(metadata_errors=...)`，faster-whisper 1.2.1 仍传该参数 → TypeError（spike 2026-10-17 实测）。
- `faster-whisper==1.2.1` + `ctranslate2==4.8.3`：spike 实测组合，直载本地模型目录，**不依赖 hf_hub 缓存**（snapshot_download 在本机有 0 字节占位异常）。
- 模型 Whisper small int8：峰值内存约 0.48GB、转录约 2 倍实时（Ryzen 9 9955HX 16 线程）。换 base/small 只需替换模型目录；medium/large 在本机内存约束下不可行，勿无脑切换。

## 数据边界

- 输入：`server/data/asr/in/<jobId>/<原名>`（Node 落盘，sidecar 只读，不删除——清理由 Node 在任务终态后执行）。
- 输出：`server/data/asr/out/<jobId>.json`（canonical JSON）。
- 以上目录均在 `data/` 下，已被 `.gitignore` 忽略，不进 git。
