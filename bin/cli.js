#!/usr/bin/env node

import { createInterface } from "readline";
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const DEFAULT_ENDPOINT = "https://api.pentatonic.com";

function parseArgs() {
  const args = process.argv.slice(2);
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--endpoint" && args[i + 1]) {
      flags.endpoint = args[++i];
    } else if (a.startsWith("--endpoint=")) {
      flags.endpoint = a.split("=")[1];
    } else if (a === "--path" && args[i + 1]) {
      flags.path = args[++i];
    } else if (a.startsWith("--path=")) {
      flags.path = a.split("=")[1];
    } else if (a === "--timeout" && args[i + 1]) {
      flags.timeout = parseInt(args[++i], 10);
    } else if (a.startsWith("--timeout=")) {
      flags.timeout = parseInt(a.split("=")[1], 10);
    } else if (a === "--json") {
      flags.json = true;
    } else if (a === "--alert") {
      flags.alert = true;
    } else if (a === "--no-plugins") {
      flags.noPlugins = true;
    } else if (a === "--local") {
      flags.local = true;
    } else if (a === "--remote") {
      flags.remote = true;
    } else if (!a.startsWith("--")) {
      // First non-flag arg is the command; subsequent ones are subcommand
      // arguments handled by the dispatched cmd (e.g. `ingest <path>`).
      if (!flags.command) flags.command = a;
    }
  }
  return flags;
}

async function runDoctorCommand(flags) {
  // Lazy-load to keep doctor's pg dep optional for users who only run
  // `npx ai-agent-sdk init` or `memory`.
  const { runDoctor, renderHuman, renderJson } = await import(
    "../packages/doctor/src/index.js"
  );

  const report = await runDoctor({
    path: flags.path || "auto",
    plugins: !flags.noPlugins,
    timeoutMs: flags.timeout,
  });

  const hasIssues = report.summary.warning + report.summary.critical > 0;
  if (flags.alert && !hasIssues) return 0;

  if (flags.json) {
    process.stdout.write(renderJson(report) + "\n");
  } else {
    process.stdout.write(renderHuman(report) + "\n");
  }

  if (report.summary.critical > 0) return 2;
  if (report.summary.warning > 0) return 1;
  return 0;
}

let rl = createInterface({ input: process.stdin, output: process.stdout });

