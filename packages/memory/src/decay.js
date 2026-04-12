/**
 * Memory decay and garbage collection.
 *
 * Applies confidence decay to memory nodes, evicts those below threshold,
 * and enforces layer capacity limits.
 */

/**
 * Run decay cycle for a client.
 *
 * @param {Function} db - Database query function
 * @param {string} clientId - Client to process
 * @param {object} [opts]
 * @param {Function} [opts.logger] - Optional logger
 * @returns {Promise<{decayed: number, evicted: number, layersProcessed: number}>}
 */
export async function decay(db, clientId, opts = {}) {
  const log = opts.logger || (() => {});
  const stats = { decayed: 0, evicted: 0, layersProcessed: 0 };

  const layers = await db(
    `SELECT id, name, capacity, decay_policy FROM memory_layers WHERE client_id = $1 AND is_active = TRUE`,
    [clientId]
  );

  for (const layer of layers.rows || []) {
    stats.layersProcessed++;

    const decayPolicy =
      typeof layer.decay_policy === "string"
        ? JSON.parse(layer.decay_policy)
        : layer.decay_policy || {};
    const minConfidence = decayPolicy.min_confidence || 0.1;

    // Apply decay — recently accessed memories decay slower
    const decayResult = await db(
      `UPDATE memory_nodes
       SET confidence = GREATEST(
         0,
         confidence * (1 - decay_rate * CASE
           WHEN last_accessed > NOW() - INTERVAL '24 hours' THEN 0.5
           WHEN last_accessed > NOW() - INTERVAL '7 days' THEN 0.8
           ELSE 1.0
         END)
       ),
       updated_at = NOW()
       WHERE layer_id = $1 AND client_id = $2 AND confidence > 0
       RETURNING id`,
      [layer.id, clientId]
    );

    stats.decayed += decayResult.rows?.length || 0;

    // Evict below threshold
    const evictResult = await db(
      `DELETE FROM memory_nodes
       WHERE layer_id = $1 AND client_id = $2 AND confidence < $3
       RETURNING id`,
      [layer.id, clientId, minConfidence]
    );

    stats.evicted += evictResult.rows?.length || 0;

    // Enforce capacity
    if (layer.capacity) {
      const countResult = await db(
        `SELECT COUNT(*)::int AS cnt FROM memory_nodes WHERE layer_id = $1 AND client_id = $2`,
        [layer.id, clientId]
      );

      const count = countResult.rows?.[0]?.cnt || 0;
      if (count > layer.capacity) {
        const overflow = count - layer.capacity;
        const capacityEvict = await db(
          `DELETE FROM memory_nodes
           WHERE id IN (
             SELECT id FROM memory_nodes
             WHERE layer_id = $1 AND client_id = $2
             ORDER BY confidence ASC, last_accessed ASC NULLS FIRST
             LIMIT $3
           )
           RETURNING id`,
          [layer.id, clientId, overflow]
        );
        stats.evicted += capacityEvict.rows?.length || 0;
      }
    }
  }

  log(
    `Decay for ${clientId}: ${stats.decayed} decayed, ${stats.evicted} evicted across ${stats.layersProcessed} layers`
  );
  return stats;
}
