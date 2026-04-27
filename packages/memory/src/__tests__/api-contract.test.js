/**
 * API Contract Tests
 *
 * These tests verify that the public API surface of the memory system
 * remains stable. TES (Thing Event System) depends on this exact interface.
 *
 * DO NOT modify these tests to make them pass after changing the API.
 * If a test fails, the API contract has been broken and TES will break.
 * Instead, add new methods/options while keeping the existing ones working.
 *
 * See CONTRIBUTORS.md for details on what must remain stable.
 */

import { createMemorySystem, createAIClient } from "../index.js";
import {
  search,
  textSearch,
} from "../search.js";
import { ingest, generateHypotheticalQueries } from "../ingest.js";
import { decay } from "../decay.js";
import { consolidate } from "../consolidate.js";
import { ensureLayers, getLayers } from "../layers.js";
import { migrate } from "../migrate.js";

// --- Factory ---

describe("createMemorySystem", () => {
  it("is a function", () => {
    expect(typeof createMemorySystem).toBe("function");
  });

  it("accepts a query function as db", () => {
    const memory = createMemorySystem({
      db: async () => ({ rows: [] }),
      embedding: { url: "http://localhost:11434/v1", model: "test" },
      llm: { url: "http://localhost:11434/v1", model: "test" },
    });
    expect(memory).toBeDefined();
  });

  it("accepts a pg.Pool-like object as db", () => {
    const mockPool = { query: async () => ({ rows: [] }) };
    const memory = createMemorySystem({
      db: mockPool,
      embedding: { url: "http://localhost:11434/v1", model: "test" },
      llm: { url: "http://localhost:11434/v1", model: "test" },
    });
    expect(memory).toBeDefined();
  });

  it("accepts an optional schema parameter", () => {
    const mockPool = { query: async () => ({ rows: [] }) };
    const memory = createMemorySystem({
      db: mockPool,
      schema: "module_deep_memory_test",
      embedding: { url: "http://localhost:11434/v1", model: "test" },
      llm: { url: "http://localhost:11434/v1", model: "test" },
    });
    expect(memory).toBeDefined();
  });

  it("accepts an optional logger", () => {
    const memory = createMemorySystem({
      db: async () => ({ rows: [] }),
      embedding: { url: "http://localhost:11434/v1", model: "test" },
      llm: { url: "http://localhost:11434/v1", model: "test" },
      logger: () => {},
    });
    expect(memory).toBeDefined();
  });

  it("throws on invalid db", () => {
    expect(() =>
      createMemorySystem({
        db: "not-a-pool",
        embedding: { url: "http://localhost:11434/v1", model: "test" },
        llm: { url: "http://localhost:11434/v1", model: "test" },
      })
    ).toThrow();
  });
});

// --- Returned API surface ---

describe("memory system API", () => {
  let memory;

  beforeAll(() => {
    memory = createMemorySystem({
      db: async () => ({ rows: [] }),
      embedding: { url: "http://localhost:11434/v1", model: "test" },
      llm: { url: "http://localhost:11434/v1", model: "test" },
    });
  });

  it("exposes migrate()", () => {
    expect(typeof memory.migrate).toBe("function");
  });

  it("exposes ensureLayers(clientId, layerNames?)", () => {
    expect(typeof memory.ensureLayers).toBe("function");
  });

  it("exposes getLayers(clientId)", () => {
    expect(typeof memory.getLayers).toBe("function");
  });

  it("exposes ingest(content, opts)", () => {
    expect(typeof memory.ingest).toBe("function");
  });

  it("exposes search(query, opts)", () => {
    expect(typeof memory.search).toBe("function");
  });

  it("exposes textSearch(query, opts)", () => {
    expect(typeof memory.textSearch).toBe("function");
  });

  it("exposes decay(clientId, opts?)", () => {
    expect(typeof memory.decay).toBe("function");
  });

  it("exposes consolidate(clientId, opts?)", () => {
    expect(typeof memory.consolidate).toBe("function");
  });
});

// --- Named exports ---

