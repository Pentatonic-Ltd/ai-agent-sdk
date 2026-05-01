#!/usr/bin/env python3
"""
KG Extraction V2 — 2-Pass Concurrent Hybrid via Ollama API
8 batches x 2 passes = 16 concurrent Ollama calls per wave.

Pass A: Structured (all 14 types in one prompt)
Pass B: Native graph discovery (nodes/edges)
Both run concurrently per batch, 8 batches per wave.

Usage:
    python3 kg-preflexor-v2.py                        # Full extraction
    python3 kg-preflexor-v2.py --source telegram      # Only telegram
    python3 kg-preflexor-v2.py --stats                # Graph stats
    python3 kg-preflexor-v2.py --dry-run              # No Neo4j writes
    python3 kg-preflexor-v2.py --reset                # Clear state
    python3 kg-preflexor-v2.py --test-batch           # Run 1 batch, show output
    python3 kg-preflexor-v2.py --concurrency 16       # Custom concurrency

Environment variables:
    PME_WORKSPACE        — workspace root (default: $HOME/pentatonic)
    PME_OLLAMA_URL       — Ollama base URL (default: http://localhost:11434)
    PME_OLLAMA_KG_MODEL  — model for extraction (default: qwen3:8b)
    PME_NEO4J_URI        — Neo4j bolt URI (default: bolt://localhost:7687)
    PME_NEO4J_PASSWORD   — Neo4j password (overrides .secrets.json)
"""

import argparse
import logging
import json
import os
import re
import time
import traceback
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Any, Optional

# -- Config --
WORKSPACE = Path(os.environ.get("PME_WORKSPACE", str(Path.home() / "pentatonic")))
SECRETS_FILE = WORKSPACE / ".secrets.json"
STATE_FILE = WORKSPACE / "data" / "kg-preflexor-v2-state.json"
REFINEMENT_FILE = WORKSPACE / "data" / "kg-refinement-queue.json"
LOG_DIR = WORKSPACE / "logs"

CHAT_ROOT = WORKSPACE / "chats"
TG_DIR = CHAT_ROOT / "telegram"
WA_DIR = CHAT_ROOT / "whatsapp"
EMAIL_DIR = CHAT_ROOT / "email"
SLACK_DIR = CHAT_ROOT / "slack"
IMESSAGE_DIR = CHAT_ROOT / "imessage"

OLLAMA_URL = os.environ.get("PME_OLLAMA_URL", "http://localhost:11434")
MODEL = os.environ.get("PME_OLLAMA_KG_MODEL", "qwen3:8b")
DEFAULT_BATCH_SIZE = 15
DEFAULT_CONCURRENCY = 8  # batches at once (x2 passes = 16 Ollama calls)

DECISION_KEYWORDS = [
    "decided", "decision", "let's go with", "switching to", "approved",
    "rejected", "committed", "promise", "deadline", "budget", "investment",
    "contract", "agreement", "strategy", "pivot", "cancelled", "postponed"
]

# -- Pass Definitions --
PASS_A_SYSTEM = """Extract structured knowledge from chat messages. Output JSON with these arrays (empty array if nothing found):

- persons: [{"name": "str", "role": "str or null"}]
- projects: [{"name": "str", "status": "active|completed|paused|planned|abandoned or null"}]
- systems: [{"name": "str", "type": "service|cron|container|script|api|database or null"}]
- entities: [{"name": "str", "type": "company|tool|place|service|product|platform"}]
- decisions: [{"what": "str", "who": "str", "date": "YYYY-MM-DD or null", "reasoning": "str or null"}]
- commitments: [{"what": "str", "who": "str", "deadline": "YYYY-MM-DD or null", "status": "open|fulfilled|broken|cancelled"}]
- events: [{"name": "str", "date": "YYYY-MM-DD or null", "type": "meeting|deadline|incident|social|travel|appointment or null"}]
- transactions: [{"description": "str", "amount": "str or null", "date": "YYYY-MM-DD or null"}]
- incidents: [{"what_broke": "str", "date": "YYYY-MM-DD or null", "severity": "critical|high|medium|low"}]
- deadlines: [{"description": "str", "date": "YYYY-MM-DD or null", "status": "upcoming|met|missed|cancelled"}]
- topics: [{"name": "str", "category": "technical|personal|business|health|finance|social or null"}]
- lessons: [{"insight": "str", "source": "str or null", "date": "YYYY-MM-DD or null"}]
- preferences: [{"category": "food|tool|workflow|communication|schedule|other", "value": "str", "who": "str"}]
- routines: [{"name": "str", "frequency": "daily|weekly|monthly or null", "description": "str or null"}]

Rules:
- ONLY extract what is explicitly stated in the messages
- Do NOT invent or infer content not shown
- If nothing found for a category, use empty array"""

