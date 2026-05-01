/**
 * Source grouping tests.
 *
 * Pinned behaviours:
 *  - Explicit metadata.source wins over heuristics.
 *  - Heuristic fallback works for older memories that pre-date the
 *    `metadata.source` field — protects the migration window.
 *  - Backwards-compatible flat render when no metadata is present (so
 *    older deployments don't regress).
 *  - Group ordering matches SOURCE_ORDER regardless of insertion order.
 */

import {
  detectSource,
  groupBySource,
  formatSourceBadges,
  renderGroupedMemoryText,
  SOURCE_ORDER,
  SOURCE_META,
} from "../source-grouping.js";

const identity = (s) => s;

describe("detectSource", () => {
  it("falls back to 'memory' when metadata is missing", () => {
    expect(detectSource(undefined)).toBe("memory");
    expect(detectSource(null)).toBe("memory");
    expect(detectSource({})).toBe("memory");
  });

  it("uses explicit source field — slack-ingest emits source: 'slack-ingest'", () => {
    expect(detectSource({ source: "slack-ingest" })).toBe("slack");
    expect(detectSource({ source: "gmail-ingest" })).toBe("gmail");
    expect(detectSource({ source: "calendar-ingest" })).toBe("calendar");
    expect(detectSource({ source: "corpus-ingest" })).toBe("code");
  });

  it("falls back to system field when source is missing", () => {
    expect(detectSource({ system: "slack-ingest" })).toBe("slack");
  });

  it("classifies code from repo metadata when source is missing", () => {
    // Older corpus-ingest payloads pre-date the `source` field — make sure
    // the heuristic still classifies them as code.
    expect(detectSource({ source_repo: "/Users/x/cursor/Pip" })).toBe("code");
    expect(detectSource({ source_path: "src/index.ts" })).toBe("code");
    expect(detectSource({ source_repo_name: "Pip" })).toBe("code");
  });

  it("classifies slack from slack_* metadata when source is missing", () => {
    expect(detectSource({ slack_thread_ts: "1234.5678" })).toBe("slack");
    expect(detectSource({ slack_channel_id: "C0123" })).toBe("slack");
  });

  it("classifies gmail from gmail_* metadata when source is missing", () => {
    expect(detectSource({ gmail_thread_id: "abc123" })).toBe("gmail");
    expect(detectSource({ gmail_message_id: "m1" })).toBe("gmail");
  });

  it("classifies calendar from calendar_* metadata when source is missing", () => {
    expect(detectSource({ calendar_event_id: "evt-1" })).toBe("calendar");
  });

  it("classifies meeting from granola/meeting metadata", () => {
    expect(detectSource({ source: "granola" })).toBe("meeting");
    expect(detectSource({ meeting_id: "m1" })).toBe("meeting");
    expect(detectSource({ granola_id: "g1" })).toBe("meeting");
  });

  it("uses memory_kind as a last-resort hint", () => {
    expect(detectSource({ memory_kind: "email" })).toBe("gmail");
    expect(detectSource({ memory_kind: "chat" })).toBe("slack");
    expect(detectSource({ memory_kind: "meeting_note" })).toBe("meeting");
  });

  it("returns 'memory' for entirely unknown metadata", () => {
    expect(detectSource({ foo: "bar", baz: 42 })).toBe("memory");
  });
});

describe("groupBySource", () => {
  it("returns an empty Map for empty/invalid input", () => {
    expect(groupBySource([])).toEqual(new Map());
    expect(groupBySource(null)).toEqual(new Map());
    expect(groupBySource(undefined)).toEqual(new Map());
  });

  it("groups memories by detected source", () => {
    const hits = [
      { content: "code A", metadata: { source: "corpus-ingest" } },
      { content: "slack A", metadata: { source: "slack-ingest" } },
      { content: "code B", metadata: { source_repo: "/x" } },
      { content: "slack B", metadata: { slack_thread_ts: "1" } },
      { content: "gmail A", metadata: { source: "gmail-ingest" } },
    ];
    const grouped = groupBySource(hits);
    expect([...grouped.keys()]).toEqual(["code", "slack", "gmail"]);
    expect(grouped.get("code")).toHaveLength(2);
    expect(grouped.get("slack")).toHaveLength(2);
    expect(grouped.get("gmail")).toHaveLength(1);
  });

  it("emits sources in SOURCE_ORDER regardless of input order", () => {
    // Inputs in reverse order — output must still be code, slack, gmail.
    const hits = [
      { content: "gmail", metadata: { source: "gmail-ingest" } },
      { content: "slack", metadata: { source: "slack-ingest" } },
      { content: "code", metadata: { source: "corpus-ingest" } },
    ];
    const grouped = groupBySource(hits);
    expect([...grouped.keys()]).toEqual(["code", "slack", "gmail"]);
  });

  it("places unknown sources after the canonical order, alphabetically", () => {
    const hits = [
      { content: "x", metadata: { source: "zzz-future-source" } },
      { content: "y", metadata: { source: "aaa-future-source" } },
      { content: "code", metadata: { source: "corpus-ingest" } },
    ];
    const grouped = groupBySource(hits);
    const keys = [...grouped.keys()];
    // code first (canonical), then unknowns sorted alphabetically.
    expect(keys[0]).toBe("code");
    expect(keys[1]).toBe("aaa-future-source");
    expect(keys[2]).toBe("zzz-future-source");
  });

  it("buckets all-untyped hits into the generic 'memory' bucket", () => {
    const hits = [{ content: "x" }, { content: "y", metadata: {} }];
    const grouped = groupBySource(hits);
    expect([...grouped.keys()]).toEqual(["memory"]);
    expect(grouped.get("memory")).toHaveLength(2);
  });
});

