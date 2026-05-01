import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_ENGINE_URL = "http://localhost:8099";

/**
 * Top-level dispatcher for `tes config <sub>`.
 *
 * Subcommands:
 *   local  — write `mode: local` + memory_url to the plugin config; print
 *            bring-up instructions for the engine docker stack.
 *   hosted — run the SDK login flow (writes ~/.config/tes/credentials.json
 *            and updates the plugin config to hosted mode).
 *   show   — read the plugin config + credentials and print what's
 *            currently configured.
 *
 * Future:
 *   set <key> <value> — tweak engine env vars (EMBED_MODEL, EMBED_DIM, …)
 *                        and reload docker-compose.
 *
 * @param {object} opts
 * @param {string} opts.sub - subcommand name
 * @param {string} [opts.endpoint] - default TES endpoint (forwarded to login)
 * @param {string} [opts.engineUrl] - override for `local`
 * @param {string} [opts.configDir] - override config-file dir (test hook)
 * @param {Function} [opts.log]
 * @param {Function} [opts.errLog]
 */
export async function runConfigCommand(opts = {}) {
  const log = opts.log || ((m) => process.stdout.write(m + "\n"));
  const errLog = opts.errLog || ((m) => process.stderr.write(m + "\n"));
  const sub = opts.sub;

  switch (sub) {
    case "local":
      return runConfigLocal(opts);
    case "hosted":
      return runConfigHosted(opts);
    case "show":
      return runConfigShow(opts);
    case undefined:
    case "":
    case "help":
    case "--help":
    case "-h":
      printHelp(log);
      return { exitCode: sub === undefined ? 1 : 0 };
    default:
      errLog(`Unknown subcommand: ${sub}`);
      printHelp(errLog);
      return { exitCode: 2 };
  }
}

function printHelp(out) {
  out("Usage: tes config <subcommand>");
  out("");
  out("Subcommands:");
  out("  local           Point Claude Code's plugin at a local memory engine");
  out("  hosted          Sign in with TES (browser flow); writes credentials");
  out("  show            Print the current plugin config + memory backend");
  out("");
  out("Flags (subcommand-specific):");
  out("  --engine-url <url>   For 'local'; default http://localhost:8099");
}

// ----------------------------------------------------------------------
// `tes config local`
// ----------------------------------------------------------------------

async function runConfigLocal(opts) {
  const log = opts.log || ((m) => process.stdout.write(m + "\n"));
  const errLog = opts.errLog || ((m) => process.stderr.write(m + "\n"));
  const engineUrl = opts.engineUrl || DEFAULT_ENGINE_URL;

  const configDir = opts.configDir || resolveConfigDir();
  const configPath = join(configDir, "tes-memory.local.md");

  try {
    mkdirSync(configDir, { recursive: true });
  } catch (err) {
    errLog(`Error: cannot create config dir ${configDir}: ${err.message}`);
    return { exitCode: 1 };
  }

  // Preserve any existing hosted config as comments so the user can
  // flip back without re-running login.
  let preserved = "";
  if (existsSync(configPath)) {
    try {
      const fm = parseFrontmatter(readFileSync(configPath, "utf-8"));
      if (fm && fm.tes_endpoint) {
        copyFileSync(configPath, configPath + ".bak");
        preserved = formatPreservedHosted(fm);
        log(`  Existing hosted config backed up to ${configPath}.bak`);
      }
    } catch {
      // best-effort
    }
  }

  const body =
    `---\n` +
    `mode: local\n` +
    `memory_url: ${engineUrl}\n` +
    preserved +
    `---\n`;

  try {
    writeFileSync(configPath, body, { mode: 0o600 });
  } catch (err) {
    errLog(`Error: cannot write config ${configPath}: ${err.message}`);
    return { exitCode: 1 };
  }

  log("");
  log(`✓ Plugin config written: ${configPath}`);
  log(`  → Claude Code's tes-memory plugin now points at ${engineUrl}`);
  log("");
  log("Next steps to bring up the engine:");
  log("");
  log("  1. Make sure Ollama is running and bound to all interfaces");
  log("     (so docker containers can reach it via host.docker.internal):");
  log("");
  log("       sudo mkdir -p /etc/systemd/system/ollama.service.d");
  log("       echo -e '[Service]\\nEnvironment=\"OLLAMA_HOST=0.0.0.0:11434\"' \\");
  log("         | sudo tee /etc/systemd/system/ollama.service.d/override.conf");
  log("       sudo systemctl daemon-reload && sudo systemctl restart ollama");
  log("       ollama pull nomic-embed-text     # if not already pulled");
  log("");
  log("  2. Bring up the engine docker stack:");
  log("");
  log("       cd packages/memory-engine");
  log("       cp .env.example .env             # if no .env yet");
  log("       # edit .env if you want a different embedding model/dim");
  log("       docker compose up -d --scale nv-embed=0");
  log("");
  log("  3. Verify it's healthy:");
  log("");
  log(`       curl -s ${engineUrl}/health | jq`);
  log("");
  log("  4. Reload Claude Code (close + reopen, or /reload-plugins).");
  log("");
  log("     Verify with /tes-memory:tes-status — should report:");
  log("     ✓ Connected to local memory engine");
  log("");
  return { exitCode: 0, configPath };
}