PASS_B_SYSTEM = """Analyse these chat messages and extract a knowledge graph. Return JSON with "nodes" and "edges" arrays.
Each node: {"id": "string", "type": "string"}
Each edge: {"source": "string", "relation": "string", "target": "string"}

Find ALL meaningful relationships -- especially:
- Implicit connections between people and projects
- Temporal sequences and causation
- Sentiment and attitude signals
- Technical dependencies
- Any patterns a rigid schema might miss

Rules:
- ONLY extract from the messages shown
- Do NOT invent content not present"""


# -- Ollama Client --
class OllamaClient:
    def __init__(self, base_url=OLLAMA_URL, model=MODEL):
        self.base_url = base_url
        self.model = model
        self.lock = Lock()
        self.total_tokens = 0
        self.total_time = 0.0
        self.total_calls = 0

    def warmup(self) -> None:
        print(f"  Warming up {self.model}...", end=" ", flush=True)
        t0 = time.time()
        self._call("system", "Say OK", 8)
        print(f"done ({time.time() - t0:.1f}s)", flush=True)

    def extract(self, system_prompt, user_prompt, max_tokens=768) -> None:
        for attempt in range(2):
            result = self._call(system_prompt, user_prompt, max_tokens)
            if result is None:
                continue
            with self.lock:
                self.total_tokens += result.get("tokens", 0)
                self.total_time += result.get("duration", 0)
                self.total_calls += 1
            data = self._parse_json(result["text"])
            if data is not None:
                return data
        return None

    def _call(self, system_prompt, user_prompt, max_tokens):
        payload = json.dumps({
            "model": self.model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt}
            ],
            "format": "json",
            "stream": False,
            "options": {"num_predict": max_tokens}
        }).encode()
        req = urllib.request.Request(
            f"{self.base_url}/api/chat", data=payload,
            headers={"Content-Type": "application/json"}, method="POST"
        )
        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                d = json.loads(resp.read())
                return {
                    "text": d.get("message", {}).get("content", ""),
                    "duration": d.get("total_duration", 0) / 1e9,
                    "tokens": d.get("eval_count", 0),
                }
        except Exception:
            return None

    def _parse_json(self, text):
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            pass
        for pat in [r'```json\s*\n?(.*?)\n?```', r'```\s*\n?(.*?)\n?```']:
            m = re.search(pat, text, re.DOTALL)
            if m:
                try:
                    return json.loads(m.group(1).strip())
                except json.JSONDecodeError:
                    pass
        s, e = text.find("{"), text.rfind("}")
        if s != -1 and e > s:
            try:
                return json.loads(text[s:e + 1])
            except json.JSONDecodeError:
                pass
        return None


# -- Schema Mapper --
PRED_MAP = {
    "decides": "DECIDED", "decided": "DECIDED", "chose": "DECIDED",
    "builds": "WORKS_ON", "built": "WORKS_ON", "develops": "WORKS_ON",
    "uses": "USES", "used": "USES", "runs": "USES",
    "manages": "MANAGES", "owns": "OWNS",
    "creates": "CREATED", "created": "CREATED",
    "mentions": "DISCUSSED", "discusses": "DISCUSSED",
    "commits": "COMMITTED_TO", "committed": "COMMITTED_TO",
    "breaks": "BROKE", "broke": "BROKE", "crashed": "BROKE",
    "fixes": "FIXED", "fixed": "FIXED", "resolved": "FIXED",
    "causes": "CAUSED", "caused": "CAUSED", "causes_problem": "CAUSED",
    "depends_on": "DEPENDS_ON", "requires": "DEPENDS_ON",
    "replaces": "LED_TO", "leads_to": "LED_TO",
    "rejects": "DECIDED", "prefers": "PREFERS", "likes": "PREFERS",
    "switches_to": "LED_TO", "connects": "CONNECTS_TO",
    "avoids": "REJECTED", "cancels": "CANCELLED",
}

