/**
 * Distillation tests — unit tests for extractAtomicFacts and distill.
 *
 * Uses mock LLM/embedding clients and an in-memory db fake.
 */

import { extractAtomicFacts, distill } from "../distill.js";

// --- Mock helpers ---

function mockLlm(responseText) {
  return {
    chat: async () => responseText,
  };
}

function mockAi() {
  return {
    embed: async (text) => ({
      embedding: new Array(768).fill(0).map((_, i) => i / 768),
      dimensions: 768,
      model: "mock",
    }),
    chat: async () => "",
  };
}

function mockDb(overrides = {}) {
  const calls = [];
  const db = async (sql, params) => {
    calls.push({ sql, params });
    // Layer lookup
    if (sql.includes("FROM memory_layers")) {
      return { rows: [{ id: "layer_semantic_id" }] };
    }
    // Handle INSERTs / UPDATEs silently
    return { rows: [] };
  };
  db.calls = calls;
  return db;
}

// --- extractAtomicFacts ---

describe("extractAtomicFacts", () => {
  it("parses a JSON array response", async () => {
    const llm = mockLlm('["Phil loves steak", "Phil lives in Nantwich"]');
    const facts = await extractAtomicFacts(llm, "I love steak and I live in Nantwich");
    expect(facts).toEqual(["Phil loves steak", "Phil lives in Nantwich"]);
  });

  it("strips markdown code fences", async () => {
    const llm = mockLlm('```json\n["Phil likes coffee"]\n```');
    const facts = await extractAtomicFacts(llm, "I like coffee");
    expect(facts).toEqual(["Phil likes coffee"]);
  });

  it("returns empty array when LLM returns empty", async () => {
    const llm = mockLlm("");
    const facts = await extractAtomicFacts(llm, "hi");
    expect(facts).toEqual([]);
  });

  it("returns empty array when JSON is malformed", async () => {
    const llm = mockLlm("not json at all");
    const facts = await extractAtomicFacts(llm, "some content");
    expect(facts).toEqual([]);
  });

  it("returns empty array when response is not an array", async () => {
    const llm = mockLlm('{"fact": "Phil likes coffee"}');
    const facts = await extractAtomicFacts(llm, "some content");
    expect(facts).toEqual([]);
  });

  it("filters out non-string entries", async () => {
    const llm = mockLlm('["valid fact", 123, null, "", "   ", "another"]');
    const facts = await extractAtomicFacts(llm, "...");
    expect(facts).toEqual(["valid fact", "another"]);
  });

  it("trims whitespace", async () => {
    const llm = mockLlm('["  Phil likes tea  "]');
    const facts = await extractAtomicFacts(llm, "...");
    expect(facts).toEqual(["Phil likes tea"]);
  });

  it("includes userName hint in system prompt when provided", async () => {
    let capturedMessages;
    const llm = {
      chat: async (messages) => {
        capturedMessages = messages;
        return "[]";
      },
    };
    await extractAtomicFacts(llm, "I like tea", { userName: "Phil" });
    expect(capturedMessages[0].content).toContain("Phil");
  });
});

// --- distill ---

describe("distill", () => {
  it("returns empty array when no facts extracted", async () => {
    const db = mockDb();
    const llm = mockLlm("[]");
    const ai = mockAi();
    const result = await distill(db, ai, llm, "mem_src", "hello", {
      clientId: "test",
    });
    expect(result).toEqual([]);
  });

  it("stores each fact with source_id pointing back to the raw memory", async () => {
    const db = mockDb();
    const llm = mockLlm('["Phil likes coffee", "Phil lives in London"]');
    const ai = mockAi();

    const result = await distill(db, ai, llm, "mem_raw_123", "...", {
      clientId: "test",
    });

    expect(result.length).toBe(2);

    // Find the INSERTs
    const inserts = db.calls.filter((c) =>
      c.sql.includes("INSERT INTO memory_nodes")
    );
    expect(inserts.length).toBe(2);

    // Each INSERT should include source_id = 'mem_raw_123'
    inserts.forEach((call) => {
      expect(call.params).toContain("mem_raw_123");
    });
  });

  it("skips when no semantic layer exists for client", async () => {
    const db = async (sql) => {
      if (sql.includes("FROM memory_layers")) return { rows: [] };
      return { rows: [] };
    };
    db.calls = [];
    const llm = mockLlm('["Phil likes tea"]');
    const ai = mockAi();

    const result = await distill(db, ai, llm, "mem_src", "content", {
      clientId: "test",
    });
    expect(result).toEqual([]);
  });

  it("continues storing remaining facts if one fails", async () => {
    let insertCount = 0;
    const db = async (sql, params) => {
      if (sql.includes("FROM memory_layers")) {
        return { rows: [{ id: "layer_sem" }] };
      }
      if (sql.includes("INSERT INTO memory_nodes")) {
        insertCount++;
        if (insertCount === 1) throw new Error("simulated db failure");
      }
      return { rows: [] };
    };
    const llm = mockLlm('["fact one", "fact two"]');
    const ai = mockAi();

    const result = await distill(db, ai, llm, "mem_src", "...", {
      clientId: "test",
    });

    // First INSERT fails, second succeeds
    expect(result.length).toBe(1);
    expect(result[0].content).toBe("fact two");
  });
});
