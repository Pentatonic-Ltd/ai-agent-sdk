# TES companion changes for SDK corpus ingest (PR #16)

**Status:** Draft — pass to the TES agent
**SDK PR:** Pentatonic-Ltd/ai-agent-sdk#16 (`feat/onboarding-repo-ingest`)
**Companion TES PRs (already in flight):** #244 (layerId honoring), #245 (`deleteMemoryNodesByMetadata`)
**Audience:** Engineer working in `thing-event-system` (`modules/deep-memory/`)

---

## 1. Context

The SDK ships a corpus ingest pipeline that walks a customer repo and writes one memory per code reference (`function`/`class`/heading/etc.). After review feedback, the SDK was changed to store **references** — `path + lines + signature` — rather than full chunk content. Each memory carries:

```json
{
  "metadata": {
    "kind": "code_reference",
    "path": "src/auth.js",
    "symbol": "authenticate",
    "start_line": 12,
    "end_line": 30,
    "lines": "12-30",
    "language": "javascript",
    "source_file": "src/auth.js",
    "source_file_hash": "<sha256>",
    "source_repo": "<abs path>",
    "source_repo_name": "<basename>",
    "corpus_file_key": "<abs>::<rel>"
  }
}
```

The SDK's local path (`localAdapter`) already passes `distill: false` so the conversation-shaped distiller doesn't run on code structure. The **hosted path** (`hostedAdapter` → GraphQL `createMemory`) cannot pass that flag through the current API. This spec covers what TES needs to do to make hosted-mode corpus ingest behave the same.

This spec assumes #244 and #245 land first (they are not blocking each other but should ship together for hosted-mode parity).

---

## 2. Why this matters

Two failure modes the SDK is trying to prevent. Both apply server-side too if TES does conversational post-processing on every `createMemory` call.

### 2.1 Distillation hallucinates "user facts" from code

`extractAtomicFacts` (or whatever the equivalent is server-side) is prompted with:

> *"You extract atomic facts from conversations. Rules: only extract facts the user has explicitly stated about themselves, their preferences, decisions, relationships, or world."*

Apply that to a chunk like `function authenticate(req) { return verifyJWT(req.headers.authorization) }` and either:

- The LLM correctly returns `[]` — you've burned ~5–60s of compute per chunk × N chunks.
- The LLM hallucinates `"the user uses JWT"`, `"the user's API requires Authorization header"`. These land in the same `semantic` layer as real user-stated facts, indistinguishable in retrieval. Now `"what does the user prefer?"` surfaces model-imagined claims drawn from code structure.

### 2.2 HyDE generates conversation-shaped queries for code

If HyDE runs at retrieval time and the corpus is in the same store as conversational memory, hypothetical-question expansion may degrade rather than help when the query target is a function signature.

---

## 3. Required changes

### 3.1 Skip conversational post-processing when `metadata.kind === "code_reference"`

**File(s):** `modules/deep-memory/graphql/memory/resolvers.js` (or wherever `createMemory` is implemented), plus any consumer that processes the resulting memory rows.

**Change:** In every code path that runs distillation, atomic-fact extraction, or any other conversation-shaped LLM enrichment on stored content, branch on `metadata.kind`:

```js
// Pseudocode — adapt to your actual structure
if (metadata?.kind === "code_reference") {
  // Skip distillation entirely. Embed and store the content as-is.
  // The SDK has already extracted a signature/summary for the embed.
  return storeRaw({ clientId, layerId, content, metadata });
}
// Existing conversational path unchanged
return storeAndDistill({ clientId, layerId, content, metadata });
```

**Acceptance:**
- A `createMemory` call with `metadata.kind = "code_reference"` does not trigger any LLM call beyond the embedding model.
- A `createMemory` call without that flag (or with any other `kind`) behaves exactly as today.
- Add a regression test asserting both branches.

### 3.2 Skip HyDE for code-reference retrieval (verify)

**File(s):** Wherever `semanticSearchMemories` runs HyDE expansion server-side.

**Change:** If HyDE is currently run unconditionally on the query string, add a path so callers can opt out per query — or have it skip automatically when the search is scoped to `kind: code_reference` (see 3.3). Simplest contract: a `hyde: true | false` arg on `semanticSearchMemories`, defaulting to current behavior. The SDK will pass `hyde: false` for code-reference searches.

