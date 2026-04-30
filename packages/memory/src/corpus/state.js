/**
 * Local corpus state — what repos are tracked, content hashes per file,
 * last sync timestamps. Lives at ~/.config/tes/corpus.json (or
 * $XDG_CONFIG_HOME/tes/corpus.json) so it survives plugin reinstalls
 * but stays per-developer.
 *
 * Schema:
 *   {
 *     "version": 1,
 *     "tenant": { "clientId": "acme", "endpoint": "https://acme.api..." },
 *     "sources": {
 *       "/abs/path/to/repo": {
 *         "sourceType": "git" | "directory",
 *         "sourceUrl": "git@github.com:org/repo.git" | null,
 *         "addedAt": "2026-04-27T12:00:00Z",
 *         "lastSyncedAt": "2026-04-27T12:05:00Z",
 *         "lastSyncedCommit": "abc123" | null,
 *         "files": {
 *           "src/index.ts": { "hash": "sha256...", "chunks": 3, "indexedAt": "..." }
 *         },
 *         "stats": { "fileCount": 47, "chunkCount": 132, "totalBytes": 184320 }
 *       }
 *     }
 *   }
 *
 * Atomic writes via tmpfile + rename so partial writes can't corrupt
 * the state file mid-sync.
 */

import { promises as fsp, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";

const STATE_VERSION = 1;

export function defaultStatePath() {
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdg, "tes", "corpus.json");
}

export function emptyState() {
  return {
    version: STATE_VERSION,
    tenant: null,
    sources: {},
  };
}

export async function loadState(path = defaultStatePath()) {
  if (!existsSync(path)) return emptyState();
  try {
    const raw = await fsp.readFile(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed.version || parsed.version > STATE_VERSION) {
      throw new Error(
        `corpus state at ${path} has unsupported version ${parsed.version} (we understand up to ${STATE_VERSION}). Upgrade the SDK.`
      );
    }
    parsed.sources = parsed.sources || {};
    return parsed;
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`corpus state at ${path} is corrupt JSON: ${err.message}`);
    }
    throw err;
  }
}

export async function saveState(state, path = defaultStatePath()) {
  await fsp.mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(state, null, 2), {
    mode: 0o600, // user-only — state may include endpoint URLs
  });
  await fsp.rename(tmp, path);
}

export function getSource(state, repoPath) {
  const abs = resolve(repoPath);
  return state.sources[abs] || null;
}

export function upsertSource(state, repoPath, patch) {
  const abs = resolve(repoPath);
  const existing = state.sources[abs] || {
    sourceType: "directory",
    sourceUrl: null,
    addedAt: new Date().toISOString(),
    lastSyncedAt: null,
    lastSyncedCommit: null,
    files: {},
    stats: { fileCount: 0, chunkCount: 0, totalBytes: 0 },
  };
  state.sources[abs] = { ...existing, ...patch };
  return state.sources[abs];
}

export function removeSource(state, repoPath) {
  const abs = resolve(repoPath);
  if (state.sources[abs]) {
    delete state.sources[abs];
    return true;
  }
  return false;
}

export function recordFile(source, relPath, hash, chunks) {
  source.files[relPath] = {
    hash,
    chunks,
    indexedAt: new Date().toISOString(),
  };
}

export function forgetFile(source, relPath) {
  if (source.files[relPath]) {
    delete source.files[relPath];
    return true;
  }
  return false;
}

export function recomputeStats(source) {
  let fileCount = 0;
  let chunkCount = 0;
  for (const f of Object.values(source.files)) {
    fileCount++;
    chunkCount += f.chunks || 0;
  }
  source.stats = { ...source.stats, fileCount, chunkCount };
  return source.stats;
}

export { STATE_VERSION };
