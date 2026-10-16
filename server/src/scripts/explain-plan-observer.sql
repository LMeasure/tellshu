-- =============================================================================
-- discover_plan_observe() —— 发现书籍检索「执行计划观测函数」
--
-- 用途：持续监控 pgvector 检索是否退化。B.6 发现 ef=200/400 时优化器会放弃 HNSW，
--       改用 discovered_book_chunks_book_idx 做全量排序（FALLBACK，518ms，比 EXACT
--       还慢一倍），而 ef=800 又跳回 HNSW —— 退化区是「区间」不是「阈值」，
--       所以必须持续观测，不能一次性测完就放心。
--
-- 用法：
--   SELECT * FROM discover_plan_observe('[0.01,-0.02,...]'::vector(1024), 800, 'strict_order');
--
-- 输出：
--   plan_type        HNSW | FALLBACK | EXACT | UNKNOWN
--   scan_node        Seq Scan / Index Scan / ...
--   index_name       实际用到的索引名（路径判据只认名字，不认节点类型）
--   latency_ms       EXPLAIN ANALYZE 的 Execution Time
--   rows_returned    Limit 节点实际返回行数（饥饿时会 < top_k）
--   shared_hit/read  buffer 命中 / 读取
--   buffer_hit_ratio hit / (hit + read)
--
-- 安装说明（重要）：
--   ⚠ 本文件**默认不安装到正式库**。B.7 全程遵循「只读优先、不触碰正式资产」，
--     建函数属于 schema 变更，需要你明确授权后再执行：
--       psql "$DATABASE_URL" -f server/src/scripts/explain-plan-observer.sql
--   本轮 §3 的实测数据由等价的客户端观测器 plan-observer.py 产出（零 schema 变更）。
--
-- 设计说明：
--   · GUC 一律用 set_config(..., true)（等价 SET LOCAL），随事务结束自动失效，
--     绝不污染连接池、绝不改 postgresql.conf。
--   · 函数只读主表，不写任何数据。
-- =============================================================================

