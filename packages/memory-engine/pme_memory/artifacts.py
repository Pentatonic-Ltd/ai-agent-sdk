from __future__ import annotations

import hashlib
import json
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _stable_json(data: Any) -> str:
    return json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _sha256(data: Any) -> str:
    return hashlib.sha256(_stable_json(data).encode("utf-8")).hexdigest()


@dataclass
class ArtifactEnvelope:
    artifact_id: str
    artifact_type: str
    producer: str
    payload: Dict[str, Any]
    needs: List[str] = field(default_factory=list)
    parents: List[str] = field(default_factory=list)
    source_tool: Optional[str] = None
    topic: Optional[str] = None
    created_at: str = field(default_factory=_utc_now)
    content_hash: str = ""

    @classmethod
    def create(
        cls,
        artifact_type: str,
        producer: str,
        payload: Dict[str, Any],
        *,
        needs: Optional[List[str]] = None,
        parents: Optional[List[str]] = None,
        source_tool: Optional[str] = None,
        topic: Optional[str] = None,
    ) -> "ArtifactEnvelope":
        env = cls(
            artifact_id=str(uuid.uuid4()),
            artifact_type=artifact_type,
            producer=producer,
            payload=payload,
            needs=needs or [],
            parents=parents or [],
            source_tool=source_tool,
            topic=topic,
        )
        env.content_hash = _sha256({
            "artifact_type": env.artifact_type,
            "producer": env.producer,
            "payload": env.payload,
            "needs": env.needs,
            "parents": env.parents,
            "source_tool": env.source_tool,
            "topic": env.topic,
        })
        return env

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


class ArtifactStore:
    """Append-only local artifact store (JSONL)."""

    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if not self.path.exists():
            self.path.touch()

    def append(self, artifact: ArtifactEnvelope) -> None:
        with self.path.open("a", encoding="utf-8") as f:
            f.write(_stable_json(artifact.to_dict()) + "\n")

    def tail(self, n: int = 20) -> List[Dict[str, Any]]:
        lines = self.path.read_text(encoding="utf-8").splitlines()
        out: List[Dict[str, Any]] = []
        for line in lines[-n:]:
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        return out
