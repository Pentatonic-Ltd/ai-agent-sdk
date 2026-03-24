#!/usr/bin/env node

/**
 * PostToolUse hook — appends tool call to turn state.
 */

import { readTurnState, writeTurnState, readStdin } from "./shared.js";

function main() {
  const input = readStdin();
  const sessionId = input.session_id;
  if (!sessionId) process.exit(0);

  const state = readTurnState(sessionId);

  state.tool_calls.push({
    tool: input.tool_name,
    input: input.tool_input,
    tool_use_id: input.tool_use_id,
  });

  writeTurnState(sessionId, state);
}

main();
