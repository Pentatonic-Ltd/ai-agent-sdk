-- Migration 002: Add vector similarity index for memory embeddings
-- Requires pgvector extension (already installed on TES PostgreSQL)
--
-- The embedding column is JSONB. For efficient vector search, we create
-- a generated column that casts to vector type and index it.
-- If pgvector is not available, this migration is a no-op.

DO $$
BEGIN
  -- Only create if pgvector extension exists
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    -- Add a vector column for efficient cosine similarity search
    -- Use current_schema() to scope the check to the active module schema
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'memory_nodes' AND column_name = 'embedding_vec'
    ) THEN
      ALTER TABLE memory_nodes ADD COLUMN embedding_vec vector(4096);

      -- Create vector index (best-effort — may fail on older pgvector with dim > 2000)
      BEGIN
        CREATE INDEX IF NOT EXISTS idx_memory_nodes_embedding_vec
          ON memory_nodes USING hnsw (embedding_vec vector_cosine_ops);
      EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'Vector index creation skipped: %', SQLERRM;
      END;
    END IF;

    -- Create a function to sync JSONB embedding to vector column
    CREATE OR REPLACE FUNCTION sync_memory_embedding()
    RETURNS trigger AS $fn$
    BEGIN
      IF NEW.embedding IS NOT NULL AND NEW.embedding != 'null'::jsonb AND NEW.embedding != '[]'::jsonb THEN
        BEGIN
          NEW.embedding_vec := NEW.embedding::text::vector;
        EXCEPTION WHEN OTHERS THEN
          NEW.embedding_vec := NULL;
        END;
      ELSE
        NEW.embedding_vec := NULL;
      END IF;
      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql;

    -- Trigger to auto-sync on insert/update
    DROP TRIGGER IF EXISTS trg_sync_memory_embedding ON memory_nodes;
    CREATE TRIGGER trg_sync_memory_embedding
      BEFORE INSERT OR UPDATE OF embedding ON memory_nodes
      FOR EACH ROW
      EXECUTE FUNCTION sync_memory_embedding();
  END IF;
END $$;
