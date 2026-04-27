/**
 * Tests for the corpus ingest pipeline against a fake adapter.
 *
 * Covers:
 *   - End-to-end ingest of a fixture repo
 *   - Delta sync: unchanged files are skipped
 *   - Re-ingest: changed file's old chunks are deleted before new chunks
 *     are written
 *   - File deletion: vanished files have their chunks removed
 *   - State persistence: state.json reflects the ingest
 *   - maxChunks cap: aborts cleanly when exceeded
 *   - ingestPaths: handles a list of changed files (git hook path)
 */

import { promises as fsp } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";

import { ingestCorpus, ingestPaths } from "../corpus/ingest.js";
import { loadState } from "../corpus/state.js";

function makeFakeAdapter() {
  // Stores chunks keyed by corpus_file_key → array of chunk records.
  const store = new Map();
  let ingestCount = 0;
  let deleteCount = 0;
  return {
    store,
    counts: () => ({ ingestCount, deleteCount }),
    async ingestChunk(content, metadata) {
      ingestCount++;
      const key = metadata.corpus_file_key;
      const existing = store.get(key) || [];
      existing.push({ content, metadata });
      store.set(key, existing);
      return { id: `mem_${ingestCount}` };
    },
    async deleteByCorpusFile(repoAbs, relPath) {
      const key = `${repoAbs}::${relPath}`;
      const had = store.get(key);
      if (!had) return 0;
      deleteCount += had.length;
      store.delete(key);
      return had.length;
    },
  };
}

