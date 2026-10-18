"""六个 V1 转换方向的插件。

PDF→PNG 已由 `pdf_to_png.py` 用 PyMuPDF 实现（见 `PdfToPngConverter`）。
其余五个方向引擎尚未实现：convert 诚实抛 `ConverterNotImplemented`，
并附上 格式转换.md §8 推荐的落地工具，供后续实现参考——禁止伪造任何输出文件。
"""
from __future__ import annotations

from pathlib import Path
from typing import List

from .base import Converter, ConverterNotImplemented
from .pdf_to_png import PdfToPngConverter  # PDF→PNG 已接入真实引擎


class PdfToDocxConverter(Converter):
    source_format = "pdf"
    target_format = "docx"

    def convert(self, input_path: Path, output_dir: Path, **opts: object) -> List[str]:
        raise ConverterNotImplemented(
            "PDF→DOCX 引擎未实现。推荐：pdfplumber/PyMuPDF 抽取文本与版式，或 LibreOffice headless 转换。"
        )


class DocxToPdfConverter(Converter):
    source_format = "docx"
    target_format = "pdf"

    def convert(self, input_path: Path, output_dir: Path, **opts: object) -> List[str]:
        raise ConverterNotImplemented(
            "DOCX→PDF 引擎未实现。推荐：LibreOffice headless --convert-to pdf。"
        )


class PngToPdfConverter(Converter):
    source_format = "png"
    target_format = "pdf"

    def convert(self, input_path: Path, output_dir: Path, **opts: object) -> List[str]:
        raise ConverterNotImplemented(
            "PNG→PDF 引擎未实现。推荐：PyMuPDF/PIL 将图片写入 PDF 页。"
        )


class JpgToPdfConverter(Converter):
    source_format = "jpg"
    target_format = "pdf"

    def convert(self, input_path: Path, output_dir: Path, **opts: object) -> List[str]:
        raise ConverterNotImplemented(
            "JPG→PDF 引擎未实现。推荐：PyMuPDF/PIL 将图片写入 PDF 页。"
        )


class XlsxToPdfConverter(Converter):
    source_format = "xlsx"
    target_format = "pdf"

    def convert(self, input_path: Path, output_dir: Path, **opts: object) -> List[str]:
        raise ConverterNotImplemented(
            "XLSX→PDF 引擎未实现。"
            "推荐：LibreOffice headless --convert-to pdf，或 openpyxl + ReportLab 自绘。"
        )
