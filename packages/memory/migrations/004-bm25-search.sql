-- Migration 004: Add stored tsvector column for BM25 full-text search
-- Enables hybrid search (cosine + BM25) for better retrieval accuracy

-- Add tsvector column
ALTER TABLE memory_nodes ADD COLUMN IF NOT EXISTS content_tsv tsvector;

-- Populate from existing content
UPDATE memory_nodes SET content_tsv = to_tsvector('english', content)
WHERE content_tsv IS NULL AND content IS NOT NULL;

-- GIN index for fast full-text search
CREATE INDEX IF NOT EXISTS idx_memory_nodes_content_tsv
  ON memory_nodes USING GIN(content_tsv);

-- Trigger to auto-update tsvector on insert/update
CREATE OR REPLACE FUNCTION memory_content_tsv_trigger()
RETURNS trigger AS $$
BEGIN
  NEW.content_tsv := to_tsvector('english', COALESCE(NEW.content, ''));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_memory_content_tsv ON memory_nodes;
CREATE TRIGGER trg_memory_content_tsv
  BEFORE INSERT OR UPDATE OF content ON memory_nodes
  FOR EACH ROW
  EXECUTE FUNCTION memory_content_tsv_trigger();
