/**
 * Shared utilities for hook scripts.
 * Config loading, memory operations, and turn state management.
 *
 * Supports two modes:
 *   - "hosted" — calls TES GraphQL (existing behavior)
 *   - "local"  — calls the memory system directly via HTTP
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir, tmpdir } from "os";

// --- Config ---

/**
 * Resolve TES config with per-project override support.
 *
 * Resolution order (first hit wins):
 *   1. $CLAUDE_PROJECT_DIR/.claude/tes-memory.local.md   — repo-local override
 *   2. $CLAUDE_CONFIG_DIR/tes-memory.local.md            — CLI-provided dir
 *   3. ~/.claude/tes-memory.local.md                     — personal default
 *   4. ~/.claude-pentatonic/tes-memory.local.md          — legacy location
 *
 * This lets a single machine route different projects to different TES
 * tenants (e.g. work vs personal, staging vs prod) without env hacks:
 * drop `.claude/tes-memory.local.md` in the repo and Claude Code picks it
 * up automatically via CLAUDE_PROJECT_DIR.
 *
 * The returned object has a non-enumerable `_path` field (string) telling
 * callers which file was resolved — useful for diagnostics.
 *
 * `agent_id` defaults to `basename($CLAUDE_PROJECT_DIR)` if not declared in
 * frontmatter, so events get attributed to the project even when configs
 * are shared.
 */
export function loadConfig() {
  const candidates = [];
  if (process.env.CLAUDE_PROJECT_DIR) {
    candidates.push(
      join(process.env.CLAUDE_PROJECT_DIR, ".claude", "tes-memory.local.md")
    );
  }
  if (process.env.CLAUDE_CONFIG_DIR) {
    candidates.push(join(process.env.CLAUDE_CONFIG_DIR, "tes-memory.local.md"));
  }
  candidates.push(join(homedir(), ".claude", "tes-memory.local.md"));
  candidates.push(join(homedir(), ".claude-pentatonic", "tes-memory.local.md"));

  const configPath = candidates.find((p) => existsSync(p));
  if (!configPath) return null;

  const content = readFileSync(configPath, "utf-8");
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const config = {};
  for (const line of match[1].split("\n")) {
    const [key, ...rest] = line.split(":");
    if (key && rest.length) {
      config[key.trim()] = rest.join(":").trim();
    }
  }

  // agent_id defaults to the project dir basename when unset, so events
  // stay attributable even when projects share a config file.
  if (!config.agent_id && process.env.CLAUDE_PROJECT_DIR) {
    config.agent_id = process.env.CLAUDE_PROJECT_DIR.split("/")
      .filter(Boolean)
      .pop();
  }

  // _path is for diagnostics (doctor, logs) — hidden from attribute spread.
  Object.defineProperty(config, "_path", {
    value: configPath,
    enumerable: false,
    writable: false,
  });
  return config;
}

/**
 * Build the `source` attribute emitted alongside every event.
 * Format: `claude-code-<agent_id>` — falls back to `claude-code-plugin`
 * when agent_id isn't resolvable (shouldn't happen under Claude Code,
 * but keeps the field non-empty for diagnostic paths).
 */
function eventSource(config) {
  return config?.agent_id
    ? `claude-code-${config.agent_id}`
    : "claude-code-plugin";
}

// --- Version check ---

// Minimum memory-server version the hooks expect. Bump when the hooks
// start relying on a new endpoint, schema, or query param. Older servers
// still work for common operations — the mismatch just surfaces as a
// stderr warning so users know to update.
const MIN_SERVER_VERSION = "0.5.0";

function parseVersion(v) {
  if (typeof v !== "string") return null;
  const parts = v.split(".").slice(0, 3).map((n) => parseInt(n, 10));
  if (parts.some(Number.isNaN)) return null;
  while (parts.length < 3) parts.push(0);
  return parts;
}

export function versionGte(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return true;
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return true;
    if (pa[i] < pb[i]) return false;
  }
  return true;
}

