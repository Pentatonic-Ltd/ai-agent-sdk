/**
 * Distilled memory — extract atomic facts from raw content.
 *
 * Each turn can contain multiple distinct facts. Distilling them into
 * standalone atoms makes semantic retrieval more precise: searching for
 * "what does Phil drink?" matches "Phil drinks cortado" better than a
 * mixed paragraph covering food, drinks, and hobbies.
 *
 * Atoms are stored in the semantic layer with source_id pointing back
 * to the raw memory in episodic.
 */

import { generateHypotheticalQueries } from "./ingest.js";

const EXTRACTION_PROMPT = `You extract atomic facts from conversations.

Rules:
- Only extract facts the user has explicitly stated about themselves, their preferences, decisions, relationships, or world.
- Each fact must be a single standalone statement (no "and", "or", no lists).
- Decontextualize: replace "I" / "my" with the user's name or role if known, otherwise use "the user".
- Reject questions, jokes, small talk, meta-discussion, and speculation.
- Reject facts about the AI or the current task.
- If nothing qualifies, return an empty array.

Output a JSON array of strings. No explanation, no markdown fences. Just the JSON array.`;

/**
 * Extract atomic facts from content using the LLM.
 *
 * @param {object} llm - LLM client with chat() method
 * @param {string} content - Raw content to distil
 * @param {object} [opts]
 * @param {string} [opts.userName] - User's name for decontextualization
 * @returns {Promise<string[]>} Array of atomic fact strings
 */
export async function extractAtomicFacts(llm, content, opts = {}) {
  const userHint = opts.userName
    ? `\nThe user's name is ${opts.userName}.`
    : "";
  const text = await llm.chat(
    [
      { role: "system", content: EXTRACTION_PROMPT + userHint },
      { role: "user", content: content.substring(0, 4000) },
    ],
    { maxTokens: 500, temperature: 0 }
  );

  if (!text) return [];

  // Try to parse as JSON array. Be lenient about markdown fences.
  let jsonText = text.trim();
  const fenceMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) jsonText = fenceMatch[1].trim();

  try {
    const parsed = JSON.parse(jsonText);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((f) => typeof f === "string" && f.trim().length > 0)
      .map((f) => f.trim());
  } catch {
    return [];
  }
}

/**
 * Distill a raw memory into atomic facts and store each as a separate
 * memory node in the semantic layer, linked via source_id.
 *
 * Fire-and-forget: call this without awaiting to avoid blocking ingest.
 *
 * @param {Function} db - Database query function
 * @param {object} ai - Embedding client
 * @param {object} llm - Chat client for extraction + HyDE
 * @param {string} sourceId - The raw memory ID this distillation derives from
 * @param {string} content - The raw content
 * @param {object} opts
 * @param {string} opts.clientId
 * @param {string} [opts.userId]
 * @param {string} [opts.userName]
 * @param {Function} [opts.logger]
 * @returns {Promise<Array<{id: string, content: string}>>}
 */
export async function distill(db, ai, llm, sourceId, content, opts = {}) {
  const clientId = opts.clientId;
  const log = opts.logger || (() => {});

  const facts = await extractAtomicFacts(llm, content, opts);
  if (!facts.length) {
    log(`distill: no facts extracted from ${sourceId}`);
    return [];
  }

  // Resolve semantic layer ID (create the atoms there, not in episodic)
  const layerResult = await db(
    `SELECT id FROM memory_layers
     WHERE client_id = $1 AND name = 'semantic' AND is_active = TRUE
     LIMIT 1`,
    [clientId]
  );
  if (!layerResult.rows?.length) {
    log(`distill: no semantic layer for client ${clientId}`);
    return [];
  }
  const layerId = layerResult.rows[0].id;

  // Batch-embed all atoms in one HTTP call. Under load this is a big
  // win over N serial embed calls — one GPU forward pass instead of N,
  // less downstream queueing.
  let embeddings;
  if (ai.embedBatch) {
    try {
      embeddings = await ai.embedBatch(facts, "passage");
    } catch (err) {
      log(`distill: batch embed failed: ${err.message}`);
      embeddings = facts.map(() => null);
    }
  } else {
    // Older AI clients without embedBatch — fall through to per-atom embed
    // inside the loop below. Kept for backwards compat with any custom
    // client passed into createMemorySystem.
    embeddings = null;
  }

  const stored = [];
  for (let i = 0; i < facts.length; i++) {
    const fact = facts[i];
    try {
      const atomId = `mem_${crypto.randomUUID()}`;

      // Insert the atom linked to its source
      await db(
        `INSERT INTO memory_nodes (id, client_id, layer_id, source_id, content, metadata, user_id, confidence, decay_rate, access_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 1.0, 0.05, 0)`,
        [
          atomId,
          clientId,
          layerId,
          sourceId,
          fact,
          JSON.stringify({ distilled_from: sourceId }),
          opts.userId || null,
        ]
      );

      // Attach embedding — from the batch when available, else fall back
      // to a per-atom call.
      try {
        let embResult = embeddings ? embeddings[i] : null;
        if (!embResult && !embeddings) {
          embResult = await ai.embed(fact, "passage");
        }
        if (embResult?.embedding) {
          await db(
            `UPDATE memory_nodes SET embedding = $1, updated_at = NOW() WHERE id = $2`,
            [JSON.stringify(embResult.embedding), atomId]
          );
        }
      } catch (err) {
        log(`distill: embedding failed for ${atomId}: ${err.message}`);
      }

      // HyDE (2 queries for atoms — they're already focused).
      // Still per-atom — chat completions don't share a batch surface
      // across providers the way embeddings do.
      try {
        const queries = await generateHypotheticalQueries(llm, fact);
        const trimmed = queries.slice(0, 2);
        if (trimmed.length) {
          await db(
            `UPDATE memory_nodes SET metadata = jsonb_set(COALESCE(metadata, '{}')::jsonb, '{hypothetical_queries}', $1::jsonb), updated_at = NOW() WHERE id = $2`,
            [JSON.stringify(trimmed), atomId]
          );
        }
      } catch (err) {
        log(`distill: HyDE failed for ${atomId}: ${err.message}`);
      }

      stored.push({ id: atomId, content: fact });
    } catch (err) {
      log(`distill: failed to store fact "${fact.substring(0, 40)}": ${err.message}`);
    }
  }

  log(`distill: ${stored.length}/${facts.length} atoms stored from ${sourceId}`);
  return stored;
}
