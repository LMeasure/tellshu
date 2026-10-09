#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
述树 · OpenEtymology 内容层接入管线
=================================================================
解析 OpenEtymology 五个词本（CET4/CET6/TEM8/TOEFL/GRE8000）的 EPUB，
抽取真实字段，映射为述树 ContentWord 形状。

【分片输出，加速首屏】
  不再产出单个 19MB 的 words.json，而是按词本分片：
    public/data/linguabase/index.json        # 极小（~1KB）：词本清单 + 每本路径/词数
    public/data/linguabase/books/CET4.json   # 单本 ~2-8MB，按需懒加载
    ... books/CET6.json / TEM8.json / TOEFL.json / GRE8000.json
  前端首屏只 fetch index.json（~1KB），进入某词本时再按需加载对应 books/<id>.json。
  旧的 words.json 会在产出后自动删除。

为什么用 EPUB 而非 .txt：
  .txt 只是纯单词列表（无词源/中文/例句）；EPUB 是从官方词库生成的富文本，
  每个词条目自带：IPA 音标、中文释义(带词性)、词根词缀、词源段落、双语例句。
  这正好补齐 Linguabase 缺失的中文/音标/例句/词源，且是**真实授权数据**
  （词本文件 CC BY-SA 4.0，须署名 OpenEtymology）。

真实字段 → 输出映射：
  h2                         -> word
  p.pronunciation 的 /.../   -> ipa (UK 音标，真实)
  ol.definitions li          -> definition_zh (合并词性+中文) + pos
  ul.morphemes li            -> morphemes[{form,meaning,note}] + root(首词素)
  section Etymology p        -> etymology (词源，真实中文段落)
  ol.examples li             -> examples[{en,zh}] + example_en/example_zh(首条)
  wordbook                   -> difficulty_level / topic_id / book
    CET4 -> L2(基础词汇级)；CET6/TEM8/TOEFL/GRE8000 -> L3(进阶)

可选增强（--linguabase-data-dir）：对同时出现在 Linguabase core 的词，
补入 frequency_rank(core_rank) 与 related/antonyms/relatives 关系网络。

