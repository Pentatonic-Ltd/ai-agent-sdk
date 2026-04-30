# Memory Engine v1 — full-stack spec

**Status:** Draft v1 — for hand-off to engine, TES, and SDK teams
**Source repos:**
- Engine: `Pentatonic-Ltd/memory_stack_updated` (private)
- SDK: `Pentatonic-Ltd/ai-agent-sdk`
- TES: `Pentatonic-Ltd/thing-event-system`
- Embedding service (existing): `pentatonic-ai-gateway` on lambda.dev

**Authors:** Phil Hauser + agents
**Goal:** Replace TES's in-Worker `deep-memory` JS implementation with the 7-layer memory engine, deployed once in AWS for hosted, packaged once in the SDK for local-OSS, fronted by a thin TES GraphQL/perms shim. **API surface visible to SDK clients is unchanged.**

**Source-of-truth principle:** `memory_stack_updated` is the source of truth for everything memory-related — embedding dimensions, storage choices (Postgres / Neo4j / Qdrant / Milvus), retrieval semantics (HyDE timing, reranker, layer fusion), operational requirements (CPU/GPU, RAM floor), and the `/store` `/search` `/forget` `/store-batch` `/health` HTTP contract. SDK and TES **adapt to whatever the engine ships**; they do not dictate internal choices. The only thing we coordinate on cross-team is the wire-format contract itself, and even that is owned and versioned in the engine repo.

**Porting principle:** The engine is **ported verbatim** into the SDK as `packages/memory-engine/`. We do not redesign, refactor, simplify, or adapt the engine internals during this port. We do not change the API. We do not change storage choices. We do not add SDK-specific abstractions inside the engine. Two things we *do* allow:

1. **Deployment glue** — `docker-compose.aws.yml` overlay file for hosted, environment variable wiring, healthcheck tuning for AWS load balancers, a Cloudflare Tunnel daemon as an additional service. No changes to the existing engine services or compose file beyond what's needed to layer hosted-mode config on top.
2. **Embedding endpoint config** — `NV_EMBED_URL` already supports OpenAI-compat endpoints. Set it to `pentatonic-ai-gateway` for hosted; user-configurable for local. This is engine-supported, not a fork.

Anything beyond those two is a change to the engine and goes through the engine repo. If we discover the engine needs a real change to fit (auth header, multi-region awareness, whatever), that's an engine PR — we don't make it in our copy.

**Repository question (defer):** Whether `memory_stack_updated` continues as a separate repo with periodic syncs into `packages/memory-engine/`, or gets archived once the port lands and the engine's day-to-day moves into the SDK monorepo, is a v1.1 decision. v1 commits to the port; the upstream repo's fate can be settled later.

---

## 1. Why we're doing this

Two pressures meeting in one move:

1. The current `pentatonic-memory` v0.5.x in-process JS engine has documented architectural gaps (no chunking, no reranker, HyDE-at-ingest instead of search, single embedding per row, pgvector HNSW dim limit, etc. — see `memory_stack_updated/docs/why-v05-underperforms.md`). The 7-layer engine ships fixes for all of them.
2. The SDK has been growing into a kitchen sink because memory and observability are bundled. Splitting **memory engine = SDK-shipped product** from **TES module = thin proxy + GraphQL surface** lets us market memory as its own product on top of TES, without npm-package fragmentation.

The architectural unification is: **one memory backend** (the engine), **deployed identically** locally and hosted, **fronted by TES on hosted** for auth/multi-tenancy/observability.

---

## 2. Scope

### In v1

