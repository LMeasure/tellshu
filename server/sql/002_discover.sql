-- =============================================================================
-- 述树 · 发现书籍链路（Stage 1+）专用表
--
-- 背景：旁路链路「发现书籍 → 合规抓取 → 入库 → 切块 → 本地 embedding → pgvector 检索」。
-- 本脚本只 **新增** 两张表，不修改 OCR / 词典链路已有的
-- entries / toc / grammar_rules / words / scan_records。
--
-- 幂等：扩展、表、索引全部使用 IF NOT EXISTS / ON CONFLICT DO NOTHING 风格，可重复执行。
--
-- 应用方式（本机实测）：
--   cd server && npm run db:migrate
-- db:migrate 按文件名升序执行 sql/ 目录下的全部 .sql（当前 001 → 002），幂等可重复执行。
-- （一次性工具 apply-sql 仍保留，但不再需要它来应用本文件。）
--
-- 变更记录：
--   Stage 1.5 新增 embedding_recipe 列 —— 用于区分两代 embedding 输入格式：
--     v1-book-chapter         旧格式（2026-10-08 生成）："Book: X\nChapter: Y\n\n正文"
--     v2-title-author-chapter 新格式（Stage 1.5 起）：   "Title: X\nAuthor: Y\nChapter: Z\n正文"
--   旧的 v1 向量在重跑前会备份到 discovered_book_chunks_emb_v1，不静默丢弃。
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 扩展：pgvector 0.8.6（已装入本机 PostgreSQL 18）
-- -----------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS vector;

-- -----------------------------------------------------------------------------
-- discovered_books：书籍 metadata（不含正文）
-- 唯一键 (source_site, source_id)：同一来源的书重复 ingest 只更新、不新增。
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS discovered_books (
  id                    BIGSERIAL PRIMARY KEY,
  source_site           TEXT        NOT NULL,
  source_id             TEXT        NOT NULL,
  source_url            TEXT        NOT NULL,
  title                 TEXT,
  alternative_title     TEXT,
  author_display        TEXT,
  description           TEXT,
  description_source    TEXT,
  rights                TEXT,
  license_raw           TEXT,
  license_url           TEXT,
  language              TEXT,
  issued                DATE,
  cover_url             TEXT,
  toc_from_rdf          TEXT,
  subjects_lcsh         TEXT[]      NOT NULL DEFAULT '{}',
  bookshelves           TEXT[]      NOT NULL DEFAULT '{}',
  reading_ease          TEXT,
  rank_in_top_list      INTEGER,
  copyright_policy      TEXT        NOT NULL DEFAULT 'A',
  copyright_reason_code TEXT,
  max_author_death_year INTEGER,
  authors               JSONB       NOT NULL DEFAULT '[]'::jsonb,
  contributors          JSONB       NOT NULL DEFAULT '[]'::jsonb,
  text_url              TEXT        NOT NULL,
  text_sha256           TEXT        NOT NULL,
  crawl_time            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT discovered_books_source_unique UNIQUE (source_site, source_id)
);

COMMENT ON TABLE  discovered_books IS '发现书籍链路：书籍 metadata（不含正文），Stage 1 数据源为 Project Gutenberg';
COMMENT ON COLUMN discovered_books.rights IS '逐本取自 RDF 的 dcterms:rights 原文，不做任何推断';
COMMENT ON COLUMN discovered_books.max_author_death_year IS '版权口径 A：所有作者/贡献者卒年的最大值，用于复核 ≤1975';

CREATE INDEX IF NOT EXISTS discovered_books_language_idx ON discovered_books (language);

-- -----------------------------------------------------------------------------
-- discovered_book_chunks：切块后的正文片段 + BGE-M3 1024 维 dense embedding
-- 唯一键 (book_id, chunk_index)：重复 ingest 保证幂等，不产生重复 chunk。
-- embedding 允许为 NULL：正文已入库但 embedding 失败的块不会被静默丢弃，
-- 而是留待补跑，检索时用 IS NOT NULL 过滤。
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS discovered_book_chunks (
  id             BIGSERIAL PRIMARY KEY,
  book_id        BIGINT      NOT NULL REFERENCES discovered_books (id) ON DELETE CASCADE,
  chunk_index    INTEGER     NOT NULL,
  chapter_title  TEXT,
  chapter_number INTEGER,
  content        TEXT        NOT NULL,
  content_chars  INTEGER     NOT NULL,
  embedding      VECTOR(1024),
  embedding_model TEXT       NOT NULL DEFAULT 'BAAI/bge-m3',
  embedding_dim  INTEGER     NOT NULL DEFAULT 1024,
  -- 见文件头「变更记录」：区分 v1 / v2 两代 embedding 输入格式，防止新旧向量混用而无人察觉
  embedding_recipe TEXT      NOT NULL DEFAULT 'v1-book-chapter',
  source_sha256  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT discovered_book_chunks_unique UNIQUE (book_id, chunk_index)
);

COMMENT ON COLUMN discovered_book_chunks.embedding IS 'normalize_embeddings=True 的单位向量，用 <=> 做余弦距离';

-- 已存在的库（002 之前就建好的表）补齐 embedding_recipe 列；
-- 默认值取 v1，保证「没写 recipe 的行一律视为旧格式」这个保守口径成立。
ALTER TABLE discovered_book_chunks
  ADD COLUMN IF NOT EXISTS embedding_recipe TEXT NOT NULL DEFAULT 'v1-book-chapter';

COMMENT ON COLUMN discovered_book_chunks.embedding_recipe IS
  'embedding 输入格式版本：v1-book-chapter / v2-title-author-chapter；用于 A/B 与防混用';

CREATE INDEX IF NOT EXISTS discovered_book_chunks_recipe_idx
  ON discovered_book_chunks (embedding_recipe);

-- HNSW + vector_cosine_ops：pgvector 0.8.6 已在本机验证可用
CREATE INDEX IF NOT EXISTS discovered_book_chunks_embedding_hnsw_idx
  ON discovered_book_chunks USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS discovered_book_chunks_book_idx
  ON discovered_book_chunks (book_id);

COMMIT;
