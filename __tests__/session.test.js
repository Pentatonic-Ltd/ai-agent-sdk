import { TESClient } from "../src/index.js";

// Mock fetch globally
let fetchCalls = [];
globalThis.fetch = async (url, opts) => {
  fetchCalls.push({ url, opts });
  return {
    ok: true,
    json: async () => ({
      data: {
        emitEvent: { success: true, eventId: "evt-123" },
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
    expect(headers["x-service-key"]).toBe("tes_sk_test");
    expect(headers["x-client-id"]).toBe("test-client");

    const body = JSON.parse(call.opts.body);
    expect(body.query).toContain("emitEvent");

    const input = body.variables.input;
    expect(input.eventType).toBe("CHAT_TURN");
    expect(input.entityType).toBe("conversation");
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
    expect(headers["x-service-key"]).toBe("tes_sk_test");
    expect(headers["x-client-id"]).toBe("test-client");
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
});
