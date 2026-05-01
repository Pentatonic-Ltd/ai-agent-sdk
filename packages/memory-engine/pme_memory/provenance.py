"""
pme_memory.provenance — Provenance-first output rendering

Renders artifact lineage chains for human-readable output.
Given an artifact, walks parent pointers to build a full
provenance trail with sources, tools, and timestamps.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Optional


def load_artifact_index(store_path: str | Path) -> Dict[str, Dict[str, Any]]:
    """Load all artifacts into a dict keyed by artifact_id."""
    store_path = Path(store_path)
    index: Dict[str, Dict[str, Any]] = {}
    if not store_path.exists():
        return index
    for line in store_path.read_text(encoding="utf-8").splitlines():
        try:
            art = json.loads(line)
            index[art["artifact_id"]] = art
        except (json.JSONDecodeError, KeyError):
            continue
    return index


def trace_lineage(
    artifact_id: str,
    index: Dict[str, Dict[str, Any]],
    max_depth: int = 20,
) -> List[Dict[str, Any]]:
    """Walk parent pointers and return lineage chain (newest first)."""
    chain: List[Dict[str, Any]] = []
    visited: set = set()
    queue = [artifact_id]

    while queue and len(chain) < max_depth:
        aid = queue.pop(0)
        if aid in visited:
            continue
        visited.add(aid)
        art = index.get(aid)
        if not art:
            chain.append({"artifact_id": aid, "status": "missing"})
            continue
        chain.append(art)
        for pid in art.get("parents", []):
            if pid not in visited:
                queue.append(pid)

    return chain


def render_lineage_text(
    artifact_id: str,
    index: Dict[str, Dict[str, Any]],
    max_depth: int = 20,
) -> str:
    """Render a human-readable provenance chain."""
    chain = trace_lineage(artifact_id, index, max_depth)
    if not chain:
        return f"No lineage found for {artifact_id}"

    lines = [f"Provenance for {artifact_id[:12]}...\n"]
    for i, art in enumerate(chain):
        prefix = "  " * i + ("└─ " if i > 0 else "")
        if art.get("status") == "missing":
            lines.append(f"{prefix}[missing] {art['artifact_id'][:12]}...")
        else:
            tool = art.get("source_tool", "?")
            atype = art.get("artifact_type", "?")
            ts = art.get("created_at", "?")[:19]
            aid = art["artifact_id"][:12]
            lines.append(f"{prefix}{aid}... | {atype} | tool={tool} | {ts}")

    return "\n".join(lines)
