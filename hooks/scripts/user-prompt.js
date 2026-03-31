#!/usr/bin/env node

/**
 * UserPromptSubmit hook — records the user's message and searches
 * for related memories to inject as context.
 */

import {
  loadConfig,
  readTurnState,
  writeTurnState,
  readStdin,
} from "./shared.js";

async function searchMemories(config, query) {
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
        semanticSearchMemories(clientId: $clientId, query: $query, limit: 5, minScore: 0.4) {
          id content similarity
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
  const input = readStdin();
  const sessionId = input.session_id;
  if (!sessionId) process.exit(0);

  const state = readTurnState(sessionId);
  state.user_message = input.prompt;
  state.turn_start = Date.now();
  state.tool_calls = [];
  writeTurnState(sessionId, state);

  // Search for memories related to the user's actual message
  const config = loadConfig();
  if (!config?.tes_endpoint || !config?.tes_api_key || !input.prompt) {
    process.exit(0);
  }

  try {
    const memories = await searchMemories(config, input.prompt);
    if (memories.length > 0) {
      const memoryText = memories
        .map((m) => `- [${Math.round(m.similarity * 100)}%] ${m.content}`)
        .join("\n");

      process.stdout.write(
        JSON.stringify({
          additionalContext: `[TES Memory] Related knowledge:\n${memoryText}`,
        })
      );
    }
  } catch {
    // Non-fatal
  }
}

main();
