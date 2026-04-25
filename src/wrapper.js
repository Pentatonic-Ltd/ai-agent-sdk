import { Session } from "./session.js";
import { normalizeResponse } from "./normalizer.js";
import { rewriteUrls } from "./tracking.js";
import {
  hostedSearch,
  injectMemories,
} from "../packages/memory/src/hosted.js";

// Default memory-injection knobs. Match the proxy's defaults so SDK and
// proxy customers see identical retrieval behaviour.
const MEMORY_DEFAULTS = {
  limit: 6,
  minScore: 0.55,
  timeoutMs: 800,
};

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
 * Pull the last user message from a request body. Anthropic + OpenAI both
 * carry messages on `params.messages`; Workers AI may also use
 * `params.prompt` or `params.input_text`. Returns null when nothing usable
 * is present (e.g. embedding call, empty prompt) so memory retrieval is
 * skipped cleanly.
 */
function extractLastUserMessage(params, provider) {
  // Only messages-shaped requests are eligible for system-prompt injection.
  // Workers AI prompt-style calls (`{ prompt: "..." }`) are passed through
  // unchanged — there's no clean place to insert memory context without
  // changing the request shape, and we never want to surprise the caller
  // by mutating their prompt string.
  void provider;
  const msgs = Array.isArray(params?.messages) ? params.messages : null;
  if (!msgs) return null;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "user") {
      const c = msgs[i].content;
      if (typeof c === "string") return c;
      if (Array.isArray(c)) {
        return c
          .filter((p) => p.type === "text" && typeof p.text === "string")
          .map((p) => p.text)
          .join("\n");
      }
    }
  }
  return null;
}

/**
 * Inject memories from TES into request params before the LLM call.
 *
 * Default-on. Disable per-wrapClient via `sessionOpts.memory: false` or
 * per-call via `sessionOpts.memoryOpts.disable: true`. Knobs come from
 * `sessionOpts.memoryOpts` (`limit`, `minScore`, `timeoutMs`).
 *
 * Failure modes (TES timeout, module disabled, network error) are
 * non-fatal — the call proceeds with the customer's original params and
 * the skip reason is recorded on the session under `_lastMemoryStats`
 * for observability.
 */
async function maybeInjectMemories(
  clientConfig,
  sessionOpts,
  params,
  provider
) {
  if (sessionOpts.memory === false) {
    return { params, injected: 0, skipped: "memory_disabled" };
  }

  if (!clientConfig?.endpoint || !clientConfig?.apiKey) {
    return { params, injected: 0, skipped: "no_tes_config" };
  }

  const userMessage = extractLastUserMessage(params, provider);
  if (!userMessage) {
    return { params, injected: 0, skipped: "no_user_message" };
  }

  const opts = { ...MEMORY_DEFAULTS, ...(sessionOpts.memoryOpts || {}) };
  const { memories, skipped } = await hostedSearch(
    {
      endpoint: clientConfig.endpoint,
      clientId: clientConfig.clientId,
      apiKey: clientConfig.apiKey,
    },
    userMessage,
    opts
  );

  if (!memories?.length) {
    return { params, injected: 0, skipped: skipped || "no_memories" };
  }

  return {
    params: injectMemories(params, memories, provider),
    injected: memories.length,
    skipped: null,
  };
}

function recordMemoryStats(sessionOpts, stats) {
  if (sessionOpts._session) {
    sessionOpts._session._lastMemoryStats = stats;
  }
}

/**
 * Wrap any supported LLM client with automatic usage tracking.
 * Auto-detects OpenAI, Anthropic, and Workers AI clients.
 */
