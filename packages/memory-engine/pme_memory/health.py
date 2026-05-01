"""
pme_memory.health — Health check for the L5 communications layer
"""

import httpx
from .store import CommsStore, COLLECTIONS
from .embed import EMBED_URL, EMBED_MODEL


def health_check(store: CommsStore = None) -> dict:
    """Check L5 health: Milvus connectivity, collection stats, embeddings."""
    if store is None:
        store = CommsStore()
    try:
        stats = store.collection_stats()
        total = sum(c["count"] for c in stats.values())

        # Check embeddings
        embeddings_ok = False
        try:
            r = httpx.get("http://localhost:11434/api/tags", timeout=3)
            models = [m["name"] for m in r.json().get("models", [])]
            embeddings_ok = EMBED_MODEL in str(models)
        except Exception:
            pass

        return {
            "status": "ok",
            "db_path": store.uri,
            "collections": stats,
            "total_chunks": total,
            "embeddings": embeddings_ok,
            "embed_model": EMBED_MODEL,
        }
    except Exception as e:
        return {"status": "error", "error": str(e)}