function ask(question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

function spinner(text) {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const id = setInterval(() => {
    process.stdout.write(`\r${frames[i++ % frames.length]} ${text}`);
  }, 80);
  return {
    stop(result) {
      clearInterval(id);
      process.stdout.write(`\r✓ ${result}\n`);
    },
    fail(msg) {
      clearInterval(id);
      process.stdout.write(`\r✗ ${msg}\n`);
    },
  };
}

async function setupLocalMemory() {
  console.log(`\n  Local Memory Setup\n`);

  // Check Docker
  try {
    execFileSync("docker", ["info"], { stdio: "pipe" });
  } catch {
    console.error("  Error: Docker is required. Install it from https://docker.com\n");
    process.exit(1);
  }

  const memoryDir = new URL("../packages/memory", import.meta.url).pathname;

  // Start infrastructure + memory server
  const infraSpinner = spinner("Starting memory server + PostgreSQL + Ollama...");
  try {
    execFileSync("docker", ["compose", "up", "-d", "memory", "postgres", "ollama"], {
      cwd: memoryDir,
      stdio: "pipe",
    });
    infraSpinner.stop("Memory stack running!");
  } catch (err) {
    infraSpinner.fail(`Failed to start: ${err.message}`);
    process.exit(1);
  }

  // Pull models
  const embModel = process.env.EMBEDDING_MODEL || "nomic-embed-text";
  const llmModel = process.env.LLM_MODEL || "llama3.2:3b";

  const embSpinner = spinner(`Pulling ${embModel}...`);
  try {
    execFileSync("docker", ["compose", "exec", "ollama", "ollama", "pull", embModel], {
      cwd: memoryDir,
      stdio: "pipe",
    });
    embSpinner.stop(`${embModel} ready!`);
  } catch {
    embSpinner.fail(`Failed to pull ${embModel}. Run manually: docker compose exec ollama ollama pull ${embModel}`);
  }

  const llmSpinner = spinner(`Pulling ${llmModel}...`);
  try {
    execFileSync("docker", ["compose", "exec", "ollama", "ollama", "pull", llmModel], {
      cwd: memoryDir,
      stdio: "pipe",
    });
    llmSpinner.stop(`${llmModel} ready!`);
  } catch {
    llmSpinner.fail(`Failed to pull ${llmModel}. Run manually: docker compose exec ollama ollama pull ${llmModel}`);
  }

  // Write local config (warn if hosted config exists)
  const configDir = join(homedir(), ".claude-pentatonic");
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  const configPath = join(configDir, "tes-memory.local.md");
  if (existsSync(configPath)) {
    const existing = readFileSync(configPath, "utf-8");
    if (existing.includes("tes_endpoint") && !existing.includes("mode: local")) {
      console.log("\n  ⚠ Hosted TES config detected. Switching to local mode will");
      console.log("  disable hosted memory. To restore, run: npx @pentatonic-ai/ai-agent-sdk init\n");
      const confirm = await ask("  Switch to local mode? (y/n): ");
      if (confirm.toLowerCase() !== "y") {
        console.log("  Cancelled. Hosted config unchanged.\n");
        rl.close();
        return;
      }
    }
  }

  writeFileSync(
    configPath,
    `---
mode: local
memory_url: http://localhost:3333
---
`
  );

  console.log(`\n  Config written to ${configPath}`);

  const sdkDir = new URL("..", import.meta.url).pathname;

  console.log(`
  Memory server: http://localhost:3333
  Hooks are auto-configured to use local memory.

  Install the plugin in Claude Code:
    /plugin marketplace add Pentatonic-Ltd/ai-agent-sdk
    /plugin install tes-memory@pentatonic-ai

  You're ready! Every prompt auto-searches memory,
  every turn auto-stores. No MCP setup needed.
`);

  rl.close();
}


async function main() {
  const flags = parseArgs();
  const TES_ENDPOINT = flags.endpoint || DEFAULT_ENDPOINT;

  if (flags.command === "doctor") {
    const code = await runDoctorCommand(flags);
    rl.close();
    process.exit(code);
  }

  // SDK login (browser-based OAuth) — replaces the old in-terminal
  // setupHostedTes flow. `login` opens api.pentatonic.com/cli-init in
  // a browser, listens on localhost for the OAuth callback, exchanges
  // for an access token, mints a long-lived tes_* via createClientApiToken,
  // writes ~/.config/tes/credentials.json. `init` is kept as a one-major
  // alias (Task 10).
  if (flags.command === "login") {
    const { runLoginCommand } = await import("./commands/login.js");
    const { exitCode } = await runLoginCommand({
      endpoint: TES_ENDPOINT,
    });
    rl.close();
    process.exit(exitCode);
  }

  // SDK login identity check. Named `whoami` rather than `status`
  // because the corpus subcommand `tes status` already exists (shows
  // tracked repos). Matches the standard CLI convention for "who am
  // I logged in as" and avoids the conflict.
  if (flags.command === "whoami") {
    const { runWhoamiCommand } = await import("./commands/whoami.js");
    const { exitCode } = await runWhoamiCommand();
    rl.close();
    process.exit(exitCode);
  }

  // `memory` is kept as a shortcut to skip the local-or-remote question
  // for users with that command in scripts/docs. New users should use init.
  if (flags.command === "memory") {
    await setupLocalMemory();
    return;
  }

  // Corpus subcommands — onboarding/repo ingest (spec 01)
  const CORPUS_COMMANDS = new Set([
    "onboard", "ingest", "status", "resync", "corpus",
    "install-git-hook", "ingest-paths",
  ]);
  if (CORPUS_COMMANDS.has(flags.command)) {
    const corpusCli = await import("../packages/memory/src/corpus/cli.js");
    const subArgs = process.argv.slice(2).filter((a) => a !== flags.command);
    const ctx = { ask, close: () => rl.close() };
    let code = 0;
    try {
      switch (flags.command) {
        case "onboard": code = await corpusCli.cmdOnboard(subArgs, ctx); break;
        case "ingest": code = await corpusCli.cmdIngest(subArgs); break;
        case "status": code = await corpusCli.cmdStatus(); break;
        case "resync": code = await corpusCli.cmdResync(subArgs); break;
        case "corpus": code = await corpusCli.cmdCorpus(subArgs, ctx); break;
        case "install-git-hook": code = await corpusCli.cmdInstallGitHook(); break;
        case "ingest-paths": code = await corpusCli.cmdIngestPaths(subArgs); break;
      }
    } catch (err) {
      process.stderr.write(`Error: ${err.message}\n`);
      code = 2;
    }
    rl.close();
    process.exit(code);
  }

  if (flags.command !== "init") {
    console.log(`
@pentatonic-ai/ai-agent-sdk

Usage:
  npx @pentatonic-ai/ai-agent-sdk login                   Sign in with TES (browser-based OAuth)
  npx @pentatonic-ai/ai-agent-sdk whoami                  Show current login identity
  npx @pentatonic-ai/ai-agent-sdk init                    [deprecated] Alias for 'login'
  npx @pentatonic-ai/ai-agent-sdk init --local            Set up local Docker memory stack
  npx @pentatonic-ai/ai-agent-sdk memory                  Shortcut for 'init --local'
  npx @pentatonic-ai/ai-agent-sdk doctor                  Run health checks (exit 0/1/2)

Memory corpus (onboarding):
  npx @pentatonic-ai/ai-agent-sdk onboard                 Interactive: pick paths, ingest, install hooks
  npx @pentatonic-ai/ai-agent-sdk ingest <path>           One-shot ingest of a path (any folder works)
  npx @pentatonic-ai/ai-agent-sdk status                  Show tracked paths and corpus stats
  npx @pentatonic-ai/ai-agent-sdk resync [<path>]         Delta-sync (or all tracked paths)
  npx @pentatonic-ai/ai-agent-sdk corpus list             List tracked paths
  npx @pentatonic-ai/ai-agent-sdk corpus remove <path>    Stop tracking a path
  npx @pentatonic-ai/ai-agent-sdk corpus reset            Wipe local corpus state
  npx @pentatonic-ai/ai-agent-sdk install-git-hook        Install post-commit hook in cwd

Tenant for corpus commands is read from these env vars:
  TES_ENDPOINT, TES_CLIENT_ID, TES_API_KEY

doctor flags:
  --json                  Emit a JSON report
  --alert                 Suppress output when all green
  --no-plugins            Skip ~/.config/pentatonic-ai/doctor-plugins/*
  --path local|hosted|platform|auto
  --timeout <ms>          Per-check timeout (default 10000)

For docs, see https://api.pentatonic.com
    `);
    process.exit(0);
  }

  // init: --local still routes to setupLocalMemory (Docker stack —
  // separate concern). Anything else (no flag, --remote, mode prompt)
  // delegates to login via runInitAlias which emits a one-line
  // deprecation warning. setupHostedTes (the old form-based hosted
  // flow) is gone; init has been replaced by `login` for one major
  // release, then `init` itself goes away.
  if (flags.local && flags.remote) {
    console.error("\n  Error: --local and --remote are mutually exclusive\n");
    process.exit(1);
  }
  if (flags.local) {
    await setupLocalMemory();
    return;
  }
  // Non-local path → login alias.
  const { runInitAlias } = await import("./commands/login.js");
  const { exitCode } = await runInitAlias({
    endpoint: TES_ENDPOINT,
  });
  rl.close();
  process.exit(exitCode);
}

main().catch((err) => {
  console.error(`\n  Error: ${err.message}\n`);
  process.exit(1);
});
