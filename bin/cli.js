#!/usr/bin/env node

import { createInterface } from "readline";

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
    } else if (a === "--engine-url" && args[i + 1]) {
      flags.engineUrl = args[++i];
    } else if (a.startsWith("--engine-url=")) {
      flags.engineUrl = a.split("=")[1];
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

// setupLocalMemory + its `spinner` helper were the legacy "bring up
// Postgres + Ollama" wrapper for the in-process memory server. Removed
// in favour of:
//   - `tes config local`  → writes the plugin config + prints engine
//                           bring-up instructions
//   - `cd packages/memory-engine && docker compose up -d` → runs the
//                           actual engine
// `ask` is kept for any future interactive prompts.


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

  // tes config <local|hosted|show> — point Claude Code's tes-memory
  // plugin at a memory backend, or inspect what's configured. Each
  // subcommand is a thin scaffold:
  //   local  → write mode: local + memory_url; print engine bring-up steps
  //   hosted → run the login flow (delegates to runLoginCommand)
  //   show   → read and print the current plugin config
  // Future: `tes config set <key> <value>` for engine env-var tweaks.
  if (flags.command === "config") {
    const sub = process.argv.slice(3).find((a) => !a.startsWith("--"));
    const { runConfigCommand } = await import("./commands/config.js");
    const { exitCode } = await runConfigCommand({
      sub,
      endpoint: TES_ENDPOINT,
      engineUrl: flags.engineUrl,
    });
    rl.close();
    process.exit(exitCode);
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

  console.log(`
@pentatonic-ai/ai-agent-sdk

Usage:
  npx @pentatonic-ai/ai-agent-sdk login                   First-time hosted setup: browser sign-in + writes credentials
  npx @pentatonic-ai/ai-agent-sdk whoami                  Show current login identity
  npx @pentatonic-ai/ai-agent-sdk config <sub>            Configure memory backend; see 'config --help'
  npx @pentatonic-ai/ai-agent-sdk doctor                  Run health checks (exit 0/1/2)

  config subcommands:
    config local                                          Point plugin at a local memory engine
    config hosted                                         Switch to hosted (delegates to login)
    config show                                           Print current plugin config + creds

Memory corpus (onboarding):
  npx @pentatonic-ai/ai-agent-sdk onboard                 Interactive: pick paths, ingest, install hooks
  npx @pentatonic-ai/ai-agent-sdk ingest <path>           One-shot ingest of a path (any folder works)
  npx @pentatonic-ai/ai-agent-sdk status                  Show tracked paths and corpus stats
  npx @pentatonic-ai/ai-agent-sdk resync [<path>]         Delta-sync (or all tracked paths)
  npx @pentatonic-ai/ai-agent-sdk corpus list             List tracked paths
  npx @pentatonic-ai/ai-agent-sdk corpus remove <path>    Stop tracking a path
  npx @pentatonic-ai/ai-agent-sdk corpus reset            Wipe local corpus state
  npx @pentatonic-ai/ai-agent-sdk install-git-hook        Install post-commit hook in cwd

Corpus commands route to the backend configured via 'config' (local engine
or hosted TES). Override with env vars: MEMORY_ENGINE_URL, TES_ENDPOINT, …

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

main().catch((err) => {
  console.error(`\n  Error: ${err.message}\n`);
  process.exit(1);
});
