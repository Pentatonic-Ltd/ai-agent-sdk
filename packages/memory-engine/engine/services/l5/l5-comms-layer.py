#!/usr/bin/env python3
"""L5 Communications Layer — Deep semantic search over life data.

Collections:
  - chats: Telegram, WhatsApp, iMessage, Slack transcripts
  - emails: Email archives (markdown summaries)
  - contacts: People profiles + contact records
  - memory: Daily notes, project docs, research files

Usage:
  python3 l5-comms-layer.py index          # Index all sources
  python3 l5-comms-layer.py index chats    # Index just chats
  python3 l5-comms-layer.py search "query" # Search across all collections
  python3 l5-comms-layer.py search "query" --collection chats
  python3 l5-comms-layer.py health         # Health check
  python3 l5-comms-layer.py stats          # Collection stats
  python3 l5-comms-layer.py serve          # Run as HTTP server (port 8034)
"""

import argparse
import logging
import os
import glob
import hashlib
import json
import time
from datetime import datetime
from pathlib import Path

import httpx
from pymilvus import MilvusClient, DataType, CollectionSchema, FieldSchema

# --- Config ---
DB_PATH = os.environ.get(
    "L5_DB_PATH",
    str(Path.home() / "memory-l5" / "comms.db"),
)
WORKSPACE = Path(os.environ.get("PME_WORKSPACE", ".pentatonic"))
CLAWD_CHATS_DIR = Path.home() / "clawd" / "chats"  # Legacy archive
CHATS_DIR = WORKSPACE / "chats"
EMAILS_DIR = WORKSPACE / "memory" / "chats" / "email"
PEOPLE_DIR = WORKSPACE / "memory" / "people"
CONTACTS_DIR = WORKSPACE / "memory" / "contacts"
MEMORY_DIR = WORKSPACE / "memory"

NV_EMBED_URL = os.environ.get("L5_NV_EMBED_URL", "http://localhost:8041/v1/embeddings")
# Embedding model name sent in /v1/embeddings request body. Defaults to
# the production NV-Embed-v2 name; override when pointing at a different
# OpenAI-compat endpoint (e.g. Ollama with nomic-embed-text).
EMBED_MODEL_NAME = os.environ.get("L5_EMBED_MODEL", "nv-embed-v2")
# Optional Authorization: Bearer <key> for the primary embedding endpoint.
EMBED_API_KEY = os.environ.get("L5_EMBED_API_KEY", "")

def _embed_headers() -> dict:
    return {"Authorization": f"Bearer {EMBED_API_KEY}"} if EMBED_API_KEY else {}
# Ollama fallback path. URL/model can be overridden so the L5 container can
# reach an Ollama instance running on the docker host (host.docker.internal)
# or on a co-located service. Mirrors the env-var pattern used by L2.
OLLAMA_EMBED_URL = os.environ.get(
    "L5_OLLAMA_EMBED_URL", "http://localhost:11434/api/embed"
)
OLLAMA_EMBED_MODEL = os.environ.get("L5_OLLAMA_EMBED_MODEL", "nomic-embed-text")
# Vector dim. Default matches NV-Embed-v2; override for smaller-dim models
# (e.g. 768 for nomic-embed-text, 1024 for mxbai-embed-large). Milvus
# collections are created at this dim; existing data won't survive a dim
# change — wipe the L5 volume to switch.
EMBED_DIM = int(os.environ.get("L5_EMBED_DIM", "4096"))
# Dim of the Ollama-fallback model. If equal to EMBED_DIM, the fallback
# returns vectors as-is; if smaller, they're zero-padded to EMBED_DIM.
OLLAMA_DIM = int(os.environ.get("L5_OLLAMA_DIM", "768"))
CHUNK_SIZE = 512  # chars per chunk
CHUNK_OVERLAP = 64
BATCH_SIZE = 100  # embeddings per batch


def get_client():
    return MilvusClient(uri=DB_PATH)


