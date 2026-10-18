"""Converter 注册表单测（无需数据库，可在 CI 直接跑）。

覆盖：
    - V1 六个方向均已登记且 source/target 正确
    - 不支持的方向抛 ConverterNotImplemented
    - 骨架阶段每个 convert 都诚实抛 ConverterNotImplemented（不伪造输出）
"""
from __future__ import annotations

import unittest
from pathlib import Path

from converters.base import ConverterNotImplemented
from converters.pdf_to_png import PdfToPngConverter
from converters.registry import get_converter, supported_pairs


class RegistryTest(unittest.TestCase):
    ALLOWED = [
        ("pdf", "docx"),
        ("docx", "pdf"),
        ("pdf", "png"),
        ("png", "pdf"),
        ("jpg", "pdf"),
        ("xlsx", "pdf"),
    ]

    def test_all_allowed_registered(self) -> None:
        self.assertEqual(len(supported_pairs()), len(self.ALLOWED))
        for src, tgt in self.ALLOWED:
            conv = get_converter(src, tgt)
            self.assertEqual(conv.source_format, src)
            self.assertEqual(conv.target_format, tgt)

    def test_unknown_pair_raises(self) -> None:
        with self.assertRaises(ConverterNotImplemented):
            get_converter("png", "docx")

    def test_unimplemented_pairs_raise(self) -> None:
        # 其余五个方向引擎未实现：convert 必须诚实抛 ConverterNotImplemented，绝不伪造输出
        for src, tgt in self.ALLOWED:
            if (src, tgt) == ("pdf", "png"):
                continue  # 该方向已接入真实引擎，单独验证
            conv = get_converter(src, tgt)
            with self.assertRaises(ConverterNotImplemented):
                conv.convert(Path("/tmp/in"), Path("/tmp/out"))

    def test_pdf_png_is_real_engine(self) -> None:
        # PDF→PNG 已接入 PyMuPDF 真实引擎：不应是 NotImplemented 占位
        conv = get_converter("pdf", "png")
        self.assertIsInstance(conv, PdfToPngConverter)
        self.assertEqual(conv.source_format, "pdf")
        self.assertEqual(conv.target_format, "png")
        # 对不存在的文件调用应报错，但必须不是「未实现」——证明走的是真实引擎
        with self.assertRaises(Exception) as ctx:
            conv.convert(Path("/tmp/does_not_exist_xyz.pdf"), Path("/tmp/out"))
        self.assertNotIsInstance(ctx.exception, ConverterNotImplemented)


if __name__ == "__main__":
    unittest.main()
