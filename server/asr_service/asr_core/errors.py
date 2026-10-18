"""类型化错误：code / http_status / message 三元组，全局异常处理器只回规范化结构。

迁移自 shutree/语音识别/backend/app/core/errors.py，裁剪掉任务系统 / AI 相关类型，
新增 SidecarBusyError（推理串行队列饱和，保护内存约束）。
"""
from __future__ import annotations


class AppError(Exception):
    """业务错误基类。"""

    code = "INTERNAL_ERROR"
    http_status = 500

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message

    def to_payload(self) -> dict:
        return {"success": False, "code": self.code, "message": self.message}


class EmptyFileError(AppError):
    """输入文件内容为空。"""

    code = "EMPTY_FILE"
    http_status = 400


class InvalidLanguageError(AppError):
    """language 参数非法。"""

    code = "INVALID_LANGUAGE"
    http_status = 400


class UnsupportedMediaTypeError(AppError):
    """文件扩展名不受支持。"""

    code = "UNSUPPORTED_MEDIA_TYPE"
    http_status = 415


class PayloadTooLargeError(AppError):
    """文件超过大小上限。"""

    code = "FILE_TOO_LARGE"
    http_status = 413


class AudioDecodeError(AppError):
    """音频/视频无法解码（损坏或伪装扩展名）。"""

    code = "AUDIO_DECODE_ERROR"
    http_status = 400


class TranscriptionError(AppError):
    """识别过程失败（模型未加载 / 推理异常）。"""

    code = "TRANSCRIPTION_ERROR"
    http_status = 500


class JobNotFoundError(AppError):
    """job_id 不存在。"""

    code = "JOB_NOT_FOUND"
    http_status = 404


class InputFileGoneError(AppError):
    """输入文件已被删除或不存在。"""

    code = "INPUT_FILE_GONE"
    http_status = 410


class SidecarBusyError(AppError):
    """串行队列已满（内存约束下的背压，不排队假任务）。"""

    code = "SIDECAR_BUSY"
    http_status = 503
