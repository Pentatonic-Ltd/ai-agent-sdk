/**
 * Corpus ingest pipeline.
 *
 * Takes a discovered file → chunks it → ingests each chunk via an
 * adapter. Two adapters ship: `localAdapter` (writes via the existing
 * memory.ingest path against a Pool) and `hostedAdapter` (emits
 * STORE_MEMORY events via the existing TES createModuleEvent mutation —
 * no new server-side schema needed).
 *
 * This module knows nothing about HTTP or pg directly — adapters
 * encapsulate that. Keeps it testable and lets us add e.g. a Cloudflare
 * Worker adapter later without changing the pipeline.
 */

import { chunkFile } from "./chunkers.js";
import { extractReferences } from "./signatures.js";
import {
  loadState,
  saveState,
  upsertSource,
  recordFile,
  forgetFile,
  recomputeStats,
} from "./state.js";
import { discover } from "./discover.js";
import { resolve, basename } from "node:path";

/**
 * Adapter contract:
 *   adapter.ingestChunk(content, metadata) → Promise<{ id, skipped? }>
 *   adapter.deleteByCorpusFile(repoAbs, relPath) → Promise<number> // chunks removed
 *
 * Both methods MUST be safe to call repeatedly with the same args
 * (idempotent on adapter side or via metadata content_hash).
 */

/**
 * Ingest a single repo end-to-end. Walks the tree, chunks each file,
 * sends chunks through the adapter, and updates corpus state.
 *
 * Caller controls concurrency by setting `opts.concurrency` (default 4
 * — small enough not to swamp local Ollama, large enough to amortize
 * hosted GraphQL round trips).
 *
 * @param {object} adapter - { ingestChunk, deleteByCorpusFile }
 * @param {string} repoPath - Path to the repo (will be resolved to abs)
 * @param {object} [opts]
 * @param {number} [opts.concurrency=4]
 * @param {number} [opts.maxChunks=100000] - Hard cap per ingest run; abort if exceeded
 * @param {string} [opts.statePath] - Override state file path (tests)
 * @param {Function} [opts.onProgress] - ({phase, processed, total, file}) => void
 * @param {Function} [opts.onWarning] - (msg) => void
 * @param {string}   [opts.sourceUrl] - Optional git remote URL to record
 * @param {object}   [opts.discoverOpts] - Forwarded to discover()
 * @param {"references"|"content"} [opts.mode="references"] - Storage mode.
 *   "references" (default): store path + signature pointers; the agent
 *   reads source files at query time. Stale source = `Read` fails →
 *   loud, self-correcting failure mode.
 *   "content": store full chunk content (legacy behaviour). Stale chunks
 *   silently mislead retrieval until re-ingested. Kept for callers who
 *   explicitly want a self-contained index.
 * @returns {Promise<{filesProcessed, filesIngested, filesSkipped, chunksCreated, bytesProcessed}>}
 */