describe("named exports", () => {
  it("exports createMemorySystem from index", () => {
    expect(typeof createMemorySystem).toBe("function");
  });

  it("exports createAIClient from index", () => {
    expect(typeof createAIClient).toBe("function");
  });

  it("exports search and textSearch from search.js", () => {
    expect(typeof search).toBe("function");
    expect(typeof textSearch).toBe("function");
  });

  it("exports ingest and generateHypotheticalQueries from ingest.js", () => {
    expect(typeof ingest).toBe("function");
    expect(typeof generateHypotheticalQueries).toBe("function");
  });

  it("exports decay from decay.js", () => {
    expect(typeof decay).toBe("function");
  });

  it("exports consolidate from consolidate.js", () => {
    expect(typeof consolidate).toBe("function");
  });

  it("exports ensureLayers and getLayers from layers.js", () => {
    expect(typeof ensureLayers).toBe("function");
    expect(typeof getLayers).toBe("function");
  });

  it("exports migrate from migrate.js", () => {
    expect(typeof migrate).toBe("function");
  });
});

// --- AI client ---

describe("createAIClient", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("returns an object with embed() and chat()", () => {
    const client = createAIClient({
      url: "http://localhost:11434/v1",
      model: "test",
    });
    expect(typeof client.embed).toBe("function");
    expect(typeof client.chat).toBe("function");
  });

  it("accepts optional apiKey", () => {
    const client = createAIClient({
      url: "http://localhost:11434/v1",
      model: "test",
      apiKey: "sk-test",
    });
    expect(client).toBeDefined();
  });

  it("hits /embeddings by default (OpenAI spec)", async () => {
    let hitUrl;
    globalThis.fetch = async (url) => {
      hitUrl = url;
      return { ok: true, json: async () => ({ data: [{ embedding: [0.1, 0.2] }] }) };
    };
    const client = createAIClient({
      url: "http://localhost:11434/v1",
      model: "test",
    });
    await client.embed("hello");
    expect(hitUrl).toBe("http://localhost:11434/v1/embeddings");
  });

  it("uses embeddingPath override (e.g. Pentatonic AI Gateway)", async () => {
    let hitUrl;
    globalThis.fetch = async (url) => {
      hitUrl = url;
      return { ok: true, json: async () => ({ data: [{ embedding: [0.1] }] }) };
    };
    const client = createAIClient({
      url: "https://lambda-gateway.pentatonic.com/v1",
      model: "NV-Embed-v2",
      embeddingPath: "embed",
    });
    await client.embed("hello");
    expect(hitUrl).toBe("https://lambda-gateway.pentatonic.com/v1/embed");
  });

  it("normalises leading slashes and trailing base-url slashes", async () => {
    let hitUrl;
    globalThis.fetch = async (url) => {
      hitUrl = url;
      return { ok: true, json: async () => ({ data: [{ embedding: [0.1] }] }) };
    };
    const client = createAIClient({
      url: "https://gateway.test/v1/",
      model: "m",
      embeddingPath: "/embed",
    });
    await client.embed("hi");
    expect(hitUrl).toBe("https://gateway.test/v1/embed");
  });

  it("chatPath override applies to chat() too", async () => {
    let hitUrl;
    globalThis.fetch = async (url) => {
      hitUrl = url;
      return { ok: true, json: async () => ({ choices: [{ message: { content: "hi" } }] }) };
    };
    const client = createAIClient({
      url: "https://gateway.test/v1",
      model: "m",
      chatPath: "chat",
    });
    await client.chat([{ role: "user", content: "q" }]);
    expect(hitUrl).toBe("https://gateway.test/v1/chat");
  });

  it("chat defaults to /chat/completions", async () => {
    let hitUrl;
    globalThis.fetch = async (url) => {
      hitUrl = url;
      return { ok: true, json: async () => ({ choices: [{ message: { content: "hi" } }] }) };
    };
    const client = createAIClient({
      url: "http://localhost:11434/v1",
      model: "m",
    });
    await client.chat([{ role: "user", content: "q" }]);
    expect(hitUrl).toBe("http://localhost:11434/v1/chat/completions");
  });

  it("embedBatch sends all inputs in one HTTP call", async () => {
    let callCount = 0;
    let lastBody;
    globalThis.fetch = async (_url, opts) => {
      callCount++;
      lastBody = JSON.parse(opts.body);
      return {
        ok: true,
        json: async () => ({
          data: lastBody.input.map((_, i) => ({
            embedding: [0.1, 0.2, 0.3],
            index: i,
          })),
        }),
      };
    };
    const client = createAIClient({
      url: "http://localhost:11434/v1",
      model: "m",
    });
    const out = await client.embedBatch(["a", "b", "c"], "passage");
    expect(callCount).toBe(1);
    expect(lastBody.input).toEqual(["a", "b", "c"]);
    expect(out.length).toBe(3);
    expect(out.every((r) => r.embedding.length === 3)).toBe(true);
  });

  it("embedBatch returns nulls on non-2xx without throwing", async () => {
    globalThis.fetch = async () => ({ ok: false, json: async () => ({}) });
    const client = createAIClient({
      url: "http://localhost:11434/v1",
      model: "m",
    });
    const out = await client.embedBatch(["a", "b"]);
    expect(out).toEqual([null, null]);
  });

  it("embedBatch parses Ollama/Pentatonic-style {embeddings: [[...]]} response", async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        embeddings: [
          [0.1, 0.2],
          [0.3, 0.4],
        ],
      }),
    });
    const client = createAIClient({
      url: "http://localhost:11434/v1",
      model: "m",
    });
    const out = await client.embedBatch(["x", "y"]);
    expect(out[0].embedding).toEqual([0.1, 0.2]);
    expect(out[1].embedding).toEqual([0.3, 0.4]);
  });
});

