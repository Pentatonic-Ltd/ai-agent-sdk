"""
pme_memory.indexer — Index life data into Milvus collections

Scans workspace for chat transcripts (JSONL), email archives, people
profiles, contacts, and memory files. Chunks text and embeds via Ollama.

Collections:
    chats:    JSONL chat transcripts + markdown chat summaries
    emails:   Email archive markdown files
    contacts: People profiles + contact records
    memory:   Daily notes, project docs, research (excludes evolution run logs)
"""

import glob
import hashlib
import json
import os
from pathlib import Path

from .embed import embed_texts, BATCH_SIZE
from .store import CommsStore

CHUNK_SIZE = 512
CHUNK_OVERLAP = 64


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


def _upsert_batch(store, collection, batch):
    """Embed and upsert a batch of documents."""
    if not batch:
        return 0
    vectors = embed_texts([d["text"] for d in batch])
    for d, v in zip(batch, vectors):
        d["vector"] = v
    store.upsert(collection, batch)
    return len(batch)


def index_chats(store: CommsStore, workspace: Path) -> int:
    """Index JSONL chat transcripts and markdown chat summaries."""
    total = 0
    chats_dir = workspace / "chats"
    if not chats_dir.exists():
        return 0

    # JSONL files
    for f in chats_dir.rglob("*.jsonl"):
        try:
            lines = f.read_text(errors="replace").strip().split("\n")
            batch = []
            for line in lines:
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError:
                    continue
                text = msg.get("text", "")
                if not text or len(text) < 10:
                    continue
                source = str(f.relative_to(workspace))
                for chunk in chunk_text(text):
                    batch.append({
                        "id": text_id(chunk, source),
                        "text": chunk[:8000],
                        "source": source[:500],
                        "channel": str(msg.get("channel", "unknown"))[:60],
                        "contact": str(msg.get("contact", msg.get("sender", "")))[:250],
                        "timestamp": str(msg.get("timestamp", ""))[:30],
                    })
                    if len(batch) >= BATCH_SIZE:
                        total += _upsert_batch(store, "chats", batch)
                        batch = []
            total += _upsert_batch(store, "chats", batch)
        except Exception as e:
            print(f"  Error indexing {f}: {e}")

    # Markdown chat summaries
    for channel in ["telegram", "whatsapp", "imessage", "slack", "unknown"]:
        chat_dir = workspace / "memory" / "chats" / channel
        if not chat_dir.exists():
            continue
        for f in chat_dir.glob("*.md"):
            try:
                text = f.read_text(errors="replace")
                if len(text) < 20:
                    continue
                source = str(f.relative_to(workspace))
                batch = [{"id": text_id(c, source), "text": c[:8000], "source": source[:500],
                          "channel": channel, "contact": f.stem[:250], "timestamp": ""}
                         for c in chunk_text(text)]
                total += _upsert_batch(store, "chats", batch)
            except Exception as e:
                print(f"  Error: {e}")

    return total


def index_emails(store: CommsStore, workspace: Path) -> int:
    """Index email archive markdown files."""
    total = 0
    emails_dir = workspace / "memory" / "chats" / "email"
    if not emails_dir.exists():
        return 0
    for f in emails_dir.glob("*.md"):
        try:
            text = f.read_text(errors="replace")
            if len(text) < 20:
                continue
            source = str(f.relative_to(workspace))
            contact = f.stem.replace("_", " ")[:250]
            batch = [{"id": text_id(c, source), "text": c[:8000], "source": source[:500],
                      "channel": "email", "contact": contact, "timestamp": ""}
                     for c in chunk_text(text)]
            total += _upsert_batch(store, "emails", batch)
        except Exception as e:
            print(f"  Error: {e}")
    return total


def index_contacts(store: CommsStore, workspace: Path) -> int:
    """Index people profiles and contact records."""
    total = 0
    for dir_path, channel in [(workspace / "memory" / "people", "profile"),
                               (workspace / "memory" / "contacts", "contacts")]:
        if not dir_path.exists():
            continue
        for f in dir_path.glob("*"):
            if not f.is_file():
                continue
            try:
                text = f.read_text(errors="replace")
                if len(text) < 20:
                    continue
                source = str(f.relative_to(workspace))
                batch = [{"id": text_id(c, source), "text": c[:8000], "source": source[:500],
                          "channel": channel, "contact": f.stem[:250], "timestamp": ""}
                         for c in chunk_text(text, chunk_size=1024 if channel == "contacts" else CHUNK_SIZE)]
                total += _upsert_batch(store, "contacts", batch)
            except Exception as e:
                print(f"  Error: {e}")
    return total


def index_memory(store: CommsStore, workspace: Path) -> int:
    """Index memory markdown files (excludes chats and evolution run logs)."""
    total = 0
    memory_dir = workspace / "memory"
    skip_patterns = ["chats/", "evolution/loop-run-", "evolution/v3/runs/"]

    for f in memory_dir.rglob("*.md"):
        source = str(f.relative_to(workspace))
        if any(p in source for p in skip_patterns):
            continue
        try:
            text = f.read_text(errors="replace")
            if len(text) < 30:
                continue
            batch = [{"id": text_id(c, source), "text": c[:8000], "source": source[:500],
                      "channel": "memory", "contact": "", "timestamp": ""}
                     for c in chunk_text(text)]
            total += _upsert_batch(store, "memory", batch)
        except Exception as e:
            print(f"  Error: {e}")
    return total


def index_all(store: CommsStore, workspace: Path, targets=None) -> dict:
    """Index specified targets (or all). Returns counts per collection."""
    if targets is None:
        targets = ["chats", "emails", "contacts", "memory"]
    counts = {}
    indexers = {
        "chats": index_chats,
        "emails": index_emails,
        "contacts": index_contacts,
        "memory": index_memory,
    }
    for target in targets:
        if target in indexers:
            print(f"Indexing {target}...")
            counts[target] = indexers[target](store, workspace)
            print(f"  {counts[target]:,} chunks")
    return counts
