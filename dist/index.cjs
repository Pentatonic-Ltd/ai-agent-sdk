var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.js
var src_exports = {};
__export(src_exports, {
  Session: () => Session,
  TESClient: () => TESClient,
  buildTrackUrl: () => buildTrackUrl,
  normalizeResponse: () => normalizeResponse,
  rewriteUrls: () => rewriteUrls,
  signPayload: () => signPayload,
  verifyPayload: () => verifyPayload
});
module.exports = __toCommonJS(src_exports);

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
      ...headers,
      ...authHeaders
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

// src/tracking.js
var encoder = new TextEncoder();
function toBase64Url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++)
    binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function signPayload(secret, payload) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const data = encoder.encode(JSON.stringify(payload));
  const sig = await crypto.subtle.sign("HMAC", key, data);
  return toBase64Url(sig);
}
async function verifyPayload(secret, payload, signature) {
  const expected = await signPayload(secret, payload);
  return expected === signature;
}
async function buildTrackUrl(endpoint, apiKey, payload) {
  const p = { ...payload };
  if (!p.e)
    p.e = "LINK_CLICK";
  const encoded = toBase64Url(encoder.encode(JSON.stringify(p)));
  const sig = await signPayload(apiKey, p);
  return `${endpoint}/r/${encoded}?sig=${sig}`;
}
var URL_RE = /https?:\/\/[^\s"'<>)\]]+/g;
async function rewriteUrls(text, config, sessionId, metadata) {
  if (!text)
    return text;
  const redirectPrefix = `${config.endpoint}/r/`;
  const matches = [...text.matchAll(URL_RE)];
  if (matches.length === 0)
    return text;
  const replacements = /* @__PURE__ */ new Map();
  for (const m of matches) {
    const originalUrl = m[0];
    if (originalUrl.startsWith(redirectPrefix))
      continue;
    if (replacements.has(originalUrl))
      continue;
    const payload = {
      u: originalUrl,
      s: sessionId,
      c: config.clientId,
      t: Math.floor(Date.now() / 1e3)
    };
    if (metadata && Object.keys(metadata).length > 0) {
      payload.a = metadata;
    }
    const trackUrl = await buildTrackUrl(config.endpoint, config.apiKey, payload);
    replacements.set(originalUrl, trackUrl);
  }
  let result = text;
  const sorted = [...replacements.entries()].sort((a, b) => b[0].length - a[0].length);
  for (const [original, tracked] of sorted) {
    result = result.split(original).join(tracked);
  }
  return result;
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
    this._systemPrompt = null;
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
  /**
   * Attach a result summary to the most recent tool call matching `toolName`.
   * Call this after executing a tool to include results in the emitted event.
   */
  recordToolResult(toolName, result) {
    for (let i = this._toolCalls.length - 1; i >= 0; i--) {
      if (this._toolCalls[i].tool === toolName && !this._toolCalls[i].result) {
        this._toolCalls[i].result = result;
        return;
      }
    }
  }
  async emitChatTurn({ userMessage, assistantResponse, turnNumber, messages }) {
    const capture = this._config.captureContent !== false;
    const maxLen = this._config.maxContentLength;
    const attributes = {
      ...this._metadata,
      source: "pentatonic-ai-sdk",
      model: this._model,
      usage: this.totalUsage,
      tool_calls: this._toolCalls.length ? capture ? this._toolCalls : this._toolCalls.map(({ args, ...rest }) => rest) : void 0
    };
    if (capture) {
      attributes.user_message = truncate(userMessage, maxLen);
      attributes.assistant_response = truncate(assistantResponse, maxLen);
      if (this._systemPrompt) {
        attributes.system_prompt = truncate(this._systemPrompt, maxLen);
      }
      if (messages) {
        attributes.messages = messages.map((m) => {
          if (typeof m.content === "string") {
            return { ...m, content: truncate(m.content, maxLen) };
          }
          return m;
        });
      }
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
  async trackUrl(url, { eventType, attributes } = {}) {
    const payload = {
      u: url,
      s: this.sessionId,
      c: this._config.clientId,
      t: Math.floor(Date.now() / 1e3),
      e: eventType || "LINK_CLICK"
    };
    const meta = { ...this._metadata, ...attributes };
    if (Object.keys(meta).length) {
      payload.a = meta;
    }
    return buildTrackUrl(this._config.endpoint, this._config.apiKey, payload);
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
function wrapClient(clientConfig, client, sessionOpts = {}) {
  sessionOpts._resolvedSessionId = sessionOpts.sessionId || crypto.randomUUID();
  sessionOpts._session = new Session(clientConfig, {
    sessionId: sessionOpts._resolvedSessionId,
    metadata: sessionOpts.metadata
  });
  const type = detectClientType(client);
  if (type === "openai")
    return wrapOpenAI(clientConfig, client, sessionOpts);
  if (type === "anthropic")
    return wrapAnthropic(clientConfig, client, sessionOpts);
  if (type === "workers-ai")
    return wrapWorkersAI(clientConfig, client, sessionOpts);
  throw new Error(
    "Unsupported client: expected OpenAI (chat.completions.create), Anthropic (messages.create), or Workers AI (run) client"
  );
}
function wrapOpenAI(clientConfig, client, sessionOpts) {
  return new Proxy(client, {
    get(target, prop) {
      if (prop === "chat")
        return wrapOpenAIChat(clientConfig, target.chat, target, sessionOpts);
      if (prop === "sessionId")
        return sessionOpts._resolvedSessionId;
      if (prop === "tesSession")
        return sessionOpts._session;
      if (prop === "session")
        return (opts) => new OpenAISession(clientConfig, target, opts);
      return target[prop];
    }
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
    }
  });
}
function wrapOpenAICompletions(clientConfig, completions, client, sessionOpts) {
  return new Proxy(completions, {
    get(target, prop) {
      if (prop === "create") {
        return async (params) => {
          const result = await target.create(params);
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
            params.messages,
            result
          );
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
      if (prop === "sessionId")
        return sessionOpts._resolvedSessionId;
      if (prop === "tesSession")
        return sessionOpts._session;
      if (prop === "session")
        return (opts) => new AnthropicSession(clientConfig, target, opts);
      return target[prop];
    }
  });
}
function wrapAnthropicMessages(clientConfig, messages, client, sessionOpts) {
  return new Proxy(messages, {
    get(target, prop) {
      if (prop === "create") {
        return async (params) => {
          const result = await target.create(params);
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
            params.messages,
            result
          );
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
function wrapWorkersAI(clientConfig, aiBinding, sessionOpts) {
  return new Proxy(aiBinding, {
    get(target, prop) {
      if (prop === "run") {
        return async (model, params, ...rest) => {
          const result = await target.run(model, params, ...rest);
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
            params?.messages,
            result,
            model
          );
          return result;
        };
      }
      if (prop === "sessionId")
        return sessionOpts._resolvedSessionId;
      if (prop === "tesSession")
        return sessionOpts._session;
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
function extractToolResults(session, messages) {
  if (!messages?.length || !session._toolCalls.length)
    return;
  const idToName = /* @__PURE__ */ new Map();
  for (const msg of messages) {
    if (msg.role === "assistant" && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        const id = tc.id || tc.tool_call_id;
        const name = tc.function?.name || tc.name;
        if (id && name)
          idToName.set(id, name);
      }
    }
  }
  for (const msg of messages) {
    if (msg.role !== "tool" || !msg.content)
      continue;
    const callId = msg.tool_call_id;
    const toolName = callId ? idToName.get(callId) : null;
    for (const tc of session._toolCalls) {
      if (tc.result)
        continue;
      if (toolName && tc.tool !== toolName)
        continue;
      try {
        const parsed = JSON.parse(msg.content);
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
  extractToolResults(session, messages);
  if (!session._systemPrompt && messages?.length) {
    const systemMsg = messages.find((m) => m.role === "system");
    if (systemMsg?.content) {
      session._systemPrompt = systemMsg.content;
    }
  }
  if (model && !normalized.model) {
    session._model = model;
  }
  if (sessionOpts.autoEmit === false) {
    return;
  }
  if (!normalized.content && normalized.toolCalls.length > 0) {
    return;
  }
  const userMsg = messages?.filter?.((m) => m.role === "user")?.pop()?.content || "";
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
  wrap(client, { sessionId, metadata, autoEmit = true } = {}) {
    return wrapClient(this._config, client, { sessionId, metadata, autoEmit });
  }
};
