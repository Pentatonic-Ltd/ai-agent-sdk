#!/usr/bin/env python3
"""
L6 Document Store — HybridRAG for Document Retrieval

Features:
- Milvus Lite (vector) + SQLite FTS5 (BM25) + RRF fusion
- Cross-encoder reranker (ms-marco-MiniLM-L-6-v2)
- Ingest-time entity extraction via Ollama graph-preflexor
- Adaptive chunk sizing by doc_type
- Freshness-aware dedup (purge-and-replace on re-index)
- Confidence scoring (RRF + engine_count + reranker_score)

Port: 8037
"""

import argparse
import hashlib
import json
import logging
import os
import re
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import httpx
from pymilvus import MilvusClient, DataType, CollectionSchema, FieldSchema
from pymilvus.milvus_client.index import IndexParams

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

DATA_DIR = Path(os.environ.get("L6_DATA_DIR", str(Path.home() / "l6-document-store" / "data")))
MILVUS_DB = str(DATA_DIR / "documents.db")
FTS_DB = str(DATA_DIR / "documents_fts.db")
OLLAMA_URL = os.environ.get("L6_OLLAMA_URL", "http://localhost:11434")
EMBED_MODEL = os.environ.get("L6_EMBED_MODEL", "nomic-embed-text")
NV_EMBED_URL = os.environ.get("L6_NV_EMBED_URL", "http://localhost:8041/v1/embeddings")
NV_EMBED_ENABLED = os.environ.get("L6_NV_EMBED_ENABLED", "true").lower() == "true"
EMBED_DIM = int(os.environ.get("L6_EMBED_DIM", "4096"))
COLLECTION_NAME = "documents"
RRF_K = 60
DEFAULT_PORT = 8037

# Chunk sizes by doc_type
CHUNK_CONFIG = {
    "legal": {"max_chars": 2500, "overlap": 400},
    "financial": {"max_chars": 2500, "overlap": 400},
    "governance": {"max_chars": 2500, "overlap": 400},
    "technical": {"max_chars": 2000, "overlap": 300},
    "general": {"max_chars": 1500, "overlap": 200},
}

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("l6-document-store")

# ---------------------------------------------------------------------------
# Embedding
# ---------------------------------------------------------------------------

_embed_client = httpx.Client(timeout=60)

def embed_text(text: str) -> List[float]:
    """Get embedding — NV-Embed-v2 primary, Ollama fallback."""
    if NV_EMBED_ENABLED:
        try:
            resp = _embed_client.post(NV_EMBED_URL, json={"input": text[:4000]})
            resp.raise_for_status()
            return resp.json()["data"][0]["embedding"]
        except Exception as e:
            log.warning(f"NV-Embed-v2 failed, falling back to Ollama: {e}")

    # Ollama fallback
    resp = _embed_client.post(
        f"{OLLAMA_URL}/api/embeddings",
        json={"model": EMBED_MODEL, "prompt": text[:8000]},
    )
    resp.raise_for_status()
    return resp.json()["embedding"]


def embed_batch(texts: List[str]) -> List[List[float]]:
    """Embed a batch of texts — NV-Embed-v2 supports native batching."""
    if NV_EMBED_ENABLED:
        try:
            resp = _embed_client.post(NV_EMBED_URL, json={"input": [t[:4000] for t in texts]})
            resp.raise_for_status()
            return [d["embedding"] for d in resp.json()["data"]]
        except Exception as e:
            log.warning(f"NV-Embed-v2 batch failed, falling back to sequential: {e}")

    return [embed_text(t) for t in texts]

# ---------------------------------------------------------------------------
# Cross-Encoder Reranker
# ---------------------------------------------------------------------------

_reranker = None
_reranker_loaded = False

def get_reranker():
    """Lazy-load cross-encoder reranker."""
    global _reranker, _reranker_loaded
    if not _reranker_loaded:
        try:
            from sentence_transformers import CrossEncoder
            _reranker = CrossEncoder("cross-encoder/ms-marco-MiniLM-L-6-v2")
            log.info("Cross-encoder reranker loaded (ms-marco-MiniLM-L-6-v2)")
        except Exception as e:
            log.warning(f"Cross-encoder not available: {e}")
            _reranker = None
        _reranker_loaded = True
    return _reranker


