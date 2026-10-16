# -*- coding: utf-8 -*-
"""
阶段 3 前置 · 把一条真实 query 编码成 1024 维向量，供执行计划验证使用。

与生产路径完全一致（逐字对齐 search-discover.py）：
    SentenceTransformer("BAAI/bge-m3", local_files_only=True)
    encode([q], normalize_embeddings=True, convert_to_numpy=True)
    literal = "[" + ",".join(f"{v:.6f}") + "]"

用法（必须在 PowerShell 下跑；Git Bash/MSYS 下 import torch 会 SIGSEGV）：
    $env:HF_HUB_OFFLINE="1"
    C:/Python314/python.exe -u src/scripts/encode-probe-vector.py --query "..."
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

SERVER_ROOT = Path(__file__).resolve().parents[2]
OUT = SERVER_ROOT / ".crawl-cache" / "_b6-probe-vector.json"

DEFAULT_QUERY = (
    "一位富家小姐拒绝了门当户对的求婚，执意嫁给年长的学者；婚后丈夫只允许她在脚注里存在，"
    "而丈夫的表亲、姨夫和妹妹各自有着彼此冲突的打算，最后一份遗嘱的附加条款改变了所有人的处境"
)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--query", default=DEFAULT_QUERY)
    ap.add_argument("--model", default=os.environ.get("EMBED_MODEL", "BAAI/bge-m3"))
    args = ap.parse_args()

    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    from sentence_transformers import SentenceTransformer

    model = SentenceTransformer(args.model, local_files_only=True)
    vector = model.encode([args.query], normalize_embeddings=True, convert_to_numpy=True)[0]
    if vector.shape != (1024,):
        raise RuntimeError(f"向量维度异常：{vector.shape}")
    literal = "[" + ",".join(f"{float(v):.6f}" for v in vector) + "]"
    OUT.write_text(json.dumps({
        "model": str(model[0].auto_model.name_or_path),
        "query": args.query,
        "query_chars": len(args.query),
        "dim": int(vector.shape[0]),
        "normalize_embeddings": True,
        "literal_precision": 6,
        "literal": literal,
    }, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"written -> {OUT}  dim={int(vector.shape[0])}  literal_len={len(literal)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
