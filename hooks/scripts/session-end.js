#!/usr/bin/env node

/**
 * SessionEnd hook — emits SESSION_END summary and cleans up turn state.
 */

import {
  loadConfig,
  emitModuleEvent,
  readTurnState,
  clearTurnState,
  readStdin,
} from "./shared.js";

async function main() {
  const config = loadConfig();
  if (!config?.tes_endpoint || !config?.tes_api_key) {
    process.exit(0);
  }

  const input = readStdin();
  const sessionId = input.session_id;
  if (!sessionId) process.exit(0);

  const state = readTurnState(sessionId);
  const durationMs = state.session_start
    ? Date.now() - state.session_start
    : undefined;

  try {
    await emitModuleEvent(config, "conversation-analytics", "SESSION_END", sessionId, {
      reason: input.reason,
      total_turns: state.total_turns || 0,
      total_tool_calls: state.total_tool_calls || 0,
      duration_ms: durationMs,
      cwd: input.cwd,
    });
  } catch {
    // Non-fatal
  }

  clearTurnState(sessionId);
}

main();
