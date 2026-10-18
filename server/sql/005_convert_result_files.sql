-- 005 · 格式转换结果多文件支持（PDF→PNG 每页一张等场景）
--
-- 目的：convert_tasks 增加 result_files(jsonb)，记录一次任务产出的全部结果文件 id；
--       result_file_id 仍保留为「主结果」（下载路由默认返回第一个，兼容单文件下载）。
--
-- 该列由 Python Worker 的 commit_success 写入；纯扩展，不修改既有列与数据。
-- 幂等：仅在列不存在时添加。

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'convert_tasks' AND column_name = 'result_files'
  ) THEN
    ALTER TABLE convert_tasks ADD COLUMN result_files jsonb NULL;
    COMMENT ON COLUMN convert_tasks.result_files IS
      '一次任务产出的全部结果文件 id 列表（jsonb 数组）；多页 PDF→PNG 等场景用，主结果仍看 result_file_id';
  END IF;
END $$;

COMMIT;
