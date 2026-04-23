/**
 * Memory-used indicator tests.
 *
 * When the assemble hook injects memories into the system prompt, the
 * plugin appends an instruction telling the LLM to add a visible footer
 * to its reply so the end user sees when Pentatonic Memory was used.
 *
 * Opt out with show_memory_indicator: false in plugin config.
 */

import plugin from "../index.js";

const realFetch = globalThis.fetch;

function mockFetch(searchResults) {
  globalThis.fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    const query = body?.query || "";
    // Return search results for hosted search; empty for anything else.
    if (query.includes("semanticSearchMemories")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: { semanticSearchMemories: searchResults },
        }),
      };
    }
    if (url.endsWith("/search")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ results: searchResults }),
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
  if (!factory) throw new Error("plugin did not register a context engine");
  return factory();
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("memory-used indicator — hosted mode", () => {
  it("injects a footer instruction into systemPromptAddition when memories are found", async () => {
    mockFetch([
      { id: "m1", content: "Phil likes cheese", similarity: 0.9 },
      { id: "m2", content: "Phil drinks cortado", similarity: 0.8 },
    ]);
    const engine = makeEngine();

    const result = await engine.assemble({
      sessionId: "s",
      messages: [{ role: "user", content: "what do I like?" }],
    });

    expect(result.systemPromptAddition).toMatch(/🧠/);
    expect(result.systemPromptAddition).toMatch(/Matched 2 memories from Pentatonic Memory/);
    expect(result.systemPromptAddition).toMatch(/append exactly this footer/);
  });

  it("pluralises correctly for a single memory", async () => {
    mockFetch([{ id: "m1", content: "only one", similarity: 0.9 }]);
    const engine = makeEngine();

    const result = await engine.assemble({
      sessionId: "s",
      messages: [{ role: "user", content: "query" }],
    });

    expect(result.systemPromptAddition).toMatch(/Matched 1 memory from Pentatonic Memory/);
    expect(result.systemPromptAddition).not.toMatch(/Matched 1 memories/);
  });

  it("omits the indicator instruction when show_memory_indicator is false", async () => {
    mockFetch([{ id: "m1", content: "fact", similarity: 0.9 }]);
    const engine = makeEngine({ show_memory_indicator: false });

    const result = await engine.assemble({
      sessionId: "s",
      messages: [{ role: "user", content: "query" }],
    });

    expect(result.systemPromptAddition).toBeDefined();
    expect(result.systemPromptAddition).not.toMatch(/🧠/);
    expect(result.systemPromptAddition).not.toMatch(/Pentatonic Memory_/);
    // Still contains the memory content itself
    expect(result.systemPromptAddition).toMatch(/fact/);
  });

  it("does not inject anything when no memories are found", async () => {
    mockFetch([]);
    const engine = makeEngine();

    const result = await engine.assemble({
      sessionId: "s",
      messages: [{ role: "user", content: "query" }],
    });

    // No memories → no systemPromptAddition at all (so nothing to indicate)
    expect(result.systemPromptAddition).toBeUndefined();
  });

  it("always instructs the LLM to append the footer when memories were retrieved", async () => {
    // Removed the "omit if irrelevant" escape hatch so users always get
    // a visible signal when memory was consulted — even when retrieval
    // was poor. Surfaces retrieval quality instead of hiding it.
    mockFetch([{ id: "m1", content: "Phil likes cheese", similarity: 0.4 }]);
    const engine = makeEngine();

    const result = await engine.assemble({
      sessionId: "s",
      messages: [{ role: "user", content: "query" }],
    });

    expect(result.systemPromptAddition).not.toMatch(/omit the footer/);
    expect(result.systemPromptAddition).toMatch(/append exactly this footer/);
  });
});
