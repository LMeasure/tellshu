#!/usr/bin/env python3
"""
PWA 构建产物体检（不依赖浏览器）
==================================================================
为什么需要它：**字符串存在 ≠ 功能正确**。

曾经踩过的坑：vite.config.ts 里把 urlPattern 写成
`({ url }) => DATA_SHARD_RE.test(url.pathname)`，workbox 会把函数体原样写进 sw.js，
而 `DATA_SHARD_RE` 在 Service Worker 作用域里根本不存在 —— 产物里能看到
`shushu-data` / `CacheFirst` 这些字样（看起来"配好了"），实际每条路由一匹配就
ReferenceError，运行时缓存完全失效。

所以本脚本不比对配置源文件，而是**从 dist/sw.js 里把正则抠出来直接跑 URL**：
  * 抠出 `registerRoute(<正则>, ...)` 的正则与它对应的 cacheName
  * 用一批真实 URL 验证分流是否符合预期（index / shard / 不拦截）
  * 顺带检查悬空标识符、precache 是否混入词库数据、manifest 与 index.html 是否完整

用法
----
  npm run build
  python scripts/check_pwa.py            # 或：python scripts/check_pwa.py --dist dist
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# 期望的路由归属：index=NetworkFirst 索引缓存；shard=CacheFirst 分片缓存；None=不该被这两条拦
ROUTE_CASES: list[tuple[str, str | None]] = [
    # 同源（dev / preview / 自托管）
    ('http://localhost:4173/data/linguabase/v1/index.json', 'index'),
    ('http://localhost:4173/data/linguabase/v1/manifest.json', 'index'),
    ('http://localhost:4173/data/linguabase/v1/catalog.json', 'index'),
    ('http://localhost:4173/data/linguabase/v1/themes/index.json', 'index'),
    ('http://localhost:4173/data/linguabase/v1/bank/index.json', 'index'),
    ('http://localhost:4173/data/linguabase/v1/search-index.json', 'shard'),
    ('http://localhost:4173/data/linguabase/v1/books/CET4.json', 'shard'),
    ('http://localhost:4173/data/linguabase/v1/themes/animals.json', 'shard'),
    ('http://localhost:4173/data/linguabase/v1/bank/L3_a.json', 'shard'),
    ('http://localhost:4173/data/linguabase/v1/defs/bank_L3_x.json', 'shard'),
    # 跨域（生产：数据放 R2 等对象存储）—— 路径里没有 data/ 前缀也必须命中
    ('https://data.shushu.app/linguabase/v1/index.json', 'index'),
    ('https://data.shushu.app/linguabase/v1/defs/bank_L1.json', 'shard'),
    # 不应被数据路由拦截
    ('http://localhost:4173/', None),
    ('http://localhost:4173/assets/index-abc.js', None),
    ('http://localhost:4173/manifest.webmanifest', None),
    ('http://localhost:4173/sw.js', None),
]

# 未来发 v2 时也要能命中（正则里是 v\d+，不是写死的 v1）
VERSION_CASES: list[tuple[str, str | None]] = [
    ('http://localhost:4173/data/linguabase/v2/index.json', 'index'),
    ('https://data.shushu.app/linguabase/v3/bank/L1.json', 'shard'),
]

# precache 里绝不能出现的关键词（410MB 数据一旦进预缓存，首屏就废了）
FORBIDDEN_IN_PRECACHE = ('linguabase', 'books/', 'bank/', 'defs/', 'themes/', 'search-index')


class Report:
    def __init__(self) -> None:
        self.errors: list[str] = []
        self.passed = 0

    def ok(self, msg: str) -> None:
        self.passed += 1
        print(f'  ✓ {msg}')

    def fail(self, msg: str) -> None:
        self.errors.append(msg)
        print(f'  ✗ {msg}')


def extract_regex(text: str, start: int) -> tuple[str, int] | None:
    """从 `/` 开始读一个 JS 正则字面量，正确处理 \\/ 与字符类 [...]"""
    if start >= len(text) or text[start] != '/':
        return None
    i = start + 1
    in_class = False
    while i < len(text):
        ch = text[i]
        if ch == '\\':
            i += 2
            continue
        if ch == '[':
            in_class = True
        elif ch == ']':
            in_class = False
        elif ch == '/' and not in_class:
            return text[start + 1 : i], i + 1
        i += 1
    return None


def parse_routes(sw: str) -> list[dict]:
    """抠出所有 registerRoute(<正则>, handler) 的正则与其 cacheName"""
    routes: list[dict] = []
    for m in re.finditer(r'registerRoute\(', sw):
        got = extract_regex(sw, m.end())
        if not got:
            continue  # 非正则形式（如 NavigationRoute），跳过
        pattern, after = got
        tail = sw[after : after + 400]
        name = re.search(r'cacheName:"([^"]+)"', tail)
        handler = re.search(r'new \w+\.(\w+)\(', tail)
        routes.append(
            {
                'pattern': pattern,
                'cache': name.group(1) if name else '(无 cacheName)',
                'handler': handler.group(1) if handler else '(未知)',
            }
        )
    return routes


def main() -> None:
    ap = argparse.ArgumentParser(description='PWA 构建产物体检')
    ap.add_argument('--dist', default=str(ROOT / 'dist'))
    args = ap.parse_args()

    dist = Path(args.dist)
    sw_path = dist / 'sw.js'
    manifest_path = dist / 'manifest.webmanifest'
    index_path = dist / 'index.html'
    r = Report()

    for p in (sw_path, manifest_path, index_path):
        if not p.is_file():
            sys.exit(f'找不到 {p}\n请先执行 npm run build')

    sw = sw_path.read_text(encoding='utf-8')
    print('PWA 构建产物体检')
    print(f'  dist: {dist}')
    print()

    # ── 1. 悬空标识符：函数体被原样复制进 SW 时会留下外部常量名 ──────
    print('[1] sw.js 无悬空标识符')
    dangling = sorted(set(re.findall(r'\b(?:DATA|APP|SAME_ORIGIN)_[A-Z_]+\b', sw)))
    if dangling:
        r.fail(
            f'sw.js 引用了 Service Worker 作用域里不存在的标识符：{dangling}'
            '（urlPattern 写成函数就会这样，改用 RegExp 字面量）'
        )
    else:
        r.ok('未发现悬空标识符')

    # ── 2. 路由规则存在且是正则字面量 ───────────────────────────────
    print('[2] 运行时路由规则')
    routes = parse_routes(sw)
    if len(routes) < 2:
        r.fail(f'只解析到 {len(routes)} 条数据路由（期望 ≥2：索引 NetworkFirst + 分片 CacheFirst）')
    for route in routes:
        r.ok(f'{route["handler"]:<14} cache={route["cache"]:<14} /{route["pattern"]}/')

    by_cache = {route['cache']: route for route in routes}
    index_route = by_cache.get('shushu-index')
    shard_route = by_cache.get('shushu-data')
    if not index_route or not shard_route:
        r.fail('缺少 shushu-index 或 shushu-data 缓存配置')
        print()
        if r.errors:
            sys.exit(1)
        return

    # ── 3. 用真实 URL 跑抠出来的正则 ────────────────────────────────
    print('[3] URL 分流验证（用 sw.js 里的正则实测）')
    try:
        re_index = re.compile(index_route['pattern'])
        re_shard = re.compile(shard_route['pattern'])
    except re.error as exc:
        r.fail(f'从 sw.js 抠出的正则无法编译：{exc}')
        print()
        sys.exit(1)

    def classify(url: str) -> str | None:
        if re_index.search(url):
            return 'index'
        if re_shard.search(url):
            return 'shard'
        return None

    bad = 0
    for url, want in ROUTE_CASES + VERSION_CASES:
        got = classify(url)
        if got != want:
            bad += 1
            r.fail(f'{url}  实际={got} 期望={want}')
    if bad == 0:
        r.ok(f'{len(ROUTE_CASES) + len(VERSION_CASES)} 个 URL 全部命中预期策略'
             f'（含跨域与 v2/v3）')

    # ── 4. precache 不得混入词库数据 ────────────────────────────────
    print('[4] 预缓存清单')
    precache = re.findall(r'\{url:"([^"]+)"', sw)
    leaked = [u for u in precache if any(k in u for k in FORBIDDEN_IN_PRECACHE)]
    if leaked:
        r.fail(f'预缓存混入了词库数据（{len(leaked)} 项）：{leaked[:5]}')
    else:
        r.ok(f'{len(precache)} 项预缓存，全部为应用外壳（无词库数据）')

    # ── 5. manifest 完整性 ──────────────────────────────────────────
    print('[5] manifest.webmanifest')
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    for key in ('name', 'short_name', 'start_url', 'display', 'theme_color', 'icons'):
        if not manifest.get(key):
            r.fail(f'manifest 缺少 {key}')
    icons = manifest.get('icons', [])
    if not any(i.get('purpose') == 'maskable' for i in icons):
        r.fail('manifest 缺少 purpose=maskable 的图标（Android 会裁掉图标边缘）')
    sizes = {i.get('sizes') for i in icons}
    if '192x192' not in sizes or '512x512' not in sizes:
        r.fail(f'图标尺寸不全（有 {sizes}，需要 192x192 与 512x512）')
    if not r.errors or all('manifest' not in e and '图标' not in e for e in r.errors):
        r.ok(f'{len(icons)} 个图标，含 maskable；display={manifest.get("display")}')

    # ── 6. index.html 必需引用 ──────────────────────────────────────
    print('[6] index.html')
    html = index_path.read_text(encoding='utf-8')
    for needle, desc in (
        ('rel="manifest"', 'manifest 链接'),
        ('registerSW.js', 'SW 注册脚本'),
        ('apple-touch-icon', 'iOS 主屏图标'),
        ('apple-mobile-web-app-capable', 'iOS 独立窗口 meta'),
    ):
        if needle in html:
            r.ok(desc)
        else:
            r.fail(f'index.html 缺少 {desc}（{needle}）')

    print()
    if r.errors:
        print(f'❌ {len(r.errors)} 项失败')
        sys.exit(1)
    print(f'✅ PWA 构建产物体检通过（{r.passed} 项）')


if __name__ == '__main__':
    main()
