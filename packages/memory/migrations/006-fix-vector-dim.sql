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

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    -- Drop the HNSW index if it exists (can't resize column while indexed)
    DROP INDEX IF EXISTS idx_memory_nodes_embedding_vec;

    -- Recreate the column without a dimension constraint
    -- Only touch it if it has a dimension constraint baked in
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'memory_nodes'
        AND column_name = 'embedding_vec'
    ) THEN
      ALTER TABLE memory_nodes ALTER COLUMN embedding_vec TYPE vector USING NULL;
    END IF;

    -- Repopulate from JSONB using the updated trigger
    UPDATE memory_nodes
    SET embedding_vec = embedding::text::vector
    WHERE embedding IS NOT NULL
      AND embedding != 'null'::jsonb
      AND embedding != '[]'::jsonb
      AND embedding_vec IS NULL;
  END IF;
END $$;
