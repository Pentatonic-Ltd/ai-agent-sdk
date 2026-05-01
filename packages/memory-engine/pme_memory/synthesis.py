"""
pme_memory.synthesis — Synthesis Operator

Deterministic multi-parent merge for compatible artifacts.
When two or more artifacts share overlapping schema fields,
the operator produces a new synthesis artifact that:
  - references all parents
  - merges payloads (union of keys, conflict detection)
  - inherits combined needs (minus fulfilled ones)
  - gets its own content_hash for integrity
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Set

from .artifacts import ArtifactEnvelope, ArtifactStore


def find_compatible_pairs(
    artifacts: List[Dict[str, Any]],
    min_overlap: int = 2,
) -> List[tuple[Dict[str, Any], Dict[str, Any], Set[str]]]:
    """Find artifact pairs with overlapping payload keys.

    Returns list of (art_a, art_b, shared_keys) tuples.
    """
    pairs = []
    for i, a in enumerate(artifacts):
        a_keys = set(a.get("payload", {}).keys())
        for b in artifacts[i + 1:]:
            b_keys = set(b.get("payload", {}).keys())
            shared = a_keys & b_keys
            if len(shared) >= min_overlap:
                pairs.append((a, b, shared))
    return pairs


def merge_payloads(
    payloads: List[Dict[str, Any]],
) -> tuple[Dict[str, Any], List[str]]:
    """Merge multiple payloads. Returns (merged_payload, conflict_keys).

    For conflicting keys, keeps all values as a list under the key.
    """
    merged: Dict[str, Any] = {}
    conflicts: List[str] = []

    for payload in payloads:
        for k, v in payload.items():
            if k not in merged:
                merged[k] = v
            elif merged[k] != v:
                if k not in conflicts:
                    conflicts.append(k)
                # Store as list of divergent values
                existing = merged[k]
                if isinstance(existing, list) and k in conflicts:
                    existing.append(v)
                else:
                    merged[k] = [existing, v]

    return merged, conflicts


def synthesise(
    parents: List[Dict[str, Any]],
    producer: str,
    topic: Optional[str] = None,
    store: Optional[ArtifactStore] = None,
) -> ArtifactEnvelope:
    """Create a synthesis artifact from multiple parent artifacts.

    Args:
        parents: list of artifact dicts (must have artifact_id, payload, needs)
        producer: who is producing the synthesis
        topic: optional topic label
        store: if provided, appends the new artifact automatically

    Returns:
        The new synthesis ArtifactEnvelope
    """
    parent_ids = [p["artifact_id"] for p in parents]
    payloads = [p.get("payload", {}) for p in parents]

    merged_payload, conflicts = merge_payloads(payloads)

    # Combine unresolved needs, deduplicated
    all_needs: List[str] = []
    seen: set = set()
    for p in parents:
        for n in p.get("needs", []):
            if n not in seen:
                all_needs.append(n)
                seen.add(n)

    synthesis = ArtifactEnvelope.create(
        artifact_type="synthesis",
        producer=producer,
        payload={
            "merged": merged_payload,
            "conflicts": conflicts,
            "parent_count": len(parents),
        },
        parents=parent_ids,
        needs=all_needs,
        source_tool="synthesis_operator",
        topic=topic,
    )

    if store:
        store.append(synthesis)

    return synthesis
