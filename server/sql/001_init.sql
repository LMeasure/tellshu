-- =============================================================================
-- 述树 · 后端初始数据库结构
-- 执行：npm run db:migrate   （等价于 psql "$DATABASE_URL" -f sql/001_init.sql）
-- 本脚本幂等：表 / 索引 / 函数均使用 IF NOT EXISTS / CREATE OR REPLACE。
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 扩展：pg_trgm 提供 trigram 模糊匹配；pgcrypto 提供 gen_random_uuid()
-- -----------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- -----------------------------------------------------------------------------
-- 全局递增序列：entries / toc / grammar_rules 共用，使「一次 since 游标」即可
-- 跨表增量同步，避免各表自增列各自为政导致的漏读。
-- -----------------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS dictionary_sync_seq AS bigint START WITH 1 INCREMENT BY 1;

-- -----------------------------------------------------------------------------
-- 辅助函数
-- -----------------------------------------------------------------------------

-- 归一化键：去首尾空白、折叠内部连续空白、转小写。
CREATE OR REPLACE FUNCTION shutree_normalize_key(input text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT lower(btrim(regexp_replace(coalesce(input, ''), '\s+', ' ', 'g')));
$$;

-- 文本数组拼成空格分隔字符串（供 tsvector 生成列使用；自身声明为 IMMUTABLE）。
CREATE OR REPLACE FUNCTION shutree_text_array_to_text(input text[])
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT coalesce(array_to_string(input, ' '), '');
$$;

-- 合并标量文本：已有值非空则保留已有值（仅补空，不覆盖）；否则取新值。
CREATE OR REPLACE FUNCTION shutree_merge_text(existing text, incoming text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN existing IS NOT NULL AND btrim(existing) <> '' THEN existing
    WHEN incoming IS NULL OR btrim(incoming) = '' THEN coalesce(existing, '')
    ELSE btrim(incoming)
  END;
$$;

-- 合并文本数组：去空白项后按字面去重（保序性不做保证，仅保证集合正确）。
CREATE OR REPLACE FUNCTION shutree_merge_text_array(existing text[], incoming text[])
RETURNS text[]
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT ARRAY(
    SELECT DISTINCT btrim(x)
    FROM unnest(coalesce(existing, '{}'::text[]) || coalesce(incoming, '{}'::text[])) AS t(x)
    WHERE x IS NOT NULL AND btrim(x) <> ''
  );
$$;

-- 合并 JSONB 数组（例句 / 短语等）：按整体值去重。
CREATE OR REPLACE FUNCTION shutree_merge_jsonb_array(existing jsonb, incoming jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  base jsonb := CASE WHEN jsonb_typeof(coalesce(existing, '[]'::jsonb)) = 'array'
                     THEN coalesce(existing, '[]'::jsonb) ELSE '[]'::jsonb END;
  tail jsonb := CASE WHEN jsonb_typeof(coalesce(incoming, '[]'::jsonb)) = 'array'
                     THEN coalesce(incoming, '[]'::jsonb) ELSE '[]'::jsonb END;
BEGIN
  RETURN (
    SELECT coalesce(jsonb_agg(DISTINCT elem), '[]'::jsonb)
    FROM (
      SELECT jsonb_array_elements(base) AS elem
      UNION ALL
      SELECT jsonb_array_elements(tail) AS elem
    ) AS merged
  );
END;
$$;

-- JSONB 数组按指定字段去重合并（例句按 en 去重、短语按 text 去重）。
CREATE OR REPLACE FUNCTION shutree_merge_jsonb_array_by_key(
  existing jsonb,
  incoming jsonb,
  key_name text
)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  base jsonb := CASE WHEN jsonb_typeof(coalesce(existing, '[]'::jsonb)) = 'array'
                     THEN coalesce(existing, '[]'::jsonb) ELSE '[]'::jsonb END;
  tail jsonb := CASE WHEN jsonb_typeof(coalesce(incoming, '[]'::jsonb)) = 'array'
                     THEN coalesce(incoming, '[]'::jsonb) ELSE '[]'::jsonb END;
BEGIN
  RETURN (
    SELECT coalesce(jsonb_agg(elem), '[]'::jsonb)
    FROM (
      SELECT DISTINCT ON (coalesce(elem ->> key_name, elem::text)) elem
      FROM (
        SELECT jsonb_array_elements(base) AS elem
        UNION ALL
        SELECT jsonb_array_elements(tail) AS elem
      ) AS all_elems
      WHERE jsonb_typeof(elem) = 'object'
      ORDER BY coalesce(elem ->> key_name, elem::text), elem
    ) AS deduped
  );
END;
$$;

-- 触发器：写入 / 更新时推进共享同步序号并刷新 updated_at。
CREATE OR REPLACE FUNCTION shutree_touch_sync_seq()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.sync_seq := nextval('dictionary_sync_seq');
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- 触发器：仅刷新 updated_at（scan_records 不参与增量同步游标）。
CREATE OR REPLACE FUNCTION shutree_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- -----------------------------------------------------------------------------
-- 词条表
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS entries (
  id            bigserial PRIMARY KEY,

  word          text NOT NULL,
  word_key      text GENERATED ALWAYS AS (shutree_normalize_key(word)) STORED,

  phonetic      text,
  pos           text NOT NULL DEFAULT '',
  pos_key       text GENERATED ALWAYS AS (shutree_normalize_key(pos)) STORED,

  definition_en text NOT NULL DEFAULT '',
  definition_zh text NOT NULL DEFAULT '',

  -- 义项分组：[{ definitionEn, definitionZh, examples: [{en, zh}] }]；例句挂在所属释义下
  senses        jsonb   NOT NULL DEFAULT '[]'::jsonb,

  examples      jsonb   NOT NULL DEFAULT '[]'::jsonb,
  phrases       jsonb   NOT NULL DEFAULT '[]'::jsonb,
  synonyms      text[]  NOT NULL DEFAULT '{}'::text[],
  antonyms      text[]  NOT NULL DEFAULT '{}'::text[],
  tags          text[]  NOT NULL DEFAULT '{}'::text[],

  root_affix    text,
  source_page   integer,
  source_book   text NOT NULL DEFAULT '',

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  sync_seq      bigint      NOT NULL DEFAULT 0,

  -- 严格唯一键：归一化词 + 归一化词性
  CONSTRAINT entries_word_pos_unique UNIQUE (word_key, pos_key),

  CONSTRAINT entries_word_not_blank CHECK (btrim(word) <> ''),
  CONSTRAINT entries_examples_is_array CHECK (jsonb_typeof(examples) = 'array'),
  CONSTRAINT entries_phrases_is_array CHECK (jsonb_typeof(phrases) = 'array'),
  CONSTRAINT entries_senses_is_array CHECK (jsonb_typeof(senses) = 'array')
);

-- 存量库升级：senses 列（2026-10-06 新增，幂等）
ALTER TABLE entries ADD COLUMN IF NOT EXISTS senses jsonb NOT NULL DEFAULT '[]'::jsonb;

-- 全文检索列（英文走 english 分词，中文走 simple 分词）。
-- 仅在列不存在时添加，避免重复迁移把已有数据重写一遍。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'entries'
      AND column_name = 'search_tsv'
  ) THEN
    ALTER TABLE entries
      ADD COLUMN search_tsv tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce(word, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(definition_en, '')), 'B') ||
        setweight(to_tsvector('simple', coalesce(definition_zh, '')), 'B') ||
        setweight(to_tsvector('english', shutree_text_array_to_text(synonyms)), 'C') ||
        setweight(to_tsvector('english', shutree_text_array_to_text(antonyms)), 'C') ||
        setweight(to_tsvector('english', shutree_text_array_to_text(tags)), 'D')
      ) STORED;
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS entries_search_tsv_idx   ON entries USING gin (search_tsv);
CREATE INDEX IF NOT EXISTS entries_word_key_trgm_idx ON entries USING gin (word_key gin_trgm_ops);
CREATE INDEX IF NOT EXISTS entries_word_key_prefix_idx ON entries (word_key text_pattern_ops);
CREATE INDEX IF NOT EXISTS entries_sync_seq_idx     ON entries (sync_seq);
CREATE INDEX IF NOT EXISTS entries_source_book_idx  ON entries (source_book);