export function wrapClient(clientConfig, client, sessionOpts = {}) {
  // Resolve sessionId once so all calls share the same session
  sessionOpts._resolvedSessionId =
    sessionOpts.sessionId || crypto.randomUUID();

  // Shared session accumulates usage and tool calls across rounds
  sessionOpts._session = new Session(clientConfig, {
    sessionId: sessionOpts._resolvedSessionId,
    metadata: sessionOpts.metadata,
  });

  const type = detectClientType(client);

  if (type === "openai") return wrapOpenAI(clientConfig, client, sessionOpts);
  if (type === "anthropic")
    return wrapAnthropic(clientConfig, client, sessionOpts);
  if (type === "workers-ai")
    return wrapWorkersAI(clientConfig, client, sessionOpts);

  throw new Error(
    "Unsupported client: expected OpenAI (chat.completions.create), " +
      "Anthropic (messages.create), or Workers AI (run) client"
  );
}

// --- OpenAI ---

function wrapOpenAI(clientConfig, client, sessionOpts) {
  return new Proxy(client, {
    get(target, prop) {
      if (prop === "chat")
        return wrapOpenAIChat(clientConfig, target.chat, target, sessionOpts);
      if (prop === "sessionId") return sessionOpts._resolvedSessionId;
      if (prop === "tesSession") return sessionOpts._session;
      if (prop === "session")
        return (opts) => new OpenAISession(clientConfig, target, opts);
      return target[prop];
    },
  });
}

function wrapOpenAIChat(clientConfig, chat, client, sessionOpts) {
  return new Proxy(chat, {
    get(target, prop) {
      if (prop === "completions")
        return wrapOpenAICompletions(
          clientConfig,
          target.completions,
          client,
          sessionOpts
        );
      return target[prop];
    },
  });
}

