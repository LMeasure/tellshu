#!/usr/bin/env python3
"""
用「述树 icon」原图生成 PWA / 浏览器所需的全部图标（需求 26）。
------------------------------------------------------------------
产物（写进 public/icons/）：
  icon-192.png        192×192  any     —— 原图去白边后等比缩放，保留原底色
  icon-512.png        512×512  any
  maskable-512.png    512×512  maskable—— 图形缩到 80% 安全区，底色铺满（不裁头）
  apple-touch-icon.png 180×180
  favicon.ico         16/32/48 多尺寸

用法：
  python scripts/build_app_icons.py [源图路径]
  # 默认读 D:\\lagom\\Pictures\\述树icon.png

说明：原图是 1920×1920 的 RGB（米白底、无透明通道），
所以「去白边」用与四角底色的差值做阈值，而不是靠 alpha。
"""

import sys
from pathlib import Path

from PIL import Image

DEFAULT_SRC = r"D:\lagom\Pictures\述树icon.png"
OUT_DIR = Path(__file__).resolve().parent.parent / "public" / "icons"

# 与底色差异超过这个距离就算「图形」（0-255 的欧氏距离平方阈值）
DIFF_THRESHOLD = 24**2
# 去白边后留的边距（占图形边长比例）
PAD_RATIO = 0.04


def bg_color(im: Image.Image) -> tuple[int, int, int]:
    """取四角像素的平均作为底色（原图底色有轻微噪点）"""
    w, h = im.size
    pts = [(2, 2), (w - 3, 2), (2, h - 3), (w - 3, h - 3)]
    px = [im.getpixel(p)[:3] for p in pts]
    return tuple(sum(c[i] for c in px) // len(px) for i in range(3))


def trim_to_content(im: Image.Image) -> Image.Image:
    """裁掉四周的纯底色，只留图形（加一点边距）"""
    rgb = im.convert("RGB")
    bg = bg_color(rgb)
    w, h = rgb.size
    px = rgb.load()

    def diff(p):
        d = 0
        for i in range(3):
            d += (p[i] - bg[i]) ** 2
        return d

    left, top, right, bottom = w, h, -1, -1
    # 步长 2：1920px 全扫 1.8M 次足够快，但没必要更细
    for y in range(0, h, 2):
        for x in range(0, w, 2):
            if diff(px[x, y]) > DIFF_THRESHOLD:
                if x < left:
                    left = x
                if x > right:
                    right = x
                if y < top:
                    top = y
                if y > bottom:
                    bottom = y

    if right < left or bottom < top:
        # 整张图都是底色：不裁，避免生成空图
        return rgb

    pad = int(max(right - left, bottom - top) * PAD_RATIO)
    left = max(0, left - pad)
    top = max(0, top - pad)
    right = min(w - 1, right + pad)
    bottom = min(h - 1, bottom + pad)
    return rgb.crop((left, top, right + 1, bottom + 1))


def squared(im: Image.Image, size: int, content_ratio: float, bg: tuple[int, int, int]) -> Image.Image:
    """
    把图形放进 size×size 的方图：
      content_ratio=1.0 → 图形占满（any 用途）
      content_ratio=0.8 → 图形只占 80%（maskable 安全区）
    底色铺满整张，图形居中。
    """
    canvas = Image.new("RGB", (size, size), bg)
    src = im.convert("RGBA")
    box = int(size * content_ratio)
    src = src.resize((box, box), Image.LANCZOS)
    canvas.paste(src, ((size - box) // 2, (size - box) // 2), src)
    return canvas


def compress(im: Image.Image) -> Image.Image:
    """
    图标是平滑渐变，RGB PNG 压不动（512 的要 280KB）。
    转 256 色调色板后同样观感只要 ~33KB —— 预缓存清单从 1.5MB 降到 1.0MB。
    """
    return im.quantize(colors=256, method=Image.FASTOCTREE, dither=Image.Dither.NONE)


def main() -> int:
    src_path = Path(sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SRC)
    if not src_path.exists():
        print(f"[失败] 找不到源图：{src_path}")
        return 1

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    raw = Image.open(src_path)
    print(f"源图：{src_path.name} {raw.size} {raw.mode}")

    content = trim_to_content(raw)
    bg = bg_color(raw.convert("RGB"))
    print(f"裁切后：{content.size}  底色 RGB{bg}")

    jobs = [
        ("icon-192.png", squared(content, 192, 1.0, bg), None),
        ("icon-512.png", squared(content, 512, 1.0, bg), None),
        ("maskable-512.png", squared(content, 512, 0.8, bg), None),
        ("apple-touch-icon.png", squared(content, 180, 1.0, bg), None),
    ]
    for name, img, _ in jobs:
        out = OUT_DIR / name
        compress(img).save(out, "PNG", optimize=True)
        print(f"  ✓ {name} {img.size} {out.stat().st_size // 1024}KB")

    fav = OUT_DIR / "favicon.ico"
    squared(content, 64, 1.0, bg).save(
        fav, "ICO", sizes=[(16, 16), (32, 32), (48, 48)]
    )
    print(f"  ✓ favicon.ico 16/32/48")

    print(f"\n全部写入 {OUT_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
