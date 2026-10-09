#!/usr/bin/env python3
"""
校验已发布的词库数据（纯 HTTP，不依赖任何云 SDK）
==================================================================
为什么需要它：上传 159 个对象 / 409MB 之后，"到底传全了没有" 靠肉眼看控制台不可靠。
本脚本拿本地目录当**期望清单**，逐个 HTTP 校验远端，把"漏传 / 类型错 / 缓存头错 /
索引引用了不存在的分片"这几类事故一次性查出来。

设计取舍：
  * **只用标准库 urllib** —— 不装 boto3/requests 也能跑，因此现在就能对
    `http://localhost:4173` 实测；将来把 --base 换成 R2 公开地址即可直接复用做上线验收。
  * 清单来自**本地目录**而不是手写列表 —— 上传脚本也是这么枚举的，两边天然一致，
    不会出现"按 A 清单传、按 B 清单验"的错位。
  * 缓存头默认只**告警**不判失败 —— 本地 dev/preview 中间件固定返回 no-cache，
    那是预期行为；加 --strict 才会把它当错误（对 R2 验收时用）。

用法
----
  # 本地 preview（先 npm run preview）
  python scripts/verify_data.py --base http://localhost:4173/data/linguabase/v1/

  # R2 上线验收：严格模式 + 查 CORS
  python scripts/verify_data.py \
      --base https://data.shushu.app/linguabase/v1/ \
      --origin https://shushu.app \
      --strict

  # 只抽查，不逐个 HEAD（快）
  python scripts/verify_data.py --base <url> --quick

常用参数
--------
  --base      数据基址，末尾需带 /（必填）
  --dir       本地期望清单目录，默认 data/linguabase/v1（受 VITE_DATA_VERSION 影响）
  --origin    带上 Origin 头，顺带查 CORS 是否放行该来源
  --sample    实际 GET 并解析 JSON 的对象数，默认 5
  --strict    缓存头不符也判为失败
  --quick     只校验索引文件与抽样，不逐个 HEAD 全量分片
  --jobs      并发数，默认 8
  --timeout   单个请求超时秒数，默认 20
"""

from __future__ import annotations

import argparse
import concurrent.futures as futures
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# 本机地址不走代理：环境里若配了 http_proxy，urllib 会把 localhost 请求也发给代理，
# 表现为莫名其妙的 502/超时。这种失败极难排查，所以显式绕开。
LOCAL_HOSTS = {'localhost', '127.0.0.1', '::1'}


def make_opener(base: str) -> urllib.request.OpenerDirector:
    host = (urllib.parse.urlparse(base).hostname or '').lower()
    if host in LOCAL_HOSTS:
        return urllib.request.build_opener(urllib.request.ProxyHandler({}))
    return urllib.request.build_opener()

# 与 scripts/upload_data.py 完全一致的缓存头规则（两处改了要一起改）
SHORT_CACHE_NAMES = {'index.json', 'manifest.json', 'catalog.json'}
SHORT_CACHE_REL = {'themes/index.json', 'bank/index.json'}
SHORT_CACHE = 'public, max-age=300'
LONG_CACHE = 'public, max-age=31536000, immutable'


def default_data_dir() -> Path:
    version = os.environ.get('VITE_DATA_VERSION', 'v1')
    return ROOT / 'data' / 'linguabase' / version


def content_type_for(name: str) -> str:
    if name.endswith('.json'):
        return 'application/json'
    if name.endswith('.png'):
        return 'image/png'
    return 'application/octet-stream'


def expected_cache(rel: str) -> str:
    name = rel.rsplit('/', 1)[-1]
    if rel in SHORT_CACHE_REL or (name in SHORT_CACHE_NAMES and '/' not in rel):
        return SHORT_CACHE
    return LONG_CACHE


def build_expectation(data_dir: Path) -> list[dict]:
    if not data_dir.is_dir():
        sys.exit(f'找不到本地数据目录：{data_dir}\n请先生成数据，或用 --dir 指定。')
    items: list[dict] = []
    for path in sorted(data_dir.rglob('*')):
        if not path.is_file():
            continue
        rel = path.relative_to(data_dir).as_posix()
        items.append(
            {
                'rel': rel,
                'size': path.stat().st_size,
                'content_type': content_type_for(path.name),
                'cache': expected_cache(rel),
            }
        )
    return items


