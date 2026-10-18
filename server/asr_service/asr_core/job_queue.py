"""进程内串行任务队列（新增，不迁移）。

原「语音识别」项目用 SQLAlchemy + SQLite 数据库队列支持多 Worker / 崩溃恢复；
sidecar 定位是本机单人使用 + Node 托管生命周期，队列退化为进程内单 worker
asyncio 循环：同一时刻只有一次推理（本机内存约束下多推理必然互相踩踏），
其余任务排队——状态 queued/running/done/failed 与 Node 侧 JobStore 同构。

结果双交付：GET /jobs/{id} 直接返回 canonical JSON；同时原子落盘
<out_dir>/<job_id>.json，Node 侧 fetchTranscript 按文件读取（与 OCR/convert
结果走文件的惯例一致）。
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from asr_core.config import SidecarSettings
from asr_core.errors import AppError, SidecarBusyError
from asr_core.model import TranscriptionResult
from asr_core.transcriber import Transcriber
from asr_core.upload import probe_audio, resolve_input, validate_language

logger = logging.getLogger("asr.queue")

MAX_PENDING = 64          # queued+running 上限（背压，超出返回 503 不排队假任务）
MAX_FINISHED_JOBS = 500   # 进程内终态记录上限，超出淘汰最旧（防内存泄漏）
_TERMINAL = {"done", "failed"}


@dataclass(slots=True)
class AsrJob:
    job_id: str
    status: str                     # queued / running / done / failed
    language: str
    input_path: str
    filename: str
    created_at: float = field(default_factory=time.time)
    started_at: float | None = None
    finished_at: float | None = None
    duration_ms: int | None = None  # 推理耗时（不含排队）
    transcript: dict | None = None  # canonical {language, duration, segments}
    error: str | None = None

    def to_payload(self) -> dict:
        payload: dict = {"job_id": self.job_id, "status": self.status}
        if self.transcript is not None:
            payload["transcript"] = self.transcript
        if self.error is not None:
            payload["error"] = self.error
        if self.duration_ms is not None:
            payload["duration_ms"] = self.duration_ms
        return payload


class AsrJobQueue:
    """单 worker 串行执行器。start() 后常驻，stop() 优雅退出。"""

    def __init__(self, transcriber: Transcriber, settings: SidecarSettings) -> None:
        self._transcriber = transcriber
        self._settings = settings
        self._jobs: dict[str, AsrJob] = {}
        self._pending: asyncio.Queue[str] = asyncio.Queue()
        self._worker: asyncio.Task | None = None
        self._out_dir = Path(settings.out_dir)

    # ---- 生命周期 ----

    def start(self) -> None:
        if self._worker is None:
            self._worker = asyncio.create_task(self._run(), name="asr-queue-worker")

    async def stop(self) -> None:
        if self._worker is not None:
            self._worker.cancel()
            try:
                await self._worker
            except asyncio.CancelledError:
                pass
            self._worker = None

    def _evict_finished_if_needed(self) -> None:
        """终态记录超限时淘汰最旧者。只淘汰终态任务——排队中/执行中的
        任务 id 可能仍在 _pending 队列里，绝不能淘汰（worker 找不到会静默丢任务）。"""
        finished = [j for j in self._jobs.values() if j.status in _TERMINAL]
        if len(finished) <= MAX_FINISHED_JOBS:
            return
        finished.sort(key=lambda j: j.finished_at or j.created_at)
        for victim in finished[: len(finished) - MAX_FINISHED_JOBS]:
            self._jobs.pop(victim.job_id, None)
            logger.info("终态记录淘汰 job_id=%s", victim.job_id)

    # ---- 对外接口 ----

    def submit(
        self, path: str, filename: str, language: str | None, job_id: str | None = None
    ) -> AsrJob:
        """校验输入并入队，毫秒级返回。调用方（FastAPI 同步上下文）轮询 get()。"""
        self._evict_finished_if_needed()
        queued = sum(1 for j in self._jobs.values() if j.status not in _TERMINAL)
        if queued >= MAX_PENDING:
            raise SidecarBusyError("转录队列已满，请稍后重试")
        p = resolve_input(path, filename, self._settings)
        lang = validate_language(language)
        # Node 侧可自带 job_id（与其 JobStore 对齐）；未带则服务端生成
        final_id = (job_id or "").strip() or uuid.uuid4().hex
        if final_id in self._jobs:
            raise SidecarBusyError(f"job_id 已存在：{final_id}")
        job = AsrJob(
            job_id=final_id,
            status="queued",
            language=lang,
            input_path=str(p),
            filename=filename or p.name,
        )
        self._jobs[final_id] = job
        self._pending.put_nowait(final_id)
        logger.info("任务入队 job_id=%s language=%s file=%s", final_id, lang, job.filename)
        return job

    def get(self, job_id: str) -> AsrJob:
        job = self._jobs.get(job_id)
        if job is None:
            raise KeyError(job_id)
        return job

    @property
    def queue_depth(self) -> int:
        return sum(1 for j in self._jobs.values() if j.status not in _TERMINAL)

    # ---- 内部 ----

    async def _run(self) -> None:
        logger.info("队列 worker 启动（单推理串行）")
        while True:
            job_id = await self._pending.get()
            job = self._jobs.get(job_id)
            if job is None:  # 已被淘汰（理论上不会：pending 淘汰只清理终态）
                continue
            try:
                await self._process(job)
            except Exception as exc:  # noqa: BLE001 - worker 不允许因单任务崩溃
                logger.exception("任务处理异常 job_id=%s", job_id)
                job.status = "failed"
                job.error = f"转录失败：{type(exc).__name__}"
                job.finished_at = time.time()
        # 注意：这里不可达，stop() 走 cancel

    async def _process(self, job: AsrJob) -> None:
        job.status = "running"
        job.started_at = time.time()
        logger.info("开始识别 job_id=%s", job.job_id)
        try:
            # 与 worker 单线程模型实例配套：同步推理放线程池，不阻塞事件循环
            await asyncio.to_thread(probe_audio, Path(job.input_path))
            result: TranscriptionResult = await asyncio.to_thread(
                self._transcriber.transcribe_file, job.input_path, job.language
            )
        except FileNotFoundError as exc:
            job.status = "failed"
            job.error = str(exc)
            job.finished_at = time.time()
            logger.warning("输入文件丢失 job_id=%s：%s", job.job_id, exc)
            return
        except AppError as exc:
            # 探测/校验阶段的类型化错误（如解码失败）：保留可读原文，
            # 调用方能区分「文件坏」与「识别过程异常」，方便 UI 给准建议
            job.status = "failed"
            job.error = exc.message
            job.finished_at = time.time()
            logger.warning("任务被拒 job_id=%s：%s", job.job_id, exc.message)
            return
        except Exception as exc:  # noqa: BLE001 - 细节只进日志，对外给可读信息
            job.status = "failed"
            job.error = "转录失败，请确认文件未损坏且格式受支持"
            job.finished_at = time.time()
            logger.exception("识别失败 job_id=%s", job.job_id)
            return

        canonical = result.to_canonical()
        job.transcript = canonical
        job.status = "done"
        job.finished_at = time.time()
        if job.started_at is not None:
            job.duration_ms = int((job.finished_at - job.started_at) * 1000)
        self._persist(job, canonical)
        logger.info(
            "识别完成 job_id=%s duration_ms=%s segments=%d",
            job.job_id,
            job.duration_ms,
            len(canonical["segments"]),
        )

    def _persist(self, job: AsrJob, canonical: dict) -> None:
        """原子落盘 <out_dir>/<job_id>.json（tmp + os.replace，防读到半截文件）。"""
        try:
            self._out_dir.mkdir(parents=True, exist_ok=True)
            final = self._out_dir / f"{job.job_id}.json"
            tmp = final.with_suffix(".json.tmp")
            with tmp.open("w", encoding="utf-8") as fh:
                json.dump(canonical, fh, ensure_ascii=False, indent=2)
            os.replace(tmp, final)
        except Exception:  # noqa: BLE001 - 落盘失败不影响内存态结果，Node 仍可走 HTTP 取
            logger.exception("结果落盘失败 job_id=%s", job.job_id)
