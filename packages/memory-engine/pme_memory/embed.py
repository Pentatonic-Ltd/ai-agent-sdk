"""
pme_memory.embed — Embedding backend

Primary: NV-Embed-v2 service (4096-dim) on localhost:8041
Fallback: Ollama nomic-embed-text (768-dim) on localhost:11434
"""

import os
import httpx
import logging

log = logging.getLogger("pme_memory.embed")

# NV-Embed-v2 (primary)
NV_EMBED_URL = os.environ.get("PME_NV_EMBED_URL", "http://localhost:8041/v1/embeddings")
NV_EMBED_ENABLED = os.environ.get("PME_NV_EMBED_ENABLED", "true").lower() == "true"

# Ollama (fallback)
OLLAMA_URL = os.environ.get("PME_EMBED_URL", "http://localhost:11434/api/embed")
OLLAMA_MODEL = os.environ.get("PME_EMBED_MODEL", "nomic-embed-text")

# Legacy aliases for backward compatibility
EMBED_URL = OLLAMA_URL
EMBED_MODEL = OLLAMA_MODEL

# Dimension — NV-Embed-v2 is 4096, nomic is 768
EMBED_DIM = int(os.environ.get("PME_EMBED_DIM", "4096"))
BATCH_SIZE = 100  # 100 is the sweet spot for NV-Embed-v2 on GB10 (0.02s/text vs 0.48s at batch=64)


def _embed_nv(texts: list[str]) -> list[list[float]] | None:
    """Batch embed via NV-Embed-v2 service (OpenAI-compatible)."""
    try:
        r = httpx.post(NV_EMBED_URL, json={"input": texts}, timeout=60)
        r.raise_for_status()
        data = r.json()["data"]
        return [d["embedding"] for d in data]
    except Exception as e:
        log.warning(f"NV-Embed-v2 failed: {e}")
        return None


def _embed_ollama(texts: list[str]) -> list[list[float]]:
    """Embed one-by-one via Ollama."""
    results = []
    for text in texts:
        try:
            r = httpx.post(OLLAMA_URL, json={"model": OLLAMA_MODEL, "input": text}, timeout=30)
            r.raise_for_status()
            data = r.json()
            emb = data.get("embeddings", [data.get("embedding", [])])[0]
            if isinstance(emb, list) and len(emb) > 0:
                results.append(emb)
            else:
                results.append([0.0] * EMBED_DIM)
        except Exception:
            results.append([0.0] * EMBED_DIM)
    return results


def embed_texts(texts: list[str]) -> list[list[float]]:
    """Get embeddings. Tries NV-Embed-v2 first, falls back to Ollama."""
    if NV_EMBED_ENABLED:
        result = _embed_nv(texts)
        if result and len(result) == len(texts):
            return result

    return _embed_ollama(texts)


def embed_query(query: str) -> list[float]:
    """Embed a single query string."""
    vecs = embed_texts([query])
    return vecs[0] if vecs else [0.0] * EMBED_DIM
