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
            if capture:
                attributes["tool_calls"] = self._tool_calls
            else:
                attributes["tool_calls"] = [
                    {k: v for k, v in tc.items() if k != "args"}
                    for tc in self._tool_calls
                ]

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
