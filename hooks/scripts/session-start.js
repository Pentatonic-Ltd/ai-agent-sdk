#!/usr/bin/env node

/**
 * SessionStart hook — emits SESSION_START event and initializes turn state.
 */

import {
  loadConfig,
  emitModuleEvent,
  writeTurnState,
  readStdin,
} from "./shared.js";

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

  try {
    await emitModuleEvent(
      config,
      "conversation-analytics",
      "SESSION_START",
      sessionId,
      {
        cwd: input.cwd,
        model: input.model,
      }
    );
  } catch {
    // Non-fatal
  }
}

main();
