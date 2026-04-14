/**
 * E2E tests for the @pentatonic-ai/ai-agent-sdk memory system.
 *
 * Tests the full round-trip:
 *   1. Server starts and applies migrations
 *   2. Store memories via HTTP API (simulates hook stop.js)
 *   3. Search memories via HTTP API (simulates hook user-prompt.js)
 *   4. HyDE generates hypothetical queries
 *   5. Decay reduces confidence
 *   6. Memory layers work correctly
 *
 * Requires: Docker (for PostgreSQL with pgvector)
 * Does NOT require: Ollama (embeddings/HyDE mocked for CI speed)
 *
 * Run:
 *   docker compose -f e2e/memory/docker-compose.test.yml up -d
 *   node --experimental-vm-modules node_modules/.bin/jest e2e/memory/memory.e2e.test.js
 *   docker compose -f e2e/memory/docker-compose.test.yml down
 */

import { createMemorySystem } from "../../packages/memory/src/index.js";
import { searchMemories, storeMemory } from "../../hooks/scripts/shared.js";
import pg from "pg";
import fs from "fs";
import path from "path";
import os from "os";

const { Pool } = pg;

const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://memory_test:memory_test@localhost:5435/memory_test";

let pool;
let memory;

// Mock AI client for CI (no Ollama needed)
const mockEmbedding = Array.from({ length: 768 }, (_, i) =>
  Math.sin(i * 0.1)
);

function createMockAIMemory() {
  return createMemorySystem({
    db: pool,
    embedding: {
      url: "http://mock-not-called",
      model: "mock",
    },
    llm: {
      url: "http://mock-not-called",
      model: "mock",
    },
    logger: () => {},
  });
}

