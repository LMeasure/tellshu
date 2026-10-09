#!/usr/bin/env python3
"""
构建「全词库搜索索引」与「学习路径目录」
==================================================================
输入：data/linguabase/v1/books/*.json（OpenEtymology 真实词库）
输出：
  data/linguabase/v1/search-index.json  全词搜索（按需懒加载，约 4MB）
  data/linguabase/v1/catalog.json       路径目录（词本 × 难度档统计，几 KB）

⚠️ 数据目录已移出 public/（不参与打包），见「部署与外部存储方案.md」P0。

为什么需要它：
  1. 搜索要覆盖全部 22,791 词。直接拉 5 本词本共 30MB，移动端首屏代价太大；
     索引只保留搜索/列表所需的核心字段，体积降到约 1/8。
  2. 学习路径要按「词本 × 难度档」分组，若在运行时算需先加载全部词本；
     catalog 把统计结果预计算好，路径页只需读这几 KB。

难度分档规则必须与前端 src/lib/diagnostic.ts 的 bucketByDifficulty 保持一致：
  L1 = 词长<=4 且 语素<=1（不足 4 个则放宽为 词长<=5）
  L2 = 5<=词长<=8 且 语素<=2（不足 4 个则放宽为 5..8）
  L3 = 词长>=9 或 语素>=3（不足 4 个则放宽为 词长>=8）

⚠️ 不使用 frequency_rank —— 该字段实为字母序下标（见 README「数据陷阱」）。

用法：python3 scripts/build_search_index.py
"""
import json
import io
import os
import sys
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BOOKS_DIR = os.path.join(ROOT, 'data', 'linguabase', 'v1', 'books')
OUT_DIR = os.path.join(ROOT, 'data', 'linguabase', 'v1')
INDEX_FILE = os.path.join(OUT_DIR, 'index.json')

LEVEL_LABEL = {
    1: '基础短词',
    2: '常用词',
    3: '进阶长词',
}


def morph_count(w):
    m = w.get('morphemes')
    return len(m) if isinstance(m, list) else 0


def bucketize(rows):
    """与前端 bucketByDifficulty 同规则的三档切分。"""
    l1 = [w for w in rows if len(w['word']) <= 4 and morph_count(w) <= 1]
    l2 = [w for w in rows if 5 <= len(w['word']) <= 8 and morph_count(w) <= 2]
    l3 = [w for w in rows if len(w['word']) >= 9 or morph_count(w) >= 3]

    def relax(cur, fallback):
        return cur if len(cur) >= 4 else fallback()

    return {
        1: relax(l1, lambda: [w for w in rows if len(w['word']) <= 5]),
        2: relax(l2, lambda: [w for w in rows if 5 <= len(w['word']) <= 8]),
        3: relax(l3, lambda: [w for w in rows if len(w['word']) >= 8]),
    }


def main():
    if not os.path.isdir(BOOKS_DIR):
        print('找不到词本目录：%s' % BOOKS_DIR, file=sys.stderr)
        return 1

    # 词本顺序与元数据以 index.json 为准，保证与前端一致
    with io.open(INDEX_FILE, encoding='utf-8') as f:
        meta = json.load(f)
    books = meta['books']

    index_rows = []      # 全词搜索索引
    catalog_books = []   # 路径目录

    for b in books:
        path = os.path.join(BOOKS_DIR, os.path.basename(b['file']))
        if not os.path.isfile(path):
            print('跳过缺失词本：%s' % path, file=sys.stderr)
            continue
        with io.open(path, encoding='utf-8') as f:
            rows = json.load(f)

        for w in rows:
            index_rows.append({
                'id': w['id'],
                'word': w['word'],
                'ipa': w.get('ipa'),
                'pos': w.get('pos'),
                'zh': w.get('definition_zh'),
                'book': w.get('book') or b['id'],
                'dl': w.get('difficulty_level', b.get('difficulty_level', 2)),
                'tid': w.get('topic_id') or '',
            })

        buckets = bucketize(rows)
        levels = []
        for lv in (1, 2, 3):
            if buckets[lv]:
                levels.append({
                    'level': lv,
                    'label': LEVEL_LABEL[lv],
                    'count': len(buckets[lv]),
                })
        catalog_books.append({
            'id': b['id'],
            'name': b['name'],
            'total': len(rows),
            'levels': levels,
        })
        print('  %-8s %5d 词 → 档位 %s' % (
            b['id'], len(rows), ', '.join('L%d:%d' % (x['level'], x['count']) for x in levels)))

    # 搜索索引按单词字母序排列（前端可做前缀匹配优化）
    index_rows.sort(key=lambda x: x['word'].lower())

    idx_out = {
        'generated_at': datetime.now(timezone.utc).isoformat(),
        'source': meta.get('source'),
        'license': meta.get('license'),
        'total': len(index_rows),
        'words': index_rows,
    }
    with io.open(os.path.join(OUT_DIR, 'search-index.json'), 'w', encoding='utf-8') as f:
        json.dump(idx_out, f, ensure_ascii=False, separators=(',', ':'))

    cat_out = {
        'generated_at': idx_out['generated_at'],
        'source': meta.get('source'),
        'license': meta.get('license'),
        'books': catalog_books,
    }
    with io.open(os.path.join(OUT_DIR, 'catalog.json'), 'w', encoding='utf-8') as f:
        json.dump(cat_out, f, ensure_ascii=False, separators=(',', ':'), indent=0)

    si = os.path.getsize(os.path.join(OUT_DIR, 'search-index.json'))
    ci = os.path.getsize(os.path.join(OUT_DIR, 'catalog.json'))
    print('\n共 %d 词' % len(index_rows))
    print('search-index.json  %.2f MB' % (si / 1024 / 1024))
    print('catalog.json       %.1f KB' % (ci / 1024))
    return 0


if __name__ == '__main__':
    sys.exit(main())
