/**
 * Memory-content sanitizer.
 *
 * Stored memories from TES often contain dashboard-UI noise (leading
 * timestamps, layer IDs, confidence/decay metadata, trailing JSON
 * blobs). This strips them before showing content to the model — the
 * fact-bearing text is what matters, the metadata just dilutes the
 * signal and burns context budget.
 *
 * Conservative: if stripping would leave no real words, fall back to
 * the original content. Better a noisy signal than none.
 *
 * Canonical implementation. The Claude Code hook (`hooks/scripts/
 * shared.js`) and the published openclaw-plugin (`openclaw-plugin/
 * index.js`) each inline the same logic — they're published
 * standalone and can't cross-import. Update all three if changing.
 */

const TES_META_FIELDS =
  "event_id|event_type|entity_type|source|clientId|correlationId|timestamp|session_id|layer_id|confidence|decay_rate|user_id";

export const MEMORY_MAX_LEN = 600;

export function sanitizeMemoryContent(content) {
  if (typeof content !== "string") return content;
  let out = content;
  // Trailing JSON metadata blob (no `m` flag — `$` = end-of-string).
  out = out.replace(/\n\{\s*\n[\s\S]*?\n\s*\}\s*$/, "");
  // Inline JSON metadata blobs (2+ consecutive TES metadata fields).
  out = out.replace(
    new RegExp(
      `\\{\\s*\\n(\\s*"(?:${TES_META_FIELDS})"[^\\n]*\\n){2,}\\s*\\}`,
      "g"
    ),
    ""
  );
  // Dashboard-UI standalone lines.
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
  // Leading ISO timestamps — strip prefix, keep line content.
  out = out.replace(/^\s*\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\]\s*/gm, "");
  // Collapse consecutive blank lines.
  out = out.replace(/\n\s*\n\s*\n+/g, "\n\n").trim();
  // Cap verbose transcript dumps.
  if (out.length > MEMORY_MAX_LEN) {
    out = out.slice(0, MEMORY_MAX_LEN).trimEnd() + "…";
  }
  // Fallback to original if we stripped everything meaningful.
  const wordCount = (out.match(/\b\w{2,}\b/g) || []).length;
  if (wordCount < 2) return content;
  return out;
}