DROP TRIGGER IF EXISTS entries_touch_sync_seq ON entries;
CREATE TRIGGER entries_touch_sync_seq
  BEFORE INSERT OR UPDATE ON entries
  FOR EACH ROW EXECUTE FUNCTION shutree_touch_sync_seq();

-- -----------------------------------------------------------------------------
-- 目录（TOC）表：自引用树
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS toc (
  id          bigserial PRIMARY KEY,

  source_book text NOT NULL DEFAULT '',
  title       text NOT NULL,
  title_key   text GENERATED ALWAYS AS (shutree_normalize_key(title)) STORED,

  parent_id   bigint REFERENCES toc (id) ON DELETE SET NULL,

  page_start  integer NOT NULL DEFAULT 0,
  page_end    integer,
  order_index integer NOT NULL DEFAULT 0,

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  sync_seq    bigint      NOT NULL DEFAULT 0,

  -- 严格唯一键：书目 + 归一化标题 + 起始页
  CONSTRAINT toc_book_title_page_unique UNIQUE (source_book, title_key, page_start),
  CONSTRAINT toc_title_not_blank CHECK (btrim(title) <> ''),
  CONSTRAINT toc_page_range_valid CHECK (page_end IS NULL OR page_end >= page_start)
);

CREATE INDEX IF NOT EXISTS toc_parent_idx     ON toc (parent_id);
CREATE INDEX IF NOT EXISTS toc_book_order_idx ON toc (source_book, order_index);
CREATE INDEX IF NOT EXISTS toc_sync_seq_idx   ON toc (sync_seq);

