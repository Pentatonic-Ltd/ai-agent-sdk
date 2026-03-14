import sys
import uuid
from .normalizer import normalize_response
from .transport import send_event


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


def wrap_client(config, client, session_id=None, metadata=None):
    client_type = detect_client_type(client)
    sid = session_id or str(uuid.uuid4())
    meta = metadata or {}

    if client_type == "openai":
        return _OpenAIWrapper(config, client, sid, meta)
    if client_type == "anthropic":
        return _AnthropicWrapper(config, client, sid, meta)
    if client_type == "workers-ai":
        return _WorkersAIWrapper(config, client, sid, meta)

    raise ValueError(
        "Unsupported client: expected OpenAI (chat.completions.create), "
        "Anthropic (messages.create), or Workers AI (run) client"
    )


def _truncate(value, max_len):
    if not value or not max_len or not isinstance(value, str):
        return value
    if len(value) <= max_len:
        return value
    return value[:max_len] + "...[truncated]"


def _emit_event(config, session_id, metadata, messages, normalized, model=None):
    capture = config.get("capture_content", True) is not False
    max_len = config.get("max_content_length")

    raw_content = ""
    if isinstance(messages, list):
        user_msgs = [m for m in messages if isinstance(m, dict) and m.get("role") == "user"]
        if user_msgs:
            raw_content = user_msgs[-1].get("content", "")

    if isinstance(raw_content, list):
        user_msg = "\n".join(
            b.get("text", "") for b in raw_content if isinstance(b, dict) and b.get("type") == "text"
        )
    else:
        user_msg = raw_content

    assistant_msg = normalized["content"] or ""

    attributes = {
        **metadata,
        "source": "pentatonic-ai-sdk",
        "model": model or normalized["model"],
        "usage": {
            "prompt_tokens": normalized["usage"]["prompt_tokens"],
            "completion_tokens": normalized["usage"]["completion_tokens"],
            "total_tokens": normalized["usage"]["prompt_tokens"] + normalized["usage"]["completion_tokens"],
            "ai_rounds": 1,
        },
    }

    if normalized["tool_calls"]:
        if capture:
            attributes["tool_calls"] = [{**tc, "round": 0} for tc in normalized["tool_calls"]]
        else:
            attributes["tool_calls"] = [
                {k: v for k, v in {**tc, "round": 0}.items() if k != "args"}
                for tc in normalized["tool_calls"]
            ]

    if capture:
        attributes["user_message"] = _truncate(user_msg, max_len)
        attributes["assistant_response"] = _truncate(assistant_msg, max_len)

        if messages:
            attributes["messages"] = [
                {**m, "content": _truncate(m["content"], max_len)}
                if isinstance(m.get("content"), str) else m
                for m in messages
            ]

    try:
        send_event(config, {
            "eventType": "CHAT_TURN",
            "entityType": "conversation",
            "data": {
                "entity_id": session_id,
                "attributes": attributes,
            },
        })
    except Exception as e:
        print(f"[pentatonic-ai] emit failed: {e}", file=sys.stderr)


class _WrappedOpenAICompletions:
    def __init__(self, config, completions, session_id, metadata):
        self._config = config
        self._completions = completions
        self._session_id = session_id
        self._metadata = metadata

    def create(self, **kwargs):
        result = self._completions.create(**kwargs)
        normalized = normalize_response(result)
        _emit_event(self._config, self._session_id, self._metadata, kwargs.get("messages"), normalized)
        return result

    def __getattr__(self, name):
        return getattr(self._completions, name)


class _WrappedOpenAIChat:
    def __init__(self, config, chat, session_id, metadata):
        self._config = config
        self._chat = chat
        self.completions = _WrappedOpenAICompletions(config, chat.completions, session_id, metadata)

    def __getattr__(self, name):
        if name == "completions":
            return self.completions
        return getattr(self._chat, name)


class _OpenAIWrapper:
    def __init__(self, config, client, session_id, metadata):
        self._config = config
        self._client = client
        self._session_id = session_id
        self._metadata = metadata
        self.chat = _WrappedOpenAIChat(config, client.chat, session_id, metadata)

    @property
    def session_id(self):
        return self._session_id

    def __getattr__(self, name):
        if name == "chat":
            return self.chat
        return getattr(self._client, name)


class _WrappedAnthropicMessages:
    def __init__(self, config, messages, session_id, metadata):
        self._config = config
        self._messages = messages
        self._session_id = session_id
        self._metadata = metadata

    def create(self, **kwargs):
        result = self._messages.create(**kwargs)
        normalized = normalize_response(result)
        _emit_event(self._config, self._session_id, self._metadata, kwargs.get("messages"), normalized)
        return result

    def __getattr__(self, name):
        return getattr(self._messages, name)


class _AnthropicWrapper:
    def __init__(self, config, client, session_id, metadata):
        self._config = config
        self._client = client
        self._session_id = session_id
        self._metadata = metadata
        self.messages = _WrappedAnthropicMessages(config, client.messages, session_id, metadata)

    @property
    def session_id(self):
        return self._session_id

    def __getattr__(self, name):
        if name == "messages":
            return self.messages
        return getattr(self._client, name)


class _WorkersAIWrapper:
    def __init__(self, config, ai_binding, session_id, metadata):
        self._config = config
        self._ai = ai_binding
        self._session_id = session_id
        self._metadata = metadata

    @property
    def session_id(self):
        return self._session_id

    def run(self, model, params=None, **kwargs):
        result = self._ai.run(model, params, **kwargs)
        messages = params.get("messages") if isinstance(params, dict) else None
        normalized = normalize_response(result)
        _emit_event(self._config, self._session_id, self._metadata, messages, normalized, model=model)
        return result

    def __getattr__(self, name):
        return getattr(self._ai, name)
