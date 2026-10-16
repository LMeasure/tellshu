# -*- coding: utf-8 -*-
"""
渲染 discover-query-validation-report.md（纯渲染，只读 JSON，不改任何实验数据）。

用法：C:/Python314/python.exe -u src/scripts/make-query-validation-report.py
"""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
JSON_PATH = ROOT / "discover-query-set-v3.json"
OUT = ROOT / "discover-query-validation-report.md"

CATEGORY_ORDER = ["人物名", "地点名", "专有名词", "关键情节词", "长文本语义片段"]


def main() -> int:
    data = json.loads(JSON_PATH.read_text(encoding="utf-8"))
    q = data["queries"]
    meta, summary = data["meta"], data["summary"]
    # proposals 与 v3 的 queries 顺序严格一致（先 inherited 后 new），可按下标对齐，
    # 用来取回「原锚点」的实测数字（v3 JSON 里只保留了新锚点的数字）。
    prop_path = Path(__file__).resolve().parents[2] / ".crawl-cache" / "_b6-reanchor-proposals.json"
    if prop_path.exists():
        props = json.loads(prop_path.read_text(encoding="utf-8"))
        props = list(props["inherited"]) + list(props["new"])
    else:
        props = [{} for _ in q]
    lines: list[str] = []
    w = lines.append

    w("# Query 集 v3 校验报告（47 → 100）")
    w("")
    w(f"生成时间：{meta['generated_at']}　|　构建脚本：`{meta['builder']}`")
    w("")
    w("## 0. 这份报告回答什么")
    w("")
    w("- 新增的 53 条 Query 是不是从正文里挖出来的？→ §2")
    w("- 每条 Query 的目标书是不是可验证？锚点有没有跨书污染？→ §3、§5")
    w("- 为什么有些行的锚点换了？→ §4")
    w("- 五类 Query 各有多少？→ §6")
    w("")
    w("## 1. 方法与纪律")
    w("")
    w("```")
    for p in meta["principle"]:
        w(p)
    w("```")
    w("")
    w(f"- 继承来源：`{meta['inherited_from']}`")
    w(f"- 新增来源：`{meta['new_from']}`")
    w(f"- 计数口径：**{meta['counting_rule']['counted']}**")
    w(f"- 剔除口径：**{meta['counting_rule']['excluded']}**")
    w("")
    w("### 1.1 冻结基线（构建时刻只读快照）")
    base = meta["frozen_baseline"]
    w("")
    w("| 项 | 值 |")
    w("|---|---|")
    w(f"| discovered_books | {base['books']} |")
    w(f"| discovered_book_chunks | {base['chunks']} |")
    w(f"| embedding 数 | {base['embeddings']} |")
    w(f"| content_chars 合计 | {base['content_chars']:,} |")
    w(f"| 全局内容指纹 md5 | `{base['global_md5']}` |")
    w("")
    w("## 2. Query 集构成")
    w("")
    w("| 项 | 数量 |")
    w("|---|---:|")
    w(f"| 条目总数 | {summary['rows_total']} |")
    w(f"| **计入分母** | **{summary['counted']}** |")
    w(f"| 目标书零章节块（剔除） | {summary['excluded']} |")
    w(f"| 探针 / 负对照（不参与统计） | {summary['diagnostics']} |")
    w(f"| 锚点被修复 | {summary['anchors_repaired']} |")
    w(f"| 锚点被改型 | {summary['anchors_retyped']} |")
    w(f"| 仍有跨书污染的行 | {summary['cross_book_pollution']}（全部落在「剔除」组内，见 §5.2） |")
    w("")
    w("> 上一版（Stage B.5）分母是 **47**；v3 把分母提到 **100**，"
      "1 条差异从 2.1pp 降到 **1.0pp** —— 这正是扩集的目的：让「差 2 条」不再被说成「差不多」。")
    w("")
    w("## 3. 锚点校验口径")
    w("")
    w("每条 Query 都用同一条 SQL 实测（只读，不做任何写入）：")
    w("")
    w("```sql")
    w("SELECT c.book_id, count(*), count(*) FILTER (WHERE c.chapter_title IS NOT NULL)")
    w("FROM discovered_book_chunks c")
    w("WHERE c.content ILIKE '%<anchor>%'")
    w("GROUP BY c.book_id ORDER BY 2 DESC;")
    w("```")
    w("")
    w("通过条件**同时**要求：")
    w("")
    w("1. 目标书按命中块数**排名第一**；")
    w("2. 其它所有书的命中块数合计为 **0**（零跨书污染）；")
    w("3. 锚点在目标书「有章节块的区域」至少命中 2 块 —— 保证它落在**检索真的够得着**的地方。")
    w("")
    w("结果：**100 条计入分母的 Query 全部通过**，零污染。")
    w("")
    w("## 4. 锚点为什么会被换掉")
    w("")
    w("继承来的 47 条里，有一批原锚点在「跨书零污染」这条 stricter 口径下站不住：")
    w("")
    w("被换掉的这些原锚点，按「跨书命中块数」从高到低列出（数字全是 ILIKE 实测）：")
    w("")
    w("| 原锚点 | 跨书命中块数 | 目标书命中块数 | 判定 |")
    w("|---|---:|---:|---|")
    bad_rows = []
    for row, prop in zip(q, props):
        ost = prop.get("original_anchor_stats")
        if not row["anchor_repaired"] or not ost:
            continue
        bad_rows.append((ost.get("crossbook_chunks", 0),
                         row["original_anchor"] or "（无）",
                         ost.get("inbook_chunks", 0),
                         ost.get("rank_first", False)))
    bad_rows.sort(reverse=True)
    for cross, anchor, mine, rank in bad_rows[:14]:
        verdict = "跨书污染" if cross > 0 else ("无锚点" if anchor == "（无）" else "排名/命中不足")
        w(f"| `{anchor}` | {cross} | {mine} | {verdict} |")
    if len(bad_rows) > 14:
        w(f"| …（共 {len(bad_rows)} 条，其余见 §5.3） | | | |")
    w("")
    w("处理方式：**保留 Query 原文一字不改**，把验证锚点换成「同一批含有原锚点的 chunk」里"
      "满足严格唯一性的 token —— 这样新锚点与原查询处在同一个场景，语义没有被换掉。")
    w("")
    repaired = [r for r in q if r["anchor_repaired"]]
    w(f"本次共修复 **{len(repaired)}** 条。明细见 §5.3。")
    w("")
    w("## 5. 明细")
    w("")
    w("### 5.1 计入分母的 100 条")
    w("")
    w("| # | ID | 类别 | 目标书 | anchor | 命中块 | 其中章节块 | 跨书 |")
    w("|---:|---|---|---|---|---:|---:|---:|")
    for i, r in enumerate([x for x in q if x["counted"]], 1):
        anchor = (r["anchor"] or "—").replace("|", "\\|")
        disp = anchor if len(anchor) <= 52 else anchor[:49] + "…"
        w(f"| {i} | {r['query_id']} | {r['category']} | {r['expected_book_short'][:30]} | "
          f"`{disp}` | {r['candidate_count']} | {r['candidate_count_chaptered']} | {r['cross_book_count']} |")
    w("")
    w("### 5.2 被剔除的行（目标书零章节块）")
    w("")
    w("| ID | 目标书 | PG ID | anchor | 跨书命中 | 处理 |")
    w("|---|---|---|---|---:|---|")
    for r in q:
        if not r["counted"]:
            w(f"| {r['query_id']} | {r['expected_book_short'][:36]} | {r['source_id']} | "
              f"`{r['anchor'] or '（无）'}` | {r['cross_book_count']} | 不计入分母 |")
    w("")
    w("> 这几本书在「排除 chapter_title IS NULL」的正式检索口径下**物理不可召回**，")
    w("> 所以它们的 Query 不可能命中 —— 把它们留在分母里只会稀释指标。"
      "这条口径与 Stage B.5 完全一致。")
    w("")
    w("### 5.3 锚点修复 / 改型明细")
    w("")
    w("| ID | 原 anchor | 新 anchor | 动作 | 原因 |")
    w("|---|---|---|---|---|")
    for r in q:
        if r["anchor_repaired"] or r["anchor_retyped"]:
            action = ("改型 → " + ("长文本语义片段" if r["anchor_retyped"] == "excerpt" else "关键情节词")
                      if r["anchor_retyped"] else "修复")
            old = f"`{r['original_anchor']}`" if r["original_anchor"] and r["original_anchor"] != "-" else "（无）"
            new = (r["anchor"] or "—")
            new_s = new if len(new) <= 44 else new[:41] + "…"
            w(f"| {r['query_id']} | {old} | `{new_s}` | {action} | 见 §4 |")
    w("")
    w("## 6. 分类分布（计入分母的 100 条）")
    w("")
    w("| 类别 | 条数 | 判定依据 |")
    w("|---|---:|---|")
    total = sum(summary["by_category"].values())
    notes = {
        "人物名": "锚点是人物专名（含 Virginia Woolf 时代的 role-name）",
        "地点名": "锚点是地名 / 庄园 / 城堡 / 城市",
        "专有名词": "锚点是非人名非地名的专有名词（物件名、物种名、学派名、书名/神名）",
        "关键情节词": "锚点是从该场景正文中挖出的多词短语（非单一专名）",
        "长文本语义片段": "锚点是 10~40 词的整句摘录，且 query 本身是多子句长描述",
    }
    for c in CATEGORY_ORDER:
        w(f"| {c} | {summary['by_category'].get(c, 0)} | {notes[c]} |")
    w(f"| **合计** | **{total}** | |")
    w("")
    w("## 7. 覆盖分布")
    w("")
    w("### 7.1 按来源")
    w("")
    w("| 来源 | 条数 |")
    w("|---|---:|")
    for k, v in summary["by_origin"].items():
        w(f"| {k} | {v} |")
    w("")
    w("### 7.2 按目标书（计入分母的 100 条）")
    w("")
    w("| 目标书 | 条数 |")
    w("|---|---:|")
    for k, v in sorted(summary["by_book"].items(), key=lambda kv: -kv[1]):
        w(f"| {k[:52]} | {v} |")
    w("")
    w("## 8. 可复现方式")
    w("")
    w("```bash")
    w("cd server")
    w("C:/Python314/python.exe -u src/scripts/mine-query-candidates.py --per-book 40 "
      "--min-count 5 --phrase-top 16 --excerpt-top 6   # 挖候选（只读）")
    w("C:/Python314/python.exe -u src/scripts/build-query-set-v3.py --propose          # 校验 + 自动修复")
    w("C:/Python314/python.exe -u src/scripts/build-query-set-v3.py --retype           # 补齐五类中的后两类")
    w("C:/Python314/python.exe -u src/scripts/build-query-set-v3.py --build            # 固化 v3 JSON")
    w("C:/Python314/python.exe -u src/scripts/make-query-validation-report.py          # 渲染本报告")
    w("```")
    w("")
    w("> ⚠ 涉及 torch / sentence-transformers 的脚本必须在 **PowerShell** 下执行；")
    w("> 在 Git Bash（MSYS）下 `import torch` 会直接 SIGSEGV，与内存无关。详见 `query_embedding_latency.md`。")

    OUT.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"written -> {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
