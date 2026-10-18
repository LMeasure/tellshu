"""输入边界校验与解码探测。

迁移自 shutree/语音识别/backend/app/services/upload.py（v0.5.0）。
适配点：
- 删除 save_to_temp / save_to_storage：sidecar 输入是 Node 已落盘的**路径**
  （媒体不驻内存 Node 侧双份拷贝的设计，见 Phase1.5 修订版 §3）；
- validate_extension 白名单扩充为 spike 2026-10-17 实测可收的音频+视频容器；
- 保留 probe_audio：用 PyAV 试解码一帧，把损坏/伪装文件变成明确错误。
"""
from __future__ import annotations

import logging
from pathlib import Path

from asr_core.config import SidecarSettings
from asr_core.errors import (
    AudioDecodeError,
    EmptyFileError,
    InputFileGoneError,
    InvalidLanguageError,
    PayloadTooLargeError,
    UnsupportedMediaTypeError,
)

logger = logging.getLogger("asr.upload")


def validate_extension(filename: str, settings: SidecarSettings) -> str:
    suffix = Path(filename).suffix.lower().lstrip(".")
    if not suffix:
        raise UnsupportedMediaTypeError(
            f"文件没有扩展名，支持的容器：{' / '.join(sorted(settings.supported_extensions))}"
        )
    if suffix not in settings.supported_extensions:
        raise UnsupportedMediaTypeError(
            f"不支持的容器：{suffix}（支持：{' / '.join(sorted(settings.supported_extensions))}）"
        )
    return suffix


def validate_language(language: str | None) -> str:
    value = (language or "auto").strip().lower()
    if value not in {"auto", "zh", "en"}:
        raise InvalidLanguageError(f"不支持的语言参数：{language!r}（可用：auto / zh / en）")
    return value


def resolve_input(path: str, filename: str, settings: SidecarSettings) -> Path:
    """把 Node 传入的路径解析为可用的输入文件：存在性 / 扩展名 / 大小 / 非空四重校验。"""
    if not path:
        raise InputFileGoneError("未提供输入文件路径")
    p = Path(path)
    if not p.is_file():
        raise InputFileGoneError(f"输入文件不存在：{path}")
    validate_extension(filename or p.name, settings)
    size = p.stat().st_size
    if size == 0:
        raise EmptyFileError("输入文件内容为空")
    if size > settings.max_file_bytes:
        raise PayloadTooLargeError(
            f"文件超过大小上限 {settings.max_file_mb}MB（当前 {size // (1024 * 1024)}MB）"
        )
    return p


def probe_audio(path: Path) -> None:
    """用 PyAV 试解码一帧，提前把损坏/伪装文件变成明确的错误。"""

    def _probe() -> None:
        import av

        with av.open(str(path)) as container:
            stream = container.streams.audio[0]
            for _frame in container.decode(stream):
                break

    try:
        _probe()
    except Exception as exc:  # noqa: BLE001 - av 异常类型不统一，统一收敛
        raise AudioDecodeError(
            f"文件无法解码，请确认文件未损坏且容器格式正确（{type(exc).__name__}）"
        ) from exc
