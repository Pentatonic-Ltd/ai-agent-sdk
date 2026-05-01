#!/usr/bin/env python3
"""
Sequential HybridRAG Proxy — Graph-First Architecture

Based on BlackRock-NVIDIA paper methodology:
1. HybridRAG trigger (early detection)
2. Neo4j graph search (entities/relationships first)
3. QMD vector search (informed by graph context)
4. Result fusion with graph-priority scoring

Port: 8031 (replaces neo4j-qmd-proxy.py)
"""

import argparse
import hashlib
import json
import logging
import os
import sqlite3
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

import re
import requests
from fastapi import FastAPI, HTTPException, Request
from neo4j import GraphDatabase
from neo4j.time import DateTime as Neo4jDateTime, Date as Neo4jDate
from pydantic import BaseModel
import uvicorn


def _serialize_neo4j_value(v: Any) -> Any:
    """Convert neo4j-specific types to JSON-serialisable equivalents.

    Without this, FastAPI's pydantic serialiser raises
    ``PydanticSerializationError: Unable to serialize unknown type:
    <class 'neo4j.time.DateTime'>`` when L3 graph results include nodes
    with datetime properties (e.g. created_at on entity nodes).
    """
    if isinstance(v, (Neo4jDateTime, Neo4jDate)):
        return v.iso_format()
    if isinstance(v, dict):
        return {k: _serialize_neo4j_value(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_serialize_neo4j_value(x) for x in v]
    return v

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

WORKSPACE = Path(os.environ.get("PME_WORKSPACE", Path.home() / "pentatonic"))

NEO4J_URI = os.environ.get("PME_NEO4J_URI", "bolt://localhost:7687")

def _load_neo4j_password() -> str:
    """Resolve Neo4j password from env or secrets file."""
    pw = os.environ.get("PME_NEO4J_PASSWORD", os.environ.get("NEO4J_PASSWORD"))
    if pw:
        return pw
    for path in [
        WORKSPACE / ".secrets.json",
        Path.home() / ".pentatonic" / "workspace" / ".secrets.json",
        Path.home() / ".pentatonic" / "secrets.json",
    ]:
        if path.exists():
            try:
                data = json.loads(path.read_text())
                for key in ("neo4j_password", "NEO4J_PASSWORD", "neo4jPassword"):
                    if key in data:
                        return data[key]
            except (json.JSONDecodeError, OSError):
                continue
    return "password"  # fallback default

NEO4J_AUTH = ("neo4j", _load_neo4j_password())
def _resolve_qmd_db() -> str:
    """Resolve QMD DB path, checking common locations."""
    env = os.environ.get("PME_QMD_DB")
    if env:
        return env
    for candidate in [
        Path.home() / ".pentatonic" / "memory" / "main.sqlite",
        Path.home() / ".openclaw" / "memory" / "main.sqlite",
    ]:
        if candidate.exists():
            return str(candidate)
    return str(Path.home() / ".pentatonic" / "memory" / "main.sqlite")

QMD_DB_PATH = _resolve_qmd_db()
OLLAMA_URL = os.environ.get("PME_OLLAMA_URL", "http://localhost:11434/api/embeddings")
EMBEDDING_MODEL = os.environ.get("PME_EMBED_MODEL", "nomic-embed-text")

# NV-Embed-v2 service (primary, 4096-dim)
NV_EMBED_URL = os.environ.get("PME_NV_EMBED_URL", "http://localhost:8041/v1/embeddings")
NV_EMBED_ENABLED = os.environ.get("PME_NV_EMBED_ENABLED", "true").lower() == "true"

# Sequential processing weights - OPTIMIZED FOR QUALITY
GRAPH_PRIORITY_BOOST = 0.5  # Extra score for graph-derived results (↑ for better entity/relationship context)
VECTOR_BASE_WEIGHT = 0.5     # Base weight for vector results (↓ balanced for accuracy over speed)

# Memory tracking
TRACKER_FILE = WORKSPACE / "memory" / "memory-tracker.jsonl"

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("sequential-hybridrag")

app = FastAPI(title="Sequential HybridRAG Proxy", version="1.0.0")

# ---------------------------------------------------------------------------
# Memory Usage Tracking
# ---------------------------------------------------------------------------

def log_memory_usage(query: str, layers_hit: List[str], l1_hits: int = 0,
                    l3_hits: int = 0, l4_hits: int = 0, search_time_ms: float = 0.0,
                    entities_extracted: List[str] = None) -> None:
    """Log memory layer usage for evolution tracking."""
    try:
        TRACKER_FILE.parent.mkdir(parents=True, exist_ok=True)

        # L2 HybridRAG is active whenever L3 or L4 are used
        l2_active = 1 if (l3_hits > 0 or l4_hits > 0) else 0

        event = {
            "timestamp": datetime.utcnow().isoformat() + "Z",
            "query": query[:100],  # Truncate for privacy
            "source": "sequential-hybridrag",
            "layers_hit": layers_hit,
            "l1_system_hits": l1_hits,
            "l2_hybridrag_active": l2_active,
            "l3_graph_hits": l3_hits,
            "l4_vector_hits": l4_hits,
            "total_hits": l1_hits + l3_hits + l4_hits,
            "search_time_ms": round(search_time_ms, 1),
            "entities_extracted": entities_extracted or [],
            "entity_count": len(entities_extracted or [])
        }

        with open(TRACKER_FILE, "a", encoding="utf-8") as f:
            f.write(json.dumps(event) + "\n")

    except Exception as e:
        log.warning(f"Memory tracking failed: {e}")

def get_layer_stats() -> Dict:
    """Get usage statistics by layer."""
    if not TRACKER_FILE.exists():
        return {"error": "No tracking data found"}

    try:
        layer_counts = {"L1": 0, "L2": 0, "L3": 0, "L4": 0}
        total_queries = 0
        recent_queries = 0

        with open(TRACKER_FILE, "r", encoding="utf-8") as f:
            for line in f:
                try:
                    event = json.loads(line.strip())
                    if event.get("source") == "sequential-hybridrag":
                        total_queries += 1

                        # Count layer hits
                        layers = event.get("layers_hit", [])
                        if "system" in layers or event.get("l1_system_hits", 0) > 0:
                            layer_counts["L1"] += 1

                        # L2 HybridRAG orchestration
                        if event.get("l2_hybridrag_active", 0) > 0:
                            layer_counts["L2"] += 1

                        if "graph" in layers or event.get("l3_graph_hits", 0) > 0:
                            layer_counts["L3"] += 1
                        if "vector" in layers or event.get("l4_vector_hits", 0) > 0:
                            layer_counts["L4"] += 1

                        # Count recent (last 24h)
                        event_time = datetime.fromisoformat(event["timestamp"].replace("Z", "+00:00"))
                        if (datetime.now(event_time.tzinfo) - event_time).days < 1:
                            recent_queries += 1
                except Exception as e:
                    logging.debug(f"Suppressed: {e}")

        return {
            "total_queries": total_queries,
            "recent_24h": recent_queries,
            "layer_usage": layer_counts,
            "layer_percentages": {
                f"L{i}": round(count / max(total_queries, 1) * 100, 1)
                for i, count in enumerate(layer_counts.values(), 1)
            } if total_queries > 0 else {}
        }

    except Exception as e:
        return {"error": str(e)}

# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class ChatMessage(BaseModel):
    role: str
    content: str

class ChatCompletionRequest(BaseModel):
    messages: List[ChatMessage]
    model: str = "gpt-3.5-turbo"
    max_tokens: int = 1000
    temperature: float = 0.1

class EmbeddingRequest(BaseModel):
    input: Any
    model: str = EMBEDDING_MODEL

# ---------------------------------------------------------------------------
# HybridRAG Processing Functions
# ---------------------------------------------------------------------------

def extract_query_entities(query: str) -> List[str]:
    """Extract potential entities from query (early detection)."""
    import re
    # Strip punctuation from words
    words = [re.sub(r'[^\w\s-]', '', w).strip() for w in query.split()]
    words = [w for w in words if w]
    potential_entities = []
    stop_words = {'what', 'who', 'where', 'when', 'how', 'does', 'did', 'the', 'and', 'for', 'with', 'from', 'about', 'this', 'that'}

    # Look for capitalized words (proper nouns)
    for word in words:
        if word.istitle() and len(word) > 2 and word.lower() not in stop_words:
            potential_entities.append(word)

    # Look for multi-word entities (title case phrases)
    for i in range(len(words) - 1):
        if words[i].istitle() and words[i+1].istitle() and words[i].lower() not in stop_words:
            potential_entities.append(f"{words[i]} {words[i+1]}")

    log.info(f"Extracted entities: {potential_entities}")
    return potential_entities

def _hebbian_strengthen(session, node_names: List[str], increment: float = 0.05) -> None:
    """Hebbian: strengthen edges between co-accessed nodes during query."""
    if len(node_names) < 2:
        return
    now = datetime.utcnow().isoformat() + "Z"
    for i, n1 in enumerate(node_names):
        for n2 in node_names[i+1:]:
            try:
                session.run(
                    """MATCH (a {name: $n1})-[r]-(b {name: $n2})
                       SET r.weight = coalesce(r.weight, 1.0) + $inc,
                           r.last_accessed = $now""",
                    n1=n1, n2=n2, inc=increment, now=now
                )
            except Exception:
                pass  # non-critical


def search_neo4j_sequential(query: str, entities: List[str], limit: int = 12) -> Dict:
    """Phase 1: Neo4j graph search with spreading activation + Hebbian."""
    try:
        driver = GraphDatabase.driver(NEO4J_URI, auth=NEO4J_AUTH)
        results = []
        graph_entities = set()

        with driver.session() as session:
            # Search for specific entities — use weighted spreading activation
            for entity in entities:
                # Direct match first
                cypher = """
                MATCH (n)
                WHERE n.name CONTAINS $entity
                OPTIONAL MATCH (n)-[r]-(connected)
                WHERE coalesce(r.weight, 1.0) >= 0.2
                RETURN n, r, connected, $entity as search_entity,
                       coalesce(r.weight, 1.0) AS edge_weight
                ORDER BY edge_weight DESC
                LIMIT $limit
                """

                records = session.run(cypher, entity=entity, limit=8)

                for record in records:
                    node = _serialize_neo4j_value(dict(record["n"]))
                    rel = record["r"]
                    connected = record["connected"]
                    search_entity = record["search_entity"]
                    edge_weight = record["edge_weight"]

                    context = f"Entity: {node.get('name', 'Unknown')} (type: {node.get('type', 'Unknown')})"
                    if rel and connected:
                        rel_type = type(rel).__name__ if rel else "CONNECTED_TO"
                        connected_dict = _serialize_neo4j_value(dict(connected)) if connected else {}
                        context += f" → {rel_type} → {connected_dict.get('name', 'Unknown')}"
                        if edge_weight != 1.0:
                            context += f" [weight: {edge_weight:.2f}]"

                    if 'source_file' in node:
                        context += f"\nSource: {node['source_file']}"

                    name = node.get('name', '')
                    graph_entities.add(name)

                    # Score boosted by edge weight (spreading activation)
                    score = min(0.95, 0.7 + (edge_weight * 0.1))

                    results.append({
                        "path": f"neo4j://entity/{search_entity}",
                        "text": context,
                        "score": score,
                        "source": "graph",
                        "entity": search_entity,
                        "node_data": node
                    })

                # 2-hop spreading activation for high-weight paths
                if entity:
                    activation_results = session.run("""
                        MATCH (start)-[r1]-(mid)-[r2]-(end)
                        WHERE start.name CONTAINS $entity
                          AND coalesce(r1.weight, 1.0) >= 0.5
                          AND coalesce(r2.weight, 1.0) >= 0.5
                          AND start <> end
                        RETURN end,
                             coalesce(r1.weight, 1.0) * coalesce(r2.weight, 1.0) AS activation,
                             mid.name AS via
                        ORDER BY activation DESC
                        LIMIT 5
                    """, entity=entity)

                    for rec in activation_results:
                        end_node = _serialize_neo4j_value(dict(rec["end"])) if rec["end"] else {}
                        name = end_node.get("name", "")
                        if name and name not in graph_entities:
                            graph_entities.add(name)
                            results.append({
                                "path": f"neo4j://activation/{entity}/{name}",
                                "text": f"Activated: {name} (via {rec['via']}, activation: {rec['activation']:.3f})",
                                "score": min(0.85, 0.5 + rec["activation"] * 0.05),
                                "source": "graph",
                                "entity": entity,
                                "node_data": end_node
                            })

            # General query search if no specific entities found
            if not results:
                general_words = [w for w in query.split() if len(w) > 3 and w.lower() not in ['what', 'who', 'where', 'when', 'how']]

                for word in general_words[:2]:
                    cypher = """
                    MATCH (n)
                    WHERE ANY(prop IN keys(n) WHERE n[prop] IS :: STRING AND n[prop] CONTAINS $term)
                    OPTIONAL MATCH (n)-[r]-(connected)
                    RETURN n, r, connected
                    LIMIT $limit
                    """

                    records = session.run(cypher, term=word, limit=4)

                    for record in records:
                        node = _serialize_neo4j_value(dict(record["n"]))
                        context = f"Related: {node}"
                        graph_entities.add(node.get('name', ''))

                        results.append({
                            "path": f"neo4j://search/{word}",
                            "text": context,
                            "score": 0.7,
                            "source": "graph",
                            "entity": word,
                            "node_data": node
                        })

            # Hebbian: strengthen edges between all accessed entities
            _hebbian_strengthen(session, list(graph_entities))

        driver.close()

        return {
            "results": results[:limit],
            "graph_entities": list(graph_entities),
            "entity_count": len(graph_entities)
        }

    except Exception as e:
        log.error(f"Neo4j search failed: {e}")
        return {"results": [], "graph_entities": [], "entity_count": 0}

def get_embedding(text: str) -> List[float]:
    """Get embedding — tries NV-Embed-v2 (4096-dim) first, falls back to Ollama."""
    # Try NV-Embed-v2 service first
    if NV_EMBED_ENABLED:
        try:
            r = requests.post(NV_EMBED_URL, json={"input": text}, timeout=30)
            r.raise_for_status()
            return r.json()["data"][0]["embedding"]
        except Exception as e:
            log.warning(f"NV-Embed-v2 failed, falling back to Ollama: {e}")

    # Fallback to Ollama
    try:
        r = requests.post(OLLAMA_URL, json={"model": EMBEDDING_MODEL, "prompt": text}, timeout=30)
        r.raise_for_status()
        return r.json()["embedding"]
    except Exception as e:
        log.error(f"Embedding failed (both NV-Embed-v2 and Ollama): {e}")
        return []


# ---------------------------------------------------------------------------
# HyDE — Hypothetical Document Embeddings
# ---------------------------------------------------------------------------

HYDE_MODEL = os.environ.get("PME_HYDE_MODEL", "qwen2.5:7b")
HYDE_ENABLED = os.environ.get("PME_HYDE_ENABLED", "true").lower() == "true"

def hyde_expand(query: str) -> str:
    """Generate a hypothetical answer to the query, then concatenate with the
    original query for richer vector search embeddings.
    Uses a small local LLM via Ollama /api/generate."""
    if not HYDE_ENABLED:
        return query
    try:
        r = requests.post(
            "http://localhost:11434/api/generate",
            json={
                "model": HYDE_MODEL,
                "prompt": f"Answer this question in one concise sentence:\n{query}",
                "stream": False,
                "options": {"temperature": 0.3, "num_predict": 60},
            },
            timeout=15,
        )
        r.raise_for_status()
        hypo = r.json().get("response", "").strip()
        if hypo:
            log.info(f"HyDE expansion: '{query}' → +'{hypo[:80]}…'")
            return f"{query} {hypo}"
    except Exception as e:
        log.warning(f"HyDE expansion failed (falling back to raw query): {e}")
    return query


# ---------------------------------------------------------------------------
# Cross-Encoder Reranking
# ---------------------------------------------------------------------------

RERANK_ENABLED = os.environ.get("PME_RERANK_ENABLED", "true").lower() == "true"
RERANK_WINDOW = int(os.environ.get("PME_RERANK_WINDOW", "5"))

def _cosine_sim(a: List[float], b: List[float]) -> float:
    """Cosine similarity between two vectors (handles mismatched dims)."""
    if len(a) != len(b):
        # Truncate to shorter length — still meaningful for cosine
        min_len = min(len(a), len(b))
        a, b = a[:min_len], b[:min_len]
    dot = sum(x * y for x, y in zip(a, b))
    na = sum(x * x for x in a) ** 0.5
    nb = sum(x * x for x in b) ** 0.5
    return dot / (na * nb) if na and nb else 0.0

def cross_encoder_rerank(query: str, results: List[Dict], top_k: int = 16) -> List[Dict]:
    """Re-embed the query and top-N result texts, then sort by cosine
    similarity. Acts as a lightweight cross-encoder reranker without needing
    a dedicated reranking model."""
    if not RERANK_ENABLED or len(results) <= top_k:
        return results

    query_emb = get_embedding(query)
    if not query_emb:
        return results[:top_k]

    window = results[:RERANK_WINDOW]
    scored = []
    for r in window:
        # Get text from 'text' or 'content' field, fallback to path
        text_content = r.get("text") or r.get("content") or r.get("path", "")
        if not text_content:
            scored.append(r)
            continue
        r_emb = get_embedding(text_content[:512])
        if r_emb:
            sim = _cosine_sim(query_emb, r_emb)
            # Blend original score (layer priority) with cosine similarity
            blended = 0.6 * r["score"] + 0.4 * sim
            scored.append({**r, "score": round(blended, 4), "_rerank_sim": round(sim, 4)})
        else:
            scored.append(r)

    scored.sort(key=lambda x: x["score"], reverse=True)
    # Append remaining results (outside rerank window) unchanged
    remaining = results[RERANK_WINDOW:]
    return scored[:top_k] + remaining

def search_qmd_informed(query: str, graph_context: Dict, limit: int = 12) -> List[Dict]:
    """Phase 2: QMD vector search informed by graph results."""
    if not os.path.exists(QMD_DB_PATH):
        return []

    query_embedding = get_embedding(query)
    if not query_embedding:
        return []

    # Enhance query with graph entities for better vector search
    enhanced_query = query
    if graph_context["graph_entities"]:
        enhanced_query += " " + " ".join(graph_context["graph_entities"][:3])

    enhanced_embedding = get_embedding(enhanced_query)
    if not enhanced_embedding:
        enhanced_embedding = query_embedding

    try:
        conn = sqlite3.connect(QMD_DB_PATH, timeout=5)
        conn.row_factory = sqlite3.Row

        # Get vectors and compute similarity
        rows = conn.execute("""
            SELECT id, path, text, embedding
            FROM chunks
            WHERE embedding IS NOT NULL
            ORDER BY id
            LIMIT 2000
        """).fetchall()

        results = []
        for row in rows:
            try:
                # Deserialize embedding
                embedding_data = row["embedding"]
                if isinstance(embedding_data, str):
                    embedding = json.loads(embedding_data)
                else:
                    embedding = list(embedding_data)

                # Cosine similarity with enhanced query
                dot = sum(a * b for a, b in zip(enhanced_embedding, embedding))
                norm_q = sum(x * x for x in enhanced_embedding) ** 0.5
                norm_e = sum(x * x for x in embedding) ** 0.5

                if norm_q > 0 and norm_e > 0:
                    similarity = dot / (norm_q * norm_e)

                    # Boost score if path contains graph entities
                    entity_boost = 0
                    path_lower = row["path"].lower()
                    for entity in graph_context["graph_entities"]:
                        if entity.lower() in path_lower or entity.lower() in row["text"].lower():
                            entity_boost = GRAPH_PRIORITY_BOOST
                            break

                    final_score = (similarity * VECTOR_BASE_WEIGHT) + entity_boost

                    if similarity > 0.2:  # Threshold for inclusion
                        results.append({
                            "path": row["path"],
                            "text": row["text"][:600],
                            "score": final_score,
                            "source": "vector",
                            "base_similarity": similarity,
                            "entity_boost": entity_boost
                        })
            except Exception as e:
                logging.debug(f"Suppressed: {e}")

        conn.close()
        results.sort(key=lambda x: x["score"], reverse=True)
        return results[:limit]

    except Exception as e:
        log.error(f"QMD search failed: {e}")
        return []

def search_core_memory_files(query: str, limit: int = 8) -> List[Dict]:
    """L1 System Files - Section-aware search with synonym expansion (v2)."""
    core_files = [
        "MEMORY.md",
        "plans.md",
        "SESSION-STATE.md",
        "SOUL.md",
        "USER.md",
        f"memory/daily/{time.strftime('%Y-%m-%d')}.md",  # Today's notes
        f"memory/daily/{time.strftime('%Y-%m-%d', time.localtime(time.time() - 86400))}.md"  # Yesterday
    ]

    # Synonym expansion for common query terms
    SYNONYMS = {
        'birthday': ['birthday', 'born', 'birth', 'date'],
        'car': ['car', 'vehicle', 'inster', 'hyundai'],
        'wife': ['wife', 'spouse', 'partner', 'family'],
        'budget': ['budget', 'cap', 'cost', 'monthly', 'spending'],
        'port': ['port', 'listen', 'service', 'endpoint'],
        'neo4j': ['neo4j', 'graph', 'knowledge'],
        'tes': ['tes', 'thing', 'event', 'system'],  # example: add domain-specific terms
        'phone': ['phone', 'mobile', 'number', 'contact'],
        'password': ['password', 'secret', 'credential'],
        'home': ['home', 'address', 'live', 'residence'],
        'hobbies': ['hobbies', 'hobby', 'interests', 'leisure'],
        'hobby': ['hobbies', 'hobby', 'interests', 'leisure'],
        'interests': ['hobbies', 'hobby', 'interests', 'leisure'],
        'patent': ['patent', 'deadline', 'filing'],  # example: legal terms
        'deadline': ['deadline', 'patent', 'due', 'expiry'],
        'dimensions': ['dimensions', 'embed', 'vector', 'dim', '4096'],
        'embed': ['embed', 'embedding', 'dimensions', 'vector', 'nv'],
    }

    stop_words = {'what', 'where', 'when', 'how', 'who', 'which', 'does', 'the',
                  'is', 'are', 'was', 'were', 'for', 'and', 'with', 'has', 'have'}

    query_lower = query.lower()
    raw_keywords = [w for w in re.findall(r'\w+', query_lower) if len(w) > 2 and w not in stop_words]

    # Expand with synonyms
    expanded = set(raw_keywords)
    for k in raw_keywords:
        if k in SYNONYMS:
            expanded.update(SYNONYMS[k])
    keywords = list(expanded)

    results = []

    for file_path in core_files:
        try:
            full_path = WORKSPACE / file_path
            if not full_path.exists():
                continue
            content = full_path.read_text(encoding='utf-8', errors='ignore')

            # Split into sections by ## headers for granular matching
            sections = re.split(r'\n(?=##\s)', content)

            for section in sections:
                lines = section.strip().split('\n')
                header = lines[0] if lines and lines[0].startswith('#') else ""
                section_lower = section.lower()
                header_lower = header.lower()

                # Score 1: Header keyword match (3x weight — header match is very precise)
                header_score = sum(k in header_lower for k in keywords) * 3

                # Score 2: Content keyword hits
                content_score = sum(section_lower.count(k) for k in keywords)

                # Score 3: Exact answer patterns (IPs, ports, dates, reg plates)
                exact_patterns = re.findall(
                    r'\b(?:\d{1,3}\.){3}\d{1,3}\b'   # IP addresses
                    r'|\b\d{4,5}\b'                    # port numbers
                    r'|[A-Z]{2}\d{2}[A-Z]{3}'         # UK reg plates
                    r'|\b\d{1,2}\s+(?:January|February|March|April|May|June|July|'
                    r'August|September|October|November|December)\b',  # dates
                    section
                )
                exact_score = len(exact_patterns)

                total_score = header_score + content_score + exact_score

                if total_score > 0:
                    results.append({
                        "path": file_path,
                        "text": section[:600],
                        "score": 1.0,  # HIGHEST PRIORITY
                        "source": "core_memory",
                        "keyword_hits": total_score,
                        "file_type": "core",
                        "layer": "L1_system",
                    })

        except Exception as e:
            log.warning(f"Failed to read core file {file_path}: {e}")
            continue

    # Sort by total score, deduplicate by path+header prefix
    results.sort(key=lambda x: x["keyword_hits"], reverse=True)
    seen = set()
    deduped = []
    for r in results:
        key = r["text"][:50]
        if key not in seen:
            seen.add(key)
            deduped.append(r)

    return deduped[:limit]

def extract_relevant_snippet(content: str, keywords: List[str], max_chars: int = 400) -> str:
    """Extract most relevant snippet from content around keywords."""
    content_lower = content.lower()
    best_pos = 0
    best_score = 0

    # Find position with highest keyword density
    for i in range(0, len(content), 100):
        window = content_lower[i:i + max_chars]
        score = sum(window.count(keyword) for keyword in keywords)
        if score > best_score:
            best_score = score
            best_pos = i

    # Extract snippet around best position
    start = max(0, best_pos - 50)
    end = min(len(content), best_pos + max_chars + 50)
    snippet = content[start:end].strip()

    # Clean up to sentence boundaries if possible
    if '. ' in snippet:
        sentences = snippet.split('. ')
        # Keep middle sentences (most likely to be complete)
        if len(sentences) > 2:
            snippet = '. '.join(sentences[1:-1]) + '.'

    return snippet

# ---------------------------------------------------------------------------
# L0: Native BM25 Workspace Memory Search
# ---------------------------------------------------------------------------

L0_MEMORY_DB = Path(os.environ.get(
    "PME_MEMORY_DB",
    str(Path.home() / ".pentatonic" / "memory" / "main.sqlite"),
))

def search_l0_bm25(query: str, limit: int = 6) -> List[Dict]:
    """Search native BM25 index over workspace memory files.
    
    Covers chunks from daily notes, memory files, people profiles,
    infrastructure docs, project files — corpus that L3-L6 don't index.
    Sub-millisecond local SQLite reads, zero network overhead.
    """
    if not L0_MEMORY_DB.exists():
        return []
    try:
        # Tokenize query for FTS5 match
        tokens = query.lower().split()
        meaningful = [t for t in tokens if len(t) > 2 and t not in {
            "the", "and", "for", "with", "that", "this", "from", "what",
            "how", "does", "have", "has", "are", "was", "were", "been",
        }]
        if not meaningful:
            return []
        fts_query = " OR ".join(f'"{t}"' for t in meaningful)

        conn = sqlite3.connect(str(L0_MEMORY_DB), timeout=2)
        conn.execute("PRAGMA journal_mode=WAL")
        rows = conn.execute("""
            SELECT path, text, bm25(chunks_fts) as rank
            FROM chunks_fts
            WHERE chunks_fts MATCH ?
              AND path NOT LIKE '%/snapshots/%'
              AND path NOT LIKE '%/archive/%'
              AND path NOT LIKE '%-backup-%'
            ORDER BY rank ASC
            LIMIT ?
        """, (fts_query, limit * 2)).fetchall()
        conn.close()

        results = []
        seen_paths = set()
        for path, text, rank in rows:
            if path in seen_paths:
                continue
            seen_paths.add(path)
            relevance = -rank if rank < 0 else 0.001
            score = min(relevance / (1 + relevance) * 0.85, 0.75)
            results.append({
                "path": f"L0/{path}",
                "snippet": text[:500],
                "score": round(score, 4),
                "layer": "L0_workspace_bm25",
                "source": path,
            })
            if len(results) >= limit:
                break
        return results
    except Exception as e:
        log.debug(f"L0 BM25 search error: {e}")
        return []


# ---------------------------------------------------------------------------
# L5: Communications Context Search
# ---------------------------------------------------------------------------

L5_API_URL = os.environ.get("PME_L5_URL", "http://127.0.0.1:8034")

def search_l5_communications(query: str, limit: int = 6) -> List[Dict]:
    """Search L5 Communications Context via L5 API (emails, chats, calendar)."""
    try:
        resp = requests.get(
            f"{L5_API_URL}/search",
            params={"q": query, "limit": limit},
            timeout=10,
        )
        if resp.status_code != 200:
            return []
        data = resp.json()
        results = []
        for hit in data.get("results", []):
            source = hit.get("source", "")
            score = hit.get("score", 0)
            # Scale Milvus cosine similarity to HybridRAG range
            # Milvus returns 0.4-0.7 for relevant results; boost to compete with other layers
            scaled_score = round(min((score - 0.3) * 2.0 + 0.5, 0.82), 4)
            if scaled_score < 0.4:
                continue  # skip low relevance
            contact = hit.get("contact", "")
            channel = hit.get("channel", "")
            path_label = f"L5/{source}"
            if contact:
                path_label = f"L5/{channel}/{contact}"
            results.append({
                "path": path_label,
                "snippet": hit.get("text", "")[:500],
                "score": scaled_score,
                "layer": "L5_communications",
                "source": source,
                "collection": hit.get("collection", ""),
                "timestamp": hit.get("timestamp", ""),
            })
        return results
    except Exception as e:
        log.debug(f"L5 search error: {e}")
        return []


# L6: Document Store Search
L6_URL = os.environ.get("PME_L6_URL", "http://localhost:8037")

def search_l6_documents(query: str, limit: int = 6) -> List[Dict]:
    """Search L6 Document Store (research, legal, financial, project docs)."""
    try:
        resp = requests.get(
            f"{L6_URL}/search",
            params={"q": query, "method": "hybrid", "limit": limit, "rerank": "true"},
            timeout=10,
        )
        if resp.status_code != 200:
            return []
        data = resp.json()
        results = []
        for hit in data.get("results", []):
            source = hit.get("source_file", "")
            heading = hit.get("heading", "")
            arena = hit.get("arena", "")
            rrf = hit.get("rrf_score", 0)
            reranker = hit.get("reranker_score", None)

            # Scale score: RRF max is ~0.033, normalize to 0.0-0.82 range
            # (below L1's 1.0, comparable to L3/L4/L5)
            score = min(rrf * 25, 0.82)
            if reranker is not None and reranker > 0:
                score = min(score + 0.05, 0.85)

            path_label = f"L6/{arena}/{Path(source).name}" if arena else f"L6/{Path(source).name}"
            if heading:
                path_label += f": {heading[:50]}"

            snippet = hit.get("text", "")[:500]
            entities = hit.get("entities", [])
            if entities:
                snippet += f"\n[Entities: {', '.join(entities[:5])}]"

            results.append({
                "path": f"l6:{Path(source).stem}:{hit.get('chunk_index', 0)}",
                "snippet": snippet,
                "score": round(score, 4),
                "layer": "L6_documents",
                "source": source,
                "arena": arena,
                "doc_type": hit.get("doc_type", ""),
                "engines": hit.get("engines", []),
            })
        return results
    except Exception as e:
        log.debug(f"L6 search error: {e}")
        return []


def sequential_hybridrag_search(query: str, limit: int = 16) -> List[Dict]:
    """Main HybridRAG processing: L0 BM25 → L1 System Files → L2 HybridRAG (L3 Graph + L4 Vector + L5 Comms + L6 Docs)."""
    start_time = time.time()
    log.info(f"Starting sequential HybridRAG search for: '{query}'")

    # L0: BM25 workspace memory (keyword search — complements semantic layers)
    l0_results = search_l0_bm25(query, limit=6)
    log.info(f"L0 BM25 workspace: {len(l0_results)} results")

    # L1: System Files (HIGHEST PRIORITY)
    system_results = search_core_memory_files(query, limit=4)
    log.info(f"L1 System files: {len(system_results)} results")

    # L2: HybridRAG orchestration
    # L3: Graph search (entity extraction + Neo4j)
    entities = extract_query_entities(query)
    graph_context = search_neo4j_sequential(query, entities, limit=8)
    log.info(f"L3 Graph search: {len(graph_context['results'])} results, {graph_context['entity_count']} entities")

    # HyDE: expand query for better vector embeddings
    hyde_query = hyde_expand(query)

    # L4: Vector search (informed by L3 graph context + HyDE)
    vector_results = search_qmd_informed(hyde_query, graph_context, limit=8)
    log.info(f"L4 Vector search: {len(vector_results)} results (HyDE={'on' if hyde_query != query else 'off'})")

    # L5: Communications Context (emails, chats, calendar) — also use HyDE
    l5_results = search_l5_communications(hyde_query, limit=6)
    log.info(f"L5 Communications: {len(l5_results)} results")

    # L6: Document Store (research, legal, financial, project docs)
    l6_results = search_l6_documents(hyde_query, limit=6)
    log.info(f"L6 Documents: {len(l6_results)} results")

    # L2: HybridRAG fusion (combines all layers with L1 priority)
    all_results = l0_results + system_results + graph_context["results"] + vector_results + l5_results + l6_results

    # Remove duplicates by path
    seen_paths = set()
    deduplicated = []
    for result in all_results:
        if result["path"] not in seen_paths:
            deduplicated.append(result)
            seen_paths.add(result["path"])

    # Sort by layer priority: L1 System (1.0) > L3 Graph (0.9) > L4 Vector (0.7+)
    deduplicated.sort(key=lambda x: x["score"], reverse=True)

    # Cross-encoder reranking: re-embed top results and blend scores
    deduplicated = cross_encoder_rerank(query, deduplicated, top_k=limit)

    # Track layer usage for evolution
    search_time_ms = (time.time() - start_time) * 1000
    layers_used = []
    if len(l0_results) > 0:
        layers_used.append("workspace_bm25")
    if len(system_results) > 0:
        layers_used.append("system")
    if len(graph_context["results"]) > 0:
        layers_used.append("graph")
    if len(vector_results) > 0:
        layers_used.append("vector")
    if len(l5_results) > 0:
        layers_used.append("communications")
    if len(l6_results) > 0:
        layers_used.append("documents")

    log_memory_usage(
        query=query,
        layers_hit=layers_used,
        l1_hits=len(system_results),
        l3_hits=len(graph_context["results"]),
        l4_hits=len(vector_results),
        search_time_ms=search_time_ms,
        entities_extracted=entities
    )

    log.info(f"L2 HybridRAG final: {len(deduplicated[:limit])} total results")
    return deduplicated[:limit]

# ---------------------------------------------------------------------------
# API Endpoints
# ---------------------------------------------------------------------------

@app.post("/v1/search")
async def search_endpoint(request: Request) -> dict:
    """Direct L1→L3→L4 cascade search. Returns structured results for programmatic use."""
    try:
        body = await request.json()
        query = body.get("query", "")
        limit = body.get("limit", 16)
        if not query:
            raise HTTPException(status_code=400, detail="query is required")

        results = sequential_hybridrag_search(query, limit=limit)

        # Also return raw graph entities for context enrichment
        entities = extract_query_entities(query)
        graph_context = search_neo4j_sequential(query, entities, limit=8)

        return {
            "results": results,
            "entities": entities,
            "graph_nodes": graph_context.get("entity_count", 0),
            "graph_entities": graph_context.get("graph_entities", []),
            "layers_active": {
                "L1_system": True,
                "L3_graph": True,
                "L4_vector": True,
                "L5_communications": True
            }
        }
    except HTTPException:
        raise
    except Exception as e:
        log.error(f"Search endpoint error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/v1/models")
async def list_models() -> dict:
    """OpenAI-compatible model listing."""
    return {
        "object": "list",
        "data": [
            {"id": "gpt-3.5-turbo", "object": "model", "owned_by": "sequential-hybridrag"}
        ]
    }

@app.post("/v1/embeddings")
async def create_embeddings(request: EmbeddingRequest) -> dict:
    """Pass-through to NV-Embed-v2 (4096-dim). Batch-native — forwards the full
    input list in a single HTTP call instead of looping one-at-a-time."""
    try:
        import httpx
        inputs = [request.input] if isinstance(request.input, str) else request.input
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(
                NV_EMBED_URL,
                json={"input": inputs, "model": request.model or "nv-embed-v2"}
            )
            resp.raise_for_status()
            return resp.json()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/v1/chat/completions")
async def chat_completions(request: ChatCompletionRequest) -> dict:
    """Sequential HybridRAG memory search."""
    try:
        # Extract query from last user message
        user_messages = [m for m in request.messages if m.role == "user"]
        if not user_messages:
            raise HTTPException(status_code=400, detail="No user message found")

        query = user_messages[-1].content

        # Perform sequential HybridRAG search
        start_time = time.time()
        results = sequential_hybridrag_search(query, limit=16)
        search_time = time.time() - start_time

        # Format results with correct layer structure
        context_parts = []
        system_count = sum(1 for r in results if r["source"] == "core_memory")
        graph_count = sum(1 for r in results if r["source"] == "graph")
        vector_count = sum(1 for r in results if r["source"] == "vector")

        context_parts.append(f"# HybridRAG Results (L1 System → L2 HybridRAG → L3 Graph → L4 Vector)")
        context_parts.append(f"Query: {query}")
        context_parts.append(f"Results: {system_count} system + {graph_count} graph + {vector_count} vector = {len(results)} total")
        context_parts.append(f"Search time: {search_time:.3f}s")
        context_parts.append("")

        current_tier = None
        for i, result in enumerate(results):
            # Group by layer for clarity
            source = result['source']
            if source != current_tier:
                if source == "core_memory":
                    context_parts.append(f"## L1 SYSTEM FILES (Highest Priority)")
                elif source == "graph":
                    context_parts.append(f"## L3 GRAPH SEARCH (via L2 HybridRAG)")
                elif source == "vector":
                    context_parts.append(f"## L4 VECTOR SEARCH (via L2 HybridRAG)")
                context_parts.append("")
                current_tier = source

            context_parts.append(f"**{result['path']}** (score: {result['score']:.3f})")
            context_parts.append("")
            context_parts.append(result['text'][:800])
            context_parts.append("")

        response_content = "\n".join(context_parts) if context_parts else "No relevant context found."

        return {
            "id": f"seq-hybridrag-{int(time.time())}",
            "object": "chat.completion",
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": response_content
                },
                "index": 0,
                "finish_reason": "stop"
            }],
            "usage": {"total_tokens": len(response_content)},
            "model": request.model
        }

    except Exception as e:
        log.error(f"HybridRAG search failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/contradictions/{node_name}")