CREATE OR REPLACE FUNCTION discover_plan_observe(
    p_embedding          vector(1024),
    p_ef_search          int  DEFAULT NULL,   -- NULL = 走 EXACT（禁用索引）
    p_iterative_scan     text DEFAULT 'off',  -- off | strict_order | relaxed_order
    p_top_k              int  DEFAULT 10,
    p_filtered           boolean DEFAULT true -- true = 带 chapter_title IS NOT NULL 过滤（生产口径）
)
RETURNS TABLE (
    plan_type        text,
    scan_node        text,
    index_name       text,
    latency_ms       numeric,
    rows_returned    bigint,
    shared_hit       bigint,
    shared_read      bigint,
    buffer_hit_ratio numeric
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_sql       text;
    v_where     text;
    v_json      jsonb;
    v_idx       text;
    v_scan      text;
    v_hit       bigint := 0;
    v_read      bigint := 0;
    v_ratio     numeric;
BEGIN
    -- ---- 1. 设置 GUC（事务内，不污染全局）----
    IF p_ef_search IS NULL THEN
        -- EXACT：关掉所有索引扫描，只留 Seq Scan
        PERFORM set_config('enable_indexscan',    'off', true);
        PERFORM set_config('enable_bitmapscan',   'off', true);
        PERFORM set_config('enable_indexonlyscan','off', true);
        PERFORM set_config('enable_seqscan',      'on',  true);
    ELSE
        PERFORM set_config('hnsw.ef_search', p_ef_search::text, true);
        PERFORM set_config('enable_seqscan', 'off', true);
    END IF;
    PERFORM set_config('hnsw.iterative_scan', p_iterative_scan, true);

    -- ---- 2. 拼生产检索 SQL（与 search-discover.py 同形状）----
    v_where := 'c.embedding IS NOT NULL';
    IF p_filtered THEN
        v_where := v_where || ' AND c.chapter_title IS NOT NULL';
    END IF;

    v_sql := format(
        'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) '
        'SELECT b.id, b.title, c.chunk_index, c.chapter_title, '
        '1 - (c.embedding <=> %L::vector) AS similarity '
        'FROM discovered_book_chunks c JOIN discovered_books b ON b.id = c.book_id '
        'WHERE %s ORDER BY c.embedding <=> %L::vector LIMIT %s',
        p_embedding::text, v_where, p_embedding::text, p_top_k
    );

    EXECUTE v_sql INTO v_json;
    v_json := (v_json -> 0);            -- EXPLAIN FORMAT JSON 返回单元素数组

    -- ---- 3. 递归遍历计划树，取索引名 / 扫描节点 / buffer ----
    WITH RECURSIVE walk AS (
        SELECT (v_json -> 'Plan') AS node
        UNION ALL
        SELECT child.value
        FROM walk w, jsonb_array_elements(COALESCE(w.node -> 'Plans', '[]'::jsonb)) AS child(value)
    )
    SELECT
        (SELECT node ->> 'Index Name' FROM walk WHERE node ->> 'Index Name' IS NOT NULL LIMIT 1),
        (SELECT node ->> 'Node Type'  FROM walk
          WHERE node ->> 'Node Type' LIKE '%Scan%' LIMIT 1),
        COALESCE((SELECT sum((node ->> 'Shared Hit Blocks')::bigint)  FROM walk), 0),
        COALESCE((SELECT sum((node ->> 'Shared Read Blocks')::bigint) FROM walk), 0)
    INTO v_idx, v_scan, v_hit, v_read;

    -- ---- 4. 判定：只认索引名 ----
    plan_type := CASE
        WHEN v_idx = 'discovered_book_chunks_embedding_hnsw_idx' THEN 'HNSW'
        WHEN v_idx IS NOT NULL                                   THEN 'FALLBACK'
        WHEN v_scan = 'Seq Scan'                                 THEN 'EXACT'
        ELSE 'UNKNOWN'
    END;

    scan_node     := COALESCE(v_scan, v_json -> 'Plan' ->> 'Node Type');
    index_name    := COALESCE(v_idx, '—（无索引）');
    latency_ms    := round((v_json ->> 'Execution Time')::numeric, 3);
    rows_returned := (v_json -> 'Plan' ->> 'Actual Rows')::bigint;
    shared_hit    := v_hit;
    shared_read   := v_read;
    buffer_hit_ratio := CASE
        WHEN (v_hit + v_read) > 0 THEN round(v_hit::numeric / (v_hit + v_read), 4)
        ELSE NULL
    END;

    RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION discover_plan_observe IS
'B.7 执行计划观测：判定检索走 HNSW / FALLBACK / EXACT。'
'路径判据只认索引名（discovered_book_chunks_embedding_hnsw_idx）。'
'GUC 全部事务内 set_config(..., true)，不污染全局。';

-- -----------------------------------------------------------------------------
-- 一次性巡检：把 ef ∈ {40,120,200,400,800} 全跑一遍，直接看出退化区
-- （需要先把 :'qvec' 换成真实 1024 维向量字面量）
-- -----------------------------------------------------------------------------
-- \set qvec '[...]'
-- SELECT 40  AS ef, * FROM discover_plan_observe(:'qvec'::vector(1024), 40,  'strict_order')
-- UNION ALL SELECT 120, * FROM discover_plan_observe(:'qvec'::vector(1024), 120, 'strict_order')
-- UNION ALL SELECT 200, * FROM discover_plan_observe(:'qvec'::vector(1024), 200, 'strict_order')
-- UNION ALL SELECT 400, * FROM discover_plan_observe(:'qvec'::vector(1024), 400, 'strict_order')
-- UNION ALL SELECT 800, * FROM discover_plan_observe(:'qvec'::vector(1024), 800, 'strict_order');
