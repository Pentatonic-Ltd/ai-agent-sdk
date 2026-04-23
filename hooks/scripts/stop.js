#!/usr/bin/env node

/**
 * Stop hook — finalizes a user turn.
 *
 * Two responsibilities:
 *   1. Footer enforcement (hybrid mechanism for memory-retrieval turns):
 *      If memories were injected this turn but the last assistant
 *      message doesn't end with the "🧠 Matched N memories" footer,
 *      return decision:"block" to force Claude to append it. Capped at
 *      one retry per turn to prevent loops.
 *   2. Turn finalization: store the turn as a memory, emit analytics,
 *      reset turn state. Runs only on the *last* Stop of the turn —
 *      after the retry completes, so the stored content includes the
 *      footer Claude appended.
 *
 * Works with both hosted TES and local memory system.
 */

import { readFileSync } from "fs";
import {
  loadConfig,
  emitModuleEvent,
  storeMemory,
  readTurnState,
  writeTurnState,
  readStdin,
  checkFooterRetry,
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

  // --- Footer enforcement (retry path) ---
  //
  // If memories were retrieved this turn and Claude's last message
  // doesn't include the footer, force a continuation with decision:block.
  // We bail BEFORE finalizing the turn so the retry captures the footer
  // in the stored memory / CHAT_TURN event.
  // The `reason` field of decision:"block" is rendered to the user as a
  // "Stop hook error" block in Claude Code — so we use IT as the footer
  // display channel directly. Decision:"block" does force a continuation,
  // but the reason guides Claude to emit nothing of substance on it.
  //
  // The retry attempt counter still matters: it prevents this hook from
  // displaying the footer on every subsequent Stop-hook invocation inside
  // the same user turn.
  const retry = checkFooterRetry(state, config, input.last_assistant_message);
  if (retry) {
    state.footer_retry_attempts = retry.nextAttempts;
    writeTurnState(sessionId, state);
    process.stdout.write(
      JSON.stringify({
        decision: "block",
        reason: retry.footer,
      })
    );
    return;
  }

  // --- Turn finalization ---

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

  // Increment turn number, clear turn-specific data (including
  // memories_retrieved + footer_retry_attempts — user-prompt.js resets
  // them at the start of the next turn too, but we also clear here).
  writeTurnState(sessionId, {
    tool_calls: [],
    turn_number: turnNumber + 1,
    session_start: state.session_start,
    total_tool_calls: (state.total_tool_calls || 0) + (state.tool_calls?.length || 0),
    total_turns: turnNumber + 1,
  });
}

main();
