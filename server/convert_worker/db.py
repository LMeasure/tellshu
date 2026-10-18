"""数据库访问：复用 server/ 的 convert_tasks / convert_files 表。

不使用 Redis——按 格式转换.md 的「任务系统 + Worker」思想，但落地为
pg 轮询（与 server 已建表一致，零新依赖）。

为便于单测，ConvertDB 接受任意 DB-API 连接（生产用 psycopg2，测试用 sqlite3 内存库）；
SQL 用「Python 计算 cutoff + 参数化占位符」做到跨库可移植。
psycopg2 为懒加载：未安装时本模块仍可 import（sqlite 单测路径不依赖它）。
"""
from __future__ import annotations

import datetime as _dt
import json
import logging
import os
import sqlite3
import uuid
from dataclasses import dataclass
from typing import List, Optional, Tuple

logger = logging.getLogger("convert_worker")

# 结果文件 MIME 与扩展名映射（供下载与落盘命名）
TARGET_MIME = {
    "pdf": "application/pdf",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "png": "image/png",
    "jpg": "image/jpeg",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}
TARGET_EXT = {
    "pdf": "pdf",
    "docx": "docx",
    "png": "png",
    "jpg": "jpg",
    "xlsx": "xlsx",
}


@dataclass
class ClaimedTask:
    task_id: str
    file_id: str
    source_format: str
    target_format: str


class ConvertDB:
    def __init__(self, conn, storage_dir: str) -> None:
        # 接受注入的连接：生产用 psycopg2，单测用 sqlite3 内存库
        self._conn = conn
        self.storage_dir = storage_dir
        # 占位符与 now() 表达式随连接类型切换，SQL 才能跨库运行
        if isinstance(conn, sqlite3.Connection):
            self._ph = "?"
            self._now_expr = "CURRENT_TIMESTAMP"
        else:
            self._ph = "%s"
            self._now_expr = "now()"

    @classmethod
    def connect(cls, database_url: str, storage_dir: str) -> "ConvertDB":
        # 懒加载 psycopg2：让本模块在不装 psycopg2 的环境（如 sqlite 单测）也能被 import
        import psycopg2

        # autocommit=False：认领/写回各自成事务，失败不影响其余任务
        conn = psycopg2.connect(database_url, connect_timeout=10)
        conn.autocommit = False
        return cls(conn, storage_dir)

    def close(self) -> None:
        try:
            self._conn.close()
        except Exception:  # noqa: BLE001 - 关闭失败忽略
            pass

    def claim_task(self) -> Optional[ClaimedTask]:
        """原子认领一个 waiting 任务并置为 processing；无任务返回 None。

        用子查询 UPDATE...RETURNING 一次性完成「选最旧 + 置处理中」，
        避免多 Worker / 重试时的重复消费。
        """
        cur = self._conn.cursor()
        cur.execute(
            f"""
            UPDATE convert_tasks
            SET status = 'processing', progress = 10, updated_at = {self._now_expr}
            WHERE id = (
                SELECT id FROM convert_tasks
                WHERE status = 'waiting'
                ORDER BY created_at ASC
                LIMIT 1
            )
            RETURNING id, file_id, source_format, target_format
            """
        )
        row = cur.fetchone()
        if row is None:
            self._conn.rollback()
            return None
        self._conn.commit()
        return ClaimedTask(
            task_id=row[0], file_id=row[1], source_format=row[2], target_format=row[3]
        )

    def get_source_path(self, file_id: str) -> Optional[str]:
        cur = self._conn.cursor()
        cur.execute(f"SELECT storage_path FROM convert_files WHERE id = {self._ph}", (file_id,))
        row = cur.fetchone()
        return row[0] if row else None

    def commit_success(
        self,
        task_id: str,
        target_format: str,
        result_files: List[Tuple[str, str, int]],
    ) -> None:
        """在单事务内：登记所有结果文件 + 任务置 success。

        result_files: list[(file_id, storage_path, size_bytes)]，至少一个。
        任务 result_file_id 指向第一个结果（兼容单文件下载路由），
        result_files(jsonb) 记录全部结果 id（多页 PDF→PNG 等场景；见 005 迁移）。
        """
        if not result_files:
            raise ValueError("result_files 不能为空")
        cur = self._conn.cursor()
        for file_id, storage_path, size_bytes in result_files:
            original_name = os.path.basename(storage_path) or f"result.{TARGET_EXT.get(target_format, target_format)}"
            mime = TARGET_MIME.get(target_format, "application/octet-stream")
            cur.execute(
                f"""
                INSERT INTO convert_files (id, original_name, format, mime_type, size_bytes, storage_path)
                VALUES ({self._ph}, {self._ph}, {self._ph}, {self._ph}, {self._ph}, {self._ph})
                """,
                (file_id, original_name, target_format, mime, size_bytes, storage_path),
            )
        first_id = result_files[0][0]
        all_ids = json.dumps([r[0] for r in result_files])
        # jsonb  cast 仅在 psycopg2 路径使用（sqlite 测试不触发此分支）
        jsonb_clause = f"{self._ph}::jsonb" if self._ph == "%s" else self._ph
        cur.execute(
            f"""
            UPDATE convert_tasks
            SET status = 'success', progress = 100, result_file_id = {self._ph},
                result_files = {jsonb_clause}, finished_at = {self._now_expr}, updated_at = {self._now_expr}
            WHERE id = {self._ph}
            """,
            (first_id, all_ids, task_id),
        )
        self._conn.commit()

    def mark_failed(self, task_id: str, error_message: str) -> None:
        """任务失败：写回真实错误原因（截断到 2000 字，字段为 text 仍留余量）。"""
        msg = error_message[:2000]
        cur = self._conn.cursor()
        cur.execute(
            f"""
            UPDATE convert_tasks
            SET status = 'failed', error_message = {self._ph}, finished_at = {self._now_expr}, updated_at = {self._now_expr}
            WHERE id = {self._ph}
            """,
            (msg, task_id),
        )
        self._conn.commit()

    def reclaim_stale_tasks(self, timeout_seconds: int) -> int:
        """将 status='processing' 且 updated_at 早于 (now - timeout) 的任务重置为 'waiting'。

        返回受影响行数。用于修复 Worker 崩溃 / 长时卡死导致的任务滞留
        （注意：本项目 schema 用 'waiting' 而非 spec 里的 'pending'，受 CHECK 约束限制）。
        用 Python 计算 cutoff 再参数化比较，SQL 跨库可移植（sqlite 单测即用此路径）。
        """
        cutoff = _dt.datetime.now() - _dt.timedelta(seconds=timeout_seconds)
        # sqlite 用 ISO 字符串比较（lexicographic == chronological），pg 直接用 datetime 对象
        cutoff_param: object = cutoff.isoformat(sep=" ") if self._ph == "?" else cutoff
        sql = (
            f"UPDATE convert_tasks "
            f"SET status = 'waiting', updated_at = {self._now_expr} "
            f"WHERE status = 'processing' AND updated_at < {self._ph}"
        )
        cur = self._conn.cursor()
        cur.execute(sql, (cutoff_param,))
        count = cur.rowcount
        self._conn.commit()
        return count
