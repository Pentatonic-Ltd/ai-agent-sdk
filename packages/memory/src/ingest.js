/**
 * Memory ingestion — store content, generate embedding, generate HyDE queries.
 */

import { distill } from "./distill.js";

/**
 * Ingest content as a new memory node.
 *
 * @param {Function} db - Database query function: (sql, params) => {rows}
 * @param {object} ai - AI client with embed() and chat() methods
 * @param {object} llm - LLM client for HyDE (may be same as ai, or separate)
 * @param {string} content - Memory content text
 * @param {object} [opts]
 * @param {string} opts.clientId - Client ID
 * @param {string} [opts.userId] - Optional user ID
 * @param {string} [opts.layerType="episodic"] - Target layer
 * @param {object} [opts.metadata] - Additional metadata
 * @param {Function} [opts.logger] - Optional logger
 * @param {Function} [opts.waitUntil] - Platform hook to register background
 *   tasks (e.g. Cloudflare Worker ctx.waitUntil). If provided, the distill
 *   background task is handed to it so the host keeps it alive past return.
 *   Without it, distill is fire-and-forget (fine for Node/browser).
 * @param {boolean} [opts.dedup=false] - Skip ingest if a memory_node with
 *   byte-equal content already exists for this `client_id`. Use for
 *   retry-safe pipelines where the same logical event may be processed
 *   twice (queue retries, consumer fan-out). Returns the existing row's
 *   id with `{deduped: true}` instead of inserting. Strict equality —
 *   not a semantic similarity match. Best-effort: if the SELECT itself
 *   fails, ingest proceeds (worst case: duplicate row, identical to
 *   `dedup:false` behaviour). The eventual structural fix is a
 *   `UNIQUE(client_id, content_hash)` constraint at the schema level;
 *   this option is the bridge.
 * @param {string} [opts.dedupContent] - Optional: the string to dedup
 *   against, when it differs from what gets stored. Use when callers
 *   wrap the stored content in a non-stable prefix (timestamps, run
 *   ids) — pass the raw form here so retries of the same logical event
 *   match across runs whose prefixes differ by a few ms. Defaults to
 *   `content`.
 * @returns {Promise<{id: string, content: string, layerId: string, deduped?: boolean}>}
 */
export async function ingest(db, ai, llm, content, opts = {}) {
  const clientId = opts.clientId;
  const layerType = opts.layerType || "episodic";
  const log = opts.logger || (() => {});

  // Ensure layer exists
  const layerResult = await db(
    `SELECT id FROM memory_layers
     WHERE client_id = $1 AND name = $2 AND is_active = TRUE
     LIMIT 1`,
    [clientId, layerType]
  );

  if (!layerResult.rows?.length) {
    throw new Error(`No active ${layerType} layer for client ${clientId}`);
  }

  const layerId = layerResult.rows[0].id;

  // Optional dedup: skip the insert (and all the embedding/HyDE/distill
  // work that would follow) if a row with byte-equal content already
  // exists for this tenant. The dedup key is `opts.dedupContent` if
  // provided (use for callers that wrap the stored form in a non-stable
  // prefix like a timestamp), else `content`. The OR-LIKE branch matches
  // against legacy `[<iso>] <content>` rows so callers that wrote with a
  // timestamp prefix dedup correctly until the legacy corpus ages out.
  if (opts.dedup) {
    const dedupKey =
      typeof opts.dedupContent === "string" ? opts.dedupContent : content;
    try {
      const dupCheck = await db(
        `SELECT id FROM memory_nodes
           WHERE client_id = $1
             AND (content = $2 OR content LIKE '%] ' || $2)
           LIMIT 1`,
        [clientId, dedupKey]
      );
      if (dupCheck.rows?.length) {
        log(`dedup: matched existing memory ${dupCheck.rows[0].id}`);
        return {
          id: dupCheck.rows[0].id,
          content,
          layerId,
          deduped: true,
        };
      }
    } catch (err) {
      log(`dedup check failed (proceeding with insert): ${err.message}`);
    }
  }

  const memoryId = `mem_${crypto.randomUUID()}`;

  // Insert memory node
  await db(
    `INSERT INTO memory_nodes (id, client_id, layer_id, content, metadata, user_id, confidence, decay_rate, access_count)
     VALUES ($1, $2, $3, $4, $5, $6, 1.0, 0.05, 0)`,
    [
      memoryId,
      clientId,
      layerId,
      content,
      JSON.stringify(opts.metadata || {}),
      opts.userId || null,
    ]
  );

  // Generate embedding (non-fatal)
  try {
    const embResult = await ai.embed(content, "passage");
    if (embResult?.embedding) {
      await db(
        `UPDATE memory_nodes SET embedding = $1, updated_at = NOW() WHERE id = $2`,
        [JSON.stringify(embResult.embedding), memoryId]
      );
      log(
        `Embedded ${memoryId} (${embResult.dimensions}d, ${embResult.model})`
      );
    }
  } catch (err) {
    log(`Embedding failed for ${memoryId}: ${err.message}`);
  }

  // HyDE: generate hypothetical queries (non-fatal)
  try {
    const queries = await generateHypotheticalQueries(llm, content);
    if (queries.length) {
      await db(
        `UPDATE memory_nodes SET metadata = jsonb_set(COALESCE(metadata, '{}')::jsonb, '{hypothetical_queries}', $1::jsonb), updated_at = NOW() WHERE id = $2`,
        [JSON.stringify(queries), memoryId]
      );
      log(`Generated ${queries.length} hypothetical queries for ${memoryId}`);
    }
  } catch (err) {
    log(`HyDE failed for ${memoryId}: ${err.message}`);
  }

  // Distill atomic facts — only for raw ingestions (skip if this call is
  // already storing a distilled atom or user opted out).
  //
  // On Cloudflare Workers: caller passes `waitUntil` so distill runs past
  // the handler return (without waitUntil the runtime kills unreferenced
  // promises). On Node / local dev / test: we await inline so distill
  // actually completes before ingest() returns.
  if (opts.distill !== false && !opts.sourceId) {
    const distillPromise = distill(db, ai, llm, memoryId, content, {
      ...opts,
      logger: log,
    }).catch((err) => log(`distill failed for ${memoryId}: ${err.message}`));
    if (typeof opts.waitUntil === "function") opts.waitUntil(distillPromise);
    else await distillPromise;
  }

  return { id: memoryId, content, layerId };
}

/**
 * Generate hypothetical questions a memory could answer (HyDE).
 *
 * @param {object} llm - LLM client with chat() method
 * @param {string} content - Memory content
 * @returns {Promise<string[]>}
 */
export async function generateHypotheticalQueries(llm, content) {
  const text = await llm.chat(
    [
      {
        role: "system",
        content:
          "Generate exactly 3 short questions that someone might ask which this memory could help answer. Return only the questions, one per line. No numbering.",
      },
      { role: "user", content: content.substring(0, 500) },
    ],
    { maxTokens: 150, temperature: 0.7 }
  );

  if (!text) return [];

  return text
    .split("\n")
    .map((l) => l.replace(/^\d+[.)]\s*/, "").trim())
    .filter((l) => l.length > 10);
}
