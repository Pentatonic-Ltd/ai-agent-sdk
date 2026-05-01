# Benchmark Results

All runs were conducted on **DGX Spark GB10** (10-core ARM CPU, 128GB unified memory, NVIDIA GB10 SoC) on **2026-04-27**.

## Summary

| Stack | Mean accuracy | Mean p50 latency | Coverage |
|---|---|---|---|
| **pentatonic-memory-engine — 7-layer fusion** | **85.7%** | 1241ms | 6/6 |
| **pentatonic-memory-engine — L6-only fast path** | **84.6%** | 110ms | 6/6 |
| pentatonic-memory v0.4.7 (current canonical OSS) | 38.8% | 27ms | 6/6 |
| pentatonic-memory v0.5.6 (latest OSS) | 17.6% | 33ms | 6/6 |

Both pentatonic-memory baselines were freshly purged before the run (no stale data pollution). Both modes of `pentatonic-memory-engine` ship in the same docker-compose package — one env var (`BYPASS_L2_PROXY`) toggles between fast path and 7-layer fusion.

## Per-bench breakdown

| Bench | 7-layer | L6-only | v0.4.7 | v0.5.6 |
|---|---|---|---|---|
| agent-coding | 100.0% (22/22) | 100.0% (22/22) | 63.6% (14/22) | 9.1% (2/22) |
| chat-recall | 100.0% (16/16) | 100.0% (16/16) | 12.5% (2/16) | 0.0% (0/16) |
| circular-economy | 76.0% (19/25) | 80.0% (20/25) | 40.0% (10/25) | 32.0% (8/25) |
| customer-support | 75.0% (15/20) | 70.0% (14/20) | 25.0% (5/20) | 5.0% (1/20) |
| marketplace-ops | 80.0% (16/20) | 80.0% (16/20) | 25.0% (5/20) | 15.0% (3/20) |
| product-catalogue | 83.3% (15/18) | 77.8% (14/18) | 66.7% (12/18) | 44.4% (8/18) |
| **MEAN** | **85.7%** | **84.6%** | **38.8%** | **17.6%** |

### When does 7-layer fusion help?

Layer-by-layer effect over L6-only:

- **+5.6pp on product-catalogue** — KG entity matching pulls related SKUs / materials in one hop; L0 BM25 catches part numbers that vector search alone misses.
- **+5.0pp on customer-support** — Multi-hop entity resolution (customer → order → policy) lifts retrieval where pure semantic search loses the relationship.
- **Tied on agent-coding, chat-recall, marketplace-ops** — L6 already saturated (100%, 100%, 80%); extra layers add nothing.
- **−4.0pp on circular-economy** — Extra layers add noise on this sustainability corpus; L6's reranker alone is the better signal.

Net: +1.1pp accuracy at 11× latency cost. Use 7-layer for accuracy-graded eval and offline batch retrieval; stay on L6-only for live agent calls.

## Bench corpora

The 6 benches use commerce-domain corpora that overlap Pentatonic's actual product space:

- `agent-coding` — 22 questions over 22 docs (TES + agent SDK source/docs)
- `chat-recall` — 16 questions over a 16-turn chat transcript
- `circular-economy` — 25 questions over 25 sustainability docs
- `customer-support` — 20 questions over a 20-doc support knowledge base
- `marketplace-ops` — 20 questions over 20 marketplace listings
- `product-catalogue` — 18 questions over an 18-SKU product catalogue

All grading uses **substring match**: a hit is correct if the retrieved text contains the literal answer string. This is the strictest grading mode and the closest analogue to "did the SDK return a chunk that actually answers the question."

## Reproduce

```bash
# Bring up the engine
cd pentatonic-memory-engine && docker compose up -d

# Wait for healthy
until curl -sf http://localhost:8099/health | grep -q '"status":"ok"'; do sleep 2; done

# Set up the bench harness
cd ~/pentatonic-memory-bench
pip install -e .

# Run the L6-only fast path (default)
PENTATONIC_MEMORY_URL=http://localhost:8099 \
  python -m pentatonic_bench.cli run -b chat-recall -s pentatonic-memory -k 3

# Run the 7-layer fusion (toggle BYPASS_L2_PROXY=0 + restart compat)
BYPASS_L2_PROXY=0 docker compose up -d --force-recreate compat
PENTATONIC_MEMORY_URL=http://localhost:8099 \
  python -m pentatonic_bench.cli run -b chat-recall -s pentatonic-memory -k 3
```

## Comparison to other open-source memory stacks

| Stack | Mean acc | Mean p50 | Notes |
|---|---|---|---|
| 🥇 **pentatonic-memory-engine — 7-layer** | **85.7%** | **1241ms** | This package, full L2 fusion |
| 🥈 **pentatonic-memory-engine — L6-only** | **84.6%** | **110ms** | This package, fast path |
| 🥉 langmem | 83.0% | 121ms | LangChain's in-process memory; no HTTP/embedding overhead |
| cognee | 82.1% | 192ms | Graph + vector hybrid, KG-first |
| single-store baseline | 79.3% | 110ms | Single vector store + sentence-transformers |
| llamaindex | 79.3% | 203ms | LlamaIndex with default config |
| bm25-baseline | 75.9% | 0ms | Pure SQLite FTS5, no embeddings |
| pentatonic-memory v0.4.7 | 38.8% | 27ms | Current canonical OSS |
| graphiti | 30.1% | 156ms | Graph-only, no vector |
| pentatonic-memory v0.5.6 | 17.6% | 33ms | Latest OSS |

Engine beats every other OSS memory stack on accuracy in both modes. The L6-only fast path matches langmem's latency profile while delivering +1.6pp accuracy. The 7-layer mode is the genuine #1 on accuracy across all benchmarked stacks.

## Raw scorecards

- `scorecards-engine-via-docker/` — 6 JSON scorecards, L6-only fast path (84.6% mean / 110ms p50)
- `scorecards-engine-via-l2-7-layer-populated/` — 6 JSON scorecards, full 7-layer fusion (85.7% mean / 1241ms p50)
- `scorecards-engine-via-l2-empty-layers/` — earlier experiment, 7-layer with empty L0/L4-qmd/L3 (82.1%, rolled back; superseded by populated 7-layer)
- `scorecards-engine-via-shim/` — earlier experiment, shim-direct ingestion path
- `scorecards-engine/` — initial bench (1183ms, before L6-only optimisation)
- `scorecards-pentatonic-baseline/` — 12 JSON scorecards (6 per stack) for the v0.4.7 and v0.5.6 baselines
