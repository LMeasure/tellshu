#!/usr/bin/env python3
"""一次性工具：把 src/domain/types.ts 中「单词默写」相关的 3 处改动单独放进索引。

背景：工作树里的 types.ts 混了两组改动——
  A. 单词默写（本功能）：import SpellingSession、StorageSchema.spellingSessions、PrimaryKeyMap.spellingSessions
  B. 转写→阅读器链路（并行任务）：TranscriptSegment import、ReadingType += 'transcript'、ReadingDoc.segments
按裁定 A，本功能提交不能夹带并行任务改动，于是基于 HEAD 版本只叠加 A 组改动，
写成一个新 blob 塞进索引；工作树文件一个字节都不动。

用法（在本仓库根目录执行）：
    python scripts/_stage_types_spelling_only.py
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

REL = "src/domain/types.ts"


def run(args: list[str], **kw) -> str:
    return subprocess.run(args, capture_output=True, text=True, check=True, **kw).stdout


def replace_once(text: str, old: str, new: str, label: str) -> str:
    """精确替换一次；出现次数不为 1 就直接失败，避免悄悄改错地方。"""
    n = text.count(old)
    if n != 1:
        sys.exit(f"[fail] {label}: 期望 1 处匹配，实际 {n} 处")
    return text.replace(old, new, 1)


def main() -> None:
    head = run(["git", "show", f"HEAD:{REL}"])
    out = head

    # A1：引入 SpellingSession 类型（不引入并行任务要的 TranscriptSegment）
    out = replace_once(
        out,
        "import type { StudyNoteRecord, TranscriptRecord } from './transcript/types'\n",
        "import type { StudyNoteRecord, TranscriptRecord } from './transcript/types'\n"
        "import type { SpellingSession } from './spelling'\n",
        "A1 import SpellingSession",
    )

    # A2：StorageSchema 增加 spellingSessions 表
    out = replace_once(
        out,
        "  transcripts: TranscriptRecord\n  studyNotes: StudyNoteRecord\n}\n",
        "  transcripts: TranscriptRecord\n  studyNotes: StudyNoteRecord\n"
        "  // \u2193 v10 \u65b0\u589e\uff1a\u5355\u8bcd\u9ed8\u5199\u4f1a\u8bdd\uff08\u5355\u6587\u6863\uff0cqueue "
        "\u5185\u5d4c\uff1b\u65b9\u6848 V3.2 \u00a75.1\uff09\n  spellingSessions: SpellingSession\n}\n",
        "A2 StorageSchema.spellingSessions",
    )

    # A3：PrimaryKeyMap 声明主键类型
    out = replace_once(
        out,
        "  transcripts: string\n  studyNotes: string\n}\n",
        "  transcripts: string\n  studyNotes: string\n  spellingSessions: string\n}\n",
        "A3 PrimaryKeyMap.spellingSessions",
    )

    tmp = Path("_types_spelling_only.ts")
    tmp.write_text(out, encoding="utf-8", newline="\n")

    sha = run(["git", "hash-object", "-w", str(tmp)]).strip()
    run(["git", "update-index", "--cacheinfo", f"100644,{sha},{REL}"])
    tmp.unlink()

    print(f"[ok] 已把拼写相关改动单独写入索引：{REL}")
    print(f"     blob = {sha}")
    print("[ok] 工作树文件未被修改（转写/阅读器改动仍留在工作树，未进索引）")


if __name__ == "__main__":
    main()
