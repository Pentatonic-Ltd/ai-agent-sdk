#!/usr/bin/env node

/**
 * @pentatonic/memory-server
 *
 * MCP server that exposes search_memories, store_memory, and list_memories
 * tools backed by @pentatonic/memory + PostgreSQL + pgvector.
 *
 * Environment variables:
 *   DATABASE_URL     — PostgreSQL connection string (required)
 *   EMBEDDING_URL    — OpenAI-compatible embeddings endpoint (required)
 *   EMBEDDING_MODEL  — Embedding model name (required)
 *   LLM_URL          — OpenAI-compatible chat endpoint (required)
 *   LLM_MODEL        — Chat model name for HyDE (required)
 *   API_KEY          — API key for embedding/LLM endpoints (optional)
 *   CLIENT_ID        — Client ID for memory scoping (default: "default")
 *   PORT             — HTTP port for SSE transport (default: 3333)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import pg from "pg";
import { createMemorySystem } from "./index.js";

const { Pool } = pg;

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
    },
    llm: {
      url: process.env.LLM_URL,
      model: process.env.LLM_MODEL,
      apiKey: process.env.API_KEY,
    },
    logger: (msg) => process.stderr.write(`[memory] ${msg}\n`),
  });
}

async function main() {
  const memory = createMemory();

  // Run migrations on startup
  await memory.migrate();
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

  // --- Start ---

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`[memory-server] Running with CLIENT_ID=${CLIENT_ID}\n`);
}

main().catch((err) => {
  process.stderr.write(`[memory-server] Fatal: ${err.message}\n`);
  process.exit(1);
});