- Stand the engine up in AWS as a single Pentatonic-managed deployment (one region).
- Wire it to TES via Cloudflare Tunnel.
- **Rebuild** TES's `deep-memory` module as a thin GraphQL/perms wrapper around the engine HTTP API. (Not migrate; rebuild. The module's storage gets reduced to a single audit-log table.)
- Move the engine repo's runtime into the SDK at `packages/memory-engine/` so `npx @pentatonic-ai/ai-agent-sdk memory` brings it up locally with the same compose file (modulo a hosted overlay).
- Replace the SDK's JS memory implementation in `packages/memory/` with a thin HTTP client that talks to the engine.
- Use `pentatonic-ai-gateway` (lambda.dev) as the embedding endpoint — no GPU on the engine box.
- Migration tooling: dual-write window + backfill from existing TES Postgres → engine for hosted tenants.
- All visible TES GraphQL surface stays the same. SDK callers are unchanged.

### Out of v1

- Multi-region engine deployment (single-region first; regionalize when traffic justifies)
- HA / replication for stateful stores (single instance + EBS snapshots is enough for v1)
- Move to managed offerings (RDS, Neo4j Aura, Qdrant Cloud, Zilliz). v1 = self-hosted on EC2; v2 may move pieces to managed.
- Distillation as a JS-side preprocess (decided dropped; revisit if recall on chat-style queries regresses past tolerance)
- Layer routing as a first-class concept (`episodic`/`semantic`/`procedural`/`working`) — collapses to optional `metadata.layer_type`; no enforcement
- The full marketing/docs split between memory and observability — README repositioning landed separately
- New JS features in `createMemorySystem()` beyond what existed pre-rewrite

---

## 3. Architecture

```
              SDK clients (Claude Code plugin, OpenClaw, direct lib users)
                                       │
                                       │  hosted: GraphQL to TES
                                       │  local: HTTP to engine on localhost:8099
                                       ▼
              ┌─────────────────────────────────────────────────────┐
              │  Cloudflare TES (stays as-is for everything else)    │
              │                                                       │
              │  module_pentatonic_memory (REBUILT, thin)            │
              │   • GraphQL resolvers: createMemory,                 │
              │     semanticSearchMemories, forget, etc.             │
              │   • Auth + per-tenant perms                          │
              │   • Rate limit per tenant                            │
              │   • Audit log row per call (one new table)           │
              │   • All real work → forwarded over HTTP              │
              │                                                       │
              │  Other TES modules (predictive-modelling,            │
              │  conversation-analytics, etc.) UNCHANGED             │
              │  CHAT_TURN events / queues / R2 UNCHANGED            │
              │  Dashboard UNCHANGED                                  │
              └────────────────────────┬─────────────────────────────┘
                                       │
                                       │  HTTPS via Cloudflare Tunnel
                                       │  (engine.pentatonic.internal — private)
                                       │  X-TES-Client header + HMAC signature
                                       ▼
              ┌─────────────────────────────────────────────────────┐
              │  AWS — memory engine (single region, single AZ for v1)│
              │                                                       │
              │  EC2 (m6i.2xlarge, no GPU)                           │
              │   docker-compose with:                                │
              │   ├─ cloudflared (CF Tunnel daemon)                  │
              │   ├─ compat shim   :8099                             │
              │   ├─ L2 orchestrator                                  │
              │   ├─ L3 Neo4j      EBS volume                        │
              │   ├─ L5 Qdrant     EBS volume                        │
              │   ├─ L6 doc store  EBS volume (Milvus Lite + SQLite) │
              │   └─ Postgres      EBS volume (chunks + tsvector FTS) │
              │                                                       │
              │  Embedding: outbound to pentatonic-ai-gateway        │
              │              (no nv-embed locally on hosted)          │
              │  HyDE LLM: TBD — see open question §11                │
              └─────────────────────────────────────────────────────┘
```

**Local-OSS deployment** is the same compose stack on the user's machine. `npx @pentatonic-ai/ai-agent-sdk memory` runs `docker compose up`. Embedding endpoint defaults to `pentatonic-ai-gateway` for parity (or user-configured Ollama / OpenAI / etc.). No CF Tunnel — engine listens on `localhost:8099` directly.

---

## 4. The contract (engine HTTP API)

