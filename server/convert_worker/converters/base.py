"""统一的 Converter 接口（对应 格式转换.md §4.1）。

每个具体转换是一个插件，只需实现：
    - source_format / target_format 类属性
    - convert(input_path, output_dir, **opts) -> list[str]

约定：把 input_path 转换后写入 output_dir，返回所有输出文件的路径列表。
一个方向可能产出多个文件（如 PDF→PNG 每页一张）。引擎本身不碰数据库，
只做「文件 → 文件」的转换。任何失败都应抛 ConvertError，不要产出半成品文件
（Worker 会做兜底清理，且绝不伪造结果——项目红线）。
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from pathlib import Path
from typing import ClassVar, List


class ConvertError(Exception):
    """转换真实失败（写进任务的 error_message）。"""


class ConverterNotImplemented(ConvertError):
    """该方向引擎未实现：如实报错，绝不伪造输出文件。"""


class Converter(ABC):
    source_format: ClassVar[str]
    target_format: ClassVar[str]

    @abstractmethod
    def convert(self, input_path: Path, output_dir: Path, **opts: object) -> List[str]:
        """把 input_path 转换后写入 output_dir，返回所有输出文件路径列表。

        Args:
            input_path: 源文件（含 uuid 命名，绝不含客户端原始名）
            output_dir: 输出目录（Worker 已按任务建好、唯一）
            **opts: 可选参数（如 dpi / max_pages），由各引擎自行解释
        返回：输出文件的绝对路径列表（至少一个）
        """
        raise NotImplementedError

    def __repr__(self) -> str:
        return f"<{type(self).__name__} {self.source_format}->{self.target_format}>"
