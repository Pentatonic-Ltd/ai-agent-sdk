import json
from unittest.mock import patch, MagicMock
from pentatonic_agent_events.client import TESClient


def _mock_urlopen(captured_requests):
    def mock_fn(req, **kwargs):
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
                "choices": [{"message": {"content": "", "tool_calls": [{"function": {"name": "search", "arguments": '{"q":"shoes"}'}}]}}],
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
        session.chat(model="claude-sonnet-4-6-20250514", messages=[{"role": "user", "content": "find shoes"}], max_tokens=200)
        session.chat(model="claude-sonnet-4-6-20250514", messages=[{"role": "user", "content": "find shoes"}], max_tokens=200)
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
        session.chat("@cf/meta/llama-3.1-8b-instruct", {"messages": [{"role": "user", "content": "find item 123"}]})
        session.chat("@cf/meta/llama-3.1-8b-instruct", {"messages": [{"role": "user", "content": "find item 123"}, {"role": "tool", "content": "{}"}]})
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
