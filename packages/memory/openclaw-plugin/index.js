/**
 * Pentatonic Memory — OpenClaw Context Engine Plugin
 *
 * Install: openclaw plugins install @pentatonic-ai/openclaw-memory-plugin
 *
 * Provides persistent, searchable memory via the ContextEngine lifecycle:
 *   ingest   — every message stored with embedding + HyDE
 *   assemble — relevant memories injected before every prompt
 *   compact  — decay cycle on context overflow
 *   afterTurn — consolidation check
 *
 * Plus agent-callable tools: pentatonic_memory_search, pentatonic_memory_store, pentatonic_memory_status, pentatonic_memory_setup
 *
 * Two modes:
 *   - Local: HTTP calls to the memory server (localhost:3333)
 *   - Hosted: HTTP calls to TES GraphQL API
 *
 * No native modules, no child_process, no filesystem access.
 * All config comes from OpenClaw's plugin config system.
 */

const TES_ENDPOINT = "https://api.pentatonic.com";

// Minimum local memory server version the plugin expects. Bump this when
// the plugin starts relying on new endpoints, schema, or query params.
// A server older than this still works for common operations — the
// mismatch just surfaces as a stderr warning so users know to update.
const MIN_SERVER_VERSION = "0.5.0";

// Track whether we've already warned for a given server version so we
// don't spam stderr every health check.
const warnedServerVersions = new Set();

function parseVersion(v) {
  if (typeof v !== "string") return null;
  const parts = v.split(".").slice(0, 3).map((n) => parseInt(n, 10));
  if (parts.some(Number.isNaN)) return null;
  while (parts.length < 3) parts.push(0);
  return parts;
}

// Returns true when a >= b. Missing or unparseable versions are treated
// as "newer than anything" to avoid false warnings when a server
// pre-dates the /health version field.
function versionGte(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa) return true;
  if (!pb) return true;
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return true;
    if (pa[i] < pb[i]) return false;
  }
  return true;
}

function warnIfServerTooOld(serverVersion) {
  if (warnedServerVersions.has(serverVersion)) return;
  if (versionGte(serverVersion, MIN_SERVER_VERSION)) return;
  warnedServerVersions.add(serverVersion);
  console.error(
    `[pentatonic-memory] WARNING: memory server is ${serverVersion}, plugin needs >= ${MIN_SERVER_VERSION}. ` +
      `Some features may not work until you update — run: npx @pentatonic-ai/ai-agent-sdk@latest memory`
  );
}

const SUCCESS_GIFS = [
  "https://media.giphy.com/media/l0MYt5jPR6QX5APm0/giphy.gif",    // brain expanding
  "https://media.giphy.com/media/3o7btNa0RUYa5E7iiQ/giphy.gif",   // elephant never forgets
  "https://media.giphy.com/media/d31vTpVi1LAcDvdm/giphy.gif",     // thinking smart
  "https://media.giphy.com/media/3o7buirYcmV5nSwIRW/giphy.gif",   // mind blown
  "https://media.giphy.com/media/xT0xeJpnrWC3nQ8S1G/giphy.gif",  // remembering
];

function randomGif() {
  return SUCCESS_GIFS[Math.floor(Math.random() * SUCCESS_GIFS.length)];
}

// --- Stats tracking ---

const stats = {
  memoriesInjected: 0,
  memoriesStored: 0,
  searchesRun: 0,
  lastAssembleCount: 0,
  backendReachable: null,
  mode: "unknown",
  setupPrompted: false,
};

// --- Query keyword extraction ---
// Natural-language prompts ("what were those changes again?") often fall
// below the semantic threshold even when relevant memories exist. We
// drop stopwords and retry with the keyword-distilled form.
const STOPWORDS = new Set([
  "a", "am", "an", "and", "are", "as", "at", "be", "been", "but", "by",
  "can", "did", "do", "does", "for", "from", "had", "has", "have", "he",
  "her", "him", "his", "how", "i", "if", "in", "into", "is", "it", "its",
  "just", "like", "made", "me", "my", "need", "needed", "of", "on", "or",
  "our", "out", "over", "she", "so", "some", "than", "that", "the",
  "their", "them", "then", "there", "these", "they", "this", "those",
  "to", "up", "us", "was", "we", "went", "were", "what", "when", "where",
  "which", "who", "why", "will", "with", "would", "you", "your",
]);

