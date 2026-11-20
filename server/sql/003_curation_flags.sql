-- 003 · 人工治理标记列（Stage C）
--
-- 目的：给需要人工复核的书加「标记」，而不是改原值。
--   2680  译本，译者/译本来源待人工确认 → translator_source_unverified
--   76639 标题含 MARC 子字段符 "$b"，清洗规则待确认 → title_cleanup_pending
--
-- 约束：本迁移只增加一个可空列 + 注释，
--       不修改 title / author_display / authors / contributors 等任何既有数据。

BEGIN;

ALTER TABLE discovered_books
  ADD COLUMN IF NOT EXISTS curation_flags jsonb;

COMMENT ON COLUMN discovered_books.curation_flags IS
  '人工治理标记（只读提示，不改原值）。键：translator_source_unverified（译者/译本来源待人工确认）、title_cleanup_pending（标题清洗规则待确认）。值示例：{"translator_source_unverified":{"note":"...","flagged_at":"2026-10-11"}}';

COMMIT;
