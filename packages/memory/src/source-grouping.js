/**
 * Source grouping for retrieved memories.
 *
 * Cross-domain memory only matters if the agent (and the human watching)
 * can see *which* surfaces a retrieval came from. A flat list of
 * "5 memories" tells you nothing; "2 from code · 2 from Slack · 1 from
 * a meeting" tells you the agent connected the dots Anthropic / Cursor /
 * Codex couldn't.
 *
 * Source IDs map to the `source` (or `system`) field in TES STORE_MEMORY
 * event attributes — `slack-ingest`, `gmail-ingest`, `calendar-ingest`,
 * `corpus-ingest`. We normalise to short labels (`slack`, `gmail`,
 * `calendar`, `code`, `meeting`) so the rendered output stays terse.
 *
 * Anything we can't classify falls into the `memory` bucket — that
 * preserves backwards compatibility with deployments that don't yet
 * populate `metadata.source` or with memory sources we haven't taught
 * the SDK about. New sources only need a single entry here to surface.
 *
 * Canonical implementation. The Claude Code hook (`hooks/scripts/
 * shared.js`) and the published openclaw-plugin (`openclaw-plugin/
 * index.js`) each inline the same logic — they're published standalone
 * and can't cross-import. Update all three if changing.
 */

/**
 * Canonical source IDs in render order. The order matters — code first
 * because it's the most concrete artefact, then conversational sources,
 * then the catch-all. The "Memory used" footer renders sources in this
 * order regardless of bucket size so the eye picks up structure.
 */
export const SOURCE_ORDER = [
  "code",
  "slack",
  "gmail",
  "calendar",
  "meeting",
  "memory",
];

/**
 * Per-source render metadata used in the assembled prompt and footer.
 * Labels are user-facing (singular form). The `kind` plural is appended
 * automatically when N > 1.
 */
export const SOURCE_META = {
  code: { label: "Code", kind: "snippet", icon: "💻" },
  slack: { label: "Slack", kind: "message", icon: "💬" },
  gmail: { label: "Gmail", kind: "email", icon: "✉️" },
  calendar: { label: "Calendar", kind: "event", icon: "📅" },
  meeting: { label: "Meeting", kind: "note", icon: "🗒️" },
  memory: { label: "Memory", kind: "fact", icon: "🧠" },
};

/**
 * Detect a memory's source from its `metadata` JSONB.
 *
 * Resolution order:
 *  1. Explicit `metadata.source` (or fallback `metadata.system`) string
 *     containing a known token (`slack`, `gmail`, `calendar`, `corpus`,
 *     `repo`, `meeting`, `granola`).
 *  2. Heuristic from per-source metadata keys — `slack_thread_ts`,
 *     `gmail_thread_id`, `calendar_event_id`, `source_repo`, etc.
 *  3. Fallback to the generic `memory` bucket.
 *
 * The heuristic step lets older memories (written before the slack-ingest
 * spec landed `source: "slack-ingest"`) still classify correctly — useful
 * for the migration window after deploy.
 *
 * @param {object|null|undefined} metadata
 * @returns {string} a canonical source ID from SOURCE_ORDER
 */
export function detectSource(metadata) {
  if (!metadata || typeof metadata !== "object") return "memory";

  const explicit = String(metadata.source || metadata.system || "").toLowerCase();
  if (explicit) {
    if (explicit.includes("slack")) return "slack";
    if (explicit.includes("gmail")) return "gmail";
    if (explicit.includes("calendar")) return "calendar";
    if (explicit.includes("corpus") || explicit.includes("repo") || explicit.includes("code")) return "code";
    if (explicit.includes("granola") || explicit.includes("meeting") || explicit.includes("transcript")) return "meeting";
    // Unknown explicit source — preserve a slugged version so future
    // modules surface as their own bucket rather than vanishing into
    // the generic "memory" catch-all. Slug strips the `-ingest`
    // convention and any non-alphanumerics.
    const slug = explicit.replace(/-ingest$/, "").replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    if (slug) return slug;
  }

  if (metadata.slack_thread_ts || metadata.slack_channel_id || metadata.slack_ts) return "slack";
  if (metadata.gmail_thread_id || metadata.gmail_message_id) return "gmail";
  if (metadata.calendar_event_id || metadata.calendar_id) return "calendar";
  if (metadata.source_repo || metadata.source_repo_name || metadata.source_path) return "code";
  if (metadata.meeting_id || metadata.transcript_id || metadata.granola_id) return "meeting";

  // Memory kind is the last-ditch hint — `memory_kind: "email"` fires only
  // if the explicit source check above missed (defensive).
  const kind = String(metadata.memory_kind || "").toLowerCase();
  if (kind.includes("chat") || kind.includes("slack")) return "slack";
  if (kind.includes("email")) return "gmail";
  if (kind.includes("meeting")) return "meeting";
  if (kind.includes("code")) return "code";

  return "memory";
}

