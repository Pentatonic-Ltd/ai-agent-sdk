"""Initialise empty L0 BM25 SQLite + L4 QMD SQLite at container startup.

The L2 proxy reads from two SQLite files that don't otherwise exist
in a fresh container — so opening them via sqlite3.connect() fails
with "unable to open database file." Pre-creating them with the
schemas the proxy expects lets the proxy come up cleanly and return
empty results from those layers (instead of crashing) until the shim
populates them through /index-batch.

Schemas mirror what the production ingester writes.
"""

import os
import sqlite3
import sys
from pathlib import Path


def init_l0_bm25(db_path: Path) -> None:
    """L0 — workspace BM25 over chunked markdown."""
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    conn.execute("PRAGMA journal_mode=WAL")
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
    conn.commit()
    conn.close()


def init_l4_qmd(db_path: Path) -> None:
    """L4 — QMD vector store, JSONB embeddings stored alongside text."""
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
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
    conn.commit()
    conn.close()


def main() -> int:
    base = Path(sys.argv[1] if len(sys.argv) > 1 else "/data")
    init_l0_bm25(base / "workspace.db")
    init_l4_qmd(base / "qmd.sqlite")
    print(f"initialised L0 + L4 QMD databases under {base}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
