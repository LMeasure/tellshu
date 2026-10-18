"""转写器：编排「加载模型 → 识别音频 → 输出结果」，并提供本地命令行入口。

迁移自 shutree/语音识别/backend/app/asr/transcriber.py（v0.5.0）。

用法（在 server/asr_service/ 目录下）：
    python -m asr_core.transcriber /path/to/audio.mp4
    python -m asr_core.transcriber /path/to/audio.mp3 --language zh

输出（stdout，JSON，canonical 形态）：
    {"language": "zh", "duration": 12.3,
     "segments": [{"start": 0, "end": 3, "text": "xxx"}]}
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path

from asr_core.config import load_settings
from asr_core.logconf import configure_logging
from asr_core.model import ASRModel, TranscriptionResult

logger = logging.getLogger("asr.transcriber")


class Transcriber:
    """ASR 转写器：业务侧只面对这一个类。"""

    def __init__(self, settings=None) -> None:
        self._settings = settings or load_settings()
        self._model = ASRModel(self._settings)

    @property
    def ready(self) -> bool:
        return self._model.ready

    @property
    def model_ref(self) -> str | None:
        return self._model.model_ref

    @property
    def device(self) -> str | None:
        return self._model.device

    @property
    def compute_type(self) -> str | None:
        return self._model.compute_type

    def warmup(self) -> None:
        """加载模型（幂等）。供 sidecar 启动时调用：模型全局只初始化一次。"""
        self._model.load()

    def transcribe_file(self, audio_path: str | Path, language: str | None = None) -> TranscriptionResult:
        audio = Path(audio_path)
        if not audio.is_file():
            raise FileNotFoundError(f"音频文件不存在：{audio}")
        self._model.load()
        return self._model.transcribe(audio, language=language or self._settings.language)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m asr_core.transcriber",
        description="本地语音识别：音频/视频文件 → canonical JSON（faster-whisper）",
    )
    parser.add_argument("audio", help="音视频文件路径，如 data/asr/in/<jobId>/clip.mp4")
    parser.add_argument(
        "--language",
        default=None,
        help="识别语言：auto（默认，自动检测）/ zh / en；不传则用 ASR_LANGUAGE 配置",
    )
    parser.add_argument("--verbose", action="store_true", help="输出调试日志到 stderr")
    args = parser.parse_args(argv)

    configure_logging(
        level="DEBUG" if args.verbose else "INFO",
        fmt="text",
        stream=sys.stderr,
    )

    try:
        transcriber = Transcriber()
        result = transcriber.transcribe_file(args.audio, language=args.language)
    except FileNotFoundError as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2
    except Exception as exc:  # noqa: BLE001 - CLI 边界统一收敛为可读错误
        logger.exception("识别失败")
        print(json.dumps({"error": f"{type(exc).__name__}: {exc}"}, ensure_ascii=False), file=sys.stderr)
        return 1

    print(json.dumps(result.to_canonical(), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
