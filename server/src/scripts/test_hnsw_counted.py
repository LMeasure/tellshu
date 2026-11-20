"""
test_hnsw_counted.py —— 命中率分母判据 `assign_counted` 的单元测试

背景：Stage B 首轮实验把 front matter 探针（F1/F2）错误地计入了命中率分母，
导致 aggregate.denominator 记成 15（正确应为 13）。修完后把判据收敛成唯一来源
`hnsw_experiment.assign_counted(category)`，用本测试锁住行为。

规则（方案 §4.0）：
    probe   -> False  （探针验的是「行为」不是「召回」，永不进分母）
    control -> False  （负对照，永不进分母）
    其余     -> True   （fixed / new / new-blocked 等定向 Query）

运行：
    cd server
    python src/scripts/test_hnsw_counted.py
    # 或
    python -m unittest src.scripts.test_hnsw_counted -v

只依赖标准库 + psycopg2（hnsw-experiment.py 的顶层导入）。
本测试不连接数据库、不加载 embedding 模型、不读写任何表。
"""

from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent


def _load_experiment_module():
    """按文件路径导入 hnsw-experiment.py（文件名含连字符，不能直接用 import）。"""
    path = HERE / "hnsw-experiment.py"
    if not path.exists():
        raise unittest.SkipTest(f"找不到被测脚本：{path}")
    spec = importlib.util.spec_from_file_location("hnsw_experiment", path)
    if spec is None or spec.loader is None:
        raise unittest.SkipTest(f"无法构造模块 spec：{path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules["hnsw_experiment"] = module
    try:
        spec.loader.exec_module(module)
    except ImportError as exc:      # 例如当前解释器没装 psycopg2
        raise unittest.SkipTest(f"导入被测脚本失败（缺少依赖）：{exc}") from exc
    return module


mod = _load_experiment_module()
assign_counted = mod.assign_counted


class TestAssignCounted(unittest.TestCase):
    """探针必须 False，普通 Query 必须 True。"""

    def test_probe_query_not_counted(self):
        """输入 probe query -> 期望 counted=False"""
        self.assertFalse(assign_counted("probe"))

    def test_control_not_counted(self):
        """负对照同样不进分母"""
        self.assertFalse(assign_counted("control"))

    def test_fixed_query_counted(self):
        """普通 query（Stage 1 固定 6 条）-> 期望 counted=True"""
        self.assertTrue(assign_counted("fixed"))

    def test_new_query_counted(self):
        """新增定向 query -> True"""
        self.assertTrue(assign_counted("new"))

    def test_new_blocked_counted_by_category(self):
        """new-blocked 按类别仍为 True；「过滤开启时不计入」是口径层面的另行置位，
        由调用方处理（见 hnsw-experiment.py 中 category == 'new-blocked' 的置 False），
        不属于本判据的职责。"""
        self.assertTrue(assign_counted("new-blocked"))

    def test_unknown_category_defaults_counted(self):
        """未知类别默认计入（load_queries 会把空类别兜底成 'new'），不得静默丢弃。"""
        self.assertTrue(assign_counted("new"))
        self.assertTrue(assign_counted("something-unknown"))

    def test_case_sensitive(self):
        """类别名大小写敏感，'Probe' 不被当作探针 —— 这提醒查询集文件必须用小写类别。"""
        self.assertTrue(assign_counted("Probe"))
        self.assertTrue(assign_counted("PROBE"))


class TestDenominatorWithQuerySet(unittest.TestCase):
    """用真实查询集文件验一遍分母算出来是 13（过滤开启口径）。"""

    def test_filtered_denominator_is_13(self):
        qf = HERE / "discover-queries-stage2.txt"
        if not qf.exists():
            self.skipTest("查询集文件不存在")

        categories: list[str] = []
        for line in qf.read_text(encoding="utf-8").splitlines():
            s = line.strip()
            if not s or s.startswith("#"):
                continue
            parts = [p.strip() for p in s.split("\t")]
            while len(parts) < 3:
                parts.append("")
            categories.append(parts[2] or "new")

        # 过滤开启：定向 Query 中再排除 new-blocked（N3 锚点全在无章节块）
        counted = sum(
            1
            for c in categories
            if assign_counted(c) and c != "new-blocked"
        )
        self.assertEqual(counted, 13, f"过滤开启口径分母应为 13，实得 {counted}")

    def test_unfiltered_denominator_is_14(self):
        qf = HERE / "discover-queries-stage2.txt"
        if not qf.exists():
            self.skipTest("查询集文件不存在")
        categories = []
        for line in qf.read_text(encoding="utf-8").splitlines():
            s = line.strip()
            if not s or s.startswith("#"):
                continue
            parts = [p.strip() for p in s.split("\t")]
            while len(parts) < 3:
                parts.append("")
            categories.append(parts[2] or "new")
        counted = sum(1 for c in categories if assign_counted(c))
        self.assertEqual(counted, 14, f"过滤关闭口径分母应为 14，实得 {counted}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