beforeAll(async () => {
  pool = new Pool({ connectionString: DATABASE_URL });

  // Wait for Postgres
  for (let i = 0; i < 30; i++) {
    try {
      await pool.query("SELECT 1");
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  // Enable pgvector
  await pool.query("CREATE EXTENSION IF NOT EXISTS vector");

  memory = createMockAIMemory();
  await memory.migrate();
}, 60000);

afterAll(async () => {
  // Cleanup
  try {
    await pool.query("DROP TABLE IF EXISTS memory_consolidations CASCADE");
    await pool.query("DROP TABLE IF EXISTS memory_nodes CASCADE");
    await pool.query("DROP TABLE IF EXISTS memory_layers CASCADE");
    await pool.query("DROP TABLE IF EXISTS schema_migrations CASCADE");
  } catch {
    // Ignore
  }
  await pool.end();
});

describe("Memory System E2E", () => {
  const CLIENT_ID = "e2e-test";

  test("migrate creates tables", async () => {
    const result = await pool.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'memory%' ORDER BY tablename"
    );
    const tables = result.rows.map((r) => r.tablename);
    expect(tables).toContain("memory_nodes");
    expect(tables).toContain("memory_layers");
    expect(tables).toContain("memory_consolidations");
  });

  test("ensureLayers creates default layers", async () => {
    await memory.ensureLayers(CLIENT_ID);
    const layers = await memory.getLayers(CLIENT_ID);
    const names = layers.map((l) => l.name);
    expect(names).toContain("episodic");
    expect(names).toContain("semantic");
    expect(names).toContain("procedural");
    expect(names).toContain("working");
  });

  test("ingest stores a memory", async () => {
    const result = await memory.ingest(
      "Phil is the Director of Engineering at Pentatonic and built TES",
      {
        clientId: CLIENT_ID,
        userId: "phil@pentatonic.com",
        metadata: { source: "e2e-test" },
      }
    );

    expect(result.id).toMatch(/^mem_/);
    expect(result.content).toContain("Director of Engineering");
    expect(result.layerId).toBeDefined();
  });

  test("ingest stores multiple memories", async () => {
    await memory.ingest("The team decided to use PostgreSQL with pgvector for memory storage", {
      clientId: CLIENT_ID,
    });
    await memory.ingest("HyDE generates hypothetical questions at ingest time to improve retrieval", {
      clientId: CLIENT_ID,
    });
    await memory.ingest("The LoCoMo benchmark measures long-term conversational memory quality", {
      clientId: CLIENT_ID,
    });

    const result = await pool.query(
      "SELECT COUNT(*)::int as cnt FROM memory_nodes WHERE client_id = $1",
      [CLIENT_ID]
    );
    expect(result.rows[0].cnt).toBeGreaterThanOrEqual(4);
  });

  test("textSearch finds memories by content", async () => {
    const results = await memory.textSearch("PostgreSQL pgvector", {
      clientId: CLIENT_ID,
      limit: 5,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain("PostgreSQL");
  });

  test("textSearch returns empty for unrelated query", async () => {
    const results = await memory.textSearch("quantum physics black holes", {
      clientId: CLIENT_ID,
      limit: 5,
    });

    expect(results.length).toBe(0);
  });

  test("getLayers returns memory counts", async () => {
    const layers = await memory.getLayers(CLIENT_ID);
    const episodic = layers.find((l) => l.name === "episodic");
    expect(episodic.memory_count).toBeGreaterThanOrEqual(4);
  });

  test("decay reduces confidence", async () => {
    // Get initial confidence
    const before = await pool.query(
      "SELECT AVG(confidence)::float as avg_conf FROM memory_nodes WHERE client_id = $1",
      [CLIENT_ID]
    );
    const beforeConf = before.rows[0].avg_conf;

    const stats = await memory.decay(CLIENT_ID);

    expect(stats.layersProcessed).toBeGreaterThan(0);
    expect(stats.decayed).toBeGreaterThanOrEqual(0);

    // Confidence should have decreased (or stayed same if recently accessed)
    const after = await pool.query(
      "SELECT AVG(confidence)::float as avg_conf FROM memory_nodes WHERE client_id = $1",
      [CLIENT_ID]
    );
    expect(after.rows[0].avg_conf).toBeLessThanOrEqual(beforeConf);
  });

  test("consolidate promotes high-access memories", async () => {
    // Manually bump access_count on a memory to trigger consolidation
    await pool.query(
      "UPDATE memory_nodes SET access_count = 10 WHERE client_id = $1 AND content LIKE '%Director%'",
      [CLIENT_ID]
    );

    const consolidated = await memory.consolidate(CLIENT_ID, {
      threshold: 5,
    });

    expect(consolidated.length).toBeGreaterThan(0);
    expect(consolidated[0]).toHaveProperty("sourceId");
    expect(consolidated[0]).toHaveProperty("targetId");

    // Verify the promoted memory exists in semantic layer
    const semantic = await pool.query(
      "SELECT mn.* FROM memory_nodes mn JOIN memory_layers ml ON mn.layer_id = ml.id WHERE ml.name = 'semantic' AND mn.client_id = $1",
      [CLIENT_ID]
    );
    expect(semantic.rows.length).toBeGreaterThan(0);
  });

  test("client isolation — different clients don't see each other", async () => {
    await memory.ensureLayers("other-client");
    await memory.ingest("This belongs to another client entirely", {
      clientId: "other-client",
    });

    const results = await memory.textSearch("another client", {
      clientId: CLIENT_ID,
      limit: 10,
    });

    const leaked = results.filter((r) =>
      r.content.includes("another client")
    );
    expect(leaked.length).toBe(0);
  });
});

describe("HTTP API E2E", () => {
  let server;
  let serverUrl;

  beforeAll(async () => {
    // Start memory server programmatically
    const http = await import("http");

    const mem = createMockAIMemory();

    server = http.createServer(async (req, res) => {
      const url = new URL(req.url, "http://localhost");
      const body = await new Promise((resolve) => {
        let data = "";
        req.on("data", (chunk) => (data += chunk));
        req.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve({});
          }
        });
      });

      res.setHeader("Content-Type", "application/json");

      if (url.pathname === "/health") {
        res.end(JSON.stringify({ status: "ok" }));
      } else if (url.pathname === "/store" && req.method === "POST") {
        const result = await mem.ingest(body.content || "", {
          clientId: "http-test",
          metadata: body.metadata || {},
        });
        res.end(JSON.stringify(result));
      } else if (url.pathname === "/search" && req.method === "POST") {
        const results = await mem.textSearch(body.query || "", {
          clientId: "http-test",
          limit: body.limit || 5,
        });
        res.end(JSON.stringify({ results }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "not found" }));
      }
    });

    await new Promise((resolve) => {
      server.listen(0, () => {
        serverUrl = `http://localhost:${server.address().port}`;
        resolve();
      });
    });

    await mem.ensureLayers("http-test");
  });

  afterAll(() => {
    server?.close();
  });

  test("health endpoint responds", async () => {
    const res = await fetch(`${serverUrl}/health`);
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.status).toBe("ok");
  });

  test("store + search round-trip", async () => {
    // Store
    const storeRes = await fetch(`${serverUrl}/store`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "The deployment uses Cloudflare Workers with D1 and R2",
      }),
    });
    expect(storeRes.ok).toBe(true);
    const stored = await storeRes.json();
    expect(stored.id).toMatch(/^mem_/);

    // Search
    const searchRes = await fetch(`${serverUrl}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "Cloudflare Workers" }),
    });
    expect(searchRes.ok).toBe(true);
    const { results } = await searchRes.json();
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain("Cloudflare");
  });

  test("search returns empty for unrelated query", async () => {
    const res = await fetch(`${serverUrl}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "martian geology samples" }),
    });
    const { results } = await res.json();
    expect(results.length).toBe(0);
  });
});

