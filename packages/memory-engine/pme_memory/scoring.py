"""
pme_memory.scoring — Pressure Scoring for Need Signals

Ranks unresolved needs by four dimensions:
  - recency:    how fresh the need is (exponential decay)
  - novelty:    inverse frequency of this need_type in the index
  - centrality: how many artifacts reference the producing artifact
  - priority:   explicit priority_hint weight (critical > high > normal > low)

Output: sorted list of needs with composite pressure score (0-1).
"""

from __future__ import annotations

import json
import math
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional


# --- Weight configuration (tunable) ---
WEIGHT_RECENCY = 0.30
WEIGHT_NOVELTY = 0.25
WEIGHT_CENTRALITY = 0.25
WEIGHT_PRIORITY = 0.20

PRIORITY_SCORES = {
    "critical": 1.0,
    "high": 0.75,
    "normal": 0.5,
    "low": 0.25,
}

# Recency half-life in hours (need loses half its recency score after this)
RECENCY_HALF_LIFE_H = 12.0


def _parse_iso(ts: str) -> datetime:
    return datetime.fromisoformat(ts)


def _recency_score(created_at: str, now: datetime) -> float:
    """Exponential decay: score = 2^(-age_hours / half_life)."""
    try:
        age = (now - _parse_iso(created_at)).total_seconds() / 3600.0
    except (ValueError, TypeError):
        return 0.0
    return math.pow(2, -age / RECENCY_HALF_LIFE_H)


def _novelty_scores(needs: List[Dict[str, Any]]) -> Dict[str, float]:
    """Inverse frequency: rarer need_types score higher."""
    counts = Counter(n.get("need_type", "") for n in needs)
    total = len(needs) or 1
    return {
        nt: 1.0 - (count / total)
        for nt, count in counts.items()
    }


def _centrality_map(artifact_store_path: Path) -> Dict[str, int]:
    """Count how many artifacts reference each artifact_id as a parent."""
    refs: Dict[str, int] = {}
    if not artifact_store_path.exists():
        return refs
    for line in artifact_store_path.read_text(encoding="utf-8").splitlines():
        try:
            art = json.loads(line)
        except json.JSONDecodeError:
            continue
        for pid in art.get("parents", []):
            refs[pid] = refs.get(pid, 0) + 1
    return refs


@dataclass
class ScoredNeed:
    need_type: str
    produced_by_artifact: str
    producer: str
    topic: Optional[str]
    created_at: str
    priority_hint: str
    recency: float
    novelty: float
    centrality: float
    priority: float
    pressure: float

    def to_dict(self) -> Dict[str, Any]:
        return {
            "need_type": self.need_type,
            "produced_by_artifact": self.produced_by_artifact,
            "producer": self.producer,
            "topic": self.topic,
            "created_at": self.created_at,
            "priority_hint": self.priority_hint,
            "scores": {
                "recency": round(self.recency, 4),
                "novelty": round(self.novelty, 4),
                "centrality": round(self.centrality, 4),
                "priority": round(self.priority, 4),
            },
            "pressure": round(self.pressure, 4),
        }


def rank_needs(
    needs_path: str | Path,
    artifact_store_path: str | Path,
    limit: int = 50,
) -> List[ScoredNeed]:
    """Score and rank unresolved needs by composite pressure."""
    needs_path = Path(needs_path)
    artifact_store_path = Path(artifact_store_path)

    if not needs_path.exists():
        return []

    raw = []
    for line in needs_path.read_text(encoding="utf-8").splitlines():
        try:
            raw.append(json.loads(line))
        except json.JSONDecodeError:
            continue

    if not raw:
        return []

    now = datetime.now(timezone.utc)
    novelty_map = _novelty_scores(raw)
    centrality_map = _centrality_map(artifact_store_path)
    max_centrality = max(centrality_map.values()) if centrality_map else 1

    scored: List[ScoredNeed] = []
    for n in raw[-limit:]:
        rec = _recency_score(n.get("created_at", ""), now)
        nov = novelty_map.get(n.get("need_type", ""), 0.0)
        art_id = n.get("produced_by_artifact", "")
        cen = (centrality_map.get(art_id, 0) / max_centrality) if max_centrality else 0.0
        pri = PRIORITY_SCORES.get(n.get("priority_hint", "normal"), 0.5)

        pressure = (
            WEIGHT_RECENCY * rec
            + WEIGHT_NOVELTY * nov
            + WEIGHT_CENTRALITY * cen
            + WEIGHT_PRIORITY * pri
        )

        scored.append(ScoredNeed(
            need_type=n.get("need_type", ""),
            produced_by_artifact=art_id,
            producer=n.get("producer", ""),
            topic=n.get("topic"),
            created_at=n.get("created_at", ""),
            priority_hint=n.get("priority_hint", "normal"),
            recency=rec,
            novelty=nov,
            centrality=cen,
            priority=pri,
            pressure=pressure,
        ))

    scored.sort(key=lambda s: s.pressure, reverse=True)
    return scored
