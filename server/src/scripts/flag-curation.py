"""
Stage C · 给指定书打人工治理标记（只写 curation_flags，不改任何原值）

用法：
    python src/scripts/flag-curation.py            # 写入
    python src/scripts/flag-curation.py --dry-run  # 只打印将写入的内容

硬约束：
  - 只 UPDATE curation_flags 一列；
  - 绝不修改 title / author_display / authors / contributors / rights 等任何原值；
  - 写入前后各校验一次原值，若发现被改动立即回滚并报错退出。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import psycopg2

SERVER_ROOT = Path(__file__).resolve().parents[2]

# 需要人工复核的两本（Stage C 批次 A 候选书单中已标注）
FLAGS: dict[str, dict[str, object]] = {
    "2680": {
        "translator_source_unverified": {
            "reason": "本书为 Marcus Aurelius《Meditations》英译本；RDF 未给出译者/译本来源，"
                      "无法确认所用底本与译者。原值一律保留，不做任何推断或替换。",
            "flagged_at": "2026-10-11",
            "needs": "人工确认译者与译本来源后再决定是否补充 contributors",
        }
    },
    "76639": {
        "title_cleanup_pending": {
            "reason": "标题含 MARC 子字段分隔符 \"$b\"（原始值 'Eloisa : $b or, A series of "
                      "original letters'）。这是编目格式残留，但清洗规则尚未确定，故保留原值不动。",
            "flagged_at": "2026-10-11",
            "needs": "确认标题清洗规则后统一处理，不在此阶段自动改写",
        }
    },
}


def load_env() -> dict[str, str]:
    env: dict[str, str] = {}
    for line in (SERVER_ROOT / ".env").read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, _, value = stripped.partition("=")
        env[key.strip()] = value.strip().strip("'\"")
    return env


def main(argv: list[str]) -> int:
    dry_run = "--dry-run" in argv
    env = load_env()
    conn = psycopg2.connect(env["DATABASE_URL"])
    try:
        with conn.cursor() as cur:
            for source_id, flags in FLAGS.items():
                cur.execute(
                    "SELECT id, title, author_display, rights, curation_flags "
                    "FROM discovered_books WHERE source_site='gutenberg.org' AND source_id=%s",
                    (source_id,),
                )
                row = cur.fetchone()
                if row is None:
                    print(f"PG {source_id}: 尚未入库，跳过（先跑 ingest 再执行本脚本）")
                    continue
                book_id, title, author_display, rights, current = row
                print(f"PG {source_id} (book_id={book_id})")
                print(f"  原值 title          = {title!r}")
                print(f"  原值 author_display = {author_display!r}")
                print(f"  现有 curation_flags = {json.dumps(current, ensure_ascii=False) if current else 'null'}")
                merged = dict(current or {})
                merged.update(flags)
                print(f"  将写入              = {json.dumps(flags, ensure_ascii=False)}")
                if dry_run:
                    print("  [dry-run] 未写入")
                    continue
                cur.execute(
                    "UPDATE discovered_books SET curation_flags=%s::jsonb, updated_at=now() "
                    "WHERE id=%s",
                    (json.dumps(merged, ensure_ascii=False), book_id),
                )
                # 立即复核：原值必须一字未动
                cur.execute(
                    "SELECT title, author_display, curation_flags FROM discovered_books WHERE id=%s",
                    (book_id,),
                )
                t2, a2, f2 = cur.fetchone()
                if t2 != title or a2 != author_display:
                    conn.rollback()
                    print("  ❌ 原值被改动，已回滚")
                    return 1
                print(f"  ✅ 已写入，原值未变；复核 curation_flags = {json.dumps(f2, ensure_ascii=False)}")
            if dry_run:
                conn.rollback()
            else:
                conn.commit()
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
