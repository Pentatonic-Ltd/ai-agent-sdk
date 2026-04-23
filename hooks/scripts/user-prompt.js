#!/usr/bin/env node

/**
 * UserPromptSubmit hook — searches for related memories
 * and injects them as context for the current prompt.
 *
 * Works with both hosted TES and local memory system.
 */

import {
  loadConfig,
  readTurnState,
  writeTurnState,
  readStdin,
  searchMemories,
  buildMemoryContext,
  writeSessionMemoriesToAutoMemory,
} from "./shared.js";

async function main() {
  const input = readStdin();
  const sessionId = input.session_id;
  if (!sessionId) process.exit(0);

  const state = readTurnState(sessionId);
  state.user_message = input.prompt;
  state.turn_start = Date.now();
  state.tool_calls = [];
  state.memories_retrieved = 0;
  writeTurnState(sessionId, state);

  const config = loadConfig();
  if (!config || !input.prompt) process.exit(0);

  // Need either hosted config or local mode
  if (config.mode !== "local" && (!config.tes_endpoint || !config.tes_api_key)) {
    process.exit(0);
  }

  try {
    const memories = await searchMemories(config, input.prompt);
    // Record the count so the Stop hook can emit the "Matched N" footer
    // deterministically, without relying on the model to follow an
    // injected instruction that can get buried in a long context.
    state.memories_retrieved = memories.length;
    writeTurnState(sessionId, state);

    // Write into Claude Code's auto-memory directory so the model reads
    // these as its own trusted memory (via MEMORY.md auto-load), rather
    // than as "additional notes" that get frequently ignored. Best-
    // effort — never blocks the hook.
    if (memories.length > 0) {
      try {
        writeSessionMemoriesToAutoMemory(input.cwd, input.prompt, memories);
      } catch {
        // Non-fatal
      }
    }

    if (memories.length > 0) {
      process.stdout.write(
        JSON.stringify({
          additionalContext: buildMemoryContext(config, memories),
        })
      );
    }
  } catch {
    // Non-fatal
  }
}

main();
