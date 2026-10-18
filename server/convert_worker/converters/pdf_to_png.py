"""PDF → PNG 转换引擎（PyMuPDF / `import fitz`）。

落地 格式转换.md §2 / §8：纯 Python 库，无外部进程调用（绝不 subprocess / os.system）。
把 PDF 每一页渲染成一张 PNG，命名 page_001.png / page_002.png …，返回所有输出路径。

安全约定（spec §9）：
    - 只通过库 API 读取文件，不执行任何外部命令；
    - dpi 超出 [72, 600] 自动 clamp，max_pages 防止超大 PDF 爆内存；
    - 引擎本身不碰数据库，只做文件→文件转换。
"""
from __future__ import annotations

from pathlib import Path
from typing import List

from .base import ConvertError, Converter

DPI_MIN = 72
DPI_MAX = 600
DEFAULT_DPI = 150


class PdfToPngConverter(Converter):
    source_format = "pdf"
    target_format = "png"

    def _clamp_dpi(self, dpi: int) -> int:
        if dpi < DPI_MIN:
            return DPI_MIN
        if dpi > DPI_MAX:
            return DPI_MAX
        return dpi

    def convert(self, input_path: Path, output_dir: Path, **opts: object) -> List[str]:
        # 懒加载 PyMuPDF：让本模块在不装 fitz 的环境（如仅跑其它方向/单测）也能被 import；
        # 真正执行时才检查依赖，缺失则给出明确错误而非栈溢出。
        try:
            import fitz  # PyMuPDF
        except ImportError as exc:  # pragma: no cover - 依赖缺失时的明确报错路径
            raise ConvertError(
                "PyMuPDF(fitz) 未安装，无法执行 PDF→PNG 转换；请在 worker 环境 pip install PyMuPDF"
            ) from exc

        # 可选参数：dpi（默认 150，范围 clamp 到 [72,600]）、max_pages（默认无限制）
        try:
            dpi = self._clamp_dpi(int(opts.get("dpi", DEFAULT_DPI)))  # type: ignore[arg-type]
        except (TypeError, ValueError):
            dpi = DEFAULT_DPI

        max_pages = opts.get("max_pages", None)
        if max_pages is not None:
            try:
                max_pages = int(max_pages)  # type: ignore[arg-type]
            except (TypeError, ValueError):
                max_pages = None
            if max_pages is not None and max_pages < 1:
                raise ConvertError(f"max_pages 必须为正整数：{max_pages}")

        out_dir = Path(output_dir)
        out_dir.mkdir(parents=True, exist_ok=True)

        doc = fitz.open(str(input_path))
        try:
            total = doc.page_count
            if max_pages is not None:
                total = min(total, max_pages)
            if total < 1:
                raise ConvertError("PDF 没有可渲染的页面")

            zoom = dpi / 72.0
            matrix = fitz.Matrix(zoom, zoom)
            out_paths: List[str] = []
            for i in range(total):
                page = doc.load_page(i)
                pix = page.get_pixmap(matrix=matrix)
                out = out_dir / f"page_{i + 1:03d}.png"
                pix.save(str(out))
                out_paths.append(str(out))
            return out_paths
        finally:
            doc.close()
