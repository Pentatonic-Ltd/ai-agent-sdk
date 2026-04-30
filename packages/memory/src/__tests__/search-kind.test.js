/**
 * Tests for search opts.kind — must add a metadata->>'kind' filter to
 * the SQL so corpus-shaped queries can scope to code references and
 * not compete with conversational memory for top-K slots.
 */

import { search, textSearch } from "../search.js";

function makeDb() {
  const calls = [];
  const db = async (sql, params) => {
    calls.push({ sql, params });
    // Vector column existence check — pretend it's there
    if (sql.includes("information_schema.columns")) {
      return { rows: [{}] };
    }
    // Search SQL — return empty rows; we only assert SQL shape
    return { rows: [] };
  };
  db.calls = calls;
  return db;
}

function makeAi() {
  return {
    embed: async () => ({
      embedding: new Array(8).fill(0.1),
      dimensions: 8,
      model: "mock",
    }),
  };
}

describe("search — kind filter", () => {
  it("adds metadata->>'kind' filter when opts.kind is provided", async () => {
    const db = makeDb();
    await search(db, makeAi(), "auth", {
      clientId: "acme",
      kind: "code_reference",
    });
    const searchCall = db.calls.find(
      (c) =>
        c.sql.includes("FROM memory_nodes mn") &&
        c.sql.includes("ORDER BY final_score")
    );
    expect(searchCall).toBeDefined();
    expect(searchCall.sql).toMatch(/metadata->>'kind' = \$\d+/);
    expect(searchCall.params).toContain("code_reference");
  });

  it("omits the kind filter entirely when not provided", async () => {
    const db = makeDb();
    await search(db, makeAi(), "auth", { clientId: "acme" });
    const searchCall = db.calls.find(
      (c) =>
        c.sql.includes("FROM memory_nodes mn") &&
        c.sql.includes("ORDER BY final_score")
    );
    expect(searchCall.sql).not.toMatch(/metadata->>'kind'/);
  });

  it("supports kind together with userId (param numbering stays valid)", async () => {
    const db = makeDb();
    await search(db, makeAi(), "auth", {
      clientId: "acme",
      userId: "u1",
      kind: "code_reference",
    });
    const searchCall = db.calls.find(
      (c) =>
        c.sql.includes("FROM memory_nodes mn") &&
        c.sql.includes("ORDER BY final_score")
    );
    expect(searchCall.sql).toMatch(/mn.user_id = \$\d+/);
    expect(searchCall.sql).toMatch(/metadata->>'kind' = \$\d+/);
    // Check params include both
    expect(searchCall.params).toContain("u1");
    expect(searchCall.params).toContain("code_reference");
  });
});

describe("textSearch fallback — kind filter", () => {
  it("propagates kind to the fallback path SQL", async () => {
    const db = makeDb();
    await textSearch(db, "auth", {
      clientId: "acme",
      kind: "code_reference",
    });
    const searchCall = db.calls.find(
      (c) =>
        c.sql.includes("FROM memory_nodes mn") &&
        c.sql.includes("plainto_tsquery")
    );
    expect(searchCall.sql).toMatch(/metadata->>'kind' = \$\d+/);
    expect(searchCall.params).toContain("code_reference");
  });

  it("omits kind from textSearch when not provided", async () => {
    const db = makeDb();
    await textSearch(db, "auth", { clientId: "acme" });
    const searchCall = db.calls.find(
      (c) =>
        c.sql.includes("FROM memory_nodes mn") &&
        c.sql.includes("plainto_tsquery")
    );
    expect(searchCall.sql).not.toMatch(/metadata->>'kind'/);
  });
});