DROP TRIGGER IF EXISTS toc_touch_sync_seq ON toc;
CREATE TRIGGER toc_touch_sync_seq
  BEFORE INSERT OR UPDATE ON toc
  FOR EACH ROW EXECUTE FUNCTION shutree_touch_sync_seq();

-- -----------------------------------------------------------------------------
-- 语法规则表（不规则动词、名词复数等）
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS grammar_rules (
  id              bigserial PRIMARY KEY,

  type            text NOT NULL DEFAULT '',
  base_form       text NOT NULL,
  base_form_key   text GENERATED ALWAYS AS (shutree_normalize_key(base_form)) STORED,

  past_tense      text,
  past_participle text,
  extra           jsonb NOT NULL DEFAULT '{}'::jsonb,

  source_book     text NOT NULL DEFAULT '',
  source_page     integer,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  sync_seq        bigint      NOT NULL DEFAULT 0,

  -- 严格唯一键：规则类型 + 归一化原形
  CONSTRAINT grammar_type_base_unique UNIQUE (type, base_form_key),
  CONSTRAINT grammar_base_not_blank CHECK (btrim(base_form) <> ''),
  CONSTRAINT grammar_extra_is_object CHECK (jsonb_typeof(extra) = 'object')
);

CREATE INDEX IF NOT EXISTS grammar_type_idx    ON grammar_rules (type);
CREATE INDEX IF NOT EXISTS grammar_sync_seq_idx ON grammar_rules (sync_seq);
CREATE INDEX IF NOT EXISTS grammar_base_trgm_idx ON grammar_rules USING gin (base_form_key gin_trgm_ops);

DROP TRIGGER IF EXISTS grammar_rules_touch_sync_seq ON grammar_rules;
CREATE TRIGGER grammar_rules_touch_sync_seq
  BEFORE INSERT OR UPDATE ON grammar_rules
  FOR EACH ROW EXECUTE FUNCTION shutree_touch_sync_seq();

