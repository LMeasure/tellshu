# -*- coding: utf-8 -*-
"""生成 PaddleOCR 全链路 E2E 用的四张词典扫描测试图。

输出到 server/data/e2e/（已被 server/.gitignore 忽略）：
  instruction.png  书籍使用说明页（词性缩写 / 符号说明 / 标注约定）
  toc.png          目录页（缩进层级 + 引导点 + 页码）
  entry.png        单词正文页（词头/音标/词性/英中释义/例句/同反义/短语/词根）
  table.png        不规则动词表（真实表格线）

用法：python scripts/make_e2e_images.py [输出目录]
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

W, H = 1240, 1754  # A4 @150dpi
MARGIN_X = 90
LINE_GAP = 22  # 行间额外间距

FONT_PATH = r"C:\Windows\Fonts\msyh.ttc"
FONT_IPA = r"C:\Windows\Fonts\arial.ttf"  # msyh 缺 ə ˈ ɪ ɔ ː 等 IPA 字形，音标段换 Arial

PHON_RE = re.compile(r"\[[^\]]*\]")


def font(size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(FONT_PATH, size)


def new_page() -> tuple[Image.Image, ImageDraw.ImageDraw]:
    img = Image.new("RGB", (W, H), "white")
    return img, ImageDraw.Draw(img)


def draw_lines(
    draw: ImageDraw.ImageDraw,
    lines: list[str],
    body_size: int = 40,
    title: str | None = None,
    title_size: int = 56,
) -> None:
    y = 80
    if title:
        f = font(title_size)
        draw.text((MARGIN_X, y), title, fill="black", font=f)
        y += title_size + 40
    f = font(body_size)
    step = body_size + LINE_GAP
    for line in lines:
        draw.text((MARGIN_X, y), line, fill="black", font=f)
        y += step


def dots(n: int) -> str:
    return "·" * n


def make_instruction(out: Path) -> None:
    lines = [
        "词性缩写",
        "n. = 名词",
        "v. = 动词",
        "vt. = 及物动词",
        "vi. = 不及物动词",
        "adj. = 形容词",
        "adv. = 副词",
        "",
        "符号说明",
        "★ 表示考纲词汇",
        "☆ 表示超纲词汇",
        "",
        "标注约定",
        "例：引出例句",
        "同义词：引出同义词",
        "反义词：引出反义词",
        "短语：引出常用短语",
        "词根：引出词根词缀",
    ]
    img, draw = new_page()
    draw_lines(draw, lines, title="使用说明")
    img.save(out)


def make_toc(out: Path) -> None:
    lines = [
        f"第一章 名词 {dots(28)} 1",
        f"    1.1 名词的分类 {dots(22)} 2",
        f"        专有名词 {dots(24)} 3",
        f"        普通名词 {dots(24)} 4",
        f"    1.2 名词的数 {dots(24)} 5",
        f"第二章 动词 {dots(28)} 12",
        f"    2.1 动词的分类 {dots(22)} 13",
        f"        及物动词 {dots(24)} 14",
        f"        不及物动词 {dots(23)} 15",
        f"    2.2 动词的时态 {dots(22)} 20",
        f"附录 不规则动词表 {dots(24)} 88",
    ]
    img, draw = new_page()
    draw_lines(draw, lines, title="目 录")
    img.save(out)


def make_entry(out: Path) -> None:
    lines = [
        "abandon ★★ [əˈbændən] v. to leave sb 放弃；抛弃",
        "例：He abandoned his car in the snow. 他把车丢在雪地里。",
        "同义词：desert, forsake",
        "反义词：keep, retain",
        "短语：abandon oneself to 沉溺于",
        "词根：a-(去) + bandon(控制)",
        "",
        "ability ★ [əˈbɪləti] n. the fact that sb can do sth 能力；才能",
        "例：She has the ability to learn fast. 她有快速学习的能力。",
        "",
        "abroad ★★ [əˈbrɔːd] adv. in or to a foreign country 在国外；到国外",
        "例：He has never been abroad. 他从未出过国。",
    ]
    img, draw = new_page()
    draw_lines(draw, lines, title="单词正文（样页）")
    img.save(out)


def make_table(out: Path) -> None:
    img, draw = new_page()
    f_title = font(56)
    f_head = font(40)
    f_cell = font(38)
    draw.text((MARGIN_X, 80), "附录 不规则动词表", fill="black", font=f_title)

    rows = [
        ("动词原形", "过去式", "过去分词"),
        ("go", "went", "gone"),
        ("be", "was/were", "been"),
        ("do", "did", "done"),
        ("give", "gave", "given"),
        ("take", "took", "taken"),
    ]
    x0, y0 = MARGIN_X, 220
    col_w = [380, 380, 320]
    row_h = 84
    # 表格外框与内线（PP-StructureV3 依赖真实表格线输出 markdown 表格）
    total_w = sum(col_w)
    total_h = row_h * len(rows)
    for r in range(len(rows) + 1):
        yy = y0 + r * row_h
        draw.line([(x0, yy), (x0 + total_w, yy)], fill="black", width=3)
    x = x0
    for c in range(len(col_w) + 1):
        draw.line([(x, y0), (x, y0 + total_h)], fill="black", width=3)
        if c < len(col_w):
            x += col_w[c]
    for r, row in enumerate(rows):
        cx = x0
        for c, cell in enumerate(row):
            f = f_head if r == 0 else f_cell
            draw.text((cx + 24, y0 + r * row_h + 20), cell, fill="black", font=f)
            cx += col_w[c]
    img.save(out)


def main() -> int:
    out_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / "data" / "e2e"
    out_dir.mkdir(parents=True, exist_ok=True)
    make_instruction(out_dir / "instruction.png")
    make_toc(out_dir / "toc.png")
    make_entry(out_dir / "entry.png")
    make_table(out_dir / "table.png")
    for name in ("instruction.png", "toc.png", "entry.png", "table.png"):
        p = out_dir / name
        print(f"{name}: {p.stat().st_size} bytes")
    print(f"OK -> {out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