/**
 * Group an array of memory hits by detected source.
 *
 * Returns a Map (preserves insertion order, which is SOURCE_ORDER for
 * sources that have hits — empty buckets are omitted entirely so the
 * caller doesn't render headers for empty groups).
 *
 * @param {Array<{metadata?: object}>} memories
 * @returns {Map<string, Array<object>>}
 */
export function groupBySource(memories) {
  const grouped = new Map();
  if (!Array.isArray(memories) || memories.length === 0) return grouped;

  // Bucket first.
  const buckets = new Map();
  for (const m of memories) {
    const src = detectSource(m?.metadata);
    if (!buckets.has(src)) buckets.set(src, []);
    buckets.get(src).push(m);
  }

  // Re-emit in SOURCE_ORDER, then any unknown sources we haven't
  // ranked, sorted alphabetically so the output is deterministic.
  for (const src of SOURCE_ORDER) {
    if (buckets.has(src)) grouped.set(src, buckets.get(src));
  }
  const unknown = [...buckets.keys()].filter((k) => !SOURCE_ORDER.includes(k)).sort();
  for (const src of unknown) grouped.set(src, buckets.get(src));

  return grouped;
}

/**
 * Render a one-line summary of grouped memories — the badge string used
 * in the visibility footer. Omits sources with zero hits and pluralises
 * the unit ("1 message" → "2 messages") per source.
 *
 * @example
 *   formatSourceBadges(groupBySource(hits))
 *   // → "2 code · 3 slack · 1 meeting"
 *
 * @param {Map<string, Array<object>>} grouped
 * @returns {string}
 */
export function formatSourceBadges(grouped) {
  const sources = [...grouped.keys()].filter((src) => grouped.get(src)?.length > 0);
  // When the only bucket is the generic "memory" fallback, return empty
  // — there's no useful breakdown to show, and surfacing "5 memory" in
  // the footer is just noise. Backwards-compatible with deployments
  // that don't yet populate metadata.source.
  if (sources.length === 1 && sources[0] === "memory") return "";
  const parts = [];
  for (const src of sources) {
    parts.push(`${grouped.get(src).length} ${src}`);
  }
  return parts.join(" · ");
}

/**
 * Render the assembled memory text grouped by source — the body of the
 * `[Memory]` / `=== PENTATONIC MEMORY ===` block injected into the
 * system prompt.
 *
 * Ungrouped fallback (single bucket, all `memory`) renders as a flat
 * list to match the pre-source-grouping output exactly. That keeps
 * snapshot tests stable for deployments where TES doesn't yet return
 * `metadata`.
 *
 * @param {Map<string, Array<{content: string, similarity?: number}>>} grouped
 * @param {(content: string) => string} sanitize - the caller's sanitiser
 * @returns {string}
 */
export function renderGroupedMemoryText(grouped, sanitize) {
  const sources = [...grouped.keys()];

  // Backwards-compatible flat render when only the generic bucket has
  // hits — preserves the exact pre-grouping output shape.
  if (sources.length === 1 && sources[0] === "memory") {
    return grouped.get("memory")
      .map((m) => `- [${pct(m.similarity)}%] ${sanitize(m.content)}`)
      .join("\n");
  }

  const blocks = [];
  for (const src of sources) {
    const hits = grouped.get(src);
    if (!hits.length) continue;
    const meta = SOURCE_META[src] || { label: src, icon: "" };
    const head = meta.icon
      ? `${meta.icon} ${meta.label} (${hits.length})`
      : `${meta.label} (${hits.length})`;
    blocks.push(head);
    for (const m of hits) {
      blocks.push(`- [${pct(m.similarity)}%] ${sanitize(m.content)}`);
    }
    blocks.push(""); // blank line between groups
  }
  // Drop the trailing blank line so the caller controls outer spacing.
  while (blocks.length && blocks[blocks.length - 1] === "") blocks.pop();
  return blocks.join("\n");
}

function pct(similarity) {
  return Math.round((Number(similarity) || 0) * 100);
}
