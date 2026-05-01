"""
pme_memory.search — Semantic search across communications collections

Searches across chats, emails, contacts, and memory using vector similarity.
"""

from .embed import embed_query
from .store import CommsStore, COLLECTIONS


def search(query: str, store: CommsStore = None, collection: str = None,
           limit: int = 10) -> list[dict]:
    """Search across all collections (or a specific one).

    Returns list of dicts with: collection, score, text, source, channel, contact, timestamp
    """
    if store is None:
        store = CommsStore()

    vector = embed_query(query)
    if all(v == 0.0 for v in vector):
        return []

    collections = [collection] if collection else COLLECTIONS
    all_results = []

    for coll in collections:
        try:
            results = store.search(coll, vector, limit=limit)
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


def search_collection(query: str, collection: str, store: CommsStore = None,
                      limit: int = 10) -> list[dict]:
    """Search a single collection."""
    return search(query, store=store, collection=collection, limit=limit)
