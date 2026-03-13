# Python Agent Events SDK — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Port `@pentatonic-ai/agent-events` to Python with full feature parity, sharing the same repo and README.

**Architecture:** Six Python modules mirroring the JS SDK 1:1 — `transport.py`, `normalizer.py`, `session.py`, `client.py`, `wrapper.py`, `__init__.py` — plus `pyproject.toml` for packaging, pytest tests mirroring the JS test suite, a CLI update to offer `pip install` as an option, and a shared README with both JS and Python examples.

**Tech Stack:** Python 3.9+, stdlib only (`urllib.request`, `uuid`, `json`), `pytest` for tests, `hatchling` build backend.

---

### Task 1: Packaging — `pyproject.toml`

**Files:**
- Create: `pyproject.toml`

**Step 1: Create `pyproject.toml`**

```toml
[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[project]
name = "pentatonic-agent-events"
version = "0.1.0b3"
description = "LLM observability SDK — track token usage, tool calls, and conversations via Pentatonic TES"
readme = "README.md"
license = "MIT"
requires-python = ">=3.9"
keywords = ["llm", "observability", "ai", "openai", "anthropic", "pentatonic"]
classifiers = [
    "Development Status :: 4 - Beta",
    "License :: OSI Approved :: MIT License",
    "Programming Language :: Python :: 3",
    "Programming Language :: Python :: 3.9",
    "Programming Language :: Python :: 3.10",
    "Programming Language :: Python :: 3.11",
    "Programming Language :: Python :: 3.12",
    "Programming Language :: Python :: 3.13",
]

[project.urls]
Homepage = "https://github.com/Pentatonic-Ltd/ai-events-sdk"
Repository = "https://github.com/Pentatonic-Ltd/ai-events-sdk"

[tool.hatch.build.targets.wheel]
packages = ["python/pentatonic_agent_events"]

[tool.pytest.ini_options]
testpaths = ["python/tests"]
```

**Step 2: Create package directory**

```bash
mkdir -p python/pentatonic_agent_events python/tests
```

**Step 3: Commit**

```bash
git add pyproject.toml python/
git commit -m "chore: add pyproject.toml and Python package skeleton"
```

---

### Task 2: Transport — `python/pentatonic_agent_events/transport.py`

**Files:**
- Create: `python/pentatonic_agent_events/transport.py`
- Create: `python/tests/test_transport.py`

This mirrors `src/transport.js`. Uses `urllib.request` instead of `fetch`. Same GraphQL mutation, same auth header logic (`tes_` prefix → Bearer, else `x-service-key`).

**Step 1: Write the failing test**

Create `python/tests/test_transport.py`:

```python
import json
from unittest.mock import patch, MagicMock
from pentatonic_agent_events.transport import send_event


EMIT_EVENT_MUTATION = """
  mutation EmitEvent($input: EventInput!) {
    emitEvent(input: $input) {
      success
      eventId
      message
    }
  }
"""


def _mock_response(data, status=200):
    """Create a mock urllib response."""
    resp = MagicMock()
    resp.status = status
    resp.read.return_value = json.dumps(data).encode()
    resp.__enter__ = MagicMock(return_value=resp)
    resp.__exit__ = MagicMock(return_value=False)
    return resp


class TestSendEvent:
    def test_sends_graphql_mutation_with_bearer_auth(self):
        config = {
            "endpoint": "https://api.test.com",
            "api_key": "tes_sk_test123",
            "client_id": "test-client",
            "headers": {},
        }
        event_input = {
            "eventType": "CHAT_TURN",
            "entityType": "conversation",
            "data": {"entity_id": "sess-1", "attributes": {"model": "gpt-4o"}},
        }
        mock_resp = _mock_response({
            "data": {"emitEvent": {"success": True, "eventId": "evt-1", "message": None}}
        })

        with patch("pentatonic_agent_events.transport.urlopen", return_value=mock_resp) as mock_urlopen:
            result = send_event(config, event_input)

        assert result == {"success": True, "eventId": "evt-1", "message": None}

        # Verify the request
        call_args = mock_urlopen.call_args
        req = call_args[0][0]
        assert req.full_url == "https://api.test.com/api/graphql"
        assert req.get_header("Authorization") == "Bearer tes_sk_test123"
        assert req.get_header("X-client-id") == "test-client"
        assert req.get_header("Content-type") == "application/json"

        body = json.loads(req.data)
        assert "emitEvent" in body["query"]
        assert body["variables"]["input"] == event_input

    def test_sends_service_key_for_non_tes_tokens(self):
        config = {
            "endpoint": "https://api.test.com",
            "api_key": "internal_key_abc",
            "client_id": "test-client",
            "headers": {},
        }
        mock_resp = _mock_response({
            "data": {"emitEvent": {"success": True, "eventId": "evt-2", "message": None}}
        })

        with patch("pentatonic_agent_events.transport.urlopen", return_value=mock_resp) as mock_urlopen:
            send_event(config, {"eventType": "TEST"})

        req = mock_urlopen.call_args[0][0]
        assert req.get_header("X-service-key") == "internal_key_abc"
        assert req.get_header("Authorization") is None

    def test_includes_custom_headers(self):
        config = {
            "endpoint": "https://api.test.com",
            "api_key": "tes_sk_test",
            "client_id": "c",
            "headers": {"X-Custom": "value"},
        }
        mock_resp = _mock_response({
            "data": {"emitEvent": {"success": True, "eventId": "evt-3", "message": None}}
        })

        with patch("pentatonic_agent_events.transport.urlopen", return_value=mock_resp) as mock_urlopen:
            send_event(config, {"eventType": "TEST"})

        req = mock_urlopen.call_args[0][0]
        assert req.get_header("X-custom") == "value"

    def test_raises_on_http_error(self):
        config = {
            "endpoint": "https://api.test.com",
            "api_key": "tes_sk_test",
            "client_id": "c",
            "headers": {},
        }

        from urllib.error import HTTPError
        import io

        with patch("pentatonic_agent_events.transport.urlopen") as mock_urlopen:
            mock_urlopen.side_effect = HTTPError(
                "https://api.test.com/api/graphql", 500, "Internal Server Error",
                {}, io.BytesIO(b"error")
            )
            try:
                send_event(config, {"eventType": "TEST"})
                assert False, "Should have raised"
            except Exception as e:
                assert "500" in str(e) or "Internal Server Error" in str(e)

    def test_raises_on_graphql_error(self):
        config = {
            "endpoint": "https://api.test.com",
            "api_key": "tes_sk_test",
            "client_id": "c",
            "headers": {},
        }
        mock_resp = _mock_response({
            "errors": [{"message": "Invalid input"}]
        })

        with patch("pentatonic_agent_events.transport.urlopen", return_value=mock_resp):
            try:
                send_event(config, {"eventType": "TEST"})
                assert False, "Should have raised"
            except Exception as e:
                assert "Invalid input" in str(e)
```

**Step 2: Run test to verify it fails**

```bash
cd /home/phil/Development/takebacks/ai-events-sdk && python -m pytest python/tests/test_transport.py -v
```

Expected: `ModuleNotFoundError: No module named 'pentatonic_agent_events'`

**Step 3: Write minimal implementation**

Create `python/pentatonic_agent_events/transport.py`:

