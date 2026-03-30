import uuid
from .normalizer import normalize_response
from .tracking import build_track_url
from .transport import send_event
import math
import time


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
        self._system_prompt = None

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

    def record_tool_result(self, tool_name, result):
        """Attach a result summary to the most recent tool call matching tool_name."""
        for i in range(len(self._tool_calls) - 1, -1, -1):
            tc = self._tool_calls[i]
            if tc.get("tool") == tool_name and not tc.get("result"):
                tc["result"] = result
                return

    def track_url(self, url, event_type="LINK_CLICK", attributes=None):
        """Build a tracked redirect URL for the given URL."""
        payload = {
            "u": url,
            "s": self.session_id,
            "c": self._config.get("client_id", ""),
            "t": math.floor(time.time()),
            "e": event_type,
        }
        meta = {**self._metadata, **(attributes or {})}
        if meta:
            payload["a"] = meta
        return build_track_url(self._config.get("endpoint", ""), self._config.get("api_key", ""), payload)

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

            if self._system_prompt:
                attributes["system_prompt"] = _truncate(self._system_prompt, max_len)

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
