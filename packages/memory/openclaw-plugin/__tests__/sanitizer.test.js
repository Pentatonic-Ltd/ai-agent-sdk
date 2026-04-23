/**
 * OpenClaw plugin — memory-content sanitization tests.
 *
 * Verifies the sanitizer is actually applied at the two format
 * surfaces: the context-engine `assemble` output and the
 * `pentatonic_memory_search` tool result.
 */

import plugin from "../index.js";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockSearchReturns(results) {
  globalThis.fetch = async (_url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    const query = body?.query || "";
    if (query.includes("semanticSearchMemories")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { semanticSearchMemories: results } }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: {} }),
    };
  };
}

function makeEngine(extraConfig = {}) {
  let factory;
  plugin.register({
    pluginConfig: {
      tes_endpoint: "https://x.test",
      tes_client_id: "c",
      tes_api_key: "tes_c_xyz",
      ...extraConfig,
    },
    registerTool: () => {},
    registerContextEngine: (_name, fn) => {
      factory = fn;
    },
  });
  if (!factory) throw new Error("no engine registered");
  return factory();
}

describe("openclaw-plugin — assemble applies memory sanitizer", () => {
  it("strips TES dashboard noise before injecting into systemPromptAddition", async () => {
    const noisy = [
      "[2026-04-21T11:47:04.826Z] I have a subaru and hyundai.",
      "anonymous",
      "ml_phil-h-claude_episodic",
      "100% match",
      "Confidence: 100%",
      "Accessed: 2x",
      "<1h ago",
      "Decay: 0.05",
    ].join("\n");
    mockSearchReturns([{ id: "m1", content: noisy, similarity: 0.9 }]);
    const engine = makeEngine();

    const result = await engine.assemble({
      sessionId: "s",
      messages: [{ role: "user", content: "what car do I drive?" }],
    });

    const addition = result.systemPromptAddition || "";
    expect(addition).toMatch(/I have a subaru and hyundai/);
    expect(addition).not.toMatch(/ml_phil-h-claude_episodic/);
    expect(addition).not.toMatch(/Confidence:/);
    expect(addition).not.toMatch(/Accessed: 2x/);
    expect(addition).not.toMatch(/Decay:/);
    expect(addition).not.toMatch(/\[2026-04-21T/);
  });

  it("strips trailing JSON metadata blobs", async () => {
    const content = [
      "User said: I drive a Subaru.",
      "{",
      '  "event_id": "abc",',
      '  "event_type": "CHAT_TURN"',
      "}",
    ].join("\n");
    mockSearchReturns([{ id: "m1", content, similarity: 0.9 }]);
    const engine = makeEngine();

    const result = await engine.assemble({
      sessionId: "s",
      messages: [{ role: "user", content: "q" }],
    });

    expect(result.systemPromptAddition).toMatch(/User said: I drive a Subaru\./);
    expect(result.systemPromptAddition).not.toMatch(/event_id/);
    expect(result.systemPromptAddition).not.toMatch(/entity_type/);
  });

  it("caps verbose memories so a single transcript dump can't dominate", async () => {
    // 2400-char "memory" — well over the 600-char cap
    const long = "Phil owns a Subaru. ".repeat(120);
    mockSearchReturns([{ id: "m1", content: long, similarity: 0.9 }]);
    const engine = makeEngine();

    const result = await engine.assemble({
      sessionId: "s",
      messages: [{ role: "user", content: "q" }],
    });

    const addition = result.systemPromptAddition || "";
    // Full content would be ~2400 chars; capped version ~600 + …
    expect(addition).toMatch(/Phil owns a Subaru\./);
    expect(addition).toMatch(/…/);
  });

  it("keeps clean content unchanged", async () => {
    mockSearchReturns([
      { id: "m1", content: "Phil drinks cortado.", similarity: 0.9 },
    ]);
    const engine = makeEngine();

    const result = await engine.assemble({
      sessionId: "s",
      messages: [{ role: "user", content: "q" }],
    });

    expect(result.systemPromptAddition).toMatch(/Phil drinks cortado\./);
    expect(result.systemPromptAddition).not.toMatch(/…/); // no truncation
  });
});
