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
