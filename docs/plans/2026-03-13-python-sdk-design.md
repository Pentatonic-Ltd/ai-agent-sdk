# Python Agent Events SDK — Design

## Goal

Python port of `@pentatonic-ai/agent-events` with feature parity, sharing the same repo and README.

## Structure

`python/pentatonic_agent_events/` alongside existing `src/` (JS).

```
ai-events-sdk/
├── src/                          # JS source (unchanged)
├── python/
│   ├── pentatonic_agent_events/
│   │   ├── __init__.py           # Public exports
│   │   ├── client.py             # TESClient
│   │   ├── session.py            # Session
│   │   ├── normalizer.py         # normalize_response()
│   │   ├── wrapper.py            # Provider wrapping
│   │   └── transport.py          # GraphQL via urllib
│   └── tests/
│       ├── test_normalizer.py
│       ├── test_session.py
│       └── test_wrapper.py
├── package.json                  # JS (unchanged)
├── pyproject.toml                # Python packaging
└── README.md                     # Shared — JS + Python examples
```

## Module Mapping (JS → Python)

| JS file | Python file | Purpose |
|---------|------------|---------|
| `src/client.js` | `client.py` | `TESClient` — config, `session()`, `wrap()` |
| `src/session.js` | `session.py` | `Session` — record, emit, accumulate |
| `src/normalizer.js` | `normalizer.py` | `normalize_response()` — duck-type detection |
| `src/wrapper.js` | `wrapper.py` | Provider wrapping with auto-emission |
| `src/transport.js` | `transport.py` | GraphQL mutation via `urllib.request` |
| `src/index.js` | `__init__.py` | Public exports |

## API Surface

```python
from pentatonic_agent_events import TESClient

tes = TESClient(
    client_id="...",
    api_key="...",
    endpoint="...",
)

# Wrap — auto-emit on every call
openai_client = tes.wrap(OpenAI())
response = openai_client.chat.completions.create(...)

# Sessions — accumulate across rounds
session = openai_client.session(session_id="conv-123")
r1 = session.chat(...)
r2 = session.chat(...)
session.emit_chat_turn(user_message="...", assistant_response="...")

# Manual — record + emit yourself
session = tes.session(session_id="conv-123", metadata={"user_id": "u_456"})
session.record(response)
session.emit_chat_turn(user_message="...", assistant_response="...")
```

## Providers

Same three as JS, detected via duck-typing:
- **OpenAI**: `hasattr(client, 'chat')` and `hasattr(client.chat, 'completions')`
- **Anthropic**: `hasattr(client, 'messages')` and `hasattr(client.messages, 'create')`
- **Workers AI**: `callable(client.run)` (for Cloudflare Python bindings)

## Dependencies

Zero runtime dependencies. `urllib.request` for HTTP, `uuid` from stdlib.

## Packaging

- `pyproject.toml` at repo root
- Package name: `pentatonic-agent-events`
- Build backend: `hatchling` with `python/` as source root
- Python >=3.9

## Tests

`pytest` in `python/tests/`, mirroring JS test structure. Mock `urllib.request.urlopen` for transport tests.

## CLI Update

Update `bin/cli.js` to offer install choice at the end:
- `npm install @pentatonic-ai/agent-events`
- `pip install pentatonic-agent-events`
- Skip

## README

Shared at root. Add Python tab/section alongside each JS example.

## Non-Goals

- Async/await (keep it sync like urllib — async can come later)
- Python CLI (use the JS one)
- Type stubs package (inline types in the code are sufficient)
