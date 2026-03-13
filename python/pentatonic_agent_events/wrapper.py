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
