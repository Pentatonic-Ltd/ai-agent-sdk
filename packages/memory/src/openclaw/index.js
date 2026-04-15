/**
 * OpenClaw plugin entry point for the Pentatonic memory system.
 *
 * Supports two modes:
 *   - Local: direct PostgreSQL + pgvector (requires Docker stack)
 *   - Hosted: routes through TES GraphQL API
 *
 * Install:
 *   openclaw plugins install -l ./packages/memory/src/openclaw
 *
 * Config in openclaw.json:
 * {
 *   "plugins": {
 *     "slots": { "contextEngine": "pentatonic-memory" },
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
 *
 * For hosted mode, replace config with:
 *   "config": {
 *     "tes_endpoint": "https://your-client.api.pentatonic.com",
 *     "tes_client_id": "your-company",
 *     "tes_api_key": "tes_your-company_xxxxx"
 *   }
 */

import pg from "pg";
import { createMemorySystem } from "../index.js";
import { createContextEngine } from "./context-engine.js";

const { Pool } = pg;

const TELEMETRY_URL = "https://sdk-telemetry.philip-134.workers.dev";

let memory = null;

function isHostedMode(config) {
  return !!(config.tes_endpoint && config.tes_api_key);
}

function getLocalMemory(config = {}) {
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

// --- Hosted mode helpers ---

function tesHeaders(config) {
  const headers = {
    "Content-Type": "application/json",
    "x-client-id": config.tes_client_id,
  };
  if (config.tes_api_key?.startsWith("tes_")) {
    headers["Authorization"] = `Bearer ${config.tes_api_key}`;
  } else {
    headers["x-service-key"] = config.tes_api_key;
  }
  return headers;
}

async function hostedSearch(config, query, limit = 5, minScore = 0.3) {
  try {
    const response = await fetch(`${config.tes_endpoint}/api/graphql`, {
      method: "POST",
      headers: tesHeaders(config),
      body: JSON.stringify({
        query: `query($clientId: String!, $query: String!, $limit: Int, $minScore: Float) {
          semanticSearchMemories(clientId: $clientId, query: $query, limit: $limit, minScore: $minScore) {
            id content similarity
          }
        }`,
        variables: {
          clientId: config.tes_client_id,
          query,
          limit,
          minScore,
        },
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return [];
    const json = await response.json();
    return json.data?.semanticSearchMemories || [];
  } catch {
    return [];
  }
}

async function hostedStore(config, content, metadata = {}) {
  try {
    const response = await fetch(`${config.tes_endpoint}/api/graphql`, {
      method: "POST",
      headers: tesHeaders(config),
      body: JSON.stringify({
        query: `mutation CreateModuleEvent($moduleId: String!, $input: ModuleEventInput!) {
          createModuleEvent(moduleId: $moduleId, input: $input) { success eventId }
        }`,
        variables: {
          moduleId: "deep-memory",
          input: {
            eventType: "STORE_MEMORY",
            data: {
              entity_id: metadata.session_id || "openclaw",
              attributes: {
                ...metadata,
                content,
                source: "openclaw-plugin",
              },
            },
          },
        },
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return null;
    return response.json();
  } catch {
    return null;
  }
}

// --- Hosted context engine ---

function createHostedContextEngine(config, opts = {}) {
  const searchLimit = opts.searchLimit || 5;
  const minScore = opts.minScore || 0.3;
  const log = opts.logger || (() => {});

  return {
    info: {
      id: "pentatonic-memory",
      name: "Pentatonic Memory (Hosted)",
      ownsCompaction: false,
    },

    async ingest({ sessionId, message }) {
      if (!message?.content) return { ingested: false };
      const role = message.role || message.type;
      if (role !== "user" && role !== "assistant") return { ingested: false };

      try {
        await hostedStore(config, message.content, {
          session_id: sessionId,
          role,
        });
        log(`[memory] Ingested ${role} message via TES`);
        return { ingested: true };
      } catch (err) {
        log(`[memory] Hosted ingest failed: ${err.message}`);
        return { ingested: false };
      }
    },

    async assemble({ sessionId, messages }) {
      const lastUserMsg = [...messages]
        .reverse()
        .find((m) => m.role === "user" || m.type === "user");

      if (!lastUserMsg?.content) {
        return { messages, estimatedTokens: 0 };
      }

      try {
        const results = await hostedSearch(
          config,
          lastUserMsg.content,
          searchLimit,
          minScore
        );

        if (!results.length) {
          return { messages, estimatedTokens: 0 };
        }

        const memoryText = results
          .map(
            (m) =>
              `- [${Math.round((m.similarity || 0) * 100)}%] ${m.content}`
          )
          .join("\n");

        const addition = `[Memory] Relevant context from past conversations:\n${memoryText}`;

        log(`[memory] Assembled ${results.length} memories via TES`);

        return {
          messages,
          estimatedTokens: Math.ceil(addition.length / 4),
          systemPromptAddition: addition,
        };
      } catch (err) {
        log(`[memory] Hosted assemble failed: ${err.message}`);
        return { messages, estimatedTokens: 0 };
      }
    },

    async compact() {
      return { ok: true, compacted: false };
    },

    async afterTurn() {},
  };
}

// --- Telemetry ---

function emitTelemetry(mode) {
  if (process.env.PENTATONIC_TELEMETRY === "0") return;
  const raw = `${process.env.USER || "u"}:${process.platform}:${process.arch}`;
  let h = 0;
  for (let i = 0; i < raw.length; i++)
    h = ((h << 5) - h + raw.charCodeAt(i)) | 0;
  const mid = (h >>> 0).toString(16).padStart(8, "0");
  fetch(TELEMETRY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      machine_id: mid,
      sdk_version: "0.4.0",
      node_version: process.version,
      platform: process.platform,
      arch: process.arch,
      mode: `openclaw-${mode}`,
    }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => {});
}

// --- Plugin entry ---

export default {
  id: "pentatonic-memory",
  name: "Pentatonic Memory",
  description:
    "Persistent, searchable memory with multi-signal retrieval and HyDE query expansion",
  kind: "context-engine",

  register(api) {
    const config = api.config || {};
    const hosted = isHostedMode(config);
    const log = (msg) =>
      process.stderr.write(`[pentatonic-memory] ${msg}\n`);

    emitTelemetry(hosted ? "hosted" : "local");

    if (hosted) {
      // --- Hosted mode: TES GraphQL ---
      log("Hosted mode — routing through TES");

      api.registerContextEngine(
        "pentatonic-memory",
        () =>
          createHostedContextEngine(config, {
            searchLimit: config.search_limit || 5,
            minScore: config.min_score || 0.3,
            logger: log,
          })
      );

      api.registerTool({
        name: "memory_search",
        description:
          "Search memories for relevant context. Use when you need to recall past conversations, decisions, or knowledge.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "What to search for" },
            limit: { type: "number", description: "Max results (default 5)" },
          },
          required: ["query"],
        },
        async execute({ query, limit }) {
          const results = await hostedSearch(config, query, limit || 5, 0.3);
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
            content: { type: "string", description: "What to remember" },
          },
          required: ["content"],
        },
        async execute({ content }) {
          const result = await hostedStore(config, content, {
            source: "openclaw-tool",
          });
          return result ? "Memory stored." : "Failed to store memory.";
        },
      });
    } else {
      // --- Local mode: direct PostgreSQL ---
      const mem = getLocalMemory(config);
      log("Local mode — direct PostgreSQL");

      mem.migrate().then(() => {
        mem.ensureLayers(config.client_id || "default");
        log("Migrations applied, layers ready");
      });

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

      api.registerTool({
        name: "memory_search",
        description:
          "Search memories for relevant context. Use when you need to recall past conversations, decisions, or knowledge.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "What to search for" },
            limit: { type: "number", description: "Max results (default 5)" },
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
            content: { type: "string", description: "What to remember" },
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
        name: "memory_layers",
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
    }

    log(`Plugin registered (${hosted ? "hosted" : "local"} mode)`);
  },
};