TYPE_MAP = {
    "person": "Person", "human": "Person", "user": "Person", "agent": "Person",
    "project": "Project", "feature": "Project", "task": "Project",
    "system": "System", "service": "System", "tool": "System", "script": "System",
    "database": "System", "cron": "System", "container": "System", "api": "System",
    "company": "Entity", "organisation": "Entity", "organization": "Entity",
    "place": "Entity", "platform": "Entity", "product": "Entity",
    "topic": "Topic", "subject": "Topic", "event": "Event",
    "meeting": "Event", "routine": "Routine", "decision": "Decision",
    "lesson": "Lesson", "preference": "Preference", "deadline": "Deadline",
    "commitment": "Commitment", "incident": "Incident",
    "transaction": "Transaction", "subscription": "Transaction",
    "version": "System", "schedule": "Routine", "date": "Event",
    "data": "System", "briefing": "Event",
}


def map_native(data) -> tuple:
    """Map native nodes/edges to Neo4j ops. Returns (ops, novel_types)."""
    ops, novel = [], []
    for node in data.get("nodes", []):
        nid = node.get("id", "").strip()
        if not nid:
            continue
        ntype = node.get("type", "entity").lower()
        label = TYPE_MAP.get(ntype, "Entity")
        if ntype and ntype not in TYPE_MAP:
            novel.append(("node_type", ntype, nid))
        ops.append(("node", label, nid))
    for edge in data.get("edges", []):
        src, tgt = edge.get("source", "").strip(), edge.get("target", "").strip()
        if not src or not tgt:
            continue
        rel = edge.get("relation", "RELATES_TO").lower().replace(" ", "_")
        neo_rel = PRED_MAP.get(rel, re.sub(r"[^A-Z0-9_]", "_", rel.upper()) or "RELATES_TO")
        if rel and rel not in PRED_MAP:
            novel.append(("edge_type", rel, f"{src} -> {tgt}"))
        ops.append(("edge", neo_rel, src, tgt))
    return ops, novel