// --- Search options contract ---

describe("search options contract", () => {
  it("search accepts clientId, limit, minScore, userId, weights", async () => {
    const mockDb = async () => ({ rows: [] });
    const mockAi = { embed: async () => null };

    // Should not throw — these are the options TES passes
    const results = await search(mockDb, mockAi, "test query", {
      clientId: "test-client",
      limit: 20,
      minScore: 0.5,
      userId: "user-123",
      weights: { relevance: 0.6, recency: 0.25, frequency: 0.15 },
    });

    expect(Array.isArray(results)).toBe(true);
  });

  it("SQL includes atomBoost and verbosityPenalty terms", async () => {
    const seenSqls = [];
    const mockDb = async (sql) => {
      seenSqls.push(sql);
      if (sql.includes("information_schema.columns")) return { rows: [{ "?column?": 1 }] };
      return { rows: [] };
    };
    const mockAi = { embed: async () => ({ embedding: [0.1], dimensions: 1, model: "t" }) };

    await search(mockDb, mockAi, "q", { clientId: "c" });

    const scoringSql = seenSqls.find((s) => s.includes("final_score"));
    expect(scoringSql).toBeDefined();
    expect(scoringSql).toMatch(/source_id IS NOT NULL/);
    expect(scoringSql).toMatch(/length\(mn\.content\)/);
  });

  it("dedupeBySource drops raw rows whose id is a source of a matched atom", async () => {
    const rows = [
      { id: "raw-1", client_id: "c", layer_id: "l", content: "long raw turn",
        confidence: 1, decay_rate: 0.05, access_count: 0, final_score: 0.9, source_id: null },
      { id: "atom-1", client_id: "c", layer_id: "l", content: "Phil owns a Subaru",
        confidence: 1, decay_rate: 0.05, access_count: 0, final_score: 0.8, source_id: "raw-1" },
    ];
    let searchCallCount = 0;
    const mockDb = async (sql) => {
      if (sql.includes("information_schema.columns")) return { rows: [{ "?column?": 1 }] };
      if (sql.includes("final_score")) {
        searchCallCount++;
        return { rows };
      }
      return { rows: [] };
    };
    const mockAi = { embed: async () => ({ embedding: [0.1], dimensions: 1, model: "t" }) };

    const out = await search(mockDb, mockAi, "q", { clientId: "c", minScore: 0 });

    expect(searchCallCount).toBe(1);
    expect(out.length).toBe(1);
    expect(out[0].id).toBe("atom-1");
    expect(out[0].source_id).toBe("raw-1");
  });

  it("dedupeBySource: false keeps both atom and its raw source", async () => {
    const rows = [
      { id: "raw-1", client_id: "c", layer_id: "l", content: "long",
        confidence: 1, decay_rate: 0.05, access_count: 0, final_score: 0.9, source_id: null },
      { id: "atom-1", client_id: "c", layer_id: "l", content: "short",
        confidence: 1, decay_rate: 0.05, access_count: 0, final_score: 0.8, source_id: "raw-1" },
    ];
    const mockDb = async (sql) => {
      if (sql.includes("information_schema.columns")) return { rows: [{ "?column?": 1 }] };
      if (sql.includes("final_score")) return { rows };
      return { rows: [] };
    };
    const mockAi = { embed: async () => ({ embedding: [0.1], dimensions: 1, model: "t" }) };

    const out = await search(mockDb, mockAi, "q", {
      clientId: "c",
      minScore: 0,
      dedupeBySource: false,
    });

    expect(out.length).toBe(2);
    expect(out.map((r) => r.id).sort()).toEqual(["atom-1", "raw-1"]);
  });

  it("search results include source_id (null for raw, set for atoms)", async () => {
    const rows = [
      { id: "atom-1", client_id: "c", layer_id: "l", content: "atom",
        confidence: 1, decay_rate: 0.05, access_count: 0, final_score: 0.9, source_id: "raw-1" },
    ];
    const mockDb = async (sql) => {
      if (sql.includes("information_schema.columns")) return { rows: [{ "?column?": 1 }] };
      if (sql.includes("final_score")) return { rows };
      return { rows: [] };
    };
    const mockAi = { embed: async () => ({ embedding: [0.1], dimensions: 1, model: "t" }) };

    const out = await search(mockDb, mockAi, "q", { clientId: "c", minScore: 0 });
    expect(out[0].source_id).toBe("raw-1");
  });

  it("hydrateAtomSources: true fetches and appends source raws for matched atoms", async () => {
    const matchedRows = [
      { id: "atom-1", client_id: "c", layer_id: "l", content: "Caroline went to support group",
        confidence: 1, decay_rate: 0.05, access_count: 0, final_score: 0.9, source_id: "raw-1" },
    ];
    const hydratedRaw = {
      id: "raw-1", client_id: "c", layer_id: "l", source_id: null,
      content: "[Date: 8 May 2023] Caroline: I went to the LGBTQ support group...",
      confidence: 1, decay_rate: 0.05, access_count: 0,
    };
    const mockDb = async (sql, params) => {
      if (sql.includes("information_schema.columns")) return { rows: [{ "?column?": 1 }] };
      if (sql.includes("final_score")) return { rows: matchedRows };
      if (sql.includes("id = ANY") && Array.isArray(params?.[0]) && params[0].includes("raw-1")) {
        return { rows: [hydratedRaw] };
      }
      return { rows: [] };
    };
    const mockAi = { embed: async () => ({ embedding: [0.1], dimensions: 1, model: "t" }) };

    const out = await search(mockDb, mockAi, "q", {
      clientId: "c",
      minScore: 0,
      dedupeBySource: false,
      hydrateAtomSources: true,
    });

    expect(out.length).toBe(2);
    expect(out.map((r) => r.id).sort()).toEqual(["atom-1", "raw-1"]);
    const raw = out.find((r) => r.id === "raw-1");
    expect(raw.content).toContain("8 May 2023");
  });

  it("hydrateAtomSources: false is a no-op (default)", async () => {
    const rows = [
      { id: "atom-1", client_id: "c", layer_id: "l", content: "atom",
        confidence: 1, decay_rate: 0.05, access_count: 0, final_score: 0.9, source_id: "raw-1" },
    ];
    let hydrateCalled = false;
    const mockDb = async (sql) => {
      if (sql.includes("information_schema.columns")) return { rows: [{ "?column?": 1 }] };
      if (sql.includes("final_score")) return { rows };
      if (sql.includes("SELECT * FROM memory_nodes WHERE id = ANY")) {
        hydrateCalled = true;
        return { rows: [] };
      }
      return { rows: [] };
    };
    const mockAi = { embed: async () => ({ embedding: [0.1], dimensions: 1, model: "t" }) };

    await search(mockDb, mockAi, "q", {
      clientId: "c",
      minScore: 0,
      dedupeBySource: false,
    });

    expect(hydrateCalled).toBe(false);
  });
});