def rerank(query: str, results: List[Dict], top_k: int = 10) -> List[Dict]:
    """Rerank results using cross-encoder."""
    reranker = get_reranker()
    if not reranker or not results:
        return results[:top_k]

    pairs = [(query, r["text"][:512]) for r in results[:20]]
    scores = reranker.predict(pairs)

    for i, r in enumerate(results[:20]):
        r["reranker_score"] = float(scores[i])

    results[:20] = sorted(results[:20], key=lambda x: x.get("reranker_score", -999), reverse=True)
    return results[:top_k]

# ---------------------------------------------------------------------------
# Entity Extraction (ingest-time)
# ---------------------------------------------------------------------------

def extract_entities(text: str) -> List[str]:
    """Extract entities from text using Ollama graph-preflexor."""
    try:
        resp = _embed_client.post(
            f"{OLLAMA_URL}/api/generate",
            json={
                "model": "graph-preflexor",
                "prompt": f"Extract all named entities (people, companies, products, places, dates) from this text. Return ONLY a JSON array of strings, nothing else.\n\nText: {text[:2000]}",
                "stream": False,
            },
            timeout=15,
        )
        if resp.status_code == 200:
            raw = resp.json().get("response", "")
            # Try to parse JSON array from response
            match = re.search(r'\[.*?\]', raw, re.DOTALL)
            if match:
                entities = json.loads(match.group())
                return [str(e).strip() for e in entities if e and len(str(e).strip()) > 1][:20]
    except Exception as e:
        log.debug(f"Entity extraction failed: {e}")
    return []

# ---------------------------------------------------------------------------
# Document Processing
# ---------------------------------------------------------------------------

def detect_doc_type(path: str) -> str:
    """Detect document type from path patterns."""
    p = path.lower()
    if any(k in p for k in ["legal", "contract", "nda", "agreement", "terms"]):
        return "legal"
    if any(k in p for k in ["finance", "financial", "investor", "revenue", "budget", "portfolio"]):
        return "financial"
    if any(k in p for k in ["governance", "policy", "compliance", "audit"]):
        return "governance"
    if any(k in p for k in ["technical", "architecture", "api", "schema", "code"]):
        return "technical"
    return "general"


def detect_arena(path: str) -> str:
    """Detect arena/domain from path patterns."""
    p = path.lower()
    if "company" in p or "internal" in p:
        return "company"
    if "project" in p or "proj-" in p:
        return "project"
    if "sarai" in p or "defence" in p:
        return "sarai"
    if "research" in p:
        return "research"
    if "finance" in p or "portfolio" in p or "stock" in p:
        return "finance"
    return "general"


def content_hash(text: str) -> str:
    """SHA256 hash for dedup."""
    return hashlib.sha256(text.encode()).hexdigest()[:16]


def chunk_markdown(text: str, doc_type: str = "general") -> List[Dict]:
    """Split markdown into chunks with adaptive sizing."""
    cfg = CHUNK_CONFIG.get(doc_type, CHUNK_CONFIG["general"])
    max_chars = cfg["max_chars"]
    overlap = cfg["overlap"]

    chunks = []
    current_heading = ""

    # Split on ## or ### headings
    sections = re.split(r'(^#{2,3}\s+.+$)', text, flags=re.MULTILINE)

    current_text = ""
    for part in sections:
        if re.match(r'^#{2,3}\s+', part):
            # Save previous section
            if current_text.strip():
                chunks.extend(_split_section(current_text.strip(), current_heading, max_chars, overlap))
            current_heading = part.strip().lstrip('#').strip()
            current_text = ""
        else:
            current_text += part

    # Don't forget last section
    if current_text.strip():
        chunks.extend(_split_section(current_text.strip(), current_heading, max_chars, overlap))

    # If no headings found, chunk the whole thing
    if not chunks and text.strip():
        chunks = _split_section(text.strip(), "", max_chars, overlap)

    return chunks


def _split_section(text: str, heading: str, max_chars: int, overlap: int) -> List[Dict]:
    """Split a section into overlapping chunks."""
    if len(text) <= max_chars:
        return [{"text": text, "heading": heading}]

    chunks = []
    start = 0
    while start < len(text):
        end = start + max_chars

        # Try to break at paragraph boundary
        if end < len(text):
            para_break = text.rfind('\n\n', start, end)
            if para_break > start + max_chars // 2:
                end = para_break

        chunk_text = text[start:end].strip()
        if chunk_text:
            chunks.append({"text": chunk_text, "heading": heading})

        start = end - overlap
        if start >= len(text):
            break

    return chunks

