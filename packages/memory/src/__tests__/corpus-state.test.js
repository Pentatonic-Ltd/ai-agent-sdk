/**
 * Tests for corpus state persistence — atomic writes, version handling,
 * and the upsert/remove API used by ingest.js.
 */

import { promises as fsp, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";

import {
  loadState,
  saveState,
  upsertSource,
  removeSource,
  getSource,
  recordFile,
  forgetFile,
  recomputeStats,
  emptyState,
  STATE_VERSION,
} from "../corpus/state.js";

let tmp;
let statePath;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "tes-state-"));
  statePath = join(tmp, "corpus.json");
});

afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

describe("loadState", () => {
  it("returns empty state when file does not exist", async () => {
    const state = await loadState(statePath);
    expect(state.version).toBe(STATE_VERSION);
    expect(state.sources).toEqual({});
  });

  it("loads previously-saved state", async () => {
    const initial = emptyState();
    upsertSource(initial, "/repo/x", { sourceType: "git" });
    await saveState(initial, statePath);

    const loaded = await loadState(statePath);
    expect(loaded.sources["/repo/x"]).toBeDefined();
    expect(loaded.sources["/repo/x"].sourceType).toBe("git");
  });

  it("rejects state with newer version than supported", async () => {
    await fsp.writeFile(
      statePath,
      JSON.stringify({ version: STATE_VERSION + 99, sources: {} })
    );
    await expect(loadState(statePath)).rejects.toThrow(/unsupported version/);
  });

  it("rejects corrupt JSON with a clear error", async () => {
    await fsp.writeFile(statePath, "{ not valid json");
    await expect(loadState(statePath)).rejects.toThrow(/corrupt JSON/);
  });
});

describe("saveState", () => {
  it("creates parent directory if missing", async () => {
    const nested = join(tmp, "a", "b", "c", "corpus.json");
    await saveState(emptyState(), nested);
    expect(existsSync(nested)).toBe(true);
  });

  it("writes with mode 0600 (owner-only)", async () => {
    await saveState(emptyState(), statePath);
    const stat = await fsp.stat(statePath);
    // mode bits: only check owner read+write set, group/other empty
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("uses atomic rename (no half-written file on crash)", async () => {
    // Save twice; the second save shouldn't leave a .tmp behind
    await saveState(emptyState(), statePath);
    await saveState(emptyState(), statePath);
    const dir = await fsp.readdir(tmp);
    expect(dir.filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
  });
});

describe("upsertSource / removeSource / getSource", () => {
  it("upsert merges patches and resolves to absolute path", async () => {
    const state = emptyState();
    upsertSource(state, "./relative-path", { sourceType: "directory" });
    const keys = Object.keys(state.sources);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^\//); // absolute
  });

  it("upsert preserves existing fields when patching", async () => {
    const state = emptyState();
    upsertSource(state, "/repo", { sourceType: "git" });
    upsertSource(state, "/repo", { lastSyncedCommit: "abc" });
    expect(state.sources["/repo"].sourceType).toBe("git");
    expect(state.sources["/repo"].lastSyncedCommit).toBe("abc");
  });

  it("removeSource returns false for unknown paths", () => {
    const state = emptyState();
    expect(removeSource(state, "/never-added")).toBe(false);
  });

  it("removeSource returns true and deletes when present", () => {
    const state = emptyState();
    upsertSource(state, "/repo", {});
    expect(removeSource(state, "/repo")).toBe(true);
    expect(state.sources["/repo"]).toBeUndefined();
  });

  it("getSource resolves relative paths to absolute lookups", () => {
    const state = emptyState();
    upsertSource(state, "/abs/repo", {});
    // Looking up a different relative form that resolves to same abs
    // returns the same record (assuming cwd matches when the test runs
    // — we use an absolute path here to avoid flakiness)
    expect(getSource(state, "/abs/repo")).toBeDefined();
    expect(getSource(state, "/abs/other")).toBeNull();
  });
});

describe("recordFile / forgetFile / recomputeStats", () => {
  it("recordFile sets hash, chunks, indexedAt", () => {
    const state = emptyState();
    const src = upsertSource(state, "/repo", {});
    recordFile(src, "src/x.ts", "hash123", 4);
    expect(src.files["src/x.ts"]).toMatchObject({
      hash: "hash123",
      chunks: 4,
    });
    expect(src.files["src/x.ts"].indexedAt).toBeTruthy();
  });

  it("forgetFile removes the entry", () => {
    const state = emptyState();
    const src = upsertSource(state, "/repo", {});
    recordFile(src, "src/x.ts", "h", 1);
    expect(forgetFile(src, "src/x.ts")).toBe(true);
    expect(src.files["src/x.ts"]).toBeUndefined();
    expect(forgetFile(src, "src/x.ts")).toBe(false);
  });

  it("recomputeStats reflects current files", () => {
    const state = emptyState();
    const src = upsertSource(state, "/repo", {});
    recordFile(src, "a", "h1", 3);
    recordFile(src, "b", "h2", 7);
    const stats = recomputeStats(src);
    expect(stats.fileCount).toBe(2);
    expect(stats.chunkCount).toBe(10);
  });
});
