"""ASR 模型封装：faster-whisper 引擎 + CPU/GPU 自动切换 + 语言自动检测。

迁移自 shutree/语音识别/backend/app/asr/model.py（v0.5.0）。
适配点：
- transcribe() 的 vad_filter 由配置控制（Phase1.5 决策点 5：默认关，切配置可开）；
- 其余（延迟加载、本地目录优先、GPU 失败回退 CPU、静音预热）原样保留。
业务代码只依赖本模块暴露的 transcribe()，不接触具体推理库。
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path

from asr_core.config import SidecarSettings

logger = logging.getLogger("asr.model")


@dataclass(slots=True)
class Segment:
    """带时间戳的识别片段（单位：秒）。"""

    start: float
    end: float
    text: str


@dataclass(slots=True)
class TranscriptionResult:
    """识别结果（canonical 形态，与 Node 侧 Phase 1 Transcript 结构同构）。"""

    text: str
    language: str
    duration: float
    segments: list[Segment] = field(default_factory=list)

    def to_canonical(self) -> dict:
        return {
            "language": self.language,
            "duration": round(self.duration, 2),
            "segments": [
                {"start": round(seg.start, 2), "end": round(seg.end, 2), "text": seg.text}
                for seg in self.segments
            ],
        }


def detect_device(preferred: str = "auto") -> tuple[str, str]:
    """返回 (device, compute_type)。

    preferred=auto 时有 CUDA 用 GPU(float16)，否则 CPU(int8)。
    """
    if preferred in ("cpu", "cuda"):
        return preferred, "float16" if preferred == "cuda" else "int8"
    try:
        import ctranslate2

        if ctranslate2.get_cuda_device_count() > 0:
            return "cuda", "float16"
    except Exception:  # noqa: BLE001 - 探测失败时安全退回 CPU
        logger.warning("CUDA 探测失败，回退到 CPU", exc_info=True)
    return "cpu", "int8"


class ASRModel:
    """faster-whisper 模型封装（延迟加载，首次使用时初始化）。"""

    def __init__(self, settings: SidecarSettings) -> None:
        self._settings = settings
        self._model = None
        self._device: str | None = None
        self._compute_type: str | None = None
        self._model_ref: str | None = None  # 实际加载的模型目录或名称

    @property
    def ready(self) -> bool:
        return self._model is not None

    @property
    def model_ref(self) -> str | None:
        return self._model_ref

    @property
    def device(self) -> str | None:
        return self._device

    @property
    def compute_type(self) -> str | None:
        return self._compute_type

    def load(self) -> None:
        """加载模型（幂等）。本地目录优先，缺失时按模型名从 HuggingFace 下载。

        GPU 不可用时（如缺少 CUDA 运行库）自动回退到 CPU(int8)。
        """
        if self._model is not None:
            return
        from faster_whisper import WhisperModel

        local_dir = self._settings.resolved_model_dir
        device, compute_type = detect_device(self._settings.device)
        if self._settings.compute_type != "auto":
            compute_type = self._settings.compute_type

        model_ref = str(local_dir) if local_dir is not None else self._settings.model_size
        logger.info(
            "加载模型 model=%s device=%s compute_type=%s",
            model_ref,
            device,
            compute_type,
        )
        self._model = WhisperModel(model_ref, device=device, compute_type=compute_type)
        try:
            self._warmup()
        except Exception as exc:  # noqa: BLE001 - GPU 缺库等场景统一回退 CPU
            if device != "cuda":
                raise
            logger.warning("GPU 初始化失败（%s），自动回退到 CPU(int8)", exc)
            self._model = WhisperModel(model_ref, device="cpu", compute_type="int8")
            device, compute_type = "cpu", "int8"
            self._warmup()
        self._device = device
        self._compute_type = compute_type
        self._model_ref = model_ref
        logger.info("模型加载完成（device=%s compute_type=%s）", device, compute_type)

    def _warmup(self) -> None:
        """用 1 秒静音做一次微型推理：验证推理库（CUDA）可用并预热模型。

        注意：必须让 language=None 走「语言检测 → 编码」完整路径，
        GPU 缺库（如 cublas64_12.dll 缺失）的错误才会在这里暴露，
        从而触发 load() 里的 CPU 回退；固定 language 会跳过检测，预热可能空转。
        预热打在静音上，日志（如检出的语言）没有业务含义，临时压低日志级别。
        """
        import numpy as np

        fw_logger = logging.getLogger("faster_whisper")
        previous_level = fw_logger.level
        fw_logger.setLevel(logging.WARNING)
        try:
            silence = np.zeros(16000, dtype=np.float32)
            for _segment in self._model.transcribe(silence, beam_size=1):
                break
        finally:
            fw_logger.setLevel(previous_level)

    def transcribe(self, audio_path: str | Path, language: str | None = None) -> TranscriptionResult:
        """识别音频文件，返回文本 + 时间戳分段。

        language=None 或 "auto" 时自动检测语种。
        """
        if self._model is None:
            raise RuntimeError("模型尚未加载，请先调用 load()")
        lang = None if language in (None, "", "auto") else language
        segments_iter, info = self._model.transcribe(
            str(audio_path),
            language=lang,
            beam_size=self._settings.beam_size,
            vad_filter=self._settings.vad_filter,
        )
        raw_texts: list[str] = []
        segments: list[Segment] = []
        for seg in segments_iter:
            raw_texts.append(seg.text)
            segments.append(Segment(start=float(seg.start), end=float(seg.end), text=seg.text.strip()))
        # 原始文本直接拼接（英文段首带空格，中英文都自然）；分段展示用 strip 后的干净文本
        text = "".join(raw_texts).strip()
        return TranscriptionResult(
            text=text,
            language=str(info.language),
            duration=float(info.duration),
            segments=segments,
        )
