-- Migration 007: Restore fixed-dim + HNSW on TES prod (and any deployment
-- that uses a single consistent embedding dimension).
--
-- Only runs if:
--   * embedding_vec is currently dimensionless (post-006 state), AND
--   * all existing JSONB embeddings have the same dimension, AND
--   * there are enough rows to make it worthwhile (>= 100)
--
-- For local setups with <100 memories or mixed dimensions, this migration
-- is a no-op — the dimensionless column keeps working.

DO $$
DECLARE
  uniform_dim INTEGER;
  row_count INTEGER;
  dim_count INTEGER;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    RETURN;
  END IF;

  -- Already indexed? skip.
  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'memory_nodes'
      AND indexname = 'idx_memory_nodes_embedding_vec'
  ) THEN
    RETURN;
  END IF;

  -- Count distinct JSONB embedding dimensions.
  SELECT COUNT(DISTINCT jsonb_array_length(embedding)), COUNT(*)
    INTO dim_count, row_count
  FROM memory_nodes
  WHERE embedding IS NOT NULL AND embedding != 'null'::jsonb AND embedding != '[]'::jsonb;

  IF dim_count IS NULL OR dim_count = 0 OR dim_count > 1 OR row_count < 100 THEN
    -- Mixed/no dimensions or tiny dataset — keep dimensionless
    RETURN;
  END IF;

  SELECT jsonb_array_length(embedding) INTO uniform_dim
  FROM memory_nodes
  WHERE embedding IS NOT NULL AND embedding != 'null'::jsonb AND embedding != '[]'::jsonb
  LIMIT 1;

  -- Resize column to the uniform dimension (parameterised via EXECUTE)
  EXECUTE format('ALTER TABLE memory_nodes ALTER COLUMN embedding_vec TYPE vector(%s) USING NULL', uniform_dim);

  -- Repopulate from JSONB
  UPDATE memory_nodes
  SET embedding_vec = embedding::text::vector
  WHERE embedding IS NOT NULL AND embedding != 'null'::jsonb AND embedding != '[]'::jsonb;

  -- Recreate HNSW index (if dim <= 2000) or a simpler ivfflat
  BEGIN
    EXECUTE 'CREATE INDEX idx_memory_nodes_embedding_vec ON memory_nodes USING hnsw (embedding_vec vector_cosine_ops)';
    RAISE NOTICE 'Created HNSW index for dim=%', uniform_dim;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'HNSW index creation failed (dim=% may exceed limit): %', uniform_dim, SQLERRM;
  END;
END $$;
