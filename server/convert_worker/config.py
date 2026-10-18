"""运行时配置：全部来自环境变量（不硬编码任何密钥）。

与 server/ 保持一致——优先读取 server/.env（若存在），
未设 CONVERT_STORAGE_DIR 时默认与 server 相同的 server/data/convert。
"""
from __future__ import annotations

import os
from pathlib import Path

WORKER_DIR = Path(__file__).resolve().parent
SERVER_ROOT = WORKER_DIR.parent  # server/


def _try_load_dotenv() -> None:
    """若存在 server/.env，则加载（python-dotenv 缺失时静默跳过）。"""
    env_path = SERVER_ROOT / ".env"
    if not env_path.exists():
        return
    try:
        from dotenv import load_dotenv

        load_dotenv(env_path)
    except ImportError:
        # 没有 python-dotenv 也能跑，只要环境变量已导出
        pass


def _default_storage_dir() -> str:
    return str(SERVER_ROOT / "data" / "convert")


class Config:
    database_url: str | None
    storage_dir: str
    poll_interval: float
    max_file_bytes: int
    converter_timeout: int
    reclaim_every: int
    task_timeout: int
    log_level: str

    def __init__(self) -> None:
        self.database_url = os.environ.get("DATABASE_URL")
        self.storage_dir = os.environ.get("CONVERT_STORAGE_DIR") or _default_storage_dir()
        self.poll_interval = float(os.environ.get("CONVERT_POLL_INTERVAL", "3"))
        self.max_file_bytes = int(os.environ.get("CONVERT_MAX_FILE_BYTES", str(50 * 1024 * 1024)))
        self.converter_timeout = int(os.environ.get("CONVERT_TIMEOUT_SECONDS", "300"))
        self.reclaim_every = int(os.environ.get("CONVERT_RECLAIM_EVERY", "10"))
        self.task_timeout = int(os.environ.get("CONVERT_TASK_TIMEOUT", "300"))
        self.log_level = (os.environ.get("CONVERT_LOG_LEVEL") or "INFO").upper()


def load_config() -> Config:
    _try_load_dotenv()
    return Config()
