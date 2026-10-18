#!/usr/bin/env python3
"""格式转换 Worker 入口：轮询 convert_tasks，调 Converter 插件，写回结果。

运行（先确保 server/sql/004_convert.sql 已建表、server/.env 含 DATABASE_URL）：
    cd server
    python -m convert_worker.worker            # 持续轮询
    python -m convert_worker.worker --once     # 处理一轮即退出（便于测试）
    python -m convert_worker.worker --poll-interval 5

流程（对应 格式转换.md §7）：
    认领(UPDATE...RETURNING) -> 锁任务 -> 调 Converter -> 落结果文件 -> 写回状态
    任何异常都写回 error_message 并置 FAILED，任务不丢失；
    失败残留的半成品结果文件会被清理；转换完成后的输入源文件也会被删除（不长期留存用户文件）。
"""
from __future__ import annotations

import argparse
import logging
import os
import signal
import sys
import time
import uuid
from pathlib import Path

from .config import load_config
from .converters.base import ConvertError, ConverterNotImplemented
from .converters.registry import get_converter
from .db import ConvertDB

logger = logging.getLogger("convert_worker")

_shutdown = False


def _handle_signal(signum: int, _frame: object) -> None:
    global _shutdown
    _shutdown = True
    logger.info("收到信号 %s，将在当前任务结束后退出", signum)


def _cleanup_outputs(result_files: list[tuple[str, str, int]]) -> None:
    """删除失败时残留的半成品结果文件。"""
    for _file_id, path, _size in result_files:
        try:
            if os.path.exists(path):
                os.remove(path)
        except OSError:
            pass


def _cleanup_source(source_path: str | None) -> None:
    """转换完成后（无论成败）删除输入源文件，不长期留存用户文件。"""
    if not source_path:
        return
    try:
        if os.path.exists(source_path):
            os.remove(source_path)
    except OSError:
        logger.warning("删除输入源文件失败（可忽略）：%s", source_path)


def process_one(db: ConvertDB) -> bool:
    """处理一个任务；无任务可处理返回 False。"""
    task = db.claim_task()
    if task is None:
        return False

    logger.info("认领任务 %s：%s -> %s", task.task_id, task.source_format, task.target_format)
    source_path: str | None = None
    result_files: list[tuple[str, str, int]] = []
    try:
        source_path = db.get_source_path(task.file_id)
        if source_path is None or not os.path.exists(source_path):
            raise ConvertError(f"源文件缺失或已被清理：{task.file_id}")

        # 取转换器（不支持的方向这里就抛 ConverterNotImplemented，不写任何文件）
        converter = get_converter(task.source_format, task.target_format)

        # 每个任务独立的输出子目录，避免多任务 page_001.png 命名互相覆盖
        task_out_dir = os.path.join(db.storage_dir, task.task_id)
        os.makedirs(task_out_dir, exist_ok=True)

        # 引擎只做文件→文件转换，不碰数据库；可能产出多个文件（如每页一张 PNG）
        outputs = converter.convert(Path(source_path), Path(task_out_dir))
        if not outputs:
            raise ConvertError("转换器未产出结果文件")

        for out_path in outputs:
            if not os.path.exists(out_path):
                raise ConvertError(f"转换器声明的输出文件不存在：{out_path}")
            file_id = str(uuid.uuid4())
            size = os.path.getsize(out_path)
            result_files.append((file_id, out_path, size))

        db.commit_success(task.task_id, task.target_format, result_files)
        total_bytes = sum(s for _f, _p, s in result_files)
        logger.info("任务完成 %s -> %d 个结果文件 (%d bytes)", task.task_id, len(result_files), total_bytes)
        return True

    except ConvertError as exc:
        msg = f"[{type(exc).__name__}] {exc}"
        logger.warning("任务失败 %s：%s", task.task_id, msg)
        _cleanup_outputs(result_files)
        db.mark_failed(task.task_id, msg)
        return True
    except Exception as exc:  # noqa: BLE001 - 兜底，确保任务不卡死在 processing
        msg = f"[unexpected] {exc}"
        logger.exception("任务异常 %s", task.task_id)
        _cleanup_outputs(result_files)
        db.mark_failed(task.task_id, msg)
        return True
    finally:
        # 无论成败都删除输入源文件（spec §9：不长期留存用户文件）
        _cleanup_source(source_path)


def main() -> int:
    parser = argparse.ArgumentParser(description="格式转换 Worker（复用 server 的 pg 任务表）")
    parser.add_argument("--once", action="store_true", help="只处理一轮（认领并处理直到无任务）即退出")
    parser.add_argument("--poll-interval", type=float, default=None, help="轮询间隔秒，覆盖环境变量")
    args = parser.parse_args()

    config = load_config()
    if args.poll_interval is not None:
        config.poll_interval = args.poll_interval

    logging.basicConfig(
        level=getattr(logging, config.log_level, logging.INFO),
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    if not config.database_url:
        logger.error("缺少 DATABASE_URL（请在 server/.env 配置或导出环境变量）")
        return 2

    os.makedirs(config.storage_dir, exist_ok=True)

    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)

    try:
        db = ConvertDB.connect(config.database_url, config.storage_dir)
    except Exception as exc:  # noqa: BLE001
        logger.error("无法连接数据库：%s", exc)
        return 1

    logger.info("Worker 启动：storage=%s poll=%.1fs reclaim_every=%d timeout=%ds",
                config.storage_dir, config.poll_interval, config.reclaim_every, config.task_timeout)
    processed = 0
    reclaim_counter = 0
    try:
        while not _shutdown:
            if process_one(db):
                processed += 1
                continue
            if args.once:
                break
            # 无任务：拆成 0.1s 小步休眠，保证信号能及时打断；
            # 每 reclaim_every 轮回收一次卡在 processing 的超时任务
            reclaim_counter += 1
            if reclaim_counter >= config.reclaim_every:
                reclaim_counter = 0
                try:
                    n = db.reclaim_stale_tasks(config.task_timeout)
                    if n:
                        logger.info("[reclaim] reset %d stale tasks", n)
                except Exception:  # noqa: BLE001
                    logger.exception("[reclaim] 回收失败（跳过本轮）")
            for _ in range(int(config.poll_interval * 10)):
                if _shutdown:
                    break
                time.sleep(0.1)
    finally:
        db.close()
    logger.info("Worker 退出：本次处理 %d 个任务", processed)
    return 0


if __name__ == "__main__":
    sys.exit(main())
