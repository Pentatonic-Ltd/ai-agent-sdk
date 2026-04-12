/**
 * Memory consolidation — promote frequently-accessed episodic memories
 * to the semantic layer.
 */

/**
 * Consolidate memories that exceed the access count threshold.
 *
 * @param {Function} db - Database query function
 * @param {object} ai - AI client for re-embedding promoted memories
 * @param {string} clientId - Client to process
 * @param {object} [opts]
 * @param {number} [opts.threshold=5] - Access count threshold for promotion
 * @param {number} [opts.limit=10] - Max consolidations per run
 * @param {Function} [opts.logger] - Optional logger
 * @returns {Promise<Array<{sourceId: string, targetId: string}>>}
 */
export async function consolidate(db, ai, clientId, opts = {}) {
  const threshold = opts.threshold || 5;
  const maxConsolidations = opts.limit || 10;
  const log = opts.logger || (() => {});

  // Find candidates: episodic memories with high access count, not yet consolidated
  const candidates = await db(
    `SELECT mn.id, mn.content, mn.metadata, mn.access_count, mn.user_id
     FROM memory_nodes mn
     JOIN memory_layers ml ON mn.layer_id = ml.id
     WHERE mn.client_id = $1
       AND ml.name = 'episodic'
       AND mn.access_count >= $2
       AND NOT EXISTS (
         SELECT 1 FROM memory_consolidations mc
         WHERE mc.source_memory_id = mn.id
       )
     LIMIT $3`,
    [clientId, threshold, maxConsolidations]
  );

  if (!candidates.rows?.length) return [];

  // Get semantic layer
  const semanticResult = await db(
    `SELECT id FROM memory_layers
     WHERE client_id = $1 AND name = 'semantic' AND is_active = TRUE
     LIMIT 1`,
    [clientId]
  );

  if (!semanticResult.rows?.length) return [];

  const semanticLayerId = semanticResult.rows[0].id;
  const consolidated = [];

  for (const row of candidates.rows) {
    const newMemoryId = `mem_${crypto.randomUUID()}`;
    const consolidationId = `mc_${crypto.randomUUID()}`;

    const metadata =
      typeof row.metadata === "string"
        ? JSON.parse(row.metadata)
        : row.metadata || {};

    // Create promoted memory in semantic layer
    await db(
      `INSERT INTO memory_nodes (id, client_id, layer_id, content, metadata, user_id, confidence, decay_rate, access_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 0.001, 0)`,
      [
        newMemoryId,
        clientId,
        semanticLayerId,
        row.content,
        JSON.stringify({
          ...metadata,
          consolidated_from: row.id,
          consolidation_reason: "access_count_threshold",
        }),
        row.user_id || null,
        Math.min(1.0, (row.access_count / threshold) * 0.8),
      ]
    );

    // Embed promoted memory (non-fatal)
    try {
      const embResult = await ai.embed(row.content, "passage");
      if (embResult?.embedding) {
        await db(
          `UPDATE memory_nodes SET embedding = $1, updated_at = NOW() WHERE id = $2`,
          [JSON.stringify(embResult.embedding), newMemoryId]
        );
      }
    } catch {
      // Non-fatal
    }

    // Record consolidation
    await db(
      `INSERT INTO memory_consolidations (id, client_id, source_memory_id, target_memory_id, consolidation_type)
       VALUES ($1, $2, $3, $4, 'promotion')`,
      [consolidationId, clientId, row.id, newMemoryId]
    );

    consolidated.push({ sourceId: row.id, targetId: newMemoryId });
  }

  log(`Consolidated ${consolidated.length} memories for ${clientId}`);
  return consolidated;
}