/**
 * Check that the local memory server is at least MIN_SERVER_VERSION.
 * Logs a stderr warning if not. Best-effort — silent if the server is
 * unreachable or doesn't expose a version.
 */
export async function checkLocalServerVersion(config) {
  const baseUrl = config?.memory_url || "http://localhost:3333";
  try {
    const res = await fetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return;
    const data = await res.json();
    const serverVersion = data?.version;
    if (!serverVersion) return;
    if (versionGte(serverVersion, MIN_SERVER_VERSION)) return;
    process.stderr.write(
      `[pentatonic-memory] WARNING: memory server is ${serverVersion}, hooks need >= ${MIN_SERVER_VERSION}. ` +
        `Some features may not work. Run: npx @pentatonic-ai/ai-agent-sdk@latest memory\n`
    );
  } catch {
    // Unreachable / malformed — silent
  }
}

// --- Memory Context Formatting ---

/**
 * Build the additionalContext string that UserPromptSubmit injects when
 * memories are found. Includes a visible footer instruction so the end
 * user can see when Pentatonic Memory was used in a reply.
 *
 * The config is the parsed frontmatter from tes-memory.local.md, so
 * values are strings. Disable the indicator with
 *   show_memory_indicator: false
 *
 * @param {object} config
 * @param {Array<{similarity?: number, content: string}>} memories
 * @returns {string}
 */
export function buildMemoryContext(config, memories) {
  const memoryText = memories
    .map((m) => `- [${Math.round((m.similarity || 0) * 100)}%] ${m.content}`)
    .join("\n");

  const showIndicator = config?.show_memory_indicator !== "false";
  const n = memories.length;
  const indicatorRule = showIndicator
    ? [
        "",
        "After your reply, on a new line, append exactly this footer (no other prefix, no trailing content):",
        "—",
        `🧠 _Used ${n} memor${n === 1 ? "y" : "ies"} from Pentatonic Memory_`,
        "",
        "If the memories above were not relevant to your reply, omit the footer.",
      ].join("\n")
    : "";

  return `[Memory] Related knowledge:\n${memoryText}${indicatorRule}`;
}

// --- Memory Operations (mode-aware) ---

// Stopwords dropped when distilling a verbose prompt to keyword form.
// Kept small on purpose: we only want to strip obvious filler so the
// remaining tokens are content-bearing enough for semantic search.
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

/**
 * Extract keyword-dense query from a verbose prompt. Drops stopwords,
 * preserves hyphenated compounds, keeps tokens >=2 chars. Used to retry
 * a semantic search when the raw prompt returned nothing — short
 * keyword-dense queries hit the embedding index far more reliably than
 * long pronoun-heavy natural-language prompts.
 *
 * Returns null if the distilled form is identical to (or a superset of)
 * the original, so callers can skip a redundant retry.
 */
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

/**
 * Search memories. Routes to TES GraphQL or local memory server.
 *
 * If the raw query returns no results, we retry once with a
 * keyword-distilled form. Natural-language prompts ("what were those
 * changes again?") often fall below the semantic threshold even when
 * relevant memories exist — stripping to content words recovers them.
 */
export async function searchMemories(config, query) {
  const search = config.mode === "local" ? searchLocal : searchHosted;
  const first = await search(config, query);
  if (first.length > 0) return first;
  const keywords = extractSearchKeywords(query);
  if (!keywords) return first;
  return search(config, keywords);
}

/**
 * Store a memory. Routes to TES GraphQL or local memory server.
 */
export async function storeMemory(config, content, metadata = {}) {
  if (config.mode === "local") {
    return storeLocal(config, content, metadata);
  }
  return storeHosted(config, content, metadata);
}

// --- Local mode: direct HTTP to memory server ---

