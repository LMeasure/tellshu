# -*- coding: utf-8 -*-
"""
阶段 1 · 构建 discover-query-set-v3.json（47 -> 100）

纪律：
  * 候选 token 一律来自 30 本正文，不允许人工凭印象造 token；
  * 唯一性一律 content ILIKE '%anchor%' 全表实测（rank1 + 其它书 0 命中）；
  * 继承 discover-queries-b5.txt 的 query 文本（一字不改），但锚点必须重新做严格校验；
    原锚点不通过时，自动在「同一批含有该原锚点的 chunk」里找一个严格唯一的替代 token，
    保证新锚点与原查询语义处在同一场景；
  * 已有 Query 文件只读，绝不写回；旧实验数据（_b5-matrix.json 等）只读。

用法：
  C:/Python314/python.exe -u src/scripts/build-query-set-v3.py --propose
  C:/Python314/python.exe -u src/scripts/build-query-set-v3.py --build
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path

SERVER_ROOT = Path(__file__).resolve().parents[2]
CACHE = SERVER_ROOT / ".crawl-cache"
B5_FILE = Path(__file__).parent / "discover-queries-b5.txt"
B6_FILE = Path(__file__).parent / "discover-queries-b6-draft.txt"
PROPOSALS = CACHE / "_b6-reanchor-proposals.json"
OUT_JSON = SERVER_ROOT.parent / "discover-query-set-v3.json"
OUT_MD = SERVER_ROOT.parent / "discover-query-validation-report.md"

TOKEN_RE = re.compile(r"\b[A-Z][A-Za-z'’-]{3,}\b")

STOP_EN = frozenset("""
the and but that this with from into then when they them their there here what which who
whom have has had been were was will would could should shall must more most much many some
such than over under about after before again very said says say one two out now how why you
your she her him his its our all any not yes yet for nor too own can did does CHAPTER chapter
""".split())


# ------------------------------------------------------------------ 数据加载
def load_rows(path: Path) -> list[tuple[str, str, str, str]]:
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        parts = line.rstrip("\n").split("\t")
        if len(parts) < 4:
            continue
        rows.append((parts[0], parts[1], parts[2], parts[3]))
    return rows


def load_db_url() -> str:
    for line in (SERVER_ROOT / ".env").read_text(encoding="utf-8").splitlines():
        if line.startswith("DATABASE_URL="):
            return line.split("=", 1)[1].strip()
    raise SystemExit("server/.env 缺少 DATABASE_URL")


def like(needle: str) -> str:
    return "%" + needle.replace("%", "\\%").replace("_", "\\_") + "%"


# ------------------------------------------------------------------ 书名解析
def resolve_book(cur, expected: str) -> dict | None:
    cur.execute(
        "SELECT b.id, b.source_id, b.title, b.author_display, "
        "       count(c.id) FILTER (WHERE c.chapter_title IS NOT NULL) AS with_ch, "
        "       count(c.id) AS total "
        "FROM discovered_books b LEFT JOIN discovered_book_chunks c ON c.book_id=b.id "
        "GROUP BY b.id,b.source_id,b.title,b.author_display"
    )
    books = cur.fetchall()
    exp = expected.strip().lower()
    # 1) 原名相等
    for r in books:
        if r[2].strip().lower() == exp:
            return _pack(r)
    # 2) 前缀包含（'Moby Dick' -> 'Moby Dick; Or, The Whale'）
    cands = [r for r in books if exp in r[2].lower()]
    if len(cands) == 1:
        return _pack(cands[0])
    if cands:
        # 3) 取标题最短的那个（去掉副标题的原始书名）
        return _pack(sorted(cands, key=lambda r: len(r[2]))[0])
    return None


def _pack(r) -> dict:
    return {"book_id": str(r[0]), "source_id": r[1], "title": r[2],
            "author": r[3], "with_ch": int(r[4] or 0), "total": int(r[5] or 0)}


# ------------------------------------------------------------------ 锚点校验
def anchor_stats(cur, anchor: str, book_id: str) -> dict:
    cur.execute(
        "SELECT c.book_id, count(*), count(*) FILTER (WHERE c.chapter_title IS NOT NULL) "
        "FROM discovered_book_chunks c WHERE c.content ILIKE %s GROUP BY c.book_id "
        "ORDER BY 2 DESC",
        (like(anchor),),
    )
    rows = cur.fetchall()
    mine_n = mine_ch = 0
    others = []
    for bid, n, nch in rows:
        if str(bid) == book_id:
            mine_n, mine_ch = int(n), int(nch)
        else:
            others.append({"book_id": str(bid), "chunks": int(n)})
    cross = sum(o["chunks"] for o in others)
    # 目标书是否 ILIKE 命中第一（按命中块数排序）
    rank_first = True
    if rows:
        top_bid, top_n = rows[0][0], rows[0][1]
        rank_first = (str(top_bid) == book_id)
    return {"inbook_chunks": mine_n, "inbook_chapter_chunks": mine_ch,
            "crossbook_books": others, "crossbook_chunks": cross,
            "rank_first": rank_first, "total_chunks": sum(int(r[1]) for r in rows)}


# ------------------------------------------------------------------ 语义片段/情节词锚点


def scope_chunks(cur, book_id: str, anchor: str, limit: int = 400) -> str:
    """取「含有指定锚点」的那批 chunk —— 保证新锚点与原查询处在同一个场景。"""
    cur.execute(
        "SELECT content FROM discovered_book_chunks "
        "WHERE book_id=%s AND content ILIKE %s AND content IS NOT NULL LIMIT %s",
        (book_id, like(anchor), limit),
    )
    return "\n".join(r[0] or "" for r in cur.fetchall())


def _clean_words(ws: list[str]) -> bool:
    """短语质量闸门：必须是干净的实词组合，不要断句残片。"""
    for w in ws:
        if not re.fullmatch(r"[A-Za-z'’-]{4,}", w):
            return False
        if "’" in w or "'" in w:
            # 允许 Porfiry Petrovitch 这类人名，但要排除被截断的属格残片
            if not w[0].isupper():
                return False
    return True


def pick_phrase(cur, book_id: str, scope: str, exclude: set[str],
                min_ch: int = 2, tries: int = 40) -> dict | None:
    """关键情节词：2 词短语，严格跨书唯一，且必须是「干净实词组合」。

    质量优先于数量：先在场景里收集若干合格候选，再按
        ① 首字母大写的词越多越好（专名/人名组合更可能是真实情节词）
        ② 命中块数越多越好
    排序取第一名，避免拿到 "formally dismissed"、"visible beyond" 这类通用残片。
    """
    words = [w for w in re.findall(r"[A-Za-z'’-]+", scope)]
    seen: set[str] = set()
    best: tuple[int, int, str, dict] | None = None
    for i in range(len(words) - 1):
        ws = words[i:i + 2]
        lw = [w.lower() for w in ws]
        if any(w in STOP_EN for w in lw):
            continue
        if lw[0] in STOP_EN or lw[-1] in STOP_EN:
            continue
        if not _clean_words(ws):
            continue
        ph = " ".join(ws)
        key = ph.lower()
        if key in seen or key in exclude:
            continue
        seen.add(key)
        st = anchor_stats(cur, ph, book_id)
        if (st["crossbook_chunks"] == 0 and st["rank_first"]
                and st["inbook_chapter_chunks"] >= min_ch):
            score = (sum(1 for w in ws if w[:1].isupper()), st["inbook_chunks"])
            if best is None or score > best[:2]:
                best = (score[0], score[1], ph, st)
        if len(seen) >= tries:
            break
    return {"token": best[2], **best[3]} if best else None


def pick_excerpt(cur, book_id: str, scope: str, exclude: set[str],
                 min_words: int = 10, max_words: int = 40) -> dict | None:
    """长文本语义片段：整句摘录（10~40 词），严格跨书唯一（整句几乎必然唯一）。"""
    sents = re.split(r"(?<=[.!?])\s+", scope)
    tried = 0
    for sent in sents:
        ex = " ".join(sent.split()).strip("\"“”‘’ ")
        if not (min_words <= len(ex.split()) <= max_words):
            continue
        if not ex[:1].isupper():
            continue
        if ex.lower() in exclude:
            continue
        st = anchor_stats(cur, ex, book_id)
        tried += 1
        if (st["crossbook_chunks"] == 0 and st["rank_first"]
                and st["inbook_chapter_chunks"] >= 1):
            return {"token": ex, **st}
        if tried >= 40:
            break
    return None


def repair_anchor(cur, book_id: str, old_anchor: str, min_ch: int = 2,
                  exclude: set[str] | None = None,
                  min_freq: int = 2) -> dict | None:
    """
    在「含有 old_anchor 的同一批 chunk」里找严格唯一的替代 token，保证新锚点与原查询同场景。

    候选处理：
      * 属格 's / ’s 先剥离再试；剥离后不唯一时，允许用带属格的原文形式
        （例：Syme 有跨书命中，但 Syme’s 是严格唯一的）
      * 要求锚点在「有章节块」的 chunk 里至少出现 min_ch 次 —— 这样它落在
        检索真的够得着的区域，否则这条 query 的 ground truth 可能是不可召回的 front matter
      * exclude：全局已用掉的锚点。同一本书的多条 query 若共用同一个锚点，
        等于把 N 条证据退化成 1 条，因此优先换一个互斥的 token
      * 词边界扫描不到合格的 token 时，退回 2~4 词短语（要求含至少一个大写起头的词）
    """
    exclude = {e.lower() for e in (exclude or set())}
    if old_anchor and old_anchor != "-":
        exclude.discard(old_anchor.lower())
    scope = ""
    if old_anchor and old_anchor != "-":
        cur.execute(
            "SELECT content FROM discovered_book_chunks "
            "WHERE book_id=%s AND content ILIKE %s LIMIT 600",
            (book_id, like(old_anchor)),
        )
        scope = "\n".join(r[0] or "" for r in cur.fetchall())
    if not scope.strip():
        cur.execute(
            "SELECT count(*) FROM discovered_book_chunks "
            "WHERE book_id=%s AND content IS NOT NULL", (book_id,)
        )
        total = int(cur.fetchone()[0] or 0)
        step = max(1, total // 240) if total else 1
        cur.execute(
            "SELECT content FROM discovered_book_chunks "
            "WHERE book_id=%s AND content IS NOT NULL AND (chunk_index %% %s)=0 "
            "ORDER BY chunk_index LIMIT 240",
            (book_id, step),
        )
        scope = "\n".join(r[0] or "" for r in cur.fetchall())
    if not scope.strip():
        return None

    counts: dict[str, int] = {}
    for tok in TOKEN_RE.findall(scope):
        counts[tok] = counts.get(tok, 0) + 1
    # 按「剥离属格后的规范词」聚合计数，并记住一个可回溯的原文形式
    merged: dict[str, list[tuple[str, int]]] = {}
    for tok, n in counts.items():
        if n < min_freq:
            continue
        plain = re.sub(r"[’']s$", "", tok)
        merged.setdefault(plain, []).append((tok, n))
    ranked = sorted(merged.items(), key=lambda kv: -sum(n for _, n in kv[1]))

    def try_token(candidate: str) -> dict | None:
        if candidate.lower() in exclude:
            return None
        st = anchor_stats(cur, candidate, book_id)
        if (st["crossbook_chunks"] == 0 and st["rank_first"]
                and st["inbook_chunks"] > 0
                and st["inbook_chapter_chunks"] >= min_ch):
            return {"token": candidate, **st}
        return None

    for plain, variants in ranked[:80]:
        if old_anchor and plain.lower() == old_anchor.lower():
            continue
        hit = try_token(plain)
        if hit:
            return hit
        if len(variants) == 1 and variants[0][0] != plain:
            hit = try_token(variants[0][0])
            if hit:
                return hit

    # 退回：2~4 词短语（必须含至少一个大写起头的词，否则几乎不可能跨书唯一）
    words = re.findall(r"[A-Za-z'’-]+", scope)
    seen: set[str] = set()
    phrases: list[str] = []
    for i in range(len(words) - 3):
        for size in (2, 3, 4):
            ws = words[i:i + size]
            if len(ws) < size:
                continue
            if not any(w[:1].isupper() for w in ws):
                continue
            lw = [w.lower() for w in ws]
            if lw[0] in STOP_EN or lw[-1] in STOP_EN:
                continue
            ph = " ".join(ws)
            key = ph.lower()
            if key in seen:
                continue
            seen.add(key)
            phrases.append(ph)
            if len(phrases) >= 300:
                break
        if len(phrases) >= 300:
            break
    for ph in phrases[:60]:
        hit = try_token(ph)
        if hit:
            return hit
    return None


# ------------------------------------------------------------------ propose
def cmd_propose(args) -> int:
    import psycopg2

    rows5 = load_rows(B5_FILE)
    rows6 = load_rows(B6_FILE)
    print(f"继承 B.5 = {len(rows5)} 条；B.6 新增草稿 = {len(rows6)} 条", flush=True)

    conn = psycopg2.connect(load_db_url())
    out = {"inherited": [], "new": [], "diagnostics": []}
    used: set[str] = set()
    with conn.cursor() as cur:
        def handle(rows, bucket):
            for query, expected, category, anchor in rows:
                book = resolve_book(cur, expected)
                item = {"query": query, "expected": expected,
                        "origin_category": category, "original_anchor": anchor}
                if book is None:
                    item["resolve_error"] = f"书名无法解析: {expected}"
                    bucket.append(item)
                    print(f"  !! 书名解析失败: {expected}")
                    continue
                item.update(book)
                if anchor and anchor != "-":
                    st = anchor_stats(cur, anchor, book["book_id"])
                    item["original_anchor_stats"] = st
                    item["original_anchor_ok"] = bool(
                        st["crossbook_chunks"] == 0 and st["rank_first"] and st["inbook_chunks"] > 0
                    )
                    item["final_anchor"] = anchor
                    item["final_anchor_stats"] = st
                    item["repair"] = False
                else:
                    item["original_anchor_ok"] = False
                    item["no_anchor"] = True
                    item["final_anchor"] = None

                need_repair = (not item.get("original_anchor_ok"))
                if not need_repair:
                    need_repair = item["final_anchor"].lower() in used
                    if need_repair:
                        item["dedup"] = True
                if need_repair:
                    rep = repair_anchor(cur, book["book_id"], anchor, exclude=used)
                    if rep:
                        item["final_anchor"] = rep["token"]
                        item["final_anchor_stats"] = anchor_stats(cur, rep["token"], book["book_id"])
                        item["repair"] = True
                        item["repair_from"] = (
                            f"原锚点 {anchor} 有跨书命中" if anchor not in ("", "-")
                            else ("原锚点与其它 query 重复" if item.get("dedup") else "无原锚点")
                        )
                    else:
                        item["repair_failed"] = True
                if item.get("final_anchor"):
                    used.add(item["final_anchor"].lower())
                elif item.get("final_anchor") is None:
                    item["repair_failed"] = True
                bucket.append(item)

        diag = [r for r in rows5 if r[2] in ("probe", "control")]
        inherited_main = [r for r in rows5 if r[2] not in ("probe", "control")]
        handle(inherited_main, out["inherited"])
        handle(rows6, out["new"])
        for q, e, c, a in diag:
            out["diagnostics"].append({"query": q, "expected": e, "origin_category": c,
                                       "original_anchor": a, "counted": False})

    n_rep = sum(1 for b in out["inherited"] + out["new"] if b.get("repair"))
    n_fail = sum(1 for b in out["inherited"] + out["new"] if b.get("repair_failed"))
    print(f"\n已修复锚点 = {n_rep}，修复失败 = {n_fail}")
    PROPOSALS.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"written -> {PROPOSALS}")
    return 0


# ------------------------------------------------------------------ 锚点改型（补齐五类里的后两类）
# 关键情节词：挑 12 条「不同书」的短场景查询，把验证锚点从人名换成同一场景里的 2~4 词短语
PHRASE_RETYPE_BOOKS = {"2554", "3268", "2465", "1513", "72", "345",
                       "601", "2868", "3296", "21839", "67979", "75201"}
# 长文本语义片段：查询本身足够长（中文 >= 40 字，或英文 >= 25 词）就改用整句摘录做锚点
LONG_CN = 40
LONG_EN_WORDS = 25


def is_long_query(q: str) -> bool:
    cn = len(re.findall(r"[\u4e00-\u9fff]", q))
    en = len(re.findall(r"[A-Za-z]+", q))
    return cn >= LONG_CN or en >= LONG_EN_WORDS


def cmd_retype(args) -> int:
    """把部分查询的验证锚点改成「关键情节词 / 长文本语义片段」，让五类都有真实样本。"""
    import psycopg2

    data = json.loads(PROPOSALS.read_text(encoding="utf-8"))
    buckets = [("inherited", data["inherited"]), ("new", data["new"])]
    used = {it.get("final_anchor", "").lower() for _, b in buckets for it in b
            if it.get("final_anchor")}
    conn = psycopg2.connect(load_db_url())
    n_ph = n_ex = 0
    pending_books = set(PHRASE_RETYPE_BOOKS)
    with conn.cursor() as cur:
        for _, bucket in buckets:
            for it in bucket:
                if it.get("with_ch", 0) == 0 or not it.get("final_anchor"):
                    continue  # 这些行本就不计入分母，不必再费功夫
                current = it["final_anchor"]
                long_row = is_long_query(it["query"])
                # 关键情节词：每本目标书**只改一条**，改过就退出候选集
                want_phrase = False
                if (not long_row) and it.get("source_id") in pending_books:
                    want_phrase = True
                    pending_books.discard(it["source_id"])
                if not (long_row or want_phrase):
                    continue
                scope = scope_chunks(cur, it["book_id"], current)
                if not scope.strip():
                    print(f"  !! 无可用场景：PG{it['source_id']} {current}")
                    continue
                hit = (pick_excerpt(cur, it["book_id"], scope, {u.lower() for u in used})
                       if long_row
                       else pick_phrase(cur, it["book_id"], scope, {u.lower() for u in used}))
                if not hit:
                    print(f"  !! 改型失败：PG{it['source_id']} {current} -> "
                          f"{'excerpt' if long_row else 'phrase'}")
                    continue
                used.discard(current.lower())
                it["prev_anchor"] = current
                it["final_anchor"] = hit["token"]
                it["final_anchor_stats"] = anchor_stats(cur, hit["token"], it["book_id"])
                it["retype"] = "excerpt" if long_row else "phrase"
                used.add(hit["token"].lower())
                if long_row:
                    n_ex += 1
                else:
                    n_ph += 1
                print(f"  PG{it['source_id']:<6} {current[:22]:<22} -> "
                      f"{hit['token'][:46]:<46} ({it['retype']})")
    PROPOSALS.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n改型完成：关键情节词 {n_ph} 条，长文本语义片段 {n_ex} 条")
    return 0


ANCHOR_CLASS: dict[str, str] = {
    # 人物名
    "Raskolnikov": "人物名", "Sonia": "人物名", "Wickham": "人物名", "BENVOLIO": "人物名",
    "Brocklehurst": "人物名", "Sweeney": "人物名", "Freddy": "人物名", "MERCUTIO": "人物名",
    "Carmen": "人物名", "Ratcliffe": "人物名", "Antoinetta": "人物名", "Marmeladov": "人物名",
    "BALTHASAR": "人物名", "Hyde": "人物名", "Thuvia": "人物名", "Dorothea": "人物名",
    "Lydgate": "人物名", "Dracula": "人物名", "Renfield": "人物名", "Manon": "人物名",
    "Ambrosio": "人物名", "Starbuck": "人物名", "Queequeg": "人物名", "Braddock": "人物名",
    "Alypius": "人物名", "Victorinus": "人物名", "Arsène": "人物名", "Ganimard": "人物名",
    "Marianne": "人物名", "Brandon": "人物名", "Imlay": "人物名", "Valancy": "人物名",
    "Barney": "人物名", "Fergy": "人物名", "Bonello": "人物名", "Wolmar": "人物名",
    "Hosmer": "人物名", "Jasper": "人物名", "Drood": "人物名", "Bulstrode": "人物名",
    "Helsing": "人物名", "Seward": "人物名", "Lestrade": "人物名", "Norton": "人物名",
    "Porfiry": "人物名", "Dounia": "人物名", "Montoni": "人物名", "Valancourt": "人物名",
    "Durdles": "人物名", "Ferrars": "人物名", "Carthoris": "人物名", "Elizondo": "人物名",
    "Telemachus": "人物名", "Emily": "人物名", "Preux": "人物名", "Odysseus": "人物名",
    "Stickles": "人物名", "Barkley": "人物名", "Meillerie": "人物名", "Celia": "人物名",
    "Datchery": "人物名", "Renard": "人物名", "Rosaline": "人物名", "Antonia": "人物名",
    "Elvira": "人物名", "Emerson": "人物名", "Vyse": "人物名",
    "Jasher": "人物名", "Nebridius": "人物名",
    "Baudru": "人物名", "Dreux-Soubise": "人物名", "Jose-Maria": "人物名",
    "Garcia": "人物名", "Penelope": "人物名",
    "Caxas": "专有名词", "Manichees": "专有名词", "Baedeker": "专有名词",
    "Gryphon": "专有名词", "Yojo": "专有名词", "Moby": "专有名词",
    "Eloisa": "专有名词", "Rabbit-Hole": "关键情节词", "Etange": "地点名",
    # 地点名
    "Lowood": "地点名", "Thornfield": "地点名", "Ithaca": "地点名", "Pemberley": "地点名",
    "Longbourn": "地点名", "Udolpho": "地点名", "Barsoom": "地点名", "Ptarth": "地点名",
    "Netherfield": "地点名", "Derbyshire": "地点名", "Millcote": "地点名", "Lowick": "地点名",
    "Pierside": "地点名", "Deerwood": "地点名", "Norland": "地点名", "Boscombe": "地点名",
    "Montreux": "地点名", "Clarens": "地点名",
    # 专有名词
    "GREEN MUMMY": "专有名词",
}


def classify(anchor: str | None, warn) -> str:
    if not anchor:
        return "（无锚点）"
    if anchor in ANCHOR_CLASS:
        return ANCHOR_CLASS[anchor]
    words = anchor.split()
    if len(words) >= 8:
        return "长文本语义片段"
    if len(words) >= 2:
        return "关键情节词"
    warn(f"  ⚠ 未见显式分类的单 token 锚点（默认归入 人物名，需人工复核）：{anchor}")
    return "人物名"


CATEGORY_ORDER = ["人物名", "地点名", "专有名词", "关键情节词", "长文本语义片段"]


def cmd_build(args) -> int:
    """把 proposals 固化为 discover-query-set-v3.json + 校验报告（只读，不改任何实验数据）。"""
    import psycopg2

    data = json.loads(PROPOSALS.read_text(encoding="utf-8"))
    rows = [("继承 B.5", it) for it in data["inherited"]] + [("B.6 新增", it) for it in data["new"]]

    def _warn(msg: str) -> None:
        print(msg)

    conn = psycopg2.connect(load_db_url())
    out_rows: list[dict] = []
    warnings: list[str] = []
    with conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM discovered_books")
        books = cur.fetchone()[0]
        cur.execute("SELECT count(*), count(embedding), sum(content_chars) FROM discovered_book_chunks")
        n_rows, n_emb, n_chars = cur.fetchone()
        cur.execute("SELECT md5(string_agg(chunk_index||':'||content_chars||':'||"
                    "coalesce(chapter_title,'<null>'),'|' order by id)) FROM discovered_book_chunks")
        fp_global = cur.fetchone()[0]

        for i, (origin, it) in enumerate(rows, 1):
            anchor = it.get("final_anchor")
            st = it.get("final_anchor_stats") or {}
            counted = it.get("with_ch", 0) > 0
            ver = ("content ILIKE '%" + (anchor or "") + "%' 全表实测"
                   if anchor else "无可用锚点（目标书无可召回章节块，本行不计入分母）")
            if anchor:
                ver += (f"：目标书命中 {st.get('inbook_chunks', 0)} 块"
                        f"（其中有章节块 {st.get('inbook_chapter_chunks', 0)}）、"
                        f"跨书命中 {st.get('crossbook_chunks', 0)} 块、目标书排名第一="
                        f"{st.get('rank_first')}")
                if it.get("repair"):
                    ver += "；原锚点未通过严格校验，已自动换为同场景内的严格唯一 token"
                if it.get("retype"):
                    ver += f"；已改型为 {'整句摘录' if it['retype']=='excerpt' else '多词短语'}"
            cat = classify(anchor, lambda m: warnings.append(m))
            out_rows.append({
                "query_id": f"Q{i:03d}",
                "query": it["query"],
                "book_id": it.get("book_id"),
                "source_id": it.get("source_id"),
                "expected_book": it.get("title") or it.get("expected"),
                "expected_book_short": it.get("expected"),
                "origin": origin,
                "anchor": anchor,
                "category": cat,
                "candidate_count": st.get("inbook_chunks", 0),
                "candidate_count_chaptered": st.get("inbook_chapter_chunks", 0),
                "cross_book_count": st.get("crossbook_chunks", 0),
                "verification_method": ver,
                "counted": counted,
                "blocked_when_filtered": not counted,
                "original_anchor": it.get("original_anchor"),
                "anchor_repaired": bool(it.get("repair")),
                "anchor_retyped": it.get("retype"),
            })

    diagnostics = [{"query_id": f"D{i:03d}", "query": d["query"], "category": d["origin_category"],
                    "counted": False, "verification_method": "探针/负对照，不参与命中率统计"}
                   for i, d in enumerate(data["diagnostics"], 1)]

    by_cat: dict[str, int] = {}
    by_origin: dict[str, int] = {}
    by_book: dict[str, int] = {}
    for r in out_rows:
        if not r["counted"]:
            continue
        by_cat[r["category"]] = by_cat.get(r["category"], 0) + 1
        by_origin[r["origin"]] = by_origin.get(r["origin"], 0) + 1
        by_book[r["expected_book_short"]] = by_book.get(r["expected_book_short"], 0) + 1

    payload = {
        "meta": {
            "version": "v3",
            "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "builder": "src/scripts/build-query-set-v3.py",
            "principle": [
                "候选 token 全部来自 30 本正文 content 字段，无一条人工杜撰",
                "跨书唯一性一律 content ILIKE 全表实测，不以词频直觉或视觉判断代替",
                "已有 Query 文件只读不写回；旧实验数据（_b5-matrix.json 等）不覆盖",
            ],
            "inherited_from": "src/scripts/discover-queries-b5.txt（原文逐字继承，仅替换/修复验证锚点）",
            "new_from": "src/scripts/discover-queries-b6-draft.txt（Stage B.6 Query 扩展方案附录）",
            "frozen_baseline": {
                "books": int(books), "chunks": int(n_rows), "embeddings": int(n_emb),
                "content_chars": int(n_chars or 0), "global_md5": fp_global,
            },
            "counting_rule": {
                "counted": "目标书至少有一个 chapter_title 非空的 chunk（过滤口径下物理可召回）",
                "excluded": "目标书零章节块 —— 与 Stage B.5 口径一致，不计入命中率分母",
            },
        },
        "summary": {
            "rows_total": len(out_rows),
            "counted": sum(1 for r in out_rows if r["counted"]),
            "excluded": sum(1 for r in out_rows if not r["counted"]),
            "diagnostics": len(diagnostics),
            "by_category": {c: by_cat.get(c, 0) for c in CATEGORY_ORDER},
            "by_origin": by_origin,
            "by_book": by_book,
            "anchors_repaired": sum(1 for r in out_rows if r["anchor_repaired"]),
            "anchors_retyped": sum(1 for r in out_rows if r["anchor_retyped"]),
            "cross_book_pollution": sum(1 for r in out_rows if r["cross_book_count"] > 0),
        },
        "queries": out_rows,
        "diagnostics": diagnostics,
    }
    OUT_JSON.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"written -> {OUT_JSON}")
    for w in warnings:
        print(w)
    return 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--propose", action="store_true")
    ap.add_argument("--build", action="store_true")
    ap.add_argument("--retype", action="store_true")
    ns = ap.parse_args()
    if ns.propose:
        sys.exit(cmd_propose(ns))
    if ns.retype:
        sys.exit(cmd_retype(ns))
    if ns.build:
        sys.exit(cmd_build(ns))
    print("需要 --propose 或 --build")
    sys.exit(2)
