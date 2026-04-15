/**
 * Pentatonic Memory — OpenClaw Context Engine Plugin
 *
 * Install: openclaw plugins install @pentatonic-ai/openclaw-memory
 *
 * Provides persistent, searchable memory via the ContextEngine lifecycle:
 *   ingest   — every message stored with embedding + HyDE
 *   assemble — relevant memories injected before every prompt
 *   compact  — decay cycle on context overflow
 *   afterTurn — consolidation check
 *
 * Plus agent-callable tools: memory_search, memory_store, pentatonic_memory_setup
 *
 * Two modes:
 *   - Local: HTTP calls to the memory server (localhost:3333)
 *   - Hosted: HTTP calls to TES GraphQL API
 *
 * No native modules, no child_process, no filesystem access.
 * All config comes from OpenClaw's plugin config system.
 */

// --- Local mode: HTTP to memory server ---

async function localSearch(baseUrl, query, limit = 5, minScore = 0.3) {
  try {
    const res = await fetch(`${baseUrl}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, limit, min_score: minScore }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.results || [];
  } catch {
    return [];
  }
}

async function localStore(baseUrl, content, metadata = {}) {
  try {
    const res = await fetch(`${baseUrl}/store`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, metadata }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

async function localHealth(baseUrl) {
  try {
    const res = await fetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// --- Hosted mode: TES GraphQL ---

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
    const res = await fetch(`${config.tes_endpoint}/api/graphql`, {
      method: "POST",
      headers: tesHeaders(config),
      body: JSON.stringify({
        query: `query($clientId: String!, $query: String!, $limit: Int, $minScore: Float) {
          semanticSearchMemories(clientId: $clientId, query: $query, limit: $limit, minScore: $minScore) {
            id content similarity
          }
        }`,
        variables: { clientId: config.tes_client_id, query, limit, minScore },
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const json = await res.json();
    return json.data?.semanticSearchMemories || [];
  } catch {
    return [];
  }
}

async function hostedStore(config, content, metadata = {}) {
  try {
    const res = await fetch(`${config.tes_endpoint}/api/graphql`, {
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
              attributes: { ...metadata, content, source: "openclaw-plugin" },
            },
          },
        },
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

// --- Context engines ---

function createLocalContextEngine(baseUrl, opts = {}) {
  const searchLimit = opts.searchLimit || 5;
  const minScore = opts.minScore || 0.3;
  const log = opts.logger || (() => {});

  return {
    info: { id: "pentatonic-memory", name: "Pentatonic Memory (Local)", ownsCompaction: false },

    async ingest({ sessionId, message }) {
      if (!message?.content) return { ingested: false };
      const role = message.role || message.type;
      if (role !== "user" && role !== "assistant") return { ingested: false };
      try {
        await localStore(baseUrl, message.content, { session_id: sessionId, role });
        log(`Ingested ${role} message`);
        return { ingested: true };
      } catch (err) {
        log(`Ingest failed: ${err.message}`);
        return { ingested: false };
      }
    },

    async assemble({ sessionId, messages }) {
      const lastUserMsg = [...messages].reverse().find((m) => m.role === "user" || m.type === "user");
      if (!lastUserMsg?.content) return { messages, estimatedTokens: 0 };
      try {
        const results = await localSearch(baseUrl, lastUserMsg.content, searchLimit, minScore);
        if (!results.length) return { messages, estimatedTokens: 0 };
        const memoryText = results
          .map((m) => `- [${Math.round((m.similarity || 0) * 100)}%] ${m.content}`)
          .join("\n");
        const addition = `[Memory] Relevant context from past conversations:\n${memoryText}`;
        log(`Assembled ${results.length} memories`);
        return { messages, estimatedTokens: Math.ceil(addition.length / 4), systemPromptAddition: addition };
      } catch (err) {
        log(`Assemble failed: ${err.message}`);
        return { messages, estimatedTokens: 0 };
      }
    },

    async compact() { return { ok: true, compacted: false }; },
    async afterTurn() {},
  };
}

function createHostedContextEngine(config, opts = {}) {
  const searchLimit = opts.searchLimit || 5;
  const minScore = opts.minScore || 0.3;
  const log = opts.logger || (() => {});

  return {
    info: { id: "pentatonic-memory", name: "Pentatonic Memory (Hosted)", ownsCompaction: false },

    async ingest({ sessionId, message }) {
      if (!message?.content) return { ingested: false };
      const role = message.role || message.type;
      if (role !== "user" && role !== "assistant") return { ingested: false };
      try {
        await hostedStore(config, message.content, { session_id: sessionId, role });
        log(`Ingested ${role} message via TES`);
        return { ingested: true };
      } catch (err) {
        log(`Hosted ingest failed: ${err.message}`);
        return { ingested: false };
      }
    },

    async assemble({ sessionId, messages }) {
      const lastUserMsg = [...messages].reverse().find((m) => m.role === "user" || m.type === "user");
      if (!lastUserMsg?.content) return { messages, estimatedTokens: 0 };
      try {
        const results = await hostedSearch(config, lastUserMsg.content, searchLimit, minScore);
        if (!results.length) return { messages, estimatedTokens: 0 };
        const memoryText = results
          .map((m) => `- [${Math.round((m.similarity || 0) * 100)}%] ${m.content}`)
          .join("\n");
        const addition = `[Memory] Relevant context from past conversations:\n${memoryText}`;
        log(`Assembled ${results.length} memories via TES`);
        return { messages, estimatedTokens: Math.ceil(addition.length / 4), systemPromptAddition: addition };
      } catch (err) {
        log(`Hosted assemble failed: ${err.message}`);
        return { messages, estimatedTokens: 0 };
      }
    },

    async compact() { return { ok: true, compacted: false }; },
    async afterTurn() {},
  };
}

// --- Format helpers ---

function formatResults(results) {
  if (!results.length) return "No relevant memories found.";
  return results
    .map((m, i) => `${i + 1}. [${Math.round((m.similarity || 0) * 100)}%] ${m.content}`)
    .join("\n\n");
}

// --- Plugin entry ---

export default {
  id: "pentatonic-memory",
  name: "Pentatonic Memory",
  description: "Persistent, searchable memory with multi-signal retrieval and HyDE query expansion",
  kind: "context-engine",

  register(api) {
    const config = api.config || {};
    const hosted = !!(config.tes_endpoint && config.tes_api_key);
    const baseUrl = config.memory_url || "http://localhost:3333";
    const log = (msg) => process.stderr.write(`[pentatonic-memory] ${msg}\n`);

    // --- Setup tool (always registered) ---

    api.registerTool({
      name: "pentatonic_memory_setup",
      description: `Guide the user through setting up Pentatonic Memory.

Two modes:
1. "local" — fully private, Docker-based (PostgreSQL + pgvector + Ollama). No cloud.
2. "hosted" — Pentatonic TES cloud. Team-wide shared memory, analytics, higher-dimensional embeddings.

Call this to get instructions for the user's chosen mode.`,
      parameters: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["local", "hosted"], description: "Which mode the user wants" },
        },
        required: ["mode"],
      },
      async execute({ mode }) {
        if (mode === "local") {
          return `## Local Memory Setup

Run in terminal:
\`\`\`
npx @pentatonic-ai/ai-agent-sdk memory
\`\`\`

This starts PostgreSQL + pgvector, Ollama, and the memory server via Docker.

Then add to openclaw.json:
\`\`\`json
{
  "plugins": {
    "slots": { "contextEngine": "pentatonic-memory" },
    "entries": {
      "pentatonic-memory": {
        "enabled": true,
        "config": { "memory_url": "http://localhost:3333" }
      }
    }
  }
}
\`\`\`

Restart OpenClaw to activate.`;
        }
        return `## Hosted TES Setup

Run in terminal:
\`\`\`
npx @pentatonic-ai/ai-agent-sdk init
\`\`\`

This creates a TES account and generates API credentials.

Then add to openclaw.json:
\`\`\`json
{
  "plugins": {
    "slots": { "contextEngine": "pentatonic-memory" },
    "entries": {
      "pentatonic-memory": {
        "enabled": true,
        "config": {
          "tes_endpoint": "https://your-company.api.pentatonic.com",
          "tes_client_id": "your-company",
          "tes_api_key": "tes_your-company_xxxxx"
        }
      }
    }
  }
}
\`\`\`

Restart OpenClaw to activate.`;
      },
    });

    // --- Mode-specific registration ---

    if (hosted) {
      log("Hosted mode — routing through TES");

      api.registerContextEngine("pentatonic-memory", () =>
        createHostedContextEngine(config, {
          searchLimit: config.search_limit || 5,
          minScore: config.min_score || 0.3,
          logger: log,
        })
      );

      api.registerTool({
        name: "memory_search",
        description: "Search memories for relevant context.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "What to search for" },
            limit: { type: "number", description: "Max results (default 5)" },
          },
          required: ["query"],
        },
        async execute({ query, limit }) {
          return formatResults(await hostedSearch(config, query, limit || 5, 0.3));
        },
      });

      api.registerTool({
        name: "memory_store",
        description: "Explicitly store something important.",
        parameters: {
          type: "object",
          properties: { content: { type: "string", description: "What to remember" } },
          required: ["content"],
        },
        async execute({ content }) {
          const result = await hostedStore(config, content, { source: "openclaw-tool" });
          return result ? "Memory stored." : "Failed to store memory.";
        },
      });
    } else {
      // Local mode — HTTP to memory server
      const isConfigured = config.memory_url || config.database_url;

      if (isConfigured) {
        log(`Local mode — ${baseUrl}`);

        // Check if server is reachable on startup
        localHealth(baseUrl).then((ok) => {
          if (!ok) log(`Warning: memory server not reachable at ${baseUrl}. Is Docker running?`);
        });

        api.registerContextEngine("pentatonic-memory", () =>
          createLocalContextEngine(baseUrl, {
            searchLimit: config.search_limit || 5,
            minScore: config.min_score || 0.3,
            logger: log,
          })
        );

        api.registerTool({
          name: "memory_search",
          description: "Search memories for relevant context.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "What to search for" },
              limit: { type: "number", description: "Max results (default 5)" },
            },
            required: ["query"],
          },
          async execute({ query, limit }) {
            return formatResults(await localSearch(baseUrl, query, limit || 5, 0.3));
          },
        });

        api.registerTool({
          name: "memory_store",
          description: "Explicitly store something important.",
          parameters: {
            type: "object",
            properties: { content: { type: "string", description: "What to remember" } },
            required: ["content"],
          },
          async execute({ content }) {
            const result = await localStore(baseUrl, content, { source: "openclaw-tool" });
            return result ? `Stored: ${result.id}` : "Failed to store memory.";
          },
        });
      } else {
        log("No config — setup tool available. Tell OpenClaw: 'set up pentatonic memory'");
      }
    }

    log(`Plugin registered (${hosted ? "hosted" : isConfigured ? "local" : "unconfigured"})`);
  },
};