```python
import json
from urllib.request import Request, urlopen

EMIT_EVENT_MUTATION = """
  mutation EmitEvent($input: EventInput!) {
    emitEvent(input: $input) {
      success
      eventId
      message
    }
  }
"""


def send_event(config, event_input):
    endpoint = config["endpoint"]
    api_key = config["api_key"]
    client_id = config["client_id"]
    extra_headers = config.get("headers") or {}

    # tes_ prefixed tokens are API tokens — send as Authorization: Bearer
    # Other tokens (internal service keys) go as x-service-key
    if api_key.startswith("tes_"):
        auth_headers = {"Authorization": f"Bearer {api_key}"}
    else:
        auth_headers = {"x-service-key": api_key}

    headers = {
        "Content-Type": "application/json",
        "x-client-id": client_id,
        **auth_headers,
        **extra_headers,
    }

    body = json.dumps({
        "query": EMIT_EVENT_MUTATION,
        "variables": {"input": event_input},
    }).encode()

    req = Request(f"{endpoint}/api/graphql", data=body, headers=headers, method="POST")

    with urlopen(req) as resp:
        data = json.loads(resp.read())

    if data.get("errors"):
        raise RuntimeError(f"TES GraphQL error: {data['errors'][0]['message']}")

    return data["data"]["emitEvent"]
```

Also create `python/pentatonic_agent_events/__init__.py` (empty for now so the package is importable):

```python
```

**Step 4: Run test to verify it passes**

```bash
cd /home/phil/Development/takebacks/ai-events-sdk && python -m pytest python/tests/test_transport.py -v
```

Expected: All 5 tests PASS

**Step 5: Commit**

```bash
git add python/pentatonic_agent_events/transport.py python/pentatonic_agent_events/__init__.py python/tests/test_transport.py
git commit -m "feat(python): add transport module — GraphQL event emission via urllib"
```

---

### Task 3: Normalizer — `python/pentatonic_agent_events/normalizer.py`

**Files:**
- Create: `python/pentatonic_agent_events/normalizer.py`
- Create: `python/tests/test_normalizer.py`

This mirrors `src/normalizer.js`. Duck-type detection of OpenAI, Anthropic, and Workers AI response shapes. Returns dict with `content`, `model`, `usage`, `tool_calls` keys.

**Step 1: Write the failing test**

Create `python/tests/test_normalizer.py`:

```python
from pentatonic_agent_events.normalizer import normalize_response


class TestNormalizeOpenAI:
    def test_normalizes_openai_format(self):
        result = normalize_response({
            "choices": [{
                "message": {
                    "content": "Hello!",
                    "tool_calls": [{
                        "id": "call_1",
                        "function": {"name": "search", "arguments": '{"q":"shoes"}'},
                    }],
                },
            }],
            "usage": {"prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 150},
            "model": "gpt-4o",
        })

        assert result["content"] == "Hello!"
        assert result["model"] == "gpt-4o"
        assert result["usage"]["prompt_tokens"] == 100
        assert result["usage"]["completion_tokens"] == 50
        assert len(result["tool_calls"]) == 1
        assert result["tool_calls"][0]["tool"] == "search"
        assert result["tool_calls"][0]["args"] == {"q": "shoes"}

    def test_openai_no_tool_calls(self):
        result = normalize_response({
            "choices": [{"message": {"content": "Just text."}}],
            "usage": {"prompt_tokens": 50, "completion_tokens": 20, "total_tokens": 70},
            "model": "gpt-4o-mini",
        })

        assert result["content"] == "Just text."
        assert result["tool_calls"] == []

    def test_openai_top_level_tool_calls(self):
        """Workers AI sometimes returns choices[] but puts tool_calls at top level."""
        result = normalize_response({
            "choices": [{"message": {"content": ""}}],
            "tool_calls": [{
                "function": {"name": "search_products", "arguments": '{"query":"red shoes"}'},
            }],
            "usage": {"prompt_tokens": 50, "completion_tokens": 10},
        })

        assert len(result["tool_calls"]) == 1
        assert result["tool_calls"][0]["tool"] == "search_products"
        assert result["tool_calls"][0]["args"] == {"query": "red shoes"}

    def test_prefers_message_tool_calls_over_top_level(self):
        result = normalize_response({
            "choices": [{
                "message": {
                    "content": "",
                    "tool_calls": [{"function": {"name": "from_message", "arguments": "{}"}}],
                },
            }],
            "tool_calls": [{"function": {"name": "from_top_level", "arguments": "{}"}}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5},
        })

        assert len(result["tool_calls"]) == 1
        assert result["tool_calls"][0]["tool"] == "from_message"

    def test_parses_stringified_arguments(self):
        result = normalize_response({
            "choices": [{
                "message": {
                    "content": "",
                    "tool_calls": [{
                        "function": {"name": "fn", "arguments": '{"key":"value"}'},
                    }],
                },
            }],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
        })

        assert result["tool_calls"][0]["args"] == {"key": "value"}


class TestNormalizeAnthropic:
    def test_normalizes_anthropic_format(self):
        result = normalize_response({
            "content": [
                {"type": "text", "text": "Let me search."},
                {"type": "tool_use", "id": "tu_1", "name": "search", "input": {"query": "shoes"}},
            ],
            "usage": {"input_tokens": 200, "output_tokens": 60},
            "model": "claude-sonnet-4-6-20250514",
        })

        assert result["content"] == "Let me search."
        assert result["model"] == "claude-sonnet-4-6-20250514"
        assert result["usage"]["prompt_tokens"] == 200
        assert result["usage"]["completion_tokens"] == 60
        assert len(result["tool_calls"]) == 1
        assert result["tool_calls"][0]["tool"] == "search"
        assert result["tool_calls"][0]["args"] == {"query": "shoes"}


class TestNormalizeWorkersAI:
    def test_normalizes_workers_ai_format(self):
        result = normalize_response({
            "response": "Hi there!",
            "tool_calls": [{"name": "lookup", "arguments": {"id": "123"}}],
            "usage": {"prompt_tokens": 80, "completion_tokens": 30},
        })

        assert result["content"] == "Hi there!"
        assert result["usage"]["prompt_tokens"] == 80
        assert result["usage"]["completion_tokens"] == 30
        assert len(result["tool_calls"]) == 1
        assert result["tool_calls"][0]["tool"] == "lookup"
        assert result["tool_calls"][0]["args"] == {"id": "123"}


class TestNormalizeEdgeCases:
    def test_empty_dict(self):
        result = normalize_response({})
        assert result["content"] == ""
        assert result["model"] is None
        assert result["usage"]["prompt_tokens"] == 0
        assert result["usage"]["completion_tokens"] == 0
        assert result["tool_calls"] == []

    def test_none(self):
        result = normalize_response(None)
        assert result["content"] == ""
        assert result["model"] is None

    def test_non_dict(self):
        result = normalize_response("string")
        assert result["content"] == ""
```

**Step 2: Run test to verify it fails**

```bash
cd /home/phil/Development/takebacks/ai-events-sdk && python -m pytest python/tests/test_normalizer.py -v
```

Expected: `ModuleNotFoundError: No module named 'pentatonic_agent_events.normalizer'`

**Step 3: Write minimal implementation**

Create `python/pentatonic_agent_events/normalizer.py`:

