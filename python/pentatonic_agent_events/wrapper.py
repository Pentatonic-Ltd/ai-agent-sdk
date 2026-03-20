import json
import sys
import uuid
from .normalizer import normalize_response
from .session import Session
from .tracking import rewrite_urls
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


def wrap_client(config, client, session_id=None, metadata=None, auto_emit=True, wait_until=None):
    client_type = detect_client_type(client)
    sid = session_id or str(uuid.uuid4())
    meta = metadata or {}

    # Shared session accumulates usage and tool calls across rounds
    session = Session(config, session_id=sid, metadata=meta)

    opts = {
        "session": session,
        "auto_emit": auto_emit,
        "metadata": meta,
        "wait_until": wait_until,
    }

    if client_type == "openai":
        return _OpenAIWrapper(config, client, opts)
    if client_type == "anthropic":
        return _AnthropicWrapper(config, client, opts)
    if client_type == "workers-ai":
        return _WorkersAIWrapper(config, client, opts)

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


def _extract_tool_results(session, messages):
    """
    Extract tool results from the messages array and attach them to recorded
    tool calls in the session. Messages contain {role:"tool", content, tool_call_id}
    entries after the app executes tools and feeds results back to the AI.
    """
    if not messages or not session._tool_calls:
        return

    # Build map: tool_call_id -> tool name from assistant messages
    id_to_name = {}
    for msg in messages:
        if not isinstance(msg, dict):
            continue
        if msg.get("role") == "assistant" and msg.get("tool_calls"):
            for tc in msg["tool_calls"]:
                tc_id = tc.get("id") or tc.get("tool_call_id")
                name = None
                if isinstance(tc.get("function"), dict):
                    name = tc["function"].get("name")
                if not name:
                    name = tc.get("name")
                if tc_id and name:
                    id_to_name[tc_id] = name

    # Attach results to session tool calls
    for msg in messages:
        if not isinstance(msg, dict):
            continue
        if msg.get("role") != "tool" or not msg.get("content"):
            continue

        call_id = msg.get("tool_call_id")
        tool_name = id_to_name.get(call_id) if call_id else None

        # Find matching tool call in session (by name, without a result yet)
        for tc in session._tool_calls:
            if tc.get("result"):
                continue
            if tool_name and tc.get("tool") != tool_name:
                continue

            # Parse JSON content if possible, otherwise store as string
            try:
                parsed = json.loads(msg["content"])
                if isinstance(parsed, list):
                    tc["result"] = {"count": len(parsed), "sample": parsed[:3]}
                else:
                    tc["result"] = parsed
            except (json.JSONDecodeError, TypeError, ValueError):
                tc["result"] = msg["content"]
            break


def _fire_and_forget_emit(config, opts, messages, result, model=None):
    session = opts["session"]
    normalized = session.record(result)

    # Extract tool results from the messages array
    _extract_tool_results(session, messages)

    # Capture system prompt from messages (first system message, only once)
    if not session._system_prompt and messages:
        for msg in (messages if isinstance(messages, list) else []):
            if isinstance(msg, dict) and msg.get("role") == "system" and msg.get("content"):
                session._system_prompt = msg["content"]
                break

    # If Workers AI didn't include model in the response, use the one passed to run()
    if model and not normalized.get("model"):
        session._model = model

    # When auto_emit is disabled, the caller controls event emission.
    # The wrapper still tracks usage/tool calls via session.record() above.
    if opts.get("auto_emit") is False:
        return

    # Accumulate tool-call rounds without emitting — only emit when there's
    # actual text content (the final response in a multi-round tool loop).
    if not normalized.get("content") and normalized.get("tool_calls"):
        return

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

    assistant_msg = normalized.get("content") or ""

    def _do_emit():
        try:
            session.emit_chat_turn(
                user_message=user_msg,
                assistant_response=assistant_msg,
            )
        except Exception as e:
            print(f"[pentatonic-ai] emit failed: {e}", file=sys.stderr)

    wait_until = opts.get("wait_until")
    if callable(wait_until):
        # On runtimes that terminate early (e.g., serverless), wait_until
        # keeps the process alive for background work.
        wait_until(_do_emit)
    else:
        _do_emit()


