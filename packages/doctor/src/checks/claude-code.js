/**
 * Claude Code plugin installation check.
 *
 * The SDK ships a Claude Code plugin (`tes-memory@pentatonic-ai`) that
 * wires UserPromptSubmit / Stop hooks so CHAT_TURN + MEMORY_CREATED
 * events actually get emitted. It's entirely possible for the server
 * side to be healthy (TES reachable, key valid) while the client side
 * is silently uninstalled — the hooks never fire and the event stream
 * stays empty. This check tells users whether the plugin is present
 * and what version they're on, so upstream feedback ("why am I not
 * seeing memories?") lands faster.
 *
 * The check is universal-ish: it only reports positively when the
 * plugin file is found. If the user isn't on Claude Code at all, the
 * plugin absence is reported as info, not a failure.
 */

import { existsSync as realExistsSync, readFileSync as realReadFileSync } from "fs";
import { join } from "path";
import { homedir as realHomedir } from "os";

import { SEVERITY } from "../index.js";

const CLAUDE_PLUGIN_PATH = [
  ".claude",
  "plugins",
  "marketplaces",
  "pentatonic-ai",
  ".claude-plugin",
  "plugin.json",
];

function checkClaudeCodePluginInstalled({ fileExists, readFile, homedir } = {}) {
  const exists = fileExists || realExistsSync;
  const read = readFile || ((p) => realReadFileSync(p, "utf8"));
  const resolveHome = typeof homedir === "function" ? homedir : realHomedir;
  const home = resolveHome();

  return {
    name: "tes-memory Claude Code plugin installed",
    severity: SEVERITY.INFO,
    run: async () => {
      const manifestPath = join(home, ...CLAUDE_PLUGIN_PATH);
      if (!exists(manifestPath)) {
        return {
          ok: false,
          msg: "tes-memory plugin not found — run: /plugin marketplace add Pentatonic-Ltd/ai-agent-sdk && /plugin install tes-memory@pentatonic-ai",
          detail: { path: manifestPath },
        };
      }
      try {
        const manifest = JSON.parse(read(manifestPath));
        const version = typeof manifest.version === "string" ? manifest.version : "?";
        const name = typeof manifest.name === "string" ? manifest.name : "tes-memory";
        return {
          ok: true,
          msg: `${name} v${version} installed`,
          detail: { name, version, path: manifestPath },
        };
      } catch (err) {
        return {
          ok: false,
          msg: `plugin manifest unreadable: ${err.message}`,
          detail: { path: manifestPath },
        };
      }
    },
  };
}

export function claudeCodeChecks(seams = {}) {
  return [checkClaudeCodePluginInstalled(seams)];
}