```python
import json


def normalize_response(raw):
    if not raw or not isinstance(raw, dict):
        return _empty()

    # OpenAI SDK format: { choices, usage, model }
    if isinstance(raw.get("choices"), list):
        return _normalize_openai(raw)

    # Anthropic SDK format: { content: [{ type: "text"|"tool_use", ... }] }
    content = raw.get("content")
    if isinstance(content, list) and content and isinstance(content[0], dict) and "type" in content[0]:
        return _normalize_anthropic(raw)

    # Workers AI format: { response: "...", tool_calls: [...] }
    if isinstance(raw.get("response"), str) or (raw.get("tool_calls") and not raw.get("choices")):
        return _normalize_workers_ai(raw)

    return _empty()


def _empty():
    return {
        "content": "",
        "model": None,
        "usage": {"prompt_tokens": 0, "completion_tokens": 0},
        "tool_calls": [],
    }


def _normalize_openai(raw):
    choices = raw.get("choices") or []
    message = choices[0].get("message", {}) if choices else {}
    usage = raw.get("usage") or {}

    # Workers AI sometimes puts tool_calls at top level instead of inside message
    msg_tool_calls = message.get("tool_calls") or []
    raw_tool_calls = msg_tool_calls if msg_tool_calls else (raw.get("tool_calls") or [])

    tool_calls = [
        {
            "tool": tc.get("function", {}).get("name") or tc.get("name", ""),
            "args": _parse_args(tc.get("function", {}).get("arguments") or tc.get("arguments")),
        }
        for tc in raw_tool_calls
    ]

    return {
        "content": message.get("content") or "",
        "model": raw.get("model"),
        "usage": {
            "prompt_tokens": usage.get("prompt_tokens", 0),
            "completion_tokens": usage.get("completion_tokens", 0),
        },
        "tool_calls": tool_calls,
    }


def _normalize_anthropic(raw):
    usage = raw.get("usage") or {}
    content = ""
    tool_calls = []

    for block in raw.get("content", []):
        if block.get("type") == "text":
            content += block.get("text", "")
        elif block.get("type") == "tool_use":
            tool_calls.append({
                "tool": block.get("name", ""),
                "args": block.get("input") or {},
            })

    return {
        "content": content,
        "model": raw.get("model"),
        "usage": {
            "prompt_tokens": usage.get("input_tokens", 0),
            "completion_tokens": usage.get("output_tokens", 0),
        },
        "tool_calls": tool_calls,
    }


def _normalize_workers_ai(raw):
    usage = raw.get("usage") or {}
    raw_tool_calls = raw.get("tool_calls") or []

    tool_calls = [
        {
            "tool": tc.get("function", {}).get("name") or tc.get("name", ""),
            "args": _parse_args(tc.get("function", {}).get("arguments") or tc.get("arguments") or {}),
        }
        for tc in raw_tool_calls
    ]

    return {
        "content": raw.get("response") or "",
        "model": raw.get("model"),
        "usage": {
            "prompt_tokens": usage.get("prompt_tokens", 0),
            "completion_tokens": usage.get("completion_tokens", 0),
        },
        "tool_calls": tool_calls,
    }


def _parse_args(args):
    if isinstance(args, str):
        try:
            return json.loads(args)
        except (json.JSONDecodeError, ValueError):
            return {}
    return args or {}
```

**Step 4: Run test to verify it passes**

```bash
cd /home/phil/Development/takebacks/ai-events-sdk && python -m pytest python/tests/test_normalizer.py -v
```

Expected: All 10 tests PASS

**Step 5: Commit**

```bash
git add python/pentatonic_agent_events/normalizer.py python/tests/test_normalizer.py
git commit -m "feat(python): add normalizer — duck-type OpenAI/Anthropic/Workers AI responses"
```

---

### Task 4: Session — `python/pentatonic_agent_events/session.py`

**Files:**
- Create: `python/pentatonic_agent_events/session.py`
- Create: `python/tests/test_session.py`

This mirrors `src/session.js`. Session accumulates usage/tool calls across `record()` calls, then emits via `emit_chat_turn()`, `emit_tool_use()`, or `emit_session_start()`. Resets internal state after emit.

**Step 1: Write the failing test**

Create `python/tests/test_session.py`:

