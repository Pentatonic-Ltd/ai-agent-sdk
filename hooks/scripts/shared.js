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

export function loadConfig() {
  const candidates = [
    join(homedir(), ".claude", "tes-memory.local.md"),
    join(homedir(), ".claude-pentatonic", "tes-memory.local.md"),
  ];
  if (process.env.CLAUDE_CONFIG_DIR) {
    candidates.unshift(
      join(process.env.CLAUDE_CONFIG_DIR, "tes-memory.local.md")
    );
  }
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
  return config;
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

// --- Memory Operations (mode-aware) ---

/**
 * Search memories. Routes to TES GraphQL or local memory server.
 */
export async function searchMemories(config, query) {
  if (config.mode === "local") {
    return searchLocal(config, query);
  }
  return searchHosted(config, query);
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
                source: "claude-code-plugin",
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
                source: "claude-code-plugin",
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
