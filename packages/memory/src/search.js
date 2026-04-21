/**
 * Multi-signal memory search.
 *
 * Combines cosine similarity (vector), BM25 (full-text), recency decay,
 * and access frequency into a single scored ranking via Postgres CTE.
 * Also searches HyDE hypothetical queries stored in metadata.
 */

const DEFAULT_WEIGHTS = {
  relevance: 0.6,
  recency: 0.25,
  frequency: 0.15,
  // Boost distilled atoms — they're high signal per token by design.
  atomBoost: 0.15,
  // Penalty on verbose raw turns. Short focused memories rank higher.
  // Atoms are exempt (penalty skipped when source_id IS NOT NULL).
  verbosityPenalty: 0.1,
};

/**
 * Semantic search across memories using multi-signal scoring.
 *
 * @param {object} db - Database query function: (sql, params) => {rows}
 * @param {object} ai - AI client with embed() method
 * @param {string} query - Search query text
 * @param {object} [opts]
 * @param {string} opts.clientId - Client ID to scope search
 * @param {string} [opts.schema] - Postgres schema (default: current)
 * @param {number} [opts.limit=20] - Max results
 * @param {number} [opts.minScore=0.5] - Minimum score threshold
 * @param {string} [opts.userId] - Optional user scope
 * @param {object} [opts.weights] - Override scoring weights
 *   (relevance, recency, frequency, atomBoost, verbosityPenalty)
 * @param {boolean} [opts.dedupeBySource=true] - When an atom matches,
 *   drop its raw source memory from the results (atoms are already
 *   distillations of the source, so returning both is redundant).
 * @param {Function} [opts.logger] - Optional logger
 * @returns {Promise<Array>} Scored memory results
 */