```python
import json
from unittest.mock import patch, MagicMock
from pentatonic_agent_events.session import Session


def _mock_urlopen(captured_requests):
    """Return a mock urlopen that captures requests and returns success."""
    def mock_fn(req):
        captured_requests.append(req)
        resp = MagicMock()
        resp.read.return_value = json.dumps({
            "data": {"emitEvent": {"success": True, "eventId": "evt-123", "message": None}}
        }).encode()
        resp.__enter__ = MagicMock(return_value=resp)
        resp.__exit__ = MagicMock(return_value=False)
        return resp
    return mock_fn


CONFIG = {
    "endpoint": "https://api.test.com",
    "api_key": "tes_sk_test",
    "client_id": "test-client",
    "headers": {},
    "capture_content": True,
    "max_content_length": 4096,
}


class TestSessionRecord:
    def test_accumulates_usage_across_records(self):
        session = Session(CONFIG, session_id="sess-1")

        session.record({
            "choices": [{"message": {"content": "thinking..."}}],
            "usage": {"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120},
            "model": "gpt-4o",
        })
        session.record({
            "choices": [{"message": {"content": "done!"}}],
            "usage": {"prompt_tokens": 150, "completion_tokens": 30, "total_tokens": 180},
            "model": "gpt-4o",
        })

        assert session.total_usage == {
            "prompt_tokens": 250,
            "completion_tokens": 50,
            "total_tokens": 300,
            "ai_rounds": 2,
        }

    def test_collects_tool_calls_across_rounds(self):
        session = Session(CONFIG, session_id="sess-2")

        session.record({
            "choices": [{
                "message": {
                    "content": "",
                    "tool_calls": [{"function": {"name": "search", "arguments": '{"q":"shoes"}'}}],
                },
            }],
            "usage": {"prompt_tokens": 50, "completion_tokens": 10, "total_tokens": 60},
        })
        session.record({
            "choices": [{
                "message": {
                    "content": "",
                    "tool_calls": [{"function": {"name": "recommend", "arguments": '{"ids":["1","2"]}'}}],
                },
            }],
            "usage": {"prompt_tokens": 80, "completion_tokens": 15, "total_tokens": 95},
        })

        assert len(session.tool_calls) == 2
        assert session.tool_calls[0] == {"tool": "search", "args": {"q": "shoes"}, "round": 0}
        assert session.tool_calls[1] == {"tool": "recommend", "args": {"ids": ["1", "2"]}, "round": 1}

    def test_auto_generates_session_id(self):
        session = Session(CONFIG)
        assert session.session_id is not None
        assert len(session.session_id) > 0


class TestSessionEmitChatTurn:
    def test_emits_chat_turn_event(self):
        requests = []

        session = Session(
            CONFIG,
            session_id="sess-3",
            metadata={"shop_domain": "cool.myshopify.com"},
        )
        session.record({
            "choices": [{"message": {"content": "Here you go!"}}],
            "usage": {"prompt_tokens": 100, "completion_tokens": 40, "total_tokens": 140},
            "model": "gpt-4o",
        })

        with patch("pentatonic_agent_events.transport.urlopen", side_effect=_mock_urlopen(requests)):
            session.emit_chat_turn(user_message="find shoes", assistant_response="Here you go!")

        assert len(requests) == 1
        req = requests[0]
        assert req.full_url == "https://api.test.com/api/graphql"
        assert req.get_header("Authorization") == "Bearer tes_sk_test"
        assert req.get_header("X-client-id") == "test-client"

        body = json.loads(req.data)
        event_input = body["variables"]["input"]
        assert event_input["eventType"] == "CHAT_TURN"
        assert event_input["entityType"] == "conversation"
        assert event_input["data"]["entity_id"] == "sess-3"

        attrs = event_input["data"]["attributes"]
        assert attrs["user_message"] == "find shoes"
        assert attrs["model"] == "gpt-4o"
        assert attrs["usage"]["prompt_tokens"] == 100
        assert attrs["usage"]["ai_rounds"] == 1
        assert attrs["shop_domain"] == "cool.myshopify.com"
        assert attrs["source"] == "pentatonic-ai-sdk"

    def test_resets_state_after_emit(self):
        requests = []
        session = Session(CONFIG, session_id="sess-6")
        session.record({
            "choices": [{"message": {"content": "hi"}}],
            "usage": {"prompt_tokens": 50, "completion_tokens": 10, "total_tokens": 60},
        })

        with patch("pentatonic_agent_events.transport.urlopen", side_effect=_mock_urlopen(requests)):
            session.emit_chat_turn(user_message="hi", assistant_response="hello")

        assert session.total_usage["prompt_tokens"] == 0
        assert session.total_usage["ai_rounds"] == 0
        assert session.tool_calls == []

    def test_metadata_cannot_overwrite_reserved_fields(self):
        requests = []
        session = Session(
            CONFIG,
            session_id="sess-override",
            metadata={"source": "attacker", "user_message": "spoofed", "model": "fake"},
        )
        session.record({
            "choices": [{"message": {"content": "hi"}}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
            "model": "gpt-4o",
        })

        with patch("pentatonic_agent_events.transport.urlopen", side_effect=_mock_urlopen(requests)):
            session.emit_chat_turn(user_message="real message", assistant_response="real response")

        body = json.loads(requests[0].data)
        attrs = body["variables"]["input"]["data"]["attributes"]
        assert attrs["source"] == "pentatonic-ai-sdk"
        assert attrs["user_message"] == "real message"
        assert attrs["model"] == "gpt-4o"

    def test_truncates_long_content(self):
        requests = []
        config = {**CONFIG, "max_content_length": 20}
        session = Session(config, session_id="sess-trunc")
        session.record({
            "choices": [{"message": {"content": "hi"}}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
        })

        with patch("pentatonic_agent_events.transport.urlopen", side_effect=_mock_urlopen(requests)):
            session.emit_chat_turn(user_message="A" * 100, assistant_response="B" * 100)

        body = json.loads(requests[0].data)
        attrs = body["variables"]["input"]["data"]["attributes"]
        assert len(attrs["user_message"]) <= 35  # 20 + "...[truncated]"
        assert "...[truncated]" in attrs["user_message"]
        assert "...[truncated]" in attrs["assistant_response"]

    def test_omits_content_when_capture_disabled(self):
        requests = []
        config = {**CONFIG, "capture_content": False}
        session = Session(config, session_id="sess-nocap")
        session.record({
            "choices": [{"message": {"content": "secret"}}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
        })

        with patch("pentatonic_agent_events.transport.urlopen", side_effect=_mock_urlopen(requests)):
            session.emit_chat_turn(user_message="secret question", assistant_response="secret answer")

        body = json.loads(requests[0].data)
        attrs = body["variables"]["input"]["data"]["attributes"]
        assert "user_message" not in attrs
        assert "assistant_response" not in attrs
        assert attrs["usage"]["prompt_tokens"] == 10

    def test_includes_full_messages_array(self):
        requests = []
        session = Session(CONFIG, session_id="sess-msgs")
        session.record({
            "choices": [{"message": {"content": "hi"}}],
            "usage": {"prompt_tokens": 50, "completion_tokens": 10, "total_tokens": 60},
            "model": "gpt-4o",
        })

        messages = [
            {"role": "system", "content": "You are a helpful assistant."},
            {"role": "user", "content": "What is 2+2?"},
            {"role": "assistant", "content": "4"},
            {"role": "user", "content": "Thanks"},
        ]

        with patch("pentatonic_agent_events.transport.urlopen", side_effect=_mock_urlopen(requests)):
            session.emit_chat_turn(user_message="Thanks", assistant_response="hi", messages=messages)

        body = json.loads(requests[0].data)
        attrs = body["variables"]["input"]["data"]["attributes"]
        assert len(attrs["messages"]) == 4
        assert attrs["messages"][0]["role"] == "system"
        assert attrs["messages"][0]["content"] == "You are a helpful assistant."

    def test_truncates_messages_content(self):
        requests = []
        config = {**CONFIG, "max_content_length": 20}
        session = Session(config, session_id="sess-msgs-trunc")
        session.record({
            "choices": [{"message": {"content": "hi"}}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
        })

        messages = [
            {"role": "system", "content": "A" * 100},
            {"role": "user", "content": "short"},
        ]

        with patch("pentatonic_agent_events.transport.urlopen", side_effect=_mock_urlopen(requests)):
            session.emit_chat_turn(user_message="short", assistant_response="hi", messages=messages)

        body = json.loads(requests[0].data)
        attrs = body["variables"]["input"]["data"]["attributes"]
        assert "...[truncated]" in attrs["messages"][0]["content"]
        assert len(attrs["messages"][0]["content"]) <= 35
        assert attrs["messages"][1]["content"] == "short"

    def test_omits_messages_when_capture_disabled(self):
        requests = []
        config = {**CONFIG, "capture_content": False}
        session = Session(config, session_id="sess-msgs-nocap")
        session.record({
            "choices": [{"message": {"content": "hi"}}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
        })

        with patch("pentatonic_agent_events.transport.urlopen", side_effect=_mock_urlopen(requests)):
            session.emit_chat_turn(
                user_message="hi", assistant_response="hello",
                messages=[{"role": "system", "content": "secret system prompt"}],
            )

        body = json.loads(requests[0].data)
        attrs = body["variables"]["input"]["data"]["attributes"]
        assert "messages" not in attrs


class TestSessionEmitToolUse:
    def test_emits_tool_use_event(self):
        requests = []
        session = Session(CONFIG, session_id="sess-4")

        with patch("pentatonic_agent_events.transport.urlopen", side_effect=_mock_urlopen(requests)):
            session.emit_tool_use(
                tool="search_products",
                args={"query": "red shoes"},
                result_summary={"count": 12},
                duration_ms=340,
                turn_number=1,
            )

        body = json.loads(requests[0].data)
        event_input = body["variables"]["input"]
        assert event_input["eventType"] == "TOOL_USE"
        assert event_input["data"]["attributes"]["tool"] == "search_products"
        assert event_input["data"]["attributes"]["duration_ms"] == 340


class TestSessionEmitSessionStart:
    def test_emits_session_start_event(self):
        requests = []
        session = Session(
            CONFIG,
            session_id="sess-5",
            metadata={"shop_domain": "test.myshopify.com"},
        )

        with patch("pentatonic_agent_events.transport.urlopen", side_effect=_mock_urlopen(requests)):
            session.emit_session_start()

        body = json.loads(requests[0].data)
        event_input = body["variables"]["input"]
        assert event_input["eventType"] == "SESSION_START"
        assert event_input["data"]["attributes"]["metadata"]["shop_domain"] == "test.myshopify.com"
```

**Step 2: Run test to verify it fails**

```bash
cd /home/phil/Development/takebacks/ai-events-sdk && python -m pytest python/tests/test_session.py -v
```

Expected: `ModuleNotFoundError: No module named 'pentatonic_agent_events.session'`

**Step 3: Write minimal implementation**

Create `python/pentatonic_agent_events/session.py`:

