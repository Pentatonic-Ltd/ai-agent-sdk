/**
 * Tests for ingest opts.distill / opts.hyde — both must be skippable
 * for corpus ingest so code references don't trigger conversation-shaped
 * LLM enrichment (distillation hallucinates "user facts" from code,
 * HyDE generates expansion that won't match how callers query symbols).
 */

import { ingest } from "../ingest.js";

function mockDb() {
  const queries = [];
  const db = async (sql, params) => {
    queries.push({ sql, params });
    if (sql.includes("FROM memory_layers")) {
      return { rows: [{ id: "layer_xyz" }] };
    }
    return { rows: [] };
  };
  db.queries = queries;
  return db;
}

function mockAi() {
  let embedCalls = 0;
  return {
    embed: async () => {
      embedCalls++;
      return {
        embedding: new Array(8).fill(0.1),
        dimensions: 8,
        model: "mock-embed",
      };
    },
    chat: async () => "",
    get embedCalls() {
      return embedCalls;
    },
  };
}

function mockLlm() {
  let chatCalls = 0;
  const calls = [];
  return {
    chat: async (...args) => {
      chatCalls++;
      calls.push(args);
      // Fake hypothetical-question response (3 lines)
      return "What does this do?\nHow does this work?\nWhen is this called?";
    },
    get chatCalls() {
      return chatCalls;
    },
    get calls() {
      return calls;
    },
  };
}

describe("ingest — corpus opt-outs", () => {
  it("runs HyDE by default (chat is invoked)", async () => {
    const db = mockDb();
    const ai = mockAi();
    const llm = mockLlm();
    await ingest(db, ai, llm, "user said hello", {
      clientId: "acme",
      distill: false, // isolate HyDE behavior
    });
    expect(llm.chatCalls).toBeGreaterThan(0);
    // The HyDE update should land in metadata
    const hydeUpdate = db.queries.find((q) =>
      q.sql.includes("hypothetical_queries")
    );
    expect(hydeUpdate).toBeDefined();
  });

  it("skips HyDE when opts.hyde === false", async () => {
    const db = mockDb();
    const ai = mockAi();
    const llm = mockLlm();
    await ingest(db, ai, llm, "function authenticate(req)", {
      clientId: "acme",
      distill: false,
      hyde: false,
    });
    expect(llm.chatCalls).toBe(0);
    const hydeUpdate = db.queries.find((q) =>
      q.sql.includes("hypothetical_queries")
    );
    expect(hydeUpdate).toBeUndefined();
  });

  it("skips both HyDE and distill for code references", async () => {
    const db = mockDb();
    const ai = mockAi();
    const llm = mockLlm();
    await ingest(db, ai, llm, "function authenticate(req)", {
      clientId: "acme",
      distill: false,
      hyde: false,
      metadata: {
        kind: "code_reference",
        path: "src/auth.js",
        symbol: "authenticate",
      },
    });
    // No LLM calls at all (only embedding)
    expect(llm.chatCalls).toBe(0);
    expect(ai.embedCalls).toBe(1);
  });

  it("preserves the metadata.kind field through to the insert", async () => {
    const db = mockDb();
    const ai = mockAi();
    const llm = mockLlm();
    await ingest(db, ai, llm, "fn x()", {
      clientId: "acme",
      hyde: false,
      distill: false,
      metadata: { kind: "code_reference", path: "x.js" },
    });
    const insert = db.queries.find((q) =>
      q.sql.includes("INSERT INTO memory_nodes")
    );
    expect(insert).toBeDefined();
    const metadataParam = JSON.parse(insert.params[4]);
    expect(metadataParam.kind).toBe("code_reference");
  });
});