# -- Neo4j Writer --
class GraphWriter:
    def __init__(self, uri, user, password, dry_run=False):
        self.dry_run = dry_run
        self.driver = None
        self.lock = Lock()
        self.nodes_written = 0
        self.edges_written = 0
        self.novel_types = []
        if not dry_run:
            from neo4j import GraphDatabase
            self.driver = GraphDatabase.driver(uri, auth=(user, password))
            self._indexes()

    def close(self) -> None:
        if self.driver:
            self.driver.close()

    def _indexes(self):
        idxs = [
            "CREATE INDEX IF NOT EXISTS FOR (p:Person) ON (p.name)",
            "CREATE INDEX IF NOT EXISTS FOR (p:Project) ON (p.name)",
            "CREATE INDEX IF NOT EXISTS FOR (e:Entity) ON (e.name)",
            "CREATE INDEX IF NOT EXISTS FOR (s:System) ON (s.name)",
            "CREATE INDEX IF NOT EXISTS FOR (t:Topic) ON (t.name)",
            "CREATE INDEX IF NOT EXISTS FOR (d:Decision) ON (d.what)",
            "CREATE INDEX IF NOT EXISTS FOR (i:Incident) ON (i.what_broke)",
            "CREATE INDEX IF NOT EXISTS FOR (l:Lesson) ON (l.insight)",
            "CREATE INDEX IF NOT EXISTS FOR (c:Commitment) ON (c.what)",
            "CREATE INDEX IF NOT EXISTS FOR (e:Event) ON (e.name)",
            "CREATE INDEX IF NOT EXISTS FOR (r:Routine) ON (r.name)",
            "CREATE INDEX IF NOT EXISTS FOR (d:Deadline) ON (d.description)",
        ]
        with self.driver.session() as s:
            for idx in idxs:
                try:
                    s.run(idx)
                except Exception as e:
                    logging.debug(f"Suppressed: {e}")
                    pass

    def _run(self, query, **params):
        if self.dry_run:
            return
        clean = {k: (v if v is not None else "") for k, v in params.items()}
        with self.driver.session() as s:
            s.run(query, **clean)

    def ingest_structured(self, data, source_chat=None) -> int:
        if not data:
            return 0
        count = 0

        LINK_MAP = {
            "decisions":   ("who",  "MADE_DECISION",   "Decision",   "what",        "what"),
            "commitments": ("who",  "HAS_COMMITMENT",  "Commitment", "what",        "what"),
            "events":      (None,   "PARTICIPATED_IN", "Event",      "name",        "name"),
            "transactions":(None,   "MADE_TRANSACTION","Transaction","description", "description"),
            "incidents":   (None,   "EXPERIENCED",     "Incident",   "what_broke",  "what_broke"),
            "deadlines":   (None,   "HAS_DEADLINE",    "Deadline",   "description", "description"),
            "lessons":     (None,   "LEARNED",         "Lesson",     "insight",     "insight"),
            "preferences": ("who",  "HAS_PREFERENCE",  "Preference", "value",       "value"),
            "routines":    (None,   "FOLLOWS_ROUTINE", "Routine",    "name",        "name"),
        }

        HANDLERS = {
            "persons": lambda p: self._run("MERGE (n:Person {name: $name}) SET n.role = $role", name=p.get("name","").strip(), role=p.get("role","")),
            "projects": lambda p: self._run("MERGE (n:Project {name: $name}) SET n.status = $s, n.updated_at = datetime()", name=p.get("name","").strip(), s=p.get("status","active")),
            "systems": lambda p: self._run("MERGE (n:System {name: $name}) SET n.type = $t", name=p.get("name","").strip(), t=p.get("type","")),
            "entities": lambda p: self._run("MERGE (n:Entity {name: $name}) SET n.type = $t", name=p.get("name","").strip(), t=p.get("type","")),
            "decisions": lambda p: self._run("MERGE (n:Decision {what: $w}) SET n.who=$who, n.date=$d, n.reasoning=$r, n.source_chat=$src",
                w=p.get("what","").strip(), who=p.get("who",""), d=p.get("date",""), r=p.get("reasoning",""), src=source_chat or ""),
            "commitments": lambda p: self._run("MERGE (n:Commitment {what: $w}) SET n.who=$who, n.deadline=$d, n.status=$s, n.source_chat=$src",
                w=p.get("what","").strip(), who=p.get("who",""), d=p.get("deadline",""), s=p.get("status","open"), src=source_chat or ""),
            "events": lambda p: self._run("MERGE (n:Event {name: $name}) SET n.date=$d, n.type=$t, n.source_chat=$src",
                name=p.get("name","").strip(), d=p.get("date",""), t=p.get("type",""), src=source_chat or ""),
            "transactions": lambda p: self._run("MERGE (n:Transaction {description: $d}) SET n.amount=$a, n.date=$dt, n.source_chat=$src",
                d=p.get("description","").strip(), a=p.get("amount",""), dt=p.get("date",""), src=source_chat or ""),
            "incidents": lambda p: self._run("MERGE (n:Incident {what_broke: $w}) SET n.date=$d, n.severity=$s, n.source_chat=$src",
                w=p.get("what_broke","").strip(), d=p.get("date",""), s=p.get("severity","medium"), src=source_chat or ""),
            "deadlines": lambda p: self._run("MERGE (n:Deadline {description: $d}) SET n.date=$dt, n.status=$s, n.source_chat=$src",
                d=p.get("description","").strip(), dt=p.get("date",""), s=p.get("status","upcoming"), src=source_chat or ""),
            "topics": lambda p: self._run("MERGE (n:Topic {name: $name}) SET n.category=$c, n.source_chat=$src",
                name=p.get("name","").strip(), c=p.get("category",""), src=source_chat or ""),
            "lessons": lambda p: self._run("MERGE (n:Lesson {insight: $i}) SET n.source=$s, n.date=$d, n.source_chat=$src",
                i=p.get("insight","").strip(), s=p.get("source",""), d=p.get("date",""), src=source_chat or ""),
            "preferences": lambda p: self._run("MERGE (n:Preference {category: $c, value: $v}) SET n.who=$w, n.source_chat=$src",
                c=p.get("category","other"), v=p.get("value","").strip(), w=p.get("who",""), src=source_chat or ""),
            "routines": lambda p: self._run("MERGE (n:Routine {name: $name}) SET n.frequency=$f, n.description=$d, n.source_chat=$src",
                name=p.get("name","").strip(), f=p.get("frequency",""), d=p.get("description",""), src=source_chat or ""),
        }
        for key, handler in HANDLERS.items():
            for item in data.get(key, []):
                primary = item.get("name", item.get("what", item.get("insight", item.get("description", item.get("value", "")))))
                if not primary or not str(primary).strip():
                    continue
                try:
                    handler(item)
                    count += 1
                    if key in LINK_MAP:
                        who_field, rel_type, label, primary_field, param_name = LINK_MAP[key]
                        who = item.get(who_field, "") if who_field else None
                        primary_val = str(primary).strip()
                        if who and str(who).strip():
                            self._run(f"""
                                MATCH (p:Person {{name: $who}})
                                MATCH (n:{label} {{{primary_field}: $pval}})
                                MERGE (p)-[r:{rel_type}]->(n)
                                SET r.updated_at = datetime()
                            """, who=str(who).strip(), pval=primary_val)
                        elif source_chat:
                            self._run(f"""
                                MERGE (src:Entity {{name: $src, type: 'chat_source'}})
                                WITH src
                                MATCH (n:{label} {{{primary_field}: $pval}})
                                MERGE (src)-[r:EXTRACTED_FROM]->(n)
                                SET r.updated_at = datetime()
                            """, src=source_chat, pval=primary_val)
                except Exception as e:
                    logging.debug(f"Suppressed: {e}")
                    pass
        with self.lock:
            self.nodes_written += count
        return count

    def ingest_native(self, data) -> int:
        if not data:
            return 0
        ops, novel = map_native(data)
        count = 0
        for op in ops:
            try:
                if op[0] == "node":
                    self._run(f"MERGE (n:{op[1]} {{name: $name}})", name=op[2])
                    count += 1
                elif op[0] == "edge":
                    self._run(f"""
                        MATCH (a {{name: $src}}) MATCH (b {{name: $tgt}})
                        MERGE (a)-[r:{op[1]}]->(b) SET r.updated_at = datetime()
                    """, src=op[2], tgt=op[3])
                    count += 1
            except Exception as e:
                logging.debug(f"Suppressed: {e}")
                pass
        with self.lock:
            self.nodes_written += sum(1 for o in ops if o[0] == "node")
            self.edges_written += sum(1 for o in ops if o[0] == "edge")
            self.novel_types.extend(novel)
        return count


