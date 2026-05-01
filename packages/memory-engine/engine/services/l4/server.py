"""
L4 sqlite-vec sidecar.

Vector index sidecar for the Pentatonic Memory Engine stack.
Exposes /health, /search, /index-batch, /refresh over HTTP.

Endpoints:
    GET  /health
    POST /search       body: {"query":"...", "limit":10}
    POST /index-batch  body: {"records":[{"id","text"}, ...]}
    POST /refresh      no-op (sqlite-vec writes are immediate)

Env:
    L4_DB_PATH       default /data/vec.db
    L4_NV_EMBED_URL  default http://nv-embed:8041/v1/embeddings
    PORT             default 8042
"""

from __future__ import annotations

import argparse
import hashlib
import os
import sqlite3
import struct
import time
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

# ----------------------------------------------------------------------
# Config
# ----------------------------------------------------------------------

DB_PATH = os.environ.get("L4_DB_PATH", "/data/vec.db")
NV_EMBED_URL = os.environ.get("L4_NV_EMBED_URL", "http://nv-embed:8041/v1/embeddings")
EMBED_DIM = int(os.environ.get("L4_EMBED_DIM", "4096"))


# ----------------------------------------------------------------------
# DB helpers
# ----------------------------------------------------------------------

def _vec_to_blob(vec: list[float]) -> bytes:
    """Pack a list of floats as little-endian f32 bytes for sqlite-vec."""
    return struct.pack(f"<{len(vec)}f", *vec)


def _blob_to_vec(blob: bytes) -> list[float]:
    n = len(blob) // 4
    return list(struct.unpack(f"<{n}f", blob))


def _cosine(a: list[float], b: list[float]) -> float:
    import math
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


def _get_db() -> sqlite3.Connection:
    """Open DB and ensure schema. We use plain BLOB columns rather than
    the sqlite-vec virtual table because sqlite-vec is an optional ext
    that may not be loadable in every container — plain BLOB lets us
    fall back to a Python-side cosine pass without losing correctness.
    """
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS chunks (
            id TEXT PRIMARY KEY,
            text TEXT,
            embedding BLOB,
            indexed_at REAL
        )
    """)
    return conn


# ----------------------------------------------------------------------
# Embedding client
# ----------------------------------------------------------------------

_http: httpx.AsyncClient | None = None


def _client() -> httpx.AsyncClient:
    global _http
    if _http is None:
        _http = httpx.AsyncClient(timeout=120.0)
    return _http


async def _embed_batch(texts: list[str]) -> list[list[float]]:
    if not texts:
        return []
    resp = await _client().post(
        NV_EMBED_URL,
        json={"input": texts, "model": "nv-embed-v2"},
        timeout=120.0,
    )
    resp.raise_for_status()
    return [d["embedding"] for d in resp.json()["data"]]


# ----------------------------------------------------------------------
# FastAPI
# ----------------------------------------------------------------------

class SearchRequest(BaseModel):
    query: str
    limit: int = 10


class IndexBatchRequest(BaseModel):
    records: list[dict[str, Any]]


app = FastAPI(title="L4 sqlite-vec sidecar (OSS)")


@app.get("/health")
def health():
    try:
        conn = _get_db()
        n = conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
        conn.close()
        return {"status": "ok", "loaded": True, "n_vectors": n,
                "dim": EMBED_DIM, "db_path": DB_PATH, "backend": "sqlite-vec-fallback"}
    except Exception as exc:
        return {"status": "degraded", "error": str(exc)}


@app.post("/search")
async def search(req: SearchRequest):
    if not req.query:
        return []
    try:
        embs = await _embed_batch([req.query])
        if not embs or embs[0] is None:
            raise HTTPException(status_code=502, detail="embed failed")
        q_vec = embs[0]
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"embed: {exc}")

    conn = _get_db()
    rows = conn.execute("SELECT id, text, embedding FROM chunks").fetchall()
    conn.close()

    # Cosine similarity in Python — fine for OSS / small corpora. For
    # large corpora: consider a dedicated vector DB.
    scored: list[tuple[float, str, str]] = []
    for rid, text, blob in rows:
        if not blob:
            continue
        v = _blob_to_vec(blob)
        if len(v) != len(q_vec):
            continue
        s = _cosine(q_vec, v)
        scored.append((s, rid, text))
    scored.sort(reverse=True)
    out = [
        {"path": rid, "text": text, "score": float(s),
         "source": "L4-sqlite-vec", "layer": "L4"}
        for s, rid, text in scored[: req.limit]
    ]
    return out


@app.post("/index-batch")
async def index_batch(req: IndexBatchRequest):
    if not req.records:
        return {"status": "ok", "inserted": 0}
    texts = [(r.get("text") or r.get("content") or "")[:8192] for r in req.records]
    t0 = time.perf_counter()
    embs = await _embed_batch(texts)
    embed_ms = (time.perf_counter() - t0) * 1000.0

    conn = _get_db()
    t1 = time.perf_counter()
    rows = []
    for r, emb, txt in zip(req.records, embs, texts):
        if not emb:
            continue
        rid = r.get("id") or hashlib.sha1(txt.encode("utf-8")).hexdigest()[:32]
        rows.append((rid, txt, _vec_to_blob(emb), time.time()))
    if rows:
        conn.executemany(
            "INSERT OR REPLACE INTO chunks(id, text, embedding, indexed_at) "
            "VALUES (?, ?, ?, ?)", rows,
        )
        conn.commit()
    insert_ms = (time.perf_counter() - t1) * 1000.0
    conn.close()
    return {"status": "ok", "inserted": len(rows),
            "embed_ms": round(embed_ms, 1), "insert_ms": round(insert_ms, 1)}


@app.post("/refresh")
def refresh():
    """No-op for sqlite-vec — writes are immediate. Kept for API parity."""
    return {"status": "ok", "noop": True}


# ----------------------------------------------------------------------
# Entrypoint
# ----------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8042")))
    parser.add_argument("--data-dir", default=None)
    args = parser.parse_args()
    if args.data_dir:
        os.environ["L4_DB_PATH"] = str(Path(args.data_dir) / "vec.db")
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=args.port, log_level="info")
