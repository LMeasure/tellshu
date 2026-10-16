# -*- coding: utf-8 -*-
"""
阶段 1 · 候选 token / 短语挖掘（纯只读）

纪律：候选一律来自 30 本正文，不允许人工凭印象造 token；
      唯一性一律用 content ILIKE 全表实测，不用「看起来应该唯一」。

产出 server/.crawl-cache/_b6-candidates.json：
  books[] -> {
      source_id, title, book_id, has_chapter_chunks,
      proper_tokens[]:  {token, inbook, inbook_chapter, unique(bool), ctx}
      phrases[]:        {phrase, words, inbook, unique(bool), ctx}
      excerpts[]:       {excerpt, words, inbook, unique(bool)}
  }

用法：
  C:/Python314/python.exe -u src/scripts/mine-query-candidates.py \
      [--per-book 26] [--min-count 6] [--phrase-top 14] [--excerpt-top 6]
"""
from __future__ import annotations

import argparse
import json
import random
import re
import sys
from collections import Counter
from pathlib import Path

SERVER_ROOT = Path(__file__).resolve().parents[2]
OUT = SERVER_ROOT / ".crawl-cache" / "_b6-candidates.json"

_TOKEN_RE = re.compile(r"\b[A-Z][A-Za-z'’-]{3,}\b")
_WORD_RE = re.compile(r"[A-Za-z'’-]+")
_SENT_SPLIT = re.compile(r"(?<=[.!?])\s+")

# 常见英文功能词/叙事词，不能当「关键情节词」的锚点
_STOP = {
    "the", "and", "but", "that", "this", "with", "from", "into", "then", "when",
    "they", "them", "their", "there", "here", "what", "which", "who", "whom",
    "have", "has", "had", "been", "were", "was", "will", "would", "could",
    "should", "shall", "must", "more", "most", "much", "many", "some", "such",
    "than", "that", "over", "under", "about", "after", "before", "again",
    "very", "said", "says", "say", "one", "two", "out", "now", "how", "why",
    "you", "your", "she", "her", "him", "his", "its", "our", "all", "any",
    "not", "yes", "yet", "for", "nor", "too", "own", "can", "did", "does",
}


def load_db_url() -> str:
    for line in (SERVER_ROOT / ".env").read_text(encoding="utf-8").splitlines():
        if line.startswith("DATABASE_URL="):
            return line.split("=", 1)[1].strip()
    raise SystemExit("server/.env 里没有 DATABASE_URL")


def book_rows(cur):
    cur.execute(
        "SELECT b.id, b.source_id, b.title, "
        "       count(c.id) FILTER (WHERE c.chapter_title IS NOT NULL) AS with_ch "
        "FROM discovered_books b "
        "LEFT JOIN discovered_book_chunks c ON c.book_id = b.id "
        "GROUP BY b.id, b.source_id, b.title "
        "ORDER BY b.source_id::int"
    )
    return cur.fetchall()


