#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
述树 · Linguabase 真实内容接入管线
=================================================================
读取真实的 Linguabase CC0 下载包（.parquet），抽取并映射为述树
ContentWord 形状，输出到 public/data/linguabase/ 供前端离线加载。

设计原则（与 Phase 0「不创造虚拟数据」一致）：
  1. 只输出**从真实 Linguabase 字段抽取**的数据；不编造任何单词、释义、音频。
  2. Linguabase 缺失的字段（中文释义 / 音标 IPA / 音频）一律留空（null），
     由外部内容层/运行时补齐，绝不伪造。
  3. 难度（difficulty_level）由真实的 core_rank 分桶得出，确定性、可复现。
  4. 无数据文件时进入「校验模式」：打印字段映射方案与待补清单，不写任何词。

真实字段来源（见 Linguabase README）：
  vocabulary.core  -> word, core_rank, familiarity_score, is_mwe
  definitions.core -> definition（英文段落，{braces}=斜体用例）
  associations.core-> associates（排名关联词，最强在前）
  antonyms.core    -> opposites（term:rating，1-7，7 最强）
  word_families.core-> relatives（形态/词源亲属，用于同根聚合）

缺口补齐（真实、非虚拟）：
  - 音标 IPA：若系统装有 espeak-ng，离线真实生成；否则 ipa=null（待生成）。
  - 发音音频：前端运行时用 Web Speech API 真实合成（见 repository.ts），audio_path=null。
  - 中文释义 definition_zh / example_zh：外部合规 EN-ZH 词典灌入，脚本留接口（--zh-dict）。

用法：
  python scripts/linguabase_ingest.py                  # 自动找数据目录
  python scripts/linguabase_ingest.py --data-dir /path/to/linguabase
  python scripts/linguabase_ingest.py --top 2000 --out-dir public/data/linguabase
  python scripts/linguabase_ingest.py --validate       # 仅校验映射，不产出词
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone

# ---------- 配置：Linguabase 各子集的 core 文件名 ----------
CORE_FILES = {
    "vocabulary": "vocabulary.core.parquet",
    "definitions": "definitions.core.parquet",
    "associations": "associations.core.parquet",
    "antonyms": "antonyms.core.parquet",
    "word_families": "word_families.core.parquet",
}

# 难度分桶：按真实 core_rank（1=最熟悉）分位。
#   L1 = 字母识别级（教材内容层，非 Linguabase 来源，此处不产出）
#   L2 = 基础词汇级（高频，core_rank 前 25%）
#   L3 = 进阶词汇级（其余 core 词）
BASIC_VOCAB_RANK_CUTOFF = 100_000  # core 共 400,000；前 25% 视为基础词

# 抽取/裁剪参数
RELATED_K = 8          # 每个词保留的关联词数（已裁剪到 core 内）
ANTONYM_RATING_MIN = 6 # 仅保留强度 >= 6 的反义词
ANTONYM_K = 6          # 每个词保留的反义词数


def log(msg: str) -> None:
    print(f"[ingest] {msg}", flush=True)


def find_data_dir(explicit: str | None) -> str | None:
    candidates = []
    if explicit:
        candidates.append(explicit)
    candidates += [
        os.environ.get("LINGUABASE_DATA_DIR", ""),
        "/root/uploads",
        os.path.join(os.getcwd(), "linguabase_data"),
        "/workspace/linguabase_data",
    ]
    candidates = [c for c in candidates if c]
    for c in candidates:
        if os.path.isdir(c):
            return c
    return None


def locate_files(data_dir: str) -> dict[str, str]:
    found = {}
    for key, fname in CORE_FILES.items():
        p = os.path.join(data_dir, fname)
        if os.path.isfile(p):
            found[key] = p
    return found


def has_espeak() -> bool:
    return shutil.which("espeak-ng") is not None or shutil.which("espeak") is not None


def gen_ipa(word: str, bin_name: str) -> str | None:
    """用 espeak-ng 离线真实生成美式 IPA。失败返回 None（绝不编造）。"""
    try:
        out = subprocess.run(
            [bin_name, "-q", "--ipa", "-v", "en-us", word],
            capture_output=True, text=True, timeout=5,
        )
        ipa = out.stdout.strip()
        return ipa or None
    except Exception:
        return None


_BRACE_RE = re.compile(r"\{([^{}]+)\}")


def extract_example(definition: str) -> str | None:
    """Linguabase 约定：定义中 {curly braces} 为斜体用例。取首个作为真实例句。"""
    if not definition:
        return None
    m = _BRACE_RE.search(definition)
    return m.group(1).strip() if m else None


def clean_definition(definition: str) -> str:
    """去除斜体标记花括号，得到纯文本英文释义。"""
    if not definition:
        return ""
    return _BRACE_RE.sub(lambda m: m.group(1), definition).strip()


def parse_antonyms(opposites) -> list[tuple[str, int]]:
    """opposites 为 ['term:rating', ...]，按最后一个 ':' 切分。"""
    result = []
    for tok in (opposites or []):
        if not isinstance(tok, str) or ":" not in tok:
            continue
        term, _, rating_s = tok.rpartition(":")
        try:
            rating = int(rating_s)
        except ValueError:
            continue
        term = term.strip()
        if term:
            result.append((term, rating))
    return result


