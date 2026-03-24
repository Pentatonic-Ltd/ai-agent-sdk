#!/usr/bin/env node

/**
 * Stop hook — emits CHAT_TURN event with accumulated turn data.
 */

import {
  loadConfig,
  emitModuleEvent,
  readTurnState,
  writeTurnState,
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
  const turnNumber = state.turn_number || 0;
  const durationMs = state.turn_start ? Date.now() - state.turn_start : undefined;

  try {
    await emitModuleEvent(config, "conversation-analytics", "CHAT_TURN", sessionId, {
      turn_number: turnNumber,
      user_message: state.user_message,
      assistant_response: input.last_assistant_message,
      tool_calls: state.tool_calls.length ? state.tool_calls : undefined,
      duration_ms: durationMs,
      cwd: input.cwd,
    });
  } catch {
    // Non-fatal
  }

  // Increment turn number, clear turn-specific data for next turn
  writeTurnState(sessionId, {
    tool_calls: [],
    turn_number: turnNumber + 1,
    session_start: state.session_start,
    total_tool_calls: (state.total_tool_calls || 0) + state.tool_calls.length,
    total_turns: turnNumber + 1,
  });
}

main();