**Owned by `memory_stack_updated`.** TES module talks this; SDK thin client talks this; future integrations talk this. Wire format is whatever the engine ships in `docs/MIGRATION.md`. Stable across v1; additive-only changes after.

> If the engine team changes the contract during v1, this spec is wrong — defer to the engine repo's docs. SDK and TES update to match.

### Endpoints

| Method | Path | Purpose | Caller |
|---|---|---|---|
| POST | `/store` | Single record ingest | All |
| POST | `/store-batch` | Bulk ingest (1–100 records) | TES module, SDK corpus ingest |
| POST | `/search` | Semantic + keyword + KG retrieval, RRF-fused, reranked | All |
| POST | `/forget` | Delete by id or `metadata_contains` filter | TES module |
| GET | `/health` | Per-layer health + aggregate status | All |

Full request/response shapes in `memory_stack_updated/docs/MIGRATION.md`. Notable:

- **`arena` field** is the multi-tenant primitive. TES module sets it to `clientId` on every call. Engine namespaces every store (Postgres schema, Neo4j label prefix, Qdrant collection, Milvus collection) by arena. **Confirm before v1**: every store path actually applies arena scoping. This is the load-bearing tenant isolation.
- **`metadata` field** is opaque JSON pass-through. Stored as JSONB in Postgres, indexable by JSON path. Engine respects `metadata_filter` on `/search` for fields like `kind`, `source_file`, `layer_type`.
- Response shape includes `engine_layer` (which layer carried the hit, informational) and `engine.l5/l6` counts on writes (informational). SDK clients ignore unknown fields.
- **Auth**: every engine call from TES carries `X-TES-Client: <clientId>` and `X-TES-Signature: HMAC-SHA256(body, shared_secret)`. Engine verifies the signature. Local-OSS deployments have no auth (local trust model); add an env-var to disable HMAC check.

### What `arena` enforces

- **Postgres** chunks table: `chunks(id, arena, ...)` with row-level filter on every query.
- **Neo4j**: prefix node labels `:Arena_<clientId>:Entity` so MATCH queries are arena-scoped.
- **Qdrant**: one collection per arena (`comms_<clientId>`) — prevents cross-tenant ANN leaks.
- **Milvus**: one collection per arena (`docs_<clientId>`).
- **SQLite FTS5** (where used): row-level WHERE clause on `arena` column.

This needs to be audited in the engine code before v1 ships. Cross-tenant leakage is unacceptable.

---

## 5. AWS deployment (engine team / infra)

### Sizing for v1

| Resource | Value | Reasoning |
|---|---|---|
| EC2 instance | `m6i.2xlarge` (8 vCPU / 32 GiB) | No GPU needed (embedding is external). Headroom for Neo4j heap + Postgres + Milvus + Qdrant working sets simultaneously. |
| Volumes | 4 × `gp3` 100 GiB | One each for Postgres / Neo4j / Qdrant / Milvus. gp3 baseline IOPS is fine; provision burst headroom on Postgres. |
| AMI | Ubuntu 22.04 LTS | Familiar; well-tested with Docker. |
| Region | `us-east-1` for v1 | Cheap, low latency to most CF colos, Neo4j Aura also there if we move to managed in v2. EU customers: **flag as v2 work**. |
| Network | Private subnet, security group: outbound 443 only inbound to engine port 8099 from CF Tunnel daemon | No public engine endpoint. |
| Cost estimate | ~$340/mo on-demand; ~$210/mo with 1yr savings plan | Excludes data transfer, EBS storage, snapshots. |

### Provisioning checklist

