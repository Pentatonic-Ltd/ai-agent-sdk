-- Deep Memory module tables
-- memory_layers: configurable memory stack layers per client
-- memory_nodes: individual memories with embeddings and decay
-- memory_consolidations: tracks memory promotion between layers

CREATE TABLE IF NOT EXISTS memory_layers (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  name TEXT NOT NULL,
  layer_type TEXT NOT NULL CHECK (layer_type IN ('episodic', 'semantic', 'procedural', 'working')),
  capacity INTEGER DEFAULT 10000,
  decay_policy JSONB DEFAULT '{"rate": 0.01, "min_confidence": 0.1, "gc_interval_hours": 24}',
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (client_id, name)
);

CREATE INDEX IF NOT EXISTS idx_memory_layers_client ON memory_layers(client_id);

CREATE TABLE IF NOT EXISTS memory_nodes (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  layer_id TEXT NOT NULL REFERENCES memory_layers(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  embedding JSONB,
  metadata JSONB DEFAULT '{}',
  confidence REAL DEFAULT 1.0,
  decay_rate REAL DEFAULT 0.01,
  access_count INTEGER DEFAULT 0,
  last_accessed TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_memory_nodes_client ON memory_nodes(client_id);
CREATE INDEX IF NOT EXISTS idx_memory_nodes_layer ON memory_nodes(client_id, layer_id);
CREATE INDEX IF NOT EXISTS idx_memory_nodes_confidence ON memory_nodes(client_id, confidence DESC);
CREATE INDEX IF NOT EXISTS idx_memory_nodes_content_search ON memory_nodes USING gin(to_tsvector('english', content));

CREATE TABLE IF NOT EXISTS memory_consolidations (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  source_memory_id TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
  target_memory_id TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
  consolidation_type TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_memory_consolidations_client ON memory_consolidations(client_id);
CREATE INDEX IF NOT EXISTS idx_memory_consolidations_source ON memory_consolidations(source_memory_id);