def embed_texts(texts: list[str]) -> list[list[float]]:
    """Get embeddings — NV-Embed-v2 batch primary, Ollama fallback."""
    # Try batch NV-Embed first
    batch_result = _embed_nv_batch(texts)
    if batch_result is not None:
        return batch_result
    # Fallback: one at a time
    results = []
    for text in texts:
        emb = _embed_nv_single(text)
        if emb is None:
            emb = _embed_ollama(text)
        results.append(emb if emb else [0.0] * EMBED_DIM)
    return results


def _embed_nv_batch(texts: list[str]) -> list[list[float]] | None:
    """Batch embed via NV-Embed-v2 (4096-dim). Returns None on failure."""
    if not texts:
        return []
    try:
        truncated = [t[:4000] for t in texts]
        r = httpx.post(NV_EMBED_URL, headers=_embed_headers(), json={"input": truncated, "model": EMBED_MODEL_NAME}, timeout=120)
        r.raise_for_status()
        data = r.json()
        embeddings = [item["embedding"] for item in data["data"]]
        if all(len(e) == EMBED_DIM for e in embeddings):
            return embeddings
    except Exception:
        logging.debug(f"Suppressed error in l5-comms-layer.py")
    return None


def _embed_nv_single(text: str) -> list[float] | None:
    """Embed single text via NV-Embed-v2 (4096-dim)."""
    try:
        r = httpx.post(NV_EMBED_URL, headers=_embed_headers(), json={"input": text[:4000], "model": EMBED_MODEL_NAME}, timeout=15)
        r.raise_for_status()
        data = r.json()
        emb = data["data"][0]["embedding"]
        if len(emb) == EMBED_DIM:
            return emb
    except Exception:
        logging.debug(f"Suppressed error in l5-comms-layer.py")
    return None


def _embed_ollama(text: str) -> list[float] | None:
    """Fallback: Ollama nomic-embed (768-dim), zero-padded to EMBED_DIM."""
    try:
        r = httpx.post(OLLAMA_EMBED_URL, json={"model": OLLAMA_EMBED_MODEL, "input": text}, timeout=30)
        r.raise_for_status()
        data = r.json()
        emb = data.get("embeddings", [data.get("embedding", [])])[0]
        if isinstance(emb, list) and len(emb) == OLLAMA_DIM:
            # Zero-pad to 4096 for Milvus compatibility
            return emb + [0.0] * (EMBED_DIM - OLLAMA_DIM)
    except Exception as e:
        print(f"  Embed error: {e}")
    return None


def chunk_text(text: str, chunk_size=CHUNK_SIZE, overlap=CHUNK_OVERLAP) -> list[str]:
    """Split text into overlapping chunks."""
    if len(text) <= chunk_size:
        return [text] if text.strip() else []
    chunks = []
    start = 0
    while start < len(text):
        end = start + chunk_size
        chunk = text[start:end].strip()
        if chunk:
            chunks.append(chunk)
        start = end - overlap
    return chunks


def text_id(text: str, source: str) -> str:
    return hashlib.md5(f"{source}:{text[:200]}".encode()).hexdigest()


def ensure_collection(client, name: str):
    """Create collection if not exists."""
    if client.has_collection(name):
        return
    schema = client.create_schema(auto_id=False, enable_dynamic_field=True)
    schema.add_field("id", DataType.VARCHAR, is_primary=True, max_length=64)
    schema.add_field("vector", DataType.FLOAT_VECTOR, dim=EMBED_DIM)
    schema.add_field("text", DataType.VARCHAR, max_length=8192)
    schema.add_field("source", DataType.VARCHAR, max_length=512)
    schema.add_field("channel", DataType.VARCHAR, max_length=64)
    schema.add_field("contact", DataType.VARCHAR, max_length=256)
    schema.add_field("timestamp", DataType.VARCHAR, max_length=32)

    index_params = client.prepare_index_params()
    index_params.add_index(field_name="vector", index_type="FLAT", metric_type="COSINE")
    client.create_collection(collection_name=name, schema=schema, index_params=index_params)
    print(f"  Created collection: {name}")


