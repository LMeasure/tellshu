"""Converter 注册表：方向 (source, target) -> 插件类。

新增格式只需在 implementations.py 加一个 Converter 子类，并在本表登记，
核心 Worker 流程零改动（满足 格式转换.md §4.1「新增格式不修改核心流程」）。
"""
from __future__ import annotations

from typing import Dict, Tuple, Type

from .base import Converter, ConverterNotImplemented
# PDF→PNG 已接入真实引擎（PyMuPDF），直接引用实现文件，避免经 implementations 中转
from .pdf_to_png import PdfToPngConverter
from .implementations import (
    DocxToPdfConverter,
    JpgToPdfConverter,
    PdfToDocxConverter,
    PngToPdfConverter,
    XlsxToPdfConverter,
)

_REGISTRY: Dict[Tuple[str, str], Type[Converter]] = {
    ("pdf", "docx"): PdfToDocxConverter,
    ("docx", "pdf"): DocxToPdfConverter,
    ("pdf", "png"): PdfToPngConverter,
    ("png", "pdf"): PngToPdfConverter,
    ("jpg", "pdf"): JpgToPdfConverter,
    ("xlsx", "pdf"): XlsxToPdfConverter,
}


def get_converter(source: str, target: str) -> Converter:
    cls = _REGISTRY.get((source, target))
    if cls is None:
        raise ConverterNotImplemented(f"不支持的转换方向：{source} → {target}")
    return cls()


def supported_pairs() -> list[Tuple[str, str]]:
    return list(_REGISTRY.keys())
