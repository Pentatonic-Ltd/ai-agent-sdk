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

  // Build a descriptive tool summary
  const toolInput = input.tool_input || {};
  const description =
    toolInput.description ||
    toolInput.file_path ||
    toolInput.pattern ||
    toolInput.command?.substring(0, 200) ||
    undefined;

  state.tool_calls.push({
    tool: input.tool_name,
    description,
    input: toolInput,
    tool_use_id: input.tool_use_id,
  });

  writeTurnState(sessionId, state);
}

main();