# --- Indexers ---

def index_chats(client):
    """Index JSONL chat transcripts."""
    ensure_collection(client, "chats")
    total = 0

    # Walk all JSONL files under chats/
    jsonl_files = list(CHATS_DIR.rglob("*.jsonl"))
    # Also grab .txt chat exports
    txt_files = list(CHATS_DIR.rglob("*.txt"))

    print(f"  Found {len(jsonl_files)} JSONL + {len(txt_files)} TXT chat files")

    for f in jsonl_files:
        try:
            lines = f.read_text(errors="replace").strip().split("\n")
            batch_data = []

            for line in lines:
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError:
                    continue

                text = msg.get("text", "")
                if not text or len(text) < 10:
                    continue

                channel = msg.get("channel", "unknown")
                contact = msg.get("contact", msg.get("sender", ""))
                ts = msg.get("timestamp", "")
                source = str(f.relative_to(WORKSPACE))

                for chunk in chunk_text(text):
                    doc_id = text_id(chunk, source)
                    batch_data.append({
                        "id": doc_id,
                        "text": chunk[:8000],
                        "source": source[:500],
                        "channel": channel[:60],
                        "contact": str(contact)[:250],
                        "timestamp": str(ts)[:30],
                    })

                    if len(batch_data) >= BATCH_SIZE:
                        vectors = embed_texts([d["text"] for d in batch_data])
                        for d, v in zip(batch_data, vectors):
                            d["vector"] = v
                        client.upsert(collection_name="chats", data=batch_data)
                        total += len(batch_data)
                        batch_data = []

            # Flush remaining
            if batch_data:
                vectors = embed_texts([d["text"] for d in batch_data])
                for d, v in zip(batch_data, vectors):
                    d["vector"] = v
                client.upsert(collection_name="chats", data=batch_data)
                total += len(batch_data)

        except Exception as e:
            print(f"  Error indexing {f}: {e}")

    # Index markdown chat summaries
    for channel_dir in ["telegram", "whatsapp", "imessage", "slack", "unknown"]:
        chat_md_dir = WORKSPACE / "memory" / "chats" / channel_dir
        if not chat_md_dir.exists():
            continue
        for f in chat_md_dir.glob("*.md"):
            try:
                text = f.read_text(errors="replace")
                if len(text) < 20:
                    continue
                source = str(f.relative_to(WORKSPACE))
                batch_data = []
                for chunk in chunk_text(text):
                    doc_id = text_id(chunk, source)
                    batch_data.append({
                        "id": doc_id,
                        "text": chunk[:8000],
                        "source": source[:500],
                        "channel": channel_dir,
                        "contact": f.stem[:250],
                        "timestamp": "",
                    })
                if batch_data:
                    vectors = embed_texts([d["text"] for d in batch_data])
                    for d, v in zip(batch_data, vectors):
                        d["vector"] = v
                    client.upsert(collection_name="chats", data=batch_data)
                    total += len(batch_data)
            except Exception as e:
                print(f"  Error indexing {f}: {e}")

    print(f"  Indexed {total} chat chunks")
    return total


def index_emails(client):
    """Index email archives."""
    ensure_collection(client, "emails")
    total = 0

    if not EMAILS_DIR.exists():
        print("  No email directory found")
        return 0

    for f in EMAILS_DIR.glob("*.md"):
        try:
            text = f.read_text(errors="replace")
            if len(text) < 20:
                continue
            source = str(f.relative_to(WORKSPACE))
            # Extract contact from filename
            contact = f.stem.replace("", "").replace("_", " ")[:250]
            batch_data = []
            for chunk in chunk_text(text):
                doc_id = text_id(chunk, source)
                batch_data.append({
                    "id": doc_id,
                    "text": chunk[:8000],
                    "source": source[:500],
                    "channel": "email",
                    "contact": contact,
                    "timestamp": "",
                })
            if batch_data:
                vectors = embed_texts([d["text"] for d in batch_data])
                for d, v in zip(batch_data, vectors):
                    d["vector"] = v
                client.upsert(collection_name="emails", data=batch_data)
                total += len(batch_data)
        except Exception as e:
            print(f"  Error indexing {f}: {e}")

    print(f"  Indexed {total} email chunks")
    return total