1. VPC + private subnet + security group locked down.
2. EC2 instance with Docker + docker-compose installed.
3. Four EBS gp3 volumes attached; mounted at `/var/lib/{postgres,neo4j,qdrant,milvus}`.
4. `cloudflared` installed; tunnel registered as `engine-prod-us-east-1.pentatonic.internal` (or similar private hostname).
5. Engine cloned from `memory_stack_updated` (or pulled from `packages/memory-engine/runtime/` once moved into SDK monorepo — not blocking for v1).
6. `docker-compose.aws.yml` overlay (drafted by SDK team) layered on top of base compose.
7. `.env` with: `PENTATONIC_AI_GATEWAY_URL`, `PENTATONIC_AI_GATEWAY_KEY`, `NEO4J_AUTH`, `POSTGRES_PASSWORD`, `HMAC_SHARED_SECRET`.
8. Bring up with `docker compose -f docker-compose.yml -f docker-compose.aws.yml up -d`.
9. Curl `https://engine-prod-us-east-1.pentatonic.internal/health` from a CF Worker — expect 200 with all 7 layers `ok`.

### Backups (v1)

- Nightly EBS snapshot of all four data volumes via AWS Backup.
- 14-day retention.
- Restore drill once before going live: spin up new instance, attach restored volumes, verify engine comes back healthy.
- DR RPO: 24h (one snapshot/day). RTO: 30 min (manual restore).

### Acceptance criteria — engine in AWS

- [ ] Engine reachable from a TES Worker via `engine.pentatonic.internal`
- [ ] `/health` returns all layers `ok`
- [ ] Round-trip latency Worker → engine `/store` → Worker < 50ms p50 from same-region
- [ ] HMAC verification rejects unsigned requests with 401
- [ ] Arena scoping verified: writes for client A invisible to searches by client B
- [ ] Snapshot + restore drill completed
- [ ] CloudWatch alarms on: EC2 health, EBS volume usage > 80%, engine `/health` failure

---

## 6. TES module rebuild (TES team)

### Drop

- All current `module_deep_memory_<client_id>` schemas: `memory_nodes`, `memory_layers`, `memory_atoms`, `memory_decay_log`, etc.
- `consumers/index.js` STORE_MEMORY consumer that calls `createMemorySystem`.
- `consumers/decay.js` decay job — engine has its own decay; JS path goes away.
- All imports of `@pentatonic-ai/ai-agent-sdk/memory` from TES.

### Replace with

A new `module_pentatonic_memory` module:

- **Schema (one table per tenant)**:

  ```sql
  CREATE TABLE module_pentatonic_memory_<client_id>.events (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    operation     TEXT NOT NULL,        -- 'store' | 'search' | 'forget'
    actor_user_id TEXT,                  -- whoever auth'd the GraphQL call
    request_hash  TEXT,                  -- sha256 of request body (PII-safe)
    engine_id     TEXT,                  -- engine's record id on success
    layer_id      TEXT,                  -- whatever layerId came back if applicable
    duration_ms   INTEGER,
    status        TEXT NOT NULL,         -- 'ok' | 'engine_error' | 'auth_error' | etc.
    error_msg     TEXT
  );
  CREATE INDEX ON module_pentatonic_memory_<client_id>.events (occurred_at);
  CREATE INDEX ON module_pentatonic_memory_<client_id>.events (operation, occurred_at);
  ```

  **That's it.** No memory storage in TES. Just an audit log row per call. Used by the dashboard for "memory operations over time" + by ops for debugging "why did client X's search fail".