# ---------------------------------------------------------------------------
# Milvus Operations
# ---------------------------------------------------------------------------

def get_milvus() -> MilvusClient:
    """Get or create Milvus client."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    client = MilvusClient(uri=MILVUS_DB)

    if COLLECTION_NAME not in client.list_collections():
        schema = CollectionSchema(fields=[
            FieldSchema("id", DataType.VARCHAR, is_primary=True, max_length=64),
            FieldSchema("vector", DataType.FLOAT_VECTOR, dim=EMBED_DIM),
            FieldSchema("text", DataType.VARCHAR, max_length=16000),
            FieldSchema("source_file", DataType.VARCHAR, max_length=500),
            FieldSchema("arena", DataType.VARCHAR, max_length=60),
            FieldSchema("doc_type", DataType.VARCHAR, max_length=30),
            FieldSchema("heading", DataType.VARCHAR, max_length=300),
            FieldSchema("chunk_index", DataType.INT64),
            FieldSchema("content_hash", DataType.VARCHAR, max_length=20),
            FieldSchema("entities_json", DataType.VARCHAR, max_length=2000),
            FieldSchema("indexed_at", DataType.VARCHAR, max_length=30),
        ])
        client.create_collection(
            collection_name=COLLECTION_NAME,
            schema=schema,
        )
        # Create index
        idx = IndexParams()
        idx.add_index(field_name="vector", index_type="AUTOINDEX", metric_type="COSINE")
        client.create_index(collection_name=COLLECTION_NAME, index_params=idx)
        client.load_collection(COLLECTION_NAME)
        log.info(f"Created Milvus collection '{COLLECTION_NAME}'")

    return client


def search_vector(client: MilvusClient, query_vec: List[float], limit: int = 20,
                  arena: Optional[str] = None) -> List[Dict]:
    """Vector similarity search."""
    filter_expr = f'arena == "{arena}"' if arena else ""
    results = client.search(
        collection_name=COLLECTION_NAME,
        data=[query_vec],
        limit=limit,
        output_fields=["text", "source_file", "arena", "doc_type", "heading",
                        "chunk_index", "content_hash", "entities_json", "indexed_at"],
        filter=filter_expr if filter_expr else None,
    )
    out = []
    for hits in results:
        for hit in hits:
            entity = hit.get("entity", {})
            out.append({
                "text": entity.get("text", ""),
                "source_file": entity.get("source_file", ""),
                "arena": entity.get("arena", ""),
                "doc_type": entity.get("doc_type", ""),
                "heading": entity.get("heading", ""),
                "chunk_index": entity.get("chunk_index", 0),
                "content_hash": entity.get("content_hash", ""),
                "entities": _parse_entities_json(entity.get("entities_json", "[]")),
                "score": hit.get("distance", 0),
                "engine": "vector",
            })
    return out

# ---------------------------------------------------------------------------
# FTS5 Operations
# ---------------------------------------------------------------------------

def get_fts_db() -> sqlite3.Connection:
    """Get or create FTS5 database."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(FTS_DB)
    conn.execute("PRAGMA journal_mode=WAL")

    # Create content table
    conn.execute("""
        CREATE TABLE IF NOT EXISTS chunks (
            id TEXT PRIMARY KEY,
            text TEXT,
            source_file TEXT,
            arena TEXT,
            doc_type TEXT,
            heading TEXT,
            chunk_index INTEGER,
            content_hash TEXT,
            entities_json TEXT,
            indexed_at TEXT
        )
    """)

    # Create FTS5 virtual table
    conn.execute("""
        CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
            text, source_file, arena, heading, entities_json,
            content='chunks',
            content_rowid='rowid'
        )
    """)

    # Triggers for sync
    conn.execute("""
        CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
            INSERT INTO chunks_fts(rowid, text, source_file, arena, heading, entities_json)
            VALUES (new.rowid, new.text, new.source_file, new.arena, new.heading, new.entities_json);
        END
    """)
    conn.execute("""
        CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
            INSERT INTO chunks_fts(chunks_fts, rowid, text, source_file, arena, heading, entities_json)
            VALUES ('delete', old.rowid, old.text, old.source_file, old.arena, old.heading, old.entities_json);
        END
    """)

    conn.commit()
    return conn


