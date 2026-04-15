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
import { execFileSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
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

// --- Setup helpers ---

function getConfigPath() {
  const candidates = [
    join(homedir(), ".openclaw", "pentatonic-memory.json"),
    join(homedir(), ".claude-pentatonic", "tes-memory.local.md"),
    join(homedir(), ".claude", "tes-memory.local.md"),
  ];
  return candidates.find((p) => existsSync(p)) || candidates[0];
}

function writeOpenClawConfig(mode, settings) {
  const configDir = join(homedir(), ".openclaw");
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });

  const configPath = join(configDir, "pentatonic-memory.json");
  writeFileSync(configPath, JSON.stringify({ mode, ...settings }, null, 2));
  return configPath;
}

async function runLocalSetup() {
  // Check Docker
  try {
    execFileSync("docker", ["info"], { stdio: "pipe" });
  } catch {
    return { success: false, error: "Docker is required but not running. Install from https://docker.com" };
  }

  // Find the memory package directory
  let memoryDir;
  try {
    const pkgRoot = new URL("../../..", import.meta.url).pathname;
    memoryDir = existsSync(join(pkgRoot, "docker-compose.yml"))
      ? pkgRoot
      : null;
  } catch { memoryDir = null; }

  if (!memoryDir) {
    // Fallback: try via npm package location
    try {
      const resolved = new URL("../../../../packages/memory", import.meta.url).pathname;
      if (existsSync(join(resolved, "docker-compose.yml"))) memoryDir = resolved;
    } catch { /* */ }
  }

  if (!memoryDir) {
    return {
      success: false,
      error: "Could not find memory package. Run: npx @pentatonic-ai/ai-agent-sdk memory",
    };
  }

  // Start Docker stack
  try {
    execFileSync("docker", ["compose", "up", "-d", "memory", "postgres", "ollama"], {
      cwd: memoryDir,
      stdio: "pipe",
    });
  } catch (err) {
    return { success: false, error: `Docker compose failed: ${err.message}` };
  }

  // Pull models
  const embModel = process.env.EMBEDDING_MODEL || "nomic-embed-text";
  const llmModel = process.env.LLM_MODEL || "llama3.2:3b";
  const pulled = [];
  for (const model of [embModel, llmModel]) {
    try {
      execFileSync("docker", ["compose", "exec", "ollama", "ollama", "pull", model], {
        cwd: memoryDir,
        stdio: "pipe",
      });
      pulled.push(model);
    } catch { /* non-fatal */ }
  }

  const configPath = writeOpenClawConfig("local", {
    memory_url: "http://localhost:3333",
  });

  return {
    success: true,
    mode: "local",
    configPath,
    models: pulled,
    message: "Local memory stack running. PostgreSQL + pgvector + Ollama + memory server started.",
  };
}