# -- Message Loading --
def load_messages(chat_dir, offset=0) -> Any:
    msgs = []
    for f in sorted(chat_dir.glob("*.jsonl")):
        with open(f) as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    msgs.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    return msgs[offset:]


def format_batch(messages) -> Any:
    lines = []
    for msg in messages:
        ts = msg.get("timestamp", msg.get("date", msg.get("t", "")))
        sender = msg.get("sender", msg.get("from", msg.get("author", "Unknown")))
        body = msg.get("body", msg.get("text", msg.get("message", "")))
        if not body or not body.strip():
            continue
        if len(body) > 800:
            body = body[:800] + "...[truncated]"
        lines.append(f"[{ts}] {sender}: {body}")
    return "\n".join(lines)


def is_decision_dense(text) -> Any:
    return sum(1 for kw in DECISION_KEYWORDS if kw in text.lower()) >= 3


# -- State --
def load_state() -> Any:
    if STATE_FILE.exists():
        try:
            return json.load(open(STATE_FILE))
        except Exception as e:
            logging.debug(f"Suppressed: {e}")
            pass
    return {"sources": {}, "last_run": None, "total_batches": 0,
            "total_items": 0, "novel_types": []}

def save_state(state) -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    state["last_run"] = datetime.now(timezone.utc).isoformat()
    json.dump(state, open(STATE_FILE, "w"), indent=2, default=str)