- **GraphQL resolvers** (signatures unchanged from current TES; implementation rewritten):

  ```graphql
  type Mutation {
    createMemory(clientId: String!, layerId: String!, content: String!, metadata: JSON): MemoryNode!
    deleteMemoryNodesByMetadata(clientId: String!, metadataKey: String!, metadataValue: String!): Int!
  }

  type Query {
    semanticSearchMemories(clientId: String!, query: String!, minScore: Float, limit: Int, layerType: String, kind: String): [MemorySearchHit!]!
    memoryLayers(clientId: String!): [MemoryLayer!]!
  }
  ```

  Resolver logic: auth → check tenant has memory enabled → forward to engine → log event → return result. Pseudo-code:

  ```js
  // createMemory resolver
  async function createMemory(_, { clientId, layerId, content, metadata }, ctx) {
    requireModuleEnabled(ctx, 'pentatonic-memory');
    const start = Date.now();
    let status = 'ok', engineId = null, errorMsg = null;
    try {
      const res = await fetchEngine('/store', {
        arena: clientId,
        content,
        metadata: { ...metadata, layer_id: layerId, actor_user_id: ctx.userId },
      });
      engineId = res.id;
      return { id: engineId, layerId, content, metadata };
    } catch (err) {
      status = 'engine_error';
      errorMsg = err.message;
      throw err;
    } finally {
      await logEvent(clientId, {
        operation: 'store',
        actor_user_id: ctx.userId,
        request_hash: sha256(content),
        engine_id: engineId,
        layer_id: layerId,
        duration_ms: Date.now() - start,
        status,
        error_msg: errorMsg,
      });
    }
  }
  ```

- **`memoryLayers` resolver**: returns a static four-layer list (`episodic`, `semantic`, `procedural`, `working`) for each tenant. Engine doesn't model layers; we keep the surface for backward-compat. May deprecate in v2.

- **Permissions**:
  - `read:memory` permission required for `semanticSearchMemories`, `memoryLayers`
  - `write:memory` for `createMemory`
  - `delete:memory:all` for `deleteMemoryNodesByMetadata` (matches existing perm model)
  - Permissions defined in `module.json` per existing TES module pattern.

- **Rate limiting**: per-tenant rate limit at the resolver boundary using existing TES rate-limit infra (whatever `module_circular_commerce` etc. use). Recommended floor: 100 req/s per tenant.

### Engine client utility

