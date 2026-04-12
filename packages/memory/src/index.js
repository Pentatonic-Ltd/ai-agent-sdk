/**
 * @pentatonic/memory
 *
 * Multi-signal memory system with HyDE query expansion.
 * Ingest, search, decay, and consolidate memories using
 * PostgreSQL + pgvector + any OpenAI-compatible LLM/embedding endpoint.
 *
 * @example
 * import { createMemorySystem } from '@pentatonic/memory';
 *
 * const memory = createMemorySystem({
 *   db: pgPool,
 *   embedding: { url: 'http://ollama:11434/v1', model: 'nomic-embed-text' },
 *   llm: { url: 'http://ollama:11434/v1', model: 'llama3.2:3b' },
 * });
 *
 * await memory.migrate();
 * await memory.ensureLayers('my-client');
 * await memory.ingest('The user likes blue sneakers', { clientId: 'my-client' });
 * const results = await memory.search('sneakers', { clientId: 'my-client' });
 */

import { createAIClient } from "./ai.js";
import { ingest } from "./ingest.js";
import { search, textSearch } from "./search.js";
import { decay } from "./decay.js";
import { consolidate } from "./consolidate.js";
import { ensureLayers, getLayers } from "./layers.js";
import { migrate } from "./migrate.js";

/**
 * Create a memory system instance.
 *
 * @param {object} config
 * @param {object|string|Function} config.db - pg.Pool, connection string, or query function
 * @param {string} [config.schema] - Postgres schema (default: current search_path)
 * @param {object} config.embedding - { url, model, apiKey? }
 * @param {object} config.llm - { url, model, apiKey? }
 * @param {Function} [config.logger] - Optional log function
 * @returns {object} Memory system API
 */
export function createMemorySystem(config) {
  const embeddingClient = createAIClient(config.embedding);
  const llmClient = createAIClient(config.llm);
  const log = config.logger || (() => {});

  // Normalize db to a query function
  const db = normalizeDb(config.db, config.schema);

  return {
    /**
     * Apply database migrations.
     */
    migrate: () => migrate(db, { logger: log }),

    /**
     * Ensure default memory layers exist for a client.
     */
    ensureLayers: (clientId, layerNames) =>
      ensureLayers(db, clientId, layerNames),

    /**
     * Get all layers for a client with memory counts.
     */
    getLayers: (clientId) => getLayers(db, clientId),

    /**
     * Ingest content as a new memory (store + embed + HyDE).
     */
    ingest: (content, opts = {}) =>
      ingest(db, embeddingClient, llmClient, content, { ...opts, logger: log }),

    /**
     * Multi-signal semantic search (cosine + BM25 + recency + frequency).
     */
    search: (query, opts = {}) =>
      search(db, embeddingClient, query, { ...opts, logger: log }),

    /**
     * Text-only search fallback (no embeddings required).
     */
    textSearch: (query, opts = {}) =>
      textSearch(db, query, { ...opts, logger: log }),

    /**
     * Run decay cycle (confidence decay + eviction + capacity enforcement).
     */
    decay: (clientId, opts = {}) =>
      decay(db, clientId, { ...opts, logger: log }),

    /**
     * Consolidate high-access episodic memories to semantic layer.
     */
    consolidate: (clientId, opts = {}) =>
      consolidate(db, embeddingClient, clientId, { ...opts, logger: log }),
  };
}

/**
 * Normalize various db inputs to a query function.
 *
 * Accepts:
 * - A function (sql, params) => {rows} — used as-is
 * - A pg.Pool or Client — wrapped in pool.query()
 * - A connection string — deferred (caller should pass a pool)
 */
function normalizeDb(db, schema) {
  if (typeof db === "function") {
    return db;
  }

  if (db && typeof db.query === "function") {
    // pg.Pool or pg.Client
    return async (sql, params) => {
      if (schema) {
        await db.query(`SET search_path TO ${schema}, public`);
      }
      return db.query(sql, params);
    };
  }

  throw new Error(
    "@pentatonic/memory: db must be a query function (sql, params) => {rows} or a pg.Pool/Client"
  );
}

// Re-export individual functions for advanced usage
export { createAIClient } from "./ai.js";
export { search, textSearch } from "./search.js";
export { ingest, generateHypotheticalQueries } from "./ingest.js";
export { decay } from "./decay.js";
export { consolidate } from "./consolidate.js";
export { ensureLayers, getLayers } from "./layers.js";
export { migrate } from "./migrate.js";