def index_contacts(client):
    """Index people profiles and contacts."""
    ensure_collection(client, "contacts")
    total = 0

    # People profiles
    if PEOPLE_DIR.exists():
        for f in PEOPLE_DIR.glob("*.md"):
            try:
                text = f.read_text(errors="replace")
                if len(text) < 20:
                    continue
                source = str(f.relative_to(WORKSPACE))
                batch_data = []
                for chunk in chunk_text(text):
                    doc_id = text_id(chunk, source)
                    batch_data.append({
                        "id": doc_id,
                        "text": chunk[:8000],
                        "source": source[:500],
                        "channel": "profile",
                        "contact": f.stem[:250],
                        "timestamp": "",
                    })
                if batch_data:
                    vectors = embed_texts([d["text"] for d in batch_data])
                    for d, v in zip(batch_data, vectors):
                        d["vector"] = v
                    client.upsert(collection_name="contacts", data=batch_data)
                    total += len(batch_data)
            except Exception as e:
                print(f"  Error: {e}")

    # Contact files
    if CONTACTS_DIR.exists():
        for f in CONTACTS_DIR.glob("*"):
            if not f.is_file():
                continue
            try:
                text = f.read_text(errors="replace")
                if len(text) < 20:
                    continue
                source = str(f.relative_to(WORKSPACE))
                batch_data = []
                for chunk in chunk_text(text, chunk_size=1024):
                    doc_id = text_id(chunk, source)
                    batch_data.append({
                        "id": doc_id,
                        "text": chunk[:8000],
                        "source": source[:500],
                        "channel": "contacts",
                        "contact": "",
                        "timestamp": "",
                    })
                if batch_data:
                    vectors = embed_texts([d["text"] for d in batch_data])
                    for d, v in zip(batch_data, vectors):
                        d["vector"] = v
                    client.upsert(collection_name="contacts", data=batch_data)
                    total += len(batch_data)
            except Exception as e:
                print(f"  Error: {e}")

    print(f"  Indexed {total} contact chunks")
    return total


def index_memory(client):
    """Index memory markdown files (daily notes, projects, research, rules)."""
    ensure_collection(client, "memory")
    total = 0

    # Skip chats/ (handled separately) and evolution run logs (too many, low value)
    skip_patterns = ["chats/", "evolution/loop-run-", "evolution/v3/runs/"]

    for f in MEMORY_DIR.rglob("*.md"):
        source = str(f.relative_to(WORKSPACE))
        if any(p in source for p in skip_patterns):
            continue
        try:
            text = f.read_text(errors="replace")
            if len(text) < 30:
                continue
            batch_data = []
            for chunk in chunk_text(text):
                doc_id = text_id(chunk, source)
                batch_data.append({
                    "id": doc_id,
                    "text": chunk[:8000],
                    "source": source[:500],
                    "channel": "memory",
                    "contact": "",
                    "timestamp": "",
                })
            if batch_data:
                vectors = embed_texts([d["text"] for d in batch_data])
                for d, v in zip(batch_data, vectors):
                    d["vector"] = v
                client.upsert(collection_name="memory", data=batch_data)
                total += len(batch_data)
        except Exception as e:
            print(f"  Error: {e}")

    print(f"  Indexed {total} memory chunks")
    return total


# --- Search ---