describe("ingest default behavior", () => {
  it("awaits distill when no waitUntil is passed (fixes fire-and-forget in local dev)", async () => {
    let distillStarted = false;
    let distillFinished = false;
    const mockDb = async (sql) => {
      if (sql.includes("SELECT id FROM memory_layers")) {
        return { rows: [{ id: "layer-1" }] };
      }
      return { rows: [] };
    };
    const mockAi = { embed: async () => null };
    const mockLlm = {
      chat: async () => {
        distillStarted = true;
        // Simulate LLM latency
        await new Promise((r) => setTimeout(r, 20));
        distillFinished = true;
        return "[]";
      },
    };

    await ingest(mockDb, mockAi, mockLlm, "some content", {
      clientId: "c",
      // no waitUntil — distill must be awaited inline
    });

    // After ingest returns, distill must have finished
    expect(distillStarted).toBe(true);
    expect(distillFinished).toBe(true);
  });
});

// --- Ingest options contract ---

describe("ingest options contract", () => {
  it("ingest accepts clientId, userId, layerType, metadata", async () => {
    const mockDb = async (sql) => {
      if (sql.includes("SELECT id FROM memory_layers")) {
        return { rows: [{ id: "layer-1" }] };
      }
      return { rows: [] };
    };
    const mockAi = { embed: async () => null };
    const mockLlm = { chat: async () => "" };

    const result = await ingest(mockDb, mockAi, mockLlm, "test content", {
      clientId: "test-client",
      userId: "user-123",
      layerType: "episodic",
      metadata: { source: "test" },
    });

    expect(result).toHaveProperty("id");
    expect(result).toHaveProperty("content");
    expect(result).toHaveProperty("layerId");
  });

  it("hands the distill background promise to opts.waitUntil when provided", async () => {
    const mockDb = async (sql) => {
      if (sql.includes("SELECT id FROM memory_layers")) {
        return { rows: [{ id: "layer-1" }] };
      }
      return { rows: [] };
    };
    const mockAi = { embed: async () => null };
    const mockLlm = { chat: async () => "[]" };

    const registered = [];
    await ingest(mockDb, mockAi, mockLlm, "test content", {
      clientId: "test-client",
      waitUntil: (p) => registered.push(p),
    });

    expect(registered.length).toBe(1);
    expect(typeof registered[0].then).toBe("function");
    await registered[0]; // should resolve cleanly
  });

  it("does not call waitUntil when distill is skipped", async () => {
    const mockDb = async (sql) => {
      if (sql.includes("SELECT id FROM memory_layers")) {
        return { rows: [{ id: "layer-1" }] };
      }
      return { rows: [] };
    };
    const mockAi = { embed: async () => null };
    const mockLlm = { chat: async () => "[]" };

    const registered = [];
    await ingest(mockDb, mockAi, mockLlm, "test content", {
      clientId: "test-client",
      distill: false,
      waitUntil: (p) => registered.push(p),
    });

    expect(registered.length).toBe(0);
  });
});