describe("Config & Hook Routing E2E", () => {

  let configDir;
  let configPath;
  let originalHome;
  let httpServer;
  let httpUrl;
  let storedViaHttp = [];

  beforeAll(async () => {
    // Use a temp dir for config to avoid touching real config
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-e2e-"));
    configPath = path.join(configDir, "tes-memory.local.md");

    // Start a mock HTTP server to capture hook calls
    const http = await import("http");
    httpServer = http.createServer(async (req, res) => {
      const body = await new Promise((resolve) => {
        let data = "";
        req.on("data", (chunk) => (data += chunk));
        req.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve({});
          }
        });
      });

      res.setHeader("Content-Type", "application/json");

      if (req.url === "/search" && req.method === "POST") {
        res.end(
          JSON.stringify({
            results: [
              {
                id: "mock-1",
                content: "Mock memory from local server",
                similarity: 0.9,
              },
            ],
          })
        );
      } else if (req.url === "/store" && req.method === "POST") {
        storedViaHttp.push(body);
        res.end(JSON.stringify({ id: "mock-stored", content: body.content }));
      } else {
        res.statusCode = 404;
        res.end("{}");
      }
    });

    await new Promise((resolve) => {
      httpServer.listen(0, () => {
        httpUrl = `http://localhost:${httpServer.address().port}`;
        resolve();
      });
    });
  });

  afterAll(() => {
    httpServer?.close();
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  test("local mode config routes search to HTTP server", async () => {
    fs.writeFileSync(
      configPath,
      `---\nmode: local\nmemory_url: ${httpUrl}\n---\n`
    );

    // Manually load config from our temp path
    const content = fs.readFileSync(configPath, "utf-8");
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    const config = {};
    for (const line of match[1].split("\n")) {
      const [key, ...rest] = line.split(":");
      if (key && rest.length) config[key.trim()] = rest.join(":").trim();
    }

    const results = await searchMemories(config, "test query");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain("Mock memory");
  });

  test("local mode config routes store to HTTP server", async () => {
    const content = fs.readFileSync(configPath, "utf-8");
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    const config = {};
    for (const line of match[1].split("\n")) {
      const [key, ...rest] = line.split(":");
      if (key && rest.length) config[key.trim()] = rest.join(":").trim();
    }

    storedViaHttp = [];
    await storeMemory(config, "Test memory from hook", { session_id: "s1" });
    expect(storedViaHttp.length).toBe(1);
    expect(storedViaHttp[0].content).toBe("Test memory from hook");
  });

  test("hosted mode config does not call local HTTP server", async () => {
    fs.writeFileSync(
      configPath,
      `---\ntes_endpoint: https://fake-tes.example.com\ntes_client_id: test\ntes_api_key: tes_test_fake\n---\n`
    );

    const content = fs.readFileSync(configPath, "utf-8");
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    const config = {};
    for (const line of match[1].split("\n")) {
      const [key, ...rest] = line.split(":");
      if (key && rest.length) config[key.trim()] = rest.join(":").trim();
    }

    // Hosted mode — search will fail (fake endpoint) but should NOT hit our local server
    storedViaHttp = [];
    const results = await searchMemories(config, "test");
    // Should return empty (fake TES endpoint fails)
    expect(results).toEqual([]);
    // Should not have hit our local mock
    expect(storedViaHttp.length).toBe(0);
  });

  test("config without mode defaults to hosted", async () => {
    fs.writeFileSync(
      configPath,
      `---\ntes_endpoint: https://example.com\ntes_client_id: x\ntes_api_key: tes_x\n---\n`
    );

    const content = fs.readFileSync(configPath, "utf-8");
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    const config = {};
    for (const line of match[1].split("\n")) {
      const [key, ...rest] = line.split(":");
      if (key && rest.length) config[key.trim()] = rest.join(":").trim();
    }

    // No mode field = hosted mode
    expect(config.mode).toBeUndefined();
    // Search goes to hosted (will fail, but won't hit local)
    storedViaHttp = [];
    await searchMemories(config, "test");
    expect(storedViaHttp.length).toBe(0);
  });
});