```python
import uuid
from .normalizer import normalize_response
from .transport import send_event


def _truncate(value, max_len):
    if not value or not max_len or not isinstance(value, str):
        return value
    if len(value) <= max_len:
        return value
    return value[:max_len] + "...[truncated]"


class Session:
    def __init__(self, config, session_id=None, metadata=None):
        self._config = config
        self.session_id = session_id or str(uuid.uuid4())
        self._metadata = metadata or {}
        self._reset()

    def _reset(self):
        self._prompt_tokens = 0
        self._completion_tokens = 0
        self._rounds = 0
        self._tool_calls = []
        self._model = None

    @property
    def total_usage(self):
        return {
            "prompt_tokens": self._prompt_tokens,
            "completion_tokens": self._completion_tokens,
            "total_tokens": self._prompt_tokens + self._completion_tokens,
            "ai_rounds": self._rounds,
        }

    @property
    def tool_calls(self):
        return list(self._tool_calls)

    def record(self, raw_response):
        normalized = normalize_response(raw_response)
        current_round = self._rounds

        self._prompt_tokens += normalized["usage"]["prompt_tokens"]
        self._completion_tokens += normalized["usage"]["completion_tokens"]
        self._rounds += 1

        if normalized["model"]:
            self._model = normalized["model"]

        for tc in normalized["tool_calls"]:
            self._tool_calls.append({**tc, "round": current_round})

        return normalized

    def emit_chat_turn(self, user_message=None, assistant_response=None, turn_number=None, messages=None):
        capture = self._config.get("capture_content", True) is not False
        max_len = self._config.get("max_content_length")

        # Spread metadata first so SDK-controlled fields always win
        attributes = {
            **self._metadata,
            "source": "pentatonic-ai-sdk",
            "model": self._model,
            "usage": self.total_usage,
        }

        if self._tool_calls:
            attributes["tool_calls"] = self._tool_calls

        if capture:
            attributes["user_message"] = _truncate(user_message, max_len)
            attributes["assistant_response"] = _truncate(assistant_response, max_len)

            if messages:
                attributes["messages"] = [
                    {**m, "content": _truncate(m["content"], max_len)}
                    if isinstance(m.get("content"), str) else m
                    for m in messages
                ]

        if turn_number is not None:
            attributes["turn_number"] = turn_number

        result = send_event(self._config, {
            "eventType": "CHAT_TURN",
            "entityType": "conversation",
            "data": {
                "entity_id": self.session_id,
                "attributes": attributes,
            },
        })

        self._reset()
        return result

    def emit_tool_use(self, tool=None, args=None, result_summary=None, duration_ms=None, turn_number=None):
        capture = self._config.get("capture_content", True) is not False
        max_len = self._config.get("max_content_length")

        attributes = {
            **self._metadata,
            "source": "pentatonic-ai-sdk",
            "tool": tool,
            "duration_ms": duration_ms,
            "turn_number": turn_number,
        }

        if capture:
            attributes["args"] = args
            attributes["result_summary"] = _truncate(result_summary, max_len) if isinstance(result_summary, str) else result_summary

        return send_event(self._config, {
            "eventType": "TOOL_USE",
            "entityType": "conversation",
            "data": {
                "entity_id": self.session_id,
                "attributes": attributes,
            },
        })

    def emit_session_start(self):
        return send_event(self._config, {
            "eventType": "SESSION_START",
            "entityType": "conversation",
            "data": {
                "entity_id": self.session_id,
                "attributes": {
                    "source": "pentatonic-ai-sdk",
                    "metadata": self._metadata,
                },
            },
        })
```

**Step 4: Run test to verify it passes**

```bash
cd /home/phil/Development/takebacks/ai-events-sdk && python -m pytest python/tests/test_session.py -v
```

Expected: All 10 tests PASS

**Step 5: Commit**

```bash
git add python/pentatonic_agent_events/session.py python/tests/test_session.py
git commit -m "feat(python): add session — record, accumulate, emit chat/tool/session events"
```

---

### Task 5: Client — `python/pentatonic_agent_events/client.py`

**Files:**
- Create: `python/pentatonic_agent_events/client.py`
- Create: `python/tests/test_client.py`

This mirrors `src/client.js`. TESClient validates config, strips trailing slash, enforces HTTPS (allows localhost), provides `session()` and `wrap()` methods.

**Step 1: Write the failing test**

Create `python/tests/test_client.py`:

```python
import pytest
from pentatonic_agent_events.client import TESClient


class TestTESClientConstructor:
    def test_requires_client_id(self):
        with pytest.raises(ValueError, match="client_id is required"):
            TESClient(client_id="", api_key="k", endpoint="https://api.test.com")

    def test_requires_api_key(self):
        with pytest.raises(ValueError, match="api_key is required"):
            TESClient(client_id="c", api_key="", endpoint="https://api.test.com")

    def test_requires_endpoint(self):
        with pytest.raises(ValueError, match="endpoint is required"):
            TESClient(client_id="c", api_key="k", endpoint="")

    def test_rejects_non_https_endpoint(self):
        with pytest.raises(ValueError, match="endpoint must use https://"):
            TESClient(client_id="c", api_key="k", endpoint="http://evil.com")

    def test_allows_http_localhost(self):
        tes = TESClient(client_id="c", api_key="k", endpoint="http://localhost:8788")
        assert tes.endpoint == "http://localhost:8788"

    def test_allows_http_127_0_0_1(self):
        tes = TESClient(client_id="c", api_key="k", endpoint="http://127.0.0.1:8788")
        assert tes.endpoint == "http://127.0.0.1:8788"

    def test_strips_trailing_slash(self):
        tes = TESClient(client_id="c", api_key="k", endpoint="https://api.test.com/")
        assert tes.endpoint == "https://api.test.com"

    def test_api_key_not_in_repr_or_str(self):
        tes = TESClient(client_id="c", api_key="secret-key", endpoint="https://api.test.com")
        assert "secret-key" not in repr(tes)
        assert "secret-key" not in str(tes)

    def test_config_includes_all_fields(self):
        tes = TESClient(
            client_id="c",
            api_key="secret-key",
            endpoint="https://api.test.com",
            headers={"X-Custom": "val"},
            capture_content=False,
            max_content_length=2048,
        )
        config = tes._config
        assert config["client_id"] == "c"
        assert config["api_key"] == "secret-key"
        assert config["endpoint"] == "https://api.test.com"
        assert config["headers"] == {"X-Custom": "val"}
        assert config["capture_content"] is False
        assert config["max_content_length"] == 2048


class TestTESClientSession:
    def test_creates_session(self):
        tes = TESClient(client_id="c", api_key="k", endpoint="https://api.test.com")
        session = tes.session(session_id="sess-1")
        assert session.session_id == "sess-1"

    def test_creates_session_with_auto_id(self):
        tes = TESClient(client_id="c", api_key="k", endpoint="https://api.test.com")
        session = tes.session()
        assert session.session_id is not None
        assert len(session.session_id) > 0

    def test_creates_session_with_metadata(self):
        tes = TESClient(client_id="c", api_key="k", endpoint="https://api.test.com")
        session = tes.session(session_id="sess-2", metadata={"user_id": "u_1"})
        assert session._metadata == {"user_id": "u_1"}
```

**Step 2: Run test to verify it fails**

```bash
cd /home/phil/Development/takebacks/ai-events-sdk && python -m pytest python/tests/test_client.py -v
```

Expected: `ModuleNotFoundError: No module named 'pentatonic_agent_events.client'`

**Step 3: Write minimal implementation**

Create `python/pentatonic_agent_events/client.py`:

```python
import re
from .session import Session
from .wrapper import wrap_client


class TESClient:
    def __init__(self, client_id, api_key, endpoint, headers=None, capture_content=True, max_content_length=4096):
        if not client_id:
            raise ValueError("client_id is required")
        if not api_key:
            raise ValueError("api_key is required")
        if not endpoint:
            raise ValueError("endpoint is required")

        clean_endpoint = endpoint.rstrip("/")
        is_local = bool(
            re.match(r"^http://localhost(:\d+)?(/|$)", clean_endpoint)
            or re.match(r"^http://127\.0\.0\.1(:\d+)?(/|$)", clean_endpoint)
        )
        if not clean_endpoint.startswith("https://") and not is_local:
            raise ValueError("endpoint must use https:// (http:// is only allowed for localhost)")

        self.client_id = client_id
        self.endpoint = clean_endpoint
        self.capture_content = capture_content
        self.max_content_length = max_content_length
        self._api_key = api_key
        self._headers = headers or {}

    @property
    def _config(self):
        return {
            "client_id": self.client_id,
            "api_key": self._api_key,
            "endpoint": self.endpoint,
            "headers": self._headers,
            "capture_content": self.capture_content,
            "max_content_length": self.max_content_length,
        }

    def session(self, session_id=None, metadata=None):
        return Session(self._config, session_id=session_id, metadata=metadata)

    def wrap(self, client):
        return wrap_client(self._config, client)

    def __repr__(self):
        return f"TESClient(client_id={self.client_id!r}, endpoint={self.endpoint!r})"
```

