#!/usr/bin/env node

/**
 * the memory server
 *
 * MCP server that exposes search_memories, store_memory, and list_memories
 * tools backed by the memory system + PostgreSQL + pgvector.
 *
 * Environment variables:
 *   DATABASE_URL     — PostgreSQL connection string (required)
 *   EMBEDDING_URL    — OpenAI-compatible embeddings endpoint (required)
 *   EMBEDDING_MODEL  — Embedding model name (required)
 *   LLM_URL          — OpenAI-compatible chat endpoint (required)
 *   LLM_MODEL        — Chat model name for HyDE (required)
 *   API_KEY          — API key for embedding/LLM endpoints (optional)
 *   EMBEDDING_PATH   — Path appended to EMBEDDING_URL (default: "embeddings").
 *                      Set to "embed" for the Pentatonic AI Gateway.
 *   CHAT_PATH        — Path appended to LLM_URL (default: "chat/completions")
 *   CLIENT_ID        — Client ID for memory scoping (default: "default")
 *   PORT             — HTTP port for SSE transport (default: 3333)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import pg from "pg";
import { createMemorySystem } from "./index.js";

const { Pool } = pg;

// Prevent unhandled rejections from killing the process
process.on("uncaughtException", (err) => {
  process.stderr.write(`[memory-server] Uncaught: ${err.message}\n`);
});
process.on("unhandledRejection", (err) => {
  process.stderr.write(`[memory-server] Unhandled rejection: ${err?.message || err}\n`);
});

const CLIENT_ID = process.env.CLIENT_ID || "default";

function createMemory() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  return createMemorySystem({
    db: pool,
    embedding: {
      url: process.env.EMBEDDING_URL,
      model: process.env.EMBEDDING_MODEL,
      apiKey: process.env.API_KEY,
      embeddingPath: process.env.EMBEDDING_PATH,
    },
    llm: {
      url: process.env.LLM_URL,
      model: process.env.LLM_MODEL,
      apiKey: process.env.API_KEY,
      chatPath: process.env.CHAT_PATH,
    },
    logger: (msg) => process.stderr.write(`[memory] ${msg}\n`),
  });
}

async function main() {
  // Telemetry ping — fire and forget
  if (process.env.PENTATONIC_TELEMETRY !== "0") {
    const mid = (() => {
      const raw = `${process.env.USER || "u"}:${process.platform}:${process.arch}`;
      let h = 0;
      for (let i = 0; i < raw.length; i++) h = ((h << 5) - h + raw.charCodeAt(i)) | 0;
      return (h >>> 0).toString(16).padStart(8, "0");
    })();
    fetch("https://sdk-telemetry.philip-134.workers.dev", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        machine_id: mid,
        sdk_version: "0.4.0",
        node_version: process.version,
        platform: process.platform,
        arch: process.arch,
        mode: "local",
      }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {});
  }

  const memory = createMemory();

  // Enable pgvector before migrations (so migration 002 can create the vector column)
  const setupPool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await setupPool.query("CREATE EXTENSION IF NOT EXISTS vector");
    process.stderr.write("[memory-server] pgvector extension enabled\n");
  } catch (err) {
    process.stderr.write(`[memory-server] pgvector not available: ${err.message}\n`);
  }

  // Run migrations on startup
  await memory.migrate();

  // Fix: if migration 002 ran without pgvector, the vector column is missing.
  // Re-apply it now that the extension is enabled.
  try {
    const colCheck = await setupPool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = 'memory_nodes' AND column_name = 'embedding_vec' LIMIT 1`
    );
    if (colCheck.rows.length === 0) {
      process.stderr.write("[memory-server] embedding_vec column missing — re-applying migration 002\n");
      const { readFileSync } = await import("fs");
      const { resolve, dirname } = await import("path");
      const { fileURLToPath } = await import("url");
      const migrationPath = resolve(dirname(fileURLToPath(import.meta.url)), "../migrations/002-vector-index.sql");
      const sql = readFileSync(migrationPath, "utf-8");
      await setupPool.query(sql);
      process.stderr.write("[memory-server] embedding_vec column created\n");
    }

    // Re-run 006 if there are JSONB embeddings but no populated vectors —
    // catches the case where 006 ran on a fresh DB before any data existed,
    // then a subsequent insert was silently dimension-mismatched.
    const mismatchCheck = await setupPool.query(
      `SELECT
         EXISTS (SELECT 1 FROM memory_nodes WHERE embedding IS NOT NULL) AS has_jsonb,
         EXISTS (SELECT 1 FROM memory_nodes WHERE embedding_vec IS NOT NULL) AS has_vec
       FROM memory_nodes LIMIT 1`
    );
    const row = mismatchCheck.rows[0] || {};
    if (row.has_jsonb && !row.has_vec) {
      process.stderr.write("[memory-server] JSONB embeddings present but no vectors — re-running migration 006\n");
      const { readFileSync } = await import("fs");
      const { resolve, dirname } = await import("path");
      const { fileURLToPath } = await import("url");
      const migrationPath = resolve(dirname(fileURLToPath(import.meta.url)), "../migrations/006-fix-vector-dim.sql");
      const sql = readFileSync(migrationPath, "utf-8");
      await setupPool.query(sql);
      process.stderr.write("[memory-server] embedding_vec repair complete\n");
    }
  } catch (err) {
    process.stderr.write(`[memory-server] Vector column repair skipped: ${err.message}\n`);
  }
  await setupPool.end();

  await memory.ensureLayers(CLIENT_ID);

  const server = new McpServer({
    name: "pentatonic-memory",
    version: "0.1.0",
  });

  // --- Tools ---

  server.tool(
    "search_memories",
    "Semantic search across memories. Returns ranked results combining vector similarity, text matching, recency, and access frequency.",
    {
      query: z.string().describe("Search query text"),
      limit: z
        .number()
        .optional()
        .default(5)
        .describe("Max results (default 5)"),
      min_score: z
        .number()
        .optional()
        .default(0.3)
        .describe("Minimum relevance score 0-1 (default 0.3)"),
    },
    async ({ query, limit, min_score }) => {
      const results = await memory.search(query, {
        clientId: CLIENT_ID,
        limit,
        minScore: min_score,
      });

      if (!results.length) {
        return {
          content: [{ type: "text", text: "No relevant memories found." }],
        };
      }

      const text = results
        .map(
          (r, i) =>
            `[${i + 1}] (${Math.round((r.similarity || 0) * 100)}% match)\n${r.content}`
        )
        .join("\n\n");

      return {
        content: [{ type: "text", text }],
      };
    }
  );

  server.tool(
    "store_memory",
    "Store a new memory. The system automatically generates embeddings and hypothetical search queries (HyDE) for better future retrieval.",
    {
      content: z.string().describe("Memory content to store"),
      metadata: z.record(z.any()).optional().describe("Optional metadata"),
    },
    async ({ content, metadata }) => {
      const result = await memory.ingest(content, {
        clientId: CLIENT_ID,
        metadata,
      });

      return {
        content: [
          {
            type: "text",
            text: `Memory stored: ${result.id}`,
          },
        ],
      };
    }
  );

  server.tool(
    "list_memories",
    "Browse memories, optionally filtered by layer (episodic, semantic, procedural, working).",
    {
      layer: z.string().optional().describe("Filter by layer type"),
      limit: z
        .number()
        .optional()
        .default(10)
        .describe("Max results (default 10)"),
    },
    async ({ layer, limit }) => {
      // Get layers to find the layer ID
      const layers = await memory.getLayers(CLIENT_ID);

      let targetLayerId;
      if (layer) {
        const found = layers.find(
          (l) => l.name === layer || l.layer_type === layer
        );
        if (!found) {
          return {
            content: [
              {
                type: "text",
                text: `Layer "${layer}" not found. Available: ${layers.map((l) => l.name).join(", ")}`,
              },
            ],
          };
        }
        targetLayerId = found.id;
      }

      // Use text search with empty query to list memories
      // (this is a browse, not a search)
      const db = memory._db || createMemory()._db;

      // Direct query for listing
      const pool = new Pool({ connectionString: process.env.DATABASE_URL });
      const whereClauses = ["client_id = $1"];
      const params = [CLIENT_ID];

      if (targetLayerId) {
        whereClauses.push(`layer_id = $${params.length + 1}`);
        params.push(targetLayerId);
      }

      params.push(Math.min(limit || 10, 100));

      const result = await pool.query(
        `SELECT id, content, confidence, access_count, created_at
         FROM memory_nodes
         WHERE ${whereClauses.join(" AND ")}
         ORDER BY created_at DESC
         LIMIT $${params.length}`,
        params
      );

      await pool.end();

      if (!result.rows.length) {
        return {
          content: [{ type: "text", text: "No memories found." }],
        };
      }

      const header = `${result.rows.length} memories${layer ? ` in ${layer} layer` : ""}:\n\n`;
      const text = result.rows
        .map(
          (r) =>
            `[${r.id}] confidence=${parseFloat(r.confidence).toFixed(2)}, accessed=${r.access_count}x\n${r.content.substring(0, 200)}`
        )
        .join("\n\n");

      return {
        content: [{ type: "text", text: header + text }],
      };
    }
  );

  // --- HTTP API (for hooks) ---

  const PORT = parseInt(process.env.PORT || "3333");

  const httpServer = await import("http").then((http) =>
    http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      const body = await new Promise((resolve) => {
        let data = "";
        req.on("data", (chunk) => (data += chunk));
        req.on("end", () => {
          try { resolve(JSON.parse(data)); } catch { resolve({}); }
        });
      });

      res.setHeader("Content-Type", "application/json");

      if (url.pathname === "/search" && req.method === "POST") {
        try {
          // Try vector search first (embeddings + BM25 + recency + frequency).
          // Falls back to text-only search internally if embeddings fail.
          // Use ?mode=text to force text-only search.
          const textOnly = url.searchParams.get("mode") === "text";
          const searchFn = textOnly ? memory.textSearch : memory.search;
          const results = await searchFn(body.query || "", {
            clientId: CLIENT_ID,
            limit: body.limit || 5,
            minScore: body.min_score || 0.3,
          });
          res.end(JSON.stringify({ results }));
        } catch (err) {
          process.stderr.write(`[memory-server] Search error: ${err.message}\n${err.stack}\n`);
          res.end(JSON.stringify({ results: [], error: err.message }));
        }
      } else if (url.pathname === "/store" && req.method === "POST") {
        try {
          const result = await memory.ingest(body.content || "", {
            clientId: CLIENT_ID,
            metadata: body.metadata || {},
          });
          res.end(JSON.stringify(result));
        } catch (err) {
          process.stderr.write(`[memory-server] Store error: ${err.message}\n`);
          res.statusCode = 500;
          res.end(JSON.stringify({ error: err.message }));
        }
      } else if (url.pathname === "/health") {
        const health = {
          status: "ok",
          client: CLIENT_ID,
          version: "0.5.5",
          search: "text",
          db: false,
          ollama: false,
          vector: false,
        };

        // Check DB
        try {
          const pool = new Pool({ connectionString: process.env.DATABASE_URL });
          await pool.query("SELECT 1");
          health.db = true;
          // Check vector column
          const vecCheck = await pool.query(
            `SELECT 1 FROM information_schema.columns WHERE table_name = 'memory_nodes' AND column_name = 'embedding_vec' LIMIT 1`
          );
          health.vector = (vecCheck.rows || []).length > 0;
          // Check memory count
          try {
            const countRes = await pool.query(
              "SELECT COUNT(*)::int as cnt FROM memory_nodes WHERE client_id = $1", [CLIENT_ID]
            );
            health.memories = countRes.rows[0].cnt;
          } catch { /* table may not exist yet */ }
          await pool.end();
        } catch { /* db not reachable */ }

        // Check Ollama
        try {
          const ollamaRes = await fetch(
            `${process.env.EMBEDDING_URL || "http://localhost:11434/v1"}/models`,
            { signal: AbortSignal.timeout(3000) }
          );
          if (ollamaRes.ok) {
            health.ollama = true;
            health.search = health.vector ? "vector+text" : "text";
          }
        } catch { /* ollama not reachable */ }

        res.end(JSON.stringify(health));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "not found" }));
      }
    })
  );

  httpServer.listen(PORT, () => {
    process.stderr.write(`[memory-server] HTTP API on port ${PORT}\n`);
  });

  // --- MCP (for direct agent connection) ---

  if (process.stdin.isTTY === false) {
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }

  process.stderr.write(`[memory-server] Running with CLIENT_ID=${CLIENT_ID}\n`);
}

main().catch((err) => {
  process.stderr.write(`[memory-server] Fatal: ${err.message}\n`);
  process.exit(1);
});