def load_parquet_dict(path: str, key: str, val_cols: list[str]) -> dict:
    """用 pyarrow 读取指定列，返回 {key: [vals]}。"""
    import pyarrow.parquet as pq

    tbl = pq.read_table(path, columns=[key] + val_cols)
    keys = tbl.column(key).to_pylist()
    val_lists = [tbl.column(c).to_pylist() for c in val_cols]
    out: dict = {}
    for i, k in enumerate(keys):
        if k is None:
            continue
        out[k] = [vl[i] for vl in val_lists]
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description="述树 Linguabase 接入管线")
    parser.add_argument("--data-dir", default=None, help="Linguabase 数据目录")
    parser.add_argument("--out-dir", default="public/data/linguabase", help="输出目录")
    parser.add_argument("--top", type=int, default=2000, help="抽取前 N 个最高频词")
    parser.add_argument("--zh-dict", default=None, help="可选 EN-ZH 词典 TSV（word\\t中文），灌入 definition_zh")
    parser.add_argument("--validate", action="store_true", help="仅校验映射，不产出词")
    args = parser.parse_args()

    data_dir = find_data_dir(args.data_dir)
    log(f"数据目录: {data_dir or '(未找到)'}")
    if data_dir is None:
        log("未定位到 Linguabase 数据目录；进入校验模式。")
        write_validate_manifest(args.out_dir, data_dir, present_files={})
        return 0

    present = locate_files(data_dir)
    log(f"找到子集: {sorted(present.keys())}")

    if "vocabulary" not in present:
        log("缺少 vocabulary.core.parquet，无法构建词表；进入校验模式。")
        write_validate_manifest(args.out_dir, data_dir, present)
        return 0

    if args.validate:
        log("显式 --validate；打印映射方案后退出（不写词）。")
        write_validate_manifest(args.out_dir, data_dir, present)
        return 0

    # ---- 1. 词表脊柱（真实 core_rank / familiarity_score）----
    log("读取 vocabulary.core ...")
    vocab = load_parquet_dict(present["vocabulary"], "word", ["core_rank", "familiarity_score", "is_mwe"])
    core_set = set(vocab.keys())
    ranked = sorted(
        ((w, v[0]) for w, v in vocab.items() if v[0] is not None),
        key=lambda x: x[1],
    )
    top_words = [w for w, _ in ranked[: max(1, args.top)]]
    log(f"候选词总数 {len(ranked)}；本次抽取前 {len(top_words)} 个。")

    # ---- 2. 英文释义 + 例句（真实 definitions）----
    defs: dict = {}
    if "definitions" in present:
        log("读取 definitions.core ...")
        defs = load_parquet_dict(present["definitions"], "word", ["definition"])
        defs = {w: (v[0] if v else None) for w, v in defs.items()}

    # ---- 3. 关联词（裁剪到 core 内，真实 associations）----
    assoc: dict = {}
    if "associations" in present:
        log("读取 associations.core ...")
        assoc = load_parquet_dict(present["associations"], "word", ["associates"])
        assoc = {w: (v[0] if v else []) for w, v in assoc.items()}

    # ---- 4. 反义词（强度>=min，真实 antonyms）----
    ant: dict = {}
    if "antonyms" in present:
        log("读取 antonyms.core ...")
        ant = load_parquet_dict(present["antonyms"], "word", ["opposites"])
        ant = {w: (v[0] if v else []) for w, v in ant.items()}

    # ---- 5. 同根/词族（真实 word_families，用于聚合展示）----
    fam: dict = {}
    if "word_families" in present:
        log("读取 word_families.core ...")
        fam = load_parquet_dict(present["word_families"], "word", ["relatives"])
        fam = {w: (v[0] if v else []) for w, v in fam.items()}

    # ---- 6. 可选中文词典 ----
    zh: dict = {}
    if args.zh_dict and os.path.isfile(args.zh_dict):
        log(f"载入中文词典: {args.zh_dict}")
        with open(args.zh_dict, encoding="utf-8") as f:
            for line in f:
                parts = line.rstrip("\n").split("\t")
                if len(parts) >= 2:
                    zh[parts[0].strip().lower()] = parts[1].strip()

    # ---- 7. IPA（真实生成，可选）----
    espeak_bin = shutil.which("espeak-ng") or shutil.which("espeak")
    ipa_mode = "generated(espeak-ng)" if espeak_bin else "pending(无 espeak-ng)"
    log(f"IPA 模式: {ipa_mode}")

    # ---- 8. 组装词对象（仅真实字段）----
    log("组装词对象 ...")
    words = []
    for w in top_words:
        rank = vocab[w][0]
        difficulty = 2 if rank <= BASIC_VOCAB_RANK_CUTOFF else 3
        topic_id = "freq-basic" if difficulty == 2 else "freq-advanced"

        definition_raw = defs.get(w)
        definition_en = clean_definition(definition_raw) if definition_raw else None
        example_en = extract_example(definition_raw) if definition_raw else None

        relates = [a for a in (assoc.get(w) or []) if a in core_set][:RELATED_K]

        antonyms = []
        for term, rating in parse_antonyms(ant.get(w) or []):
            if rating >= ANTONYM_RATING_MIN:
                antonyms.append({"term": term, "rating": rating})
        antonyms = sorted(antonyms, key=lambda x: -x["rating"])[:ANTONYM_K]

        relatives = [r for r in (fam.get(w) or []) if r in core_set][:RELATED_K]

        ipa = gen_ipa(w, espeak_bin) if espeak_bin else None

        obj = {
            "id": f"lb-{w.lower()}",
            "word": w,
            "ipa": ipa,
            "definition_zh": zh.get(w.lower()),     # 外部灌入；否则 null
            "definition_en": definition_en,
            "example_en": example_en,
            "example_zh": None,                      # 待外部灌入
            "audio_path": None,                      # 运行时 Web Speech 合成
            "word_hint": None,                       # 仅在可简单拆分时人工/算法补充
            "root": None,                            # 词根非严格字段，用 relatives 表达
            "relatives": relatives or None,
            "related": relates or None,
            "antonyms": antonyms or None,
            "difficulty_level": difficulty,
            "frequency_rank": rank,
            "topic_id": topic_id,
        }
        words.append(obj)

    # ---- 9. 写出 ----
    os.makedirs(args.out_dir, exist_ok=True)
    words_path = os.path.join(args.out_dir, "words.json")
    with open(words_path, "w", encoding="utf-8") as f:
        json.dump(words, f, ensure_ascii=False, separators=(",", ":"))
    log(f"写出 {len(words)} 词 -> {words_path}")

    manifest = build_manifest(data_dir, present, len(words), args.top, ipa_mode, bool(zh))
    manifest_path = os.path.join(args.out_dir, "manifest.json")
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    log(f"写出 manifest -> {manifest_path}")
    return 0


