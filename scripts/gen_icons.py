#!/usr/bin/env python3
"""
生成 PWA 图标（述树）
==================================================================
为什么需要它：PWA「添加到主屏幕」要求 manifest 提供 192/512 PNG，
iOS 的 apple-touch-icon 也只认 PNG。项目此前没有任何图标文件。

产出（全部落在 public/ 下，体积仅几十 KB，可安全进构建产物）：
  icons/icon-192.png          Android 主屏幕（purpose: any）
  icons/icon-512.png          Android 启动画面 / 应用列表
  icons/maskable-512.png      Android 自适应图标（purpose: maskable）
  icons/apple-touch-icon.png  iOS 主屏幕（180×180）
  favicon.ico                 浏览器标签页

设计约束：
  - 品牌绿 #2fae6a（与 index.html 的 theme-color 一致，不另造颜色）
  - maskable 必须「满幅 + 内容缩到中间 60%」：系统在四周最多裁掉 20%，
    图形贴边会被切掉，这是最常见的 maskable 图标翻车点。
  - 图形用 4 倍超采样后缩小，避免小尺寸锯齿。

用法：python scripts/gen_icons.py
"""
import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_ICONS = os.path.join(ROOT, 'public', 'icons')

# 品牌色（取自 index.html <meta name="theme-color">）
GREEN_TOP = (53, 196, 122)     # #35c47a
GREEN_BOTTOM = (31, 143, 85)   # #1f8f55
TREE = (255, 255, 255, 255)

SS = 4  # 超采样倍数


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def vertical_gradient(size, top, bottom):
    """生成竖向渐变底图（先画 1px 宽再横向拉伸，比逐像素快得多）。"""
    strip = Image.new('RGB', (1, size))
    px = strip.load()
    for y in range(size):
        px[0, y] = lerp(top, bottom, y / max(size - 1, 1))
    return strip.resize((size, size), Image.NEAREST)


def rounded_mask(size, radius_ratio):
    mask = Image.new('L', (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, size - 1, size - 1], radius=int(size * radius_ratio), fill=255
    )
    return mask


def draw_tree(size):
    """
    画「述树」的树：三团树冠（上 1 下 2 呈品字）+ 一根树干，纯白图层。
    所有坐标按 size 等比给，换尺寸不用改数字。
    选「品字三圆」而不是写实树冠：192px 下轮廓依然清晰，不会糊成一坨。
    """
    layer = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    def box(cx, cy, r):
        return [(cx - r) * size, (cy - r) * size, (cx + r) * size, (cy + r) * size]

    # 树干（先画，被树冠盖住上半段，形成连贯的树形）
    d.rounded_rectangle(
        [0.455 * size, 0.56 * size, 0.545 * size, 0.86 * size],
        radius=int(0.045 * size),
        fill=TREE,
    )
    # 树冠：上中 1 团 + 左下右下各 1 团，互相重叠
    d.ellipse(box(0.50, 0.30, 0.185), fill=TREE)
    d.ellipse(box(0.325, 0.515, 0.185), fill=TREE)
    d.ellipse(box(0.675, 0.515, 0.185), fill=TREE)
    return layer


def build(size, maskable=False):
    """
    maskable=False：圆角方形（22% 圆角）+ 图形占 74%
    maskable=True ：满幅方形（无圆角）+ 图形缩到 62%（四周留足安全区，
                    系统最多裁掉 20%，贴边就会被切）
    """
    big = size * SS
    bg = vertical_gradient(big, GREEN_TOP, GREEN_BOTTOM).convert('RGBA')

    if not maskable:
        bg.putalpha(rounded_mask(big, 0.22))

    # 图形按目标比例单独绘制后居中贴上，避免「先放大再裁」把缩放抵消掉
    scale = 0.62 if maskable else 0.74
    inner = int(big * scale)
    tree = draw_tree(inner)
    offset = (big - inner) // 2
    bg.alpha_composite(tree, (offset, offset))
    return bg.resize((size, size), Image.LANCZOS)


def save(img, path, sizes=None):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if sizes:
        img.save(path, sizes=sizes)
    else:
        img.save(path, optimize=True)
    print('%-46s %6.1f KB' % (os.path.relpath(path, ROOT), os.path.getsize(path) / 1024))


def main():
    base512 = build(512)
    base192 = build(192)

    save(base192, os.path.join(OUT_ICONS, 'icon-192.png'))
    save(base512, os.path.join(OUT_ICONS, 'icon-512.png'))
    save(build(512, maskable=True), os.path.join(OUT_ICONS, 'maskable-512.png'))
    save(build(180), os.path.join(OUT_ICONS, 'apple-touch-icon.png'))
    save(base512, os.path.join(ROOT, 'public', 'favicon.ico'), sizes=[(16, 16), (32, 32), (48, 48)])

    print('\n图标生成完成 ✓')


if __name__ == '__main__':
    main()