def load_refinement_queue() -> Any:
    if REFINEMENT_FILE.exists():
        try:
            return json.load(open(REFINEMENT_FILE))
        except Exception as e:
            logging.debug(f"Suppressed: {e}")
            pass
    return {"batches": []}

def save_refinement_queue(q) -> None:
    REFINEMENT_FILE.parent.mkdir(parents=True, exist_ok=True)
    json.dump(q, open(REFINEMENT_FILE, "w"), indent=2)


# -- Secrets --
def get_neo4j_config() -> dict:
    uri = os.environ.get("PME_NEO4J_URI", "bolt://localhost:7687")
    pw = os.environ.get("PME_NEO4J_PASSWORD", "")
    if pw:
        return {"uri": uri, "user": "neo4j", "password": pw}
    if SECRETS_FILE.exists():
        try:
            secrets = json.load(open(SECRETS_FILE))
            neo4j = secrets.get("neo4j", {})
            if isinstance(neo4j, dict) and neo4j.get("password"):
                return {"uri": neo4j.get("uri", uri),
                        "user": neo4j.get("user", "neo4j"), "password": neo4j["password"]}
            pw = secrets.get("neo4j_password", "")
            if pw:
                return {"uri": uri, "user": "neo4j", "password": pw}
        except Exception:
            pass
    return {"uri": uri, "user": "neo4j", "password": "password"}


# -- Single Batch Processing --
def process_one_batch(client, writer, batch_text, batch_id, verbose=False, source_chat=None) -> tuple:
    """Process a single batch with 2 concurrent passes. Returns (structured_count, native_count, score)."""
    results = {}

    with ThreadPoolExecutor(max_workers=2) as executor:
        fa = executor.submit(client.extract, PASS_A_SYSTEM, batch_text, 768)
        fb = executor.submit(client.extract, PASS_B_SYSTEM, batch_text, 1024)
        results["structured"] = fa.result()
        results["native"] = fb.result()

    s_count = writer.ingest_structured(results["structured"], source_chat=source_chat) if results["structured"] else 0
    n_count = writer.ingest_native(results["native"]) if results["native"] else 0

    score = 0
    if results["structured"]:
        filled = sum(1 for k, v in results["structured"].items() if isinstance(v, list) and v)
        score += min(filled * 7, 50)
    if results["native"]:
        nodes = len(results["native"].get("nodes", []))
        edges = len(results["native"].get("edges", []))
        if nodes > 0:
            score += 25
        if edges > 0:
            score += 25

    return s_count, n_count, score, results


