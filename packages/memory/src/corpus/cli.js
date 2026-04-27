/**
 * CLI handlers for corpus commands. Imported by bin/cli.js.
 *
 * Each handler returns a process exit code (0 = ok, non-zero = failure).
 * Output goes to stdout/stderr — no return values for human-facing
 * formatting.
 */

import { resolve, basename } from "node:path";
import { existsSync } from "node:fs";
import { promises as fsp } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  ingestCorpus,
  syncCorpus,
  ingestPaths,
  estimateCorpus,
  hostedAdapter,
  loadState,
  saveState,
  defaultStatePath,
  emptyState,
  removeSource as removeSourceFromState,
  recomputeStats,
} from "./index.js";

// --------------------------------------------------------------------
// Tenant resolution
// --------------------------------------------------------------------

function resolveTenant() {
  const endpoint =
    process.env.TES_ENDPOINT ||
    process.env.PENTATONIC_ENDPOINT ||
    null;
  const clientId =
    process.env.TES_CLIENT_ID || process.env.PENTATONIC_CLIENT_ID || null;
  const apiKey =
    process.env.TES_API_KEY || process.env.PENTATONIC_API_KEY || null;

  if (endpoint && clientId && apiKey) {
    return { endpoint, clientId, apiKey, source: "env" };
  }

  // Fall back to ~/.config/tes/credentials.json (written by `tes init`)
  const credPath = join(
    process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
    "tes",
    "credentials.json"
  );
  if (existsSync(credPath)) {
    try {
      const raw = JSON.parse(
        require("node:fs").readFileSync(credPath, "utf-8")
      );
      if (raw.endpoint && raw.clientId && raw.apiKey) {
        return { ...raw, source: "credentials" };
      }
    } catch {
      // fall through
    }
  }
  return null;
}

function buildAdapterOrFail() {
  const tenant = resolveTenant();
  if (!tenant) {
    process.stderr.write(
      "Error: TES tenant not configured.\n\n" +
        "  Set environment variables:\n" +
        "    export TES_ENDPOINT=https://your-co.api.pentatonic.com\n" +
        "    export TES_CLIENT_ID=your-co\n" +
        "    export TES_API_KEY=tes_your-co_xxxxx\n\n" +
        "  Or run: npx @pentatonic-ai/ai-agent-sdk init\n"
    );
    return null;
  }
  return {
    tenant,
    adapter: hostedAdapter(tenant, { source: "tes-corpus-cli" }),
  };
}

// --------------------------------------------------------------------
// Formatting helpers
// --------------------------------------------------------------------