export async function ingestCorpus(adapter, repoPath, opts = {}) {
  const repoAbs = resolve(repoPath);
  const concurrency = opts.concurrency || 4;
  const maxChunks = opts.maxChunks ?? 100000;
  const onProgress = opts.onProgress || (() => {});
  const onWarning = opts.onWarning || (() => {});

  // Default mode is "references" — store pointers, not chunks. See JSDoc
  // above. Set mode: "content" to opt back into the chunk-content
  // behaviour for callers who explicitly want a self-contained index
  // (e.g. air-gapped retrieval where the source isn't readable at
  // query time).
  const mode = opts.mode === "content" ? "content" : "references";
  const extract = mode === "content" ? chunkFile : extractReferences;

  const state = await loadState(opts.statePath);
  const source = upsertSource(state, repoAbs, {
    sourceType: "directory",
    sourceUrl: opts.sourceUrl ?? null,
  });

  const totals = {
    filesProcessed: 0,
    filesIngested: 0,
    filesSkipped: 0,
    chunksCreated: 0,
    bytesProcessed: 0,
  };

  // Phase 1: discovery (counts files for progress)
  const queue = [];
  for await (const file of discover(repoAbs, {
    ...(opts.discoverOpts || {}),
    onWarning,
  })) {
    queue.push(file);
  }
  onProgress({ phase: "discovered", total: queue.length });

  // Phase 2: ingest with bounded concurrency
  const stillSeen = new Set();
  let inFlight = 0;
  let cursor = 0;
  let aborted = null;

  async function worker() {
    while (cursor < queue.length && !aborted) {
      const file = queue[cursor++];
      stillSeen.add(file.relPath);
      totals.filesProcessed++;

      const prev = source.files[file.relPath];
      if (prev && prev.hash === file.hash) {
        totals.filesSkipped++;
        onProgress({
          phase: "file",
          processed: totals.filesProcessed,
          total: queue.length,
          file: file.relPath,
          status: "unchanged",
        });
        continue;
      }

      // Changed file — drop existing chunks before re-ingesting
      if (prev) {
        try {
          await adapter.deleteByCorpusFile(repoAbs, file.relPath);
        } catch (err) {
          onWarning(
            `corpus: failed to delete stale chunks for ${file.relPath}: ${err.message}`
          );
        }
      }

      const chunks = extract(file);
      if (totals.chunksCreated + chunks.length > maxChunks) {
        aborted = new Error(
          `corpus: maxChunks (${maxChunks}) exceeded — stopped at ${file.relPath}`
        );
        break;
      }

      let chunksCreatedHere = 0;
      for (const chunk of chunks) {
        // Per-chunk cap check — concurrency-safe because totals.chunksCreated
        // is incremented inside the loop atomically (single-threaded JS).
        if (totals.chunksCreated >= maxChunks) {
          aborted = new Error(
            `corpus: maxChunks (${maxChunks}) reached — stopped at ${file.relPath}`
          );
          break;
        }
        const metadata = {
          ...chunk.metadata,
          source_repo: repoAbs,
          source_repo_name: basename(repoAbs),
          source_file: file.relPath,
          source_file_hash: file.hash,
          corpus_file_key: `${repoAbs}::${file.relPath}`,
        };
        try {
          const result = await adapter.ingestChunk(chunk.content, metadata);
          if (!result?.skipped) {
            chunksCreatedHere++;
            totals.chunksCreated++;
          }
        } catch (err) {
          onWarning(
            `corpus: ingest failed for ${file.relPath} chunk ${chunk.metadata.chunk_index}: ${err.message}`
          );
        }
      }

      if (chunksCreatedHere > 0) {
        recordFile(source, file.relPath, file.hash, chunksCreatedHere);
        totals.filesIngested++;
        totals.bytesProcessed += file.size;
      }
      if (aborted) break;

      onProgress({
        phase: "file",
        processed: totals.filesProcessed,
        total: queue.length,
        file: file.relPath,
        status: prev ? "updated" : "ingested",
        chunks: chunksCreatedHere,
      });
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);

  // Phase 3: detect deletions — files in state but no longer on disk
  const removed = [];
  for (const relPath of Object.keys(source.files)) {
    if (!stillSeen.has(relPath)) {
      try {
        await adapter.deleteByCorpusFile(repoAbs, relPath);
        forgetFile(source, relPath);
        removed.push(relPath);
      } catch (err) {
        onWarning(
          `corpus: failed to delete chunks for vanished ${relPath}: ${err.message}`
        );
      }
    }
  }
  if (removed.length) {
    onProgress({ phase: "removed", count: removed.length });
  }

  source.lastSyncedAt = new Date().toISOString();
  recomputeStats(source);
  await saveState(state, opts.statePath);

  if (aborted) throw aborted;

  return totals;
}

/**
 * Delta-sync a known repo. Same as ingestCorpus but useful as a
 * semantic distinction in the CLI ("resync"). Skips files whose
 * content hash matches state; deletes chunks for removed files.
 */
export async function syncCorpus(adapter, repoPath, opts = {}) {
  return ingestCorpus(adapter, repoPath, opts);
}

/**
 * Ingest a specific list of files (e.g. those changed in a git commit).
 * Cheaper than walking the whole tree.
 *
 * @param {object} adapter
 * @param {string} repoPath
 * @param {string[]} relPaths - Paths relative to repoPath
 * @param {object} [opts]
 */
export async function ingestPaths(adapter, repoPath, relPaths, opts = {}) {
  const repoAbs = resolve(repoPath);
  const onWarning = opts.onWarning || (() => {});
  const state = await loadState(opts.statePath);
  const source = upsertSource(state, repoAbs, {});

  const totals = {
    filesProcessed: 0,
    filesIngested: 0,
    filesSkipped: 0,
    chunksCreated: 0,
    bytesProcessed: 0,
  };

  const { join } = await import("node:path");
  const { promises: fsp, existsSync } = await import("node:fs");
  const { createHash } = await import("node:crypto");
  const { isPathEligible } = await import("./discover.js");

  for (const relPath of relPaths) {
    totals.filesProcessed++;
    const eligible = isPathEligible(relPath);
    const fullPath = join(repoAbs, relPath);

    // File deleted on disk — drop its chunks
    if (!existsSync(fullPath)) {
      try {
        await adapter.deleteByCorpusFile(repoAbs, relPath);
        forgetFile(source, relPath);
      } catch (err) {
        onWarning(`corpus: cleanup failed for ${relPath}: ${err.message}`);
      }
      continue;
    }

    if (!eligible.eligible) {
      totals.filesSkipped++;
      continue;
    }

    let content;
    try {
      content = await fsp.readFile(fullPath, "utf-8");
    } catch (err) {
      onWarning(`corpus: cannot read ${relPath}: ${err.message}`);
      continue;
    }
    if (content.includes("\0")) {
      totals.filesSkipped++;
      continue;
    }

    const hash = createHash("sha256").update(content).digest("hex");
    const prev = source.files[relPath];
    if (prev && prev.hash === hash) {
      totals.filesSkipped++;
      continue;
    }

    if (prev) {
      try {
        await adapter.deleteByCorpusFile(repoAbs, relPath);
      } catch (err) {
        onWarning(
          `corpus: failed to delete stale chunks for ${relPath}: ${err.message}`
        );
      }
    }

    const ext = relPath.includes(".")
      ? "." + relPath.split(".").pop().toLowerCase()
      : "";

    const chunks = chunkFile({
      relPath,
      content,
      ext,
      basename: relPath.split("/").pop(),
    });

    let chunksCreatedHere = 0;
    for (const chunk of chunks) {
      const metadata = {
        ...chunk.metadata,
        source_repo: repoAbs,
        source_repo_name: basename(repoAbs),
        source_file: relPath,
        source_file_hash: hash,
        corpus_file_key: `${repoAbs}::${relPath}`,
      };
      try {
        const result = await adapter.ingestChunk(chunk.content, metadata);
        if (!result?.skipped) chunksCreatedHere++;
      } catch (err) {
        onWarning(`corpus: ingest failed for ${relPath}: ${err.message}`);
      }
    }

    if (chunksCreatedHere > 0) {
      recordFile(source, relPath, hash, chunksCreatedHere);
      totals.filesIngested++;
      totals.chunksCreated += chunksCreatedHere;
      totals.bytesProcessed += content.length;
    }
  }

  source.lastSyncedAt = new Date().toISOString();
  recomputeStats(source);
  await saveState(state, opts.statePath);

  return totals;
}