# -- Main Processing --
def process_source(source_type, chat_dir, client, writer, state, batch_size,
                   concurrency, test_mode=False, verbose=False):
    if not chat_dir.exists():
        print(f"  No {source_type} directory found")
        return

    chat_dirs = [d for d in chat_dir.iterdir() if d.is_dir()]
    print(f"  Found {len(chat_dirs)} {source_type} chats")
    refinement_queue = load_refinement_queue()

    for cdir in sorted(chat_dirs):
        chat_id = cdir.name
        state_key = f"{source_type}:{chat_id}"
        chat_state = state["sources"].get(state_key, {"offset": 0, "processed": 0})
        offset = chat_state.get("offset", 0)

        messages = load_messages(cdir, offset)
        if not messages or (len(messages) < 5 and not test_mode):
            continue

        total = len(messages)
        num_batches = (total + batch_size - 1) // batch_size
        print(f"\n  {state_key}: {total} msgs from offset {offset} ({num_batches} batches)")

        batches = []
        for i in range(0, total, batch_size):
            batch = messages[i:i + batch_size]
            text = format_batch(batch)
            if text.strip():
                batches.append((i, batch, text))

        wave_num = 0
        for wave_start in range(0, len(batches), concurrency):
            wave = batches[wave_start:wave_start + concurrency]
            wave_num += 1
            wave_total = (len(batches) + concurrency - 1) // concurrency
            print(f"    Wave {wave_num}/{wave_total} ({len(wave)} batches)...", end=" ", flush=True)

            t0 = time.time()
            wave_items = 0
            wave_results = {}

            with ThreadPoolExecutor(max_workers=concurrency) as executor:
                futures = {}
                for idx, (batch_offset, batch, text) in enumerate(wave):
                    f = executor.submit(process_one_batch, client, writer, text, idx, verbose, source_chat=state_key)
                    futures[f] = (batch_offset, batch, text)

                for f in as_completed(futures):
                    batch_offset, batch, text = futures[f]
                    try:
                        s_count, n_count, score, results = f.result()
                        wave_items += s_count + n_count
                        wave_results[batch_offset] = (s_count, n_count, score, text)
                    except Exception as e:
                        print(f"X", end="", flush=True)
                        wave_results[batch_offset] = (0, 0, 0, text)

            elapsed = time.time() - t0

            for batch_offset, batch, text in wave:
                s_count, n_count, score, _ = wave_results.get(batch_offset, (0, 0, 0, text))

                if is_decision_dense(text) or score < 40:
                    refinement_queue["batches"].append({
                        "source": state_key, "offset": offset + batch_offset,
                        "size": len(batch), "score": score,
                        "decision_dense": is_decision_dense(text),
                        "timestamp": datetime.now(timezone.utc).isoformat()
                    })

                new_offset = offset + batch_offset + len(batch)
                state["sources"][state_key] = {
                    "offset": new_offset,
                    "processed": chat_state.get("processed", 0) + len(batch)
                }

            state["total_batches"] = state.get("total_batches", 0) + len(wave)
            state["total_items"] = state.get("total_items", 0) + wave_items
            save_state(state)
            save_refinement_queue(refinement_queue)

            print(f"OK {wave_items} items, {elapsed:.1f}s ({elapsed/len(wave):.1f}s/batch)", flush=True)

            if writer.novel_types:
                for nt in writer.novel_types[-5:]:
                    print(f"      NEW {nt[0]}: {nt[1]} (from: {nt[2]})")
                state.setdefault("novel_types", []).extend([
                    {"type": t, "value": v, "example": e}
                    for t, v, e in writer.novel_types[-20:]
                ])
                writer.novel_types = []

            if test_mode:
                print(f"\n  Test mode -- showing first batch detail:")
                first_offset = wave[0][0]
                s, n, score, text = wave_results[first_offset]
                print(f"  Structured: {s} items | Native: {n} items | Score: {score}")
                r = process_one_batch(client, writer, wave[0][2], 0, True, source_chat=state_key)
                if r[3].get("structured"):
                    print(f"\n  === Structured ===")
                    for k, v in r[3]["structured"].items():
                        if isinstance(v, list) and v:
                            print(f"  {k}: {json.dumps(v, indent=2)[:500]}")
                if r[3].get("native"):
                    print(f"\n  === Native ===")
                    print(json.dumps(r[3]["native"], indent=2)[:1000])
                return