def build_manifest(data_dir, present, n_words, top, ipa_mode, has_zh) -> dict:
    return {
        "source": "Linguabase (CC0 1.0, IDEA.org)",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "data_dir": data_dir,
        "subsets_present": sorted(present.keys()),
        "subsets_missing": sorted(set(CORE_FILES) - set(present)),
        "words_extracted": n_words,
        "top_requested": top,
        "difficulty_buckets": {
            "L1_letters": "教材内容层（非 Linguabase），本管线不产出",
            "L2_basic": f"core_rank <= {BASIC_VOCAB_RANK_CUTOFF}",
            "L3_advanced": f"core_rank > {BASIC_VOCAB_RANK_CUTOFF}",
        },
        "field_status": {
            "word": "real(vocabulary)",
            "frequency_rank": "real(core_rank)",
            "difficulty_level": "derived(core_rank bucket)",
            "definition_en": "real(definitions)",
            "example_en": "real(definitions {braces})",
            "related": "real(associations, pruned to core)",
            "antonyms": f"real(antonyms, rating>={ANTONYM_RATING_MIN})",
            "relatives": "real(word_families, pruned to core)",
            "ipa": ipa_mode,
            "audio_path": "runtime(Web Speech API)",
            "definition_zh": "pending(外部 EN-ZH 词典)" if not has_zh else "real(zh-dict)",
            "example_zh": "pending(外部 EN-ZH 词典)",
        },
        "note": "本管线只产出从真实 Linguabase 抽取的数据，不编造任何单词/释义/音频。",
    }


def write_validate_manifest(out_dir, data_dir, present) -> None:
    os.makedirs(out_dir, exist_ok=True)
    manifest = {
        "status": "pending_data",
        "source": "Linguabase (CC0 1.0, IDEA.org)",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "data_dir": data_dir,
        "subsets_present": sorted(present.keys()),
        "subsets_expected": sorted(CORE_FILES),
        "subsets_missing": sorted(set(CORE_FILES) - set(present)),
        "message": (
            "未检测到完整 Linguabase core 数据，故未产出任何词（遵守不编造数据原则）。"
            "请提供 vocabulary.core.parquet 等文件后重跑本脚本。"
        ),
        "field_plan": {
            "word": "vocabulary.word",
            "frequency_rank": "vocabulary.core_rank",
            "difficulty_level": f"core_rank<={BASIC_VOCAB_RANK_CUTOFF}->L2 否则 L3",
            "definition_en": "definitions.definition (去 {braces})",
            "example_en": "definitions.definition 首个 {braces} 用例",
            "related": "associations.associates (裁剪到 core)",
            "antonyms": f"antonyms.opposites 解析 term:rating, 取 >= {ANTONYM_RATING_MIN}",
            "relatives": "word_families.relatives (裁剪到 core)",
            "ipa": "espeak-ng 离线生成(可选)；否则 pending",
            "audio_path": "运行时 Web Speech API 合成",
            "definition_zh/example_zh": "外部 EN-ZH 词典灌入(接口 --zh-dict)",
        },
    }
    manifest_path = os.path.join(out_dir, "manifest.json")
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    log(f"校验清单已写出 -> {manifest_path}")


if __name__ == "__main__":
    sys.exit(main())