async function runHostedSetup(email, clientId, password, region) {
  const endpoint = "https://api.pentatonic.com";

  // Try login first
  let accessToken = null;
  try {
    const res = await fetch(`${endpoint}/api/enrollment/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, clientId }),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.tokens?.accessToken) accessToken = data.tokens.accessToken;
    }
  } catch { /* */ }

  // If not logged in, enroll
  if (!accessToken) {
    try {
      const res = await fetch(`${endpoint}/api/enrollment/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId,
          companyName: clientId,
          industryType: "technology",
          authProvider: "native",
          adminEmail: email,
          adminPassword: password,
          region: (region || "eu").toLowerCase(),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        const errors = data.errors || {};
        if (errors.clientId?.includes("already registered")) {
          return { success: false, error: "Client ID already registered. Ask your admin to invite you, then run setup again." };
        }
        return { success: false, error: data.message || Object.values(errors).join(", ") || "Enrollment failed" };
      }
    } catch (err) {
      return { success: false, error: `Failed to connect: ${err.message}` };
    }

    // Poll for verification (up to 5 minutes)
    const start = Date.now();
    while (Date.now() - start < 300000) {
      await new Promise((r) => setTimeout(r, 3000));
      try {
        const res = await fetch(`${endpoint}/api/enrollment/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password, clientId }),
        });
        if (res.ok) {
          const data = await res.json();
          if (data.tokens?.accessToken) {
            accessToken = data.tokens.accessToken;
            break;
          }
        }
      } catch { /* keep polling */ }
    }

    if (!accessToken) {
      return { success: false, error: "Email verification timed out. Check your inbox and run setup again — it will resume." };
    }
  }

  // Get API key
  let apiKey;
  try {
    const tokenRes = await fetch(`${endpoint}/api/enrollment/service-token?client_id=${clientId}`);
    if (tokenRes.ok) {
      const tokenData = await tokenRes.json();
      if (tokenData.token) apiKey = tokenData.token;
    }
  } catch { /* */ }

  if (!apiKey) {
    try {
      const res = await fetch(`${endpoint}/api/graphql`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          query: `mutation CreateApiToken($clientId: String!, $input: CreateApiTokenInput!) {
            createClientApiToken(clientId: $clientId, input: $input) { success plainTextToken }
          }`,
          variables: { clientId, input: { name: "openclaw-plugin", role: "agent-events" } },
        }),
      });
      const data = await res.json();
      apiKey = data.data?.createClientApiToken?.plainTextToken;
    } catch { /* */ }
  }

  if (!apiKey) {
    return { success: false, error: "Account verified but failed to generate API key. Run setup again." };
  }

  const clientEndpoint = `https://${clientId}.api.pentatonic.com`;
  const configPath = writeOpenClawConfig("hosted", {
    tes_endpoint: clientEndpoint,
    tes_client_id: clientId,
    tes_api_key: apiKey,
  });

  return {
    success: true,
    mode: "hosted",
    configPath,
    endpoint: clientEndpoint,
    clientId,
    message: "TES account ready. Memory will be stored and searched via Pentatonic cloud.",
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

    emitTelemetry(hosted ? "hosted" : "local");

    // --- Setup tool (always registered) ---

    api.registerTool({
      name: "pentatonic_memory_setup",
      description: `Set up Pentatonic Memory for this user. Call this when the user wants to set up memory, or when the plugin has no config yet.

Two modes available:
1. "local" — fully private, runs on user's machine via Docker (PostgreSQL + pgvector + Ollama). No cloud, no API keys. Requires Docker.
2. "hosted" — production-grade via Pentatonic TES cloud. Higher-dimensional embeddings, team-wide shared memory, analytics dashboard. Requires account creation.

For local mode: call with action="setup_local". No other params needed.
For hosted mode: ask the user for their email, a client ID (company name), password, and region (EU or US), then call with action="setup_hosted" and those params.

If the user hasn't decided, explain both options and ask which they prefer.`,
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["setup_local", "setup_hosted"],
            description: "Which setup to run",
          },
          email: { type: "string", description: "User email (hosted only)" },
          client_id: { type: "string", description: "Company/org identifier (hosted only)" },
          password: { type: "string", description: "Account password (hosted only)" },
          region: { type: "string", enum: ["EU", "US"], description: "Data region (hosted only)" },
        },
        required: ["action"],
      },
      async execute({ action, email, client_id, password, region }) {
        if (action === "setup_local") {
          return JSON.stringify(await runLocalSetup());
        }
        if (action === "setup_hosted") {
          if (!email || !client_id || !password) {
            return JSON.stringify({
              success: false,
              error: "Missing required fields: email, client_id, and password are all required for hosted setup.",
            });
          }
          return JSON.stringify(await runHostedSetup(email, client_id, password, region));
        }
        return JSON.stringify({ success: false, error: "Unknown action" });
      },
    });

    // --- CLI subcommand ---

    if (api.registerCli) {
      api.registerCli(
        async ({ program }) => {
          program
            .command("pentatonic-memory")
            .description("Set up Pentatonic Memory (local or hosted)")
            .argument("[mode]", "Setup mode: local or hosted")
            .action(async (mode) => {
              if (mode === "local") {
                console.log("\nSetting up local memory stack...\n");
                const result = await runLocalSetup();
                if (result.success) {
                  console.log(`✓ ${result.message}`);
                  console.log(`  Config: ${result.configPath}`);
                  console.log(`  Models: ${result.models.join(", ")}\n`);
                  console.log("Restart OpenClaw to activate the context engine.\n");
                } else {
                  console.error(`✗ ${result.error}\n`);
                  process.exit(1);
                }
              } else if (mode === "hosted") {
                console.log("\nHosted setup — use the interactive agent instead:");
                console.log('  Tell OpenClaw: "set up pentatonic memory"\n');
              } else {
                console.log("\nPentatonic Memory Setup\n");
                console.log("  openclaw pentatonic-memory local    Set up local memory (Docker)");
                console.log("  openclaw pentatonic-memory hosted   Set up hosted TES (cloud)\n");
                console.log('Or just tell OpenClaw: "set up pentatonic memory"\n');
              }
            });
        },
        {
          descriptors: [
            {
              name: "pentatonic-memory",
              description: "Set up Pentatonic Memory (local Docker stack or hosted TES cloud)",
              hasSubcommands: false,
            },
          ],
        }
      );
    }

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
