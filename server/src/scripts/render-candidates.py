"""
render-candidates.py —— 把 plan-candidates.ts 产出的 JSON 渲染成人类可读的候选书单 Markdown

为什么单独一个脚本：
    候选书单要交给用户逐本确认，表格里每个数字都必须来自 .candidate-plan.json 的真实值，
    不能靠手抄（手抄必错，错了就是伪造数据）。本脚本只做「读 JSON → 排版」，不做任何推断。

用法：
    cd server && python src/scripts/render-candidates.py --out ../../候选书单.md
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

# 人工判断分组（依据：书名/作者重复，或标题显示不是完整书）
# 这些是「建议」，不是自动判定；版权判定本身全部来自口径 A 的机器结果。
BACKUP_GROUP = {
    "42": "与 #23（PG 43）同书名同作者，属 Gutenberg 重复版本；建议保留 43（榜单排名更前、issued 更新）",
    "45839": "与 #18（PG 345）同书名同作者（Dracula / Stoker），重复版本；建议保留 345",
    "42671": "与已入库的 PG 1342（Pride and Prejudice）同书；库内已有，不重复抓",
    "47530": "标题为 *Oliver Twist, Vol. 2 (of 3)*，只是三卷本的第 2 卷，不是完整书",
    "5197": "标题为 *My Life — Volume 1*（瓦格纳自传第 1 卷），不是完整书",
}


def authors_text(item: dict) -> str:
    parts = []
    for a in item.get("authors", []):
        parts.append(f"{a.get('name') or '(未具名)'}（{a.get('birthdate') or '?'}–{a.get('deathdate') or '?'}）")
    return " / ".join(parts) or "（RDF 无 creator）"


def contributors_text(item: dict) -> str:
    parts = []
    for c in item.get("contributors", []):
        role = (c.get("role") or "").replace("marcrel:", "")
        parts.append(f"{c.get('name') or '(未具名)'} [{role}] 卒 {c.get('deathdate') or '?'}")
    return " / ".join(parts)


def esc(text: str | None) -> str:
    if not text:
        return ""
    return text.replace("|", "\\|").replace("\n", " ").strip()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--in", dest="inp", default=".candidate-plan.json")
    parser.add_argument("--out", default=".candidate-render.md")
    args = parser.parse_args()

    data = json.loads(Path(args.inp).read_text(encoding="utf-8"))
    evals = data["evaluations"]
    included = [e for e in evals if e["verdict"]["decision"] == "include"]
    skipped = [e for e in evals if e["verdict"]["decision"] != "include"]

    group_a = [e for e in included if e["id"] not in BACKUP_GROUP]
    group_b = [e for e in included if e["id"] in BACKUP_GROUP]

    def url(id_: str) -> str:
        return f"https://www.gutenberg.org/ebooks/{id_}"

    lines: list[str] = []

    def row(cells: list[str]) -> str:
        return "| " + " | ".join(cells) + " |"

    # ---- A 组 ----
    lines.append(f"### A 组：建议纳入 {len(group_a)} 本")
    lines.append("")
    lines.append(row(["#", "PG ID", "书名", "作者（生–卒）", "最大卒年", "预估 chunk", "需人工复核"]))
    lines.append(row(["---"] * 7))
    for e in group_a:
        lines.append(row([
            str(e["rank"]),
            f"[{e['id']}]({url(e['id'])})",
            esc(e["title"])[:60],
            esc(authors_text(e))[:70],
            str(e["verdict"]["maxDeathYear"]),
            f"{e['estimatedChunks']:,}" if e.get("estimatedChunks") else "?",
            "是" if e["uncertainties"] else "—",
        ]))
    lines.append("")

    # ---- 不确定项明细（仅 A 组）----
    uncertain_a = [(e, u) for e in group_a for u in e["uncertainties"]]
    lines.append(f"**A 组中 {len([e for e in group_a if e['uncertainties']])} 本带需人工复核项：**")
    lines.append("")
    for e, u in uncertain_a:
        lines.append(f"- **{e['id']}** {esc(e['title'])[:50]} — {u}")
        contrib = contributors_text(e)
        if contrib:
            lines.append(f"  - 贡献者：{contrib}")
            lines.append(f"  - 正文：{e.get('txtBytes') or '?'} 字节，RDF：`{e.get('txtUrl') or 'n/a'}`")
    lines.append("")

    # ---- B 组 ----
    lines.append(f"### B 组：备选 {len(group_b)} 本（建议不纳入，理由如下）")
    lines.append("")
    lines.append(row(["#", "PG ID", "书名", "作者（生–卒）", "最大卒年", "预估 chunk", "建议剔除理由"]))
    lines.append(row(["---"] * 7))
    for e in group_b:
        lines.append(row([
            str(e["rank"]),
            f"[{e['id']}]({url(e['id'])})",
            esc(e["title"])[:60],
            esc(authors_text(e))[:70],
            str(e["verdict"]["maxDeathYear"]),
            f"{e['estimatedChunks']:,}" if e.get("estimatedChunks") else "?",
            BACKUP_GROUP.get(e["id"], ""),
        ]))
    lines.append("")

    # ---- C 组 ----
    lines.append(f"### C 组：未通过版权口径 {len(skipped)} 本（不抓取）")
    lines.append("")
    lines.append(row(["#", "PG ID", "书名 / 榜单锚文本", "判定结果", "依据（RDF 原文）"]))
    lines.append(row(["---"] * 5))
    for e in skipped:
        lines.append(row([
            str(e["rank"]),
            f"[{e['id']}]({url(e['id'])})",
            esc(e["title"] or e["anchorTitle"])[:52],
            e["verdict"]["code"],
            esc(e["verdict"]["detail"])[:70],
        ]))
    lines.append("")

    # ---- rights 原文 ----
    lines.append("### rights 原文（A 组逐本，来自 RDF `dcterms:rights`）")
    lines.append("")
    rights_map: dict[str, int] = {}
    for e in group_a:
        rights_map[esc(e["rights"])] = rights_map.get(esc(e["rights"]), 0) + 1
    for text, count in sorted(rights_map.items(), key=lambda kv: -kv[1]):
        lines.append(f"- `{text}` — {count} 本")
    lines.append("")
    lines.append(f"- 已入库 10 本的 rights 同样为 `Public domain in the USA.`（Stage 1 manifest 记录）")
    lines.append("")

    # ---- 规模预估 ----
    est_a = sum(e.get("estimatedChunks") or 0 for e in group_a)
    est_b = sum(e.get("estimatedChunks") or 0 for e in group_b)
    lines.append("### 规模预估（外推，非实测）")
    lines.append("")
    lines.append(f"- A 组预估 chunk：{est_a:,}")
    lines.append(f"- B 组预估 chunk：{est_b:,}（若一并纳入）")
    lines.append(f"- 现有库内：24,244 chunk / 10 本")
    lines.append(f"- 纳入 A 组后合计：约 {24_244 + est_a:,} chunk / 30 本")
    lines.append("")

    out_path = Path(args.out)
    out_path.write_text("\n".join(lines), encoding="utf-8")
    print(f"已渲染 {len(group_a)} 本主表 + {len(group_b)} 本备选 + {len(skipped)} 本被拒 → {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