def http_headers(
    opener: urllib.request.OpenerDirector,
    url: str,
    origin: str | None,
    timeout: float,
) -> tuple[int, dict]:
    """先 HEAD；部分服务不允许 HEAD，则退回带 Range 的 GET（避免整包下载）。"""
    def _req(method: str, extra: dict) -> tuple[int, dict]:
        request = urllib.request.Request(url, method=method, headers=extra)
        with opener.open(request, timeout=timeout) as resp:
            return resp.status, dict(resp.headers)

    headers = {'User-Agent': 'shushu-verify/1.0'}
    if origin:
        headers['Origin'] = origin
    try:
        return _req('HEAD', headers)
    except urllib.error.HTTPError as exc:
        # HEAD 不被允许时重试 GET；其余 4xx/5xx 直接按状态码返回
        if exc.code in (403, 405, 501):
            try:
                return _req('GET', {**headers, 'Range': 'bytes=0-0'})
            except urllib.error.HTTPError as exc2:
                return exc2.code, dict(exc2.headers)
        return exc.code, dict(exc.headers)
    except (urllib.error.URLError, TimeoutError) as exc:
        raise RuntimeError(f'{getattr(exc, "reason", exc)}') from exc


class Report:
    def __init__(self) -> None:
        self.errors: list[str] = []
        self.warnings: list[str] = []
        # 缓存头告警按 (实际值, 期望值) 聚合，否则 159 个对象会刷出 159 行
        self.cache_issues: dict[tuple[str, str], int] = {}
        self.ok = 0
        self.checked = 0
        self.bytes = 0

    def fail(self, msg: str) -> None:
        self.errors.append(msg)

    def warn_cache(self, actual: str, expected: str) -> None:
        key = (actual, expected)
        self.cache_issues[key] = self.cache_issues.get(key, 0) + 1


