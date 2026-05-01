/**
 * Corpus ingest adapters — concrete implementations of the
 *   { ingestChunk, deleteByCorpusFile }
 * contract that the corpus pipeline depends on.
 *
 * `localAdapter`  — writes via the existing memory.ingest() against a pg
 *                   pool (or any query function). Stores corpus chunks
 *                   in the `semantic` layer with metadata.source_file
 *                   and metadata.corpus_file_key.
 *
 * `hostedAdapter` — calls the existing `createMemory` GraphQL mutation
 *                   on deep-memory directly. This bypasses the
 *                   STORE_MEMORY event queue (which has max_batch_size=1
 *                   and would be the wrong shape for bulk ingest) and
 *                   writes synchronously into the explicit `semantic`
 *                   layer with full metadata.
 *
 *                   Companion TES PR required: the createMemory resolver
 *                   currently hardcodes layerType: "episodic" even when
 *                   layerId is supplied — see the audit notes in
 *                   specs/01-onboarding-repo-ingest.md §12. Until that
 *                   ships, chunks will land in episodic and may decay.
 */

import { ingest } from "../ingest.js";
import { buildHostedHeaders } from "../hosted.js";

const CREATE_MEMORY_MUTATION = `
  mutation CreateMemory($clientId: String!, $layerId: String!, $content: String!, $metadata: JSON) {
    createMemory(clientId: $clientId, layerId: $layerId, content: $content, metadata: $metadata) {
      id
      layer_id
    }
  }
`;

const MEMORY_LAYERS_QUERY = `
  query MemoryLayers($clientId: String!) {
    memoryLayers(clientId: $clientId) {
      id
      name
      layer_type
      is_active
    }
  }
`;

const DELETE_BY_METADATA_MUTATION = `
  mutation DeleteMemoryNodesByMetadata($clientId: String!, $metadataKey: String!, $metadataValue: String!) {
    deleteMemoryNodesByMetadata(clientId: $clientId, metadataKey: $metadataKey, metadataValue: $metadataValue)
  }
`;

const DEFAULT_LAYER = "semantic";

/**
 * Build a local adapter against a memory system instance.
 *
 * @param {object} memory - createMemorySystem() result OR raw deps
 * @param {object} opts
 * @param {string} opts.clientId - Required, used as memory_layers.client_id
 * @param {string} [opts.userId]
 * @param {string} [opts.layer="semantic"]
 * @returns {{ingestChunk, deleteByCorpusFile, init}}
 */
export function localAdapter(memory, opts = {}) {
  if (!opts.clientId) throw new Error("localAdapter: clientId is required");

  const layer = opts.layer || DEFAULT_LAYER;

  return {
    /**
     * One-time setup — ensure the target layer exists.
     */
    async init() {
      // memory.ensureLayers takes a single clientId and creates all four
      // default layers idempotently. Safe to call repeatedly.
      if (typeof memory.ensureLayers === "function") {
        await memory.ensureLayers(opts.clientId);
      }
    },

    async ingestChunk(content, metadata) {
      // Code references aren't conversational user-stated facts, so the
      // distill step (which runs an "extract atomic facts from a
      // conversation" prompt) is at best wasted compute and at worst
      // hallucinates "user" facts from code structure that pollute the
      // semantic layer. Skip distillation for corpus ingest.
      const ingestOpts = {
        clientId: opts.clientId,
        userId: opts.userId,
        layerType: layer,
        metadata,
        distill: false,
      };
      // Use memory.ingest if we have the high-level API, otherwise fall
      // back to the lower-level ingest() function with explicit deps.
      if (typeof memory.ingest === "function") {
        const result = await memory.ingest(content, ingestOpts);
        return { id: result.id };
      }
      // Direct ingest() form — caller passed { db, ai, llm }
      const result = await ingest(
        memory.db,
        memory.ai,
        memory.llm,
        content,
        ingestOpts
      );
      return { id: result.id };
    },

    /**
     * Delete all memory_nodes whose metadata.corpus_file_key matches
     * `${repoAbs}::${relPath}`. Used when re-ingesting a changed file
     * or removing a vanished one.
     *
     * Returns the number of rows deleted.
     */
    async deleteByCorpusFile(repoAbs, relPath) {
      if (!memory.db) {
        throw new Error(
          "localAdapter: deleteByCorpusFile requires { db } on the memory deps"
        );
      }
      const key = `${repoAbs}::${relPath}`;
      const res = await memory.db(
        `DELETE FROM memory_nodes
         WHERE client_id = $1
           AND metadata->>'corpus_file_key' = $2
         RETURNING id`,
        [opts.clientId, key]
      );
      return (res.rows || []).length;
    },
  };
}

