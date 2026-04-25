/**
 * Hosted-mode helpers for the Pentatonic memory system.
 *
 * These talk to a remote TES tenant over HTTPS using GraphQL, with a
 * `tes_<clientId>_<rand>` bearer token in the Authorization header.
 * They are deliberately thin wrappers around the GraphQL surface so
 * any caller (the OpenClaw plugin, the LLM proxy worker, a custom
 * integration) gets the same wire shape, the same error handling, and
 * the same operational patterns.
 *
 * No `pg`, no Node-only APIs — Workers-compatible. Pure `fetch`.
 *
 * @example
 *   import { hostedSearch, hostedEmitChatTurn } from
 *     "@pentatonic-ai/ai-agent-sdk/memory/hosted";
 *
 *   const config = {
 *     endpoint: "https://acme.api.pentatonic.com",
 *     clientId: "acme",
 *     apiKey:   "tes_acme_xxxxx",
 *   };
 *
 *   const { memories } = await hostedSearch(config, "What's my name?", {
 *     limit: 6, minScore: 0.55, timeoutMs: 800,
 *   });
 *
 *   await hostedEmitChatTurn(config, {
 *     userMessage:       "Hi",
 *     assistantResponse: "Hello!",
 *     model:             "gpt-4o-mini",
 *   }, { source: "my-product" });
 */

const SEMANTIC_SEARCH_QUERY = `
  query SemanticSearchMemories($clientId: String!, $query: String!, $limit: Int, $minScore: Float) {
    semanticSearchMemories(clientId: $clientId, query: $query, limit: $limit, minScore: $minScore) {
      id
      content
      similarity
    }
  }
`;

const CREATE_MODULE_EVENT_MUTATION = `
  mutation CreateModuleEvent($moduleId: String!, $input: ModuleEventInput!) {
    createModuleEvent(moduleId: $moduleId, input: $input) { success eventId }
  }
`;

const DEFAULT_SEARCH_TIMEOUT_MS = 5000;
const DEFAULT_EMIT_TIMEOUT_MS = 10000;
const DEFAULT_SEARCH_LIMIT = 6;
const DEFAULT_SEARCH_MIN_SCORE = 0.55;

/**
 * Normalise a config object — accepts both modern (`endpoint/clientId/apiKey`)
 * and legacy openclaw-style (`tes_endpoint/tes_client_id/tes_api_key`) keys.
 *
 * @param {object} config
 * @returns {{endpoint: string, clientId: string, apiKey: string}}
 */
function normalizeConfig(config) {
  if (!config) throw new Error("hosted: config is required");
  const endpoint = config.endpoint || config.tes_endpoint;
  const clientId = config.clientId || config.tes_client_id;
  const apiKey = config.apiKey || config.tes_api_key;
  if (!endpoint || !clientId || !apiKey) {
    throw new Error(
      "hosted: config requires { endpoint, clientId, apiKey } (or legacy tes_* equivalents)"
    );
  }
  return { endpoint, clientId, apiKey };
}

/**
 * Build the request headers TES expects for hosted-mode calls.
 * Bearer auth if the apiKey starts with `tes_`; otherwise treated as a
 * service key (for internal callers).
 */
export function buildHostedHeaders(config) {
  const { clientId, apiKey } = normalizeConfig(config);
  const headers = {
    "Content-Type": "application/json",
    "x-client-id": clientId,
  };
  if (apiKey.startsWith("tes_")) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  } else {
    headers["x-service-key"] = apiKey;
  }
  return headers;
}

/**
 * Run a semantic memory search against a remote TES tenant.
 *
 * @param {object} config — { endpoint, clientId, apiKey }
 * @param {string} query  — natural-language query
 * @param {object} [opts]
 * @param {number} [opts.limit=6]
 * @param {number} [opts.minScore=0.55]
 * @param {number} [opts.timeoutMs=5000]
 * @returns {Promise<{
 *   memories: Array<{id: string, content: string, similarity: number}>,
 *   skipped?: string,
 * }>}
 *
 * Failure mode: any error returns `{ memories: [], skipped: <reason> }`.
 * Callers (e.g. the LLM proxy) inspect `skipped` to set `X-TES-Skipped`
 * on their response, then forward unmodified. We never throw — the
 * fail-soft contract means a hosted-search call never breaks the
 * caller's primary user-facing flow.
 */