export async function search(db, ai, query, opts = {}) {
  const limit = Math.min(Math.max(1, opts.limit || 20), 200);
  const threshold = opts.minScore ?? 0.5;
  const w = { ...DEFAULT_WEIGHTS, ...opts.weights };

  // Check if vector column exists (migration 002 may not have run)
  let hasVectorCol = true;
  try {
    const colCheck = await db(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = 'memory_nodes' AND column_name = 'embedding_vec' LIMIT 1`,
      []
    );
    hasVectorCol = (colCheck.rows || []).length > 0;
  } catch {
    hasVectorCol = false;
  }

  if (!hasVectorCol) {
    return textSearch(db, query, opts);
  }

  // Generate query embedding — fall back to text search if embedding fails
  let embResult;
  try {
    embResult = await ai.embed(query, "query");
  } catch {
    return textSearch(db, query, opts);
  }
  if (!embResult?.embedding) {
    return textSearch(db, query, opts);
  }

  const embJson = JSON.stringify(embResult.embedding);
  const userFilter = opts.userId ? `AND mn.user_id = $5` : "";

  const params = [opts.clientId, embJson, query, limit];
  if (opts.userId) params.push(opts.userId);

  const sql = `
    WITH max_ac AS (
      SELECT GREATEST(MAX(access_count), 1)::float AS val
      FROM memory_nodes WHERE client_id = $1
    ),
    bm25_matches AS (
      SELECT id,
        GREATEST(
          ts_rank_cd(
            COALESCE(content_tsv, to_tsvector('english', content)),
            plainto_tsquery('english', $3)
          ),
          ts_rank_cd(
            to_tsvector('english', COALESCE(metadata->>'hypothetical_queries', '')),
            plainto_tsquery('english', $3)
          )
        ) AS bm25_raw
      FROM memory_nodes
      WHERE client_id = $1
        AND (
          COALESCE(content_tsv, to_tsvector('english', content))
            @@ plainto_tsquery('english', $3)
          OR to_tsvector('english', COALESCE(metadata->>'hypothetical_queries', ''))
            @@ plainto_tsquery('english', $3)
        )
    ),
    max_bm25 AS (
      SELECT GREATEST(MAX(bm25_raw), 0.001) AS val FROM bm25_matches
    )
    SELECT mn.*,
      (1 - (mn.embedding_vec <=> $2::vector)) AS cosine_sim,
      COALESCE(bm.bm25_raw / mb.val, 0) AS bm25_norm,
      (
        ${w.relevance} * (
          0.6 * (1 - (mn.embedding_vec <=> $2::vector)) +
          0.4 * COALESCE(bm.bm25_raw / mb.val, 0)
        ) +
        ${w.recency} * exp(
          -0.01 * EXTRACT(EPOCH FROM NOW() - COALESCE(mn.last_accessed, mn.created_at)) / 3600
        ) +
        ${w.frequency} * (ln(mn.access_count + 1) / ln(ma.val + 1)) +
        ${w.atomBoost} * (CASE WHEN mn.source_id IS NOT NULL THEN 1 ELSE 0 END) -
        ${w.verbosityPenalty} * (
          CASE WHEN mn.source_id IS NULL THEN
            LEAST(
              GREATEST(
                (ln(length(mn.content) + 1) - ln(200)) / (ln(10000) - ln(200)),
                0
              ),
              1
            )
          ELSE 0 END
        )
      ) AS final_score
    FROM memory_nodes mn
    CROSS JOIN max_ac ma
    CROSS JOIN max_bm25 mb
    LEFT JOIN bm25_matches bm ON bm.id = mn.id
    WHERE mn.client_id = $1
      AND mn.embedding_vec IS NOT NULL
      AND vector_dims(mn.embedding_vec) = vector_dims($2::vector)
      ${userFilter}
    ORDER BY final_score DESC
    LIMIT $4
  `;

  const result = await db(sql, params);

  let filtered = (result.rows || []).filter(
    (r) => parseFloat(r.final_score) >= threshold
  );

  // De-dupe: when an atom matches, drop its raw source from the set.
  // Default on; set opts.dedupeBySource: false to keep both.
  if (opts.dedupeBySource !== false) {
    const atomSources = new Set(
      filtered.filter((r) => r.source_id).map((r) => r.source_id)
    );
    if (atomSources.size > 0) {
      filtered = filtered.filter((r) => !atomSources.has(r.id));
    }
  }

  // Increment access counts
  const ids = filtered.map((r) => r.id);
  if (ids.length) {
    await db(
      `UPDATE memory_nodes SET access_count = access_count + 1, last_accessed = NOW() WHERE id = ANY($1)`,
      [ids]
    );
  }

  return filtered.map(mapRow);
}

/**
 * Text-only search fallback (no embeddings required).
 */
export async function textSearch(db, query, opts = {}) {
  const limit = Math.min(Math.max(1, opts.limit || 20), 200);
  const userFilter = opts.userId ? `AND mn.user_id = $4` : "";
  const params = opts.userId
    ? [opts.clientId, query, limit, opts.userId]
    : [opts.clientId, query, limit];

  const sql = `
    SELECT mn.* FROM memory_nodes mn
    WHERE mn.client_id = $1
      AND (
        to_tsvector('english', mn.content) @@ plainto_tsquery('english', $2)
        OR mn.content ILIKE '%' || $2 || '%'
      )
      ${userFilter}
    ORDER BY
      ts_rank(to_tsvector('english', mn.content), plainto_tsquery('english', $2)) DESC,
      mn.confidence DESC
    LIMIT $3
  `;

  const result = await db(sql, params);

  const ids = (result.rows || []).map((r) => r.id);
  if (ids.length) {
    await db(
      `UPDATE memory_nodes SET access_count = access_count + 1, last_accessed = NOW() WHERE id = ANY($1)`,
      [ids]
    );
  }

  return (result.rows || []).map(mapRow);
}

function mapRow(row) {
  return {
    id: row.id,
    client_id: row.client_id,
    user_id: row.user_id || null,
    layer_id: row.layer_id,
    source_id: row.source_id || null,
    content: row.content,
    metadata:
      typeof row.metadata === "string"
        ? JSON.parse(row.metadata)
        : row.metadata,
    confidence: parseFloat(row.confidence),
    decay_rate: parseFloat(row.decay_rate),
    access_count: parseInt(row.access_count),
    last_accessed: row.last_accessed
      ? new Date(row.last_accessed).toISOString()
      : null,
    created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
    updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    similarity: parseFloat(row.final_score || row.confidence || 0),
  };
}
