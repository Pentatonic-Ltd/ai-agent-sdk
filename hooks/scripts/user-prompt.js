#!/usr/bin/env node

/**
 * UserPromptSubmit hook — records the user's message in turn state.
 */

import { readTurnState, writeTurnState, readStdin } from "./shared.js";

function main() {
  const input = readStdin();
  const sessionId = input.session_id;
  if (!sessionId) process.exit(0);

  const state = readTurnState(sessionId);
  state.user_message = input.prompt;
  state.turn_start = Date.now();
  state.tool_calls = []; // Reset tool calls for this turn
  writeTurnState(sessionId, state);
}

main();