/**
 * Hosted adapter — calls the deep-memory `createMemory` GraphQL
 * mutation directly so corpus chunks land in the chosen layer
 * (semantic by default) with embedding + HyDE applied server-side.
 *
 * Why not events?
 *   The STORE_MEMORY event path is fine for chat-turn fan-out (one
 *   event per conversation turn) but is the wrong shape for bulk
 *   corpus ingest. The Cloudflare consumer queue is configured with
 *   max_batch_size=1 and max_concurrency=30 (see
 *   thing-event-system/workers/wrangler.epic.toml), so 12,000 chunks
 *   would mean 12,000 individual consumer invocations — slow, and
 *   the existing consumer also hardcodes layer routing to "episodic"
 *   (which would decay code chunks within days). Calling the GraphQL
 *   mutation directly is faster, cheaper, and lets us specify the
 *   layer explicitly.
 *
 * Required TES companion fix:
 *   modules/deep-memory/graphql/memory/resolvers.js#createMemory
 *   accepts a layerId argument and validates the row exists, but
 *   then ignores it and writes to "episodic" anyway. A one-line
 *   change to read layer_type from the validated row makes it honor
 *   the request. Until that lands, chunks ingested via this adapter
 *   will land in episodic; once it lands, they go to whatever layer
 *   was requested (default: semantic).
 *
 * Deletion:
 *   No `deleteMemoriesByMetadata` mutation exists today. The adapter
 *   logs the intent locally but cannot drop server-side chunks for
 *   removed files — those will accumulate. Documented as a follow-up.
 *
 * @param {object} config - { endpoint, clientId, apiKey } (or tes_* legacy)
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=15000]
 * @param {string} [opts.layerName="semantic"] - Target layer name; resolved to layerId via memoryLayers query on first call
 */
