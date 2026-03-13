// src/normalizer.js
function normalizeResponse(raw) {
  if (!raw || typeof raw !== "object") {
    return empty();
  }
  if (Array.isArray(raw.choices)) {
    return normalizeOpenAI(raw);
  }
  if (Array.isArray(raw.content) && raw.content[0]?.type) {
    return normalizeAnthropic(raw);
  }
  if (typeof raw.response === "string" || raw.tool_calls && !raw.choices) {
    return normalizeWorkersAI(raw);
  }
  return empty();
}
function empty() {
  return {
    content: "",
    model: null,
    usage: { prompt_tokens: 0, completion_tokens: 0 },
    toolCalls: []
  };
}
function normalizeOpenAI(raw) {
  const message = raw.choices?.[0]?.message || {};
  const usage = raw.usage || {};
  const rawToolCalls = message.tool_calls?.length ? message.tool_calls : raw.tool_calls || [];
  const toolCalls = rawToolCalls.map((tc) => ({
    tool: tc.function?.name || tc.name,
    args: parseArgs(tc.function?.arguments || tc.arguments)
  }));
  return {
    content: message.content || "",
    model: raw.model || null,
    usage: {
      prompt_tokens: usage.prompt_tokens || 0,
      completion_tokens: usage.completion_tokens || 0
    },
    toolCalls
  };
}
function normalizeAnthropic(raw) {
  const usage = raw.usage || {};
  let content = "";
  const toolCalls = [];
  for (const block of raw.content) {
    if (block.type === "text") {
      content += block.text;
    } else if (block.type === "tool_use") {
      toolCalls.push({ tool: block.name, args: block.input || {} });
    }
  }
  return {
    content,
    model: raw.model || null,
    usage: {
      prompt_tokens: usage.input_tokens || 0,
      completion_tokens: usage.output_tokens || 0
    },
    toolCalls
  };
}
function normalizeWorkersAI(raw) {
  const usage = raw.usage || {};
  const toolCalls = (raw.tool_calls || []).map((tc) => ({
    tool: tc.function?.name || tc.name,
    args: parseArgs(tc.function?.arguments || tc.arguments || {})
  }));
  return {
    content: raw.response || "",
    model: raw.model || null,
    usage: {
      prompt_tokens: usage.prompt_tokens || 0,
      completion_tokens: usage.completion_tokens || 0
    },
    toolCalls
  };
}
function parseArgs(args) {
  if (typeof args === "string") {
    try {
      return JSON.parse(args);
    } catch {
      return {};
    }
  }
  return args || {};
}

// src/transport.js
var EMIT_EVENT_MUTATION = `
  mutation EmitEvent($input: EventInput!) {
    emitEvent(input: $input) {
      success
      eventId
      message
    }
  }
`;
async function sendEvent({ endpoint, apiKey, clientId, headers }, input, fetchFn) {
  const f = fetchFn || globalThis.fetch;
  const authHeaders = apiKey.startsWith("tes_") ? { Authorization: `Bearer ${apiKey}` } : { "x-service-key": apiKey };
  const response = await f(`${endpoint}/api/graphql`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-client-id": clientId,
      ...authHeaders,
      ...headers
    },
    body: JSON.stringify({
      query: EMIT_EVENT_MUTATION,
      variables: { input }
    })
  });
  if (!response.ok) {
    throw new Error(`TES API error: ${response.status}`);
  }
  const json = await response.json();
  if (json.errors?.length) {
    throw new Error(`TES GraphQL error: ${json.errors[0].message}`);
  }
  return json.data.emitEvent;
}