export function extractSearchKeywords(query) {
  if (typeof query !== "string") return null;
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
  if (tokens.length === 0) return null;
  const distilled = tokens.join(" ");
  if (distilled === query.toLowerCase().trim()) return null;
  return distilled;
}

// --- Local mode: HTTP to memory server ---

async function localSearch(baseUrl, query, limit = 5, minScore = 0.3) {
  try {
    const res = await fetch(`${baseUrl}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, limit, min_score: minScore }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) { stats.backendReachable = false; console.error(`[pentatonic-memory] search HTTP ${res.status}`); return []; }
    stats.backendReachable = true;
    const data = await res.json();
    return data.results || [];
  } catch (err) {
    stats.backendReachable = false;
    console.error(`[pentatonic-memory] search fetch error: ${err.message}`);
    return [];
  }
}

async function localStore(baseUrl, content, metadata = {}) {
  try {
    const res = await fetch(`${baseUrl}/store`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, metadata }),
      // Generous timeout — on a Pi, Ollama embed + HyDE generation can take 30-60s per message
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) { stats.backendReachable = false; console.error(`[pentatonic-memory] store HTTP ${res.status}`); return null; }
    stats.backendReachable = true;
    return res.json();
  } catch (err) {
    stats.backendReachable = false;
    console.error(`[pentatonic-memory] store fetch error: ${err.message}`);
    return null;
  }
}

async function localHealth(baseUrl) {
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
    stats.backendReachable = res.ok;
    if (!res.ok) return false;
    // Check for server version mismatch. Warns loudly (but non-fatal)
    // when the server is older than what this plugin expects — the
    // common case is a user who updated the plugin but forgot to
    // re-run `npx @pentatonic-ai/ai-agent-sdk@latest memory`.
    try {
      const data = await res.json();
      if (data?.version) {
        warnIfServerTooOld(data.version);
      }
    } catch { /* health body missing version — older server, no-op */ }
    return true;
  } catch {
    stats.backendReachable = false;
    return false;
  }
}

// --- Hosted mode: TES GraphQL ---

function tesHeaders(config) {
  const headers = {
    "Content-Type": "application/json",
    "x-client-id": config.tes_client_id,
  };
  if (config.tes_api_key?.startsWith("tes_")) {
    headers["Authorization"] = `Bearer ${config.tes_api_key}`;
  } else {
    headers["x-service-key"] = config.tes_api_key;
  }
  return headers;
}

async function hostedSearch(config, query, limit = 5, minScore = 0.3) {
  try {
    const res = await fetch(`${config.tes_endpoint}/api/graphql`, {
      method: "POST",
      headers: tesHeaders(config),
      body: JSON.stringify({
        query: `query($clientId: String!, $query: String!, $limit: Int, $minScore: Float) {
          semanticSearchMemories(clientId: $clientId, query: $query, limit: $limit, minScore: $minScore) {
            id content similarity
          }
        }`,
        variables: { clientId: config.tes_client_id, query, limit, minScore },
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) { stats.backendReachable = false; return []; }
    stats.backendReachable = true;
    const json = await res.json();
    return json.data?.semanticSearchMemories || [];
  } catch {
    stats.backendReachable = false;
    return [];
  }
}

async function hostedStore(config, content, metadata = {}) {
  try {
    const res = await fetch(`${config.tes_endpoint}/api/graphql`, {
      method: "POST",
      headers: tesHeaders(config),
      body: JSON.stringify({
        query: `mutation CreateModuleEvent($moduleId: String!, $input: ModuleEventInput!) {
          createModuleEvent(moduleId: $moduleId, input: $input) { success eventId }
        }`,
        variables: {
          moduleId: "deep-memory",
          input: {
            eventType: "STORE_MEMORY",
            data: {
              entity_id: metadata.session_id || "openclaw",
              attributes: { ...metadata, content, source: "openclaw-plugin" },
            },
          },
        },
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) { stats.backendReachable = false; return null; }
    stats.backendReachable = true;
    return res.json();
  } catch {
    stats.backendReachable = false;
    return null;
  }
}

/**
 * Emit a CHAT_TURN event to TES so the conversation-analytics dashboard
 * (Token Universe + Tools tabs) can render. Without this, the dashboard
 * filters on eventType=CHAT_TURN and shows nothing for OpenClaw users
 * because the only events emitted are STORE_MEMORY.
 *
 * Missing metadata is omitted rather than zeroed — the dashboard
 * distinguishes "no data" from "zero usage".
 */
async function hostedEmitChatTurn(config, sessionId, turn) {
  const attributes = {
    source: "openclaw-plugin",
    user_message: turn.userMessage,
    assistant_response: turn.assistantResponse,
  };
  if (turn.model) attributes.model = turn.model;
  if (turn.usage) attributes.usage = turn.usage;
  if (turn.toolCalls?.length) attributes.tool_calls = turn.toolCalls;
  if (turn.turnNumber !== undefined) attributes.turn_number = turn.turnNumber;
  if (turn.systemPrompt) attributes.system_prompt = turn.systemPrompt;

  try {
    const res = await fetch(`${config.tes_endpoint}/api/graphql`, {
      method: "POST",
      headers: tesHeaders(config),
      body: JSON.stringify({
        query: `mutation Cme($moduleId: String!, $input: ModuleEventInput!) {
          createModuleEvent(moduleId: $moduleId, input: $input) { success eventId }
        }`,
        variables: {
          moduleId: "conversation-analytics",
          input: {
            eventType: "CHAT_TURN",
            data: { entity_id: sessionId, attributes },
          },
        },
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

// Pull model/usage/tool_calls from whatever shape the runtime hands us.
// Different OpenClaw versions wrap provider responses differently — we
// check the obvious places and silently omit fields we can't find.
function extractAssistantMetadata(message) {
  const meta = {};
  if (message?.model) meta.model = message.model;
  if (message?.usage) meta.usage = message.usage;
  if (Array.isArray(message?.tool_calls) && message.tool_calls.length) {
    meta.toolCalls = message.tool_calls;
  } else if (Array.isArray(message?.toolCalls) && message.toolCalls.length) {
    meta.toolCalls = message.toolCalls;
  }
  const raw = message?.raw || message?.response || message?._raw;
  if (raw && typeof raw === "object") {
    if (!meta.model && raw.model) meta.model = raw.model;
    if (!meta.usage && raw.usage) meta.usage = raw.usage;
    if (!meta.toolCalls) {
      if (Array.isArray(raw.content)) {
        const tc = raw.content
          .filter((b) => b?.type === "tool_use")
          .map((b) => ({ tool: b.name, args: b.input || {} }));
        if (tc.length) meta.toolCalls = tc;
      }
      if (!meta.toolCalls && Array.isArray(raw.choices) && raw.choices[0]?.message?.tool_calls) {
        meta.toolCalls = raw.choices[0].message.tool_calls.map((tc) => ({
          tool: tc.function?.name || tc.name,
          args: tc.function?.arguments,
        }));
      }
    }
  }
  return meta;
}

// Per-session turn buffer for CHAT_TURN emission. User message waits
// for the next assistant message in the same session, then emits as
// a paired turn. Capped to avoid unbounded growth.
const MAX_SESSIONS = 500;
const turnBuffers = new Map();
const turnCounters = new Map();

function capSessionMaps() {
  while (turnBuffers.size > MAX_SESSIONS) {
    turnBuffers.delete(turnBuffers.keys().next().value);
  }
  while (turnCounters.size > MAX_SESSIONS) {
    turnCounters.delete(turnCounters.keys().next().value);
  }
}

/** Test helper — clear turn buffers and counters between tests. */
export function _resetTurnBuffersForTest() {
  turnBuffers.clear();
  turnCounters.clear();
}

// --- TES account setup via HTTP ---

async function tesLogin(email, password, clientId) {
  try {
    const res = await fetch(`${TES_ENDPOINT}/api/enrollment/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, clientId }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.tokens?.accessToken || null;
  } catch {
    return null;
  }
}

