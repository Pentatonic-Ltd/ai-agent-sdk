-- Migration 006: Make embedding_vec dimension-agnostic
--
-- The original embedding_vec column was declared as vector(4096) assuming
-- TES's NV-Embed-v2 model. But users running with different embedding models
-- (e.g. nomic-embed-text at 768 dims) silently get NULL embedding_vec because
-- the trigger's cast fails on dimension mismatch.
--
-- Fix: use vector without a fixed dimension so any size fits. We lose the
-- ability to use HNSW indexes (which require fixed dims) but vector search
-- still works via sequential scan, which is fine for local/self-hosted setups
-- with <100k memories.
--
-- For TES production (4096d with HNSW), this migration is a no-op if the
-- column is already correctly sized.

-- Strategy: detect existing column definition and only resize if the
-- configured dimension doesn't match what the running memory server will
-- actually produce. We can't know the runtime embedding size from a SQL
-- migration, so we pick a simple heuristic:
--
--   * If any rows already have a non-NULL embedding_vec, the column dim
--     matches what's been inserted — leave it (and the HNSW index) alone.
--   * If all embedding_vec values are NULL but JSONB embeddings exist,
--     the cast has been failing silently. Check the JSONB dimension:
--       - If it matches the current column dim, repopulate and keep HNSW.
--       - If it differs, resize to dimensionless vector (loses HNSW,
--         gains compatibility with any model).

DO $$
DECLARE
  jsonb_dim INTEGER;
  col_has_data BOOLEAN;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'memory_nodes'
      AND column_name = 'embedding_vec'
  ) THEN
    RETURN;
  END IF;

  -- Is the column already working (any populated rows)?
  SELECT EXISTS (SELECT 1 FROM memory_nodes WHERE embedding_vec IS NOT NULL LIMIT 1)
    INTO col_has_data;

  IF col_has_data THEN
    -- Column + HNSW are fine as-is. Just try to repopulate anything missing.
    UPDATE memory_nodes
    SET embedding_vec = embedding::text::vector
    WHERE embedding IS NOT NULL
      AND embedding != 'null'::jsonb
      AND embedding != '[]'::jsonb
      AND embedding_vec IS NULL;
    RETURN;
  END IF;

  -- Column is empty. Check JSONB dim to decide if we need to resize.
  SELECT jsonb_array_length(embedding) INTO jsonb_dim
  FROM memory_nodes
  WHERE embedding IS NOT NULL AND embedding != 'null'::jsonb AND embedding != '[]'::jsonb
  LIMIT 1;

  IF jsonb_dim IS NULL THEN
    -- No data yet; leave column as-is, nothing to repopulate
    RETURN;
  END IF;

  -- We have JSONB data but no vector data. Try a sample cast to see if
  -- it works against the current column type.
  BEGIN
    UPDATE memory_nodes
    SET embedding_vec = embedding::text::vector
    WHERE id = (SELECT id FROM memory_nodes WHERE embedding IS NOT NULL LIMIT 1);
    -- Cast succeeded — column dim matches, repopulate everything else
    UPDATE memory_nodes
    SET embedding_vec = embedding::text::vector
    WHERE embedding IS NOT NULL
      AND embedding != 'null'::jsonb
      AND embedding != '[]'::jsonb
      AND embedding_vec IS NULL;
  EXCEPTION WHEN OTHERS THEN
    -- Dimension mismatch. Resize to dimensionless to unblock local setups.
    RAISE NOTICE 'Dimension mismatch detected (JSONB is %d); resizing embedding_vec to dimensionless', jsonb_dim;
    DROP INDEX IF EXISTS idx_memory_nodes_embedding_vec;
    ALTER TABLE memory_nodes ALTER COLUMN embedding_vec TYPE vector USING NULL;
    UPDATE memory_nodes
    SET embedding_vec = embedding::text::vector
    WHERE embedding IS NOT NULL
      AND embedding != 'null'::jsonb
      AND embedding != '[]'::jsonb;
  END;
END $$;
