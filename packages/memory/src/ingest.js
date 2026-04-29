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
 * @param {boolean} [opts.distill=true] - Run conversation-shaped fact
 *   extraction. Pass false for code/structured content.
 * @param {boolean} [opts.hyde=true] - Generate hypothetical queries
 *   (HyDE). Pass false for code/structured content.
 * @param {Function} [opts.logger] - Optional logger
 * @param {Function} [opts.waitUntil] - Platform hook to register background
 *   tasks (e.g. Cloudflare Worker ctx.waitUntil). If provided, the distill
 *   background task is handed to it so the host keeps it alive past return.
 *   Without it, distill is fire-and-forget (fine for Node/browser).
 * @returns {Promise<{id: string, content: string, layerId: string}>}
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

  // HyDE: generate hypothetical queries (non-fatal). Skippable via
  // opts.hyde === false — corpus ingest passes this for code_reference
  // chunks because hypothetical-question expansion against function
  // signatures degrades retrieval and burns one LLM call per chunk.
  if (opts.hyde !== false) {
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
