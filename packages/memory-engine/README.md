# pentatonic-memory-engine

**Drop-in replacement for `pentatonic-memory` v0.5.x with a 7-layer retrieval stack underneath.**

| Configuration | Mean accuracy* | p50 latency |
|---|---|---|
| pentatonic-memory v0.5.6 (current OSS) | 17.6% | 33ms |
| pentatonic-memory v0.4.7 (legacy OSS) | 38.8% | 27ms |
| **pentatonic-memory-engine — fast path** (L6-only via docker, default config) | **84.6%** | **110ms** |
| **pentatonic-memory-engine — max accuracy** (full 7-layer L2 fusion) | **85.7%** | **1241ms** |
| langmem (in-process) | 83.0% | 121ms |
| cognee | 82.1% | 192ms |
| single-store baseline | 79.3% | 110ms |

\* Mean over 6 commerce-domain benches (agent-coding, chat-recall, circular-economy, customer-support, marketplace-ops, product-catalogue) using substring grading. Full reports under `bench/`.

**Two configurations, same package.** The fast path (L6-only) is the default and ships at #1 on accuracy among real OSS memory stacks. The max-accuracy 7-layer mode adds Knowledge-Graph entity matching + L0 BM25 + L4 vec fusion via the L2 orchestrator — buys you +1.1pp at 11× latency. Pick per workload (live agent loop → fast path; offline batch / accuracy-graded eval → 7-layer).

---

## What this is

A self-contained docker-compose package that exposes the **same HTTP API as `pentatonic-memory`** (`/store`, `/search`, `/health`), plus two regression-fix endpoints (`/store-batch`, `/forget`) — but routes every call through a 7-layer hybrid retrieval engine instead of the single Postgres + pgvector store.

Same client code. Same SDK. ~5x better accuracy on retrieval-style benchmarks.

## Why does the existing OSS underperform?

Detailed analysis in `docs/why-v05-underperforms.md`. Short version:

- Single vector store (pgvector), single embedding per row → diluted vectors on long content
- `atomBoost: +0.15` makes LLM-paraphrased atoms outrank source verbatim → substring grading fails
- HyDE generated at ingest time (60s LLM call per /store), not at query time
- pgvector HNSW broken at >2000 dims → 4096d NV-Embed falls back to sequential scan
- No reranker, no graph traversal, no multi-store fusion

## Architecture (7-layer)

The engine is the same `sequential-hybridrag-7-layer` stack the L2 proxy reports in its health endpoint.

```
                                                     ┌──────────────────┐
                                                     │  L0  BM25 (FTS)  │
                                                     ├──────────────────┤
                                                     │  L1  Core files  │
                  POST /store    ┌──────────────┐   ├──────────────────┤
                  POST /search   │ compat shim  │   │  L2  HybridRAG   │
client (any) ───► POST /forget ──►   (FastAPI)  │──►│      orchestrator│
                  POST /store-batch└──────────────┘   ├──────────────────┤
                  GET  /health                       │  L3  Knowledge    │
                                                     │      Graph (KG)   │
                                                     ├──────────────────┤
                                                     │  L4  sqlite-vec   │
                                                     ├──────────────────┤
                                                     │  L5  Qdrant comms │
                                                     ├──────────────────┤
                                                     │  L6  Document     │
                                                     │      Store +      │
                                                     │      reranker     │
                                                     └─────────┬────────┘
                                                               │
                                              ┌────────────────┴───────┐
                                              │  NV-Embed-v2            │
                                              │  Cross-encoder reranker │
                                              └─────────────────────────┘
```

Each layer indexes the same content differently. Search runs all seven in parallel and fuses results via Reciprocal Rank Fusion (RRF). Different query types win on different layers — agent-coding queries land on L0 BM25, chat-recall on L5, multi-hop entity questions on L3, conversational context on L1.

**Layer cheat-sheet:**

| # | Layer | Purpose | Backing tech |
|---|---|---|---|
| L0 | BM25 | Lexical / keyword recall | SQLite FTS5 |
| L1 | Core files | Always-loaded high-priority text (system manuals, key docs) | flat markdown read by L2 |
| L2 | HybridRAG orchestrator | Fan-out + RRF fusion across all layers | Python FastAPI |
| L3 | Knowledge Graph | Entity-aware retrieval, multi-hop relationships | Neo4j (OSS) |
| L4 | Vector index | High-recall semantic search | sqlite-vec |
| L5 | Comms / multi-collection vectors | Chat / email / contact / memory namespaces | Qdrant |
| L6 | Document store | Per-arena docs + cross-encoder reranker | sqlite + Milvus + MiniLM |

## Quick start

```bash
git clone <this-repo>
cd pentatonic-memory-engine
cp .env.example .env       # set NEO4J_AUTH, etc.
docker compose up -d
```

Wait ~30s for layers to come up. Verify:

```bash
curl http://localhost:8099/health
# → {"status":"ok","layers":{"l0":"ok","l1":"ok","l2":"ok","l3":"ok","l4":"ok","l5":"ok","l6":"ok"},"engine":"pentatonic-memory-engine"}
```

Now point your existing `pentatonic-memory` SDK client at `http://localhost:8099` — no code change.

### Picking a mode

Both modes share the same `docker compose up -d` and the same HTTP API. Switch via one env var on the `compat` container:

```bash
# Fast path — L6-only, 84.6% / 110ms p50  (default)
BYPASS_L2_PROXY=1 docker compose up -d compat

# Max accuracy — full 7-layer L2 fusion, 85.7% / 1241ms p50
BYPASS_L2_PROXY=0 docker compose up -d compat
```

| Mode | Mean acc | p50 | When to use |
|---|---|---|---|
| L6-only (default) | 84.6% | 110ms | Live agent calls, latency-sensitive paths |
| 7-layer fusion | 85.7% | 1241ms | Offline batch retrieval, accuracy-graded eval, multi-hop entity queries |

Both modes populate all 7 layers on `/store-batch` (since v0.2). The mode flag only changes which layers the **search** path queries.

## API compatibility

| Endpoint | v0.5 | This package | Notes |
|---|---|---|---|
| `POST /store` | ✅ | ✅ | Same request/response shape |
| `POST /search` | ✅ | ✅ | Same request/response shape; ?mode=vector/text both supported |
| `GET /health` | ✅ | ✅ | Returns aggregate health across all 7 layers |
| `POST /store-batch` | ❌ | ✅ | New: batch-ingest N records in one HTTP call (30-50× faster) |
| `POST /forget` | ❌ (regression) | ✅ | Restored from v0.4.x; supports `metadata_contains` filter |

Migration: see `docs/MIGRATION.md`.


