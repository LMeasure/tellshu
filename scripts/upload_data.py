#!/usr/bin/env python3
"""
把词库数据上传到对象存储（Cloudflare R2 / 任意 S3 兼容服务）
==================================================================
为什么需要它：410MB 词库不进前端包，生产环境从对象存储按需拉取。
选 R2 的关键理由是**出口流量免费** —— 词库会被反复读取，走 CDN 计费的
服务（如 S3 + CloudFront）账单会失控。

前置条件
--------
  1. 已在 Cloudflare 建好 R2 桶，并开启了公开访问（或绑定自定义域名）
  2. 已创建 R2 API 令牌（Access Key / Secret Key）
  3. 本地有 data/linguabase/v1/ 数据（由 export_full_to_shushu.py 生成）
  4. pip install boto3   （仅正式上传需要；--dry-run 不需要）

环境变量（**不要把密钥写进代码或提交到仓库**）
----------------------------------------------
  S3_ENDPOINT        R2 的 S3 端点，如 https://<account_id>.r2.cloudflarestorage.com
  S3_BUCKET          桶名，如 shushu-data
  S3_PREFIX          对象前缀，默认 linguabase/$VITE_DATA_VERSION（即 linguabase/v1）
  VITE_DATA_VERSION  数据版本号，默认 v1；发新版数据改成 v2 即可并存（见下）
  AWS_ACCESS_KEY_ID  R2 API 令牌的 Access Key ID
  AWS_SECRET_ACCESS_KEY  R2 API 令牌的 Secret Access Key
  AWS_DEFAULT_REGION 默认 auto（R2 要求）

用法
----
  python scripts/upload_data.py --dry-run      # 先看要传什么、用什么缓存头
  python scripts/upload_data.py                # 正式上传（并发 8）
  python scripts/upload_data.py --jobs 16      # 调并发
  python scripts/upload_data.py --prefix x/y   # 换前缀（配合多版本数据）

缓存策略（这是本脚本的核心价值，比裸 rsync 重要的地方）
------------------------------------------------------
  * 版本化分片（books/ themes/<id>.json bank/L*.json defs/*.json）
      → Cache-Control: public, max-age=31536000, immutable
      路径里带 v1，内容永不变；模型：发新版=发 v2 目录，老客户端不受影响
  * 稳定索引（index.json manifest.json catalog.json themes/index.json bank/index.json）
      → Cache-Control: public, max-age=300
      允许短缓存，改词库时不至于让用户长时间读到旧目录
  * 另：分片带 immutable 也**不影响** PWA 的 Service Worker 更新
      —— SW 的缓存名带版本，且由 sw.js 自身控制失效。
"""

from __future__ import annotations

import argparse
import concurrent.futures as futures
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# 版本号与前端 dataClient 的 DATA_VERSION 同源（都读 VITE_DATA_VERSION，默认 v1）。
# 发新版数据：把 VITE_DATA_VERSION=v2 后跑本脚本，即可把新数据传成 linguabase/v2/，
# 老版本 v1 不受影响 —— 「路径即版本」，可灰度可回滚。
DATA_VERSION = os.environ.get('VITE_DATA_VERSION', 'v1')
DATA_DIR = ROOT / 'data' / 'linguabase' / DATA_VERSION

# 需要短缓存的「稳定索引」：改名/改词库后要能较快生效
SHORT_CACHE_NAMES = {
    'index.json',
    'manifest.json',
    'catalog.json',
}
SHORT_CACHE_REL = {
    'themes/index.json',
    'bank/index.json',
}
SHORT_CACHE_SECONDS = 300
LONG_CACHE_SECONDS = 31536000  # 1 年


def content_type_for(name: str) -> str:
    if name.endswith('.json'):
        return 'application/json; charset=utf-8'
    if name.endswith('.png'):
        return 'image/png'
    if name.endswith('.ico'):
        return 'image/x-icon'
    return 'application/octet-stream'


def cache_control_for(rel: str) -> str:
    """rel 是相对于数据根目录的 POSIX 路径，如 bank/L1.json"""
    name = rel.rsplit('/', 1)[-1]
    if rel in SHORT_CACHE_REL or (name in SHORT_CACHE_NAMES and rel.count('/') == 0):
        return f'public, max-age={SHORT_CACHE_SECONDS}'
    return f'public, max-age={LONG_CACHE_SECONDS}, immutable'


