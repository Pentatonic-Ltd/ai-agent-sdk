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

// --- Memory Context Formatting ---

/**
 * Strip obvious UI/dashboard metadata from a stored memory's content
 * before injection. Our memories often contain verbatim dashboard dumps
 * from past debugging sessions (timestamps, layer ids, confidence/decay
 * fields, trailing JSON metadata blobs). That noise pulls the model's
 * attention away from the actual user fact.
 *
 * Conservative: if stripping leaves fewer than 20 meaningful chars,
 * fall back to the original content — better a noisy signal than none.
 */
// Fields that appear only in our TES event-metadata blobs — used to
// recognise inline JSON dumps and strip them out of memory content.
const TES_META_FIELDS =
  "event_id|event_type|entity_type|source|clientId|correlationId|timestamp|session_id|layer_id|confidence|decay_rate|user_id";

export const MEMORY_MAX_LEN = 600;

export function sanitizeMemoryContent(content) {
  if (typeof content !== "string") return content;
  let out = content;

  // Trailing JSON metadata blob at end-of-memory. No `m` flag so `$`
  // means end-of-string, not end-of-line — otherwise this would strip
  // legitimate inline JSON snippets that just happen to sit on a line.
  out = out.replace(/\n\{\s*\n[\s\S]*?\n\s*\}\s*$/, "");

  // Inline JSON metadata blobs — 2+ consecutive "field":"value" lines
  // inside braces where the fields are all known TES metadata keys.
  // Matches our dashboard dumps without eating legitimate code samples.
  out = out.replace(
    new RegExp(
      `\\{\\s*\\n(\\s*"(?:${TES_META_FIELDS})"[^\\n]*\\n){2,}\\s*\\}`,
      "g"
    ),
    ""
  );

  // Dashboard-UI lines that appear on their own.
  const linePatterns = [
    /^\s*anonymous\s*$/gm,
    /^\s*ml_[a-z0-9_-]+_(episodic|semantic|procedural|working)\s*$/gm,
    /^\s*\d+%\s*match\s*$/gm,
    /^\s*Confidence:\s*\d+%\s*$/gm,
    /^\s*Accessed:\s*\d+x?\s*$/gm,
    /^\s*<?\s*\d+[smhd]\s*ago\s*$/gm,
    /^\s*Decay:\s*[\d.]+\s*$/gm,
    /^\s*Metadata\s*$/gm,
  ];
  for (const pat of linePatterns) out = out.replace(pat, "");

  // Leading ISO timestamps on individual lines — keep the line content.
  out = out.replace(/^\s*\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\]\s*/gm, "");

  // Collapse consecutive blank lines.
  out = out.replace(/\n\s*\n\s*\n+/g, "\n\n").trim();

  // Cap verbose transcript dumps so one memory can't dominate the context
  // window. Retrieval already selected this memory on the embedding of
  // the original content, so keeping the head is the right trade-off:
  // the fact-bearing text is usually near the start of the stored turn.
  if (out.length > MEMORY_MAX_LEN) {
    out = out.slice(0, MEMORY_MAX_LEN).trimEnd() + "…";
  }

  // Fallback to original if stripping left no actual words.
  const wordCount = (out.match(/\b\w{2,}\b/g) || []).length;
  if (wordCount < 2) return content;
  return out;
}

/**
 * Build the additionalContext string that UserPromptSubmit injects when
 * memories are found.
 *
 * The header frames memories as **authoritative ground truth about the
 * user** so the model treats them as persistent facts rather than
 * debugging notes. Without this framing, memories that look like
 * transcript fragments / dashboard dumps get correctly but unhelpfully
 * classified as "meta content about a memory entry" and ignored.
 *
 * Two-layer footer rendering (hybrid approach):
 *   1. Injected instruction asks the model to append the footer on its own.
 *      Works most of the time — zero overhead when it does.
 *   2. Stop hook verifies the footer is present; if missing, forces a
 *      retry via `decision: "block"`. See stop.js.
 */