-- -----------------------------------------------------------------------------
-- 扫描记录表：原始图片相对路径 + OCR 原始 JSON + 状态 + 用途 + 解析规则
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scan_records (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  batch_id      text NOT NULL,
  job_id        text,

  source_book   text NOT NULL DEFAULT '',
  purpose       text NOT NULL DEFAULT 'material'
                CHECK (purpose IN ('material', 'dictionary')),
  page_kind     text NOT NULL DEFAULT 'unknown'
                CHECK (page_kind IN ('material', 'toc', 'entry', 'table', 'instruction', 'unknown')),

  status        text NOT NULL DEFAULT 'queued'
                CONSTRAINT scan_records_status_check
                CHECK (status IN ('queued', 'pending', 'running', 'parsed', 'done', 'failed')),

  -- 原始图片：本地相对路径（相对 OCR_STORAGE_DIR），绝不在库中保存绝对盘符路径
  image_path    text,
  image_name    text,
  mime_type     text,
  size_bytes    integer NOT NULL DEFAULT 0,
  page_number   integer,

  result_text   text,
  raw_ocr_json  jsonb,
  parser_rules  jsonb,
  -- 待确认的结构化草稿（status='parsed' 时有值；确认入库后仍保留，供追溯）
  parsed_drafts jsonb,

  error_code    text,
  error_message text,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT scan_records_size_range CHECK (size_bytes >= 0 AND size_bytes <= 52428800)
);

-- 存量库升级（2026-10-06，幂等）：
--   ① scan_records 补 parsed_drafts 列；
--   ② status CHECK 换成含 'parsed' 的新版（旧库的约束是未命名内联 CHECK，直接替换）。
ALTER TABLE scan_records ADD COLUMN IF NOT EXISTS parsed_drafts jsonb;
ALTER TABLE scan_records DROP CONSTRAINT IF EXISTS scan_records_status_check;
ALTER TABLE scan_records ADD CONSTRAINT scan_records_status_check
  CHECK (status IN ('queued', 'pending', 'running', 'parsed', 'done', 'failed'));

CREATE INDEX IF NOT EXISTS scan_records_batch_idx  ON scan_records (batch_id);
CREATE INDEX IF NOT EXISTS scan_records_status_idx ON scan_records (status);
CREATE INDEX IF NOT EXISTS scan_records_book_kind_idx ON scan_records (source_book, page_kind);
CREATE INDEX IF NOT EXISTS scan_records_job_idx    ON scan_records (job_id);

DROP TRIGGER IF EXISTS scan_records_touch_updated_at ON scan_records;
CREATE TRIGGER scan_records_touch_updated_at
  BEFORE UPDATE ON scan_records
  FOR EACH ROW EXECUTE FUNCTION shutree_touch_updated_at();

-- -----------------------------------------------------------------------------
-- 内置词库表（2026-10-06 新增）：5 本词本（CET4/CET6/TEM8/TOEFL/GRE8000）入字库，
-- 作为全局搜索的服务端底座。数据由 `npm run db:seed-words` 从
-- data/linguabase/v1/search-index.json（22,791 条，去重后约 1.4 万词）幂等导入。
-- 一词一行：同一词被多本收录时聚合进 books，不再展开成多行。
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS words (
  id            text PRIMARY KEY,   -- 源数据 id（如 oe-abacus，跨词本稳定）
  word          text NOT NULL,
  -- 检索键：小写去空白，生成列免维护
  word_key      text GENERATED ALWAYS AS (lower(btrim(word))) STORED,
  ipa           text,               -- 音标（源数据单一字段，来源为英音；缺失 = 未收录）
  pos           text,
  definition_zh text NOT NULL DEFAULT '',
  -- 收录该词的词本 [{id,name}]（如 [{"id":"CET4","name":"CET-4 四级"}]）
  books         jsonb  NOT NULL DEFAULT '[]'::jsonb,
  min_level     smallint NOT NULL DEFAULT 3,  -- 各词本 difficulty_level 的最小值
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT words_word_not_blank CHECK (btrim(word) <> ''),
  CONSTRAINT words_books_is_array CHECK (jsonb_typeof(books) = 'array'),
  CONSTRAINT words_level_range CHECK (min_level BETWEEN 1 AND 9)
);

CREATE INDEX IF NOT EXISTS words_word_key_idx ON words (word_key);
-- 前缀检索走 text_pattern_ops（非 C locale 下 btree 不服务 LIKE 'x%'）
CREATE INDEX IF NOT EXISTS words_prefix_idx ON words (word_key text_pattern_ops);

DROP TRIGGER IF EXISTS words_touch_updated_at ON words;
CREATE TRIGGER words_touch_updated_at
  BEFORE UPDATE ON words
  FOR EACH ROW EXECUTE FUNCTION shutree_touch_updated_at();

COMMIT;
