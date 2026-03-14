import { normalizeResponse } from "./normalizer.js";
import { sendEvent } from "./transport.js";

/**
 * Detect the client type by duck-typing its shape.
 */
function detectClientType(client) {
  if (client?.chat?.completions?.create) return "openai";
  if (client?.messages?.create) return "anthropic";
  if (typeof client?.run === "function") return "workers-ai";
  return "unknown";
}

/**
 * Wrap any supported LLM client with automatic per-call event emission.
 */
export function wrapClient(clientConfig, client, { sessionId, metadata } = {}) {
  const type = detectClientType(client);
  const sid = sessionId || crypto.randomUUID();
  const meta = metadata || {};

  if (type === "openai") return wrapOpenAI(clientConfig, client, sid, meta);
  if (type === "anthropic") return wrapAnthropic(clientConfig, client, sid, meta);
  if (type === "workers-ai") return wrapWorkersAI(clientConfig, client, sid, meta);

  throw new Error(
    "Unsupported client: expected OpenAI (chat.completions.create), " +
      "Anthropic (messages.create), or Workers AI (run) client"
  );
}

// --- Shared emit ---

function emitEvent(clientConfig, sessionId, metadata, messages, normalized, model) {
  const capture = clientConfig.captureContent !== false;
  const maxLen = clientConfig.maxContentLength;

  const rawContent =
    messages?.filter?.((m) => m.role === "user")?.pop()?.content || "";
  const userMsg = Array.isArray(rawContent)
    ? rawContent
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n")
    : rawContent;
  const assistantMsg = normalized.content || "";

  const attributes = {
    ...metadata,
    source: "pentatonic-ai-sdk",
    model: model || normalized.model,
    usage: {
      prompt_tokens: normalized.usage.prompt_tokens,
      completion_tokens: normalized.usage.completion_tokens,
      total_tokens: normalized.usage.prompt_tokens + normalized.usage.completion_tokens,
      ai_rounds: 1,
    },
  };

  if (normalized.toolCalls.length) {
    attributes.tool_calls = capture
      ? normalized.toolCalls.map((tc) => ({ ...tc, round: 0 }))
      : normalized.toolCalls.map(({ args, ...rest }) => ({ ...rest, round: 0 }));
  }

  if (capture) {
    attributes.user_message = _truncate(userMsg, maxLen);
    attributes.assistant_response = _truncate(assistantMsg, maxLen);

    if (messages) {
      attributes.messages = messages.map((m) => {
        if (typeof m.content === "string") {
          return { ...m, content: _truncate(m.content, maxLen) };
        }
        return m;
      });
    }
  }

  sendEvent(clientConfig, {
    eventType: "CHAT_TURN",
    entityType: "conversation",
    data: {
      entity_id: sessionId,
      attributes,
    },
  }).catch((err) => console.error("[pentatonic-ai] emit failed:", err.message));
}

function _truncate(value, maxLen) {
  if (!value || !maxLen || typeof value !== "string") return value;
  if (value.length <= maxLen) return value;
  return value.slice(0, maxLen) + "...[truncated]";
}

// --- OpenAI ---

function wrapOpenAI(config, client, sessionId, metadata) {
  return new Proxy(client, {
    get(target, prop) {
      if (prop === "chat") return wrapOpenAIChat(config, target.chat, sessionId, metadata);
      if (prop === "sessionId") return sessionId;
      return target[prop];
    },
  });
}

function wrapOpenAIChat(config, chat, sessionId, metadata) {
  return new Proxy(chat, {
    get(target, prop) {
      if (prop === "completions") return wrapOpenAICompletions(config, target.completions, sessionId, metadata);
      return target[prop];
    },
  });
}

function wrapOpenAICompletions(config, completions, sessionId, metadata) {
  return new Proxy(completions, {
    get(target, prop) {
      if (prop === "create") {
        return async (params) => {
          const result = await target.create(params);
          const normalized = normalizeResponse(result);
          emitEvent(config, sessionId, metadata, params.messages, normalized);
          return result;
        };
      }
      return target[prop];
    },
  });
}

// --- Anthropic ---

function wrapAnthropic(config, client, sessionId, metadata) {
  return new Proxy(client, {
    get(target, prop) {
      if (prop === "messages") return wrapAnthropicMessages(config, target.messages, sessionId, metadata);
      if (prop === "sessionId") return sessionId;
      return target[prop];
    },
  });
}

function wrapAnthropicMessages(config, messages, sessionId, metadata) {
  return new Proxy(messages, {
    get(target, prop) {
      if (prop === "create") {
        return async (params) => {
          const result = await target.create(params);
          const normalized = normalizeResponse(result);
          emitEvent(config, sessionId, metadata, params.messages, normalized);
          return result;
        };
      }
      return target[prop];
    },
  });
}

// --- Workers AI ---

function wrapWorkersAI(config, aiBinding, sessionId, metadata) {
  return new Proxy(aiBinding, {
    get(target, prop) {
      if (prop === "run") {
        return async (model, params, ...rest) => {
          const result = await target.run(model, params, ...rest);
          const normalized = normalizeResponse(result);
          emitEvent(config, sessionId, metadata, params?.messages, normalized, model);
          return result;
        };
      }
      if (prop === "sessionId") return sessionId;
      return target[prop];
    },
  });
}