export function hostedAdapter(config, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 15000;
  const layerName = opts.layerName || DEFAULT_LAYER;

  const endpoint = config.endpoint || config.tes_endpoint;
  const clientId = config.clientId || config.tes_client_id;
  const apiKey = config.apiKey || config.tes_api_key;
  if (!endpoint || !clientId || !apiKey) {
    throw new Error(
      "hostedAdapter: requires { endpoint, clientId, apiKey } (tes_* keys also accepted)"
    );
  }
  const cfg = { endpoint, clientId, apiKey };
  const headers = buildHostedHeaders(cfg);

  let layerId = null;
  let layerLookupPromise = null;

  async function graphql(query, variables) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${cfg.endpoint}/api/graphql`, {
        method: "POST",
        headers,
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        return { error: `tes_http_${res.status}` };
      }
      const body = await res.json();
      if (body?.errors?.length) {
        return {
          error: `tes_graphql_error:${body.errors[0]?.message}`,
          errors: body.errors,
        };
      }
      return { data: body.data };
    } catch (err) {
      clearTimeout(timer);
      return {
        error: err.name === "AbortError" ? "tes_timeout" : "tes_unreachable",
      };
    }
  }

  async function resolveLayerId() {
    if (layerId) return layerId;
    if (layerLookupPromise) return layerLookupPromise;

    layerLookupPromise = (async () => {
      const result = await graphql(MEMORY_LAYERS_QUERY, { clientId });
      if (result.error) {
        throw new Error(`hostedAdapter: layer lookup failed (${result.error})`);
      }
      const layers = result.data?.memoryLayers || [];
      const match = layers.find(
        (l) => l.is_active && (l.name === layerName || l.layer_type === layerName)
      );
      if (!match) {
        throw new Error(
          `hostedAdapter: no active layer named "${layerName}" for client ${clientId}. ` +
            `Available: ${layers.map((l) => l.name).join(", ") || "<none>"}. ` +
            `Ensure the deep-memory module is enabled in the TES dashboard.`
        );
      }
      layerId = match.id;
      return layerId;
    })();
    return layerLookupPromise;
  }

  return {
    async init() {
      // Resolve the target layerId now so we fail fast if the module
      // isn't enabled or the layer doesn't exist.
      await resolveLayerId();
    },

    async ingestChunk(content, metadata) {
      // Note: distillation happens (or not) server-side. We can't pass
      // distill:false through createMemory the way localAdapter does.
      // metadata.kind = "code_reference" is the signal downstream
      // consumers should branch on to skip the conversation-shaped
      // distiller. Tracked as a follow-up TES change.
      const lid = await resolveLayerId();
      const result = await graphql(CREATE_MEMORY_MUTATION, {
        clientId,
        layerId: lid,
        content,
        metadata,
      });
      if (result.error) return { skipped: result.error };
      return { id: result.data?.createMemory?.id };
    },

    async deleteByCorpusFile(repoAbs, relPath) {
      // Calls the deleteMemoryNodesByMetadata mutation added in TES
      // PR #245. Server-side returns the rowcount; we propagate it.
      // If the mutation isn't deployed yet (older TES tenant), the
      // GraphQL error is swallowed as a skipped delete — the SDK's
      // local state still drops the entry on its side, and orphaned
      // server-side chunks accumulate until the TES PR lands.
      const key = `${repoAbs}::${relPath}`;
      const result = await graphql(DELETE_BY_METADATA_MUTATION, {
        clientId,
        metadataKey: "corpus_file_key",
        metadataValue: key,
      });
      if (result.error) {
        // Older TES tenants (pre-PR-245) will reject the unknown
        // mutation; treat as zero deletions rather than throwing.
        return 0;
      }
      return result.data?.deleteMemoryNodesByMetadata || 0;
    },
  };
}

/**
 * Engine adapter — talks directly to the memory engine's HTTP API
 * (`/store`, `/store-batch`, `/forget`) at `engineUrl`. Used for the
 * local-OSS path where no TES is involved, and for any case where the
 * caller wants to ingest straight into a Pentatonic-managed engine
 * without going through the TES GraphQL surface.
 *
 * Wire format matches the engine's compat shim. References-mode
 * metadata (kind: "code_reference") and arbitrary metadata pass
 * through as JSONB on the engine side.
 *
 * @param {object} config
 * @param {string} config.engineUrl - e.g. "http://localhost:8099"
 * @param {string} [config.arena] - tenant scope; defaults to "default"
 * @param {string} [config.apiKey] - optional Authorization: Bearer
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=30000]
 * @returns {{ingestChunk, deleteByCorpusFile, init}}
 */
export function engineAdapter(config, opts = {}) {
  const engineUrl = (config.engineUrl || "").replace(/\/$/, "");
  if (!engineUrl) {
    throw new Error("engineAdapter: engineUrl is required");
  }
  const arena = config.arena || "default";
  const apiKey = config.apiKey || null;
  const timeoutMs = opts.timeoutMs ?? 30000;

  function headers() {
    const h = { "content-type": "application/json" };
    if (apiKey) h["authorization"] = `Bearer ${apiKey}`;
    return h;
  }

  async function http(path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${engineUrl}${path}`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) return { error: `engine_http_${res.status}` };
      return { data: await res.json() };
    } catch (err) {
      clearTimeout(timer);
      return {
        error: err.name === "AbortError" ? "engine_timeout" : "engine_unreachable",
      };
    }
  }

  return {
    /**
     * Verify the engine is reachable before kicking off ingest.
     * Engine /health returns 200 even when individual layers are
     * "degraded"; we just check the HTTP path works.
     */
    async init() {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(`${engineUrl}/health`, {
          headers: headers(),
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (!res.ok) {
          throw new Error(`engineAdapter: /health returned ${res.status}`);
        }
      } catch (err) {
        clearTimeout(timer);
        throw new Error(
          `engineAdapter: engine at ${engineUrl} unreachable (${err.message})`
        );
      }
    },

    async ingestChunk(content, metadata) {
      // Engine ingests via /store; one chunk per call. The corpus
      // pipeline batches at the file level, but each chunk is its own
      // /store call so we get a per-chunk id back. /store-batch is
      // available for future bulk ingest if/when the pipeline rewires.
      const body = { content, metadata: { ...metadata, arena } };
      const result = await http("/store", body);
      if (result.error) return { skipped: result.error };
      return { id: result.data?.id };
    },

    async deleteByCorpusFile(repoAbs, relPath) {
      const key = `${repoAbs}::${relPath}`;
      const result = await http("/forget", {
        metadata_contains: { corpus_file_key: key },
        arena,
      });
      if (result.error) return 0;
      return result.data?.deleted ?? 0;
    },
  };
}