def search_fts(conn: sqlite3.Connection, query: str, limit: int = 20,
               arena: Optional[str] = None) -> List[Dict]:
    """BM25 keyword search via FTS5."""
    # Escape FTS5 special chars
    safe_query = re.sub(r'[^\w\s]', ' ', query).strip()
    if not safe_query:
        return []

    arena_filter = f"AND c.arena = ?" if arena else ""
    params = [safe_query, limit] if not arena else [safe_query, arena, limit]

    sql = f"""
        SELECT c.*, bm25(chunks_fts) as rank
        FROM chunks_fts f
        JOIN chunks c ON c.rowid = f.rowid
        WHERE chunks_fts MATCH ?
        {arena_filter}
        ORDER BY rank
        LIMIT ?
    """

    try:
        rows = conn.execute(sql, params).fetchall()
    except sqlite3.OperationalError as e:
        log.warning(f"FTS query failed: {e}")
        return []

    cols = ["id", "text", "source_file", "arena", "doc_type", "heading",
            "chunk_index", "content_hash", "entities_json", "indexed_at", "rank"]
    out = []
    for row in rows:
        d = dict(zip(cols, row))
        out.append({
            "text": d.get("text", ""),
            "source_file": d.get("source_file", ""),
            "arena": d.get("arena", ""),
            "doc_type": d.get("doc_type", ""),
            "heading": d.get("heading", ""),
            "chunk_index": d.get("chunk_index", 0),
            "content_hash": d.get("content_hash", ""),
            "entities": _parse_entities_json(d.get("entities_json", "[]")),
            "score": -d.get("rank", 0),  # BM25 returns negative scores
            "engine": "bm25",
        })
    return out

# ---------------------------------------------------------------------------
# RRF Fusion
# ---------------------------------------------------------------------------

def rrf_fuse(vector_results: List[Dict], bm25_results: List[Dict]) -> List[Dict]:
    """Reciprocal Rank Fusion combining vector and BM25 results."""
    scored = {}

    for rank, r in enumerate(vector_results):
        key = (r["source_file"], r["chunk_index"])
        if key not in scored:
            scored[key] = {"result": r, "rrf_score": 0, "engines": set()}
        scored[key]["rrf_score"] += 1.0 / (RRF_K + rank + 1)
        scored[key]["engines"].add("vector")

    for rank, r in enumerate(bm25_results):
        key = (r["source_file"], r["chunk_index"])
        if key not in scored:
            scored[key] = {"result": r, "rrf_score": 0, "engines": set()}
        scored[key]["rrf_score"] += 1.0 / (RRF_K + rank + 1)
        scored[key]["engines"].add("bm25")

    # Sort by RRF score
    fused = sorted(scored.values(), key=lambda x: x["rrf_score"], reverse=True)

    out = []
    for item in fused:
        r = item["result"]
        r["rrf_score"] = round(item["rrf_score"], 6)
        r["engine_count"] = len(item["engines"])
        r["engines"] = list(item["engines"])
        out.append(r)

    return out

# ---------------------------------------------------------------------------
# Indexing
# ---------------------------------------------------------------------------