A small `lib/memoryEngine.js` in TES that handles:
- HMAC signing
- HTTP retries (3× with exponential backoff for 5xx)
- Connection pooling (Workers' `fetch` already pools)
- Endpoint resolution from `MEMORY_ENGINE_URL` env var

```js
// lib/memoryEngine.js
export async function fetchEngine(path, body) {
  const res = await fetch(`${ENGINE_URL}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-tes-client': body.arena,
      'x-tes-signature': hmacSign(JSON.stringify(body), SHARED_SECRET),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`engine_${res.status}`);
  return res.json();
}
```

### Acceptance criteria — TES module

- [ ] All four GraphQL operations work end-to-end against a dev engine deployment
- [ ] An audit-log row is written for every operation (success and failure)
- [ ] Rate limiting enforced per tenant
- [ ] No `memory_nodes`-style storage anywhere in TES
- [ ] Existing SDK `hostedAdapter` works against the new module without code change
- [ ] HMAC signing handles JSON canonicalization (key order matters; pick a deterministic order)

---

## 7. SDK changes (SDK team)

### Move into `packages/memory-engine/` — verbatim port

The repo layout from `memory_stack_updated` is preserved under `packages/memory-engine/`. **No file modifications to the engine itself.**

```
packages/memory-engine/
├── README.md             ← from memory_stack_updated/README.md (verbatim)
├── docker-compose.yml    ← from memory_stack_updated/docker-compose.yml (verbatim)
├── docker-compose.aws.yml ← NEW: hosted overlay only (this is the only added file)
├── pyproject.toml        ← from memory_stack_updated (verbatim)
├── .env.example          ← from memory_stack_updated (verbatim)
├── compat/               ← verbatim
├── engine/               ← verbatim
├── pme_memory/           ← verbatim
├── scripts/              ← verbatim
├── tests/                ← verbatim
├── docs/                 ← verbatim (incl. MIGRATION.md, why-v05-underperforms.md)
└── bench/                ← verbatim
```

The single net-new file is `docker-compose.aws.yml` — a [docker-compose extends overlay](https://docs.docker.com/compose/multiple-compose-files/extends/) that adds the `cloudflared` Tunnel daemon as a service and sets hosted-flavour env vars. The base `docker-compose.yml` is untouched.

The local-mode CLI command becomes:
```bash
docker compose -f packages/memory-engine/docker-compose.yml up -d
```

The hosted deployment runs:
```bash
docker compose -f docker-compose.yml -f docker-compose.aws.yml up -d
```

Same image, same services, same engine code, same API. The two deployments differ only in the overlay.

**Anything that turns out to need a real change inside the engine** (e.g. arena scoping bugs, contract additions, AWS-specific quirks) is an engine PR upstream, not a local divergence in our copy. If we hit something where our copy starts drifting from upstream, treat it as a process failure and reconcile.

### Rewrite `packages/memory/`

`createMemorySystem()` keeps its public shape but its innards become an HTTP client:

```js
// packages/memory/src/index.js
export function createMemorySystem(deps = {}) {
  const url = deps.engineUrl || process.env.MEMORY_ENGINE_URL || 'http://localhost:8099';
  const auth = deps.engineAuth; // { sharedSecret } for hosted, null for local
  return {
    async ingest(content, opts) {
      const res = await fetchEngine(url, auth, '/store', {
        arena: opts.clientId,
        content,
        metadata: opts.metadata || {},
      });
      return { id: res.id };
    },
    async search(query, opts) {
      const res = await fetchEngine(url, auth, '/search', {
        arena: opts.clientId,
        query,
        limit: opts.limit || 20,
        min_score: opts.minScore ?? 0.001,
        metadata_filter: opts.kind ? { kind: opts.kind } : undefined,
      });
      return res.results;
    },
    async migrate() { /* no-op — engine runs its own migrations */ },
    async ensureLayers() { /* no-op — engine doesn't model layers */ },
  };
}
```

### Drop

- `packages/memory/src/ingest.js`
- `packages/memory/src/search.js`
- `packages/memory/src/distill.js`
- `packages/memory/src/consolidate.js`
- All Postgres-direct schema + migrations under `packages/memory/migrations/`
- Ollama dependency from local mode

### Keep

- The MCP server (`packages/memory/src/server.js`) — but its tools now call the engine via HTTP instead of in-process. Same MCP surface to Claude Code; new innards.
- The corpus ingest pipeline (`packages/memory/src/corpus/`) — already uses the adapter pattern. `localAdapter` and `hostedAdapter` both rewire to call the engine.
- The hooks (`hooks/scripts/shared.js`) — already HTTP. Just point at engine port (default `localhost:8099` instead of `:3333`). Probably rename `memory_url` to `engine_url` in plugin config.

### CLI changes

- `npx @pentatonic-ai/ai-agent-sdk memory` — runs `docker-compose -f packages/memory-engine/runtime/docker-compose.yml up -d`. Pulls images from a public registry; first run is ~5GB download.
- `npx @pentatonic-ai/ai-agent-sdk doctor` — adds checks for engine `/health`, individual layer health, embedding endpoint reachability.
- `npx @pentatonic-ai/ai-agent-sdk init` — same flow, asks local-vs-hosted, but local now means "start engine via Docker compose" not "start Postgres+Ollama".

### Acceptance criteria — SDK

- [ ] `npx @pentatonic-ai/ai-agent-sdk memory` brings up the full engine stack locally on `:8099`
- [ ] All existing 527 tests pass (or tests covering dropped features are replaced with HTTP-call tests)
- [ ] Claude Code plugin works against local engine (search returns hits, store persists)
- [ ] OpenClaw plugin same
- [ ] Corpus ingest (`tes ingest <path>`) works against local and hosted engine
- [ ] No Ollama dependency anywhere in local-mode docs/CLI

---

## 8. Cloudflare Tunnel bridge

### Why Tunnel rather than public + IP allowlist

- No public engine endpoint to harden.
- TES Workers reach `engine.pentatonic.internal` as if it's internal.
- Tunnel daemon runs as one of the engine's docker-compose services — same artefact, runs alongside the engine itself.
- Auth is layered: Tunnel restricts who can reach the engine network; HMAC restricts what arenas they can read/write.

### Setup (one-time, hosted only)

1. In Cloudflare Zero Trust: create a Tunnel called `engine-prod-us-east-1`.
2. Generate Tunnel credentials JSON.
3. Add `cloudflared` service to `docker-compose.aws.yml` overlay:
   ```yaml
   cloudflared:
     image: cloudflare/cloudflared:latest
     command: tunnel --no-autoupdate run --token ${TUNNEL_TOKEN}
     restart: unless-stopped
   ```
4. In Cloudflare Tunnel config, route `engine.pentatonic.internal` → `http://compat:8099` (the compat shim's container hostname inside the docker network).
5. TES Workers add `MEMORY_ENGINE_URL=https://engine.pentatonic.internal` to their wrangler env.

