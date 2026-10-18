-- 004 · 格式转换（复用 server/ 与现有 pg 连接池）
--
-- 目的：为「导入页·格式转换」提供文件与任务持久化。
--   转换引擎（Python Worker）异步消费 WAITING 任务，写回结果文件与状态。
--
-- 约束：幂等；不修改任何既有表/数据。convert_files 命名仅用 uuid，
--       原文件名不进入物理路径（防路径穿越）。

BEGIN;

CREATE TABLE IF NOT EXISTS convert_files (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  original_name text        NOT NULL,
  format        text        NOT NULL,
  mime_type     text        NOT NULL DEFAULT '',
  size_bytes    bigint      NOT NULL DEFAULT 0,
  storage_path  text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS convert_tasks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id         uuid NOT NULL REFERENCES convert_files(id) ON DELETE CASCADE,
  source_format   text NOT NULL,
  target_format   text NOT NULL,
  status          text NOT NULL DEFAULT 'waiting'
                  CHECK (status IN ('waiting','processing','success','failed')),
  progress        int  NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  result_file_id  uuid NULL REFERENCES convert_files(id) ON DELETE SET NULL,
  error_message   text NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz NULL
);

COMMENT ON TABLE convert_files IS '格式转换：上传源文件与转换结果文件（按 uuid 落盘，原文件名不进入路径）';
COMMENT ON TABLE convert_tasks IS '格式转换任务；worker 轮询 waiting 任务，写回 status/result_file_id';

CREATE INDEX IF NOT EXISTS convert_tasks_status_idx ON convert_tasks (status);
CREATE INDEX IF NOT EXISTS convert_tasks_created_idx ON convert_tasks (created_at);

COMMIT;