// --- Ingest dedup ---

describe("ingest dedup option", () => {
  function makeMockDb(state = {}) {
    const calls = [];
    const existing = state.existing || []; // [{ id, client_id, content }, ...]
    const inserted = [];
    const db = async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes("SELECT id FROM memory_layers")) {
        return { rows: [{ id: "layer-1" }] };
      }
      // Dedup pre-check (raw + LIKE legacy form)
      if (sql.includes("SELECT id FROM memory_nodes")) {
        const [clientId, content] = params;
        const match = existing.find(
          (r) =>
            r.client_id === clientId &&
            (r.content === content ||
              r.content.endsWith(`] ${content}`)) // legacy timestamp-prefixed
        );
        return { rows: match ? [{ id: match.id }] : [] };
      }
      // Insert path
      if (sql.startsWith("INSERT INTO memory_nodes")) {
        inserted.push({
          id: params[0],
          client_id: params[1],
          content: params[3],
        });
        return { rows: [] };
      }
      return { rows: [] };
    };
    return { db, calls, inserted };
  }

  const mockAi = { embed: async () => null };
  const mockLlm = { chat: async () => "[]" };

  it("inserts a fresh row when no duplicate exists", async () => {
    const { db, inserted } = makeMockDb({ existing: [] });

    const out = await ingest(db, mockAi, mockLlm, "fresh content", {
      clientId: "c",
      dedup: true,
    });

    expect(out.deduped).toBeUndefined();
    expect(out.id.startsWith("mem_")).toBe(true);
    expect(inserted).toHaveLength(1);
    expect(inserted[0].content).toBe("fresh content");
  });

  it("returns the existing row's id when raw content matches", async () => {
    const { db, inserted } = makeMockDb({
      existing: [
        { id: "mem_existing", client_id: "c", content: "duplicate content" },
      ],
    });

    const out = await ingest(db, mockAi, mockLlm, "duplicate content", {
      clientId: "c",
      dedup: true,
    });

    expect(out.deduped).toBe(true);
    expect(out.id).toBe("mem_existing");
    expect(out.content).toBe("duplicate content");
    expect(inserted).toHaveLength(0); // no insert happened
  });

  it("matches legacy timestamp-prefixed rows (`[<iso>] <content>`)", async () => {
    const { db, inserted } = makeMockDb({
      existing: [
        {
          id: "mem_legacy",
          client_id: "c",
          content: "[2026-04-26T10:00:00Z] duplicate content",
        },
      ],
    });

    const out = await ingest(db, mockAi, mockLlm, "duplicate content", {
      clientId: "c",
      dedup: true,
    });

    expect(out.deduped).toBe(true);
    expect(out.id).toBe("mem_legacy");
    expect(inserted).toHaveLength(0);
  });

  it("dedup off (default) still inserts on duplicate content", async () => {
    const { db, inserted } = makeMockDb({
      existing: [
        { id: "mem_existing", client_id: "c", content: "duplicate content" },
      ],
    });

    const out = await ingest(db, mockAi, mockLlm, "duplicate content", {
      clientId: "c",
      // dedup omitted — defaults to false
    });

    expect(out.deduped).toBeUndefined();
    expect(inserted).toHaveLength(1);
    expect(inserted[0].id).not.toBe("mem_existing");
  });

  it("scopes dedup to the given clientId (cross-tenant collisions don't dedup)", async () => {
    const { db, inserted } = makeMockDb({
      existing: [
        { id: "mem_other", client_id: "other", content: "duplicate content" },
      ],
    });

    const out = await ingest(db, mockAi, mockLlm, "duplicate content", {
      clientId: "c", // different tenant
      dedup: true,
    });

    expect(out.deduped).toBeUndefined();
    expect(inserted).toHaveLength(1);
    expect(inserted[0].client_id).toBe("c");
  });

  it("opts.dedupContent: matches against the raw form, stores the wrapped form", async () => {
    const { db, inserted } = makeMockDb({
      existing: [
        // Row was stored on a previous run with a 10:00 timestamp prefix
        {
          id: "mem_legacy",
          client_id: "c",
          content: "[2026-04-26T10:00:00Z] Caroline went to a support group",
        },
      ],
    });

    const out = await ingest(
      db,
      mockAi,
      mockLlm,
      // The retry would store with a fresh timestamp — strict-equality
      // would miss the dup. dedupContent makes us match on the raw form.
      "[2026-04-26T10:00:01Z] Caroline went to a support group",
      {
        clientId: "c",
        dedup: true,
        dedupContent: "Caroline went to a support group",
      }
    );

    expect(out.deduped).toBe(true);
    expect(out.id).toBe("mem_legacy");
    expect(inserted).toHaveLength(0);
  });

  it("dedup check failure falls through to insert (best-effort semantics)", async () => {
    let dupCheckSql = null;
    const flakyDb = async (sql, params) => {
      if (sql.includes("SELECT id FROM memory_layers")) {
        return { rows: [{ id: "layer-1" }] };
      }
      if (sql.includes("SELECT id FROM memory_nodes")) {
        dupCheckSql = sql;
        throw new Error("DB unreachable");
      }
      return { rows: [] };
    };

    const out = await ingest(flakyDb, mockAi, mockLlm, "content", {
      clientId: "c",
      dedup: true,
    });

    expect(dupCheckSql).toContain("memory_nodes");
    expect(out.deduped).toBeUndefined();
    expect(out.id.startsWith("mem_")).toBe(true);
  });
});