// ----------------------------------------------------------------------
// `tes config hosted`
// ----------------------------------------------------------------------

async function runConfigHosted(opts) {
  const { runLoginCommand } = await import("./login.js");
  return runLoginCommand({ endpoint: opts.endpoint });
}

// ----------------------------------------------------------------------
// `tes config show`
// ----------------------------------------------------------------------

function runConfigShow(opts) {
  const log = opts.log || ((m) => process.stdout.write(m + "\n"));
  const configDir = opts.configDir || resolveConfigDir();
  const configPath = join(configDir, "tes-memory.local.md");

  log("");
  log(`Plugin config: ${configPath}`);
  if (!existsSync(configPath)) {
    log("  (file does not exist — run `tes config local` or `tes config hosted`)");
    return { exitCode: 1 };
  }

  const fm = parseFrontmatter(readFileSync(configPath, "utf-8"));
  if (!fm) {
    log("  (file exists but couldn't parse frontmatter)");
    return { exitCode: 1 };
  }

  const mode = fm.mode || (fm.tes_endpoint ? "hosted" : "?");
  log(`  Mode: ${mode}`);
  if (mode === "local") {
    log(`  memory_url: ${fm.memory_url || "(missing)"}`);
  } else if (mode === "hosted") {
    log(`  endpoint: ${fm.tes_endpoint}`);
    log(`  client_id: ${fm.tes_client_id}`);
    log(`  user_id: ${fm.tes_user_id || "(unset)"}`);
  }

  // Also surface ~/.config/tes/credentials.json if present
  const credPath = join(
    process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
    "tes",
    "credentials.json"
  );
  if (existsSync(credPath)) {
    try {
      const c = JSON.parse(readFileSync(credPath, "utf-8"));
      log("");
      log(`Credentials: ${credPath}`);
      log(`  endpoint: ${c.endpoint}`);
      log(`  clientId: ${c.clientId}`);
    } catch {
      log(`  (${credPath} unreadable)`);
    }
  }

  log("");
  return { exitCode: 0 };
}

// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------

function resolveConfigDir() {
  const candidates = [
    process.env.CLAUDE_CONFIG_DIR,
    join(homedir(), ".claude-pentatonic"),
    join(homedir(), ".claude"),
  ].filter(Boolean);
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[candidates.length - 1];
}

function parseFrontmatter(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return out;
}

function formatPreservedHosted(fm) {
  const keys = ["tes_endpoint", "tes_client_id", "tes_api_key", "tes_user_id"];
  const present = keys.filter((k) => fm[k]);
  if (!present.length) return "";
  return (
    `# Hosted config preserved — uncomment + remove the local block above\n` +
    `# to switch back. Original saved as <this-file>.bak.\n` +
    present.map((k) => `# ${k}: ${fm[k]}`).join("\n") +
    `\n`
  );
}
