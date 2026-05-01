"""
pme_memory CLI — Communications layer management.

Usage:
    python -m pme_memory health              # Check status
    python -m pme_memory stats               # Collection stats
    python -m pme_memory index               # Index all sources
    python -m pme_memory index chats         # Index just chats
    python -m pme_memory search "query"      # Search all collections
    python -m pme_memory search "q" -c chats # Search specific collection
    python -m pme_memory serve               # HTTP API (port 8034)
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

from .store import CommsStore
from .indexer import index_all
from .search import search
from .health import health_check


def cmd_health(args):
    store = CommsStore()
    h = health_check(store)
    print(json.dumps(h, indent=2))


def cmd_stats(args):
    store = CommsStore()
    h = health_check(store)
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


def cmd_index(args):
    workspace = Path(os.environ.get("PME_DIR", os.path.expanduser("~/pentatonic")))
    store = CommsStore()
    targets = args.targets if args.targets else None
    t0 = time.time()
    counts = index_all(store, workspace, targets=targets)
    elapsed = time.time() - t0
    total = sum(counts.values())
    print(f"\nDone: {total:,} chunks indexed in {elapsed:.1f}s")


def cmd_search(args):
    query = " ".join(args.query) if args.query else ""
    if not query:
        print("Usage: python -m pme_memory search 'your query'")
        return
    store = CommsStore()
    results = search(query, store=store, collection=args.collection, limit=args.limit)
    for i, r in enumerate(results, 1):
        print(f"\n--- [{i}] {r['collection']} (score: {r['score']}) ---")
        print(f"Source: {r['source']}")
        if r["contact"]:
            print(f"Contact: {r['contact']}")
        if r["timestamp"]:
            print(f"Time: {r['timestamp']}")
        print(r["text"][:300])


def cmd_serve(args):
    try:
        from fastapi import FastAPI, Query
        import uvicorn
    except ImportError:
        print("Install fastapi + uvicorn: pip install fastapi uvicorn")
        sys.exit(1)

    api = FastAPI(title="L5 Communications Layer")
    store = CommsStore()

    @api.get("/health")
    def api_health():
        return health_check(store)

    @api.get("/search")
    def api_search(q: str = Query(...), collection: str = None, limit: int = 10):
        results = search(q, store=store, collection=collection, limit=limit)
        return {"query": q, "results": results, "count": len(results)}

    print(f"\n  L5 Communications Layer — http://127.0.0.1:{args.port}")
    uvicorn.run(api, host="127.0.0.1", port=args.port, log_level="warning")


def main():
    parser = argparse.ArgumentParser(description="L5 Communications Layer")
    sub = parser.add_subparsers(dest="command")

    sub.add_parser("health")
    sub.add_parser("stats")

    idx = sub.add_parser("index")
    idx.add_argument("targets", nargs="*", help="chats, emails, contacts, memory")

    srch = sub.add_parser("search")
    srch.add_argument("query", nargs="*")
    srch.add_argument("-c", "--collection", default=None)
    srch.add_argument("-l", "--limit", type=int, default=10)

    srv = sub.add_parser("serve")
    srv.add_argument("-p", "--port", type=int, default=8034)

    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        return

    cmds = {"health": cmd_health, "stats": cmd_stats, "index": cmd_index,
            "search": cmd_search, "serve": cmd_serve}
    cmds[args.command](args)


if __name__ == "__main__":
    main()
