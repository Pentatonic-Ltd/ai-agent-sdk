#!/usr/bin/env node

/**
 * Stop hook — stores the conversation turn as a memory and emits
 * analytics events (hosted mode only).
 *
 * Works with both hosted TES and local @pentatonic/memory.
 */

import { readFileSync } from "fs";
import {
  loadConfig,
  emitModuleEvent,
  storeMemory,
  readTurnState,
  writeTurnState,
  readStdin,
} from "./shared.js";

async function main() {
  const config = loadConfig();
  if (!config) process.exit(0);

  // Need either hosted config or local mode
  if (config.mode !== "local" && (!config.tes_endpoint || !config.tes_api_key)) {
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
      for (let i = lines.length - 1; i >= Math.max(0, lines.length - 20); i--) {
        try {
          const entry = JSON.parse(lines[i]);
          if (entry.type === "assistant" && entry.message?.usage) {
            const u = entry.message.usage;
            usage = {
              input_tokens: u.input_tokens || 0,
              output_tokens: u.output_tokens || 0,
              cache_read_input_tokens: u.cache_read_input_tokens || 0,
              cache_creation_input_tokens: u.cache_creation_input_tokens || 0,
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

  // Store the conversation turn as a memory
  const userMsg = state.user_message;
  const assistantMsg = input.last_assistant_message;

  if (userMsg || assistantMsg) {
    const content = [
      userMsg ? `User: ${userMsg}` : "",
      assistantMsg ? `Assistant: ${assistantMsg}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    try {
      await storeMemory(config, content, {
        session_id: sessionId,
        turn_number: turnNumber,
        tool_calls: state.tool_calls?.length || 0,
        model,
      });
    } catch {
      // Non-fatal
    }
  }

  // Emit analytics event (hosted mode only — local mode has no analytics)
  if (config.mode !== "local") {
    try {
      await emitModuleEvent(config, "conversation-analytics", "CHAT_TURN", sessionId, {
        turn_number: turnNumber,
        user_message: userMsg,
        assistant_response: assistantMsg,
        tool_calls: state.tool_calls?.length ? state.tool_calls : undefined,
        duration_ms: durationMs,
        cwd: input.cwd,
        usage,
        model,
      });
    } catch {
      // Non-fatal
    }
  }

  // Increment turn number, clear turn-specific data
  writeTurnState(sessionId, {
    tool_calls: [],
    turn_number: turnNumber + 1,
    session_start: state.session_start,
    total_tool_calls: (state.total_tool_calls || 0) + (state.tool_calls?.length || 0),
    total_turns: turnNumber + 1,
  });
}

main();