class _WrappedOpenAICompletions:
    def __init__(self, config, completions, opts):
        self._config = config
        self._completions = completions
        self._opts = opts

    def create(self, **kwargs):
        result = self._completions.create(**kwargs)

        # URL rewriting on text content
        session = self._opts["session"]
        if isinstance(result, dict):
            choices = result.get("choices") or []
            if choices:
                msg = choices[0].get("message") or {}
                content = msg.get("content")
                if content:
                    msg["content"] = rewrite_urls(
                        content, self._config,
                        session.session_id, self._opts.get("metadata"),
                    )

        _fire_and_forget_emit(self._config, self._opts, kwargs.get("messages"), result)
        return result

    def __getattr__(self, name):
        return getattr(self._completions, name)


class _WrappedOpenAIChat:
    def __init__(self, config, chat, opts):
        self._config = config
        self._chat = chat
        self.completions = _WrappedOpenAICompletions(config, chat.completions, opts)

    def __getattr__(self, name):
        if name == "completions":
            return self.completions
        return getattr(self._chat, name)


class _OpenAIWrapper:
    def __init__(self, config, client, opts):
        self._config = config
        self._client = client
        self._opts = opts
        self.chat = _WrappedOpenAIChat(config, client.chat, opts)

    @property
    def session_id(self):
        return self._opts["session"].session_id

    @property
    def tes_session(self):
        return self._opts["session"]

    def __getattr__(self, name):
        if name == "chat":
            return self.chat
        return getattr(self._client, name)


class _WrappedAnthropicMessages:
    def __init__(self, config, messages, opts):
        self._config = config
        self._messages = messages
        self._opts = opts

    def create(self, **kwargs):
        result = self._messages.create(**kwargs)

        # URL rewriting on text content blocks
        session = self._opts["session"]
        if isinstance(result, dict) and isinstance(result.get("content"), list):
            for block in result["content"]:
                if isinstance(block, dict) and block.get("type") == "text" and block.get("text"):
                    block["text"] = rewrite_urls(
                        block["text"], self._config,
                        session.session_id, self._opts.get("metadata"),
                    )

        _fire_and_forget_emit(self._config, self._opts, kwargs.get("messages"), result)
        return result

    def __getattr__(self, name):
        return getattr(self._messages, name)


class _AnthropicWrapper:
    def __init__(self, config, client, opts):
        self._config = config
        self._client = client
        self._opts = opts
        self.messages = _WrappedAnthropicMessages(config, client.messages, opts)

    @property
    def session_id(self):
        return self._opts["session"].session_id

    @property
    def tes_session(self):
        return self._opts["session"]

    def __getattr__(self, name):
        if name == "messages":
            return self.messages
        return getattr(self._client, name)


class _WorkersAIWrapper:
    def __init__(self, config, ai_binding, opts):
        self._config = config
        self._ai = ai_binding
        self._opts = opts

    @property
    def session_id(self):
        return self._opts["session"].session_id

    @property
    def tes_session(self):
        return self._opts["session"]

    def run(self, model, params=None, **kwargs):
        result = self._ai.run(model, params, **kwargs)

        # URL rewriting on response text
        session = self._opts["session"]
        if isinstance(result, dict) and result.get("response"):
            result["response"] = rewrite_urls(
                result["response"], self._config,
                session.session_id, self._opts.get("metadata"),
            )

        messages = params.get("messages") if isinstance(params, dict) else None
        _fire_and_forget_emit(self._config, self._opts, messages, result, model=model)
        return result

    def __getattr__(self, name):
        return getattr(self._ai, name)