**Step 4: Run test to verify it passes**

Note: This task depends on `wrapper.py` existing. Create a stub `python/pentatonic_agent_events/wrapper.py` first:

```python
def wrap_client(config, client):
    raise NotImplementedError("wrap_client not yet implemented")
```

```bash
cd /home/phil/Development/takebacks/ai-events-sdk && python -m pytest python/tests/test_client.py -v
```

Expected: All 11 tests PASS

**Step 5: Commit**

```bash
git add python/pentatonic_agent_events/client.py python/pentatonic_agent_events/wrapper.py python/tests/test_client.py
git commit -m "feat(python): add TESClient — config validation, session creation, wrap stub"
```

---

### Task 6: Wrapper — `python/pentatonic_agent_events/wrapper.py`

**Files:**
- Modify: `python/pentatonic_agent_events/wrapper.py` (replace stub)
- Create: `python/tests/test_wrapper.py`

This mirrors `src/wrapper.js`. Python doesn't have Proxy, so we use wrapper classes that delegate attribute access. Same duck-type detection, same fire-and-forget emit pattern, same provider-specific Session subclasses.

**Step 1: Write the failing test**

Create `python/tests/test_wrapper.py`:

```python
import json
from unittest.mock import patch, MagicMock, AsyncMock
from pentatonic_agent_events.client import TESClient


def _mock_urlopen(captured_requests):
    def mock_fn(req):
        captured_requests.append(req)
        resp = MagicMock()
        resp.read.return_value = json.dumps({
            "data": {"emitEvent": {"success": True, "eventId": "evt-456", "message": None}}
        }).encode()
        resp.__enter__ = MagicMock(return_value=resp)
        resp.__exit__ = MagicMock(return_value=False)
        return resp
    return mock_fn


tes = TESClient(
    client_id="test-client",
    api_key="tes_sk_test",
    endpoint="https://api.test.com",
)


class MockOpenAICompletions:
    def __init__(self, responses):
        self._responses = responses
        self._call_index = 0

    def create(self, **kwargs):
        resp = self._responses[min(self._call_index, len(self._responses) - 1)]
        self._call_index += 1
        return resp


class MockOpenAIChat:
    def __init__(self, responses):
        self.completions = MockOpenAICompletions(responses)


class MockOpenAI:
    def __init__(self, responses):
        self.chat = MockOpenAIChat(responses)
        self.models = MagicMock()
        self.models.list.return_value = {"data": [{"id": "gpt-4o"}]}


class MockAnthropicMessages:
    def __init__(self, responses):
        self._responses = responses
        self._call_index = 0

    def create(self, **kwargs):
        resp = self._responses[min(self._call_index, len(self._responses) - 1)]
        self._call_index += 1
        return resp


class MockAnthropic:
    def __init__(self, responses):
        self.messages = MockAnthropicMessages(responses)
        self.models = MagicMock()
        self.models.list.return_value = {"data": [{"id": "claude-sonnet-4-6-20250514"}]}


class MockWorkersAI:
    def __init__(self, responses):
        self._responses = responses
        self._call_index = 0

    def run(self, model, params=None, **kwargs):
        resp = self._responses[min(self._call_index, len(self._responses) - 1)]
        self._call_index += 1
        return resp


class TestWrapOpenAI:
    def test_proxies_non_chat_methods(self):
        openai = MockOpenAI([])
        ai = tes.wrap(openai)
        models = ai.models.list()
        assert models["data"][0]["id"] == "gpt-4o"

    def test_intercepts_create_and_emits(self):
        requests = []
        openai = MockOpenAI([{
            "choices": [{"message": {"content": "Hello!"}}],
            "usage": {"prompt_tokens": 50, "completion_tokens": 20, "total_tokens": 70},
            "model": "gpt-4o",
        }])

        ai = tes.wrap(openai)

        with patch("pentatonic_agent_events.transport.urlopen", side_effect=_mock_urlopen(requests)):
            result = ai.chat.completions.create(
                model="gpt-4o",
                messages=[{"role": "user", "content": "hi"}],
            )

        assert result["choices"][0]["message"]["content"] == "Hello!"
        assert len(requests) == 1
        body = json.loads(requests[0].data)
        attrs = body["variables"]["input"]["data"]["attributes"]
        assert attrs["model"] == "gpt-4o"
        assert attrs["usage"]["prompt_tokens"] == 50

    def test_includes_messages_in_emitted_event(self):
        requests = []
        openai = MockOpenAI([{
            "choices": [{"message": {"content": "Hello!"}}],
            "usage": {"prompt_tokens": 50, "completion_tokens": 20, "total_tokens": 70},
            "model": "gpt-4o",
        }])

        ai = tes.wrap(openai)

        with patch("pentatonic_agent_events.transport.urlopen", side_effect=_mock_urlopen(requests)):
            result = ai.chat.completions.create(
                model="gpt-4o",
                messages=[
                    {"role": "system", "content": "You are helpful."},
                    {"role": "user", "content": "hi"},
                ],
            )

        assert len(requests) == 1
        attrs = json.loads(requests[0].data)["variables"]["input"]["data"]["attributes"]
        assert len(attrs["messages"]) == 2
        assert attrs["messages"][0] == {"role": "system", "content": "You are helpful."}
        assert attrs["messages"][1] == {"role": "user", "content": "hi"}

    def test_session_multi_round(self):
        requests = []
        openai = MockOpenAI([
            {
                "choices": [{
                    "message": {
                        "content": "",
                        "tool_calls": [{"function": {"name": "search", "arguments": '{"q":"shoes"}'}}],
                    },
                }],
                "usage": {"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120},
                "model": "gpt-4o",
            },
            {
                "choices": [{"message": {"content": "Found shoes!"}}],
                "usage": {"prompt_tokens": 200, "completion_tokens": 40, "total_tokens": 240},
                "model": "gpt-4o",
            },
        ])

        ai = tes.wrap(openai)
        session = ai.session(session_id="multi-turn")

        session.chat(model="gpt-4o", messages=[{"role": "user", "content": "find shoes"}])
        session.chat(model="gpt-4o", messages=[{"role": "user", "content": "find shoes"}, {"role": "tool", "content": "[...]"}])

        with patch("pentatonic_agent_events.transport.urlopen", side_effect=_mock_urlopen(requests)):
            session.emit_chat_turn(user_message="find shoes", assistant_response="Found shoes!")

        assert len(requests) == 1
        attrs = json.loads(requests[0].data)["variables"]["input"]["data"]["attributes"]
        assert attrs["usage"]["prompt_tokens"] == 300
        assert attrs["usage"]["ai_rounds"] == 2
        assert len(attrs["tool_calls"]) == 1


class TestWrapAnthropic:
    def test_proxies_non_messages_methods(self):
        anthropic = MockAnthropic([])
        ai = tes.wrap(anthropic)
        models = ai.models.list()
        assert models["data"][0]["id"] == "claude-sonnet-4-6-20250514"

    def test_intercepts_create_and_emits(self):
        requests = []
        anthropic = MockAnthropic([{
            "content": [{"type": "text", "text": "Bonjour!"}],
            "usage": {"input_tokens": 80, "output_tokens": 25},
            "model": "claude-sonnet-4-6-20250514",
        }])

        ai = tes.wrap(anthropic)

        with patch("pentatonic_agent_events.transport.urlopen", side_effect=_mock_urlopen(requests)):
            result = ai.messages.create(
                model="claude-sonnet-4-6-20250514",
                messages=[{"role": "user", "content": "Say hello in French"}],
                max_tokens=100,
            )

        assert result["content"][0]["text"] == "Bonjour!"
        assert len(requests) == 1
        attrs = json.loads(requests[0].data)["variables"]["input"]["data"]["attributes"]
        assert attrs["model"] == "claude-sonnet-4-6-20250514"
        assert attrs["usage"]["prompt_tokens"] == 80
        assert attrs["user_message"] == "Say hello in French"
        assert attrs["assistant_response"] == "Bonjour!"

    def test_session_with_tool_use(self):
        requests = []
        anthropic = MockAnthropic([
            {
                "content": [
                    {"type": "text", "text": "Let me search."},
                    {"type": "tool_use", "id": "tu_1", "name": "search", "input": {"query": "shoes"}},
                ],
                "usage": {"input_tokens": 100, "output_tokens": 40},
                "model": "claude-sonnet-4-6-20250514",
            },
            {
                "content": [{"type": "text", "text": "Found red shoes!"}],
                "usage": {"input_tokens": 200, "output_tokens": 30},
                "model": "claude-sonnet-4-6-20250514",
            },
        ])

        ai = tes.wrap(anthropic)
        session = ai.session(session_id="anth-multi")

        session.chat(
            model="claude-sonnet-4-6-20250514",
            messages=[{"role": "user", "content": "find shoes"}],
            max_tokens=200,
        )
        session.chat(
            model="claude-sonnet-4-6-20250514",
            messages=[{"role": "user", "content": "find shoes"}],
            max_tokens=200,
        )

        with patch("pentatonic_agent_events.transport.urlopen", side_effect=_mock_urlopen(requests)):
            session.emit_chat_turn(user_message="find shoes", assistant_response="Found red shoes!")

        attrs = json.loads(requests[0].data)["variables"]["input"]["data"]["attributes"]
        assert attrs["usage"]["prompt_tokens"] == 300
        assert attrs["usage"]["ai_rounds"] == 2
        assert len(attrs["tool_calls"]) == 1
        assert attrs["tool_calls"][0]["tool"] == "search"


class TestWrapWorkersAI:
    def test_intercepts_run_and_emits(self):
        requests = []
        ai = MockWorkersAI([{
            "response": "4",
            "usage": {"prompt_tokens": 30, "completion_tokens": 5},
        }])

        wrapped = tes.wrap(ai)

        with patch("pentatonic_agent_events.transport.urlopen", side_effect=_mock_urlopen(requests)):
            result = wrapped.run("@cf/meta/llama-3.1-8b-instruct", {
                "messages": [{"role": "user", "content": "What is 2+2?"}],
            })

        assert result["response"] == "4"
        assert len(requests) == 1
        attrs = json.loads(requests[0].data)["variables"]["input"]["data"]["attributes"]
        assert attrs["model"] == "@cf/meta/llama-3.1-8b-instruct"
        assert attrs["usage"]["prompt_tokens"] == 30
        assert attrs["user_message"] == "What is 2+2?"
        assert attrs["assistant_response"] == "4"

    def test_session_multi_round(self):
        requests = []
        ai = MockWorkersAI([
            {
                "response": "",
                "tool_calls": [{"name": "lookup", "arguments": {"id": "123"}}],
                "usage": {"prompt_tokens": 50, "completion_tokens": 10},
            },
            {
                "response": "Found it!",
                "usage": {"prompt_tokens": 80, "completion_tokens": 15},
            },
        ])

        wrapped = tes.wrap(ai)
        session = wrapped.session(session_id="wai-multi")

        session.chat("@cf/meta/llama-3.1-8b-instruct", {
            "messages": [{"role": "user", "content": "find item 123"}],
        })
        session.chat("@cf/meta/llama-3.1-8b-instruct", {
            "messages": [{"role": "user", "content": "find item 123"}, {"role": "tool", "content": "{}"}],
        })

        with patch("pentatonic_agent_events.transport.urlopen", side_effect=_mock_urlopen(requests)):
            session.emit_chat_turn(user_message="find item 123", assistant_response="Found it!")

        attrs = json.loads(requests[0].data)["variables"]["input"]["data"]["attributes"]
        assert attrs["usage"]["prompt_tokens"] == 130
        assert attrs["usage"]["ai_rounds"] == 2
        assert len(attrs["tool_calls"]) == 1
        assert attrs["tool_calls"][0]["tool"] == "lookup"


class TestWrapUnsupported:
    def test_throws_for_unknown_client(self):
        import pytest
        with pytest.raises(ValueError, match="Unsupported client"):
            tes.wrap({})
        with pytest.raises(ValueError, match="Unsupported client"):
            tes.wrap({"foo": "bar"})
```

