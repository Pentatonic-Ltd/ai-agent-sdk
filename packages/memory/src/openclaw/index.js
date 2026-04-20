/**
 * OpenClaw plugin entry point for the Pentatonic memory system.
 *
 * Supports two modes:
 *   - Local: direct PostgreSQL + pgvector (requires Docker stack)
 *   - Hosted: routes through TES GraphQL API
 *
 * Install:
 *   openclaw plugins install @pentatonic-ai/ai-agent-sdk
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

let memory = null;

function isHostedMode(config) {
  return !!(config.tes_endpoint && config.tes_api_key);
}

function getLocalMemory(config) {
  if (memory) return memory;

  if (!config.database_url) {
    throw new Error(
      "pentatonic-memory: database_url is required in plugin config for local mode. " +
      "Run `npx @pentatonic-ai/ai-agent-sdk memory` first to start the Docker stack, " +
      "then add the database_url to your openclaw.json plugin config."
    );
  }

  memory = createMemorySystem({
    db: new Pool({ connectionString: config.database_url }),
    embedding: {
      url: config.embedding_url || "http://localhost:11435/v1",
      model: config.embedding_model || "nomic-embed-text",
    },
    llm: {
      url: config.llm_url || "http://localhost:11435/v1",
      model: config.llm_model || "llama3.2:3b",
    },
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

        // Visibility footer — instruct the model to surface that memory was
        // used. Opt out via show_memory_indicator: false in plugin config.
        const showIndicator = config.show_memory_indicator !== false;
        const indicatorRule = showIndicator
          ? [
              "",
              `After your reply, on a new line, append exactly this footer (no other prefix, no trailing content):`,
              `—`,
              `🧠 _Used ${results.length} memor${results.length === 1 ? "y" : "ies"} from Pentatonic Memory_`,
              "",
              `If the memories above were not relevant to your reply, omit the footer.`,
            ].join("\n")
          : "";

        const addition = `[Memory] Relevant context from past conversations:\n${memoryText}${indicatorRule}`;

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

    // --- Setup guide tool (always registered) ---

    api.registerTool({
      name: "pentatonic_memory_setup",
      description: `Guide the user through setting up Pentatonic Memory.

Two modes available:
1. "local" — fully private, runs on user's machine via Docker (PostgreSQL + pgvector + Ollama). No cloud, no API keys. Requires Docker.
2. "hosted" — production-grade via Pentatonic TES cloud. Higher-dimensional embeddings, team-wide shared memory, analytics dashboard. Requires account creation.

Call this tool to get setup instructions for the user's chosen mode. If they haven't decided, explain both options and ask which they prefer.`,
      parameters: {
        type: "object",
        properties: {
          mode: {
            type: "string",
            enum: ["local", "hosted"],
            description: "Which mode the user wants",
          },
        },
        required: ["mode"],
      },
      async execute({ mode }) {
        if (mode === "local") {
          return `## Local Memory Setup

The user needs to run these commands in their terminal:

1. Start the memory stack:
   \`\`\`
   npx @pentatonic-ai/ai-agent-sdk memory
   \`\`\`
   This starts PostgreSQL + pgvector, Ollama, and the memory server via Docker.

2. Then add this to their openclaw.json:
   \`\`\`json
   {
     "plugins": {
       "slots": { "contextEngine": "pentatonic-memory" },
       "entries": {
         "pentatonic-memory": {
           "enabled": true,
           "config": {
             "database_url": "postgres://memory:memory@localhost:5433/memory",
             "embedding_url": "http://localhost:11435/v1",
             "embedding_model": "nomic-embed-text",
             "llm_url": "http://localhost:11435/v1",
             "llm_model": "llama3.2:3b"
           }
         }
       }
     }
   }
   \`\`\`

3. Restart OpenClaw to activate the context engine.

Tell the user to run step 1 first, then help them with the config.`;
        }

        if (mode === "hosted") {
          return `## Hosted TES Setup

The user needs to run this command in their terminal:

1. Create a TES account:
   \`\`\`
   npx @pentatonic-ai/ai-agent-sdk init
   \`\`\`
   This walks through account creation, email verification, and API key generation.
   They'll receive credentials like:
   - TES_ENDPOINT=https://their-company.api.pentatonic.com
   - TES_CLIENT_ID=their-company
   - TES_API_KEY=tes_their-company_xxxxx

2. Then add this to their openclaw.json:
   \`\`\`json
   {
     "plugins": {
       "slots": { "contextEngine": "pentatonic-memory" },
       "entries": {
         "pentatonic-memory": {
           "enabled": true,
           "config": {
             "tes_endpoint": "https://their-company.api.pentatonic.com",
             "tes_client_id": "their-company",
             "tes_api_key": "tes_their-company_xxxxx"
           }
         }
       }
     }
   }
   \`\`\`

3. Restart OpenClaw to activate the context engine.

Tell the user to run step 1 first, then help them fill in the config with the credentials they receive.`;
        }

        return "Unknown mode. Choose 'local' or 'hosted'.";
      },
    });

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
    } else if (config.database_url) {
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
    } else {
      // --- No config: setup-only mode ---
      log("No memory config found — setup tool available. Tell OpenClaw: 'set up pentatonic memory'");
    }

    log(`Plugin registered (${hosted ? "hosted" : config.database_url ? "local" : "unconfigured"} mode)`);
  },
};
