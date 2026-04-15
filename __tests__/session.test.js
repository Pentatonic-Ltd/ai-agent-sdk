import { TESClient } from "../src/index.js";

// Mock fetch globally
let fetchCalls = [];
globalThis.fetch = async (url, opts) => {
  fetchCalls.push({ url, opts });
  return {
    ok: true,
    json: async () => ({
      data: {
        createModuleEvent: { success: true, eventId: "evt-123" },
      },
    }),
  };
};

beforeEach(() => {
  fetchCalls = [];
});

describe("TESClient constructor security", () => {
  it("rejects non-https endpoint", () => {
    expect(
      () =>
        new TESClient({
          clientId: "c",
          apiKey: "k",
          endpoint: "http://evil.com",
        })
    ).toThrow("endpoint must use https://");
  });

  it("allows http://localhost for local dev", () => {
    const tes = new TESClient({
      clientId: "c",
      apiKey: "k",
      endpoint: "http://localhost:8788",
    });
    expect(tes.endpoint).toBe("http://localhost:8788");
  });

  it("allows http://127.0.0.1 for local dev", () => {
    const tes = new TESClient({
      clientId: "c",
      apiKey: "k",
      endpoint: "http://127.0.0.1:8788",
    });
    expect(tes.endpoint).toBe("http://127.0.0.1:8788");
  });

  it("does not expose apiKey via enumeration or JSON.stringify", () => {
    const tes = new TESClient({
      clientId: "c",
      apiKey: "secret-key",
      endpoint: "https://api.test.com",
    });
    const json = JSON.stringify(tes);
    expect(json).not.toContain("secret-key");
    expect(Object.keys(tes)).not.toContain("_apiKey");
    // But it's still accessible internally via _config
    expect(tes._config.apiKey).toBe("secret-key");
  });
});