// src/session.js
function truncate(value, maxLen) {
  if (!value || !maxLen || typeof value !== "string")
    return value;
  if (value.length <= maxLen)
    return value;
  return value.slice(0, maxLen) + "...[truncated]";
}
var Session = class {
  constructor(clientConfig, { sessionId, metadata } = {}) {
    Object.defineProperty(this, "_config", {
      value: clientConfig,
      enumerable: false
    });
    this.sessionId = sessionId || crypto.randomUUID();
    this._metadata = metadata || {};
    this._reset();
  }
  _reset() {
    this._promptTokens = 0;
    this._completionTokens = 0;
    this._rounds = 0;
    this._toolCalls = [];
    this._model = null;
  }
  get totalUsage() {
    return {
      prompt_tokens: this._promptTokens,
      completion_tokens: this._completionTokens,
      total_tokens: this._promptTokens + this._completionTokens,
      ai_rounds: this._rounds
    };
  }
  get toolCalls() {
    return this._toolCalls;
  }
  record(rawResponse) {
    const normalized = normalizeResponse(rawResponse);
    const round = this._rounds;
    this._promptTokens += normalized.usage.prompt_tokens;
    this._completionTokens += normalized.usage.completion_tokens;
    this._rounds += 1;
    if (normalized.model) {
      this._model = normalized.model;
    }
    for (const tc of normalized.toolCalls) {
      this._toolCalls.push({ ...tc, round });
    }
    return normalized;
  }
  async emitChatTurn({ userMessage, assistantResponse, turnNumber }) {
    const capture = this._config.captureContent !== false;
    const maxLen = this._config.maxContentLength;
    const attributes = {
      ...this._metadata,
      source: "pentatonic-ai-sdk",
      model: this._model,
      usage: this.totalUsage,
      tool_calls: this._toolCalls.length ? this._toolCalls : void 0
    };
    if (capture) {
      attributes.user_message = truncate(userMessage, maxLen);
      attributes.assistant_response = truncate(assistantResponse, maxLen);
    }
    if (turnNumber !== void 0) {
      attributes.turn_number = turnNumber;
    }
    const result = await sendEvent(this._config, {
      eventType: "CHAT_TURN",
      entityType: "conversation",
      data: {
        entity_id: this.sessionId,
        attributes
      }
    });
    this._reset();
    return result;
  }
  async emitToolUse({ tool, args, resultSummary, durationMs, turnNumber }) {
    const capture = this._config.captureContent !== false;
    const maxLen = this._config.maxContentLength;
    const attributes = {
      ...this._metadata,
      source: "pentatonic-ai-sdk",
      tool,
      duration_ms: durationMs,
      turn_number: turnNumber
    };
    if (capture) {
      attributes.args = args;
      attributes.result_summary = truncate(resultSummary, maxLen);
    }
    return sendEvent(this._config, {
      eventType: "TOOL_USE",
      entityType: "conversation",
      data: {
        entity_id: this.sessionId,
        attributes
      }
    });
  }
  async emitSessionStart() {
    return sendEvent(this._config, {
      eventType: "SESSION_START",
      entityType: "conversation",
      data: {
        entity_id: this.sessionId,
        attributes: {
          source: "pentatonic-ai-sdk",
          metadata: this._metadata
        }
      }
    });
  }
};

