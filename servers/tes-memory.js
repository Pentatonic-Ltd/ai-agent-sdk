#!/usr/bin/env node

/**
 * TES Memory MCP Server
 *
 * Provides tools for searching and storing memories via the
 * Pentatonic TES deep-memory module GraphQL API.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// --- Config ---

function loadConfig() {
  // Check common Claude Code config locations (supports aliased installs)
  const candidates = [
    join(homedir(), ".claude", "tes-memory.local.md"),
    join(homedir(), ".claude-pentatonic", "tes-memory.local.md"),
  ];
  // Also check CLAUDE_CONFIG_DIR env var if set
  if (process.env.CLAUDE_CONFIG_DIR) {
    candidates.unshift(join(process.env.CLAUDE_CONFIG_DIR, "tes-memory.local.md"));
  }
  const configPath = candidates.find((p) => existsSync(p));
  if (!configPath) {
    return null;
  }

  const content = readFileSync(configPath, "utf-8");
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) return null;

  const config = {};
  for (const line of frontmatterMatch[1].split("\n")) {
    const [key, ...rest] = line.split(":");
    if (key && rest.length) {
      config[key.trim()] = rest.join(":").trim();
    }
  }
  return config;
}

async function graphql(config, query, variables = {}) {
  const headers = {
    "Content-Type": "application/json",
    "x-client-id": config.tes_client_id,
  };

  if (config.tes_api_key.startsWith("tes_")) {
    headers["Authorization"] = `Bearer ${config.tes_api_key}`;
  } else {
    headers["x-service-key"] = config.tes_api_key;
  }

  const response = await fetch(`${config.tes_endpoint}/api/graphql`, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`TES API error: ${response.status}`);
  }

  const json = await response.json();
  if (json.errors?.length) {
    throw new Error(`TES GraphQL error: ${json.errors[0].message}`);
  }

  return json.data;
}

// --- Server ---

const server = new Server(
  { name: "tes-memory", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "search_memories",
      description:
        "Search the team's shared knowledge bank for relevant memories. " +
        "Use this when you need context about past conversations, decisions, " +
        "debugging sessions, or anything the team has worked on before. " +
        "Supports semantic search (finds conceptually related content, not just keyword matches).",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "What to search for — can be a question, topic, or description",
          },
          userId: {
            type: "string",
            description: "Optional: filter to a specific user's memories",
          },
          limit: {
            type: "number",
            description: "Maximum number of results (default: 10)",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "store_memory",
      description:
        "Explicitly store something important in the team's knowledge bank. " +
        "Use this for decisions, architectural choices, debugging solutions, " +
        "or anything that would be valuable to remember in future sessions.",
      inputSchema: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "The memory content to store",
          },
          metadata: {
            type: "object",
            description: "Optional metadata (e.g., { topic: 'auth', type: 'decision' })",
          },
        },
        required: ["content"],
      },
    },
    {
      name: "list_memory_layers",
      description:
        "List the memory layers and their stats (episodic, semantic, procedural, working). " +
        "Shows how many memories are in each layer and their capacity.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const config = loadConfig();
  if (!config?.tes_endpoint || !config?.tes_api_key || !config?.tes_client_id) {
    return {
      content: [
        {
          type: "text",
          text: "TES memory is not configured. Run /tes-setup to connect your account.",
        },
      ],
    };
  }

  const { name, arguments: args } = request.params;

  try {
    if (name === "search_memories") {
      const data = await graphql(
        config,
        `query($clientId: String!, $query: String!, $userId: String, $limit: Int, $minScore: Float) {
          semanticSearchMemories(clientId: $clientId, query: $query, userId: $userId, limit: $limit, minScore: $minScore) {
            id user_id content confidence similarity created_at
          }
        }`,
        {
          clientId: config.tes_client_id,
          query: args.query,
          userId: args.userId || undefined,
          limit: args.limit || 10,
          minScore: 0.3,
        }
      );

      const memories = data.semanticSearchMemories || [];
      if (!memories.length) {
        return {
          content: [{ type: "text", text: `No memories found for: "${args.query}"` }],
        };
      }

      const formatted = memories
        .map(
          (m, i) =>
            `${i + 1}. [${Math.round(m.similarity * 100)}% match] ${m.content}` +
            (m.user_id ? ` (by ${m.user_id})` : "") +
            ` — ${new Date(m.created_at).toLocaleDateString()}`
        )
        .join("\n\n");

      return {
        content: [
          {
            type: "text",
            text: `Found ${memories.length} relevant memories:\n\n${formatted}`,
          },
        ],
      };
    }

    if (name === "store_memory") {
      // Get the episodic layer ID first
      const layerData = await graphql(
        config,
        `query($clientId: String!) {
          memoryLayers(clientId: $clientId) { id name layer_type }
        }`,
        { clientId: config.tes_client_id }
      );

      const episodic = (layerData.memoryLayers || []).find(
        (l) => l.layer_type === "episodic"
      );
      if (!episodic) {
        return {
          content: [{ type: "text", text: "No episodic memory layer found. The deep-memory module may not be enabled." }],
        };
      }

      const meta = {
        ...(args.metadata || {}),
        source: "claude-code-plugin",
        user_id: config.tes_user_id || undefined,
      };

      const data = await graphql(
        config,
        `mutation($clientId: String!, $layerId: String!, $content: String!, $metadata: JSON) {
          createMemory(clientId: $clientId, layerId: $layerId, content: $content, metadata: $metadata) {
            id content confidence created_at
          }
        }`,
        {
          clientId: config.tes_client_id,
          layerId: episodic.id,
          content: args.content,
          metadata: meta,
        }
      );

      const mem = data.createMemory;
      return {
        content: [
          {
            type: "text",
            text: `Stored memory (${mem.id}): "${mem.content.substring(0, 100)}..."`,
          },
        ],
      };
    }

    if (name === "list_memory_layers") {
      const data = await graphql(
        config,
        `query($clientId: String!) {
          memoryLayers(clientId: $clientId) {
            id name layer_type capacity is_active memory_count
          }
        }`,
        { clientId: config.tes_client_id }
      );

      const layers = data.memoryLayers || [];
      if (!layers.length) {
        return {
          content: [{ type: "text", text: "No memory layers found. The deep-memory module may not be enabled." }],
        };
      }

      const formatted = layers
        .map(
          (l) =>
            `${l.layer_type}: ${l.memory_count || 0}/${l.capacity || "unlimited"} memories` +
            (l.is_active ? "" : " (inactive)")
        )
        .join("\n");

      return {
        content: [{ type: "text", text: `Memory layers:\n${formatted}` }],
      };
    }

    return { content: [{ type: "text", text: `Unknown tool: ${name}` }] };
  } catch (error) {
    return {
      content: [{ type: "text", text: `TES error: ${error.message}` }],
    };
  }
});

// --- Start ---

const transport = new StdioServerTransport();
await server.connect(transport);