def index_documents(paths: List[str], arena: Optional[str] = None,
                    doc_type: Optional[str] = None,
                    extract_entities_flag: bool = True,
                    use_enhanced_ingest: bool = True) -> Dict:
    """Index documents into both Milvus and FTS5.
    
    Supports: .md, .txt, .markdown, .pdf (via enhanced_ingest)
    """
    milvus = get_milvus()
    fts_conn = get_fts_db()

    stats = {"files": 0, "chunks": 0, "entities_extracted": 0, "errors": 0, "skipped": 0, 
             "tables": 0, "semantic_chunks": 0}
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    for file_path in paths:
        p = Path(file_path)
        if not p.exists():
            log.warning(f"File not found: {file_path}")
            stats["errors"] += 1
            continue

        supported_exts = (
            '.md', '.txt', '.markdown', '.pdf',
            # enhanced_ingest formats
            '.csv', '.json', '.yaml', '.yml', '.toml',
            '.py', '.js', '.ts', '.go', '.rs', '.java', '.c', '.cpp', '.h',
            '.docx', '.doc', '.pptx', '.ppt', '.xlsx', '.xls',
            '.rtf', '.odt', '.epub', '.tex',
            '.html', '.htm', '.xml',
            '.ipynb',
        )
        if not p.suffix.lower() in supported_exts:
            log.debug(f"Skipping unsupported: {file_path}")
            stats["skipped"] += 1
            continue
        
        # Use enhanced ingest for PDFs (and optionally for all docs)
        if p.suffix.lower() == '.pdf' or use_enhanced_ingest:
            try:
                from enhanced_ingest import ingest_document, Chunk
                result = ingest_document(str(p), arena or detect_arena(str(p)))
                
                file_arena = result["arena"]
                file_doc_type = doc_type or detect_doc_type(str(p))
                source_file = str(p)
                
                # Purge old chunks
                _purge_file(milvus, fts_conn, source_file)
                
                milvus_batch = []
                for chunk_data in result["chunks"]:
                    chunk_text = chunk_data["text"]
                    c_hash = content_hash(chunk_text)
                    idx = chunk_data["chunk_index"]
                    chunk_id = f"{c_hash}_{idx}"
                    
                    # Track semantic vs fixed chunks
                    if chunk_data.get("metadata", {}).get("type") == "semantic":
                        stats["semantic_chunks"] += 1
                    if chunk_data.get("metadata", {}).get("type") == "table":
                        stats["tables"] += 1
                    
                    # Extract entities
                    entities = []
                    if extract_entities_flag and len(chunk_text) > 50:
                        entities = extract_entities(chunk_text)
                        if entities:
                            stats["entities_extracted"] += len(entities)
                    
                    entities_json = json.dumps(entities)
                    vector = embed_text(chunk_text)
                    
                    milvus_batch.append({
                        "id": chunk_id,
                        "vector": vector,
                        "text": chunk_text[:15000],
                        "source_file": source_file[:500],
                        "arena": file_arena[:60],
                        "doc_type": file_doc_type[:30],
                        "heading": chunk_data.get("heading", "")[:300],
                        "chunk_index": idx,
                        "content_hash": c_hash,
                        "entities_json": entities_json[:2000],
                        "indexed_at": now,
                    })
                    
                    fts_conn.execute(
                        "INSERT OR REPLACE INTO chunks VALUES (?,?,?,?,?,?,?,?,?,?)",
                        (chunk_id, chunk_text[:15000], source_file[:500], file_arena[:60],
                         file_doc_type[:30], chunk_data.get("heading", "")[:300], idx,
                         c_hash, entities_json[:2000], now),
                    )
                
                if milvus_batch:
                    # pymilvus 2.6+ requires keyword args; old positional form
                    # silently no-ops which causes vector hits to be empty.
                    milvus.insert(collection_name=COLLECTION_NAME, data=milvus_batch)
                    fts_conn.commit()
                
                stats["files"] += 1
                stats["chunks"] += len(result["chunks"])
                log.info(f"Indexed (enhanced): {p.name} — {len(result['chunks'])} chunks, {len(result.get('tables', []))} tables")
                continue
                
            except ImportError:
                log.warning("enhanced_ingest not available, falling back to basic chunking")
            except Exception as e:
                log.error(f"Enhanced ingest failed for {file_path}: {e}")
                if p.suffix.lower() == '.pdf':
                    stats["errors"] += 1
                    continue
                # Fall through to basic chunking for non-PDFs

        try:
            text = p.read_text(errors="replace")
            if len(text.strip()) < 20:
                stats["skipped"] += 1
                continue

            file_arena = arena or detect_arena(str(p))
            file_doc_type = doc_type or detect_doc_type(str(p))
            source_file = str(p)

            # Purge old chunks for this file (freshness-aware dedup)
            _purge_file(milvus, fts_conn, source_file)

            # Chunk the document
            chunks = chunk_markdown(text, file_doc_type)

            # Process each chunk
            milvus_batch = []
            for idx, chunk in enumerate(chunks):
                chunk_text = chunk["text"]
                c_hash = content_hash(chunk_text)
                chunk_id = f"{c_hash}_{idx}"

                # Extract entities (ingest-time)
                entities = []
                if extract_entities_flag and len(chunk_text) > 50:
                    entities = extract_entities(chunk_text)
                    if entities:
                        stats["entities_extracted"] += len(entities)

                entities_json = json.dumps(entities)

                # Embed
                vector = embed_text(chunk_text)

                # Prepare Milvus record
                milvus_batch.append({
                    "id": chunk_id,
                    "vector": vector,
                    "text": chunk_text[:15000],
                    "source_file": source_file[:500],
                    "arena": file_arena[:60],
                    "doc_type": file_doc_type[:30],
                    "heading": chunk.get("heading", "")[:300],
                    "chunk_index": idx,
                    "content_hash": c_hash,
                    "entities_json": entities_json[:2000],
                    "indexed_at": now,
                })

                # Insert into FTS5
                fts_conn.execute(
                    "INSERT OR REPLACE INTO chunks VALUES (?,?,?,?,?,?,?,?,?,?)",
                    (chunk_id, chunk_text[:15000], source_file[:500], file_arena[:60],
                     file_doc_type[:30], chunk.get("heading", "")[:300], idx,
                     c_hash, entities_json[:2000], now),
                )

                stats["chunks"] += 1

            # Batch insert into Milvus
            if milvus_batch:
                milvus.upsert(collection_name=COLLECTION_NAME, data=milvus_batch)

            stats["files"] += 1
            log.info(f"Indexed {p.name}: {len(chunks)} chunks, arena={file_arena}, type={file_doc_type}")

        except Exception as e:
            log.error(f"Error indexing {file_path}: {e}")
            stats["errors"] += 1

    fts_conn.commit()
    fts_conn.close()
    return stats