def search(query: str, collection: str = None, limit: int = 10):
    """Search across collections."""
    client = get_client()
    vectors = embed_texts([query])
    if not vectors or all(v == 0.0 for v in vectors[0]):
        print("Failed to embed query")
        return []

    collections = [collection] if collection else ["chats", "emails", "contacts", "memory"]
    all_results = []

    for coll in collections:
        if not client.has_collection(coll):
            continue
        try:
            results = client.search(
                collection_name=coll,
                data=[vectors[0]],
                limit=limit,
                output_fields=["text", "source", "channel", "contact", "timestamp"],
            )
            for hits in results:
                for hit in hits:
                    entity = hit.get("entity", {})
                    all_results.append({
                        "collection": coll,
                        "score": round(hit.get("distance", 0), 4),
                        "text": entity.get("text", ""),
                        "source": entity.get("source", ""),
                        "channel": entity.get("channel", ""),
                        "contact": entity.get("contact", ""),
                        "timestamp": entity.get("timestamp", ""),
                    })
        except Exception as e:
            print(f"  Search error in {coll}: {e}")

    all_results.sort(key=lambda x: x["score"], reverse=True)
    return all_results[:limit]


# --- Health / Stats ---

def health():
    """Check L5 health."""
    try:
        client = get_client()
        collections = ["chats", "emails", "contacts", "memory"]
        status = {"status": "ok", "db_path": DB_PATH, "collections": {}}
        for coll in collections:
            if client.has_collection(coll):
                stats = client.get_collection_stats(coll)
                count = stats.get("row_count", 0)
                status["collections"][coll] = {"exists": True, "count": count}
            else:
                status["collections"][coll] = {"exists": False, "count": 0}
        total = sum(c["count"] for c in status["collections"].values())
        status["total_chunks"] = total
        # Check embeddings
        try:
            r = httpx.get("http://localhost:11434/api/tags", timeout=3)
            models = [m["name"] for m in r.json().get("models", [])]
            status["embeddings"] = EMBED_MODEL in str(models)
        except Exception:
            status["embeddings"] = False
        return status
    except Exception as e:
        return {"status": "error", "error": str(e)}


def stats():
    """Print collection stats."""
    h = health()
    print(f"\nL5 Communications Layer — {h.get('status', 'unknown')}")
    print(f"DB: {h.get('db_path', '?')}")
    print(f"Embeddings: {'OK' if h.get('embeddings') else 'UNAVAILABLE'}")
    print(f"\nCollections:")
    for name, info in h.get("collections", {}).items():
        if info["exists"]:
            print(f"  {name}: {info['count']:,} chunks")
        else:
            print(f"  {name}: not created")
    print(f"\nTotal: {h.get('total_chunks', 0):,} chunks")


# --- HTTP Server ---

