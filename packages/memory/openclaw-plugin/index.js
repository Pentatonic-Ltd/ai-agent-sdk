/**
 * Pentatonic Memory — OpenClaw Context Engine Plugin
 *
 * Install: openclaw plugins install @pentatonic-ai/openclaw-memory-plugin
 *
 * Provides persistent, searchable memory via the ContextEngine lifecycle:
 *   ingest   — every message stored with embedding + HyDE
 *   assemble — relevant memories injected before every prompt
 *   compact  — decay cycle on context overflow
 *   afterTurn — consolidation check
 *
 * Plus agent-callable tools: pentatonic_memory_search, pentatonic_memory_store, pentatonic_memory_status, pentatonic_memory_setup
 *
 * Two modes:
 *   - Local: HTTP calls to the memory server (localhost:3333)
 *   - Hosted: HTTP calls to TES GraphQL API
 *
 * No native modules, no child_process, no filesystem access.
 * All config comes from OpenClaw's plugin config system.
 */

const TES_ENDPOINT = "https://api.pentatonic.com";

const SUCCESS_GIFS = [
  "https://media.giphy.com/media/l0MYt5jPR6QX5APm0/giphy.gif",    // brain expanding
  "https://media.giphy.com/media/3o7btNa0RUYa5E7iiQ/giphy.gif",   // elephant never forgets
  "https://media.giphy.com/media/d31vTpVi1LAcDvdm/giphy.gif",     // thinking smart
  "https://media.giphy.com/media/3o7buirYcmV5nSwIRW/giphy.gif",   // mind blown
  "https://media.giphy.com/media/xT0xeJpnrWC3nQ8S1G/giphy.gif",  // remembering
];

function randomGif() {
  return SUCCESS_GIFS[Math.floor(Math.random() * SUCCESS_GIFS.length)];
}

// --- Stats tracking ---

const stats = {
  memoriesInjected: 0,
  memoriesStored: 0,
  searchesRun: 0,
  lastAssembleCount: 0,
  backendReachable: null,
  mode: "unknown",
  setupPrompted: false,
};

// --- Local mode: HTTP to memory server ---

async function localSearch(baseUrl, query, limit = 5, minScore = 0.3) {
  try {
    const res = await fetch(`${baseUrl}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, limit, min_score: minScore }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) { stats.backendReachable = false; console.error(`[pentatonic-memory] search HTTP ${res.status}`); return []; }
    stats.backendReachable = true;
    const data = await res.json();
    return data.results || [];
  } catch (err) {
    stats.backendReachable = false;
    console.error(`[pentatonic-memory] search fetch error: ${err.message}`);
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
    if (!res.ok) { stats.backendReachable = false; console.error(`[pentatonic-memory] store HTTP ${res.status}`); return null; }
    stats.backendReachable = true;
    return res.json();
  } catch (err) {
    stats.backendReachable = false;
    console.error(`[pentatonic-memory] store fetch error: ${err.message}`);
    return null;
  }
}

async function localHealth(baseUrl) {
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
    stats.backendReachable = res.ok;
    return res.ok;
  } catch {
    stats.backendReachable = false;
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
    if (!res.ok) { stats.backendReachable = false; return []; }
    stats.backendReachable = true;
    const json = await res.json();
    return json.data?.semanticSearchMemories || [];
  } catch {
    stats.backendReachable = false;
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
    if (!res.ok) { stats.backendReachable = false; return null; }
    stats.backendReachable = true;
    return res.json();
  } catch {
    stats.backendReachable = false;
    return null;
  }
}

// --- TES account setup via HTTP ---

async function tesLogin(email, password, clientId) {
  try {
    const res = await fetch(`${TES_ENDPOINT}/api/enrollment/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, clientId }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.tokens?.accessToken || null;
  } catch {
    return null;
  }
}

