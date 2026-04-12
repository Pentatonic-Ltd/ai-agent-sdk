/**
 * Memory layer management.
 *
 * Layers organize memories by type: episodic (recent events), semantic
 * (consolidated knowledge), procedural (how-to), working (temporary).
 */

const DEFAULT_LAYER_CONFIG = {
  episodic: { capacity: 10000, decay_rate: 0.05 },
  semantic: { capacity: 5000, decay_rate: 0.001 },
  procedural: { capacity: 2000, decay_rate: 0.0001 },
  working: { capacity: 500, decay_rate: 0.2 },
};

/**
 * Ensure default layers exist for a client.
 *
 * @param {Function} db - Database query function
 * @param {string} clientId - Client ID
 * @param {string[]} [layerNames] - Layers to create (default: all four)
 */
export async function ensureLayers(db, clientId, layerNames) {
  const names = layerNames || Object.keys(DEFAULT_LAYER_CONFIG);

  for (const name of names) {
    const config = DEFAULT_LAYER_CONFIG[name] || {
      capacity: 5000,
      decay_rate: 0.01,
    };
    await db(
      `INSERT INTO memory_layers (id, client_id, name, layer_type, capacity, decay_policy, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, TRUE)
       ON CONFLICT (client_id, name) DO NOTHING`,
      [
        `ml_${clientId}_${name}`,
        clientId,
        name,
        name,
        config.capacity,
        JSON.stringify({
          rate: config.decay_rate,
          min_confidence: 0.1,
          gc_interval_hours: 24,
        }),
      ]
    );
  }
}

/**
 * Get all layers for a client with memory counts.
 *
 * @param {Function} db - Database query function
 * @param {string} clientId - Client ID
 * @returns {Promise<Array>}
 */
export async function getLayers(db, clientId) {
  const result = await db(
    `SELECT ml.*,
       (SELECT COUNT(*)::int FROM memory_nodes mn WHERE mn.layer_id = ml.id) AS memory_count
     FROM memory_layers ml
     WHERE ml.client_id = $1
     ORDER BY ml.created_at ASC`,
    [clientId]
  );

  return (result.rows || []).map((row) => ({
    id: row.id,
    client_id: row.client_id,
    name: row.name,
    layer_type: row.layer_type,
    capacity: row.capacity ? parseInt(row.capacity) : null,
    decay_policy:
      typeof row.decay_policy === "string"
        ? JSON.parse(row.decay_policy)
        : row.decay_policy,
    is_active: row.is_active,
    created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
    memory_count: parseInt(row.memory_count || 0),
  }));
}
