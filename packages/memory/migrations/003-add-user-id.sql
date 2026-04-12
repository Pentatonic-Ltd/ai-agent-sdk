-- Add optional user_id to memory_nodes for user-scoped memory.
-- Nullable: anonymous events (server-side SDK) produce memories with no user.
ALTER TABLE memory_nodes ADD COLUMN IF NOT EXISTS user_id TEXT;

CREATE INDEX IF NOT EXISTS idx_memory_nodes_user ON memory_nodes(client_id, user_id);
