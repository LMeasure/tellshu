"""
design-b6-anchors.py —— Stage B.6 Query 扩展的**锚点挖掘辅助脚本**

只读。用途：从正式表里为每本书挖「跨书唯一」的专有名词候选，
作为新 Query 的「正文锚点」。禁止凭印象填锚点，必须用本脚本的实测计数。

用法：
    cd server
    python src/scripts/design-b6-anchors.py
    python src/scripts/design-b6-anchors.py --min-book-count 3 --top 40
"""

from __future__ import annotations

import argparse
import os
import re
from collections import defaultdict
from pathlib import Path

import psycopg2

# 英文常见词，虽然首字母大写也不算专有名词
STOPWORDS = {
    "The", "This", "That", "These", "Those", "There", "Their", "Then", "They",
    "When", "What", "Where", "Which", "While", "Who", "Whom", "Whose", "Why",
    "How", "But", "For", "And", "Nor", "Yet", "So", "If", "As", "At", "By",
    "In", "Of", "On", "Or", "To", "Up", "Out", "No", "Not", "Now",
    "Chapter", "Volume", "Book", "Part", "Section", "Page", "Note", "Notes",
    "Mr", "Mrs", "Miss", "Sir", "Madam", "Lady", "Lord", "Doctor", "Saint",
    "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
    "January", "February", "March", "April", "May", "June", "July", "August",
    "September", "October", "November", "December",
    "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
    "Yes", "All", "Any", "Each", "Every", "Some", "Most", "More", "Much",
    "After", "Before", "Because", "Since", "Until", "Upon", "Into", "Over",
    "His", "Her", "Its", "Our", "Your", "My", "You", "Your", "We", "Us",
    "It", "He", "She", "I", "Am", "Is", "Are", "Was", "Were", "Be", "Been",
    "Have", "Has", "Had", "Do", "Does", "Did", "Will", "Would", "Shall",
    "Should", "Can", "Could", "May", "Might", "Must", "Ought",
    "Reply", "Letter", "Dear", "Yours", "Sincerely", "Ever", "Ah", "Oh", "Alas",
    "Gutenberg", "Project", "England", "France", "English", "French", "Latin",
    "Preface", "Introduction", "Contents", "Appendix", "Index", "Postscript",
}

TOKEN_RE = re.compile(r"\b[A-Z][a-zA-Z]{3,}\b")


def load_db_url() -> str:
    env = Path(__file__).resolve().parents[2] / ".env"
    for line in env.read_text(encoding="utf-8").splitlines():
        if line.startswith("DATABASE_URL="):
            return line.split("=", 1)[1].strip()
    raise SystemExit("未找到 DATABASE_URL")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-token-count", type=int, default=3,
                    help="token 在该书正文里至少出现几次才算候选")
    ap.add_argument("--top", type=int, default=30, help="每本输出多少候选")
    args = ap.parse_args(argv)

    conn = psycopg2.connect(load_db_url())
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT b.id, b.source_id, b.title, "
                "       count(c.id), count(c.id) FILTER (WHERE c.chapter_title IS NOT NULL) "
                "FROM discovered_books b LEFT JOIN discovered_book_chunks c ON c.book_id = b.id "
                "GROUP BY b.id, b.source_id, b.title ORDER BY b.source_id::int"
            )
            books = cur.fetchall()

        # token -> {book_id: (count, has_chapter_count)}
        per_token: dict[str, dict[int, list[int]]] = defaultdict(lambda: defaultdict(lambda: [0, 0]))
        with conn.cursor() as cur:
            for bid, sid, title, n, nch in books:
                cur.execute(
                    "SELECT content, (chapter_title IS NOT NULL) FROM discovered_book_chunks "
                    "WHERE book_id = %s", (bid,))
                for content, has_ch in cur.fetchall():
                    if not content:
                        continue
                    for tok in TOKEN_RE.findall(content):
                        if tok in STOPWORDS:
                            continue
                        cell = per_token[tok][bid]
                        cell[0] += 1
                        if has_ch:
                            cell[1] += 1
    finally:
        conn.close()

    print(f"候选 token 总数：{len(per_token)}")
    print()
    for bid, sid, title, n, nch in books:
        rows = []
        for tok, books_map in per_token.items():
            if bid not in books_map:
                continue
            cnt, cnt_ch = books_map[bid]
            if cnt < args.min_token_count:
                continue
            other_books = len(books_map) - 1
            # 「是否唯一」：该 token 只在这本书里出现过（other_books == 0）
            rows.append((tok, cnt, cnt_ch, other_books))
        # 唯一优先，其次按书内出现次数
        rows.sort(key=lambda r: (r[3], -r[1]))
        flag = "⛔无章节块" if nch == 0 else ""
        print(f"── PG{sid}  {title[:52]}   chunks={n} with_chapter={nch} {flag}")
        if not rows:
            print("   （无候选）")
        for tok, cnt, cnt_ch, others in rows[:args.top]:
            uniq = "唯一" if others == 0 else f"还出现在 {others} 本书"
            print(f"   {tok:<22} 书内 {cnt:>4} 次（有章节 {cnt_ch:>4}）  {uniq}")
        print()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