export async function hostedSearch(config, query, opts = {}) {
  if (!query) return { memories: [], skipped: "no_query" };

  let cfg;
  try {
    cfg = normalizeConfig(config);
  } catch (err) {
    return { memories: [], skipped: `config_error:${err.message}` };
  }

  const limit = opts.limit ?? DEFAULT_SEARCH_LIMIT;
  const minScore = opts.minScore ?? DEFAULT_SEARCH_MIN_SCORE;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(`${cfg.endpoint}/api/graphql`, {
      method: "POST",
      headers: buildHostedHeaders(cfg),
      body: JSON.stringify({
        query: SEMANTIC_SEARCH_QUERY,
        variables: { clientId: cfg.clientId, query, limit, minScore },
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    return {
      memories: [],
      skipped: err.name === "AbortError" ? "tes_timeout" : "tes_unreachable",
    };
  }
  clearTimeout(timer);

  if (!response.ok) {
    return { memories: [], skipped: `tes_http_${response.status}` };
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    return { memories: [], skipped: "tes_invalid_json" };
  }

  if (payload.errors?.length) {
    const reason = payload.errors[0].message || "tes_graphql_error";
    return { memories: [], skipped: `tes_graphql:${shortenReason(reason)}` };
  }

  return { memories: payload.data?.semanticSearchMemories || [] };
}

/**
 * Emit a CHAT_TURN event to the conversation-analytics module of a
 * remote TES tenant. The deep-memory consumer also subscribes to
 * CHAT_TURN, so a single emit lands in both pipelines via consumer
 * fan-out at the queue layer.
 *
 * @param {object} config — { endpoint, clientId, apiKey }
 * @param {object} payload
 * @param {string} [payload.userMessage]
 * @param {string} [payload.assistantResponse]
 * @param {string} [payload.model]
 * @param {object} [payload.usage]
 * @param {Array}  [payload.toolCalls]
 * @param {number} [payload.turnNumber]
 * @param {string} [payload.systemPrompt]
 * @param {string} [payload.sessionId]
 * @param {string} [payload.userId]
 * @param {object} [payload.extra] — additional attributes merged onto the event
 * @param {object} [opts]
 * @param {string} [opts.source="tes-sdk"] — attribution string written into attributes.source
 * @param {number} [opts.timeoutMs=10000]
 * @returns {Promise<{ ok: boolean, eventId?: string, skipped?: string }>}
 */
export async function hostedEmitChatTurn(config, payload, opts = {}) {
  if (!payload) return { ok: false, skipped: "no_payload" };
  if (!payload.userMessage && !payload.assistantResponse) {
    return { ok: false, skipped: "empty_turn" };
  }

  let cfg;
  try {
    cfg = normalizeConfig(config);
  } catch (err) {
    return { ok: false, skipped: `config_error:${err.message}` };
  }

  const source = opts.source || "tes-sdk";
  const timeoutMs = opts.timeoutMs ?? DEFAULT_EMIT_TIMEOUT_MS;

  const attributes = { source };
  if (payload.userMessage !== undefined)
    attributes.user_message = payload.userMessage;
  if (payload.assistantResponse !== undefined)
    attributes.assistant_response = payload.assistantResponse;
  if (payload.model) attributes.model = payload.model;
  if (payload.usage) attributes.usage = payload.usage;
  if (payload.toolCalls?.length) attributes.tool_calls = payload.toolCalls;
  if (payload.turnNumber !== undefined)
    attributes.turn_number = payload.turnNumber;
  if (payload.systemPrompt) attributes.system_prompt = payload.systemPrompt;
  if (payload.userId) attributes.user_id = payload.userId;
  if (payload.extra && typeof payload.extra === "object") {
    Object.assign(attributes, payload.extra);
  }

  const data = { attributes };
  if (payload.sessionId) data.entity_id = payload.sessionId;

  const input = { eventType: "CHAT_TURN", data };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(`${cfg.endpoint}/api/graphql`, {
      method: "POST",
      headers: buildHostedHeaders(cfg),
      body: JSON.stringify({
        query: CREATE_MODULE_EVENT_MUTATION,
        variables: { moduleId: "conversation-analytics", input },
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    return {
      ok: false,
      skipped: err.name === "AbortError" ? "tes_timeout" : "tes_unreachable",
    };
  }
  clearTimeout(timer);

  if (!response.ok) {
    return { ok: false, skipped: `tes_http_${response.status}` };
  }

  let body;
  try {
    body = await response.json();
  } catch {
    return { ok: false, skipped: "tes_invalid_json" };
  }

  if (body.errors?.length) {
    return {
      ok: false,
      skipped: `tes_graphql:${shortenReason(body.errors[0].message)}`,
    };
  }

  return {
    ok: !!body.data?.createModuleEvent?.success,
    eventId: body.data?.createModuleEvent?.eventId,
  };
}

/**
 * Emit a STORE_MEMORY event against the deep-memory module. Used by the
 * OpenClaw plugin for explicit memory-write tools.
 *
 * @param {object} config
 * @param {string} content
 * @param {object} [metadata]
 * @param {object} [opts]
 * @param {string} [opts.source="tes-sdk"]
 * @param {number} [opts.timeoutMs=10000]
 * @returns {Promise<{ ok: boolean, eventId?: string, skipped?: string }>}
 */
export async function hostedStoreMemory(
  config,
  content,
  metadata = {},
  opts = {}
) {
  if (!content) return { ok: false, skipped: "no_content" };

  let cfg;
  try {
    cfg = normalizeConfig(config);
  } catch (err) {
    return { ok: false, skipped: `config_error:${err.message}` };
  }

  const source = opts.source || "tes-sdk";
  const timeoutMs = opts.timeoutMs ?? DEFAULT_EMIT_TIMEOUT_MS;

  const data = {
    entity_id: metadata.session_id || metadata.sessionId || source,
    attributes: {
      ...metadata,
      content,
      source,
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(`${cfg.endpoint}/api/graphql`, {
      method: "POST",
      headers: buildHostedHeaders(cfg),
      body: JSON.stringify({
        query: CREATE_MODULE_EVENT_MUTATION,
        variables: {
          moduleId: "deep-memory",
          input: { eventType: "STORE_MEMORY", data },
        },
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    return {
      ok: false,
      skipped: err.name === "AbortError" ? "tes_timeout" : "tes_unreachable",
    };
  }
  clearTimeout(timer);

  if (!response.ok) {
    return { ok: false, skipped: `tes_http_${response.status}` };
  }

  let body;
  try {
    body = await response.json();
  } catch {
    return { ok: false, skipped: "tes_invalid_json" };
  }

  if (body.errors?.length) {
    return {
      ok: false,
      skipped: `tes_graphql:${shortenReason(body.errors[0].message)}`,
    };
  }

  return {
    ok: !!body.data?.createModuleEvent?.success,
    eventId: body.data?.createModuleEvent?.eventId,
  };
}

function shortenReason(msg) {
  if (typeof msg !== "string") return "unknown";
  return msg
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .slice(0, 60);
}

// Re-export the system-message injector so callers that import the
// hosted module get the full memory-augmentation surface in one place.
// Keeping the implementation in `./inject.js` lets non-hosted consumers
// (e.g. a future "augment a request body" helper that doesn't talk to
// TES) reuse it without pulling in the GraphQL surface.
export { injectMemories } from "./inject.js";