def _purge_file(milvus: MilvusClient, fts_conn: sqlite3.Connection, source_file: str):
    """Remove all chunks for a source file (freshness-aware re-index)."""
    try:
        # Purge from Milvus
        milvus.delete(
            collection_name=COLLECTION_NAME,
            filter=f'source_file == "{source_file}"',
        )
    except Exception as e:
        log.debug(f"Milvus purge (may be empty): {e}")

    try:
        # Purge from FTS
        fts_conn.execute("DELETE FROM chunks WHERE source_file = ?", (source_file,))
    except Exception as e:
        log.debug(f"FTS purge: {e}")


def _parse_entities_json(s: str) -> List[str]:
    """Safely parse entities JSON."""
    try:
        return json.loads(s) if s else []
    except (json.JSONDecodeError, TypeError):
        return []

# ---------------------------------------------------------------------------
# Search
# ---------------------------------------------------------------------------

def search(query: str, method: str = "hybrid", limit: int = 10,
           arena: Optional[str] = None, enable_rerank: bool = True) -> List[Dict]:
    """Search documents with specified method."""

    if method == "vector":
        vec = embed_text(query)
        results = search_vector(get_milvus(), vec, limit=limit, arena=arena)
    elif method == "bm25":
        results = search_fts(get_fts_db(), query, limit=limit, arena=arena)
    else:
        # Hybrid: RRF fusion
        vec = embed_text(query)
        vector_results = search_vector(get_milvus(), vec, limit=20, arena=arena)
        bm25_results = search_fts(get_fts_db(), query, limit=20, arena=arena)
        results = rrf_fuse(vector_results, bm25_results)

    # Rerank if enabled
    if enable_rerank and len(results) > 1:
        results = rerank(query, results, top_k=limit)

    return results[:limit]

# ---------------------------------------------------------------------------
# Stats & Health
# ---------------------------------------------------------------------------

def get_stats() -> Dict:
    """Get index statistics."""
    stats = {"vector_chunks": 0, "fts_chunks": 0, "arenas": {}, "doc_types": {}}

    try:
        milvus = get_milvus()
        info = milvus.get_collection_stats(COLLECTION_NAME)
        stats["vector_chunks"] = info.get("row_count", 0)
    except Exception:
        pass

    try:
        conn = get_fts_db()
        row = conn.execute("SELECT COUNT(*) FROM chunks").fetchone()
        stats["fts_chunks"] = row[0] if row else 0

        for row in conn.execute("SELECT arena, COUNT(*) FROM chunks GROUP BY arena").fetchall():
            stats["arenas"][row[0]] = row[1]

        for row in conn.execute("SELECT doc_type, COUNT(*) FROM chunks GROUP BY doc_type").fetchall():
            stats["doc_types"][row[0]] = row[1]

        conn.close()
    except Exception:
        pass

    return stats