**Acceptance:**
- Default behavior unchanged.
- New `hyde` arg accepted; when `false`, no hypothetical-question generation runs.
- Document in the GraphQL schema description that disabling HyDE is recommended for code-reference scoped queries.

### 3.3 Optional but recommended — kind/metadata filter on retrieval

**File(s):** `semanticSearchMemories` resolver and SQL.

**Problem:** Today, code references and conversational memories share the `semantic` layer. A query like *"what does the user prefer for auth?"* will rank code refs and user facts against the same threshold. Code refs (long, signature-shaped) embed differently than conversational facts (short, declarative); they compete for top-K slots and one will dominate retrieval depending on query shape. Result: noisy results in both directions.

**Change:** Add a `metadataFilter: JSON` (or specifically a `kind: String` field on the existing filter) to `semanticSearchMemories`. SQL joins should add a `metadata->>'kind' = $N` clause when supplied.

```graphql
type Query {
  semanticSearchMemories(
    clientId: String!
    query: String!
    minScore: Float
    limit: Int
    layerType: String
    kind: String              # NEW — exact match on metadata.kind
  ): [MemorySearchHit!]!
}
```

**Acceptance:**
- `kind: "code_reference"` returns only code refs; `kind: null`/omitted preserves current behavior.
- Index lookup remains fast — confirm the `metadata->>'kind'` clause uses an index (add a partial GIN/expression index if not).
- Add a test for each branch.

### 3.4 Verify #244 + #245 land cleanly

These are already opened. Confirming for completeness:

- **#244** — `createMemory` must honor the supplied `layerId` (currently hardcodes `episodic`). Without this, code references decay within days.
- **#245** — `deleteMemoryNodesByMetadata(metadataKey, metadataValue)` mutation. SDK calls it with `metadataKey: "corpus_file_key"` to remove chunks for changed/deleted files.

The SDK already calls #245 and treats unknown-mutation errors as zero-deletions, so older tenants degrade gracefully but accumulate orphaned rows.

---

## 4. Out of scope / follow-ups

These are not required for SDK PR #16 to function correctly, but are reasonable next steps once the above lands.

- **Dedicated `code` (or `corpus`) layer type.** Cleaner separation than `kind` filtering, but bigger schema change. Defer until we see whether `kind` filtering is sufficient in practice.
- **Commit-pinned references.** Storing `metadata.commit` alongside `path + lines` would tighten "loud rot" further (the agent could compare the file at HEAD against the reference's commit and detect drift). SDK can add this; TES needs no change.
- **Bulk createMemory mutation.** A 12k-reference repo currently means 12k mutation calls. Not painful at 30-concurrent throughput but a `createMemoriesBatch(input: [...])` would amortize round-trip overhead. Defer.
- **Retention policy for code references.** Distinct from conversational memory (which decays per layer rules), code refs should probably be evicted only when the `corpus_file_key` is deleted, never on time decay. If the deep-memory module has decay/TTL logic, it should explicitly skip rows where `metadata.kind = "code_reference"`.

---

## 5. Verification — what "done" looks like

Run end-to-end against a hosted tenant after all changes ship:

1. SDK: `tes onboard <repo>` against a hosted endpoint with deep-memory module enabled.
2. TES side: confirm rows land in the requested `semantic` layer (not `episodic`).
3. TES side: confirm zero LLM calls per `createMemory` for `kind: code_reference` (check distillation logs / metrics).
4. SDK: `tes status` shows non-zero `chunk_count`.
5. SDK: `tes search "<symbol>"` against a known function returns the expected reference with `metadata.path` + `lines`.
6. SDK: edit a tracked file, `git commit`, confirm SDK reissues `deleteMemoryNodesByMetadata` then `createMemory`. `tes search` for the old symbol no longer returns a stale ref.
7. Conversational path: a normal chat-turn `createMemory` (no `kind`) still runs distillation as before.

---

## 6. Open questions for the TES agent

- Does TES currently run any conversational post-processing in the `createMemory` mutation path, or is distillation entirely an SDK-side concern? If the SDK is the only place distillation runs today, sections 3.1 reduces to "do nothing — already correct" and we just need 3.2 + 3.3.
- If HyDE runs server-side, where is it triggered, and is the `hyde: false` opt-out approach (3.2) preferable to auto-disabling on `kind` scope?
- Any concern about the `metadata->>'kind'` filter performance at scale? Happy to add an expression index in the migration if that's the call.

Reply on the SDK PR (#16) or in `#deep-memory-dev` once you've decided on the shape.
