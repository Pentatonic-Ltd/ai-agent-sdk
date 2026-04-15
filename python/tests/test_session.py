import json
from unittest.mock import patch, MagicMock
from pentatonic_ai_agent_sdk.session import Session


def _mock_urlopen(captured_requests):
    def mock_fn(req, **kwargs):
        captured_requests.append(req)
        resp = MagicMock()
        resp.read.return_value = json.dumps({
            "data": {"createModuleEvent": {"success": True, "eventId": "evt-123"}}
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
            "prompt_tokens": 250, "completion_tokens": 50, "total_tokens": 300, "ai_rounds": 2,
        }

    def test_collects_tool_calls_across_rounds(self):
        session = Session(CONFIG, session_id="sess-2")
        session.record({
            "choices": [{"message": {"content": "", "tool_calls": [{"function": {"name": "search", "arguments": '{"q":"shoes"}'}}]}}],
            "usage": {"prompt_tokens": 50, "completion_tokens": 10, "total_tokens": 60},
        })
        session.record({
            "choices": [{"message": {"content": "", "tool_calls": [{"function": {"name": "recommend", "arguments": '{"ids":["1","2"]}'}}]}}],
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
        session = Session(CONFIG, session_id="sess-3", metadata={"shop_domain": "cool.myshopify.com"})
        session.record({
            "choices": [{"message": {"content": "Here you go!"}}],
            "usage": {"prompt_tokens": 100, "completion_tokens": 40, "total_tokens": 140},
            "model": "gpt-4o",
        })
        with patch("pentatonic_ai_agent_sdk.transport.urlopen", side_effect=_mock_urlopen(requests)):
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
        with patch("pentatonic_ai_agent_sdk.transport.urlopen", side_effect=_mock_urlopen(requests)):
            session.emit_chat_turn(user_message="hi", assistant_response="hello")
        assert session.total_usage["prompt_tokens"] == 0
        assert session.total_usage["ai_rounds"] == 0
        assert session.tool_calls == []

    def test_metadata_cannot_overwrite_reserved_fields(self):
        requests = []
        session = Session(CONFIG, session_id="sess-override", metadata={"source": "attacker", "user_message": "spoofed", "model": "fake"})
        session.record({
            "choices": [{"message": {"content": "hi"}}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
            "model": "gpt-4o",
        })
        with patch("pentatonic_ai_agent_sdk.transport.urlopen", side_effect=_mock_urlopen(requests)):
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
        with patch("pentatonic_ai_agent_sdk.transport.urlopen", side_effect=_mock_urlopen(requests)):
            session.emit_chat_turn(user_message="A" * 100, assistant_response="B" * 100)
        body = json.loads(requests[0].data)
        attrs = body["variables"]["input"]["data"]["attributes"]
        assert len(attrs["user_message"]) <= 35
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
        with patch("pentatonic_ai_agent_sdk.transport.urlopen", side_effect=_mock_urlopen(requests)):
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
        with patch("pentatonic_ai_agent_sdk.transport.urlopen", side_effect=_mock_urlopen(requests)):
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
        with patch("pentatonic_ai_agent_sdk.transport.urlopen", side_effect=_mock_urlopen(requests)):
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
        with patch("pentatonic_ai_agent_sdk.transport.urlopen", side_effect=_mock_urlopen(requests)):
            session.emit_chat_turn(user_message="hi", assistant_response="hello", messages=[{"role": "system", "content": "secret"}])
        body = json.loads(requests[0].data)
        attrs = body["variables"]["input"]["data"]["attributes"]
        assert "messages" not in attrs


class TestSessionEmitToolUse:
    def test_emits_tool_use_event(self):
        requests = []
        session = Session(CONFIG, session_id="sess-4")
        with patch("pentatonic_ai_agent_sdk.transport.urlopen", side_effect=_mock_urlopen(requests)):
            session.emit_tool_use(tool="search_products", args={"query": "red shoes"}, result_summary={"count": 12}, duration_ms=340, turn_number=1)
        body = json.loads(requests[0].data)
        event_input = body["variables"]["input"]
        assert event_input["eventType"] == "TOOL_USE"
        assert event_input["data"]["attributes"]["tool"] == "search_products"
        assert event_input["data"]["attributes"]["duration_ms"] == 340


class TestSessionEmitSessionStart:
    def test_emits_session_start_event(self):
        requests = []
        session = Session(CONFIG, session_id="sess-5", metadata={"shop_domain": "test.myshopify.com"})
        with patch("pentatonic_ai_agent_sdk.transport.urlopen", side_effect=_mock_urlopen(requests)):
            session.emit_session_start()
        body = json.loads(requests[0].data)
        event_input = body["variables"]["input"]
        assert event_input["eventType"] == "SESSION_START"
        assert event_input["data"]["attributes"]["metadata"]["shop_domain"] == "test.myshopify.com"