def sample_text(cur, book_id: int, limit: int) -> str:
    """按 chunk_index 均匀抽样，避免只抽到卷首（那里聚集大量一次性人名）。"""
    cur.execute(
        "SELECT count(*) FROM discovered_book_chunks "
        "WHERE book_id=%s AND chapter_title IS NOT NULL AND content IS NOT NULL",
        (book_id,),
    )
    total = int(cur.fetchone()[0] or 0)
    if total == 0:
        return ""
    step = max(1, total // limit)
    cur.execute(
        "SELECT content FROM discovered_book_chunks "
        "WHERE book_id=%s AND chapter_title IS NOT NULL AND content IS NOT NULL "
        "AND (chunk_index %% %s)=0 ORDER BY chunk_index LIMIT %s",
        (book_id, step, limit),
    )
    return "\n".join(r[0] or "" for r in cur.fetchall())


def unique_in_db(cur, needle: str, book_id: int) -> tuple[bool, int, int]:
    """返回 (是否跨书唯一, 目标书 ILIKE 命中块数, 其它书最大命中块数)。"""
    cur.execute(
        "SELECT c.book_id, count(*) FROM discovered_book_chunks c "
        "WHERE c.content ILIKE %s GROUP BY c.book_id",
        ("%" + needle.replace("%", "\\%").replace("_", "\\_") + "%",),
    )
    rows = cur.fetchall()
    mine = 0
    other = 0
    for bid, n in rows:
        if bid == book_id:
            mine = n
        else:
            other = max(other, n)
    return other == 0, mine, other


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--per-book", type=int, default=26, help="每本抽多少个有章节块参与 candidate 提取")
    ap.add_argument("--min-count", type=int, default=6, help="token 在抽样正文里至少出现几次")
    ap.add_argument("--phrase-top", type=int, default=14, help="每本取多少个候选短语送去唯一性实测")
    ap.add_argument("--excerpt-top", type=int, default=6, help="每本取多少个长句片段送去唯一性实测")
    ap.add_argument("--seed", type=int, default=20261012)
    args = ap.parse_args()

    random.seed(args.seed)
    import psycopg2

    conn = psycopg2.connect(load_db_url())
    books_out = []
    with conn.cursor() as cur:
        rows = book_rows(cur)
        print(f"books={len(rows)}  (只读抽样 + ILIKE 实测)", flush=True)
        for bid, sid, title, with_ch in rows:
            book = {
                "book_id": int(bid),
                "source_id": sid,
                "title": title,
                "has_chapter_chunks": int(with_ch or 0),
                "proper_tokens": [],
                "phrases": [],
                "excerpts": [],
            }
            if not with_ch:
                books_out.append(book)
                print(f"  PG{sid:<6} {title[:38]:<38} 抽样=0（无章节块，跳过）")
                continue

            text = sample_text(cur, bid, args.per_book)

            # ---- 1) 专有名词 / 人名 / 地名候选：首字母大写的 token ----
            toks = Counter(t for t in _TOKEN_RE.findall(text))
            cand = [(t, n) for t, n in toks.most_common() if n >= args.min_count]
            # 上下文：第一次出现处的窗口
            def ctx_of(tok: str) -> str:
                m = re.search(r".{0,60}\b" + re.escape(tok) + r"\b.{0,80}", text, re.S)
                return " ".join(m.group(0).split()) if m else ""

            short_tokens = cand[:34]
            for tok, n in short_tokens:
                uniq, mine, other = unique_in_db(cur, tok, bid)
                book["proper_tokens"].append({
                    "token": tok, "sample_count": n, "inbook_chunks": mine,
                    "crossbook_max": other, "unique": uniq, "ctx": ctx_of(tok),
                })

            # ---- 2) 关键情节词候选：2~4 词短语（含实词，无纯功能词） ----
            words = _WORD_RE.findall(text)
            phrases = Counter()
            for i in range(len(words) - 3):
                for size in (2, 3, 4):
                    if i + size > len(words):
                        continue
                    ws = words[i:i + size]
                    lw = [w.lower() for w in ws]
                    if all(w in _STOP or len(w) < 4 for w in lw):
                        continue
                    if lw[0] in _STOP or lw[-1] in _STOP:
                        continue
                    phrases[" ".join(ws)] += 1
            seen_stem = set()
            picked = []
            for ph, n in phrases.most_common(400):
                key = ph.lower()[:28]
                if key in seen_stem:
                    continue
                seen_stem.add(key)
                picked.append((ph, n))
                if len(picked) >= args.phrase_top:
                    break
            for ph, n in picked:
                uniq, mine, other = unique_in_db(cur, ph, bid)
                book["phrases"].append({
                    "phrase": ph, "words": len(ph.split()), "sample_count": n,
                    "inbook_chunks": mine, "crossbook_max": other,
                    "unique": uniq, "ctx": ctx_of(ph),
                })

            # ---- 3) 长文本语义片段：15~30 词的句子 ----
            sents = [s for s in _SENT_SPLIT.split(text) if 12 <= len(s.split()) <= 30]
            random.shuffle(sents)
            for sent in sents[:args.excerpt_top]:
                ex = " ".join(sent.split())
                uniq, mine, other = unique_in_db(cur, ex, bid)
                book["excerpts"].append({
                    "excerpt": ex, "words": len(ex.split()),
                    "inbook_chunks": mine, "crossbook_max": other, "unique": uniq,
                })
                if book["excerpts"] and book["excerpts"][-1]["unique"]:
                    # 已经找到唯一片段就不再往下试，省时间
                    pass

            n_uni_tok = sum(1 for t in book["proper_tokens"] if t["unique"])
            n_uni_ph = sum(1 for p in book["phrases"] if p["unique"])
            n_uni_ex = sum(1 for e in book["excerpts"] if e["unique"])
            print(f"  PG{sid:<6} {title[:38]:<38} 唯一 token={n_uni_tok:<3} 唯一短语={n_uni_ph:<3} 唯一长片段={n_uni_ex}")
            books_out.append(book)

    OUT.write_text(json.dumps(books_out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\nwritten -> {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
