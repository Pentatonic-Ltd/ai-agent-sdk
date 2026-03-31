#!/usr/bin/env node

/**
 * SessionStart hook — emits SESSION_START event, initializes turn state,
 * and fetches recent memories to inject as context.
 */

import { loadConfig, emitModuleEvent, writeTurnState, readStdin } from "./shared.js";

async function fetchRecentMemories(config) {
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
      query: `query($clientId: String!) {
        memories(clientId: $clientId, limit: 15) {
          id content user_id created_at
        }
      }`,
      variables: { clientId: config.tes_client_id },
    }),
  });

  if (!response.ok) return [];
  const json = await response.json();
  return json.data?.memories || [];
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

  // Fetch recent memories and inject as context
  try {
    const memories = await fetchRecentMemories(config);
    if (memories.length > 0) {
      const memoryText = memories
        .map((m) => `- ${m.content}`)
        .join("\n");

      // Output context that Claude will see at session start
      const output = JSON.stringify({
        additionalContext: `[TES Memory] Recent team knowledge (${memories.length} memories):\n${memoryText}`,
      });
      process.stdout.write(output);
    }
  } catch {
    // Non-fatal — session starts without memory context
  }
}

main();
