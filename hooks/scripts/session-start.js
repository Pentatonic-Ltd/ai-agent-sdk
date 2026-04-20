#!/usr/bin/env node

/**
 * SessionStart hook — emits SESSION_START event and initializes turn state.
 */

import {
  loadConfig,
  emitModuleEvent,
  writeTurnState,
  readStdin,
  checkLocalServerVersion,
} from "./shared.js";

async function main() {
  const config = loadConfig();
  if (!config) process.exit(0);

  const input = readStdin();
  const sessionId = input.session_id || `claude-code-${Date.now()}`;

  // Initialize turn state
  writeTurnState(sessionId, {
    tool_calls: [],
    turn_number: 0,
    session_start: Date.now(),
  });

  // Local mode: verify memory server version is new enough and warn if not.
  // Plugin updates don't update the Dockerised memory server — users need
  // to re-run `npx @pentatonic-ai/ai-agent-sdk@latest memory` separately.
  if (config.mode === "local") {
    await checkLocalServerVersion(config);
    return;
  }

  // Hosted mode: emit SESSION_START for analytics.
  if (!config.tes_endpoint || !config.tes_api_key) process.exit(0);

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
