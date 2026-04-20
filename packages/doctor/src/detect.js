/**
 * Install-path detection.
 *
 * The SDK supports three deployment paths (see README "Overview"). Doctor
 * needs to know which one this user is on so it only runs relevant checks.
 *
 * Detection signals (in priority order):
 *  1. Explicit override via opts.path or PENTATONIC_DOCTOR_PATH env var.
 *  2. Hosted TES — TES_ENDPOINT + TES_API_KEY both set in env.
 *  3. Self-hosted platform — HYBRIDRAG_URL set, OR a Pentatonic platform
 *     config file present (~/.openclaw/openclaw.json).
 *  4. Local memory — DATABASE_URL points at a memory-shaped DSN, OR
 *     ~/.claude/tes-memory.local.md exists, OR Local-Memory env vars set.
 *  5. Fallback: 'unknown' — only universal checks run.
 *
 * Multiple paths can be active at once (e.g. an Optimus install runs both
 * the platform stack AND has a hosted TES key). detectPaths() returns the
 * full set; detectPath() returns the primary one for human-friendly output.
 */

import { existsSync as realExistsSync } from "fs";
import { join } from "path";
import { homedir as realHomedir } from "os";

export const PATHS = Object.freeze({
  LOCAL: "local",
  HOSTED: "hosted",
  PLATFORM: "platform",
  UNKNOWN: "unknown",
});

const VALID = new Set(Object.values(PATHS));

/**
 * @param {object} opts
 * @param {object} [opts.env] - process.env override; if set, filesystem
 *   detection is also disabled so tests get deterministic results without
 *   needing to mock the real homedir.
 * @param {string} [opts.path] - explicit path or 'auto'
 * @param {Function} [opts.fileExists] - test seam for filesystem probes
 * @param {string} [opts.homedir] - test seam for homedir
 */
export function detectPaths(opts = {}) {
  const env = opts.env || process.env;
  const usingFakeEnv = Boolean(opts.env);
  const fileExists = opts.fileExists ||
    (usingFakeEnv ? () => false : realExistsSync);
  const home = opts.homedir || realHomedir();

  // Explicit override wins.
  const override = opts.path || env.PENTATONIC_DOCTOR_PATH;
  if (override && override !== "auto") {
    if (!VALID.has(override)) {
      throw new Error(
        `Unknown path '${override}'. Valid: ${[...VALID].join(", ")}, auto`
      );
    }
    return new Set([override]);
  }

  const found = new Set();

  if (env.TES_ENDPOINT && env.TES_API_KEY) {
    found.add(PATHS.HOSTED);
  }

  const platformConfig = join(home, ".openclaw", "openclaw.json");
  if (env.HYBRIDRAG_URL || fileExists(platformConfig)) {
    found.add(PATHS.PLATFORM);
  }

  const localConfig = join(home, ".claude", "tes-memory.local.md");
  const looksLocal =
    (env.DATABASE_URL && env.EMBEDDING_URL && env.LLM_URL) ||
    fileExists(localConfig);
  if (looksLocal) {
    found.add(PATHS.LOCAL);
  }

  if (!found.size) {
    found.add(PATHS.UNKNOWN);
  }

  return found;
}

/**
 * @returns the primary detected path for display purposes.
 */
export function detectPath(opts = {}) {
  const paths = detectPaths(opts);
  // Priority: platform > hosted > local > unknown.
  for (const p of [
    PATHS.PLATFORM,
    PATHS.HOSTED,
    PATHS.LOCAL,
    PATHS.UNKNOWN,
  ]) {
    if (paths.has(p)) return p;
  }
  return PATHS.UNKNOWN;
}
