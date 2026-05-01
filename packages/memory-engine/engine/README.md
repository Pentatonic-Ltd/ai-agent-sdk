# engine/

Bundled engine layers for the Pentatonic Memory Engine.

| File | Layer | LOC | Purpose |
|---|---|---|---|
| `l2-hybridrag-proxy.py` | L2 | ~1.5k | RRF fusion across all layers, exposed on `:8031` |
| `l5-comms-layer.py` | L5 | ~0.7k | Milvus comms layer for chat/email/contact/memory collections, exposed on `:8034` |
| `l6-document-store.py` | L6 | ~1.5k | Document store + cross-encoder reranker, exposed on `:8037` |
| `services/nv-embed/server.py` | — | ~150 | NV-Embed-v2 4096-dim embedding service, exposed on `:8041` |

## pme_memory SDK

The `pme_memory/` package at the repo root is an installable Python SDK for the L5 communications layer. It provides:

- **store.py** — Milvus client and collection management (chats, emails, contacts, memory)
- **search.py** — Semantic search across collections
- **embed.py** — Dual-stack embedding (NV-Embed-v2 primary, Ollama fallback)
- **indexer.py** — Data ingestion pipeline (JSONL chats, email archives, contacts, memory files)
- **scoring.py** — Pressure scoring for need signals (recency, novelty, centrality, priority)
- **synthesis.py** — Deterministic multi-parent artifact merge
- **artifacts.py** — Append-only artifact DAG store (JSONL)
- **hygiene.py** — DAG maintenance (dedup, conflict detection, orphan pruning)
- **health.py** — L5 health check
- **needs.py** — Need signal indexing
- **provenance.py** — Lineage visualization

Install: `pip install -e ".[full]"` — CLI: `pme-memory health|stats|index|search|serve`

## KG Extraction Scripts

The `scripts/` directory contains Knowledge Graph population tools:

- **kg-extractor.py** — spaCy + regex entity/relationship extraction from memory files → Neo4j
- **kg-preflexor-v2.py** — 2-pass concurrent LLM-based extraction via Ollama (14 structured entity types + native graph discovery)

## Where L0, L3 and the embedding service live

- **L0 BM25** — provided by SQLite FTS5; the L2 proxy queries it directly via `sqlite3`. No separate service binary.
- **L3 Knowledge Graph** — provided by Neo4j Community (free, OSS) running in a sibling container. The proxy queries it via the bolt protocol on `:7687`.
- **NV-Embed-v2 embedding service** — see `services/nv-embed/` for the Docker context. Exposes the OpenAI-compatible `/v1/embeddings` endpoint on `:8041`.

## Dependencies

Each service has its own `requirements.txt` in `services/<layer>/`. Common heavy deps:

- `pymilvus>=2.6.12` (L5)
- `sentence-transformers` (L6 reranker, NV-Embed)
- `httpx`, `fastapi`, `uvicorn` (all)
- `spacy` (L6 entity extraction)

NV-Embed needs Torch + the model weights (auto-downloaded on first run from Hugging Face).