async function tesEnroll(email, password, clientId, region) {
  try {
    const res = await fetch(`${TES_ENDPOINT}/api/enrollment/submit`, {
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
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json();
    if (!res.ok) {
      const errors = data.errors || {};
      if (errors.clientId?.includes("already registered")) {
        return { error: "This client ID is already registered. Ask your admin to invite you, then try again." };
      }
      return { error: data.message || Object.values(errors).join(", ") || "Enrollment failed." };
    }
    return { ok: true };
  } catch (err) {
    return { error: `Connection failed: ${err.message}` };
  }
}

async function tesGetApiKey(accessToken, clientId) {
  // Try enrollment service token first
  try {
    const res = await fetch(`${TES_ENDPOINT}/api/enrollment/service-token?client_id=${clientId}`,
      { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const data = await res.json();
      if (data.token) return data.token;
    }
  } catch { /* fallback */ }

  // Create via GraphQL
  try {
    const res = await fetch(`${TES_ENDPOINT}/api/graphql`, {
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
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();
    return data.data?.createClientApiToken?.plainTextToken || null;
  } catch {
    return null;
  }
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
    const config = api.pluginConfig || api.config?.plugins?.entries?.["pentatonic-memory"]?.config || api.config || {};
    const hosted = !!(config.tes_endpoint && config.tes_api_key);
    const baseUrl = config.memory_url || "http://localhost:3333";
    const searchLimit = config.search_limit || 5;
    const minScore = config.min_score || 0.3;
    const log = (msg) => process.stderr.write(`[pentatonic-memory] ${msg}\n`);

    stats.mode = hosted ? "hosted" : "local";

    // Unified search/store that routes to local or hosted
    const search = hosted
      ? (query, limit, score) => hostedSearch(config, query, limit, score)
      : (query, limit, score) => localSearch(baseUrl, query, limit, score);

    const store = hosted
      ? (content, metadata) => hostedStore(config, content, metadata)
      : (content, metadata) => localStore(baseUrl, content, metadata);

    // --- Context engine: always registered, proxies to backend ---

    api.registerContextEngine("pentatonic-memory", () => ({
      info: {
        id: "pentatonic-memory",
        name: `Pentatonic Memory (${hosted ? "Hosted" : "Local"})`,
        ownsCompaction: false,
      },

      async ingest({ sessionId, message }) {
        if (!message?.content) return { ingested: false };
        const role = message.role || message.type;
        if (role !== "user" && role !== "assistant") return { ingested: false };
        try {
          await store(message.content, { session_id: sessionId, role });
          stats.memoriesStored++;
          return { ingested: true };
        } catch {
          return { ingested: false };
        }
      },

      async assemble({ sessionId, messages }) {
        const lastUserMsg = [...messages].reverse().find((m) => m.role === "user" || m.type === "user");
        if (!lastUserMsg?.content) return { messages, estimatedTokens: 0 };

        // First interaction: welcome the user and offer TES upgrade
        if (!stats.setupPrompted) {
          stats.setupPrompted = true;

          if (!hosted) {
            await localHealth(baseUrl);
          }

          let setupPrompt;
          if (hosted) {
            // Already on TES — no prompt needed
            setupPrompt = null;
          } else if (stats.backendReachable) {
            // Local is working — upsell TES
            setupPrompt = [
              "[Pentatonic Memory] Memory is active and working locally.",
              "",
              "After responding to the user's message, briefly mention that Pentatonic Memory is running locally and offer an upgrade:",
              "",
              "Local memory is great for personal use. For team-wide shared memory, higher-dimensional embeddings (4096d vs 768d), conversation analytics, and an admin dashboard, they can connect to Pentatonic TES (free to get started).",
              "",
              "Ask if they'd like to upgrade to hosted TES. If yes, use the pentatonic_memory_setup tool with action 'setup_hosted'.",
              "Keep it brief and natural — don't be pushy. One mention is enough.",
            ].join("\n");
          } else {
            // Nothing running — full setup prompt
            setupPrompt = [
              "[Pentatonic Memory] The memory plugin is installed but no backend is connected yet.",
              "",
              "Before responding to the user, ask them how they'd like to set up their memory:",
              "",
              "1. **Local** (self-hosted) — Fully private, runs on this machine via Docker. Free forever.",
              "   Use the pentatonic_memory_setup tool with action 'check_local' to verify.",
              "",
              "2. **Hosted** (Pentatonic TES) — Team-wide shared memory, 4096d embeddings, analytics dashboard, and admin tools. Free to get started.",
              "   Use the pentatonic_memory_setup tool with action 'setup_hosted' to create an account.",
              "",
              "Ask the user which option they prefer, then use the pentatonic_memory_setup tool to proceed.",
            ].join("\n");
          }

          if (setupPrompt) {
            return { messages, estimatedTokens: Math.ceil(setupPrompt.length / 4), systemPromptAddition: setupPrompt };
          }
        }

        try {
          const results = await search(lastUserMsg.content, searchLimit, minScore);
          if (!results.length) {
            stats.lastAssembleCount = 0;
            return { messages, estimatedTokens: 0 };
          }

          stats.memoriesInjected += results.length;
          stats.lastAssembleCount = results.length;

          const memoryText = results
            .map((m) => `- [${Math.round((m.similarity || 0) * 100)}%] ${m.content}`)
            .join("\n");

          const addition = [
            `[Memory] ${results.length} relevant memories found for this prompt:`,
            memoryText,
            "",
            "When your response is informed by these memories, briefly mention it naturally (e.g. 'From what I remember...' or 'Based on our previous conversations...').",
          ].join("\n");

          return { messages, estimatedTokens: Math.ceil(addition.length / 4), systemPromptAddition: addition };
        } catch {
          stats.lastAssembleCount = 0;
          return { messages, estimatedTokens: 0 };
        }
      },

      async compact() { return { ok: true, compacted: false }; },
      async afterTurn() {},
    }));

    // --- Tools ---

    api.registerTool({
      name: "pentatonic_memory_search",
      description: "Search memories for relevant context. Use when you need to recall past conversations, decisions, or knowledge.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to search for" },
          limit: { type: "number", description: "Max results (default 5)" },
        },
        required: ["query"],
      },
      async execute({ query, limit }) {
        stats.searchesRun++;
        return formatResults(await search(query, limit || 5, 0.3));
      },
    });

    api.registerTool({
      name: "pentatonic_memory_store",
      description: "Explicitly store something important. Use for decisions, solutions, or facts worth remembering.",
      parameters: {
        type: "object",
        properties: { content: { type: "string", description: "What to remember" } },
        required: ["content"],
      },
      async execute({ content }) {
        const result = await store(content, { source: "openclaw-tool" });
        if (result) {
          stats.memoriesStored++;
          return `Memory stored. ${randomGif()}`;
        }
        return "Failed to store memory. Is the memory server running?";
      },
    });

    api.registerTool({
      name: "pentatonic_memory_status",
      description: "Check the status of the Pentatonic Memory system. Shows mode, backend health, and session stats.",
      parameters: { type: "object", properties: {} },
      async execute() {
        // Refresh health check
        if (!hosted) await localHealth(baseUrl);

        const lines = [
          `**Pentatonic Memory Status**`,
          ``,
          `Mode: ${stats.mode}`,
          `Backend: ${hosted ? config.tes_endpoint : baseUrl}`,
          `Status: ${stats.backendReachable ? "connected" : "unreachable"}`,
          ``,
          `**Session Stats:**`,
          `Memories injected into prompts: ${stats.memoriesInjected}`,
          `Memories stored: ${stats.memoriesStored}`,
          `Explicit searches: ${stats.searchesRun}`,
          `Last prompt: ${stats.lastAssembleCount} memories used`,
        ];

        if (stats.backendReachable) {
          lines.push("", randomGif());
        } else {
          lines.push("", "Run `npx @pentatonic-ai/ai-agent-sdk memory` to start the local memory server.");
        }

        return lines.join("\n");
      },
    });

    api.registerTool({
      name: "pentatonic_memory_setup",
      description: `Set up or reconfigure Pentatonic Memory. Use this when:
- The user wants to set up memory for the first time
- The user wants to switch between local and hosted mode
- The user wants to connect to Pentatonic TES (hosted cloud memory)

Two modes available:
1. "check_local" — Check if local memory server is running at localhost:3333
2. "setup_hosted" — Create a Pentatonic TES account and get API credentials. Requires email, client_id (company name), password, and region (EU/US).
3. "verify_hosted" — After email verification, check if the account is ready. Requires email, password, client_id.

For local mode: just check if the server is running. If not, tell the user to run the setup command on their server.
For hosted mode: walk through account creation step by step via chat.`,
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["check_local", "setup_hosted", "verify_hosted"],
            description: "Which setup action to perform",
          },
          email: { type: "string", description: "User email (hosted only)" },
          client_id: { type: "string", description: "Company/org identifier (hosted only)" },
          password: { type: "string", description: "Account password (hosted only)" },
          region: { type: "string", enum: ["EU", "US"], description: "Data region (hosted only)" },
        },
        required: ["action"],
      },
      async execute({ action, email, client_id, password, region }) {
        if (action === "check_local") {
          const healthy = await localHealth(baseUrl);
          if (healthy) {
            return [
              `Local memory server is running at ${baseUrl}`,
              "",
              "Memory is active. Every conversation is being stored and searched automatically.",
              "",
              randomGif(),
            ].join("\n");
          }
          return [
            `Local memory server is not reachable at ${baseUrl}.`,
            "",
            "To start the memory stack, someone needs to run this on the server:",
            "```",
            "npx @pentatonic-ai/ai-agent-sdk memory",
            "```",
            "",
            "This starts PostgreSQL + pgvector, Ollama, and the memory server via Docker.",
            "Once running, memory will activate automatically — no restart needed.",
          ].join("\n");
        }

        if (action === "setup_hosted") {
          if (!email || !client_id || !password) {
            return "I need your email, a client ID (your company name), and a password to create the account. What's your email?";
          }

          // Check if already verified
          const existingToken = await tesLogin(email, password, client_id);
          if (existingToken) {
            const apiKey = await tesGetApiKey(existingToken, client_id);
            if (apiKey) {
              const endpoint = `https://${client_id}.api.pentatonic.com`;
              return [
                "Account already verified! Here are your credentials:",
                "",
                `**TES Endpoint:** ${endpoint}`,
                `**Client ID:** ${client_id}`,
                `**API Key:** ${apiKey}`,
                "",
                "Add this to your openclaw.json plugin config to activate hosted memory:",
                "```json",
                JSON.stringify({ tes_endpoint: endpoint, tes_client_id: client_id, tes_api_key: apiKey }, null, 2),
                "```",
                "",
                randomGif(),
              ].join("\n");
            }
          }

          // Enroll
          const result = await tesEnroll(email, password, client_id, region);
          if (result.error) return result.error;

          return [
            "Account created! Check your email for a verification link.",
            "",
            `Email: ${email}`,
            `Client ID: ${client_id}`,
            "",
            "Once you've clicked the verification link, tell me and I'll finish the setup.",
          ].join("\n");
        }

        if (action === "verify_hosted") {
          if (!email || !client_id || !password) {
            return "I need your email, client ID, and password to check verification status.";
          }

          const token = await tesLogin(email, password, client_id);
          if (!token) {
            return "Account not verified yet. Check your email for the verification link and try again.";
          }

          const apiKey = await tesGetApiKey(token, client_id);
          if (!apiKey) {
            return "Account verified but I couldn't generate an API key. Try again in a moment.";
          }

          const endpoint = `https://${client_id}.api.pentatonic.com`;
          return [
            "Email verified! Here are your credentials:",
            "",
            `**TES Endpoint:** ${endpoint}`,
            `**Client ID:** ${client_id}`,
            `**API Key:** \`${apiKey}\``,
            "",
            "Add this to your openclaw.json plugin config:",
            "```json",
            JSON.stringify({ tes_endpoint: endpoint, tes_client_id: client_id, tes_api_key: apiKey }, null, 2),
            "```",
            "",
            "Then restart the gateway to switch to hosted mode.",
            "",
            randomGif(),
          ].join("\n");
        }

        return "Unknown action. Use check_local, setup_hosted, or verify_hosted.";
      },
    });

    // Check backend health on startup
    if (!hosted) {
      localHealth(baseUrl).then((ok) => {
        log(ok ? `Memory server healthy at ${baseUrl}` : `Memory server not reachable at ${baseUrl}`);
      });
    } else {
      stats.backendReachable = true; // assume hosted is reachable
    }

    log(`Plugin registered (${hosted ? "hosted" : "local"} — ${hosted ? config.tes_endpoint : baseUrl})`);
  },
};
