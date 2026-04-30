# Spec 01 — Onboarding repo ingest (cold-start fix)

**Status:** draft
**Author:** Philip Mossop / Claude Code
**Date:** 2026-04-27
**Owner:** TBD
**Targets:** `@pentatonic-ai/ai-agent-sdk` v0.next

---

## 1. The problem

Today the plugin installs into a tenant with empty memory layers. The first
prompt retrieves nothing useful; the second retrieves a single fragment of
the first turn; useful recall takes days of accumulated session history. For
a developer evaluating "memory for my AI" this is the worst-case first
impression — they install, prompt once, see no signal, and bounce.

The architecture supports better. The OpenClaw `ingest` lifecycle hook and
`packages/memory/src/ingest.js` already accept arbitrary content and write
it to layers with embeddings + HyDE expansion. We are not using either to
seed the user's own working corpus on day one.

## 2. What we're shipping

A first-run onboarding flow that gets the user's own code, docs, and notes
into their memory layer **before they send the first prompt**, plus the
plumbing to keep that corpus current as they work.

Cold-start retrieval should hit on prompt #1, not week #1.

### 2.1 Out of scope (this spec)
- Multi-user team sync (one tenant ingesting on behalf of others)
- IDE integrations beyond CLI plugins (Claude Code, Cursor CLI, Codex CLI)
- Cross-repo deduplication / global vector search
- Branch-aware memory (treating different git branches as different memory)

These are noted as follow-ups in §10.

## 3. User flow

```
$ openclaw plugins install @pentatonic-ai/ai-agent-sdk
✓ Installed pentatonic-memory plugin

$ tes onboard                     # or runs auto on first SessionStart
Welcome. Let's give your memory something to retrieve.

  Repos to ingest (comma-separated paths or git URLs, blank to skip):
  > ~/code/my-app, ~/code/my-app-docs

  Honoring .gitignore + .tesignore. Excluding: node_modules, dist, .git, *.lock
  Found 1,247 files (3.2M tokens after compression)

  Embedding model: nomic-embed-text (local) | NV-Embed-v2 (hosted)
  Storage: hosted (tes_pip-agents_xxxx)

  Continue? [Y/n]: y

  Ingesting... ████████████████████ 100% (1247/1247 files, 12,847 chunks)
  Done in 4m 12s.

✓ Memory ready. 12,847 chunks indexed across 3 layers.
  Try: claude-code, then ask about anything in your repos.
```

After this:
- Every `git commit` re-ingests changed files (post-commit hook installed by
  `tes onboard`).
- A filesystem watcher (opt-in, off by default) catches uncommitted edits.
- `tes status` shows corpus health; `tes resync <path>` forces a re-index.

## 4. Surface area changes

### 4.1 New CLI commands (`bin/cli.js`)

```
tes onboard [--repo <path|url>]... [--no-git-hook] [--no-watcher]
tes ingest <path> [--layer episodic|semantic|procedural]
tes status
tes resync <path>
tes corpus list
tes corpus remove <path>
```

| Command | Behavior |
|---|---|
| `onboard` | Interactive wizard. Asks for repos, scope, hooks, watcher; runs first ingest; installs git post-commit hook. Idempotent — safe to re-run. |
| `ingest` | One-shot ingest of a single path. Used by hooks and manually. |
| `status` | Shows tenant ID, layer counts, last sync per repo, corpus size. |
| `resync` | Walks repo, computes content hashes, re-ingests anything changed since last sync. |
| `corpus list/remove` | Manage which repos are tracked. |

### 4.2 New SDK API (`packages/memory/src/`)

New module: `packages/memory/src/corpus.js`

```js
// Discovery — walk a repo, return files to ingest
export async function discover(repoPath, opts) → AsyncIterable<FileRef>

// Chunking — split a file into semantically meaningful chunks
export async function chunkFile(fileRef, opts) → Chunk[]

// Bulk ingest — chunked, parallelized, resumable
export async function ingestCorpus(db, ai, llm, repoPath, opts) → IngestReport

// Track which file content-hashes are already indexed
export async function syncCorpus(db, repoPath, opts) → SyncReport
```

### 4.3 New OpenClaw hook entry

Extends `packages/memory/src/openclaw/index.js` with an `onInstall` lifecycle
that triggers `tes onboard` if no `corpus_state` row exists for the tenant.

### 4.4 New config keys (`openclaw.json`)

