"""超时回滚单测（无需真实 pg，用内存 SQLite）。

覆盖 格式转换.md §7 / worker 的 reclaim_stale_tasks：
    测试 1：processing 未超时（updated_at 在 timeout 窗口内）→ 不回收
    测试 2：processing 已超时（updated_at 早于 now-timeout） → 重置为 waiting
    测试 3：completed / failed（以及 waiting 自身）→ 不受影响
"""
from __future__ import annotations

import datetime as _dt
import sqlite3
import unittest

from db import ConvertDB


def _make_db() -> ConvertDB:
    conn = sqlite3.connect(":memory:")
    # 仅建 reclaim 所需的最小表结构；列名与 004_convert.sql 对齐
    conn.execute(
        "CREATE TABLE convert_tasks ("
        " id text PRIMARY KEY,"
        " status text NOT NULL,"
        " updated_at text NOT NULL"
        ")"
    )
    return ConvertDB(conn, "/tmp/convert_storage_test_only")


def _iso(offset_seconds: float) -> str:
    # 与 db.py 里 cutoff.isoformat(sep=' ') 同格式，保证 SQLite 文本比较 == 时间序
    return (_dt.datetime.now() + _dt.timedelta(seconds=offset_seconds)).isoformat(sep=" ")


class ReclaimStaleTasksTest(unittest.TestCase):
    def test_processing_not_expired_not_reclaimed(self) -> None:
        db = _make_db()
        db._conn.execute(
            "INSERT INTO convert_tasks (id, status, updated_at) VALUES (?,?,?)",
            ("t1", "processing", _iso(-10)),  # 10 秒前，远未超 300s
        )
        db._conn.commit()
        n = db.reclaim_stale_tasks(300)
        self.assertEqual(n, 0)
        status = db._conn.execute("SELECT status FROM convert_tasks WHERE id='t1'").fetchone()[0]
        self.assertEqual(status, "processing")

    def test_processing_expired_reclaimed_to_waiting(self) -> None:
        db = _make_db()
        db._conn.execute(
            "INSERT INTO convert_tasks (id, status, updated_at) VALUES (?,?,?)",
            ("t1", "processing", _iso(-1000)),  # 1000 秒前，超过 300s
        )
        db._conn.commit()
        n = db.reclaim_stale_tasks(300)
        self.assertEqual(n, 1)
        status = db._conn.execute("SELECT status FROM convert_tasks WHERE id='t1'").fetchone()[0]
        # 注意：本项目 schema 用 'waiting'（受 CHECK 约束），不是 spec 字面的 'pending'
        self.assertEqual(status, "waiting")

    def test_completed_and_failed_untouched(self) -> None:
        db = _make_db()
        for rid, st in [("done", "success"), ("fail", "failed"), ("wait", "waiting")]:
            db._conn.execute(
                "INSERT INTO convert_tasks (id, status, updated_at) VALUES (?,?,?)",
                (rid, st, _iso(-1000)),  # 全部早已超时，但只有 processing 会被回收
            )
        db._conn.commit()
        n = db.reclaim_stale_tasks(300)
        self.assertEqual(n, 0)  # 没有 processing 行，回收数为 0
        rows = {r[0]: r[1] for r in db._conn.execute("SELECT id, status FROM convert_tasks").fetchall()}
        self.assertEqual(rows["done"], "success")
        self.assertEqual(rows["fail"], "failed")
        self.assertEqual(rows["wait"], "waiting")


if __name__ == "__main__":
    unittest.main()