describe("Session", () => {
  const tes = new TESClient({
    clientId: "test-client",
    apiKey: "tes_sk_test",
    endpoint: "https://api.test.com",
  });

  it("accumulates usage across multiple record() calls", () => {
    const session = tes.session({ sessionId: "sess-1" });

    session.record({
      choices: [{ message: { content: "thinking..." } }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      model: "gpt-4o",
    });

    session.record({
      choices: [{ message: { content: "done!" } }],
      usage: { prompt_tokens: 150, completion_tokens: 30, total_tokens: 180 },
      model: "gpt-4o",
    });

    expect(session.totalUsage).toEqual({
      prompt_tokens: 250,
      completion_tokens: 50,
      total_tokens: 300,
      ai_rounds: 2,
    });
  });

  it("collects tool calls across rounds", () => {
    const session = tes.session({ sessionId: "sess-2" });

    session.record({
      choices: [
        {
          message: {
            content: "",
            tool_calls: [
              { function: { name: "search", arguments: '{"q":"shoes"}' } },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
    });

    session.record({
      choices: [
        {
          message: {
            content: "",
            tool_calls: [
              {
                function: {
                  name: "recommend",
                  arguments: '{"ids":["1","2"]}',
                },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 80, completion_tokens: 15, total_tokens: 95 },
    });

    expect(session.toolCalls).toHaveLength(2);
    expect(session.toolCalls[0]).toEqual({
      tool: "search",
      args: { q: "shoes" },
      round: 0,
    });
    expect(session.toolCalls[1]).toEqual({
      tool: "recommend",
      args: { ids: ["1", "2"] },
      round: 1,
    });
  });

  it("emits CHAT_TURN event via GraphQL", async () => {
    const session = tes.session({
      sessionId: "sess-3",
      metadata: { shop_domain: "cool.myshopify.com" },
    });

    session.record({
      choices: [{ message: { content: "Here you go!" } }],
      usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
      model: "gpt-4o",
    });

    await session.emitChatTurn({
      userMessage: "find shoes",
      assistantResponse: "Here you go!",
    });

    expect(fetchCalls).toHaveLength(1);
    const call = fetchCalls[0];
    expect(call.url).toBe("https://api.test.com/api/graphql");

    const headers = call.opts.headers;
    expect(headers["Authorization"]).toBe("Bearer tes_sk_test");
    expect(headers["x-client-id"]).toBe("test-client");

    const body = JSON.parse(call.opts.body);
    expect(body.query).toContain("createModuleEvent");

    const input = body.variables.input;
    expect(input.eventType).toBe("CHAT_TURN");
    expect(body.variables.moduleId).toBe("conversation-analytics");
    expect(input.data.entity_id).toBe("sess-3");
    expect(input.data.attributes.user_message).toBe("find shoes");
    expect(input.data.attributes.model).toBe("gpt-4o");
    expect(input.data.attributes.usage.prompt_tokens).toBe(100);
    expect(input.data.attributes.usage.ai_rounds).toBe(1);
    expect(input.data.attributes.shop_domain).toBe("cool.myshopify.com");
  });

  it("emits TOOL_USE event", async () => {
    const session = tes.session({ sessionId: "sess-4" });

    await session.emitToolUse({
      tool: "search_products",
      args: { query: "red shoes" },
      resultSummary: { count: 12 },
      durationMs: 340,
      turnNumber: 1,
    });

    expect(fetchCalls).toHaveLength(1);
    const body = JSON.parse(fetchCalls[0].opts.body);
    const input = body.variables.input;
    expect(input.eventType).toBe("TOOL_USE");
    expect(input.data.attributes.tool).toBe("search_products");
    expect(input.data.attributes.duration_ms).toBe(340);
  });

  it("emits SESSION_START event", async () => {
    const session = tes.session({
      sessionId: "sess-5",
      metadata: { shop_domain: "test.myshopify.com" },
    });

    await session.emitSessionStart();

    expect(fetchCalls).toHaveLength(1);
    const body = JSON.parse(fetchCalls[0].opts.body);
    const input = body.variables.input;
    expect(input.eventType).toBe("SESSION_START");
    expect(input.data.attributes.metadata.shop_domain).toBe(
      "test.myshopify.com"
    );
  });

  it("auto-generates sessionId if not provided", () => {
    const session = tes.session();
    expect(session.sessionId).toBeDefined();
    expect(typeof session.sessionId).toBe("string");
    expect(session.sessionId.length).toBeGreaterThan(0);
  });

  it("metadata cannot overwrite reserved SDK fields", async () => {
    const session = tes.session({
      sessionId: "sess-override",
      metadata: { source: "attacker", user_message: "spoofed", model: "fake" },
    });

    session.record({
      choices: [{ message: { content: "hi" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      model: "gpt-4o",
    });

    await session.emitChatTurn({
      userMessage: "real message",
      assistantResponse: "real response",
    });

    const body = JSON.parse(fetchCalls[0].opts.body);
    const attrs = body.variables.input.data.attributes;
    expect(attrs.source).toBe("pentatonic-ai-sdk");
    expect(attrs.user_message).toBe("real message");
    expect(attrs.model).toBe("gpt-4o");
  });

  it("truncates long content to maxContentLength", async () => {
    const smallTes = new TESClient({
      clientId: "test-client",
      apiKey: "tes_sk_test",
      endpoint: "https://api.test.com",
      maxContentLength: 20,
    });

    const session = smallTes.session({ sessionId: "sess-trunc" });
    session.record({
      choices: [{ message: { content: "hi" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });

    await session.emitChatTurn({
      userMessage: "A".repeat(100),
      assistantResponse: "B".repeat(100),
    });

    const body = JSON.parse(fetchCalls[0].opts.body);
    const attrs = body.variables.input.data.attributes;
    expect(attrs.user_message.length).toBeLessThanOrEqual(35); // 20 + "...[truncated]"
    expect(attrs.user_message).toContain("...[truncated]");
    expect(attrs.assistant_response).toContain("...[truncated]");
  });

  it("omits content when captureContent is false", async () => {
    const noCaptTes = new TESClient({
      clientId: "test-client",
      apiKey: "tes_sk_test",
      endpoint: "https://api.test.com",
      captureContent: false,
    });

    const session = noCaptTes.session({ sessionId: "sess-nocap" });
    session.record({
      choices: [{ message: { content: "secret" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });

    await session.emitChatTurn({
      userMessage: "secret question",
      assistantResponse: "secret answer",
    });

    const body = JSON.parse(fetchCalls[0].opts.body);
    const attrs = body.variables.input.data.attributes;
    expect(attrs.user_message).toBeUndefined();
    expect(attrs.assistant_response).toBeUndefined();
    // Usage should still be present
    expect(attrs.usage.prompt_tokens).toBe(10);
  });

  it("sends internal service key as x-service-key header", async () => {
    const internalTes = new TESClient({
      clientId: "test-client",
      apiKey: "internal_service_key_abc",
      endpoint: "https://api.test.com",
    });

    const session = internalTes.session({ sessionId: "sess-internal" });
    session.record({
      choices: [{ message: { content: "hi" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });

    await session.emitChatTurn({
      userMessage: "hi",
      assistantResponse: "hello",
    });

    const headers = fetchCalls[0].opts.headers;
    expect(headers["x-service-key"]).toBe("internal_service_key_abc");
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("includes custom headers in requests", async () => {
    const customTes = new TESClient({
      clientId: "test-client",
      apiKey: "tes_sk_test",
      endpoint: "https://api.test.com",
      headers: { "X-Custom-Header": "custom-value" },
    });

    const session = customTes.session({ sessionId: "sess-headers" });
    session.record({
      choices: [{ message: { content: "hi" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });

    await session.emitChatTurn({
      userMessage: "hi",
      assistantResponse: "hello",
    });

    const headers = fetchCalls[0].opts.headers;
    expect(headers["X-Custom-Header"]).toBe("custom-value");
    expect(headers["Authorization"]).toBe("Bearer tes_sk_test");
    expect(headers["x-client-id"]).toBe("test-client");
  });

  it("includes full messages array when provided", async () => {
    const session = tes.session({ sessionId: "sess-msgs" });
    session.record({
      choices: [{ message: { content: "hi" } }],
      usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
      model: "gpt-4o",
    });

    const messages = [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "What is 2+2?" },
      { role: "assistant", content: "4" },
      { role: "user", content: "Thanks" },
    ];

    await session.emitChatTurn({
      userMessage: "Thanks",
      assistantResponse: "hi",
      messages,
    });

    const body = JSON.parse(fetchCalls[0].opts.body);
    const attrs = body.variables.input.data.attributes;
    expect(attrs.messages).toHaveLength(4);
    expect(attrs.messages[0].role).toBe("system");
    expect(attrs.messages[0].content).toBe("You are a helpful assistant.");
    expect(attrs.messages[1].role).toBe("user");
  });

  it("truncates message content in messages array", async () => {
    const smallTes = new TESClient({
      clientId: "test-client",
      apiKey: "tes_sk_test",
      endpoint: "https://api.test.com",
      maxContentLength: 20,
    });

    const session = smallTes.session({ sessionId: "sess-msgs-trunc" });
    session.record({
      choices: [{ message: { content: "hi" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });

    const messages = [
      { role: "system", content: "A".repeat(100) },
      { role: "user", content: "short" },
    ];

    await session.emitChatTurn({
      userMessage: "short",
      assistantResponse: "hi",
      messages,
    });

    const body = JSON.parse(fetchCalls[0].opts.body);
    const attrs = body.variables.input.data.attributes;
    expect(attrs.messages[0].content).toContain("...[truncated]");
    expect(attrs.messages[0].content.length).toBeLessThanOrEqual(35);
    expect(attrs.messages[1].content).toBe("short");
  });

  it("omits messages when captureContent is false", async () => {
    const noCaptTes = new TESClient({
      clientId: "test-client",
      apiKey: "tes_sk_test",
      endpoint: "https://api.test.com",
      captureContent: false,
    });

    const session = noCaptTes.session({ sessionId: "sess-msgs-nocap" });
    session.record({
      choices: [{ message: { content: "hi" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });

    await session.emitChatTurn({
      userMessage: "hi",
      assistantResponse: "hello",
      messages: [{ role: "system", content: "secret system prompt" }],
    });

    const body = JSON.parse(fetchCalls[0].opts.body);
    const attrs = body.variables.input.data.attributes;
    expect(attrs.messages).toBeUndefined();
  });

  it("resets state after emitChatTurn", async () => {
    const session = tes.session({ sessionId: "sess-6" });
    session.record({
      choices: [{ message: { content: "hi" } }],
      usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
    });

    await session.emitChatTurn({
      userMessage: "hi",
      assistantResponse: "hello",
    });

    expect(session.totalUsage.prompt_tokens).toBe(0);
    expect(session.totalUsage.ai_rounds).toBe(0);
    expect(session.toolCalls).toEqual([]);
  });

  it("includes system_prompt in emitted event when captured", async () => {
    const session = tes.session({ sessionId: "sess-sysprompt" });
    session._systemPrompt = "You are a helpful shopping assistant.";
    session.record({
      choices: [{ message: { content: "hi" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      model: "gpt-4o",
    });

    await session.emitChatTurn({
      userMessage: "hi",
      assistantResponse: "hello",
    });

    const body = JSON.parse(fetchCalls[0].opts.body);
    const attrs = body.variables.input.data.attributes;
    expect(attrs.system_prompt).toBe("You are a helpful shopping assistant.");
  });

  it("omits system_prompt when captureContent is false", async () => {
    const noCaptTes = new TESClient({
      clientId: "test-client",
      apiKey: "tes_sk_test",
      endpoint: "https://api.test.com",
      captureContent: false,
    });

    const session = noCaptTes.session({ sessionId: "sess-sysprompt-nocap" });
    session._systemPrompt = "secret system prompt";
    session.record({
      choices: [{ message: { content: "hi" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });

    await session.emitChatTurn({
      userMessage: "hi",
      assistantResponse: "hello",
    });

    const body = JSON.parse(fetchCalls[0].opts.body);
    const attrs = body.variables.input.data.attributes;
    expect(attrs.system_prompt).toBeUndefined();
  });
});

describe("Session.recordToolResult", () => {
  const tes = new TESClient({
    clientId: "test-client",
    apiKey: "tes_sk_test",
    endpoint: "https://api.test.com",
  });

  it("attaches result to the most recent matching tool call", () => {
    const session = tes.session({ sessionId: "sess-tr-1" });
    session.record({
      choices: [
        {
          message: {
            content: "",
            tool_calls: [
              { function: { name: "search", arguments: '{"q":"shoes"}' } },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
    });

    session.recordToolResult("search", { count: 5, items: ["shoe1", "shoe2"] });

    expect(session.toolCalls[0].result).toEqual({ count: 5, items: ["shoe1", "shoe2"] });
  });

  it("does not overwrite existing results", () => {
    const session = tes.session({ sessionId: "sess-tr-2" });
    session.record({
      choices: [
        {
          message: {
            content: "",
            tool_calls: [
              { function: { name: "search", arguments: '{"q":"a"}' } },
              { function: { name: "search", arguments: '{"q":"b"}' } },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
    });

    session.recordToolResult("search", { result: "first" });
    session.recordToolResult("search", { result: "second" });

    // recordToolResult scans from end, so first call matches toolCalls[1],
    // second call matches toolCalls[0] (the remaining unmatched one)
    expect(session.toolCalls[0].result).toEqual({ result: "second" });
    expect(session.toolCalls[1].result).toEqual({ result: "first" });
  });

  it("is a no-op when no matching tool call exists", () => {
    const session = tes.session({ sessionId: "sess-tr-3" });
    session.record({
      choices: [
        {
          message: {
            content: "",
            tool_calls: [
              { function: { name: "search", arguments: '{"q":"shoes"}' } },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
    });

    session.recordToolResult("nonexistent", { result: "data" });

    expect(session.toolCalls[0].result).toBeUndefined();
  });
});

describe("Session.trackUrl", () => {
  const tes = new TESClient({
    clientId: "test-client",
    apiKey: "tes_sk_test",
    endpoint: "https://api.test.com",
  });

  function decodePayload(url) {
    const match = url.match(/\/r\/([^?]+)/);
    let b64 = match[1].replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    return JSON.parse(atob(b64));
  }

  it("returns a tracked redirect URL containing the endpoint", async () => {
    const session = tes.session({ sessionId: "sess-track-1" });
    const result = await session.trackUrl("https://example.com");
    expect(result).toContain("https://api.test.com/r/");
    expect(result).toMatch(/\?sig=[A-Za-z0-9_-]+$/);
  });

  it("payload contains the session's sessionId and clientId", async () => {
    const session = tes.session({ sessionId: "sess-abc" });
    const result = await session.trackUrl("https://example.com");
    const payload = decodePayload(result);

    expect(payload.s).toBe("sess-abc");
    expect(payload.c).toBe("test-client");
    expect(payload.u).toBe("https://example.com");
    expect(typeof payload.t).toBe("number");
  });

  it("includes custom eventType and attributes in the payload", async () => {
    const session = tes.session({ sessionId: "sess-track-2" });
    const result = await session.trackUrl("https://example.com", {
      eventType: "PRODUCT_CLICK",
      attributes: { product_id: "prod-99" },
    });
    const payload = decodePayload(result);

    expect(payload.e).toBe("PRODUCT_CLICK");
    expect(payload.a).toEqual(expect.objectContaining({ product_id: "prod-99" }));
  });

  it("defaults eventType to LINK_CLICK", async () => {
    const session = tes.session({ sessionId: "sess-track-3" });
    const result = await session.trackUrl("https://example.com");
    const payload = decodePayload(result);

    expect(payload.e).toBe("LINK_CLICK");
  });

  it("includes session metadata in attributes", async () => {
    const session = tes.session({
      sessionId: "sess-track-4",
      metadata: { source: "chat", user_tier: "premium" },
    });
    const result = await session.trackUrl("https://example.com");
    const payload = decodePayload(result);

    expect(payload.a).toEqual(expect.objectContaining({ source: "chat", user_tier: "premium" }));
  });

  it("merges session metadata with call-time attributes", async () => {
    const session = tes.session({
      sessionId: "sess-track-5",
      metadata: { source: "chat" },
    });
    const result = await session.trackUrl("https://example.com", {
      attributes: { product_id: "prod-1" },
    });
    const payload = decodePayload(result);

    expect(payload.a).toEqual(expect.objectContaining({ source: "chat", product_id: "prod-1" }));
  });
});