```json
{
  "config": {
    "tes_endpoint": "...",
    "tes_client_id": "...",
    "tes_api_key": "...",

    "corpus": {
      "auto_onboard": true,
      "watch_filesystem": false,
      "git_hook": true,
      "ignore_files": [".gitignore", ".tesignore"],
      "max_file_size_kb": 512,
      "exclude_extensions": [".lock", ".log", ".min.js"]
    }
  }
}
```

### 4.5 New table (hosted + local)

```sql
CREATE TABLE corpus_sources (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  user_id UUID,
  source_type TEXT NOT NULL,  -- 'git', 'directory'
  source_path TEXT NOT NULL,
  source_url TEXT,
  last_synced_at TIMESTAMPTZ,
  last_synced_commit TEXT,
  file_count INT,
  chunk_count INT,
  total_bytes BIGINT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(client_id, user_id, source_path)
);

CREATE TABLE corpus_files (
  id TEXT PRIMARY KEY,
  source_id TEXT REFERENCES corpus_sources(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,        -- relative to source root
  content_hash TEXT NOT NULL,     -- sha256 of file content
  chunk_count INT,
  first_indexed_at TIMESTAMPTZ DEFAULT NOW(),
  last_indexed_at TIMESTAMPTZ DEFAULT NOW()
);

-- Memory nodes get a backref so we can drop a file and remove its chunks
ALTER TABLE memory_nodes ADD COLUMN corpus_file_id TEXT;
CREATE INDEX idx_memory_nodes_corpus_file ON memory_nodes(corpus_file_id);
```

## 5. Ingest pipeline

```
                  ┌──────────────┐
   Repo root  ──→ │  discover()  │  → walks tree, applies ignores,
                  └──────┬───────┘    yields {path, ext, size, hash}
                         ▼
                  ┌──────────────┐
                  │  chunkFile() │  → tree-sitter for code, headings for md,
                  └──────┬───────┘    sliding window for text
                         ▼
                  ┌──────────────┐
                  │  embed()     │  → batch up to 32 chunks/req,
                  └──────┬───────┘    nomic local / NV-Embed hosted
                         ▼
                  ┌──────────────┐
                  │  index()     │  → memory_nodes insert + Qdrant upsert,
                  └──────┬───────┘    layer = "semantic" by default
                         ▼
                  ┌──────────────┐
                  │  HyDE        │  → background, non-blocking,
                  └──────────────┘    generates 2-3 hypothetical queries/chunk
```

### 5.1 Chunking strategy

| File type | Strategy |
|---|---|
| `.ts .tsx .js .jsx .mjs .py .go .rs .java .rb` | tree-sitter — one chunk per top-level function/class, plus a file-summary chunk |
| `.md .mdx .rst .txt` | Heading-aware split (h2/h3), max 1200 tokens per chunk, 200-token overlap |
| `.json .yaml .yml .toml` | Whole-file as one chunk if <1200 tokens, else top-level keys |
| `.sql` | One chunk per statement |
| `.csv .tsv` | Header + first 50 rows as one chunk; skip rest |
| Other text | Sliding window 1200/200 |
| Binary, lockfiles, generated | Skipped |

### 5.2 Layer assignment

- Code, docs, configs → **semantic** (low decay, high capacity)
- READMEs, CHANGELOGs, ADRs → **semantic** with `metadata.priority: "high"`
- Conversation captures from PostToolUse/Stop hooks → **episodic** (default,
  fast decay) — this is the existing path, unchanged
- Skills, prompts, agent configs → **procedural**

### 5.3 Performance budget

For a typical 1k-file repo (~3M tokens):
- Discovery + chunking: <30s (single-threaded, IO bound)
- Embedding: 4-8 min (batched, hosted) / 15-30 min (local nomic on CPU)
- Indexing: <1 min
- **Target: end-to-end <10 min for the median dev repo**

For >5k-file repos: must show progress, be resumable, and offer
`--max-files 1000` to cap initial ingest.

## 6. Live updates

### 6.1 Git post-commit hook

`tes onboard` writes `.git/hooks/post-commit`:

```bash
#!/bin/sh
# Installed by @pentatonic-ai/ai-agent-sdk
exec node $(npx tes-resolve hook-runner) post-commit "$@" || true
```

Runs `tes ingest` for `git diff --name-only HEAD~1 HEAD`. Non-fatal — never
blocks a commit, never errors loudly.

### 6.2 Filesystem watcher (opt-in)

Off by default. When enabled (`corpus.watch_filesystem: true`), a chokidar
watcher debounced at 30s catches edits between commits. Runs as a background
daemon spawned by `SessionStart` and torn down by `SessionEnd`.