// src/wrapper.js
function detectClientType(client) {
  if (client?.chat?.completions?.create)
    return "openai";
  if (client?.messages?.create)
    return "anthropic";
  if (typeof client?.run === "function")
    return "workers-ai";
  return "unknown";
}
function wrapClient(clientConfig, client) {
  const type = detectClientType(client);
  if (type === "openai")
    return wrapOpenAI(clientConfig, client);
  if (type === "anthropic")
    return wrapAnthropic(clientConfig, client);
  if (type === "workers-ai")
    return wrapWorkersAI(clientConfig, client);
  throw new Error(
    "Unsupported client: expected OpenAI (chat.completions.create), Anthropic (messages.create), or Workers AI (run) client"
  );
}
function wrapOpenAI(clientConfig, client) {
  return new Proxy(client, {
    get(target, prop) {
      if (prop === "chat")
        return wrapOpenAIChat(clientConfig, target.chat, target);
      if (prop === "session")
        return (opts) => new OpenAISession(clientConfig, target, opts);
      return target[prop];
    }
  });
}
function wrapOpenAIChat(clientConfig, chat, client) {
  return new Proxy(chat, {
    get(target, prop) {
      if (prop === "completions")
        return wrapOpenAICompletions(clientConfig, target.completions, client);
      return target[prop];
    }
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
    }
  });
}
var OpenAISession = class extends Session {
  constructor(clientConfig, client, opts) {
    super(clientConfig, opts);
    this._client = client;
  }
  async chat(params) {
    const result = await this._client.chat.completions.create(params);
    this.record(result);
    return result;
  }
};
function wrapAnthropic(clientConfig, client) {
  return new Proxy(client, {
    get(target, prop) {
      if (prop === "messages")
        return wrapAnthropicMessages(clientConfig, target.messages, target);
      if (prop === "session")
        return (opts) => new AnthropicSession(clientConfig, target, opts);
      return target[prop];
    }
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
    }
  });
}
var AnthropicSession = class extends Session {
  constructor(clientConfig, client, opts) {
    super(clientConfig, opts);
    this._client = client;
  }
  async chat(params) {
    const result = await this._client.messages.create(params);
    this.record(result);
    return result;
  }
};
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
      if (prop === "session")
        return (opts) => new WorkersAISession(clientConfig, target, opts);
      return target[prop];
    }
  });
}
var WorkersAISession = class extends Session {
  constructor(clientConfig, aiBinding, opts) {
    super(clientConfig, opts);
    this._ai = aiBinding;
  }
  async chat(model, params, ...rest) {
    const result = await this._ai.run(model, params, ...rest);
    this.record(result);
    return result;
  }
};
function fireAndForgetEmit(clientConfig, messages, result, model) {
  const session = new Session(clientConfig);
  const normalized = session.record(result);
  if (model && !normalized.model) {
    session._model = model;
  }
  const rawContent = messages?.filter?.((m) => m.role === "user")?.pop()?.content || "";
  const userMsg = Array.isArray(rawContent) ? rawContent.filter((b) => b.type === "text").map((b) => b.text).join("\n") : rawContent;
  const assistantMsg = normalized.content || "";
  session.emitChatTurn({ userMessage: userMsg, assistantResponse: assistantMsg }).catch((err) => console.error("[pentatonic-ai] emit failed:", err.message));
}

// src/client.js
var TESClient = class {
  constructor({ clientId, apiKey, endpoint, headers, captureContent = true, maxContentLength = 4096 }) {
    if (!clientId)
      throw new Error("clientId is required");
    if (!apiKey)
      throw new Error("apiKey is required");
    if (!endpoint)
      throw new Error("endpoint is required");
    const cleanEndpoint = endpoint.replace(/\/$/, "");
    const isLocalDev = /^http:\/\/localhost(:\d+)?(\/|$)/.test(cleanEndpoint) || /^http:\/\/127\.0\.0\.1(:\d+)?(\/|$)/.test(cleanEndpoint);
    if (!cleanEndpoint.startsWith("https://") && !isLocalDev) {
      throw new Error(
        "endpoint must use https:// (http:// is only allowed for localhost)"
      );
    }
    this.clientId = clientId;
    this.endpoint = cleanEndpoint;
    this.captureContent = captureContent;
    this.maxContentLength = maxContentLength;
    Object.defineProperty(this, "_apiKey", {
      value: apiKey,
      enumerable: false,
      writable: false
    });
    Object.defineProperty(this, "_headers", {
      value: headers || {},
      enumerable: false,
      writable: false
    });
  }
  get _config() {
    return {
      clientId: this.clientId,
      apiKey: this._apiKey,
      endpoint: this.endpoint,
      headers: this._headers,
      captureContent: this.captureContent,
      maxContentLength: this.maxContentLength
    };
  }
  session(opts) {
    return new Session(this._config, opts);
  }
  wrap(openaiClient) {
    return wrapClient(this._config, openaiClient);
  }
};
export {
  Session,
  TESClient,
  normalizeResponse
};
