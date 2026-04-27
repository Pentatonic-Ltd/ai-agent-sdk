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
 * Resolution order mirrors `hooks/scripts/shared.js:loadConfig` — three
 * candidate roots, first match wins:
 *
 *   1. $CLAUDE_CONFIG_DIR (explicit override, highest precedence)
 *   2. ~/.claude              (default Claude Code install)
 *   3. ~/.claude-pentatonic   (Pentatonic-branded variant)
 *
 * The check is universal-ish: it only reports positively when the
 * plugin file is found. If the user isn't on Claude Code at all, the
 * plugin absence is reported as info, not a failure.
 */

import { existsSync as realExistsSync, readFileSync as realReadFileSync } from "fs";
import { join } from "path";
import { homedir as realHomedir } from "os";

import { SEVERITY } from "../index.js";

const PLUGIN_REL_PATH = [
  "plugins",
  "marketplaces",
  "pentatonic-ai",
  ".claude-plugin",
  "plugin.json",
];

/**
 * Build the ordered list of candidate manifest paths. First match wins.
 * Same precedence as the SDK hook's loadConfig() so users on
 * CLAUDE_CONFIG_DIR or .claude-pentatonic don't get false negatives.
 */
function candidateManifestPaths(home, env) {
  const roots = [];
  if (env?.CLAUDE_CONFIG_DIR) roots.push(env.CLAUDE_CONFIG_DIR);
  roots.push(join(home, ".claude"));
  roots.push(join(home, ".claude-pentatonic"));
  return roots.map((root) => join(root, ...PLUGIN_REL_PATH));
}

function checkClaudeCodePluginInstalled({
  fileExists,
  readFile,
  homedir,
  env,
} = {}) {
  const exists = fileExists || realExistsSync;
  const read = readFile || ((p) => realReadFileSync(p, "utf8"));
  const resolveHome = typeof homedir === "function" ? homedir : realHomedir;
  const resolveEnv = env || process.env;
  const home = resolveHome();

  return {
    name: "tes-memory Claude Code plugin installed",
    severity: SEVERITY.INFO,
    run: async () => {
      const candidates = candidateManifestPaths(home, resolveEnv);
      const found = candidates.find((p) => exists(p));
      if (!found) {
        return {
          ok: false,
          msg:
            "tes-memory plugin not found — run: /plugin marketplace add Pentatonic-Ltd/ai-agent-sdk && /plugin install tes-memory@pentatonic-ai",
          detail: { candidates },
        };
      }
      try {
        const manifest = JSON.parse(read(found));
        const version = typeof manifest.version === "string" ? manifest.version : "?";
        const name = typeof manifest.name === "string" ? manifest.name : "tes-memory";
        return {
          ok: true,
          msg: `${name} v${version} installed`,
          detail: { name, version, path: found },
        };
      } catch (err) {
        return {
          ok: false,
          msg: `plugin manifest unreadable: ${err.message}`,
          detail: { path: found },
        };
      }
    },
  };
}

export function claudeCodeChecks(seams = {}) {
  return [checkClaudeCodePluginInstalled(seams)];
}