### 6.3 Conflict & dedup

Re-ingesting an unchanged file is a no-op (content hash matches existing
`corpus_files` row). Re-ingesting a changed file:
1. Look up `corpus_files.id` for the path
2. `DELETE FROM memory_nodes WHERE corpus_file_id = $1`
3. Insert new chunks
4. Update `corpus_files.content_hash` and `last_indexed_at`

This avoids the pathological "stale chunk lingers because the file moved"
case.

## 7. Hosted vs local

### 7.1 Hosted (default for `tes_endpoint` mode)

All ingest writes go through the existing TES GraphQL surface — extend
`storeMemory` mutation to accept a `corpus_file_id` and `metadata.source`
field. Embeddings are generated by the hosted NV-Embed-v2 worker (4096-dim).
Bulk ingest uses a new `ingestCorpus` mutation that accepts batches of
chunks to amortize round-trip cost.

### 7.2 Local (existing direct-DB mode)

`packages/memory/src/corpus.js` calls `ingest()` directly against the local
PostgreSQL + pgvector. Embeddings via the local Ollama (`nomic-embed-text`,
768-dim).

### 7.3 Pip's hybrid path (separate concern)

Pip's `pip-orchestrator` already wraps the L1-L6 prefetcher behind
`POST /api/internal/memory/graphql`. This spec does NOT change that
endpoint. The repo-ingest writes flow through the **per-tenant TES
GraphQL** surface (which the prefetcher's L4 fans out to as one of its
sources). Pip's own personal-agent layers (L1, L3, L5) remain orchestrator-
internal.

## 8. Site copy implications

If we ship this, the marketing site needs the cold-start narrative removed
and replaced with the "ingest on install" narrative. Files to update:

| Path | Change |
|---|---|
| `src/components/Hero.jsx` | Add a third clause to the supporting line: "Memory works on the first prompt — point it at your repos and it's ready." |
| `src/pages/sdk/ClaudeCode.jsx` | Insert step "0. `tes onboard`" before the existing install steps. Show wizard output. |
| `src/pages/sdk/OpenClaw.jsx` | Same — `tes onboard` is step 1, plugin install is step 2. |
| `src/pages/Docs.jsx` | New section "Onboarding & corpus" between Install and Reference. |
| `src/pages/Home.jsx` | Replace "Two ways in" cards with one card: install → onboard → prompt. Subscription users get the same wizard. |
| `src/pages/products/AgentMemory.jsx` | Add a "Day-one corpus" section above the layer cards. |

## 9. Build plan

Phased so we can ship the cold-start fix without waiting on the watcher.

### Phase 1 — Core ingest (1-2 days)
- `packages/memory/src/corpus.js` (discover, chunkFile, ingestCorpus, syncCorpus)
- tree-sitter integration (use `web-tree-sitter` for portability across local/Cloudflare)
- `corpus_sources` + `corpus_files` migrations
- `tes ingest <path>` CLI command
- Tests: 50-file fixture repo, golden ingest output

### Phase 2 — Onboarding wizard (0.5 day)
- `tes onboard` interactive command (extend `bin/cli.js`)
- Auto-trigger from `SessionStart` hook if no `corpus_sources` row exists
- `tes status`

### Phase 3 — Hosted-mode parity (0.5-1 day)
- `ingestCorpus` GraphQL mutation in TES API
- Per-tenant rate limiting on the embed worker
- `tes onboard` with hosted endpoint as primary test path

### Phase 4 — Live updates (1 day)
- Git post-commit hook installer
- `tes resync <path>`
- Optional: filesystem watcher (chokidar) — gated behind config flag

### Phase 5 — Site copy + ship (0.5 day)
- Update copy on the seven files in §8
- Verify the wizard renders sensibly in the screenshot reel
- Push

**Total: ~4-5 working days to a shippable v0.next.**

## 10. Open questions

1. **Default repo scope** — should `tes onboard` ingest only the cwd repo,
   or scan `~/code/*` and offer a multi-select? Cwd is safer; multi-select
   is friendlier. Lean: cwd-only by default, `--all` flag for multi.
2. **Token cost** — at 4096-dim hosted embeddings, a 3M-token repo is
   roughly 30k chunks * 4096 floats * 4 bytes = ~500MB raw vector data.
   Hosted infra needs to know what we're committing to per tenant.
3. **Sensitive files** — `.env`, `*.pem`, `*.key`, `secrets.*` should be
   hard-excluded by default regardless of `.gitignore`. List the
   exclusions explicitly in docs.
