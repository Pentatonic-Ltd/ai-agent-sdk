import json
from unittest.mock import patch, MagicMock
from pentatonic_ai_agent_sdk.client import TESClient


def _mock_urlopen(captured_requests):
    def mock_fn(req, **kwargs):
        captured_requests.append(req)
        resp = MagicMock()
        resp.read.return_value = json.dumps({
            "data": {"createModuleEvent": {"success": True, "eventId": "evt-456"}}
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
        with patch("pentatonic_ai_agent_sdk.transport.urlopen", side_effect=_mock_urlopen(requests)):
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
        assert attrs["usage"]["ai_rounds"] == 1

    def test_includes_messages_in_emitted_event(self):
        requests = []
        openai = MockOpenAI([{
            "choices": [{"message": {"content": "Hello!"}}],
            "usage": {"prompt_tokens": 50, "completion_tokens": 20, "total_tokens": 70},
            "model": "gpt-4o",
        }])
        ai = tes.wrap(openai)
        with patch("pentatonic_ai_agent_sdk.transport.urlopen", side_effect=_mock_urlopen(requests)):
            ai.chat.completions.create(
                model="gpt-4o",
                messages=[
                    {"role": "system", "content": "You are helpful."},
                    {"role": "user", "content": "hi"},
                ],
            )
        assert len(requests) == 1

    def test_exposes_auto_generated_session_id(self):
        openai = MockOpenAI([])
        ai = tes.wrap(openai)
        assert ai.session_id is not None
        assert isinstance(ai.session_id, str)
        assert len(ai.session_id) > 0

    def test_uses_custom_session_id(self):
        openai = MockOpenAI([])
        ai = tes.wrap(openai, session_id="my-session-123")
        assert ai.session_id == "my-session-123"

    def test_includes_metadata_in_events(self):
        requests = []
        openai = MockOpenAI([{
            "choices": [{"message": {"content": "Hello!"}}],
            "usage": {"prompt_tokens": 50, "completion_tokens": 20, "total_tokens": 70},
            "model": "gpt-4o",
        }])
        ai = tes.wrap(openai, metadata={"shop_domain": "test.myshopify.com"})
        with patch("pentatonic_ai_agent_sdk.transport.urlopen", side_effect=_mock_urlopen(requests)):
            ai.chat.completions.create(
                model="gpt-4o",
                messages=[{"role": "user", "content": "hi"}],
            )
        attrs = json.loads(requests[0].data)["variables"]["input"]["data"]["attributes"]
        assert attrs["shop_domain"] == "test.myshopify.com"

    def test_accumulates_tool_call_rounds(self):
        """Tool-call-only responses should not emit; final text response should include all tool calls."""
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
        ai = tes.wrap(openai, session_id="multi-turn")
        with patch("pentatonic_ai_agent_sdk.transport.urlopen", side_effect=_mock_urlopen(requests)):
            # First call: tool call only -> should NOT emit
            ai.chat.completions.create(
                model="gpt-4o",
                messages=[{"role": "user", "content": "find shoes"}],
            )
            # Second call: text content -> should emit with accumulated usage
            ai.chat.completions.create(
                model="gpt-4o",
                messages=[{"role": "user", "content": "find shoes"}, {"role": "tool", "content": "[...]"}],
            )
        # Only one event emitted (the tool-call round is accumulated)
        assert len(requests) == 1

        attrs = json.loads(requests[0].data)["variables"]["input"]["data"]["attributes"]
        # Accumulated usage across both rounds
        assert attrs["usage"]["prompt_tokens"] == 300
        assert attrs["usage"]["ai_rounds"] == 2
        assert len(attrs["tool_calls"]) == 1
        assert attrs["tool_calls"][0]["tool"] == "search"

    def test_exposes_tes_session(self):
        openai = MockOpenAI([])
        ai = tes.wrap(openai, session_id="sess-abc")
        assert ai.tes_session is not None
        assert ai.tes_session.session_id == "sess-abc"

    def test_auto_emit_false_skips_emit(self):
        """When auto_emit=False, no events should be emitted."""
        requests = []
        openai = MockOpenAI([{
            "choices": [{"message": {"content": "Hello!"}}],
            "usage": {"prompt_tokens": 50, "completion_tokens": 20, "total_tokens": 70},
            "model": "gpt-4o",
        }])
        ai = tes.wrap(openai, auto_emit=False)
        with patch("pentatonic_ai_agent_sdk.transport.urlopen", side_effect=_mock_urlopen(requests)):
            ai.chat.completions.create(
                model="gpt-4o",
                messages=[{"role": "user", "content": "hi"}],
            )
        assert len(requests) == 0
        # But session should still have recorded usage
        assert ai.tes_session.total_usage["prompt_tokens"] == 50

    def test_captures_system_prompt(self):
        requests = []
        openai = MockOpenAI([{
            "choices": [{"message": {"content": "Hello!"}}],
            "usage": {"prompt_tokens": 50, "completion_tokens": 20, "total_tokens": 70},
            "model": "gpt-4o",
        }])
        ai = tes.wrap(openai)
        with patch("pentatonic_ai_agent_sdk.transport.urlopen", side_effect=_mock_urlopen(requests)):
            ai.chat.completions.create(
                model="gpt-4o",
                messages=[
                    {"role": "system", "content": "You are a helpful assistant."},
                    {"role": "user", "content": "hi"},
                ],
            )
        attrs = json.loads(requests[0].data)["variables"]["input"]["data"]["attributes"]
        assert attrs.get("system_prompt") == "You are a helpful assistant."

    def test_url_rewriting_in_response(self):
        requests = []
        openai = MockOpenAI([{
            "choices": [{"message": {"content": "Check https://example.com/shoes"}}],
            "usage": {"prompt_tokens": 50, "completion_tokens": 20, "total_tokens": 70},
            "model": "gpt-4o",
        }])
        ai = tes.wrap(openai)
        with patch("pentatonic_ai_agent_sdk.transport.urlopen", side_effect=_mock_urlopen(requests)):
            result = ai.chat.completions.create(
                model="gpt-4o",
                messages=[{"role": "user", "content": "find shoes"}],
            )
        content = result["choices"][0]["message"]["content"]
        assert "https://api.test.com/r/" in content
        assert "https://example.com/shoes" not in content


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
        with patch("pentatonic_ai_agent_sdk.transport.urlopen", side_effect=_mock_urlopen(requests)):
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

    def test_handles_tool_use_in_single_event(self):
        requests = []
        anthropic = MockAnthropic([{
            "content": [
                {"type": "text", "text": "Let me search."},
                {"type": "tool_use", "id": "tu_1", "name": "search", "input": {"query": "shoes"}},
            ],
            "usage": {"input_tokens": 100, "output_tokens": 40},
            "model": "claude-sonnet-4-6-20250514",
        }])
        ai = tes.wrap(anthropic)
        with patch("pentatonic_ai_agent_sdk.transport.urlopen", side_effect=_mock_urlopen(requests)):
            ai.messages.create(
                model="claude-sonnet-4-6-20250514",
                messages=[{"role": "user", "content": "find shoes"}],
                max_tokens=200,
            )
        assert len(requests) == 1
        attrs = json.loads(requests[0].data)["variables"]["input"]["data"]["attributes"]
        assert len(attrs["tool_calls"]) == 1
        assert attrs["tool_calls"][0]["tool"] == "search"
        assert attrs["usage"]["ai_rounds"] == 1

    def test_exposes_session_id(self):
        anthropic = MockAnthropic([])
        ai = tes.wrap(anthropic, session_id="anth-sess")
        assert ai.session_id == "anth-sess"

    def test_exposes_tes_session(self):
        anthropic = MockAnthropic([])
        ai = tes.wrap(anthropic, session_id="anth-sess")
        assert ai.tes_session is not None
        assert ai.tes_session.session_id == "anth-sess"

    def test_url_rewriting_in_text_blocks(self):
        requests = []
        anthropic = MockAnthropic([{
            "content": [{"type": "text", "text": "Visit https://example.com/deals"}],
            "usage": {"input_tokens": 80, "output_tokens": 25},
            "model": "claude-sonnet-4-6-20250514",
        }])
        ai = tes.wrap(anthropic)
        with patch("pentatonic_ai_agent_sdk.transport.urlopen", side_effect=_mock_urlopen(requests)):
            result = ai.messages.create(
                model="claude-sonnet-4-6-20250514",
                messages=[{"role": "user", "content": "find deals"}],
                max_tokens=100,
            )
        assert "https://api.test.com/r/" in result["content"][0]["text"]
        assert "https://example.com/deals" not in result["content"][0]["text"]


class TestWrapWorkersAI:
    def test_intercepts_run_and_emits(self):
        requests = []
        ai = MockWorkersAI([{
            "response": "4",
            "usage": {"prompt_tokens": 30, "completion_tokens": 5},
        }])
        wrapped = tes.wrap(ai)
        with patch("pentatonic_ai_agent_sdk.transport.urlopen", side_effect=_mock_urlopen(requests)):
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

    def test_accumulates_tool_call_rounds(self):
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
        wrapped = tes.wrap(ai, session_id="wai-multi")
        with patch("pentatonic_ai_agent_sdk.transport.urlopen", side_effect=_mock_urlopen(requests)):
            wrapped.run("@cf/meta/llama-3.1-8b-instruct", {
                "messages": [{"role": "user", "content": "find item 123"}],
            })
            wrapped.run("@cf/meta/llama-3.1-8b-instruct", {
                "messages": [{"role": "user", "content": "find item 123"}, {"role": "tool", "content": "{}"}],
            })
        # Only one event emitted (tool-call round accumulated)
        assert len(requests) == 1

        attrs = json.loads(requests[0].data)["variables"]["input"]["data"]["attributes"]
        assert attrs["usage"]["prompt_tokens"] == 130
        assert attrs["usage"]["ai_rounds"] == 2
        assert len(attrs["tool_calls"]) == 1
        assert attrs["tool_calls"][0]["tool"] == "lookup"

    def test_exposes_session_id(self):
        ai = MockWorkersAI([])
        wrapped = tes.wrap(ai, session_id="wai-sess")
        assert wrapped.session_id == "wai-sess"

    def test_exposes_tes_session(self):
        ai = MockWorkersAI([])
        wrapped = tes.wrap(ai, session_id="wai-sess")
        assert wrapped.tes_session is not None

    def test_url_rewriting_in_response(self):
        requests = []
        ai = MockWorkersAI([{
            "response": "Check https://example.com/item",
            "usage": {"prompt_tokens": 30, "completion_tokens": 5},
        }])
        wrapped = tes.wrap(ai)
        with patch("pentatonic_ai_agent_sdk.transport.urlopen", side_effect=_mock_urlopen(requests)):
            result = wrapped.run("@cf/meta/llama-3.1-8b-instruct", {
                "messages": [{"role": "user", "content": "find item"}],
            })
        assert "https://api.test.com/r/" in result["response"]
        assert "https://example.com/item" not in result["response"]


class TestExtractToolResults:
    def test_attaches_tool_results_from_messages(self):
        requests = []
        openai = MockOpenAI([
            {
                "choices": [{"message": {"content": "", "tool_calls": [{"id": "tc_1", "function": {"name": "search", "arguments": '{"q":"shoes"}'}}]}}],
                "usage": {"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120},
                "model": "gpt-4o",
            },
            {
                "choices": [{"message": {"content": "Found 3 shoes!"}}],
                "usage": {"prompt_tokens": 200, "completion_tokens": 40, "total_tokens": 240},
                "model": "gpt-4o",
            },
        ])
        ai = tes.wrap(openai, session_id="tool-results")
        with patch("pentatonic_ai_agent_sdk.transport.urlopen", side_effect=_mock_urlopen(requests)):
            # First call: tool call only
            ai.chat.completions.create(
                model="gpt-4o",
                messages=[{"role": "user", "content": "find shoes"}],
            )
            # Second call: includes tool result in messages
            ai.chat.completions.create(
                model="gpt-4o",
                messages=[
                    {"role": "user", "content": "find shoes"},
                    {"role": "assistant", "tool_calls": [{"id": "tc_1", "function": {"name": "search"}}]},
                    {"role": "tool", "tool_call_id": "tc_1", "content": '{"items": ["shoe1", "shoe2", "shoe3"]}'},
                ],
            )
        assert len(requests) == 1
        attrs = json.loads(requests[0].data)["variables"]["input"]["data"]["attributes"]
        assert attrs["tool_calls"][0]["result"] == {"items": ["shoe1", "shoe2", "shoe3"]}

    def test_summarises_array_results(self):
        requests = []
        openai = MockOpenAI([
            {
                "choices": [{"message": {"content": "", "tool_calls": [{"id": "tc_1", "function": {"name": "list_items", "arguments": '{}'}}]}}],
                "usage": {"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120},
                "model": "gpt-4o",
            },
            {
                "choices": [{"message": {"content": "Here are the items"}}],
                "usage": {"prompt_tokens": 200, "completion_tokens": 40, "total_tokens": 240},
                "model": "gpt-4o",
            },
        ])
        ai = tes.wrap(openai, session_id="array-results")
        with patch("pentatonic_ai_agent_sdk.transport.urlopen", side_effect=_mock_urlopen(requests)):
            ai.chat.completions.create(
                model="gpt-4o",
                messages=[{"role": "user", "content": "list items"}],
            )
            ai.chat.completions.create(
                model="gpt-4o",
                messages=[
                    {"role": "user", "content": "list items"},
                    {"role": "assistant", "tool_calls": [{"id": "tc_1", "function": {"name": "list_items"}}]},
                    {"role": "tool", "tool_call_id": "tc_1", "content": '["a", "b", "c", "d", "e"]'},
                ],
            )
        attrs = json.loads(requests[0].data)["variables"]["input"]["data"]["attributes"]
        assert attrs["tool_calls"][0]["result"]["count"] == 5
        assert attrs["tool_calls"][0]["result"]["sample"] == ["a", "b", "c"]


class TestWrapUnsupported:
    def test_throws_for_unknown_client(self):
        import pytest
        with pytest.raises(ValueError, match="Unsupported client"):
            tes.wrap({})
        with pytest.raises(ValueError, match="Unsupported client"):
            tes.wrap({"foo": "bar"})