### Local-OSS

No tunnel. Engine binds to `127.0.0.1:8099`. SDK clients use `MEMORY_ENGINE_URL=http://localhost:8099`.

---

## 9. Migration plan (existing hosted tenants)

For each tenant currently using TES `deep-memory`:

### Phase 1 — dual-write window

1. Deploy the new `module_pentatonic_memory` alongside the old `deep-memory`.
2. Feature-flag at the resolver level: when `MEMORY_DUAL_WRITE=true`, every `createMemory` call writes to *both* old (TES Postgres `memory_nodes`) and new (engine).
3. Reads still go to old (legacy path).
4. Run for ~7 days to capture all live writes in both stores.

### Phase 2 — backfill

5. For each tenant, dump `SELECT * FROM module_deep_memory_<client_id>.memory_nodes` → JSONL.
6. Replay through engine `/store-batch` with original `created_at` preserved as `metadata.original_created_at`.
7. Verify count: `SELECT count(*) FROM legacy` should match engine `/health` memory count for the arena.

### Phase 3 — read cutover

8. Per tenant, flip `MEMORY_READ_PATH=engine` env flag. `semanticSearchMemories` now reads engine.
9. Monitor for 48h. If recall regresses unexpectedly, flip back.
10. Once all tenants flipped, write path can stop dual-writing.

### Phase 4 — drop legacy

11. After 30 days of all tenants on engine-only, drop `module_deep_memory_*` schemas, archive snapshots, delete the consumer queues for STORE_MEMORY events.

### Acceptance criteria — migration

- [ ] Dual-write doesn't increase p95 createMemory latency by more than 50ms
- [ ] Backfill of a 100k-row tenant completes in < 1h
- [ ] Top-10 search overlap between legacy and engine ≥ 70% on a representative query set
- [ ] Zero data loss confirmed by row-count audit per tenant

---

## 10. Cross-team coordination

### Shared artefacts

- **The contract** (engine HTTP API). Frozen at v1 ship; additive-only changes after. Lives in `memory_stack_updated/docs/MIGRATION.md` (later moves to `packages/memory-engine/CONTRACT.md` in SDK).
- **The HMAC shared secret**. Generated once; stored in TES env vars + engine `.env`. Rotation procedure documented.
- **The engine hostname**. `engine-prod-us-east-1.pentatonic.internal` for hosted v1.

### Dependencies

- TES module ships *after* engine is reachable in AWS (need a real endpoint to test against).
- SDK `packages/memory/` rewrite ships *after* TES module ships (so hosted TES still works during the SDK transition).
- SDK `packages/memory-engine/` move is independent — can happen in parallel; pulls from `memory_stack_updated` until then.
- Migration starts *after* TES module is live and SDK is updated.

### Suggested order of merge