4. **Multi-repo semantic separation** — if a user ingests three repos,
   should retrieval namespace by repo, or merge? Default merge with
   `metadata.repo` for filtering; expose `repo:my-app foo()` query syntax
   later.
5. **Replay vs forget** — if a user uninstalls the plugin and reinstalls,
   do they get their old corpus back? Default: yes (corpus survives plugin
   reinstall, lives at the tenant level). `tes corpus reset` to wipe.
6. **Cross-IDE consistency** — Cursor and Codex don't have OpenClaw hooks.
   For them, `tes onboard` is a one-shot CLI step that the docs walk users
   through; the live-update path falls back to git post-commit + `tes
   resync` in `package.json` scripts. Acceptable as v0.next; revisit.
7. **Branch awareness** — re-ingesting on every branch switch is too
   expensive. Default: ingest tracks `main` only; document that branch
   work is captured via session-history hooks (existing path).
8. **Telemetry** — should `tes onboard` report anonymous corpus stats
   back to TES (file counts, languages, sizes) to inform product decisions?
   Default opt-in with explicit prompt; never report file content or paths.

## 12. TES server-side audit findings (2026-04-27)

After implementation, walked the TES repo to verify hosted-mode parity.
The original spec assumed STORE_MEMORY events would be the right
transport — the audit shows they aren't, for the reasons below. The
implementation has been revised to use the existing `createMemory`
GraphQL mutation, with two small companion TES PRs required.

### 12.1 Wrong shape: STORE_MEMORY event path for bulk ingest

**Files inspected:**
- `thing-event-system/workers/wrangler.epic.toml` — queue config
- `thing-event-system/workers/registerConsumers.js` — consumer dispatcher
- `thing-event-system/modules/deep-memory/consumers/index.js` — handler
- `thing-event-system/lib/generated/modules.js#MODULE_EVENT_TYPES`

**Findings:**
- Cloudflare consumer queue: `max_batch_size = 1`, `max_concurrency = 30`,
  `visibility_timeout_ms = 180000`. Every event is one invocation.
- A 12k-chunk repo would mean 12k consumer invocations, capped at 30
  concurrent, ~500ms/event including embed + HyDE + dedup query →
  ~3-5 minutes consumer-side, plus retries on transient fail.
- Per-invocation Cloudflare cost adds up at scale.
- Consumer hardcodes layer routing to `episodic` (decay rate 0.05,
  capacity 10k) — code chunks would be evicted within days.
- Server prepends `[<timestamp>] ` to content before embedding, which
  is fine for chat turns but pollutes the embedding text for code.

**Decision:** switch to the `createMemory` GraphQL mutation (synchronous,
direct, layer-aware).

### 12.2 `createMemory` resolver bug — TES PR required

**File:** `modules/deep-memory/graphql/memory/resolvers.js#createMemory`

The resolver accepts a `layerId` parameter and validates the row exists,
but then calls `memory.ingest(content, { layerType: "episodic" })` —
ignoring the validated layer. Result: code chunks land in episodic
regardless of what was requested.

**Fix:** replace the hardcoded `"episodic"` with the validated row's
layer type. Roughly:

```diff
- const result = await memory.ingest(content, { clientId, layerType: "episodic", metadata });
+ const result = await memory.ingest(content, {
+   clientId,
+   layerType: layerCheck.rows[0].layer_type,
+   metadata,
+ });
```

This is a one-line change. Until it lands, the SDK's hosted adapter
will write to the layer it requests but the server will silently
re-route to episodic. Document as a known limitation in the SDK README.

### 12.3 Missing `deleteMemoryNodesByMetadata` mutation — TES PR required

**File:** `modules/deep-memory/graphql/memory/schema.js`

There is no GraphQL mutation to delete memory nodes by metadata
filter. When the SDK detects a deleted file (via `corpus_file_key`
metadata), it has no server-side way to remove the corresponding
chunks.

**Proposed mutation:**

```graphql
"""
Delete memory nodes whose metadata.<key> equals the given value.
Used for corpus-file removal when the SDK detects vanished files.
Returns the number of nodes deleted.
"""
deleteMemoryNodesByMetadata(
  clientId: String!,
  metadataKey: String!,
  metadataValue: String!
): Int!
```

Resolver implementation is straightforward:

```sql
DELETE FROM memory_nodes
WHERE client_id = $1
  AND metadata->>$2 = $3
RETURNING id;
```

