#!/usr/bin/env node

/**
 * Stop hook — emits CHAT_TURN event with accumulated turn data.
 */

import { readFileSync } from "fs";
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

  // Extract token usage from transcript (last API response entry)
  let usage = undefined;
  let model = undefined;
  if (input.transcript_path) {
    try {
      const transcript = readFileSync(input.transcript_path, "utf-8");
      const lines = transcript.trim().split("\n");
      // Walk backwards to find the last assistant message with usage
      for (let i = lines.length - 1; i >= Math.max(0, lines.length - 20); i--) {
        try {
          const entry = JSON.parse(lines[i]);
          if (entry.type === "assistant" && entry.message?.usage) {
            usage = {
              input_tokens: entry.message.usage.input_tokens,
              output_tokens: entry.message.usage.output_tokens,
            };
            model = entry.message.model;
            break;
          }
        } catch {
          // Skip malformed lines
        }
      }
    } catch {
      // Transcript not readable — non-fatal
    }
  }

  try {
    await emitModuleEvent(config, "conversation-analytics", "CHAT_TURN", sessionId, {
      turn_number: turnNumber,
      user_message: state.user_message,
      assistant_response: input.last_assistant_message,
      tool_calls: state.tool_calls.length ? state.tool_calls : undefined,
      duration_ms: durationMs,
      cwd: input.cwd,
      usage,
      model,
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