function fmtBytes(n) {
  if (!Number.isFinite(n)) return "?";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

function progressBar(processed, total, width = 30) {
  if (!total) return "";
  const filled = Math.min(width, Math.floor((processed / total) * width));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function liveProgress() {
  let lastWrite = 0;
  return (p) => {
    if (p.phase !== "file") return;
    const now = Date.now();
    if (now - lastWrite < 100 && p.processed !== p.total) return;
    lastWrite = now;
    const bar = progressBar(p.processed, p.total);
    const line = `  ${bar} ${p.processed}/${p.total}  ${p.file}`;
    process.stderr.write("\r\x1b[K" + line.slice(0, 120));
    if (p.processed === p.total) process.stderr.write("\n");
  };
}

// --------------------------------------------------------------------
// Subcommand: tes ingest <path>
// --------------------------------------------------------------------

export async function cmdIngest(args) {
  const path = args[0];
  if (!path) {
    process.stderr.write("Usage: tes ingest <path>\n");
    return 1;
  }
  const abs = resolve(path);
  if (!existsSync(abs)) {
    process.stderr.write(`Error: ${abs} does not exist\n`);
    return 1;
  }

  const built = buildAdapterOrFail();
  if (!built) return 1;
  const { adapter } = built;

  process.stdout.write(`Ingesting ${abs}...\n`);
  const start = Date.now();
  let warnings = 0;
  try {
    const totals = await ingestCorpus(adapter, abs, {
      sourceUrl: detectGitRemote(abs),
      onProgress: liveProgress(),
      onWarning: (m) => {
        warnings++;
        if (warnings <= 5) process.stderr.write(`  ! ${m}\n`);
      },
    });
    const dur = Date.now() - start;
    process.stdout.write(
      `\nDone in ${fmtDuration(dur)}.\n` +
        `  Files processed: ${totals.filesProcessed}\n` +
        `  Files ingested:  ${totals.filesIngested}\n` +
        `  Files skipped:   ${totals.filesSkipped}\n` +
        `  Chunks created:  ${totals.chunksCreated}\n` +
        `  Bytes processed: ${fmtBytes(totals.bytesProcessed)}\n`
    );
    if (warnings > 5) {
      process.stderr.write(`  (${warnings - 5} additional warnings suppressed)\n`);
    }
    return 0;
  } catch (err) {
    process.stderr.write(`\nIngest failed: ${err.message}\n`);
    return 2;
  }
}

// --------------------------------------------------------------------
// Subcommand: tes onboard
// --------------------------------------------------------------------

export async function cmdOnboard(_args, { ask, close }) {
  const built = buildAdapterOrFail();
  if (!built) return 1;
  const { tenant, adapter } = built;

  process.stdout.write(
    `\nWelcome. Let's give your memory something to retrieve.\n\n` +
      `  Tenant: ${tenant.clientId} @ ${tenant.endpoint}\n\n`
  );

  // Default to current working directory
  const defaultRepo = process.cwd();
  const inputRepos = await ask(
    `  Repos to ingest (comma-separated paths, blank for cwd):\n  > `
  );
  const repos = (inputRepos || defaultRepo)
    .split(",")
    .map((s) => resolve(s.trim()))
    .filter((s) => s && existsSync(s));

  if (!repos.length) {
    process.stdout.write("  No valid paths. Aborting.\n");
    close();
    return 1;
  }

  process.stdout.write(`\n  Estimating cost (no data sent yet)...\n`);
  const estimates = [];
  let totalChunks = 0;
  for (const r of repos) {
    const est = await estimateCorpus(r);
    estimates.push({ repo: r, ...est });
    totalChunks += est.estimatedChunks;
    process.stdout.write(
      `    ${r}\n` +
        `      ${est.fileCount} files, ${fmtBytes(est.totalBytes)}, ` +
        `~${est.estimatedChunks} chunks (~${est.estimatedTokens.toLocaleString()} tokens)\n`
    );
  }

  if (totalChunks > 100000) {
    process.stdout.write(
      `\n  ⚠️  This run would create ${totalChunks.toLocaleString()} chunks, ` +
        `exceeding the default 100,000 cap.\n      Re-run individual repos with` +
        ` --max-chunks <N> if needed.\n`
    );
    close();
    return 1;
  }

  const confirm = await ask(`\n  Continue? [Y/n]: `);
  if (confirm.trim().toLowerCase() === "n") {
    process.stdout.write("  Aborted.\n");
    close();
    return 0;
  }

  for (const { repo } of estimates) {
    process.stdout.write(`\n  Ingesting ${repo}...\n`);
    const start = Date.now();
    let warnings = 0;
    try {
      const totals = await ingestCorpus(adapter, repo, {
        sourceUrl: detectGitRemote(repo),
        onProgress: liveProgress(),
        onWarning: (m) => {
          warnings++;
          if (warnings <= 3) process.stderr.write(`  ! ${m}\n`);
        },
      });
      process.stdout.write(
        `  ✓ ${totals.filesIngested} files, ${totals.chunksCreated} chunks, ${fmtDuration(
          Date.now() - start
        )}.\n`
      );
    } catch (err) {
      process.stderr.write(`  ✗ ${err.message}\n`);
    }
  }

  // Offer to install git hook
  for (const { repo } of estimates) {
    if (!isGitRepo(repo)) continue;
    const hookPath = join(repo, ".git", "hooks", "post-commit");
    if (existsSync(hookPath)) continue;
    const yes = await ask(
      `\n  Install git post-commit hook in ${repo}?\n  (re-ingests changed files on commit) [Y/n]: `
    );
    if (yes.trim().toLowerCase() !== "n") {
      try {
        await installGitHook(repo);
        process.stdout.write(`  ✓ Hook installed at ${hookPath}\n`);
      } catch (err) {
        process.stderr.write(`  ✗ Failed to install hook: ${err.message}\n`);
      }
    }
  }

  process.stdout.write(
    `\n  Memory ready. Run \`tes status\` any time to see corpus health.\n\n`
  );
  close();
  return 0;
}

// --------------------------------------------------------------------
// Subcommand: tes status
// --------------------------------------------------------------------

export async function cmdStatus() {
  const tenant = resolveTenant();
  const state = await loadState();
  const sources = Object.entries(state.sources);

  process.stdout.write(`\nTES corpus status\n`);
  if (tenant) {
    process.stdout.write(
      `  Tenant: ${tenant.clientId}\n  Endpoint: ${tenant.endpoint}\n`
    );
  } else {
    process.stdout.write(`  Tenant: <not configured>\n`);
  }
  process.stdout.write(`  State file: ${defaultStatePath()}\n\n`);

  if (!sources.length) {
    process.stdout.write(
      `  No repos tracked yet. Run \`tes onboard\` to add some.\n\n`
    );
    return 0;
  }

  let totalFiles = 0;
  let totalChunks = 0;
  let totalBytes = 0;
  for (const [path, src] of sources) {
    recomputeStats(src);
    totalFiles += src.stats.fileCount;
    totalChunks += src.stats.chunkCount;
    totalBytes += src.stats.totalBytes || 0;
    const lastSync = src.lastSyncedAt
      ? new Date(src.lastSyncedAt).toLocaleString()
      : "never";
    process.stdout.write(
      `  ${path}\n` +
        `    ${src.stats.fileCount} files, ${src.stats.chunkCount} chunks` +
        (src.stats.totalBytes ? `, ${fmtBytes(src.stats.totalBytes)}` : "") +
        `\n` +
        `    last sync: ${lastSync}\n` +
        (src.sourceUrl ? `    git: ${src.sourceUrl}\n` : "")
    );
  }
  process.stdout.write(
    `\n  Total: ${sources.length} repos, ${totalFiles} files, ${totalChunks} chunks\n\n`
  );
  return 0;
}

// --------------------------------------------------------------------
// Subcommand: tes resync [<path>]
// --------------------------------------------------------------------

export async function cmdResync(args) {
  const built = buildAdapterOrFail();
  if (!built) return 1;
  const { adapter } = built;

  const state = await loadState();
  const sources = args[0]
    ? [resolve(args[0])]
    : Object.keys(state.sources);

  if (!sources.length) {
    process.stdout.write(
      "No repos tracked. Run `tes onboard` or `tes ingest <path>` first.\n"
    );
    return 0;
  }

  for (const repo of sources) {
    if (!existsSync(repo)) {
      process.stderr.write(`  ! ${repo} no longer exists; skipping\n`);
      continue;
    }
    process.stdout.write(`Resyncing ${repo}...\n`);
    const start = Date.now();
    try {
      const totals = await syncCorpus(adapter, repo, {
        onProgress: liveProgress(),
        onWarning: (m) => process.stderr.write(`  ! ${m}\n`),
      });
      process.stdout.write(
        `  ✓ ${totals.filesIngested} updated, ${totals.filesSkipped} unchanged, ${totals.chunksCreated} new chunks, ${fmtDuration(Date.now() - start)}\n`
      );
    } catch (err) {
      process.stderr.write(`  ✗ ${err.message}\n`);
    }
  }
  return 0;
}

// --------------------------------------------------------------------
// Subcommand: tes corpus list / remove / reset
// --------------------------------------------------------------------

export async function cmdCorpus(args, { ask, close }) {
  const sub = args[0];

  if (sub === "list" || !sub) {
    const state = await loadState();
    const entries = Object.keys(state.sources);
    if (!entries.length) {
      process.stdout.write("No repos tracked.\n");
      return 0;
    }
    for (const e of entries) process.stdout.write(`${e}\n`);
    return 0;
  }

  if (sub === "remove") {
    const repo = args[1];
    if (!repo) {
      process.stderr.write("Usage: tes corpus remove <path>\n");
      return 1;
    }
    const state = await loadState();
    const existed = removeSourceFromState(state, repo);
    if (!existed) {
      process.stdout.write(`Not tracked: ${resolve(repo)}\n`);
      return 0;
    }
    await saveState(state);
    process.stdout.write(
      `Removed ${resolve(repo)} from tracked repos.\n` +
        `Note: chunks already in hosted memory are not deleted by this command.\n` +
        `Use the dashboard or a future \`tes corpus purge\` to remove server-side data.\n`
    );
    return 0;
  }

  if (sub === "reset") {
    const yes = await ask(
      `This will wipe local corpus state at ${defaultStatePath()}.\n` +
        `Server-side memory data is NOT touched.\nProceed? [y/N]: `
    );
    if (yes.trim().toLowerCase() !== "y") {
      process.stdout.write("Aborted.\n");
      close();
      return 0;
    }
    await saveState(emptyState());
    process.stdout.write("Local corpus state cleared.\n");
    close();
    return 0;
  }

  process.stderr.write(
    `Unknown corpus subcommand: ${sub}\n` +
      `Usage: tes corpus [list|remove <path>|reset]\n`
  );
  return 1;
}

// --------------------------------------------------------------------
// Git helpers
// --------------------------------------------------------------------

function isGitRepo(dir) {
  return existsSync(join(dir, ".git"));
}

function detectGitRemote(dir) {
  try {
    return execFileSync("git", ["-C", dir, "config", "--get", "remote.origin.url"], {
      encoding: "utf-8",
    }).trim() || null;
  } catch {
    return null;
  }
}

async function installGitHook(repo) {
  const hookDir = join(repo, ".git", "hooks");
  if (!existsSync(hookDir)) {
    throw new Error(`${hookDir} does not exist (not a git repo?)`);
  }
  const hookPath = join(hookDir, "post-commit");
  // Use absolute node binary path to make the hook portable across
  // shells that strip PATH (the default for git hooks).
  const script = `#!/bin/sh
# Installed by @pentatonic-ai/ai-agent-sdk — do not edit by hand.
# Re-runs corpus ingest for files changed in the latest commit.
# Non-fatal: never blocks a commit.
CHANGED=$(git diff-tree --no-commit-id --name-only -r HEAD 2>/dev/null)
if [ -z "$CHANGED" ]; then exit 0; fi
echo "$CHANGED" | npx --no-install @pentatonic-ai/ai-agent-sdk \\
  ingest-paths --repo "$(pwd)" --stdin >/dev/null 2>&1 || true
`;
  await fsp.writeFile(hookPath, script, { mode: 0o755 });
}

// --------------------------------------------------------------------
// Subcommand: tes install-git-hook (manual install in cwd)
// --------------------------------------------------------------------

export async function cmdInstallGitHook() {
  const cwd = process.cwd();
  if (!isGitRepo(cwd)) {
    process.stderr.write(`Error: ${cwd} is not a git repo\n`);
    return 1;
  }
  try {
    await installGitHook(cwd);
    process.stdout.write(
      `✓ Installed post-commit hook at ${join(cwd, ".git", "hooks", "post-commit")}\n`
    );
    return 0;
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`);
    return 1;
  }
}

// --------------------------------------------------------------------
// Subcommand: tes ingest-paths (used by the git hook itself)
// --------------------------------------------------------------------

export async function cmdIngestPaths(args) {
  const repoIdx = args.indexOf("--repo");
  const stdinIdx = args.indexOf("--stdin");
  if (repoIdx === -1 || !args[repoIdx + 1]) {
    process.stderr.write(
      "Usage: tes ingest-paths --repo <path> --stdin (or paths as args)\n"
    );
    return 1;
  }
  const repo = resolve(args[repoIdx + 1]);

  let paths;
  if (stdinIdx !== -1) {
    const buffers = [];
    for await (const chunk of process.stdin) buffers.push(chunk);
    paths = Buffer.concat(buffers)
      .toString("utf-8")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  } else {
    paths = args.filter((a, i) => i > stdinIdx && !a.startsWith("--"));
  }

  if (!paths.length) return 0;

  const built = buildAdapterOrFail();
  if (!built) return 1;
  const { adapter } = built;

  try {
    const totals = await ingestPaths(adapter, repo, paths, {
      onWarning: () => {}, // silent in hook context
    });
    // Hook runs detached; minimal stdout noise
    process.stdout.write(
      `[tes] ${totals.filesIngested}/${totals.filesProcessed} files re-indexed (${totals.chunksCreated} chunks)\n`
    );
    return 0;
  } catch (err) {
    process.stderr.write(`[tes] ingest-paths failed: ${err.message}\n`);
    return 2;
  }
}
