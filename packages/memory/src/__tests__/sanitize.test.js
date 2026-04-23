/**
 * Unit tests for the shared memory-content sanitizer.
 *
 * Same invariants the Claude Code hook tests already cover — we
 * assert them here against the canonical module too so the published
 * openclaw-plugin's inline copy and the hooks/scripts inline copy
 * both have a reference to check against.
 */

import {
  sanitizeMemoryContent,
  MEMORY_MAX_LEN,
} from "../sanitize.js";

describe("sanitizeMemoryContent", () => {
  it("strips leading ISO timestamps on each line", () => {
    const out = sanitizeMemoryContent(
      "[2026-04-21T11:47:04.826Z] Phil owns a Subaru."
    );
    expect(out).toBe("Phil owns a Subaru.");
  });

  it("strips standalone dashboard metadata lines", () => {
    const input = [
      "Phil owns a Subaru.",
      "anonymous",
      "ml_phil-h-claude_episodic",
      "100% match",
      "Confidence: 100%",
      "Accessed: 2x",
      "<1h ago",
      "Decay: 0.05",
      "Metadata",
    ].join("\n");
    expect(sanitizeMemoryContent(input)).toBe("Phil owns a Subaru.");
  });

  it("strips trailing JSON metadata blob", () => {
    const input = [
      "Phil has two dogs named Max and Luna.",
      "{",
      '  "event_id": "abc-123",',
      '  "event_type": "CHAT_TURN"',
      "}",
    ].join("\n");
    expect(sanitizeMemoryContent(input)).toBe(
      "Phil has two dogs named Max and Luna."
    );
  });

  it("strips inline JSON metadata blobs with TES-style fields", () => {
    const input = [
      "User said: I have a Subaru.",
      "{",
      '  "event_id": "abc",',
      '  "event_type": "CHAT_TURN",',
      '  "entity_type": "conversation"',
      "}",
      "The next turn continued...",
    ].join("\n");
    const out = sanitizeMemoryContent(input);
    expect(out).toMatch(/User said: I have a Subaru\./);
    expect(out).toMatch(/The next turn continued\.\.\./);
    expect(out).not.toMatch(/event_id/);
  });

  it("does NOT strip legitimate JSON code samples", () => {
    const input = [
      "Here's how to configure the client:",
      "{",
      '  "apiKey": "xxx",',
      '  "endpoint": "https://api.test"',
      "}",
      "Then instantiate it.",
    ].join("\n");
    const out = sanitizeMemoryContent(input);
    expect(out).toMatch(/apiKey/);
    expect(out).toMatch(/endpoint/);
  });

  it("falls back to original when stripping would leave almost nothing", () => {
    const input = "anonymous\nml_phil-h-claude_episodic\n100% match";
    expect(sanitizeMemoryContent(input)).toBe(input);
  });

  it("is a no-op for clean content", () => {
    const clean = "Phil prefers espresso in the morning, tea in the afternoon.";
    expect(sanitizeMemoryContent(clean)).toBe(clean);
  });

  it("caps verbose content at MEMORY_MAX_LEN with ellipsis", () => {
    const long = "fact. ".repeat(200); // 1200 chars
    const out = sanitizeMemoryContent(long);
    expect(out.length).toBeLessThanOrEqual(MEMORY_MAX_LEN + 1);
    expect(out.endsWith("…")).toBe(true);
  });

  it("handles non-string input safely", () => {
    expect(sanitizeMemoryContent(undefined)).toBeUndefined();
    expect(sanitizeMemoryContent(null)).toBeNull();
    expect(sanitizeMemoryContent(42)).toBe(42);
  });
});
