from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class NeedSignal:
    need_type: str
    produced_by_artifact: str
    producer: str
    priority_hint: str = "normal"
    topic: str | None = None
    created_at: str = field(default_factory=_utc_now)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "need_type": self.need_type,
            "produced_by_artifact": self.produced_by_artifact,
            "producer": self.producer,
            "priority_hint": self.priority_hint,
            "topic": self.topic,
            "created_at": self.created_at,
        }


class NeedIndex:
    """Append-only machine-readable unresolved needs index (JSONL)."""

    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if not self.path.exists():
            self.path.touch()

    def publish(self, signal: NeedSignal) -> None:
        with self.path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(signal.to_dict(), sort_keys=True) + "\n")

    def latest(self, limit: int = 50) -> List[Dict[str, Any]]:
        lines = self.path.read_text(encoding="utf-8").splitlines()[-limit:]
        out: List[Dict[str, Any]] = []
        for line in lines:
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        return out