async function tesEnroll(email, password, clientId, region) {
  try {
    const res = await fetch(`${TES_ENDPOINT}/api/enrollment/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId,
        companyName: clientId,
        industryType: "technology",
        authProvider: "native",
        adminEmail: email,
        adminPassword: password,
        region: (region || "eu").toLowerCase(),
      }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json();
    if (!res.ok) {
      const errors = data.errors || {};
      if (errors.clientId?.includes("already registered")) {
        return { error: "This client ID is already registered. Ask your admin to invite you, then try again." };
      }
      return { error: data.message || Object.values(errors).join(", ") || "Enrollment failed." };
    }
    return { ok: true };
  } catch (err) {
    return { error: `Connection failed: ${err.message}` };
  }
}

async function tesGetApiKey(accessToken, clientId) {
  // Try enrollment service token first
  try {
    const res = await fetch(`${TES_ENDPOINT}/api/enrollment/service-token?client_id=${clientId}`,
      { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const data = await res.json();
      if (data.token) return data.token;
    }
  } catch { /* fallback */ }

  // Create via GraphQL
  try {
    const res = await fetch(`${TES_ENDPOINT}/api/graphql`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        query: `mutation CreateApiToken($clientId: String!, $input: CreateApiTokenInput!) {
          createClientApiToken(clientId: $clientId, input: $input) { success plainTextToken }
        }`,
        variables: { clientId, input: { name: "openclaw-plugin", role: "agent-events" } },
      }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();
    return data.data?.createClientApiToken?.plainTextToken || null;
  } catch {
    return null;
  }
}

// --- Format helpers ---

function formatResults(results) {
  if (!results.length) return "No relevant memories found.";
  return results
    .map((m, i) => `${i + 1}. [${Math.round((m.similarity || 0) * 100)}%] ${m.content}`)
    .join("\n\n");
}

// --- Plugin entry ---

export default {
  id: "pentatonic-memory",
  name: "Pentatonic Memory",
  description: "Persistent, searchable memory with multi-signal retrieval and HyDE query expansion",
  kind: "context-engine",

  register(api) {
    const config = api.pluginConfig || api.config?.plugins?.entries?.["pentatonic-memory"]?.config || api.config || {};
    const hosted = !!(config.tes_endpoint && config.tes_api_key);
    const baseUrl = config.memory_url || "http://localhost:3333";
    const searchLimit = config.search_limit || 5;
    const minScore = config.min_score || 0.3;
    const log = (msg) => console.error(`[pentatonic-memory] ${msg}`);

    stats.mode = hosted ? "hosted" : "local";

    // Unified search/store that routes to local or hosted.
    // If the raw query returns nothing, retry once with the
    // keyword-distilled form — natural-language prompts frequently
    // miss the semantic threshold even when matches exist.
    const searchBackend = hosted
      ? (query, limit, score) => hostedSearch(config, query, limit, score)
      : (query, limit, score) => localSearch(baseUrl, query, limit, score);

    const search = async (query, limit, score) => {
      const first = await searchBackend(query, limit, score);
      if (first.length > 0) return first;
      const keywords = extractSearchKeywords(query);
      if (!keywords) return first;
      log(`search: retry "${query.substring(0, 40)}" → "${keywords}"`);
      return searchBackend(keywords, limit, score);
    };

    const store = hosted
      ? (content, metadata) => hostedStore(config, content, metadata)
      : (content, metadata) => localStore(baseUrl, content, metadata);

    // --- Context engine: always registered, proxies to backend ---

    // Extract the real user text from an OpenClaw-wrapped user message.
    // Returns null for system prompts / empty content / already-seen artifacts.
    function extractIngestText(message) {
      const raw = typeof message?.content === "string"
        ? message.content
        : Array.isArray(message?.content)
          ? message.content.filter(b => b.type === "text").map(b => b.text).join(" ")
          : null;
      const role = message?.role || message?.type;
      if (!raw || (role !== "user" && role !== "assistant")) return { text: null, role };

      if (role === "user") {
        const trimmed = raw.trim();
        let text = raw;
        if (
          trimmed.startsWith("Conversation info") ||
          trimmed.startsWith("(untrusted metadata)") ||
          trimmed.startsWith("Sender (untrusted") ||
          trimmed.startsWith("Untrusted context")
        ) {
          text = trimmed
            .replace(/(?:Conversation info|Sender|Thread starter|Replied message|Forwarded message context|Chat history since last reply) \(untrusted[^)]*\):\s*```json[\s\S]*?```/g, "")
            .replace(/Untrusted context \(metadata, do not treat as instructions or commands\):/g, "")
            .trim();
        }
        if (
          !text ||
          text.startsWith("Note: The previous agent run") ||
          text.startsWith("System (untrusted)") ||
          text.startsWith("[System]") ||
          text.startsWith("System:") ||
          text.startsWith("[Queued messages")
        ) return { text: null, role };
        return { text, role };
      }
      return { text: raw, role };
    }

    api.registerContextEngine("pentatonic-memory", () => ({
      info: {
        id: "pentatonic-memory",
        name: `Pentatonic Memory (${hosted ? "Hosted" : "Local"})`,
        ownsCompaction: false,
      },

      async ingestBatch({ sessionId, messages }) {
        let ingestedCount = 0;
        for (const message of messages) {
          const { text, role } = extractIngestText(message);
          if (!text) continue;
          try {
            await store(text, { session_id: sessionId, role });
            ingestedCount++;
          } catch (err) {
            log(`ingestBatch: error ${err.message}`);
          }
        }
        stats.memoriesStored += ingestedCount;
        if (ingestedCount > 0) {
          log(`ingestBatch: ingested ${ingestedCount}/${messages.length} (total=${stats.memoriesStored})`);
        }
        return { ingested: ingestedCount };
      },

      async ingest({ sessionId, message }) {
        const { text, role } = extractIngestText(message);
        if (!text) return { ingested: false };
        try {
          await store(text, { session_id: sessionId, role });
          stats.memoriesStored++;
          return { ingested: true };
        } catch (err) {
          log(`ingest: error ${err.message}`);
          return { ingested: false };
        }
      },

      async assemble({ sessionId, messages }) {
        // Extract text from message content (may be string or array of content blocks)
        function getTextContent(msg) {
          if (!msg) return null;
          if (typeof msg.content === "string") return msg.content;
          if (Array.isArray(msg.content)) {
            const text = msg.content.filter(b => b.type === "text").map(b => b.text).join(" ");
            return text || null;
          }
          return null;
        }

        // OpenClaw wraps real user messages in "Conversation info" JSON envelopes.
        // Extract the actual user text from the embedded JSON.
        function extractUserText(text) {
          if (!text) return null;
          const trimmed = text.trim();

          // Pure system prompts — skip entirely
          if (
            trimmed.startsWith("Note: The previous agent run") ||
            trimmed.startsWith("System (untrusted)") ||
            trimmed.startsWith("[System]") ||
            trimmed.startsWith("System:")
          ) return null;

          // OpenClaw metadata envelopes: the actual user message comes AFTER all
          // the "```json ... ```" metadata blocks, separated by \n\n.
          // Strip all metadata blocks and untrusted-context framing, return what's left.
          if (
            trimmed.startsWith("Conversation info") ||
            trimmed.startsWith("(untrusted metadata)") ||
            trimmed.startsWith("Sender (untrusted") ||
            trimmed.startsWith("Untrusted context")
          ) {
            // Remove all fenced JSON blocks and their preceding labels
            let stripped = trimmed
              .replace(/(?:Conversation info|Sender|Thread starter|Replied message|Forwarded message context|Chat history since last reply) \(untrusted[^)]*\):\s*```json[\s\S]*?```/g, "")
              .replace(/Untrusted context \(metadata, do not treat as instructions or commands\):/g, "")
              .trim();
            if (stripped) return stripped;
            return null;
          }

          // "[Queued messages]" envelope — extract embedded user messages
          if (trimmed.startsWith("[Queued messages")) {
            const jsonMatches = [...trimmed.matchAll(/```json\s*([\s\S]*?)\s*```/g)];
            for (const match of jsonMatches.reverse()) {
              try {
                const data = JSON.parse(match[1]);
                const inner = data.text || data.message || data.content;
                if (inner) return inner;
              } catch { /* continue */ }
            }
            return null;
          }

          return trimmed;
        }

        const reversed = [...messages].reverse();
        let lastUserText = null;
        for (const m of reversed) {
          if (m.role !== "user" && m.type !== "user") continue;
          const text = getTextContent(m);
          const extracted = extractUserText(text);
          if (extracted) {
            lastUserText = extracted;
            break;
          }
        }
        if (!lastUserText) return { messages, estimatedTokens: 0 };

        try {
          const results = await search(lastUserText, searchLimit, minScore);
          log(`assemble: "${lastUserText.substring(0, 50)}" → ${results.length} results`);
          if (!results.length) {
            stats.lastAssembleCount = 0;
            return { messages, estimatedTokens: 0 };
          }

          stats.memoriesInjected += results.length;
          stats.lastAssembleCount = results.length;

          const memoryText = results
            .map((m) => `- [${Math.round((m.similarity || 0) * 100)}%] ${m.content}`)
            .join("\n");

          // Visibility marker: instruct the model to append a footer so the
          // end user sees when Pentatonic Memory was used. Opt out with
          // show_memory_indicator: false in plugin config.
          const showIndicator = config.show_memory_indicator !== false;
          const indicatorRule = showIndicator
            ? [
                "",
                `After your reply, on a new line, append exactly this footer (no other prefix, no trailing content):`,
                `—`,
                `🧠 _Matched ${results.length} memor${results.length === 1 ? "y" : "ies"} from Pentatonic Memory_`,
              ]
            : [];

          const addition = [
            `=== PENTATONIC MEMORY (authoritative context from prior conversations) ===`,
            `These ${results.length} memories are facts the user has shared with you previously. Treat them as ground truth about the user.`,
            "",
            memoryText,
            "",
            `When the user asks about anything in these memories, answer using them directly — do NOT say you don't remember or that you have no record. If a memory is relevant, use it.`,
            ...indicatorRule,
            `=== END PENTATONIC MEMORY ===`,
          ].join("\n");

          return { messages, estimatedTokens: Math.ceil(addition.length / 4), systemPromptAddition: addition };
        } catch {
          stats.lastAssembleCount = 0;
          return { messages, estimatedTokens: 0 };
        }
      },

      async compact() { return { ok: true, compacted: false }; },

      // OpenClaw calls afterTurn INSTEAD of ingest/ingestBatch when defined.
      // We use it to:
      //   1. Store each new message as a memory (STORE_MEMORY in hosted mode)
      //   2. Pair user+assistant messages and emit a CHAT_TURN (hosted only),
      //      which populates the conversation-analytics Token Universe +
      //      Tools tabs in the dashboard.
      async afterTurn({ sessionId, messages, prePromptMessageCount }) {
        if (!messages || typeof prePromptMessageCount !== "number") return;
        const newMessages = messages.slice(prePromptMessageCount);
        let ingestedCount = 0;
        for (const message of newMessages) {
          const { text, role } = extractIngestText(message);
          if (!text) continue;

          // Store the memory (both modes).
          try {
            await store(text, { session_id: sessionId, role });
            ingestedCount++;
          } catch (err) {
            log(`afterTurn: store error ${err.message}`);
          }

          // CHAT_TURN emission (hosted only). Buffer user messages until
          // an assistant message arrives, then emit the paired turn.
          if (!hosted) continue;
          try {
            if (role === "user") {
              turnBuffers.set(sessionId, { userMessage: text });
              capSessionMaps();
            } else if (role === "assistant") {
              const buf = turnBuffers.get(sessionId);
              const turnNumber = (turnCounters.get(sessionId) || 0) + 1;
              turnCounters.set(sessionId, turnNumber);
              capSessionMaps();
              const meta = extractAssistantMetadata(message);
              await hostedEmitChatTurn(config, sessionId, {
                userMessage: buf?.userMessage,
                assistantResponse: text,
                turnNumber,
                ...meta,
              });
              turnBuffers.delete(sessionId);
            }
          } catch (err) {
            log(`afterTurn: CHAT_TURN emit error ${err.message}`);
          }
        }
        stats.memoriesStored += ingestedCount;
        if (ingestedCount > 0) {
          log(`afterTurn: ingested ${ingestedCount}/${newMessages.length} (total=${stats.memoriesStored})`);
        }
      },
    }));

    // --- Tools ---

    api.registerTool({
      name: "pentatonic_memory_search",
      description: "Search memories for relevant context. Use when you need to recall past conversations, decisions, or knowledge.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to search for" },
          limit: { type: "number", description: "Max results (default 5)" },
        },
        required: ["query"],
      },
      async execute({ query, limit }) {
        stats.searchesRun++;
        return formatResults(await search(query, limit || 5, 0.3));
      },
    });

    api.registerTool({
      name: "pentatonic_memory_store",
      description: "Explicitly store something important. Use for decisions, solutions, or facts worth remembering.",
      parameters: {
        type: "object",
        properties: { content: { type: "string", description: "What to remember" } },
        required: ["content"],
      },
      async execute({ content }) {
        const result = await store(content, { source: "openclaw-tool" });
        if (result) {
          stats.memoriesStored++;
          return `Memory stored. ${randomGif()}`;
        }
        return "Failed to store memory. Is the memory server running?";
      },
    });

    api.registerTool({
      name: "pentatonic_memory_status",
      description: "Check the status of the Pentatonic Memory system. Shows mode, backend health, and session stats.",
      parameters: { type: "object", properties: {} },
      async execute() {
        // Refresh health check
        if (!hosted) await localHealth(baseUrl);

        const lines = [
          `**Pentatonic Memory Status**`,
          ``,
          `Mode: ${stats.mode}`,
          `Backend: ${hosted ? config.tes_endpoint : baseUrl}`,
          `Status: ${stats.backendReachable ? "connected" : "unreachable"}`,
          ``,
          `**Session Stats:**`,
          `Memories injected into prompts: ${stats.memoriesInjected}`,
          `Memories stored: ${stats.memoriesStored}`,
          `Explicit searches: ${stats.searchesRun}`,
          `Last prompt: ${stats.lastAssembleCount} memories used`,
        ];

        if (stats.backendReachable) {
          lines.push("", randomGif());
        } else {
          lines.push("", "Run `npx @pentatonic-ai/ai-agent-sdk memory` to start the local memory server.");
        }

        return lines.join("\n");
      },
    });

    api.registerTool({
      name: "pentatonic_memory_setup",
      description: `Set up or reconfigure Pentatonic Memory. Use this when:
- The user wants to set up memory for the first time
- The user wants to switch between local and hosted mode
- The user wants to connect to Pentatonic TES (hosted cloud memory)

Two modes available:
1. "check_local" — Check if local memory server is running at localhost:3333
2. "setup_hosted" — Create a Pentatonic TES account and get API credentials. Requires email, client_id (company name), password, and region (EU/US).
3. "verify_hosted" — After email verification, check if the account is ready. Requires email, password, client_id.

For local mode: just check if the server is running. If not, tell the user to run the setup command on their server.
For hosted mode: walk through account creation step by step via chat.`,
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["check_local", "setup_hosted", "verify_hosted"],
            description: "Which setup action to perform",
          },
          email: { type: "string", description: "User email (hosted only)" },
          client_id: { type: "string", description: "Company/org identifier (hosted only)" },
          password: { type: "string", description: "Account password (hosted only)" },
          region: { type: "string", enum: ["EU", "US"], description: "Data region (hosted only)" },
        },
        required: ["action"],
      },
      async execute({ action, email, client_id, password, region }) {
        if (action === "check_local") {
          const healthy = await localHealth(baseUrl);
          if (healthy) {
            return [
              `Local memory server is running at ${baseUrl}`,
              "",
              "Memory is active. Every conversation is being stored and searched automatically.",
              "",
              randomGif(),
            ].join("\n");
          }
          return [
            `Local memory server is not reachable at ${baseUrl}.`,
            "",
            "To start the memory stack, someone needs to run this on the server:",
            "```",
            "npx @pentatonic-ai/ai-agent-sdk memory",
            "```",
            "",
            "This starts PostgreSQL + pgvector, Ollama, and the memory server via Docker.",
            "Once running, memory will activate automatically — no restart needed.",
          ].join("\n");
        }

        if (action === "setup_hosted") {
          if (!email || !client_id || !password) {
            return "I need your email, a client ID (your company name), and a password to create the account. What's your email?";
          }

          // Check if already verified
          const existingToken = await tesLogin(email, password, client_id);
          if (existingToken) {
            const apiKey = await tesGetApiKey(existingToken, client_id);
            if (apiKey) {
              const endpoint = `https://${client_id}.api.pentatonic.com`;
              return [
                "Account already verified! Here are your credentials:",
                "",
                `**TES Endpoint:** ${endpoint}`,
                `**Client ID:** ${client_id}`,
                `**API Key:** ${apiKey}`,
                "",
                "Add this to your openclaw.json plugin config to activate hosted memory:",
                "```json",
                JSON.stringify({ tes_endpoint: endpoint, tes_client_id: client_id, tes_api_key: apiKey }, null, 2),
                "```",
                "",
                randomGif(),
              ].join("\n");
            }
          }

          // Enroll
          const result = await tesEnroll(email, password, client_id, region);
          if (result.error) return result.error;

          return [
            "Account created! Check your email for a verification link.",
            "",
            `Email: ${email}`,
            `Client ID: ${client_id}`,
            "",
            "Once you've clicked the verification link, tell me and I'll finish the setup.",
          ].join("\n");
        }

        if (action === "verify_hosted") {
          if (!email || !client_id || !password) {
            return "I need your email, client ID, and password to check verification status.";
          }

          const token = await tesLogin(email, password, client_id);
          if (!token) {
            return "Account not verified yet. Check your email for the verification link and try again.";
          }

          const apiKey = await tesGetApiKey(token, client_id);
          if (!apiKey) {
            return "Account verified but I couldn't generate an API key. Try again in a moment.";
          }

          const endpoint = `https://${client_id}.api.pentatonic.com`;
          return [
            "Email verified! Here are your credentials:",
            "",
            `**TES Endpoint:** ${endpoint}`,
            `**Client ID:** ${client_id}`,
            `**API Key:** \`${apiKey}\``,
            "",
            "Add this to your openclaw.json plugin config:",
            "```json",
            JSON.stringify({ tes_endpoint: endpoint, tes_client_id: client_id, tes_api_key: apiKey }, null, 2),
            "```",
            "",
            "Then restart the gateway to switch to hosted mode.",
            "",
            randomGif(),
          ].join("\n");
        }

        return "Unknown action. Use check_local, setup_hosted, or verify_hosted.";
      },
    });

    // Check backend health on startup
    if (!hosted) {
      localHealth(baseUrl).then((ok) => {
        log(ok ? `Memory server healthy at ${baseUrl}` : `Memory server not reachable at ${baseUrl}`);
      });
    } else {
      stats.backendReachable = true; // assume hosted is reachable
    }

    log(`Plugin registered (${hosted ? "hosted" : "local"} — ${hosted ? config.tes_endpoint : baseUrl})`);
  },
};
