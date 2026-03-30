from pentatonic_ai_agent_sdk.normalizer import normalize_response


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