1. Engine team: AWS deployment ready, smoke-tested from a one-off Worker.
2. TES team: new module merged behind a feature flag (`MEMORY_BACKEND=engine`). Default off.
3. SDK team: `packages/memory/` rewritten as HTTP client, behind same feature flag.
4. Engine team + SDK team: `packages/memory-engine/` move done, OSS install path validated.
5. Migration: dual-write enabled per tenant, then read cutover per tenant.
6. Flip default to `engine` for new tenants; legacy stays as deprecation cycle.

---

## 11. Open questions / decisions needed before code

1. **HyDE LLM at search time** — engine-repo concern. Whatever the engine ships (built-in, external endpoint, opt-in flag) is what TES and SDK pass through. If the engine needs an LLM endpoint env var, set it to `pentatonic-ai-gateway` for hosted; user-configurable for local. We don't pre-decide the strategy here.

2. **Layer concept** — engine-repo concern whether layers exist internally. **What we commit to here**: TES's `memoryLayers` GraphQL resolver returns a static `[episodic, semantic, procedural, working]` list (dashboard back-compat); SDK passes `layerType` as `metadata.layer_type` on every call. Engine treats it as opaque metadata or models it natively — its call. Either way the GraphQL surface stays stable.

3. **Embedding dim** — Whatever `pentatonic-ai-gateway` returns is what we use; the engine's collection schemas adapt to it. This is an engine-repo concern (per the source-of-truth principle), not a v1-spec decision. SDK and TES don't care about the dim; they only care that the contract works.

4. **Audit log retention** — TES side stores one row per memory operation. At 100 req/s for a busy tenant, that's ~9M rows/day. Need a retention policy (90 days? 1 year?) and a cleanup job.

5. **GDPR / data residency** — EU tenants may require EU-region engine. v1 = us-east-1 only. We need to either (a) flag this as v2 work and not market memory to EU customers yet, or (b) stand up two engine deployments (us-east-1 + eu-west-1) and route tenants by configured region. Affects v1 scope materially.

6. **Existing TES PRs #244 + #245** (layerId-honoring + deleteByMetadata) — these were companion fixes for the *current* deep-memory module. They become moot under this v1 plan since deep-memory is being rebuilt. Either close them or merge them as defensive fixes for the deprecation window. Recommendation: close, document the rebuild context.

7. **Cost ceiling** — v1 hosted ~$340/mo on-demand for one EC2 + 4 EBS volumes + Tunnel + AI gateway calls. Acceptable? If we want to stay under $200, drop to `m6i.xlarge` (4 vCPU, $170/mo) but Neo4j heap + Postgres + Milvus working sets get tight.

---

## 12. Out-of-band items (track separately)

- Documentation site update — Memory and Observability split (we have the README repositioning ready in a stash; blocked behind v1 wiring).
- Pricing/billing — memory operations metered separately from observability events. Needs product input.
- SLA definition for hosted memory — uptime, p99 latency, durability.
- Marketing / external announcement — coordinate with launching the split README.
- `@pentatonic-ai/ai-agent-sdk` rename — discussed but deferred. v1 ships under existing package name.

---

## 13. Glossary

- **Engine** — the 7-layer memory backend, lives in `packages/memory-engine/` (post-move) and is currently in `Pentatonic-Ltd/memory_stack_updated`.
- **Module** — a TES feature unit (e.g. `module_pentatonic_memory`, `module_deep_memory`). Has its own schema + resolvers + permissions.
- **Arena** — the engine's word for "tenant". TES sets it to `clientId`.
- **Compat shim** — the FastAPI service at engine port 8099 that translates v0.5.x-compatible HTTP calls into L2 orchestrator calls.
- **L0–L6** — the seven retrieval layers (BM25, core files, orchestrator, KG, vec, comms, doc store + reranker). See engine README.
- **HyDE** — Hypothetical Document Embeddings; query expansion technique.
- **HMAC** — keyed hash for signed-request authentication between TES and engine.

---

End of v1 spec. Reply on this PR / in `#memory-engine` with feedback before code starts moving.
