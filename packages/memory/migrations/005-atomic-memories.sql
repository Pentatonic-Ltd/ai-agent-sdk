-- Migration 005: Atomic (distilled) memories
--
-- Adds source_id column to memory_nodes, linking distilled atomic facts
-- back to their source (raw) memory. Raw messages go in episodic, extracted
-- facts go in semantic with source_id pointing to the raw.
--
-- Atoms are searchable in the same table; source_id gives provenance
-- and allows filtering (atoms-only vs. raw-only retrieval).

ALTER TABLE memory_nodes
  ADD COLUMN IF NOT EXISTS source_id TEXT
    REFERENCES memory_nodes(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_memory_nodes_source_id
  ON memory_nodes(source_id)
  WHERE source_id IS NOT NULL;
