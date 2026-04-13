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
});