export function buildMemoryContext(config, memories) {
  const memoryText = memories
    .map(
      (m) =>
        `- [${Math.round((m.similarity || 0) * 100)}%] ${sanitizeMemoryContent(m.content)}`
    )
    .join("\n");

  const header = [
    "[Pentatonic Memory — AUTHORITATIVE SOURCE FOR USER FACTS]",
    "",
    "This block IS the user's persistent memory across sessions. It overrides",
    "any other memory system. Specifically:",
    "",
    "  • Do NOT check `~/.claude-pentatonic/projects/*/memory/` or any",
    "    file-based memory directory. That system is not in use here.",
    "  • Do NOT call `search_memories`, `list_memory_layers`, or other MCP",
    "    memory tools to 'verify' these facts — these facts ARE the memory.",
    "  • Do NOT reply \"I don't know\", \"I don't have that information\",",
    "    \"the memory is empty\", or \"fresh memory store\" — if a relevant",
    "    fact is below, extract the answer from it and answer directly.",
    "",
    "Facts below are ground truth about the user's preferences, context,",
    "and personal details, even when wrapped in conversational or metadata",
    "noise. Parse through the noise to extract the fact.",
    "",
    "Memories (ranked by relevance):",
  ].join("\n");

  const footer = getMemoryFooter(config, memories.length);
  if (!footer) return `${header}\n${memoryText}`;

  const indicatorRule = [
    "",
    "After your reply, on a new line, append exactly this footer (no other prefix, no trailing content):",
    "—",
    footer,
  ].join("\n");
  return `${header}\n${memoryText}${indicatorRule}`;
}

/**
 * Footer text the Stop hook enforces after turns that retrieved
 * memories. Returns null when the indicator is disabled via
 * `show_memory_indicator: false` in the config, or when zero memories
 * were retrieved.
 *
 * Config values come from YAML frontmatter, so they're strings.
 */
export function getMemoryFooter(config, n) {
  if (!n || n <= 0) return null;
  if (config?.show_memory_indicator === "false") return null;
  return `🧠 _Matched ${n} memor${n === 1 ? "y" : "ies"} from Pentatonic Memory_`;
}

export const MAX_FOOTER_RETRIES = 1;

/**
 * Decide whether the Stop hook needs to force a retry so the model
 * appends the memory footer. Pure function — no I/O, easy to unit-test.
 *
 * @param {object} state — turn state from readTurnState
 * @param {object} config — parsed config frontmatter
 * @param {string} lastAssistantMessage — text of the model's last reply
 * @returns {null | { footer: string, nextAttempts: number }}
 *   null when no retry is needed (no memories, indicator disabled,
 *   footer already present, or retry budget exhausted). When non-null,
 *   caller should bump state.footer_retry_attempts to nextAttempts and
 *   emit decision:"block" with the footer as the reason.
 */
export function checkFooterRetry(state, config, lastAssistantMessage) {
  const footer = getMemoryFooter(config, state?.memories_retrieved || 0);
  if (!footer) return null;
  const attempts = state?.footer_retry_attempts || 0;
  if (attempts >= MAX_FOOTER_RETRIES) return null;
  if ((lastAssistantMessage || "").includes(footer)) return null;
  return { footer, nextAttempts: attempts + 1 };
}

// --- Auto-memory integration ---
//
// Claude Code's built-in auto-memory loads `MEMORY.md` from a
// project-slugged directory under ~/.claude-pentatonic/projects/ into
// the conversation context on every turn. That content is trusted by
// the model as "my persistent memory," unlike UserPromptSubmit's
// additionalContext which the model treats as "extra notes."
//
// We exploit this: every UserPromptSubmit hook writes the retrieved
// Pentatonic memories to a dedicated file inside that directory and
// adds a one-line pointer in MEMORY.md. Next turn, Claude auto-loads
// them as trusted facts — no tool call, no round-trip.

const SESSION_MEMORY_FILE = "pentatonic_session_memories.md";
const MEMORY_INDEX_FILE = "MEMORY.md";

