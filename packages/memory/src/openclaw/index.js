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
// VI signing — best-effort, never blocks emit. See ../../../../src/vi.js
// for the JWS spec; signed events satisfy the conversation-analytics
// dashboard's Verifiable Intent tab.
import { signForSession } from "../../../../src/vi-session.js";

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

/**
 * Emit a CHAT_TURN event to TES so the conversation-analytics dashboard
 * (Token Universe + Tools tabs) can render. Without this, the dashboard
 * filters on eventType=CHAT_TURN and shows nothing for OpenClaw users
 * because the only events emitted are STORE_MEMORY.
 *
 * Anything missing from the message metadata is omitted rather than
 * defaulted to zero — that way the dashboard can distinguish "no data"
 * from "zero usage".
 */
async function hostedEmitChatTurn(config, sessionId, turn) {
  const attributes = {
    source: "openclaw-plugin",
    user_message: turn.userMessage,
    assistant_response: turn.assistantResponse,
  };
  if (turn.model) attributes.model = turn.model;
  if (turn.usage) attributes.usage = turn.usage;
  if (turn.toolCalls?.length) attributes.tool_calls = turn.toolCalls;
  if (turn.turnNumber !== undefined) attributes.turn_number = turn.turnNumber;
  if (turn.systemPrompt) attributes.system_prompt = turn.systemPrompt;

  // VI signing — sign the attributes (the bound event body the verifier
  // hashes). Attached as attributes.vi.worker_jws to match the sidecar
  // shape verifyEventVI expects in workers/consumers/eventStorage.js.
  // Disable per-config with vi_disabled: true.
  if (config.vi_disabled !== true) {
    const jws = await signForSession(sessionId, attributes);
    if (jws) attributes.vi = { worker_jws: jws };
  }

  try {
    const response = await fetch(`${config.tes_endpoint}/api/graphql`, {
      method: "POST",
      headers: tesHeaders(config),
      // Route through createModuleEvent on the conversation-analytics
      // module rather than the top-level emitEvent. The latter requires
      // a permission most client API keys don't have ("Access denied:
      // You don't have permission to update emitEvent"), but the
      // module's manifest declares CHAT_TURN as a registered event
      // type, so the module-scoped path is both authorised and
      // consistent with how STORE_MEMORY is emitted.
      body: JSON.stringify({
        query: `mutation Cme($moduleId: String!, $input: ModuleEventInput!) {
          createModuleEvent(moduleId: $moduleId, input: $input) { success eventId }
        }`,
        variables: {
          moduleId: "conversation-analytics",
          input: {
            eventType: "CHAT_TURN",
            data: {
              entity_id: sessionId,
              attributes,
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

// Per-session turn buffer. Holds the user message until the matching
// assistant response arrives, at which point we emit a CHAT_TURN.
// Turn counter is kept in a separate map so it survives buffer clears
// between turns. Module-scoped (rather than per-engine) so multiple
// engine instances don't double-buffer the same session.
const turnBuffers = new Map(); // sessionId → { userMessage }
const turnCounters = new Map(); // sessionId → highest turn_number emitted

function _resetTurnBuffersForTest() {
  turnBuffers.clear();
  turnCounters.clear();
}
export { _resetTurnBuffersForTest };

// Pull whatever the runtime hands us. Different OpenClaw versions wrap
// provider responses differently — we look in the obvious places and
// silently omit fields we can't find. The dashboard handles undefined
// usage/tool_calls gracefully (renders "no data" rather than zeros).
function extractAssistantMetadata(message) {
  const meta = {};
  // Direct fields first (richest hook contracts)
  if (message.model) meta.model = message.model;
  if (message.usage) meta.usage = message.usage;
  if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
    meta.toolCalls = message.tool_calls;
  } else if (Array.isArray(message.toolCalls) && message.toolCalls.length) {
    meta.toolCalls = message.toolCalls;
  }
  // Fall back to a wrapped raw response if the runtime forwards it
  const raw = message.raw || message.response || message._raw;
  if (raw && typeof raw === "object") {
    if (!meta.model && raw.model) meta.model = raw.model;
    if (!meta.usage && raw.usage) meta.usage = raw.usage;
    if (!meta.toolCalls) {
      // Anthropic puts tool_use blocks in raw.content[]
      if (Array.isArray(raw.content)) {
        const tc = raw.content
          .filter((b) => b?.type === "tool_use")
          .map((b) => ({ tool: b.name, args: b.input || {} }));
        if (tc.length) meta.toolCalls = tc;
      }
      // OpenAI puts tool_calls inside choices[0].message
      if (
        !meta.toolCalls &&
        Array.isArray(raw.choices) &&
        raw.choices[0]?.message?.tool_calls
      ) {
        meta.toolCalls = raw.choices[0].message.tool_calls.map((tc) => ({
          tool: tc.function?.name || tc.name,
          args: tc.function?.arguments,
        }));
      }
    }
  }
  return meta;
}

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

      // STORE_MEMORY for retrieval (existing behaviour — unchanged).
      try {
        await hostedStore(config, message.content, {
          session_id: sessionId,
          role,
        });
        log(`[memory] Ingested ${role} message via TES`);
      } catch (err) {
        log(`[memory] Hosted ingest failed: ${err.message}`);
      }

      // CHAT_TURN buffering for analytics. We pair each user message with
      // the next assistant message in the same session and emit on the
      // assistant turn. This is what populates the conversation-analytics
      // Token Universe + Tools tabs.
      try {
        if (role === "user") {
          turnBuffers.set(sessionId, {
            userMessage: String(message.content),
          });
        } else if (role === "assistant") {
          const buf = turnBuffers.get(sessionId);
          const turnNumber = (turnCounters.get(sessionId) || 0) + 1;
          turnCounters.set(sessionId, turnNumber);
          // Even with no buffered user message we still emit, so an
          // assistant-only event isn't dropped — it just renders without
          // a prompt half.
          const meta = extractAssistantMetadata(message);
          await hostedEmitChatTurn(config, sessionId, {
            userMessage: buf?.userMessage,
            assistantResponse: String(message.content),
            turnNumber,
            ...meta,
          });
          turnBuffers.delete(sessionId);
          log(
            `[memory] Emitted CHAT_TURN${meta.usage ? " w/ usage" : ""}${meta.toolCalls?.length ? ` w/ ${meta.toolCalls.length} tool_calls` : ""}`
          );
        }
      } catch (err) {
        log(`[memory] CHAT_TURN emit failed: ${err.message}`);
      }

      return { ingested: true };
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