def health() -> Dict:
    """Health check."""
    status = {"status": "ok", "milvus": "unknown", "fts": "unknown", "ollama": "unknown", "reranker": "unknown"}

    # Milvus
    try:
        client = get_milvus()
        colls = client.list_collections()
        status["milvus"] = f"ok ({len(colls)} collections)"
    except Exception as e:
        status["milvus"] = f"error: {e}"
        status["status"] = "degraded"

    # FTS
    try:
        conn = get_fts_db()
        cnt = conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
        status["fts"] = f"ok ({cnt} chunks)"
        conn.close()
    except Exception as e:
        status["fts"] = f"error: {e}"
        status["status"] = "degraded"

    # Ollama
    try:
        resp = _embed_client.get(f"{OLLAMA_URL}/api/tags", timeout=5)
        status["ollama"] = "ok" if resp.status_code == 200 else f"http {resp.status_code}"
    except Exception as e:
        status["ollama"] = f"error: {e}"
        status["status"] = "degraded"

    # Reranker
    reranker = get_reranker()
    status["reranker"] = "loaded" if reranker else "unavailable (CPU fallback to RRF)"

    return status

# ---------------------------------------------------------------------------
# FastAPI Server
# ---------------------------------------------------------------------------

def serve(port: int = DEFAULT_PORT):
    """Run as HTTP API server."""
    from fastapi import FastAPI, Query as Q, HTTPException
    from pydantic import BaseModel
    import uvicorn

    api = FastAPI(title="L6 Document Store", version="1.0.0")

    class IndexRequest(BaseModel):
        paths: List[str]
        arena: Optional[str] = None
        doc_type: Optional[str] = None
        extract_entities: bool = True

    @api.get("/health")
    def api_health():
        return health()

    @api.get("/stats")
    def api_stats():
        return get_stats()

    @api.get("/search")
    def api_search(
        q: str = Q(..., description="Search query"),
        method: str = Q("hybrid", description="hybrid|vector|bm25"),
        limit: int = Q(10, ge=1, le=50),
        arena: Optional[str] = Q(None),
        rerank: bool = Q(True),
    ):
        results = search(q, method=method, limit=limit, arena=arena, enable_rerank=rerank)
        return {"query": q, "method": method, "results": results, "count": len(results)}

    @api.post("/search")
    def api_search_post(
        q: str,
        method: str = "hybrid",
        limit: int = 10,
        arena: Optional[str] = None,
        rerank: bool = True,
    ):
        """POST version of search for compatibility."""
        results = search(q, method=method, limit=limit, arena=arena, enable_rerank=rerank)
        return {"query": q, "method": method, "results": results, "count": len(results)}

    @api.post("/index")
    def api_index(req: IndexRequest):
        stats = index_documents(
            req.paths, arena=req.arena, doc_type=req.doc_type,
            extract_entities_flag=req.extract_entities,
        )
        return {"status": "ok", "stats": stats}

    @api.post("/index-batch")
    def api_index_batch(req: dict):
        """Index a batch of in-memory documents in a single batched
        NV-Embed call + a single milvus insert + one FTS write.

        Roughly 30-50x faster than calling /index for the equivalent
        files because the legacy path does one embed roundtrip per
        chunk. This endpoint exists for tests, smoke runs and bench
        harnesses where small corpora need to land quickly.

        Request body::

            {
              "arena": "benchmark",
              "records": [
                {
                  "id":  "doc1",                  # required, becomes chunk id prefix
                  "text": "…",                     # required, indexed as one chunk
                  "source_file": "doc1.md",       # optional
                  "doc_type": "general",          # optional, default "general"
                  "heading": "…"                   # optional
                }, …
              ]
            }

        Returns::

            {"status": "ok", "inserted": N, "embed_ms": float, "insert_ms": float}
        """
        import time as _time, hashlib as _hashlib, httpx as _httpx
        from datetime import datetime as _dt, timezone as _tz

        records = req.get("records") or []
        arena = req.get("arena") or "general"
        if not records:
            return {"status": "ok", "inserted": 0}

        texts = [(r.get("text") or "")[:16000] for r in records]

        # Single batched NV-Embed call.
        t0 = _time.time()
        try:
            resp = _httpx.post(
                NV_EMBED_URL, json={"input": texts, "model": "nv-embed-v2"},
                timeout=120,
            )
            resp.raise_for_status()
            embs = [d["embedding"] for d in resp.json()["data"]]
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"embed failed: {exc}")
        embed_ms = (_time.time() - t0) * 1000.0

        # Single milvus insert.
        milvus = get_milvus()
        now = _dt.now(_tz.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        rows = []
        for r, emb, txt in zip(records, embs, texts):
            if emb is None:
                continue
            rid = r.get("id") or _hashlib.sha1(txt.encode("utf-8")).hexdigest()[:32]
            chunk_id = f"l6:{rid}:0"[:63]
            rows.append({
                "id": chunk_id,
                "vector": emb,
                "text": txt,
                "source_file": (r.get("source_file") or f"{rid}.md")[:500],
                "arena": arena[:60],
                "doc_type": (r.get("doc_type") or "general")[:30],
                "heading": (r.get("heading") or "")[:300],
                "chunk_index": 0,
                "content_hash": _hashlib.sha1(txt.encode("utf-8")).hexdigest()[:20],
                "entities_json": "[]",
                "indexed_at": now,
            })
        t1 = _time.time()
        if rows:
            milvus.insert(collection_name=COLLECTION_NAME, data=rows)
        insert_ms = (_time.time() - t1) * 1000.0

        # Single FTS write (best-effort — search still works without it).
        try:
            fts_conn = get_fts_db()
            for r, txt in zip(records, texts):
                rid = r.get("id") or _hashlib.sha1(txt.encode("utf-8")).hexdigest()[:32]
                fts_conn.execute(
                    "INSERT INTO chunks_fts(text, source_file, arena, heading, entities_json) "
                    "VALUES (?, ?, ?, ?, ?)",
                    (txt, (r.get("source_file") or f"{rid}.md"), arena,
                     (r.get("heading") or ""), "[]"),
                )
            fts_conn.commit()
            fts_conn.close()
        except Exception as exc:
            log.warning("FTS write failed in /index-batch: %s", exc)

        return {
            "status": "ok",
            "inserted": len(rows),
            "embed_ms": round(embed_ms, 1),
            "insert_ms": round(insert_ms, 1),
        }

    @api.delete("/purge")
    def api_purge(source_file: str = Q(...)):
        """Remove all chunks for a source file."""
        milvus = get_milvus()
        fts_conn = get_fts_db()
        _purge_file(milvus, fts_conn, source_file)
        fts_conn.commit()
        fts_conn.close()
        return {"status": "purged", "source_file": source_file}

    @api.post("/rebuild-index")
    def api_rebuild():
        """Force Milvus index rebuild."""
        milvus = get_milvus()
        milvus.release_collection(COLLECTION_NAME)
        milvus.load_collection(COLLECTION_NAME)
        return {"status": "rebuilt"}

    log.info(f"L6 Document Store — http://127.0.0.1:{port}")
    uvicorn.run(api, host=os.environ.get("HOST","127.0.0.1"), port=port, log_level="info")

# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="L6 Document Store")
    parser.add_argument("command", choices=["serve", "index", "search", "health", "stats"])
    parser.add_argument("args", nargs="*")
    parser.add_argument("--port", "-p", type=int, default=DEFAULT_PORT)
    parser.add_argument("--arena", "-a", type=str, default=None)
    parser.add_argument("--doc-type", "-t", type=str, default=None)
    parser.add_argument("--method", "-m", type=str, default="hybrid")
    parser.add_argument("--limit", "-l", type=int, default=10)
    parser.add_argument("--no-entities", action="store_true")
    parser.add_argument("--no-rerank", action="store_true")

    args = parser.parse_args()

    if args.command == "serve":
        serve(port=args.port)

    elif args.command == "index":
        paths = args.args
        if not paths:
            print("Usage: l6-document-store.py index <file1.md> [file2.md ...]")
            print("       l6-document-store.py index ~/memory/research/*.md")
            return
        stats = index_documents(paths, arena=args.arena, doc_type=args.doc_type,
                                extract_entities_flag=not args.no_entities)
        print(json.dumps(stats, indent=2))

    elif args.command == "search":
        query = " ".join(args.args) if args.args else ""
        if not query:
            print("Usage: l6-document-store.py search 'your query'")
            return
        results = search(query, method=args.method, limit=args.limit,
                         arena=args.arena, enable_rerank=not args.no_rerank)
        for i, r in enumerate(results, 1):
            print(f"\n--- [{i}] {r.get('source_file','?')} (rrf={r.get('rrf_score',0):.4f}, engines={r.get('engines','?')}) ---")
            if r.get("heading"):
                print(f"Heading: {r['heading']}")
            if r.get("entities"):
                print(f"Entities: {', '.join(r['entities'][:10])}")
            print(r["text"][:300])

    elif args.command == "health":
        print(json.dumps(health(), indent=2))

    elif args.command == "stats":
        print(json.dumps(get_stats(), indent=2))


if __name__ == "__main__":
    main()