def serve(port=8034):
    """Run as HTTP API server."""
    from fastapi import FastAPI, Query
    import uvicorn

    api = FastAPI(title="L5 Communications Layer")

    @api.get("/health")
    def api_health():
        return health()

    @api.get("/search")
    def api_search(q: str = Query(...), collection: str = None, limit: int = 10):
        results = search(q, collection=collection, limit=limit)
        return {"query": q, "results": results, "count": len(results)}

    @api.get("/stats")
    def api_stats():
        return health()

    @api.post("/index-batch")
    def api_index_batch(req: dict):
        """Index a batch of pre-formed records using a single batched
        NV-Embed call + a single milvus insert. Roughly 30-50x faster
        than calling /index for each item or running the legacy
        per-chunk indexers, which is critical for tests, smoke runs and
        bench harnesses where a few dozen docs need to land quickly.

        Request body::

            {
              "collection": "chats",         # one of: chats|emails|contacts|memory
              "records": [
                {
                  "id": "opt-stable-id",      # optional, auto-generated if absent
                  "text": "…",                 # required
                  "source": "…",               # optional
                  "channel": "…",              # optional
                  "contact": "…"               # optional
                }, …
              ]
            }

        Returns::

            {"status": "ok", "collection": "chats", "inserted": N,
             "embed_ms": float, "insert_ms": float}
        """
        import time as _time, hashlib as _hashlib
        collection = req.get("collection", "chats")
        records = req.get("records") or []
        if not records:
            return {"status": "ok", "inserted": 0, "collection": collection}

        client = get_client()
        ensure_collection(client, collection)

        # Single batched embed call.
        texts = [(r.get("text") or "")[:8192] for r in records]
        t0 = _time.time()
        try:
            resp = httpx.post(
                NV_EMBED_URL, headers=_embed_headers(), json={"input": texts, "model": EMBED_MODEL_NAME},
                timeout=120,
            )
            resp.raise_for_status()
            embs = [d["embedding"] for d in resp.json()["data"]]
        except Exception as exc:
            return {"status": "error", "error": f"embed failed: {exc}"}
        embed_ms = (_time.time() - t0) * 1000.0

        # Single batched insert. Mirror every field the chats collection
        # schema requires (id/vector/text/source/channel/contact/timestamp).
        from datetime import datetime as _dt, timezone as _tz
        _now = _dt.now(_tz.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        rows = []
        for r, emb, txt in zip(records, embs, texts):
            if emb is None:
                continue
            rid = r.get("id") or _hashlib.sha1(txt.encode("utf-8")).hexdigest()[:32]
            rows.append({
                "id": rid[:63],
                "vector": emb,
                "text": txt,
                "source": (r.get("source") or "")[:512],
                "channel": (r.get("channel") or "")[:64],
                "contact": (r.get("contact") or "")[:256],
                "timestamp": (r.get("timestamp") or _now)[:32],
            })
        t1 = _time.time()
        if rows:
            client.insert(collection_name=collection, data=rows)
        insert_ms = (_time.time() - t1) * 1000.0
        return {
            "status": "ok",
            "collection": collection,
            "inserted": len(rows),
            "embed_ms": round(embed_ms, 1),
            "insert_ms": round(insert_ms, 1),
        }

    print(f"\n  L5 Communications Layer — http://127.0.0.1:{port}")
    uvicorn.run(api, host=os.environ.get("HOST","127.0.0.1"), port=port, log_level="warning")


# --- CLI ---

def main():
    parser = argparse.ArgumentParser(description="L5 Communications Layer")
    parser.add_argument("command", choices=["index", "search", "health", "stats", "serve"])
    parser.add_argument("args", nargs="*")
    parser.add_argument("--collection", "-c", default=None)
    parser.add_argument("--limit", "-l", type=int, default=10)
    parser.add_argument("--port", "-p", type=int, default=8034)
    args = parser.parse_args()

    if args.command == "index":
        client = get_client()
        targets = args.args if args.args else ["chats", "emails", "contacts", "memory"]
        t0 = time.time()
        total = 0
        for target in targets:
            print(f"\nIndexing {target}...")
            if target == "chats":
                total += index_chats(client)
            elif target == "emails":
                total += index_emails(client)
            elif target == "contacts":
                total += index_contacts(client)
            elif target == "memory":
                total += index_memory(client)
            else:
                print(f"  Unknown target: {target}")
        elapsed = time.time() - t0
        print(f"\nDone: {total:,} chunks indexed in {elapsed:.1f}s")

    elif args.command == "search":
        query = " ".join(args.args) if args.args else ""
        if not query:
            print("Usage: l5-comms-layer.py search 'your query'")
            return
        results = search(query, collection=args.collection, limit=args.limit)
        for i, r in enumerate(results, 1):
            print(f"\n--- [{i}] {r['collection']} (score: {r['score']}) ---")
            print(f"Source: {r['source']}")
            if r["contact"]:
                print(f"Contact: {r['contact']}")
            if r["timestamp"]:
                print(f"Time: {r['timestamp']}")
            print(r["text"][:300])

    elif args.command == "health":
        h = health()
        print(json.dumps(h, indent=2))

    elif args.command == "stats":
        stats()

    elif args.command == "serve":
        serve(port=args.port)


if __name__ == "__main__":
    main()