Until this lands, orphaned chunks for vanished files will accumulate
on the server. The local SDK state file still tracks correctly, so
re-ingest of changed files won't double-write — only deletion lags.

### 12.4 Module enablement gate

**File:** `functions/api/graphql/domains/event-ingestion/resolvers.js`
(also enforced inside `createMemory` via `authorizeClient`)

Tenants must have `deep-memory` enabled in their module config before
any ingest works. The adapter calls `memoryLayers(clientId)` on
`init()`; if the module isn't enabled, the response is empty and we
fail fast with a clear error message that points the user to the
TES dashboard.

### 12.5 Permissions

The tenant API key needs either `view:memoryLayer:all` (for the layer
lookup) and `create:memory:all` (for createMemory). These are part of
the deep-memory module's standard permission set per
`modules/deep-memory/module.json`. No additional permission
provisioning required.

### 12.6 Embedding gateway

deep-memory consumer uses `lambda-gateway.pentatonic.com/v1/embed` with
`NV-Embed-v2` (4096-dim). The SDK never calls embeddings directly in
hosted mode — the server handles it as part of `createMemory`.
At ~50ms/chunk for embedding, a 12k-chunk repo onboard takes ~10
minutes wall-clock, which is acceptable for a one-time operation.
Subsequent resyncs are delta-only and much faster.

### 12.7 Required TES PRs to ship before SDK PR is fully functional

Both opened 2026-04-27, gated on Zweck review:

1. **TES #244 — `fix(deep-memory): honor layerId in createMemory resolver`**
   <https://github.com/Pentatonic-Ltd/thing-event-system/pull/244>
   One-line behavior change + 5 regression tests. No schema impact, no
   consumer impact.
2. **TES #245 — `feat(deep-memory): deleteMemoryNodesByMetadata mutation`**
   <https://github.com/Pentatonic-Ltd/thing-event-system/pull/245>
   New mutation with metadata-key allowlist. Adds `delete:memory:all`
   permission to deep-memory module. 7 new tests + the cross-cutting
   module-permissions test passes.

Until they land, the SDK works but: (a) code chunks land in episodic
instead of semantic and decay quickly, (b) chunks for deleted files
persist server-side. The SDK adapter swallows the unknown-mutation
error from older TES tenants gracefully (delete returns 0).

## 11. Success criteria

- A new user runs `openclaw plugins install` → `tes onboard` → first prompt
  in Claude Code, and the assistant correctly references something specific
  from their repo (function name, file path, design decision in a doc).
- Time from install to first useful retrieval: **<10 minutes** for a 1k-file
  repo on hosted, **<20 minutes** on local.
- `tes status` shows a non-zero `chunk_count` immediately after onboard.
- `git commit` on a tracked file results in a re-indexed chunk visible in
  `tes status` within 60s, with no commit-time delay >100ms.

---

## Appendix A — File layout after this spec lands

```
packages/memory/src/
├── ai.js
├── consolidate.js
├── corpus.js          (NEW)  ← bulk ingest pipeline
├── decay.js
├── index.js
├── ingest.js
├── layers.js
├── migrate.js
├── openclaw/
│   ├── context-engine.js
│   ├── index.js       (extended) ← onInstall lifecycle
│   └── onboarding.js  (NEW)  ← wizard logic
├── search.js
└── server.js

bin/
└── cli.js             (extended) ← onboard, ingest, status, resync, corpus

hooks/scripts/
├── post-commit.js     (NEW)  ← git hook runner
└── ...                       (existing scripts unchanged)

specs/
└── 01-onboarding-repo-ingest.md  (this file)
```

## Appendix B — Wire format for the hosted `ingestCorpus` mutation

```graphql
mutation IngestCorpus($input: IngestCorpusInput!) {
  ingestCorpus(input: $input) {
    sourceId
    fileResults {
      filePath
      contentHash
      chunkCount
      status        # ingested | unchanged | skipped | error
      message
    }
    totals {
      filesProcessed
      filesIngested
      filesSkipped
      chunksCreated
      embeddingsCreated
      bytesProcessed
    }
  }
}

input IngestCorpusInput {
  sourceType: String!         # "git" | "directory"
  sourcePath: String!
  sourceUrl: String
  files: [IngestFileInput!]!  # batch up to 100 per call
}

input IngestFileInput {
  filePath: String!
  contentHash: String!
  chunks: [IngestChunkInput!]!
}

input IngestChunkInput {
  content: String!
  chunkIndex: Int!
  metadata: JSON              # {kind: "function", name: "foo", lineRange: [10,42]}
}
```