**Step 2: Run test to verify it fails**

```bash
cd /home/phil/Development/takebacks/ai-events-sdk && python -m pytest python/tests/test_wrapper.py -v
```

Expected: Tests fail because `wrap_client` raises `NotImplementedError`

**Step 3: Write full implementation**

Replace `python/pentatonic_agent_events/wrapper.py`:

```python
import sys
from .session import Session
from .normalizer import normalize_response


def detect_client_type(client):
    """Detect client type by duck-typing its shape."""
    try:
        if hasattr(client, "chat") and hasattr(client.chat, "completions") and hasattr(client.chat.completions, "create"):
            return "openai"
    except Exception:
        pass
    try:
        if hasattr(client, "messages") and hasattr(client.messages, "create"):
            return "anthropic"
    except Exception:
        pass
    if callable(getattr(client, "run", None)):
        return "workers-ai"
    return "unknown"


def wrap_client(config, client):
    client_type = detect_client_type(client)

    if client_type == "openai":
        return _OpenAIWrapper(config, client)
    if client_type == "anthropic":
        return _AnthropicWrapper(config, client)
    if client_type == "workers-ai":
        return _WorkersAIWrapper(config, client)

    raise ValueError(
        "Unsupported client: expected OpenAI (chat.completions.create), "
        "Anthropic (messages.create), or Workers AI (run) client"
    )


# --- Fire and forget ---

def _fire_and_forget_emit(config, messages, result, model=None):
    session = Session(config)
    normalized = session.record(result)

    if model and not normalized["model"]:
        session._model = model

    raw_content = ""
    if isinstance(messages, list):
        user_msgs = [m for m in messages if isinstance(m, dict) and m.get("role") == "user"]
        if user_msgs:
            raw_content = user_msgs[-1].get("content", "")

    # Anthropic content can be an array of content blocks
    if isinstance(raw_content, list):
        user_msg = "\n".join(
            b.get("text", "") for b in raw_content if isinstance(b, dict) and b.get("type") == "text"
        )
    else:
        user_msg = raw_content

    assistant_msg = normalized["content"] or ""

    try:
        session.emit_chat_turn(user_message=user_msg, assistant_response=assistant_msg, messages=messages)
    except Exception as e:
        print(f"[pentatonic-ai] emit failed: {e}", file=sys.stderr)


# --- OpenAI ---

class _WrappedOpenAICompletions:
    def __init__(self, config, completions, client):
        self._config = config
        self._completions = completions
        self._client = client

    def create(self, **kwargs):
        result = self._completions.create(**kwargs)
        _fire_and_forget_emit(self._config, kwargs.get("messages"), result)
        return result

    def __getattr__(self, name):
        return getattr(self._completions, name)


class _WrappedOpenAIChat:
    def __init__(self, config, chat, client):
        self._config = config
        self._chat = chat
        self._client = client
        self.completions = _WrappedOpenAICompletions(config, chat.completions, client)

    def __getattr__(self, name):
        if name == "completions":
            return self.completions
        return getattr(self._chat, name)


class _OpenAIWrapper:
    def __init__(self, config, client):
        self._config = config
        self._client = client
        self.chat = _WrappedOpenAIChat(config, client.chat, client)

    def session(self, session_id=None, metadata=None):
        return _OpenAISession(self._config, self._client, session_id=session_id, metadata=metadata)

    def __getattr__(self, name):
        if name == "chat":
            return self.chat
        return getattr(self._client, name)


class _OpenAISession(Session):
    def __init__(self, config, client, session_id=None, metadata=None):
        super().__init__(config, session_id=session_id, metadata=metadata)
        self._client = client

    def chat(self, **kwargs):
        result = self._client.chat.completions.create(**kwargs)
        self.record(result)
        return result


# --- Anthropic ---

class _WrappedAnthropicMessages:
    def __init__(self, config, messages, client):
        self._config = config
        self._messages = messages
        self._client = client

    def create(self, **kwargs):
        result = self._messages.create(**kwargs)
        _fire_and_forget_emit(self._config, kwargs.get("messages"), result)
        return result

    def __getattr__(self, name):
        return getattr(self._messages, name)


class _AnthropicWrapper:
    def __init__(self, config, client):
        self._config = config
        self._client = client
        self.messages = _WrappedAnthropicMessages(config, client.messages, client)

    def session(self, session_id=None, metadata=None):
        return _AnthropicSession(self._config, self._client, session_id=session_id, metadata=metadata)

    def __getattr__(self, name):
        if name == "messages":
            return self.messages
        return getattr(self._client, name)


class _AnthropicSession(Session):
    def __init__(self, config, client, session_id=None, metadata=None):
        super().__init__(config, session_id=session_id, metadata=metadata)
        self._client = client

    def chat(self, **kwargs):
        result = self._client.messages.create(**kwargs)
        self.record(result)
        return result


# --- Workers AI ---

class _WorkersAIWrapper:
    def __init__(self, config, ai_binding):
        self._config = config
        self._ai = ai_binding

    def run(self, model, params=None, **kwargs):
        result = self._ai.run(model, params, **kwargs)
        messages = params.get("messages") if isinstance(params, dict) else None
        _fire_and_forget_emit(self._config, messages, result, model=model)
        return result

    def session(self, session_id=None, metadata=None):
        return _WorkersAISession(self._config, self._ai, session_id=session_id, metadata=metadata)

    def __getattr__(self, name):
        return getattr(self._ai, name)


class _WorkersAISession(Session):
    def __init__(self, config, ai_binding, session_id=None, metadata=None):
        super().__init__(config, session_id=session_id, metadata=metadata)
        self._ai = ai_binding

    def chat(self, model, params=None, **kwargs):
        result = self._ai.run(model, params, **kwargs)
        self.record(result)
        return result
```

