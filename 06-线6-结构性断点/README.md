# 06 · 线6：结构性断点（产品功能断点，不是 bug）

> **这是干什么的**：述树最关键的产品缺口——**用户导入的书和「发现」里的书是两套世界，互不相通；知识库 / AI 问答根本不存在**。打通它，用户才能「找到书 → 入架 → 阅读 → 问答」。

## 现状：线6 MVP（B7-A）实现中，尚未合并
- **B7-A「先入架后全文」已于 2026-11-20 由负责人批准。** 实现在分支 `feature/line6-booklink-shelf` 上进行；**尚未合并，未经独立核验。**
- 导入书 → Dexie（`ReadingDoc`），发现书 → PG（`discovered_books` / `discovered_book_chunks`），中间仍无 `user_books`。本轮只把发现书以 `source_site='gutenberg'`、`source_id`（= API `book_id`）快照写入本地书架；正文为空，阅读器显示「正文待接入」，不编造正文。
- 知识库 / AI 问答：无表、无页（`Search.tsx` 静态「即将上线」），LLM 唯一调用只服务字幕→学习稿，与 chunks 零交集。本轮不做。

## 卡点
- **B7 已拍板为 A**（2026-11-20，负责人）：先入架后全文。方案 B（等线4 完整架构）未选。
- 正文阅读与真正的 Gutenberg `source_id` 透出仍依赖线4 / PG，不在本分支。
- 完整打通依赖线4 的 O-4A 授权 → L4/L5/L6 → 阶段 1B（见线4 门牌）。

## 关键文件
| 文件 | 用途 |
|---|---|
| `线6-MVP实现方案与文件变更清单.md` | MVP 落地方案与文件清单 |
| `述树找书与知识库问答-现状架构审计报告.md` | 断点现状审计（实测数字） |
| `产品前提卡-发现书籍数据源-*.md/.diff`（5 份） | 发现书籍数据源治理的合并差异与对照 |

## 相关源码（根目录原位）
`src/pages/Discover.tsx` · `src/components/discover/BookSearchPanel.tsx` · `src/services/storage/web.ts`（ReadingDoc）

## 红线
不编造正文 / 释义；查不到显示「未收录 / 待接入」；空数据走 EmptyState。
