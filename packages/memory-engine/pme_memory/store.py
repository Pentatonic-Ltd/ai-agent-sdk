"""
pme_memory.store — Milvus connection and collection management

Supports Milvus Lite (local .db file) and full Milvus server.
Collections: chats, emails, contacts, memory.
"""

import os
from pathlib import Path
from pymilvus import MilvusClient, DataType

COLLECTIONS = ["chats", "emails", "contacts", "memory"]
EMBED_DIM = int(os.environ.get("PME_EMBED_DIM", "4096"))


def _default_db_path():
    pme_dir = os.environ.get("PME_DIR", os.path.expanduser("~/pentatonic"))
    db_dir = Path(pme_dir) / "memory" / "l5"
    db_dir.mkdir(parents=True, exist_ok=True)
    return str(db_dir / "comms.db")


class CommsStore:
    """Manages Milvus collections for the communications layer."""

    def __init__(self, uri=None):
        self.uri = uri or os.environ.get("MILVUS_URI", _default_db_path())
        self._client = None

    @property
    def client(self):
        if self._client is None:
            self._client = MilvusClient(uri=self.uri)
        return self._client

    def ensure_collection(self, name: str):
        """Create collection if it doesn't exist."""
        if self.client.has_collection(name):
            return
        schema = self.client.create_schema(auto_id=False, enable_dynamic_field=True)
        schema.add_field("id", DataType.VARCHAR, is_primary=True, max_length=64)
        schema.add_field("vector", DataType.FLOAT_VECTOR, dim=EMBED_DIM)
        schema.add_field("text", DataType.VARCHAR, max_length=8192)
        schema.add_field("source", DataType.VARCHAR, max_length=512)
        schema.add_field("channel", DataType.VARCHAR, max_length=64)
        schema.add_field("contact", DataType.VARCHAR, max_length=256)
        schema.add_field("timestamp", DataType.VARCHAR, max_length=32)

        index_params = self.client.prepare_index_params()
        index_params.add_index(field_name="vector", index_type="FLAT", metric_type="COSINE")
        self.client.create_collection(collection_name=name, schema=schema, index_params=index_params)

    def upsert(self, collection: str, data: list[dict]):
        """Upsert documents into a collection."""
        self.ensure_collection(collection)
        self.client.upsert(collection_name=collection, data=data)

    def search(self, collection: str, vector: list[float], limit: int = 10,
               output_fields=None):
        """Search a collection by vector similarity."""
        if not self.client.has_collection(collection):
            return []
        if output_fields is None:
            output_fields = ["text", "source", "channel", "contact", "timestamp"]
        results = self.client.search(
            collection_name=collection,
            data=[vector],
            limit=limit,
            output_fields=output_fields,
        )
        return results

    def collection_stats(self):
        """Get stats for all collections."""
        stats = {}
        for name in COLLECTIONS:
            if self.client.has_collection(name):
                s = self.client.get_collection_stats(name)
                stats[name] = {"exists": True, "count": s.get("row_count", 0)}
            else:
                stats[name] = {"exists": False, "count": 0}
        return stats

    def total_chunks(self):
        stats = self.collection_stats()
        return sum(c["count"] for c in stats.values())
