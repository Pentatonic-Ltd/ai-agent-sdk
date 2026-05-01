/**
 * Corpus ingest — public entry point.
 *
 * Onboards a developer's repos into the memory layer so retrieval has
 * something to return on the first prompt. Solves the cold-start
 * problem where a freshly-installed plugin returns nothing useful for
 * days.
 *
 * Usage from the CLI is the primary path; this module exposes the
 * underlying functions for programmatic use (tests, IDE plugins, the
 * OpenClaw onboarding hook).
 *
 * @example
 *   import { ingestCorpus, hostedAdapter } from "@pentatonic-ai/ai-agent-sdk/memory/corpus";
 *
 *   const adapter = hostedAdapter({
 *     endpoint: "https://acme.api.pentatonic.com",
 *     clientId: "acme",
 *     apiKey:   process.env.TES_API_KEY,
 *   });
 *   const totals = await ingestCorpus(adapter, "/Users/me/code/my-app", {
 *     onProgress: (p) => console.log(p),
 *   });
 *   console.log(`Ingested ${totals.chunksCreated} chunks from ${totals.filesIngested} files`);
 */

export { discover, isPathEligible } from "./discover.js";
export { chunkFile } from "./chunkers.js";
export { ingestCorpus, syncCorpus, ingestPaths } from "./ingest.js";
export { localAdapter, hostedAdapter, engineAdapter } from "./adapters.js";
export {
  loadState,
  saveState,
  defaultStatePath,
  emptyState,
  upsertSource,
  removeSource,
  getSource,
  recomputeStats,
} from "./state.js";

/**
 * Estimate the cost of ingesting a repo without actually ingesting it.
 * Useful for the `tes onboard` cost preview before commit.
 *
 * @param {string} repoPath
 * @param {object} [opts] - Forwarded to discover()
 * @returns {Promise<{fileCount: number, totalBytes: number, estimatedChunks: number, estimatedTokens: number}>}
 */
export async function estimateCorpus(repoPath, opts = {}) {
  const { discover } = await import("./discover.js");
  const { chunkFile, approxTokens } = await import("./chunkers.js");

  let fileCount = 0;
  let totalBytes = 0;
  let estimatedChunks = 0;
  let estimatedTokens = 0;

  for await (const file of discover(repoPath, opts)) {
    fileCount++;
    totalBytes += file.size;
    const chunks = chunkFile(file);
    estimatedChunks += chunks.length;
    for (const c of chunks) estimatedTokens += approxTokens(c.content);
  }

  return { fileCount, totalBytes, estimatedChunks, estimatedTokens };
}