def main() -> None:
    ap = argparse.ArgumentParser(description='校验已发布的词库数据')
    ap.add_argument('--base', required=True, help='数据基址，末尾需带 /')
    ap.add_argument('--dir', default=str(default_data_dir()), help='本地期望清单目录')
    ap.add_argument('--origin', default=None, help='带 Origin 头，顺带查 CORS')
    ap.add_argument('--sample', type=int, default=5, help='实际 GET 解析 JSON 的对象数')
    ap.add_argument('--strict', action='store_true', help='缓存头不符也判失败')
    ap.add_argument('--quick', action='store_true', help='只校验索引与抽样，不逐个 HEAD 全量')
    ap.add_argument('--jobs', type=int, default=8)
    ap.add_argument('--timeout', type=float, default=20.0)
    args = ap.parse_args()

    base = args.base if args.base.endswith('/') else args.base + '/'
    data_dir = Path(args.dir)
    items = build_expectation(data_dir)
    report = Report()

    # 完整清单要留一份：quick 模式只缩小「待校验」集合，
    # 但一致性检查必须比对全量，否则会误报"索引引用了清单里没有的分片"。
    all_items = items

    # quick 模式：只校验索引类 + 每个子目录的第一个分片
    if args.quick:
        keep: list[dict] = []
        seen_dir: set[str] = set()
        for it in items:
            top = it['rel'].split('/', 1)[0] if '/' in it['rel'] else ''
            if it['rel'] in SHORT_CACHE_REL or it['rel'] in SHORT_CACHE_NAMES:
                keep.append(it)
            elif top and top not in seen_dir:
                seen_dir.add(top)
                keep.append(it)
        items = keep

    print(f'数据基址 : {base}')
    print(f'期望清单 : {data_dir}')
    print(f'校验对象 : {len(items)}')
    if args.origin:
        print(f'CORS 来源 : {args.origin}')
    print()

    opener = make_opener(base)

    def check(item: dict) -> None:
        url = base + item['rel']
        try:
            status, headers = http_headers(opener, url, args.origin, args.timeout)
        except RuntimeError as exc:
            report.fail(f'{item["rel"]}  请求失败（网络/超时）：{exc}')
            return
        report.checked += 1
        if status != 200:
            report.fail(f'{item["rel"]}  HTTP {status}（期望 200）')
            return

        ctype = headers.get('Content-Type', '')
        if not ctype.lower().startswith(item['content_type']):
            report.fail(f'{item["rel"]}  Content-Type={ctype!r}（期望 {item["content_type"]}）')

        cache = headers.get('Cache-Control', '')
        if cache != item['cache']:
            msg = f'{item["rel"]}  Cache-Control={cache!r}（期望 {item["cache"]!r}）'
            if args.strict:
                report.fail(msg)
            else:
                report.warn_cache(cache, item['cache'])

        if args.origin:
            allow = headers.get('Access-Control-Allow-Origin', '')
            if allow not in (args.origin, '*'):
                report.fail(f'{item["rel"]}  CORS 未放行 {args.origin}（收到 {allow!r}）')

        # 分块传输（无 Content-Length）时用本地文件大小兜底，避免体积统计显示为 0
        length = headers.get('Content-Length')
        if length is not None and length.isdigit():
            report.bytes += int(length)
        else:
            report.bytes += item['size']

        report.ok += 1

    with futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
        list(pool.map(check, items))

    # ── 抽样：真正下载并解析，确认不是"存在但内容坏了" ──────────────
    print('抽样解析 JSON…')
    samples: list[dict] = [it for it in items if it['rel'] in SHORT_CACHE_NAMES]
    if not samples:
        samples.append(items[0])
    step = max(1, len(items) // max(1, args.sample))
    for it in items[::step][: args.sample]:
        if it not in samples:
            samples.append(it)
    samples = samples[: max(args.sample, 3)]

    for it in samples:
        url = base + it['rel']
        try:
            request = urllib.request.Request(url, headers={'User-Agent': 'shushu-verify/1.0'})
            with opener.open(request, timeout=args.timeout) as resp:
                body = resp.read()
            parsed = json.loads(body.decode('utf-8'))
        except (urllib.error.URLError, TimeoutError) as exc:
            report.fail(f'{it["rel"]}  抽样下载失败：{getattr(exc, "reason", exc)}')
            continue
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            report.fail(f'{it["rel"]}  抽样解析失败（内容损坏？）：{exc}')
            continue
        size_note = f'{len(body) / 1024:.1f} KB'
        kind = type(parsed).__name__
        print(f'  ✓ {it["rel"]:<34} {size_note:>10}  JSON={kind}')

    # ── 一致性：索引引用的分片必须都存在 ────────────────────────────
    print('\n索引引用的分片…')
    try:
        request = urllib.request.Request(base + 'index.json')
        with opener.open(request, timeout=args.timeout) as resp:
            index = json.loads(resp.read().decode('utf-8'))
        refs: list[str] = []
        for book in index.get('books', []):
            if isinstance(book, dict) and book.get('file'):
                refs.append(book['file'])
        present = {it['rel'] for it in all_items}
        missing = [r for r in refs if r not in present]
        if missing:
            report.fail(f'index.json 引用了 {len(missing)} 个清单里没有的分片：{missing[:5]}')
        else:
            print(f'  ✓ index.json 引用的 {len(refs)} 个词本分片全部在清单内')
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, KeyError) as exc:
        report.fail(f'index.json 读取/解析失败，跳过一致性检查：{exc}')

    # ── 汇总 ────────────────────────────────────────────────────────
    print()
    print(f'已校验   : {report.checked}/{len(items)}')
    print(f'通过     : {report.ok}')
    print(f'远端体积 : {report.bytes / 1024 / 1024:.1f} MB（按 Content-Length 累加）')

    if report.cache_issues:
        total = sum(report.cache_issues.values())
        print(f'告警     : {total} 项缓存头与预期不符（--strict 会判为失败）')
        for (actual, expected), n in sorted(report.cache_issues.items(), key=lambda kv: -kv[1]):
            print(f'           {n:>3} 项  实际 {actual!r}  期望 {expected!r}')

    if report.errors:
        print(f'\n❌ {len(report.errors)} 项失败：')
        for e in report.errors[:20]:
            print(f'   {e}')
        if len(report.errors) > 20:
            print(f'   … 其余 {len(report.errors) - 20} 项')
        sys.exit(1)

    print('\n✅ 数据校验全部通过')


if __name__ == '__main__':
    main()