**Step 4: Run test to verify it passes**

```bash
cd /home/phil/Development/takebacks/ai-events-sdk && python -m pytest python/tests/test_wrapper.py -v
```

Expected: All 11 tests PASS

**Step 5: Commit**

```bash
git add python/pentatonic_agent_events/wrapper.py python/tests/test_wrapper.py
git commit -m "feat(python): add wrapper — auto-wrapping for OpenAI, Anthropic, Workers AI"
```

---

### Task 7: Public exports — `python/pentatonic_agent_events/__init__.py`

**Files:**
- Modify: `python/pentatonic_agent_events/__init__.py`

This mirrors `src/index.js`.

**Step 1: Update `__init__.py`**

```python
from .client import TESClient
from .session import Session
from .normalizer import normalize_response

__all__ = ["TESClient", "Session", "normalize_response"]
```

**Step 2: Verify imports work**

```bash
cd /home/phil/Development/takebacks/ai-events-sdk && python -c "from pentatonic_agent_events import TESClient, Session, normalize_response; print('OK')"
```

Expected: `OK`

**Step 3: Run full test suite**

```bash
cd /home/phil/Development/takebacks/ai-events-sdk && python -m pytest python/tests/ -v
```

Expected: All tests PASS

**Step 4: Commit**

```bash
git add python/pentatonic_agent_events/__init__.py
git commit -m "feat(python): add public exports — TESClient, Session, normalize_response"
```

---

### Task 8: CLI update — language choice for install

**Files:**
- Modify: `bin/cli.js` (lines 294-307)

The CLI currently auto-installs via `npm install`. Change it to offer a choice: npm, pip, or skip.

**Step 1: Write the change**

Replace the install section (after the "Add these to your environment" block, starting at the `// Install SDK` comment around line 294) with:

```javascript
    // Install SDK
    const installChoice = await askChoice("Install SDK:", [
      "npm install @pentatonic-ai/agent-events",
      "pip install pentatonic-agent-events",
      "Skip — I'll install manually",
    ]);

    if (installChoice.startsWith("npm")) {
      const installSpinner = spinner("Installing @pentatonic-ai/agent-events...");
      try {
        execFileSync("npm", ["install", "@pentatonic-ai/agent-events"], { stdio: "pipe" });
        installSpinner.stop("@pentatonic-ai/agent-events installed!");
      } catch {
        installSpinner.fail("Install failed. Run manually: npm install @pentatonic-ai/agent-events");
      }
    } else if (installChoice.startsWith("pip")) {
      const installSpinner = spinner("Installing pentatonic-agent-events...");
      try {
        execFileSync("pip", ["install", "pentatonic-agent-events"], { stdio: "pipe" });
        installSpinner.stop("pentatonic-agent-events installed!");
      } catch {
        installSpinner.fail("Install failed. Run manually: pip install pentatonic-agent-events");
      }
    } else {
      console.log("\n  Install later with:");
      console.log("    npm install @pentatonic-ai/agent-events");
      console.log("    pip install pentatonic-agent-events");
    }
```

**Step 2: Verify CLI still runs**

```bash
cd /home/phil/Development/takebacks/ai-events-sdk && node bin/cli.js --help
```

Expected: Prints usage info without errors.

**Step 3: Commit**

```bash
git add bin/cli.js
git commit -m "feat: CLI offers npm/pip/skip install choice"
```

---

### Task 9: README update — Python examples alongside JS

**Files:**
- Modify: `README.md`

Read the existing README first, then add Python examples alongside each JS example. Use a clear two-column or tabbed approach (e.g. `### JavaScript` / `### Python` headings).

Key sections to add Python for:

1. **Installation** — add `pip install pentatonic-agent-events`
2. **Quick Start (wrap)** — Python equivalent with `tes.wrap(OpenAI())`
3. **Sessions** — `tes.session()`, `session.chat()`, `session.emit_chat_turn()`
4. **Manual** — `session.record()`, `session.emit_chat_turn()`
5. **Supported Providers** — same table, note Python uses snake_case

The exact content depends on the current README — read it first and add Python sections to match.

**Step 1: Read current README**

```bash
cat README.md
```

**Step 2: Add Python examples**

Add installation, quick start, and usage examples in Python alongside the JS ones.

**Step 3: Commit**

```bash
git add README.md
git commit -m "docs: add Python examples to README"
```

---

### Task 10: Final verification

**Step 1: Run all Python tests**

```bash
cd /home/phil/Development/takebacks/ai-events-sdk && python -m pytest python/tests/ -v
```

Expected: All tests PASS

**Step 2: Run all JS tests**

```bash
cd /home/phil/Development/takebacks/ai-events-sdk && npm test
```

Expected: All tests PASS

**Step 3: Verify package builds**

```bash
cd /home/phil/Development/takebacks/ai-events-sdk && pip install -e . 2>&1 | tail -3
```

Expected: Successfully installed

**Step 4: Verify import from installed package**

```bash
python -c "from pentatonic_agent_events import TESClient; print(TESClient.__module__)"
```

Expected: `pentatonic_agent_events.client`