describe("formatSourceBadges", () => {
  it("renders zero groups as empty string", () => {
    expect(formatSourceBadges(new Map())).toBe("");
  });

  it("renders one group", () => {
    const m = new Map([["slack", [{}, {}]]]);
    expect(formatSourceBadges(m)).toBe("2 slack");
  });

  it("joins multiple groups with middle-dot", () => {
    const m = new Map([
      ["code", [{}, {}]],
      ["slack", [{}, {}, {}]],
      ["meeting", [{}]],
    ]);
    expect(formatSourceBadges(m)).toBe("2 code · 3 slack · 1 meeting");
  });

  it("returns empty when the only bucket is the generic memory fallback (backwards compat)", () => {
    // Three untyped memories all bucket into "memory" — surfacing
    // "3 memory" in the footer would be noise for deployments that
    // don't yet populate metadata.source.
    const m = new Map([["memory", [{}, {}, {}]]]);
    expect(formatSourceBadges(m)).toBe("");
  });

  it("does render badges when memory bucket coexists with typed sources", () => {
    const m = new Map([
      ["code", [{}]],
      ["memory", [{}, {}]],
    ]);
    expect(formatSourceBadges(m)).toBe("1 code · 2 memory");
  });

  it("skips empty groups", () => {
    const m = new Map([
      ["code", [{}]],
      ["slack", []],
      ["gmail", [{}, {}]],
    ]);
    expect(formatSourceBadges(m)).toBe("1 code · 2 gmail");
  });
});

describe("renderGroupedMemoryText", () => {
  it("renders a flat list (no headers) for the all-generic case — backwards-compatible", () => {
    const hits = [
      { content: "fact one", similarity: 0.9 },
      { content: "fact two", similarity: 0.7 },
    ];
    const grouped = groupBySource(hits);
    const out = renderGroupedMemoryText(grouped, identity);
    // Pre-source-grouping shape preserved exactly.
    expect(out).toBe("- [90%] fact one\n- [70%] fact two");
    expect(out).not.toContain("Memory (2)");
  });

  it("renders source headers when multiple sources are present", () => {
    const hits = [
      { content: "code A", similarity: 0.9, metadata: { source: "corpus-ingest" } },
      { content: "slack A", similarity: 0.8, metadata: { source: "slack-ingest" } },
    ];
    const grouped = groupBySource(hits);
    const out = renderGroupedMemoryText(grouped, identity);
    expect(out).toContain("Code (1)");
    expect(out).toContain("Slack (1)");
    expect(out).toContain("- [90%] code A");
    expect(out).toContain("- [80%] slack A");
    // Code must render before Slack per SOURCE_ORDER.
    expect(out.indexOf("Code")).toBeLessThan(out.indexOf("Slack"));
  });

  it("applies sanitiser to content", () => {
    const hits = [
      { content: "secret 555-1234", similarity: 0.5, metadata: { source: "slack-ingest" } },
    ];
    const grouped = groupBySource(hits);
    const out = renderGroupedMemoryText(grouped, (s) => s.replace(/555-\d+/, "[REDACTED]"));
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain("555-1234");
  });

  it("rounds similarity to integer percent", () => {
    const hits = [
      { content: "x", similarity: 0.876, metadata: { source: "corpus-ingest" } },
    ];
    const out = renderGroupedMemoryText(groupBySource(hits), identity);
    expect(out).toContain("88%");
  });

  it("falls back to 0% when similarity is missing", () => {
    const hits = [{ content: "x", metadata: { source: "corpus-ingest" } }];
    const out = renderGroupedMemoryText(groupBySource(hits), identity);
    expect(out).toContain("0%");
  });
});

describe("SOURCE_ORDER and SOURCE_META", () => {
  it("every canonical source has rendering metadata", () => {
    for (const src of SOURCE_ORDER) {
      expect(SOURCE_META[src]).toBeDefined();
      expect(SOURCE_META[src].label).toBeTruthy();
    }
  });
});