function wrapOpenAICompletions(clientConfig, completions, client, sessionOpts) {
  return new Proxy(completions, {
    get(target, prop) {
      if (prop === "create") {
        return async (params) => {
          const memStats = await maybeInjectMemories(
            clientConfig,
            sessionOpts,
            params,
            "openai"
          );
          recordMemoryStats(sessionOpts, memStats);
          const result = await target.create(memStats.params);
          const content = result.choices?.[0]?.message?.content;
          if (content) {
            result.choices[0].message.content = await rewriteUrls(
              content,
              clientConfig,
              sessionOpts._resolvedSessionId,
              sessionOpts.metadata
            );
          }
          fireAndForgetEmit(
            clientConfig,
            sessionOpts,
            memStats.params.messages,
            result
          );
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

function wrapAnthropic(clientConfig, client, sessionOpts) {
  return new Proxy(client, {
    get(target, prop) {
      if (prop === "messages")
        return wrapAnthropicMessages(
          clientConfig,
          target.messages,
          target,
          sessionOpts
        );
      if (prop === "sessionId") return sessionOpts._resolvedSessionId;
      if (prop === "tesSession") return sessionOpts._session;
      if (prop === "session")
        return (opts) => new AnthropicSession(clientConfig, target, opts);
      return target[prop];
    },
  });
}

function wrapAnthropicMessages(clientConfig, messages, client, sessionOpts) {
  return new Proxy(messages, {
    get(target, prop) {
      if (prop === "create") {
        return async (params) => {
          const memStats = await maybeInjectMemories(
            clientConfig,
            sessionOpts,
            params,
            "anthropic"
          );
          recordMemoryStats(sessionOpts, memStats);
          const result = await target.create(memStats.params);
          if (Array.isArray(result.content)) {
            for (const block of result.content) {
              if (block.type === "text" && block.text) {
                block.text = await rewriteUrls(
                  block.text,
                  clientConfig,
                  sessionOpts._resolvedSessionId,
                  sessionOpts.metadata
                );
              }
            }
          }
          fireAndForgetEmit(
            clientConfig,
            sessionOpts,
            memStats.params.messages,
            result
          );
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

function wrapWorkersAI(clientConfig, aiBinding, sessionOpts) {
  return new Proxy(aiBinding, {
    get(target, prop) {
      if (prop === "run") {
        return async (model, params, ...rest) => {
          const memStats = await maybeInjectMemories(
            clientConfig,
            sessionOpts,
            params,
            "workers-ai"
          );
          recordMemoryStats(sessionOpts, memStats);
          const result = await target.run(model, memStats.params, ...rest);
          if (result.response) {
            result.response = await rewriteUrls(
              result.response,
              clientConfig,
              sessionOpts._resolvedSessionId,
              sessionOpts.metadata
            );
          }
          fireAndForgetEmit(
            clientConfig,
            sessionOpts,
            memStats.params?.messages,
            result,
            model
          );
          return result;
        };
      }
      if (prop === "sessionId") return sessionOpts._resolvedSessionId;
      if (prop === "tesSession") return sessionOpts._session;
      if (prop === "session")
        return (opts) => new WorkersAISession(clientConfig, target, opts);
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

/**
 * Extract tool results from the messages array and attach them to recorded
 * tool calls in the session. Messages contain {role:"tool", content, tool_call_id}
 * entries after the app executes tools and feeds results back to the AI.
 */
function extractToolResults(session, messages) {
  if (!messages?.length || !session._toolCalls.length) return;

  // Build map: tool_call_id -> tool name from assistant messages
  const idToName = new Map();
  for (const msg of messages) {
    if (msg.role === "assistant" && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        const id = tc.id || tc.tool_call_id;
        const name = tc.function?.name || tc.name;
        if (id && name) idToName.set(id, name);
      }
    }
  }

  // Attach results to session tool calls
  for (const msg of messages) {
    if (msg.role !== "tool" || !msg.content) continue;

    const callId = msg.tool_call_id;
    const toolName = callId ? idToName.get(callId) : null;

    // Find matching tool call in session (by name, without a result yet)
    for (const tc of session._toolCalls) {
      if (tc.result) continue; // already has a result
      if (toolName && tc.tool !== toolName) continue;

      // Parse JSON content if possible, otherwise store as string
      try {
        const parsed = JSON.parse(msg.content);
        // Summarise arrays (e.g. product lists) to avoid bloating the event
        if (Array.isArray(parsed)) {
          tc.result = { count: parsed.length, sample: parsed.slice(0, 3) };
        } else {
          tc.result = parsed;
        }
      } catch {
        tc.result = msg.content;
      }
      break;
    }
  }
}

function fireAndForgetEmit(clientConfig, sessionOpts, messages, result, model) {
  const session = sessionOpts._session;
  const normalized = session.record(result);

  // Extract tool results from the messages array.
  extractToolResults(session, messages);

  // Capture system prompt from messages (first system message, only once)
  if (!session._systemPrompt && messages?.length) {
    const systemMsg = messages.find((m) => m.role === "system");
    if (systemMsg?.content) {
      session._systemPrompt = systemMsg.content;
    }
  }

  // If Workers AI didn't include model in the response, use the one passed to run()
  if (model && !normalized.model) {
    session._model = model;
  }

  // When autoEmit is disabled, the caller controls event emission.
  // The wrapper still tracks usage/tool calls via session.record() above.
  if (sessionOpts.autoEmit === false) {
    return;
  }

  // Accumulate tool-call rounds without emitting — only emit when there's
  // actual text content (the final response in a multi-round tool loop).
  // This ensures a single CHAT_TURN event per conversation turn with all
  // accumulated tool calls and usage included.
  if (!normalized.content && normalized.toolCalls.length > 0) {
    return;
  }

  const userMsg =
    messages?.filter?.((m) => m.role === "user")?.pop()?.content || "";
  const assistantMsg = normalized.content || "";

  const emitPromise = session
    .emitChatTurn({ userMessage: userMsg, assistantResponse: assistantMsg })
    .catch((err) => console.error("[pentatonic-ai] emit failed:", err.message));

  // On Cloudflare Workers, the runtime terminates after the response is sent.
  // waitUntil keeps the Worker alive for background work like event emission.
  if (typeof sessionOpts.waitUntil === "function") {
    sessionOpts.waitUntil(emitPromise);
  }
}
