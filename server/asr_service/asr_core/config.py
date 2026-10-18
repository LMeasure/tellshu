"""Sidecar 运行配置：全部来自环境变量，加载时校验。

迁移来源：shutree/语音识别/backend/app/asr/config.py（v0.5.0）。
适配说明：原文件 40+ 字段服务于任务系统 / AI 后处理 / HTTP 接口层，
本 sidecar 只用推理与队列相关子集；新增 out_dir / port / host /
load_timeout_seconds / preload_model / vad_filter / max_file_mb /
supported_extensions 八个 sidecar 专属项。
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

SERVICE_ROOT = Path(__file__).resolve().parents[1]      # server/asr_service/
SERVER_ROOT = SERVICE_ROOT.parent                        # server/
DEFAULT_MODEL_DIR = SERVER_ROOT / "data" / "asr-models" / "whisper-small"
DEFAULT_OUT_DIR = SERVER_ROOT / "data" / "asr" / "out"
DEFAULT_IN_DIR = SERVER_ROOT / "data" / "asr" / "in"

_LOG_LEVELS = {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}
_LOG_FORMATS = {"text", "json"}
_DEVICES = {"auto", "cpu", "cuda"}
_COMPUTE_TYPES = {"auto", "default", "int8", "float16", "float32", "bfloat16"}
_LANGUAGES = {"auto", "zh", "en"}
_TRUE_VALUES = {"1", "true", "yes", "on"}
# PyAV 内置 ffmpeg 解码，spike 2026-10-17 实测 flac/mp3/mkv/mp4 直收成功；
# 白名单（可由 ASR_SUPPORTED_EXTENSIONS 覆盖）覆盖常见音频/视频容器
DEFAULT_EXTENSIONS = (
    "wav", "mp3", "m4a", "flac", "ogg", "aac", "wma", "amr",
    "mp4", "mkv", "mov", "webm", "ts", "flv", "avi",
)

# 端口避开常见占用：8000（语音识别项目 API）/ 5173 / 4174 / 5432
DEFAULT_PORT = 8177


class ConfigError(Exception):
    """配置非法。"""


def _env(name: str, default: str) -> str:
    value = os.environ.get(name)
    if value is None or value.strip() == "":
        return default
    return value.strip()


def _env_int(name: str, default: int) -> int:
    raw = _env(name, str(default))
    try:
        return int(raw)
    except ValueError as exc:
        raise ConfigError(f"配置项 {name} 必须是整数，当前值：{raw!r}") from exc


def _env_float(name: str, default: float) -> float:
    raw = _env(name, str(default))
    try:
        return float(raw)
    except ValueError as exc:
        raise ConfigError(f"配置项 {name} 必须是数字，当前值：{raw!r}") from exc


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() in _TRUE_VALUES


def _env_list(name: str, default: tuple[str, ...]) -> tuple[str, ...]:
    raw = _env(name, "")
    if not raw.strip():
        return default
    return tuple(item.strip().lower() for item in raw.split(",") if item.strip())


@dataclass(frozen=True)
class SidecarSettings:
    """ASR sidecar 运行配置（进程启动时一次性加载）。"""

    host: str
    port: int
    model_dir: str                 # 本地模型目录（优先）
    model_size: str                # 模型目录缺失时使用的模型名（需能访问 HuggingFace）
    device: str                    # auto / cpu / cuda
    compute_type: str              # auto / int8 / float16 / ...
    language: str                  # 默认识别语言，auto = 自动检测
    beam_size: int
    vad_filter: bool               # 是否启用 silero VAD 过滤（决策点 5：默认关）
    preload_model: bool            # 服务启动即加载模型（health 门控依赖）
    load_timeout_seconds: int      # Node 侧 health 探针宽限上限（仅文档语义，sidecar 自身同步加载）
    max_file_mb: int               # 输入媒体大小上限（产品口径沿用 100MB）
    supported_extensions: tuple[str, ...]
    out_dir: str                   # canonical transcript 落盘目录（<jobId>.json）
    log_level: str
    log_format: str

    @property
    def max_file_bytes(self) -> int:
        return self.max_file_mb * 1024 * 1024

    @property
    def resolved_model_dir(self) -> Path | None:
        """返回可用的本地模型目录；不存在则 None（回退 model_size 走 HuggingFace）。"""
        if not self.model_dir:
            return None
        path = Path(self.model_dir)
        if not path.is_absolute():
            path = SERVER_ROOT / path
        return path if path.is_dir() else None


def load_settings() -> SidecarSettings:
    settings = SidecarSettings(
        host=_env("ASR_HOST", "127.0.0.1"),
        port=_env_int("ASR_PORT", DEFAULT_PORT),
        model_dir=_env("ASR_MODEL_DIR", str(DEFAULT_MODEL_DIR)),
        model_size=_env("ASR_MODEL_SIZE", "small"),
        device=_env("ASR_DEVICE", "cpu").lower(),
        compute_type=_env("ASR_COMPUTE_TYPE", "int8").lower(),
        language=_env("ASR_LANGUAGE", "auto").lower(),
        beam_size=_env_int("ASR_BEAM_SIZE", 5),
        vad_filter=_env_bool("ASR_VAD_FILTER", False),
        preload_model=_env_bool("ASR_PRELOAD_MODEL", True),
        load_timeout_seconds=_env_int("ASR_LOAD_TIMEOUT_S", 60),
        max_file_mb=_env_int("ASR_MAX_FILE_MB", 100),
        supported_extensions=_env_list("ASR_SUPPORTED_EXTENSIONS", DEFAULT_EXTENSIONS),
        out_dir=_env("ASR_OUT_DIR", str(DEFAULT_OUT_DIR)),
        log_level=_env("ASR_LOG_LEVEL", "INFO").upper(),
        log_format=_env("ASR_LOG_FORMAT", "text").lower(),
    )
    _validate(settings)
    return settings


def _validate(settings: SidecarSettings) -> None:
    if settings.device not in _DEVICES:
        raise ConfigError(f"ASR_DEVICE 必须是 {sorted(_DEVICES)} 之一，当前值：{settings.device!r}")
    if settings.compute_type not in _COMPUTE_TYPES:
        raise ConfigError(f"ASR_COMPUTE_TYPE 非法：{settings.compute_type!r}（可用：{sorted(_COMPUTE_TYPES)}）")
    if settings.language not in _LANGUAGES:
        raise ConfigError(f"ASR_LANGUAGE 必须是 auto / zh / en 之一，当前值：{settings.language!r}")
    if not 1 <= settings.beam_size <= 10:
        raise ConfigError(f"ASR_BEAM_SIZE 必须在 1-10 之间，当前值：{settings.beam_size}")
    if not 1 <= settings.port <= 65535:
        raise ConfigError(f"ASR_PORT 必须在 1-65535 之间，当前值：{settings.port}")
    if settings.log_level not in _LOG_LEVELS:
        raise ConfigError(f"ASR_LOG_LEVEL 非法：{settings.log_level!r}")
    if settings.log_format not in _LOG_FORMATS:
        raise ConfigError(f"ASR_LOG_FORMAT 必须是 text / json 之一，当前值：{settings.log_format!r}")
    if settings.max_file_mb < 1:
        raise ConfigError(f"ASR_MAX_FILE_MB 必须 ≥ 1，当前值：{settings.max_file_mb}")
    if not settings.supported_extensions:
        raise ConfigError("ASR_SUPPORTED_EXTENSIONS 不能为空")
    if settings.load_timeout_seconds < 5:
        raise ConfigError(f"ASR_LOAD_TIMEOUT_S 必须 ≥ 5，当前值：{settings.load_timeout_seconds}")
