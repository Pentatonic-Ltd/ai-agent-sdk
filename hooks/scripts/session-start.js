#!/usr/bin/env node

/**
 * SessionStart hook — emits SESSION_START event, initializes turn state,
 * and fetches recent memories to inject as context.
 */

import { loadConfig, emitModuleEvent, writeTurnState, readStdin } from "./shared.js";

async function searchRelatedMemories(config, query) {
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
    body: JSON.stringify({
      query: `query($clientId: String!, $query: String!) {
        semanticSearchMemories(clientId: $clientId, query: $query, limit: 10, minScore: 0.3) {
          id content similarity created_at
        }
      }`,
      variables: { clientId: config.tes_client_id, query },
    }),
  });

  if (!response.ok) return [];
  const json = await response.json();
  return json.data?.semanticSearchMemories || [];
}

async function main() {
  const config = loadConfig();
  if (!config?.tes_endpoint || !config?.tes_api_key) {
    process.exit(0);
  }

  const input = readStdin();
  const sessionId = input.session_id || `claude-code-${Date.now()}`;

  // Initialize turn state
  writeTurnState(sessionId, {
    tool_calls: [],
    turn_number: 0,
    session_start: Date.now(),
  });

  // Emit SESSION_START event (non-blocking)
  emitModuleEvent(config, "conversation-analytics", "SESSION_START", sessionId, {
    cwd: input.cwd,
    model: input.model,
  }).catch(() => {});

  // Search for memories related to the current project
  try {
    // Build search query from project directory name and context
    const cwd = input.cwd || "";
    const projectName = cwd.split("/").filter(Boolean).pop() || "";
    const query = [projectName, cwd].filter(Boolean).join(" ");

    if (query) {
      const memories = await searchRelatedMemories(config, query);
      if (memories.length > 0) {
        const memoryText = memories
          .map(
            (m) =>
              `- [${Math.round(m.similarity * 100)}%] ${m.content}`
          )
          .join("\n");

        const output = JSON.stringify({
          additionalContext: `[TES Memory] Related knowledge for this project (${memories.length} matches):\n${memoryText}`,
        });
        process.stdout.write(output);
      }
    }
  } catch {
    // Non-fatal — session starts without memory context
  }
}

main();
