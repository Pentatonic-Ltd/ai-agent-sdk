import { Session } from "./session.js";
import { normalizeResponse } from "./normalizer.js";

/**
 * Detect the client type by duck-typing its shape.
 * Returns "openai", "anthropic", "workers-ai", or "unknown".
 */
function detectClientType(client) {
  if (client?.chat?.completions?.create) return "openai";
  if (client?.messages?.create) return "anthropic";
  if (typeof client?.run === "function") return "workers-ai";
  return "unknown";
}

/**
 * Wrap any supported LLM client with automatic usage tracking.
 * Auto-detects OpenAI, Anthropic, and Workers AI clients.
 */
export function wrapClient(clientConfig, client) {
  const type = detectClientType(client);

  if (type === "openai") return wrapOpenAI(clientConfig, client);
  if (type === "anthropic") return wrapAnthropic(clientConfig, client);
  if (type === "workers-ai") return wrapWorkersAI(clientConfig, client);

  throw new Error(
    "Unsupported client: expected OpenAI (chat.completions.create), " +
      "Anthropic (messages.create), or Workers AI (run) client"
  );
}

// --- OpenAI ---

function wrapOpenAI(clientConfig, client) {
  return new Proxy(client, {
    get(target, prop) {
      if (prop === "chat") return wrapOpenAIChat(clientConfig, target.chat, target);
      if (prop === "session") return (opts) => new OpenAISession(clientConfig, target, opts);
      return target[prop];
    },
  });
}

function wrapOpenAIChat(clientConfig, chat, client) {
  return new Proxy(chat, {
    get(target, prop) {
      if (prop === "completions") return wrapOpenAICompletions(clientConfig, target.completions, client);
      return target[prop];
    },
  });
}

function wrapOpenAICompletions(clientConfig, completions, client) {
  return new Proxy(completions, {
    get(target, prop) {
      if (prop === "create") {
        return async (params) => {
          const result = await target.create(params);
          fireAndForgetEmit(clientConfig, params.messages, result);
          return result;
        };
      }
      return target[prop];
    },
  });
}

class OpenAISession extends Session {
  constructor(clientConfig, client, opts) {
    super(clientConfig, opts);
    this._client = client;
  }

  async chat(params) {
    const result = await this._client.chat.completions.create(params);
    this.record(result);
    return result;
  }
}

// --- Anthropic ---

function wrapAnthropic(clientConfig, client) {
  return new Proxy(client, {
    get(target, prop) {
      if (prop === "messages") return wrapAnthropicMessages(clientConfig, target.messages, target);
      if (prop === "session") return (opts) => new AnthropicSession(clientConfig, target, opts);
      return target[prop];
    },
  });
}

function wrapAnthropicMessages(clientConfig, messages, client) {
  return new Proxy(messages, {
    get(target, prop) {
      if (prop === "create") {
        return async (params) => {
          const result = await target.create(params);
          fireAndForgetEmit(clientConfig, params.messages, result);
          return result;
        };
      }
      return target[prop];
    },
  });
}

class AnthropicSession extends Session {
  constructor(clientConfig, client, opts) {
    super(clientConfig, opts);
    this._client = client;
  }

  async chat(params) {
    const result = await this._client.messages.create(params);
    this.record(result);
    return result;
  }
}

// --- Workers AI ---

function wrapWorkersAI(clientConfig, aiBinding) {
  return new Proxy(aiBinding, {
    get(target, prop) {
      if (prop === "run") {
        return async (model, params, ...rest) => {
          const result = await target.run(model, params, ...rest);
          fireAndForgetEmit(clientConfig, params?.messages, result, model);
          return result;
        };
      }
      if (prop === "session") return (opts) => new WorkersAISession(clientConfig, target, opts);
      return target[prop];
    },
  });
}

class WorkersAISession extends Session {
  constructor(clientConfig, aiBinding, opts) {
    super(clientConfig, opts);
    this._ai = aiBinding;
  }

  async chat(model, params, ...rest) {
    const result = await this._ai.run(model, params, ...rest);
    this.record(result);
    return result;
  }
}

// --- Shared ---

function fireAndForgetEmit(clientConfig, messages, result, model) {
  const session = new Session(clientConfig);
  const normalized = session.record(result);

  // If Workers AI didn't include model in the response, use the one passed to run()
  if (model && !normalized.model) {
    session._model = model;
  }

  const rawContent =
    messages?.filter?.((m) => m.role === "user")?.pop()?.content || "";
  // Anthropic content can be an array of content blocks — extract text only
  const userMsg = Array.isArray(rawContent)
    ? rawContent
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n")
    : rawContent;
  const assistantMsg = normalized.content || "";

  session
    .emitChatTurn({ userMessage: userMsg, assistantResponse: assistantMsg })
    .catch((err) => console.error("[pentatonic-ai] emit failed:", err.message));
}
