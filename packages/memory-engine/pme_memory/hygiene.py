"""
pme_memory.hygiene — DAG Hygiene (P2)

Periodic maintenance for the artifact DAG:
  1. Dedupe: collapse artifacts with identical content_hash
  2. Conflict detection: flag contradicting payloads on same topic
  3. Branch pruning: mark stale/orphaned branches
  4. Compaction: rewrite store without pruned entries
"""

from __future__ import annotations

import json
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Set


@dataclass
class HygieneReport:
    total_artifacts: int
    duplicates_found: int
    duplicates_removed: int
    conflicts_detected: List[Dict[str, Any]]
    orphans_found: int
    orphans_pruned: int

    def to_dict(self) -> Dict[str, Any]:
        return {
            "total_artifacts": self.total_artifacts,
            "duplicates_found": self.duplicates_found,
            "duplicates_removed": self.duplicates_removed,
            "conflicts_detected": self.conflicts_detected,
            "orphans_found": self.orphans_found,
            "orphans_pruned": self.orphans_pruned,
        }


def _load_all(store_path: Path) -> List[Dict[str, Any]]:
    if not store_path.exists():
        return []
    out = []
    for line in store_path.read_text(encoding="utf-8").splitlines():
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out


def _write_all(store_path: Path, artifacts: List[Dict[str, Any]]) -> None:
    with store_path.open("w", encoding="utf-8") as f:
        for art in artifacts:
            f.write(json.dumps(art, sort_keys=True, separators=(",", ":")) + "\n")


def deduplicate(artifacts: List[Dict[str, Any]]) -> tuple[List[Dict[str, Any]], int]:
    """Remove artifacts with duplicate content_hash, keeping the earliest."""
    seen: Dict[str, int] = {}
    unique: List[Dict[str, Any]] = []
    dupes = 0
    for art in artifacts:
        h = art.get("content_hash", "")
        if h and h in seen:
            dupes += 1
            continue
        if h:
            seen[h] = len(unique)
        unique.append(art)
    return unique, dupes


def detect_conflicts(artifacts: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Find artifacts on the same topic with contradicting payload values."""
    by_topic: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for art in artifacts:
        topic = art.get("topic")
        if topic:
            by_topic[topic].append(art)

    conflicts = []
    for topic, arts in by_topic.items():
        if len(arts) < 2:
            continue
        # Compare payload keys across artifacts in same topic
        for i, a in enumerate(arts):
            a_payload = a.get("payload", {})
            for b in arts[i + 1:]:
                b_payload = b.get("payload", {})
                shared_keys = set(a_payload.keys()) & set(b_payload.keys())
                for k in shared_keys:
                    if a_payload[k] != b_payload[k]:
                        conflicts.append({
                            "topic": topic,
                            "key": k,
                            "artifact_a": a["artifact_id"][:12],
                            "value_a": str(a_payload[k])[:80],
                            "artifact_b": b["artifact_id"][:12],
                            "value_b": str(b_payload[k])[:80],
                        })
    return conflicts


def find_orphans(artifacts: List[Dict[str, Any]]) -> Set[str]:
    """Find artifacts that reference parents not in the store."""
    known_ids = {a["artifact_id"] for a in artifacts}
    orphan_ids: Set[str] = set()
    for art in artifacts:
        for pid in art.get("parents", []):
            if pid not in known_ids:
                orphan_ids.add(art["artifact_id"])
    return orphan_ids


def run_hygiene(
    store_path: str | Path,
    prune_orphans: bool = False,
    dry_run: bool = True,
) -> HygieneReport:
    """Run full DAG hygiene pass.

    Args:
        store_path: path to artifacts.jsonl
        prune_orphans: if True, remove orphaned artifacts
        dry_run: if True, don't write changes back
    """
    store_path = Path(store_path)
    artifacts = _load_all(store_path)
    total = len(artifacts)

    # 1. Deduplicate
    deduped, dupe_count = deduplicate(artifacts)

    # 2. Detect conflicts
    conflicts = detect_conflicts(deduped)

    # 3. Find orphans
    orphan_ids = find_orphans(deduped)
    orphan_count = len(orphan_ids)
    pruned_count = 0

    if prune_orphans and orphan_ids:
        deduped = [a for a in deduped if a["artifact_id"] not in orphan_ids]
        pruned_count = orphan_count

    # 4. Write back if not dry_run
    removed = dupe_count + pruned_count
    if not dry_run and removed > 0:
        _write_all(store_path, deduped)

    return HygieneReport(
        total_artifacts=total,
        duplicates_found=dupe_count,
        duplicates_removed=dupe_count if not dry_run else 0,
        conflicts_detected=conflicts,
        orphans_found=orphan_count,
        orphans_pruned=pruned_count if not dry_run else 0,
    )