原则：只输出真实抽取字段，不编造任何词/释义/音频。
"""

import argparse
import json
import os
import re
import zipfile
from datetime import datetime, timezone

from bs4 import BeautifulSoup

# 词本顺序即教学梯度；CET4 为基础，其余为进阶。
BOOK_ORDER = ["CET4", "CET6", "TEM8", "TOEFL", "GRE8000"]
BOOK_DIFFICULTY = {
    "CET4": 2,   # 基础词汇级
    "CET6": 3,   # 进阶
    "TEM8": 3,
    "TOEFL": 3,
    "GRE8000": 3,
}
BOOK_NAMES = {
    "CET4": "CET-4 四级",
    "CET6": "CET-6 六级",
    "TEM8": "TEM-8 专八",
    "TOEFL": "TOEFL 托福",
    "GRE8000": "GRE 8000词",
}

_IPA_RE = re.compile(r"/([^/]+)/")


def parse_entry(section) -> dict | None:
    """解析一个 <section class="word-entry">，返回结构化字段或 None。"""
    h2 = section.find("h2")
    if not h2:
        return None
    word = h2.get_text(strip=True)
    if not word:
        return None

    # 音标（取首个 /.../）
    ipa = None
    pron = section.find("p", class_="pronunciation")
    if pron:
        m = _IPA_RE.search(pron.get_text())
        if m:
            ipa = m.group(1)

    # 中文释义（带词性）
    definitions = []
    defs_sec = section.find("h3", string="Definitions")
    if defs_sec:
        ol = defs_sec.find_next_sibling("ol", class_="definitions")
        if ol:
            for li in ol.find_all("li", recursive=False):
                pos = li.find("strong")
                pos_txt = pos.get_text(strip=True) if pos else ""
                rest = li.get_text(" ", strip=True)
                zh = rest[len(pos_txt):].strip() if pos_txt and rest.startswith(pos_txt) else rest
                definitions.append({"pos": pos_txt, "zh": zh})

    # 词根词缀
    morphemes = []
    morph_sec = section.find("h3", string="Morphemes")
    if morph_sec:
        ul = morph_sec.find_next_sibling("ul", class_="morphemes")
        if ul:
            for li in ul.find_all("li", recursive=False):
                strong = li.find("strong")
                form = strong.get_text(strip=True) if strong else ""
                note_tag = li.find("span", class_="note")
                note = note_tag.get_text(strip=True) if note_tag else None
                full = li.get_text(" ", strip=True)
                meaning = full
                if form and full.startswith(form):
                    meaning = full[len(form):].strip()
                if note and meaning.endswith(note):
                    meaning = meaning[: -len(note)].strip()
                morphemes.append({"form": form, "meaning": meaning, "note": note})

    # 词源
    etymology = None
    ety_sec = section.find("h3", string="Etymology")
    if ety_sec:
        p = ety_sec.find_next_sibling("p")
        if p:
            etymology = p.get_text(" ", strip=True)

    # 双语例句
    examples = []
    ex_sec = section.find("h3", string="Examples")
    if ex_sec:
        ol = ex_sec.find_next_sibling("ol", class_="examples")
        if ol:
            for li in ol.find_all("li", recursive=False):
                en = li.find("p", class_="example-en")
                zh = li.find("p", class_="example-zh")
                examples.append({
                    "en": en.get_text(strip=True) if en else "",
                    "zh": zh.get_text(strip=True) if zh else "",
                })

    return {
        "word": word,
        "ipa": ipa,
        "definitions": definitions,
        "morphemes": morphemes,
        "etymology": etymology,
        "examples": examples,
    }


def parse_book_epub(epub_path: str, book: str) -> list[dict]:
    """解析单个词本 EPUB，返回按出现顺序排列的词条目列表。"""
    entries = []
    with zipfile.ZipFile(epub_path) as z:
        names = [n for n in z.namelist() if re.search(r"text/[^/]+\.xhtml?$", n)]
        # 按章节号排序，保证稳定顺序
        def chap_key(n):
            m = re.search(r"chapter-(\d+)", n)
            return int(m.group(1)) if m else 999999
        names.sort(key=chap_key)
        for n in names:
            data = z.read(n).decode("utf-8", errors="replace")
            soup = BeautifulSoup(data, "html.parser")
            for sec in soup.find_all("section", class_="word-entry"):
                e = parse_entry(sec)
                if e:
                    e["book"] = book
                    entries.append(e)
    return entries


def load_linguabase_augment(data_dir: str) -> dict:
    """读取 Linguabase core parquet，返回 {word_lower: {rank, related, antonyms, relatives}}。"""
    import pyarrow.parquet as pq

    def read_cols(path, key, val_cols):
        tbl = pq.read_table(path, columns=[key] + val_cols)
        ks = tbl.column(key).to_pylist()
        vs = [tbl.column(c).to_pylist() for c in val_cols]
        return {ks[i]: [v[i] for v in vs] for i in range(len(ks))}

    aug = {}
    vocab_path = os.path.join(data_dir, "vocabulary.core.parquet")
    if not os.path.isfile(vocab_path):
        return aug
    vocab = read_cols(vocab_path, "word", ["core_rank"])
    core_set = set(vocab.keys())

    assoc = read_cols(os.path.join(data_dir, "associations.core.parquet"), "word", ["associates"]) if os.path.isfile(os.path.join(data_dir, "associations.core.parquet")) else {}
    ant = read_cols(os.path.join(data_dir, "antonyms.core.parquet"), "word", ["opposites"]) if os.path.isfile(os.path.join(data_dir, "antonyms.core.parquet")) else {}
    fam = read_cols(os.path.join(data_dir, "word_families.core.parquet"), "word", ["relatives"]) if os.path.isfile(os.path.join(data_dir, "word_families.core.parquet")) else {}

    def parse_ant(opps):
        out = []
        for tok in (opps or []):
            if not isinstance(tok, str) or ":" not in tok:
                continue
            term, _, r = tok.rpartition(":")
            try:
                out.append((term.strip(), int(r)))
            except ValueError:
                continue
        return out

    for w, v in vocab.items():
        wl = w.lower()
        related = [a for a in (assoc.get(w) or []) if a in core_set][:8] if assoc else []
        antonyms = sorted(
            ({"term": t, "rating": r} for t, r in parse_ant(ant.get(w) or []) if r >= 6),
            key=lambda x: -x["rating"],
        )[:6] if ant else []
        relatives = [r for r in (fam.get(w) or []) if r in core_set][:8] if fam else []
        aug[wl] = {
            "frequency_rank": v[0],
            "related": related or None,
            "antonyms": antonyms or None,
            "relatives": relatives or None,
        }
    return aug


def build_obj(e: dict, aug_entry: dict | None, rank: int) -> dict:
    """把解析后的单条 EPUB 字段组装为述树 ContentWord 对象。"""
    book = e["book"]
    definitions = e["definitions"]
    definition_zh = "；".join(
        f"{d['pos']} {d['zh']}" if d["pos"] else d["zh"] for d in definitions
    ) if definitions else None
    pos = definitions[0]["pos"] if definitions else None
    examples = e["examples"]
    first_ex = examples[0] if examples else None

    a = aug_entry
    difficulty = BOOK_DIFFICULTY.get(book, 3)
    frequency_rank = a["frequency_rank"] if a else rank

    return {
        "id": f"oe-{e['word'].lower()}",
        "word": e["word"],
        "ipa": e["ipa"],
        "definition_zh": definition_zh,
        "definition_en": None,           # OpenEtymology 不提供英文释义；Linguabase 也无
        "example_en": first_ex["en"] if first_ex else None,
        "example_zh": first_ex["zh"] if first_ex else None,
        "examples": examples or None,
        "audio_path": None,              # 运行时 Web Speech API 合成
        "word_hint": None,
        "root": e["morphemes"][0]["form"] if e["morphemes"] else None,
        "morphemes": e["morphemes"] or None,
        "etymology": e["etymology"],
        "related": a["related"] if a else None,
        "antonyms": a["antonyms"] if a else None,
        "relatives": a["relatives"] if a else None,
        "pos": pos,
        "difficulty_level": difficulty,
        "frequency_rank": frequency_rank,
        "topic_id": book,
        "book": book,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="述树 OpenEtymology 内容层接入（按词本分片）")
    parser.add_argument("--src-dir", default=None, help="OpenEtymology-main 目录（含 CET4..GRE8000 子目录）")
    parser.add_argument("--out-dir", default="public/data/linguabase", help="输出目录")
    parser.add_argument("--linguabase-data-dir", default=None, help="可选：Linguabase core parquet 目录，用于增强关系网络")
    args = parser.parse_args()

    # 定位源码目录
    candidates = [args.src_dir, os.environ.get("OPENETYMOLOGY_DIR"),
                  "/root/uploads/OpenEtymology-main/OpenEtymology-main",
                  os.path.join(os.getcwd(), "OpenEtymology-main")]
    src_dir = next((c for c in candidates if c and os.path.isdir(c)), None)
    if not src_dir:
        print("[oe] 未找到 OpenEtymology 目录；请用 --src-dir 指定。")
        return 1

    # 可选 Linguabase 增强
    aug = load_linguabase_augment(args.linguabase_data_dir) if args.linguabase_data_dir else {}

    # 逐词本解析，去重（词本内按小写词去重，保留首次出现）
    books_data: dict[str, list[dict]] = {}
    for book in BOOK_ORDER:
        epub = os.path.join(src_dir, book, f"{book}.epub")
        if not os.path.isfile(epub):
            print(f"[oe] 跳过 {book}：未找到 {epub}")
            continue
        entries = parse_book_epub(epub, book)
        seen: set[str] = set()
        objs: list[dict] = []
        for i, e in enumerate(entries):
            wl = e["word"].lower()
            if wl in seen:
                continue
            seen.add(wl)
            objs.append(build_obj(e, aug.get(wl), i + 1))
        books_data[book] = objs
        print(f"[oe] {book}: {len(objs)} 词（原始 {len(entries)}）")

    if not books_data:
        print("[oe] 未解析到任何词，退出。")
        return 1

    # 输出分片
    os.makedirs(args.out_dir, exist_ok=True)
    books_dir = os.path.join(args.out_dir, "books")
    os.makedirs(books_dir, exist_ok=True)
    for book, objs in books_data.items():
        with open(os.path.join(books_dir, f"{book}.json"), "w", encoding="utf-8") as f:
            json.dump(objs, f, ensure_ascii=False, separators=(",", ":"))
        print(f"[oe] 写出 books/{book}.json ({len(objs)} 词)")

    total = sum(len(v) for v in books_data.values())

    # 极小索引（前端首屏只拉这个，~1KB）
    index = {
        "total": total,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": "OpenEtymology (CC BY-SA 4.0, OpenEtymology contributors)",
        "attribution": "词源英语 OpenEtymology — https://www.openetymology.com",
        "license": "CC BY-SA 4.0 (署名-相同方式共享)",
        "books": [
            {
                "id": b,
                "name": BOOK_NAMES.get(b, b),
                "count": len(books_data[b]),
                "difficulty_level": BOOK_DIFFICULTY.get(b, 3),
                "file": f"books/{b}.json",
            }
            for b in BOOK_ORDER if b in books_data
        ],
    }
    with open(os.path.join(args.out_dir, "index.json"), "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, separators=(",", ":"))
    print(f"[oe] 写出 index.json（total={total}, 词本数={len(index['books'])}）")

    # 人类可读的 provenance（保留字段状态说明）
    manifest = {
        "source": index["source"],
        "attribution": index["attribution"],
        "license": index["license"],
        "generated_at": index["generated_at"],
        "layout": "sharded-by-book",
        "index_file": "index.json (~1KB, 首屏加载)",
        "book_files": {b: f"books/{b}.json" for b in books_data},
        "books": {b: len(v) for b, v in books_data.items()},
        "words_extracted": total,
        "linguabase_augmented": bool(aug),
        "field_status": {
            "word": "real(epub h2)",
            "ipa": "real(epub pronunciation, UK)",
            "definition_zh": "real(epub Definitions, 含词性)",
            "example_en/example_zh": "real(epub Examples 双语)",
            "morphemes/root": "real(epub Morphemes 词根词缀)",
            "etymology": "real(epub Etymology 词源)",
            "difficulty_level": "real(词本梯度: CET4=L2, 其余=L3)",
            "related/antonyms/relatives": "Linguabase 增强(可选)" if aug else "pending(需 Linguabase core)",
            "audio_path": "runtime(Web Speech API)",
        },
        "note": "仅输出真实抽取字段，不编造任何词/释义/音频。衍生内容须遵守 CC BY-SA 4.0 并署名 OpenEtymology。",
    }
    with open(os.path.join(args.out_dir, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    print(f"[oe] 写出 manifest.json")

    # 删除旧的整包（避免首屏误加载 19MB）
    old = os.path.join(args.out_dir, "words.json")
    if os.path.isfile(old):
        os.remove(old)
        print("[oe] 已删除旧的 words.json（整包）")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