async def check_contradictions(node_name: str) -> dict:
    """Detect contradictions around a named node."""
    try:
        driver = GraphDatabase.driver(NEO4J_URI, auth=NEO4J_AUTH)
        contradictions = []
        with driver.session() as session:
            # Find the node
            node = session.run(
                "MATCH (n) WHERE toLower(n.name) = toLower($name) RETURN elementId(n) AS id", name=node_name
            ).single()
            if not node:
                return {"node": node_name, "contradictions": [], "error": "Node not found"}
            nid = node["id"]

            # Explicit CONTRADICTS
            for rec in session.run(
                """MATCH (a)-[r:CONTRADICTS]-(b) WHERE elementId(a) = $nid
                   RETURN a.name AS a, b.name AS b, r.reason AS reason""", nid=nid
            ):
                contradictions.append({"type": "explicit", "a": rec["a"], "b": rec["b"], "reason": rec["reason"]})

            # Property conflicts via shared neighbour
            for rec in session.run(
                """MATCH (a)--(shared)--(b)
                   WHERE elementId(a) = $nid AND a <> b
                   WITH a, b, shared, properties(a) AS pa, properties(b) AS pb
                   WITH a, b, shared,
                        [k IN keys(pa) WHERE k IN keys(pb) AND pa[k] <> pb[k]
                         AND NOT k IN ['last_accessed','embedding','created_at','updated_at','id','weight']] AS ck
                   WHERE size(ck) > 0
                   RETURN a.name AS a, b.name AS b, shared.name AS via, ck
                   LIMIT 10""", nid=nid
            ):
                contradictions.append({
                    "type": "property_conflict", "a": rec["a"], "b": rec["b"],
                    "via": rec["via"], "conflicting_keys": rec["ck"]
                })
        driver.close()
        return {"node": node_name, "contradictions": contradictions, "count": len(contradictions)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

def _check_l5_health() -> bool:
    """Quick check if L5 Communications API is responding."""
    try:
        resp = requests.get(f"{L5_API_URL}/health", timeout=3)
        return resp.status_code == 200
    except Exception:
        return False

def _check_l6_health() -> bool:
    """Quick check if L6 Document Store is responding."""
    try:
        resp = requests.get(f"{L6_URL}/health", timeout=3)
        return resp.status_code == 200 and resp.json().get("status") in ("ok", "degraded")
    except Exception:
        return False

@app.get("/health")
async def health() -> dict:
    """System health check."""
    qmd_healthy = os.path.exists(QMD_DB_PATH)

    neo4j_healthy = False
    try:
        driver = GraphDatabase.driver(NEO4J_URI, auth=NEO4J_AUTH)
        with driver.session() as session:
            session.run("RETURN 1")
        neo4j_healthy = True
        driver.close()
    except Exception as e:
        logging.debug(f"Suppressed: {e}")

    ollama_healthy = False
    try:
        r = requests.get("http://localhost:11434/api/tags", timeout=5)
        ollama_healthy = r.status_code == 200
    except Exception as e:
        logging.debug(f"Suppressed: {e}")

    return {
        "proxy": "healthy",
        "architecture": "sequential-hybridrag-proper-layers",
        "layers": {
            "L0_workspace_bm25": {"status": "healthy" if L0_MEMORY_DB.exists() else "unavailable", "backend": "sqlite-fts5"},
            "L1_system_files": {"status": "healthy", "description": "MEMORY.md, plans.md, daily notes"},
            "L2_hybridrag": {"status": "healthy", "description": "Orchestrates L3+L4 fusion"},
            "L3_graph_search": {"status": "healthy" if neo4j_healthy else "unavailable", "backend": "neo4j"},
            "L4_vector_search": {"status": "healthy" if qmd_healthy else "unavailable", "backend": "qmd+ollama"},
            "L5_communications": {"status": "healthy" if _check_l5_health() else "unavailable", "backend": "sqlite+ollama"},
            "L6_document_store": {"status": "healthy" if _check_l6_health() else "unavailable", "backend": "milvus+fts5+reranker", "port": 8037},
            "ollama_embeddings": {"status": "healthy" if ollama_healthy else "unavailable"}
        }
    }

@app.get("/stats")
async def layer_statistics() -> Any:
    """Memory layer usage statistics for evolution tracking."""
    return get_layer_stats()

# ---------------------------------------------------------------------------
# Internal write endpoints (L0 BM25 + L4 QMD + L3 KG)
#
# These let the compat shim populate the three layers that L2 reads from
# directly (rather than via HTTP sidecars). Without these the L2-via-shim
# path runs with empty L0/L4-qmd/L3 and RRF fusion is polluted by zero-
# result rank lists.
# ---------------------------------------------------------------------------

_ENTITY_STOP = {
    'what', 'who', 'where', 'when', 'how', 'does', 'did', 'the', 'and',
    'for', 'with', 'from', 'about', 'this', 'that', 'have', 'has', 'are',
    'was', 'were', 'been', 'will', 'would', 'could', 'should', 'into',
}

def _extract_entities_for_kg(text: str, max_entities: int = 32) -> List[str]:
    """Mirror of extract_query_entities, but applied to ingest content.

    Picks single-word title-case tokens + bigrams of consecutive title-case
    tokens. Same heuristic as query-side so node names and search terms line
    up. Caps at max_entities to keep ingest fast.
    """
    if not text:
        return []
    words = [re.sub(r'[^\w\s-]', '', w).strip() for w in text.split()]
    words = [w for w in words if w]
    found: List[str] = []
    seen: Set[str] = set()
    # Single-word title-case
    for w in words:
        if w.istitle() and len(w) > 2 and w.lower() not in _ENTITY_STOP:
            key = w.lower()
            if key not in seen:
                found.append(w)
                seen.add(key)
    # Bigrams of consecutive title-case
    for i in range(len(words) - 1):
        a, b = words[i], words[i + 1]
        if (a.istitle() and b.istitle()
                and a.lower() not in _ENTITY_STOP
                and b.lower() not in _ENTITY_STOP
                and len(a) > 1 and len(b) > 1):
            phrase = f"{a} {b}"
            key = phrase.lower()
            if key not in seen:
                found.append(phrase)
                seen.add(key)
        if len(found) >= max_entities:
            break
    return found[:max_entities]


def _embed_batch_local(texts: List[str]) -> List[List[float]]:
    """Batch embed via NV-Embed. Returns vectors in input order."""
    if not texts:
        return []
    try:
        r = requests.post(NV_EMBED_URL,
                          json={"input": texts, "model": "nv-embed-v2"},
                          timeout=120)
        r.raise_for_status()
        data = r.json().get("data", [])
        # NV-Embed returns [{embedding: [...]}, ...]
        return [d["embedding"] for d in data]
    except Exception as e:
        log.warning(f"NV-Embed batch failed: {e}; trying singletons")
        return [get_embedding(t) for t in texts]


class IndexInternalBatchRequest(BaseModel):
    records: List[Dict[str, Any]]  # [{"id": str, "content": str, "metadata": dict}, ...]
    arena: Optional[str] = "general"


@app.post("/index-internal-batch")
async def index_internal_batch(req: IndexInternalBatchRequest) -> dict:
    """Populate L0 BM25 + L4 QMD vec + L3 Neo4j KG from one ingest call.

    Called by the compat shim on /store-batch so the L2 7-layer fusion
    has real data in every layer (not just L5/L6). Sequential within the
    handler since all three writes are local (SQLite + bolt to a sibling
    container).
    """
    t0 = time.time()
    records = [r for r in (req.records or [])
               if (r.get("content") or r.get("text"))]
    if not records:
        return {"status": "ok", "inserted": 0, "l0": 0, "l4_qmd": 0, "l3_entities": 0,
                "l3_chunks": 0, "duration_ms": 0.0}

    # Normalise
    norm = []
    for r in records:
        content = r.get("content") or r.get("text") or ""
        rid = (r.get("id")
               or hashlib.sha1(content.encode()).hexdigest()[:32])
        meta = r.get("metadata") or {}
        path = meta.get("path") or meta.get("doc_id") or rid
        norm.append({"id": str(rid), "content": content, "path": str(path),
                     "metadata": meta})

    now_iso = datetime.utcnow().isoformat() + "Z"
    arena = req.arena or "general"

    # ---- L0 BM25 (workspace.db) -----------------------------------------
    l0_inserted = 0
    try:
        l0_db = Path(os.environ.get("PME_MEMORY_DB", str(L0_MEMORY_DB)))
        l0_db.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(l0_db), timeout=10)
        conn.execute("PRAGMA journal_mode=WAL")
        # Schema is created by init_databases.py at container start, but be
        # defensive in case L2 is run standalone.
        conn.execute("""
            CREATE TABLE IF NOT EXISTS chunks (
                id INTEGER PRIMARY KEY,
                path TEXT,
                text TEXT,
                file_type TEXT,
                chunk_index INTEGER,
                created_at TEXT
            )
        """)
        conn.execute("""
            CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
                path, text, file_type,
                content='chunks',
                content_rowid='id'
            )
        """)
        conn.execute("""
            CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
                INSERT INTO chunks_fts(rowid, path, text, file_type)
                VALUES (new.id, new.path, new.text, new.file_type);
            END
        """)
        for n in norm:
            cur = conn.execute(
                "INSERT INTO chunks (path, text, file_type, chunk_index, created_at) VALUES (?, ?, ?, ?, ?)",
                (f"bench/{arena}/{n['path']}.md", n["content"], "md", 0, now_iso),
            )
            if cur.rowcount > 0:
                l0_inserted += 1
        conn.commit()
        conn.close()
    except Exception as e:
        log.error(f"L0 BM25 write failed: {e}")

    # ---- L4 QMD vec (qmd.sqlite) ----------------------------------------
    l4_inserted = 0
    try:
        embeddings = _embed_batch_local([n["content"] for n in norm])
        if len(embeddings) != len(norm):
            log.warning(f"L4 embed count mismatch: {len(embeddings)} != {len(norm)}")
        qmd_db = Path(QMD_DB_PATH)
        qmd_db.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(qmd_db), timeout=10)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS chunks (
                id INTEGER PRIMARY KEY,
                path TEXT,
                text TEXT,
                embedding TEXT,
                embedding_model TEXT,
                embedding_dim INTEGER,
                chunk_index INTEGER,
                created_at TEXT
            )
        """)
        for n, vec in zip(norm, embeddings):
            if not vec:
                continue
            conn.execute(
                "INSERT INTO chunks (path, text, embedding, embedding_model, embedding_dim, chunk_index, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (f"bench/{arena}/{n['path']}.md", n["content"],
                 json.dumps(vec), "nv-embed-v2", len(vec), 0, now_iso),
            )
            l4_inserted += 1
        conn.commit()
        conn.close()
    except Exception as e:
        log.error(f"L4 QMD write failed: {e}")

    # ---- L3 Neo4j KG ----------------------------------------------------
    l3_entities = 0
    l3_chunks = 0
    try:
        driver = GraphDatabase.driver(NEO4J_URI, auth=NEO4J_AUTH)
        with driver.session() as session:
            # Index for fast lookup (idempotent)
            try:
                session.run("CREATE INDEX entity_name IF NOT EXISTS FOR (n:Entity) ON (n.name)")
                session.run("CREATE INDEX chunk_id IF NOT EXISTS FOR (c:Chunk) ON (c.id)")
            except Exception:
                pass
            for n in norm:
                entities = _extract_entities_for_kg(n["content"])
                if not entities:
                    continue
                # Create the chunk node
                session.run(
                    """
                    MERGE (c:Chunk {id: $cid})
                    SET c.text = $text,
                        c.path = $path,
                        c.source_file = $path,
                        c.arena = $arena,
                        c.created_at = $now
                    """,
                    cid=n["id"], text=n["content"][:2000], path=n["path"],
                    arena=arena, now=now_iso,
                )
                l3_chunks += 1
                # Create/MERGE entities and MENTIONS edge
                for ent in entities:
                    session.run(
                        """
                        MERGE (e:Entity {name: $name})
                        ON CREATE SET e.type = 'Concept',
                                      e.created_at = $now,
                                      e.weight = 1.0
                        WITH e
                        MATCH (c:Chunk {id: $cid})
                        MERGE (e)-[r:MENTIONS]->(c)
                        ON CREATE SET r.weight = 1.0, r.created_at = $now
                        ON MATCH SET r.weight = coalesce(r.weight, 1.0) + 0.1
                        """,
                        name=ent, cid=n["id"], now=now_iso,
                    )
                    l3_entities += 1
                # Create entity-entity co-occurrence edges (within this chunk)
                # so spreading activation has structure to walk.
                if len(entities) >= 2:
                    for i in range(len(entities)):
                        for j in range(i + 1, len(entities)):
                            session.run(
                                """
                                MATCH (a:Entity {name: $a})
                                MATCH (b:Entity {name: $b})
                                MERGE (a)-[r:CO_OCCURS]->(b)
                                ON CREATE SET r.weight = 0.5, r.created_at = $now
                                ON MATCH SET r.weight = coalesce(r.weight, 0.5) + 0.05
                                """,
                                a=entities[i], b=entities[j], now=now_iso,
                            )
        driver.close()
    except Exception as e:
        log.error(f"L3 KG write failed: {e}")

    dur_ms = (time.time() - t0) * 1000.0
    return {
        "status": "ok",
        "inserted": len(norm),
        "l0": l0_inserted,
        "l4_qmd": l4_inserted,
        "l3_entities": l3_entities,
        "l3_chunks": l3_chunks,
        "duration_ms": round(dur_ms, 1),
    }


@app.post("/forget-internal")
async def forget_internal(request: Request) -> dict:
    """Wipe L0 + L4-qmd + L3. Used by bench harness to reset between runs."""
    try:
        body = await request.json()
    except Exception:
        body = {}
    arena = body.get("arena")  # optional scoping
    deleted = {"l0": 0, "l4_qmd": 0, "l3_entities": 0, "l3_chunks": 0}
    try:
        l0_db = Path(os.environ.get("PME_MEMORY_DB", str(L0_MEMORY_DB)))
        if l0_db.exists():
            conn = sqlite3.connect(str(l0_db), timeout=5)
            cur = conn.execute("DELETE FROM chunks")
            deleted["l0"] = cur.rowcount
            try:
                conn.execute("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')")
            except Exception:
                pass
            conn.commit(); conn.close()
    except Exception as e:
        log.error(f"L0 forget failed: {e}")
    try:
        if Path(QMD_DB_PATH).exists():
            conn = sqlite3.connect(QMD_DB_PATH, timeout=5)
            cur = conn.execute("DELETE FROM chunks")
            deleted["l4_qmd"] = cur.rowcount
            conn.commit(); conn.close()
    except Exception as e:
        log.error(f"L4 QMD forget failed: {e}")
    try:
        driver = GraphDatabase.driver(NEO4J_URI, auth=NEO4J_AUTH)
        with driver.session() as session:
            r1 = session.run("MATCH (c:Chunk) DETACH DELETE c RETURN count(c) AS n")
            deleted["l3_chunks"] = r1.single()["n"]
            r2 = session.run("MATCH (e:Entity) DETACH DELETE e RETURN count(e) AS n")
            deleted["l3_entities"] = r2.single()["n"]
        driver.close()
    except Exception as e:
        log.error(f"L3 forget failed: {e}")
    return {"status": "ok", "deleted": deleted, "arena": arena}


@app.get("/index-internal-stats")
async def index_internal_stats() -> dict:
    """Quick sanity check that the L0/L4-qmd/L3 stores are populated."""
    out = {"l0_chunks": 0, "l4_qmd_chunks": 0,
           "l3_chunks": 0, "l3_entities": 0}
    try:
        l0_db = Path(os.environ.get("PME_MEMORY_DB", str(L0_MEMORY_DB)))
        if l0_db.exists():
            conn = sqlite3.connect(str(l0_db), timeout=5)
            r = conn.execute("SELECT COUNT(*) FROM chunks").fetchone()
            out["l0_chunks"] = r[0] if r else 0
            conn.close()
    except Exception as e:
        out["l0_error"] = str(e)
    try:
        if Path(QMD_DB_PATH).exists():
            conn = sqlite3.connect(QMD_DB_PATH, timeout=5)
            r = conn.execute("SELECT COUNT(*) FROM chunks WHERE embedding IS NOT NULL").fetchone()
            out["l4_qmd_chunks"] = r[0] if r else 0
            conn.close()
    except Exception as e:
        out["l4_qmd_error"] = str(e)
    try:
        driver = GraphDatabase.driver(NEO4J_URI, auth=NEO4J_AUTH)
        with driver.session() as session:
            r = session.run("MATCH (c:Chunk) RETURN count(c) AS n").single()
            out["l3_chunks"] = r["n"] if r else 0
            r = session.run("MATCH (e:Entity) RETURN count(e) AS n").single()
            out["l3_entities"] = r["n"] if r else 0
        driver.close()
    except Exception as e:
        out["l3_error"] = str(e)
    return out

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8031)
    parser.add_argument("--host", type=str, default="127.0.0.1")
    args = parser.parse_args()

    log.info(f"Starting Sequential HybridRAG Proxy (L1 System → L2 HybridRAG → L3 Graph → L4 Vector) on {args.host}:{args.port}")
    uvicorn.run(app, host=args.host, port=args.port)