async function makeRepo() {
  const root = await mkdtemp(join(tmpdir(), "tes-corpus-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "README.md"), "# Project\n\nIntro paragraph.");
  await writeFile(join(root, "src", "index.ts"), "export const a = 1;\n");
  await writeFile(join(root, "src", "util.ts"), "export const b = 2;\n");
  // Should be excluded
  await writeFile(join(root, ".env"), "SECRET=do_not_ingest\n");
  return root;
}

async function isolatedStatePath() {
  // State must live OUTSIDE the repo we're scanning, otherwise it
  // gets re-ingested as a "new file" on subsequent runs.
  const dir = await mkdtemp(join(tmpdir(), "tes-corpus-state-"));
  return join(dir, "corpus.json");
}

describe("ingestCorpus", () => {
  let repo;
  let statePath;

  beforeEach(async () => {
    repo = await makeRepo();
    statePath = await isolatedStatePath();
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("ingests all eligible files on first run", async () => {
    const adapter = makeFakeAdapter();
    const totals = await ingestCorpus(adapter, repo, { statePath });
    expect(totals.filesIngested).toBe(3); // README.md + 2 .ts
    expect(totals.chunksCreated).toBeGreaterThanOrEqual(3);
    expect(totals.bytesProcessed).toBeGreaterThan(0);
    // .env never made it
    for (const [key] of adapter.store) {
      expect(key).not.toContain(".env");
    }
  });

  it("writes state with stats and file hashes", async () => {
    const adapter = makeFakeAdapter();
    await ingestCorpus(adapter, repo, { statePath });
    const state = await loadState(statePath);
    const src = state.sources[resolve(repo)];
    expect(src).toBeDefined();
    expect(src.stats.fileCount).toBe(3);
    expect(src.stats.chunkCount).toBeGreaterThanOrEqual(3);
    expect(src.files["README.md"].hash).toMatch(/^[0-9a-f]{64}$/);
    expect(src.lastSyncedAt).toBeTruthy();
  });

  it("skips unchanged files on re-ingest (delta sync)", async () => {
    const adapter = makeFakeAdapter();
    await ingestCorpus(adapter, repo, { statePath });
    const firstIngestCount = adapter.counts().ingestCount;

    const totals = await ingestCorpus(adapter, repo, { statePath });
    expect(totals.filesIngested).toBe(0);
    expect(totals.filesSkipped).toBe(3);
    expect(adapter.counts().ingestCount).toBe(firstIngestCount); // no new ingests
  });

  it("re-ingests a changed file and removes its old chunks first", async () => {
    const adapter = makeFakeAdapter();
    await ingestCorpus(adapter, repo, { statePath });
    const beforeDeletes = adapter.counts().deleteCount;

    await writeFile(
      join(repo, "src", "index.ts"),
      "export const a = 999; // changed\n"
    );

    const totals = await ingestCorpus(adapter, repo, { statePath });
    expect(totals.filesIngested).toBe(1);
    expect(totals.filesSkipped).toBe(2);
    // The changed file's chunks were deleted before new ones inserted
    expect(adapter.counts().deleteCount).toBeGreaterThan(beforeDeletes);
  });

  it("removes chunks for files that vanish from disk", async () => {
    const adapter = makeFakeAdapter();
    await ingestCorpus(adapter, repo, { statePath });

    await rm(join(repo, "src", "util.ts"));

    const beforeDeletes = adapter.counts().deleteCount;
    await ingestCorpus(adapter, repo, { statePath });
    expect(adapter.counts().deleteCount).toBeGreaterThan(beforeDeletes);

    const state = await loadState(statePath);
    const src = state.sources[resolve(repo)];
    expect(src.files["src/util.ts"]).toBeUndefined();
    expect(src.stats.fileCount).toBe(2);
  });

  it("aborts cleanly when maxChunks would be exceeded", async () => {
    const adapter = makeFakeAdapter();
    // Force concurrency=1 so the cap check is deterministic. With
    // higher concurrency the cap is "soft" — we may overshoot by up
    // to (concurrency-1) chunks before the abort propagates. That's
    // documented behavior; we test the deterministic path here.
    await expect(
      ingestCorpus(adapter, repo, { statePath, maxChunks: 1, concurrency: 1 })
    ).rejects.toThrow(/maxChunks/);
    expect(adapter.counts().ingestCount).toBe(1);
  });

  it("attaches source_file metadata to every chunk", async () => {
    const adapter = makeFakeAdapter();
    await ingestCorpus(adapter, repo, { statePath });
    for (const [key, chunks] of adapter.store) {
      for (const c of chunks) {
        expect(c.metadata.source_file).toBeTruthy();
        expect(c.metadata.source_repo).toBeTruthy();
        expect(c.metadata.source_file_hash).toMatch(/^[0-9a-f]{64}$/);
        expect(c.metadata.corpus_file_key).toBe(key);
      }
    }
  });

  it("propagates onWarning for hard-excluded secret files", async () => {
    const adapter = makeFakeAdapter();
    const warnings = [];
    await ingestCorpus(adapter, repo, {
      statePath,
      onWarning: (m) => warnings.push(m),
    });
    expect(warnings.some((w) => w.includes(".env"))).toBe(true);
  });
});

describe("ingestPaths (git hook fast path)", () => {
  let repo;
  let statePath;

  beforeEach(async () => {
    repo = await makeRepo();
    statePath = await isolatedStatePath();
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("ingests just the listed paths", async () => {
    const adapter = makeFakeAdapter();
    const totals = await ingestPaths(
      adapter,
      repo,
      ["src/index.ts", "README.md"],
      { statePath }
    );
    expect(totals.filesIngested).toBe(2);
    // src/util.ts was NOT ingested
    for (const [key] of adapter.store) {
      expect(key).not.toContain("util.ts");
    }
  });

  it("skips ineligible paths (secrets, lockfiles)", async () => {
    const adapter = makeFakeAdapter();
    await writeFile(join(repo, "yarn.lock"), "lockfile content\n");
    const totals = await ingestPaths(
      adapter,
      repo,
      [".env", "yarn.lock", "src/index.ts"],
      { statePath }
    );
    expect(totals.filesIngested).toBe(1);
    expect(totals.filesSkipped).toBe(2);
  });

  it("removes chunks for paths that no longer exist", async () => {
    const adapter = makeFakeAdapter();
    // First seed state by ingesting normally
    await ingestCorpus(adapter, repo, { statePath });
    // Then delete a file and run ingestPaths on it
    await rm(join(repo, "src", "util.ts"));
    const beforeDeletes = adapter.counts().deleteCount;
    await ingestPaths(adapter, repo, ["src/util.ts"], { statePath });
    expect(adapter.counts().deleteCount).toBeGreaterThan(beforeDeletes);
  });
});
