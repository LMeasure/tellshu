"""述树 ASR sidecar（FastAPI + uvicorn）。

被 Node server 以子进程方式 spawn（默认路径），也可独立启动调试：
    python -m uvicorn app:app --host 127.0.0.1 --port 8177

端点（Phase1.5 修订版 §5）：
- GET  /health          模型就绪探针（Node spawn 后轮询，60s 宽限）
- POST /transcribe      表单：path（必填）/ job_id（可选）/ language（可选）→ 入队
- GET  /jobs/{job_id}   查询状态与 canonical transcript

设计红线：
- 输入是 Node 已落盘的路径，媒体不驻内存、不经 HTTP 传输；
- 推理串行（单 worker 循环），排队任务如实返回 queued；
- 未就绪 / 坏文件 / 解码失败一律明确错误，绝不返回空结果冒充成功；
- 错误响应只含可读信息，堆栈与内部细节只进日志。
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Form
from fastapi.responses import JSONResponse

from asr_core.config import ConfigError, load_settings
from asr_core.errors import AppError
from asr_core.job_queue import AsrJobQueue
from asr_core.logconf import configure_logging
from asr_core.transcriber import Transcriber

logger = logging.getLogger("asr.sidecar")

settings = load_settings()
configure_logging(level=settings.log_level, fmt=settings.log_format)

transcriber = Transcriber(settings)
queue = AsrJobQueue(transcriber, settings)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    if settings.preload_model:
        # 同步加载（实测 1.3-2.1s）；失败如实抛出，uvicorn 启动即失败——
        # Node 侧 health 探针拿不到响应 → 转录服务未接入，不造假。
        logger.info("预加载模型（ASR_PRELOAD_MODEL=true）…")
        try:
            transcriber.warmup()
        except Exception as exc:  # noqa: BLE001 - 启动期失败必须显式暴露
            logger.exception("模型预加载失败")
            raise RuntimeError(f"模型预加载失败：{type(exc).__name__}: {exc}") from exc
    queue.start()
    logger.info("sidecar 就绪 host=%s port=%s", settings.host, settings.port)
    yield
    await queue.stop()


app = FastAPI(title="shutree-asr-sidecar", version="1.0.0", lifespan=lifespan)


@app.exception_handler(AppError)
async def app_error_handler(_request, exc: AppError) -> JSONResponse:
    return JSONResponse(status_code=exc.http_status, content=exc.to_payload())


@app.exception_handler(ConfigError)
async def config_error_handler(_request, exc: ConfigError) -> JSONResponse:
    logger.error("配置错误：%s", exc)
    return JSONResponse(status_code=500, content={"success": False, "code": "CONFIG_ERROR", "message": "sidecar 配置错误"})


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "model_loaded": transcriber.ready,
        "model_ref": transcriber.model_ref,
        "device": transcriber.device,
        "compute_type": transcriber.compute_type,
        "queue_depth": queue.queue_depth,
        "vad_filter": settings.vad_filter,
    }


@app.post("/transcribe", status_code=202)
def transcribe(
    path: str = Form(...),
    job_id: str | None = Form(default=None),
    language: str | None = Form(default=None),
) -> dict:
    # job_id 由 Node 侧 JobStore 生成并透传（两侧同一 id，便于对账/调试）；
    # 重复 id 返回 503 明确错误，绝不静默覆盖已有任务。
    job = queue.submit(path=path, filename=path, language=language, job_id=job_id)
    return job.to_payload()


@app.get("/jobs/{job_id}")
def get_job(job_id: str) -> dict:
    try:
        job = queue.get(job_id)
    except KeyError:
        return JSONResponse(
            status_code=404,
            content={"success": False, "code": "JOB_NOT_FOUND", "message": f"任务不存在：{job_id}"},
        )
    return job.to_payload()