def show_stats(neo4j_config) -> None:
    from neo4j import GraphDatabase
    driver = GraphDatabase.driver(neo4j_config["uri"],
                                  auth=(neo4j_config["user"], neo4j_config["password"]))
    with driver.session() as s:
        total = s.run("MATCH (n) RETURN count(n) as c").single()["c"]
        rels = s.run("MATCH ()-[r]->() RETURN count(r) as c").single()["c"]
        print(f"\nKnowledge Graph Statistics")
        print(f"{'='*50}")
        print(f"Total nodes: {total}")
        print(f"Total relationships: {rels}")
        labels = s.run("MATCH (n) RETURN DISTINCT labels(n)[0] as l, count(n) as c ORDER BY c DESC").data()
        print(f"\nBy type:")
        for r in labels:
            print(f"  {r['l']}: {r['c']}")
        rel_types = s.run("MATCH ()-[r]->() RETURN type(r) as t, count(r) as c ORDER BY c DESC LIMIT 15").data()
        if rel_types:
            print(f"\nRelationships:")
            for r in rel_types:
                print(f"  {r['t']}: {r['c']}")
    state = load_state()
    print(f"\nPipeline: {state.get('total_batches',0)} batches, {state.get('total_items',0)} items")
    novel = state.get("novel_types", [])
    if novel:
        print(f"Novel types: {len(novel)}")
    rq = load_refinement_queue()
    if rq["batches"]:
        print(f"Refinement queue: {len(rq['batches'])} batches")
    driver.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="KG V2 — 2-Pass Concurrent Hybrid")
    parser.add_argument("--source", help="telegram,whatsapp")
    parser.add_argument("--stats", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--reset", action="store_true")
    parser.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE)
    parser.add_argument("--concurrency", type=int, default=DEFAULT_CONCURRENCY)
    parser.add_argument("--test-batch", action="store_true")
    parser.add_argument("--verbose", "-v", action="store_true")
    args = parser.parse_args()

    neo4j_config = get_neo4j_config()

    if args.stats:
        show_stats(neo4j_config)
        return

    if args.reset:
        if STATE_FILE.exists():
            STATE_FILE.unlink()
            print("State cleared")

    state = load_state()
    client = OllamaClient(OLLAMA_URL, MODEL)
    client.warmup()
    writer = GraphWriter(neo4j_config["uri"], neo4j_config["user"],
                         neo4j_config["password"], dry_run=args.dry_run)

    ALL_SOURCES = {
        "telegram":  ("TG", TG_DIR),
        "whatsapp":  ("WA", WA_DIR),
        "email":     ("EM", EMAIL_DIR),
        "slack":     ("SL", SLACK_DIR),
        "imessage":  ("IM", IMESSAGE_DIR),
    }
    sources = args.source.split(",") if args.source else list(ALL_SOURCES.keys())
    total_calls = args.concurrency * 2

    print(f"\nKG V2 — 2-Pass Concurrent Hybrid via Ollama")
    print(f"{'='*60}")
    print(f"Model: {MODEL} | Batch: {args.batch_size} msgs | Concurrency: {args.concurrency} batches ({total_calls} calls)")
    print(f"Sources: {', '.join(sources)} | Dry run: {args.dry_run} | Cost: $0.00")
    print(f"{'='*60}")

    try:
        for src in sources:
            icon, d = ALL_SOURCES.get(src, ("??", CHAT_ROOT / src))
            print(f"\n[{icon}] {src.title()}...")
            process_source(src, d, client, writer, state, args.batch_size,
                          args.concurrency, test_mode=args.test_batch, verbose=args.verbose)
    except KeyboardInterrupt:
        print("\nInterrupted -- state saved")
    except Exception as e:
        print(f"\nError: {e}")
        traceback.print_exc()
    finally:
        save_state(state)
        writer.close()
        avg = client.total_time / max(client.total_calls, 1)
        tps = client.total_tokens / max(client.total_time, 0.1)
        print(f"\n{'='*60}")
        print(f"Summary")
        print(f"  Batches: {state.get('total_batches', 0)}")
        print(f"  Ollama calls: {client.total_calls} ({avg:.1f}s avg, {tps:.0f} tok/s)")
        print(f"  Neo4j: {writer.nodes_written} nodes, {writer.edges_written} edges")
        print(f"  Items total: {state.get('total_items', 0)}")
        print(f"  Cost: $0.00")
        rq = load_refinement_queue()
        if rq["batches"]:
            print(f"  Refinement queue: {len(rq['batches'])} batches")

        if not args.dry_run and writer.nodes_written > 0:
            print("\nRefreshing node degrees for bridge inference...")
            try:
                import subprocess as _sp
                _r = _sp.run(
                    ["python3", str(Path(__file__).parent / "graph-reasoner.py"), "precompute-degrees"],
                    capture_output=True, text=True, timeout=60
                )
                if _r.returncode == 0:
                    print("  Degrees refreshed")
                else:
                    print(f"  Degree refresh failed: {_r.stderr[:200]}")
            except Exception as _e:
                print(f"  Degree refresh skipped: {_e}")


if __name__ == "__main__":
    main()
