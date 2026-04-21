/**
 * Query expansion fallback tests.
 *
 * When the raw user prompt returns no memories, the plugin retries once
 * with a keyword-distilled form. This recovers matches for verbose
 * natural-language prompts that fall below the semantic threshold.
 */

import plugin, { extractSearchKeywords } from "../index.js";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

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

describe("extractSearchKeywords", () => {
  it("strips stopwords from verbose prompts", () => {
    const out = extractSearchKeywords(
      "when I was working in the thing-event-system, I copied migrations, what were they?"
    );
    expect(out).toMatch(/thing-event-system/);
    expect(out).toMatch(/migrations/);
    expect(out).not.toMatch(/\bwhen\b/);
    expect(out).not.toMatch(/\bwhat\b/);
  });

  it("preserves hyphenated compounds", () => {
    expect(extractSearchKeywords("where is thing-event-system?")).toMatch(
      /thing-event-system/
    );
  });

  it("returns null when the distilled form equals the input", () => {
    expect(extractSearchKeywords("deep-memory migrations")).toBeNull();
  });

  it("returns null when the prompt is only stopwords", () => {
    expect(extractSearchKeywords("what were they?")).toBeNull();
  });

  it("returns null for non-string input", () => {
    expect(extractSearchKeywords(null)).toBeNull();
    expect(extractSearchKeywords(undefined)).toBeNull();
  });
});

describe("assemble — keyword retry fallback (hosted mode)", () => {
  it("retries with distilled keywords when raw prompt misses", async () => {
    const queries = [];
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      const q = body.variables.query;
      queries.push(q);
      const isFirst = queries.length === 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            semanticSearchMemories: isFirst
              ? []
              : [{ id: "m1", content: "matched on retry", similarity: 0.7 }],
          },
        }),
      };
    };

    const engine = makeEngine();
    const result = await engine.assemble({
      sessionId: "s",
      messages: [
        {
          role: "user",
          content:
            "when I was working in the thing-event-system, what were those migration changes again?",
        },
      ],
    });

    expect(queries).toHaveLength(2);
    expect(queries[0]).toMatch(/when I was working/);
    expect(queries[1]).not.toMatch(/\bwhen\b/);
    expect(queries[1]).toMatch(/thing-event-system/);
    expect(queries[1]).toMatch(/migration/);
    expect(result.systemPromptAddition).toMatch(/matched on retry/);
  });

  it("does not retry when the raw prompt already returns results", async () => {
    const queries = [];
    globalThis.fetch = async (_url, init) => {
      queries.push(JSON.parse(init.body).variables.query);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            semanticSearchMemories: [
              { id: "m1", content: "hit", similarity: 0.9 },
            ],
          },
        }),
      };
    };

    const engine = makeEngine();
    await engine.assemble({
      sessionId: "s",
      messages: [{ role: "user", content: "thing-event-system migrations" }],
    });

    expect(queries).toHaveLength(1);
  });

  it("does not retry when distilled query equals the raw query", async () => {
    const queries = [];
    globalThis.fetch = async (_url, init) => {
      queries.push(JSON.parse(init.body).variables.query);
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { semanticSearchMemories: [] } }),
      };
    };

    const engine = makeEngine();
    await engine.assemble({
      sessionId: "s",
      messages: [{ role: "user", content: "deep-memory migrations" }],
    });

    expect(queries).toHaveLength(1);
  });
});

describe("assemble — keyword retry fallback (local mode)", () => {
  it("retries via /search endpoint when raw query returns nothing", async () => {
    const queries = [];
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      queries.push(body.query);
      const isFirst = queries.length === 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: isFirst
            ? []
            : [{ id: "m1", content: "local hit", similarity: 0.6 }],
        }),
      };
    };

    let factory;
    plugin.register({
      pluginConfig: {}, // no tes_* creds → local mode
      registerTool: () => {},
      registerContextEngine: (_name, fn) => {
        factory = fn;
      },
    });
    const engine = factory();

    const result = await engine.assemble({
      sessionId: "s",
      messages: [
        { role: "user", content: "what were the migration changes again?" },
      ],
    });

    expect(queries).toHaveLength(2);
    expect(queries[1]).toMatch(/migration/);
    expect(result.systemPromptAddition).toMatch(/local hit/);
  });
});