async function searchLocal(config, query) {
  const baseUrl = config.memory_url || "http://localhost:3333";
  try {
    const response = await fetch(`${baseUrl}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, limit: 5, min_score: 0.3 }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return [];
    const data = await response.json();
    return data.results || [];
  } catch {
    return [];
  }
}

async function storeLocal(config, content, metadata) {
  const baseUrl = config.memory_url || "http://localhost:3333";
  try {
    const response = await fetch(`${baseUrl}/store`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, metadata }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return null;
    return response.json();
  } catch {
    return null;
  }
}

// --- Hosted mode: TES GraphQL ---

const CREATE_MODULE_EVENT_MUTATION = `
  mutation CreateModuleEvent($moduleId: String!, $input: ModuleEventInput!) {
    createModuleEvent(moduleId: $moduleId, input: $input) { success eventId }
  }
`;

function tesHeaders(config) {
  const headers = {
    "Content-Type": "application/json",
    "x-client-id": config.tes_client_id,
  };
  if (config.tes_api_key?.startsWith("tes_")) {
    headers["Authorization"] = `Bearer ${config.tes_api_key}`;
  } else if (config.tes_api_key) {
    headers["x-service-key"] = config.tes_api_key;
  }
  return headers;
}

async function searchHosted(config, query) {
  try {
    const response = await fetch(`${config.tes_endpoint}/api/graphql`, {
      method: "POST",
      headers: tesHeaders(config),
      body: JSON.stringify({
        query: `query($clientId: String!, $query: String!) {
          semanticSearchMemories(clientId: $clientId, query: $query, limit: 5, minScore: 0.3) {
            id content similarity
          }
        }`,
        variables: { clientId: config.tes_client_id, query },
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return [];
    const json = await response.json();
    return json.data?.semanticSearchMemories || [];
  } catch {
    return [];
  }
}

async function storeHosted(config, content, metadata) {
  try {
    const response = await fetch(`${config.tes_endpoint}/api/graphql`, {
      method: "POST",
      headers: tesHeaders(config),
      body: JSON.stringify({
        query: CREATE_MODULE_EVENT_MUTATION,
        variables: {
          moduleId: "deep-memory",
          input: {
            eventType: "STORE_MEMORY",
            data: {
              entity_id: metadata.session_id || "hook",
              attributes: {
                ...metadata,
                content,
                agent_id: config.agent_id,
                source: eventSource(config),
                user_id: config.tes_user_id || undefined,
              },
            },
          },
        },
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return null;
    return response.json();
  } catch {
    return null;
  }
}

/**
 * Emit an event via TES GraphQL (hosted mode only).
 */
export async function emitModuleEvent(config, moduleId, eventType, entityId, attributes) {
  if (config.mode === "local") return null; // Local mode stores directly
  try {
    const response = await fetch(`${config.tes_endpoint}/api/graphql`, {
      method: "POST",
      headers: tesHeaders(config),
      body: JSON.stringify({
        query: CREATE_MODULE_EVENT_MUTATION,
        variables: {
          moduleId,
          input: {
            eventType,
            data: {
              entity_id: entityId,
              attributes: {
                ...attributes,
                agent_id: config.agent_id,
                source: eventSource(config),
                user_id: config.tes_user_id || undefined,
              },
            },
          },
        },
      }),
    });
    if (!response.ok) throw new Error(`TES API error: ${response.status}`);
    return response.json();
  } catch {
    return null;
  }
}

// --- Turn State (temp file per session) ---

function turnStatePath(sessionId) {
  const dir = join(tmpdir(), "tes-claude-code");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return join(dir, `turn-${sessionId}.json`);
}

export function readTurnState(sessionId) {
  const path = turnStatePath(sessionId);
  if (!existsSync(path)) {
    return { tool_calls: [], turn_number: 0 };
  }
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return { tool_calls: [], turn_number: 0 };
  }
}

export function writeTurnState(sessionId, state) {
  writeFileSync(turnStatePath(sessionId), JSON.stringify(state));
}

export function clearTurnState(sessionId) {
  const path = turnStatePath(sessionId);
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

// --- Stdin helper ---

export function readStdin() {
  try {
    return JSON.parse(readFileSync(0, "utf-8"));
  } catch {
    return {};
  }
}