def build_plan(prefix: str) -> list[dict]:
    if not DATA_DIR.is_dir():
        sys.exit(
            f'找不到数据目录：{DATA_DIR}\n'
            '请先运行 export_full_to_shushu.py 生成数据，或修正 DATA_DIR。'
        )
    plan: list[dict] = []
    for path in sorted(DATA_DIR.rglob('*')):
        if not path.is_file():
            continue
        rel = path.relative_to(DATA_DIR).as_posix()
        plan.append(
            {
                'local': path,
                'rel': rel,
                'key': f'{prefix.rstrip("/")}/{rel}',
                'size': path.stat().st_size,
                'content_type': content_type_for(path.name),
                'cache_control': cache_control_for(rel),
            }
        )
    return plan


def human(n: float) -> str:
    for unit in ('B', 'KB', 'MB', 'GB'):
        if n < 1024 or unit == 'GB':
            return f'{n:.1f} {unit}'
        n /= 1024
    return f'{n:.1f} GB'


def print_plan(plan: list[dict], prefix: str) -> None:
    total = sum(p['size'] for p in plan)
    print(f'数据目录 : {DATA_DIR}')
    print(f'对象前缀 : {prefix}/')
    print(f'文件数   : {len(plan)}')
    print(f'总体积   : {human(total)}')
    print()
    print('缓存头分布：')
    buckets: dict[str, int] = {}
    for p in plan:
        buckets[p['cache_control']] = buckets.get(p['cache_control'], 0) + 1
    for cc, cnt in sorted(buckets.items()):
        print(f'  {cnt:>4} 个  {cc}')
    print()
    print('前 5 个对象：')
    for p in plan[:5]:
        print(f'  {p["key"]:<52} {human(p["size"]):>10}  {p["content_type"]}')
    if len(plan) > 5:
        print(f'  ... 其余 {len(plan) - 5} 个')


def upload_one(client, bucket: str, item: dict) -> tuple[str, int]:
    client.upload_file(
        str(item['local']),
        bucket,
        item['key'],
        ExtraArgs={
            'ContentType': item['content_type'],
            'CacheControl': item['cache_control'],
        },
    )
    return item['key'], item['size']


def main() -> None:
    ap = argparse.ArgumentParser(description='上传词库数据到 S3 兼容对象存储')
    ap.add_argument('--dry-run', action='store_true', help='只打印计划，不实际上传')
    ap.add_argument(
        '--prefix', default=os.environ.get('S3_PREFIX', f'linguabase/{DATA_VERSION}')
    )
    ap.add_argument('--jobs', type=int, default=8, help='并发上传数，默认 8')
    args = ap.parse_args()

    plan = build_plan(args.prefix)
    print_plan(plan, args.prefix)

    if args.dry_run:
        print('\n--dry-run：未执行上传。')
        return

    endpoint = os.environ.get('S3_ENDPOINT')
    bucket = os.environ.get('S3_BUCKET')
    if not endpoint or not bucket:
        sys.exit('缺少 S3_ENDPOINT / S3_BUCKET 环境变量（见文件头部说明）')
    if not os.environ.get('AWS_ACCESS_KEY_ID') or not os.environ.get('AWS_SECRET_ACCESS_KEY'):
        sys.exit('缺少 AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY 环境变量')

    try:
        import boto3  # 延迟导入：--dry-run 无需安装
    except ImportError:
        sys.exit('未安装 boto3，请先执行：pip install boto3')

    client = boto3.client(
        's3',
        endpoint_url=endpoint,
        region_name=os.environ.get('AWS_DEFAULT_REGION', 'auto'),
    )

    print(f'\n开始上传到 {endpoint} / {bucket} （并发 {args.jobs}）…')
    done = 0
    total_bytes = 0
    total = len(plan)
    with futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
        tasks = [pool.submit(upload_one, client, bucket, item) for item in plan]
        for task in futures.as_completed(tasks):
            try:
                _key, size = task.result()
            except Exception as exc:  # noqa: BLE001 - 逐条报告后中断，避免静默半成品
                print(f'\n上传失败：{exc}')
                for t in tasks:
                    t.cancel()
                sys.exit(1)
            done += 1
            total_bytes += size
            if done % 20 == 0 or done == total:
                print(f'  {done}/{total}  {human(total_bytes)}')

    print(f'\n完成：{done} 个对象，{human(total_bytes)}')
    print('下一步：把 VITE_DATA_BASE_URL 设为你的公开访问地址，例如')
    print(f'  VITE_DATA_BASE_URL=https://<你的域名>/{args.prefix}/')


if __name__ == '__main__':
    main()
