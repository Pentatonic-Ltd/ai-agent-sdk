#!/usr/bin/env node

/**
 * PostToolUse hook — appends tool call to turn state AND emits per-tool
 * events so conversation-analytics can surface tool-level metrics.
 *
 * The Stop hook emits a bundled CHAT_TURN with tool_calls embedded, which
 * is good for session-level analytics but loses per-tool timing/frequency.
 * Emitting a TOOL_USE event here unlocks:
 *   - tool-frequency leaderboards
 *   - failed-tool detection (future, once we capture errors)
 *   - tool-sequence patterns per session
 *
 * We also sniff for the common "memory router" shell patterns and emit
 * MEMORY_SEARCHED / MEMORY_WRITTEN to deep-memory so operators can see
 * how often the memory layer is actually hit, separately from how often
 * tools are called at all.
 *
 * All emissions are fire-and-forget (errors swallowed) — this hook must
 * never block the user's next tool call.
 */

import {
  emitModuleEvent,
  loadConfig,
  readTurnState,
  writeTurnState,
  readStdin,
} from "./shared.js";

const FILE_WRITE_TOOLS = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "write",
  "edit",
]);

const MEMORY_PATH_FRAGS = [
  "memory/",
  "MEMORY.md",
  "SESSION-STATE.md",
  "memory/plans.md",
  "memory/daily/",
  "memory/rules/",
];

function isMemorySearch(toolName, toolInput) {
  if (toolName === "memory_search") return true;
  if (toolName !== "Bash" && toolName !== "exec") return false;
  const cmd = String(toolInput?.command ?? "");
  return (
    cmd.includes("memory-search-router.py") ||
    cmd.includes("pap-cli.sh search") ||
    (cmd.includes("hybridrag") && cmd.includes("/v1/search"))
  );
}

function isMemoryWrite(toolName, toolInput) {
  const p = String(toolInput?.file_path ?? toolInput?.path ?? "");
  if (FILE_WRITE_TOOLS.has(toolName)) {
    return MEMORY_PATH_FRAGS.some((f) => p.includes(f));
  }
  if (toolName !== "Bash" && toolName !== "exec") return false;
  const cmd = String(toolInput?.command ?? "");
  return (
    (cmd.includes("cat >") || cmd.includes("tee ")) &&
    MEMORY_PATH_FRAGS.some((f) => cmd.includes(f))
  );
}

function summarizeResult(toolResponse) {
  if (typeof toolResponse === "string") return toolResponse.slice(0, 500);
  return JSON.stringify(toolResponse ?? "").slice(0, 500);
}

async function main() {
  const input = readStdin();
  const sessionId = input.session_id;
  if (!sessionId) process.exit(0);

  // Always update turn state — even in local mode or without creds, the
  // Stop hook needs to know what tools ran this turn.
  const state = readTurnState(sessionId);
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

  // Emission path — hosted mode only, requires creds.
  const config = loadConfig();
  if (!config || config.mode === "local") return;
  if (!config.tes_endpoint || !config.tes_api_key) return;

  // Fire all emissions in parallel — none of them block each other, and
  // the whole hook has a 3-second timeout upstream.
  const emissions = [
    emitModuleEvent(config, "conversation-analytics", "TOOL_USE", sessionId, {
      tool: input.tool_name,
      description,
      args: toolInput,
      tool_use_id: input.tool_use_id,
      result_summary: summarizeResult(input.tool_response),
    }),
  ];

  if (isMemorySearch(input.tool_name, toolInput)) {
    const cmd = String(toolInput?.command ?? "");
    const m = cmd.match(
      /memory-search-router\.py\s+['"]?([^'"&|;\n]{3,})['"]?/
    );
    emissions.push(
      emitModuleEvent(config, "deep-memory", "MEMORY_SEARCHED", sessionId, {
        tool: input.tool_name,
        query: (m?.[1] ?? toolInput?.query ?? "").toString().slice(0, 200),
      })
    );
  }

  if (isMemoryWrite(input.tool_name, toolInput)) {
    const p = String(toolInput?.file_path ?? toolInput?.path ?? "");
    emissions.push(
      emitModuleEvent(config, "deep-memory", "MEMORY_WRITTEN", sessionId, {
        tool: input.tool_name,
        path: p.split("/").slice(-2).join("/"),
      })
    );
  }

  await Promise.allSettled(emissions);
}

main().catch(() => process.exit(0));