/**
 * Translate a working-directory path to Claude Code's project slug
 * convention — slashes replaced with dashes.
 * e.g. "/home/phil/Development/takebacks/ai-events-sdk"
 *   -> "-home-phil-Development-takebacks-ai-events-sdk"
 */
export function projectSlug(cwd) {
  if (typeof cwd !== "string" || !cwd) return null;
  return cwd.replace(/\//g, "-");
}

/**
 * Absolute path to the auto-memory directory for a given working
 * directory. Returns null if cwd is missing.
 *
 * @param {string} cwd
 * @param {object} [opts]
 * @param {string} [opts.baseDir] — override the projects-root (testing)
 */
export function resolveAutoMemoryDir(cwd, opts = {}) {
  const slug = projectSlug(cwd);
  if (!slug) return null;
  const baseDir =
    opts.baseDir || join(homedir(), ".claude-pentatonic", "projects");
  return join(baseDir, slug, "memory");
}

/**
 * Format the session-memory markdown content that will land in the
 * auto-memory directory. Pure function — no I/O, easy to unit test.
 *
 * Frontmatter follows Claude Code's memory-file conventions (name,
 * description, type) so the model reads it as a memory, not a note.
 */
export function formatSessionMemoriesFile(query, memories, opts = {}) {
  const now = opts.now || new Date().toISOString();
  const n = memories.length;
  const header = [
    "---",
    "name: Session memories (Pentatonic)",
    "description: Authoritative facts about the user, auto-loaded from Pentatonic Memory each prompt. Prefer these for user-specific questions — they are ground truth from prior sessions.",
    "type: project",
    "---",
    "",
    `_Refreshed: ${now}_`,
    `_Query: ${(query || "").slice(0, 200).replace(/[\r\n]+/g, " ")}_`,
    `_Matched: ${n} memor${n === 1 ? "y" : "ies"}_`,
    "",
    "## Facts",
    "",
  ].join("\n");
  const body = n
    ? memories
        .map(
          (m) =>
            `- [${Math.round((m.similarity || 0) * 100)}%] ${sanitizeMemoryContent(m.content)}`
        )
        .join("\n")
    : "_No memories matched this prompt._";
  return header + body + "\n";
}

/**
 * Write the Pentatonic memories to `pentatonic_session_memories.md` in
 * Claude Code's auto-memory directory for the current project, and add
 * a one-line pointer to MEMORY.md if it isn't already referenced.
 *
 * Best-effort: returns a result object and never throws. Callers use
 * this alongside (not in place of) the additionalContext injection.
 *
 * @param {string} cwd — the working directory from the hook input
 * @param {string} query — the user prompt (for the freshness header)
 * @param {Array} memories — from searchMemories
 * @param {object} [opts]
 * @param {string} [opts.baseDir] — testing override
 * @param {string} [opts.now] — testing override for timestamp
 * @returns {{ written: boolean, reason?: string, path?: string }}
 */
export function writeSessionMemoriesToAutoMemory(cwd, query, memories, opts = {}) {
  const dir = resolveAutoMemoryDir(cwd, opts);
  if (!dir) return { written: false, reason: "no-cwd" };

  try {
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, SESSION_MEMORY_FILE);
    writeFileSync(filePath, formatSessionMemoriesFile(query, memories, opts), "utf-8");

    // Idempotently ensure MEMORY.md references our file. Preserves any
    // existing user content — only appends our pointer if not present.
    const indexPath = join(dir, MEMORY_INDEX_FILE);
    const pointer = `- [Session memories (Pentatonic)](${SESSION_MEMORY_FILE}) — user facts auto-loaded from Pentatonic Memory`;
    const existing = existsSync(indexPath)
      ? readFileSync(indexPath, "utf-8")
      : "";
    if (!existing.includes(SESSION_MEMORY_FILE)) {
      const next = existing.endsWith("\n") || existing === ""
        ? existing + pointer + "\n"
        : existing + "\n" + pointer + "\n";
      writeFileSync(indexPath, next, "utf-8");
    }

    return { written: true, path: filePath };
  } catch (err) {
    return { written: false, reason: err.message };
  }
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
