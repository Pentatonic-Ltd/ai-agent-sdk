/**
 * OpenClaw plugin entry point for @pentatonic/memory.
 *
 * Registers as a context-engine plugin with memory search/store tools.
 * Every message is ingested automatically, every prompt gets relevant
 * memories injected as context.
 *
 * Config in openclaw.json:
 * {
 *   "plugins": {
 *     "entries": {
 *       "pentatonic-memory": {
 *         "enabled": true,
 *         "config": {
 *           "database_url": "postgres://memory:memory@localhost:5433/memory",
 *           "embedding_url": "http://localhost:11435/v1",
 *           "embedding_model": "nomic-embed-text",
 *           "llm_url": "http://localhost:11435/v1",
 *           "llm_model": "llama3.2:3b"
 *         }
 *       }
 *     }
 *   }
 * }
 */

import pg from "pg";
import { createMemorySystem } from "../index.js";
import { createContextEngine } from "./context-engine.js";

const { Pool } = pg;

let memory = null;

function getMemory(config = {}) {
  if (memory) return memory;

  const dbUrl =
    config.database_url ||
    process.env.DATABASE_URL ||
    "postgres://memory:memory@localhost:5433/memory";
  const embUrl =
    config.embedding_url ||
    process.env.EMBEDDING_URL ||
    "http://localhost:11435/v1";
  const embModel =
    config.embedding_model ||
    process.env.EMBEDDING_MODEL ||
    "nomic-embed-text";
  const llmUrl =
    config.llm_url || process.env.LLM_URL || "http://localhost:11435/v1";
  const llmModel =
    config.llm_model || process.env.LLM_MODEL || "llama3.2:3b";

  memory = createMemorySystem({
    db: new Pool({ connectionString: dbUrl }),
    embedding: { url: embUrl, model: embModel },
    llm: { url: llmUrl, model: llmModel },
    logger: (msg) => process.stderr.write(`[pentatonic-memory] ${msg}\n`),
  });

  return memory;
}

export default {
  id: "pentatonic-memory",
  name: "Pentatonic Memory",
  description:
    "Persistent, searchable memory with multi-signal retrieval and HyDE query expansion",
  kind: "context-engine",

  register(api) {
    const config = api.config || {};
    const mem = getMemory(config);
    const log = (msg) =>
      process.stderr.write(`[pentatonic-memory] ${msg}\n`);

    // Run migrations on startup
    mem.migrate().then(() => {
      mem.ensureLayers(config.client_id || "default");
      log("Migrations applied, layers ready");
    });

    // Register context engine (deterministic lifecycle)
    api.registerContextEngine(
      "pentatonic-memory",
      () =>
        createContextEngine(mem, {
          clientId: config.client_id || "default",
          searchLimit: config.search_limit || 5,
          minScore: config.min_score || 0.3,
          logger: log,
        })
    );

    // Register tools (agent-driven, optional)
    api.registerTool({
      name: "memory_search",
      description:
        "Search memories for relevant context. Use when you need to recall past conversations, decisions, or knowledge.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "What to search for",
          },
          limit: {
            type: "number",
            description: "Max results (default 5)",
          },
        },
        required: ["query"],
      },
      async execute({ query, limit }) {
        const results = await mem.search(query, {
          clientId: config.client_id || "default",
          limit: limit || 5,
          minScore: 0.3,
        });

        if (!results.length) return "No relevant memories found.";

        return results
          .map(
            (m, i) =>
              `${i + 1}. [${Math.round((m.similarity || 0) * 100)}%] ${m.content}`
          )
          .join("\n\n");
      },
    });

    api.registerTool({
      name: "memory_store",
      description:
        "Explicitly store something important. Use for decisions, solutions, or facts worth remembering.",
      parameters: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "What to remember",
          },
        },
        required: ["content"],
      },
      async execute({ content }) {
        const result = await mem.ingest(content, {
          clientId: config.client_id || "default",
          metadata: { source: "openclaw-tool" },
        });
        return `Stored: ${result.id}`;
      },
    });

    api.registerTool({
      name: "memory_forget",
      description: "List memory layers and their stats.",
      parameters: { type: "object", properties: {} },
      async execute() {
        const layers = await mem.getLayers(config.client_id || "default");
        return layers
          .map(
            (l) =>
              `${l.layer_type}: ${l.memory_count}/${l.capacity || "unlimited"} memories`
          )
          .join("\n");
      },
    });

    log("Plugin registered");
  },
};
