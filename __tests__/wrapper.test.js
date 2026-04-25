import { TESClient } from "../src/index.js";

let fetchCalls = [];
globalThis.fetch = async (url, opts) => {
  const body = opts?.body ? JSON.parse(opts.body) : null;

  // Memory-search calls (default-on injection in wrapClient) return an
  // empty result so injection is a no-op and the existing emit-focused
  // tests can keep asserting against the emit call only. Memory
  // injection has its own dedicated tests further down.
  if (body?.query?.includes("semanticSearchMemories")) {
    return {
      ok: true,
      json: async () => ({ data: { semanticSearchMemories: [] } }),
    };
  }

  fetchCalls.push({ url, opts });
  return {
    ok: true,
    json: async () => ({
      data: { createModuleEvent: { success: true, eventId: "evt-456" } },
    }),
  };
};

beforeEach(() => {
  fetchCalls = [];
});

const tes = new TESClient({
  clientId: "test-client",
  apiKey: "tes_sk_test",
  endpoint: "https://api.test.com",
});

// --- Mock clients ---

function createMockOpenAI(responses) {
  let callIndex = 0;
  return {
    chat: {
      completions: {
        create: async () =>
          responses[callIndex++] || responses[responses.length - 1],
      },
    },
    models: {
      list: async () => ({ data: [{ id: "gpt-4o" }] }),
    },
  };
}

function createMockAnthropic(responses) {
  let callIndex = 0;
  return {
    messages: {
      create: async () =>
        responses[callIndex++] || responses[responses.length - 1],
    },
    models: {
      list: async () => ({ data: [{ id: "claude-sonnet-4-6-20250514" }] }),
    },
  };
}

function createMockWorkersAI(responses) {
  let callIndex = 0;
  return {
    run: async () => responses[callIndex++] || responses[responses.length - 1],
  };
}

// --- OpenAI ---

describe("tes.wrap() — OpenAI", () => {
  it("proxies non-chat methods through untouched", async () => {
    const openai = createMockOpenAI([]);
    const ai = tes.wrap(openai);
    const models = await ai.models.list();
    expect(models.data[0].id).toBe("gpt-4o");
  });

  it("intercepts chat.completions.create and emits CHAT_TURN", async () => {
    const openai = createMockOpenAI([
      {
        choices: [{ message: { content: "Hello!" } }],
        usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
        model: "gpt-4o",
      },
    ]);

    const ai = tes.wrap(openai);
    const result = await ai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result.choices[0].message.content).toBe("Hello!");
    await new Promise((r) => setTimeout(r, 10));

    expect(fetchCalls).toHaveLength(1);
    const body = JSON.parse(fetchCalls[0].opts.body);
    const input = body.variables.input;
    expect(input.eventType).toBe("CHAT_TURN");
    expect(input.data.attributes.model).toBe("gpt-4o");
    expect(input.data.attributes.usage.prompt_tokens).toBe(50);
    expect(input.data.attributes.usage.ai_rounds).toBe(1);
  });

  it("exposes auto-generated sessionId", () => {
    const openai = createMockOpenAI([]);
    const ai = tes.wrap(openai);
    expect(ai.sessionId).toBeDefined();
    expect(typeof ai.sessionId).toBe("string");
    expect(ai.sessionId.length).toBeGreaterThan(0);
  });

  it("uses custom sessionId when provided", () => {
    const openai = createMockOpenAI([]);
    const ai = tes.wrap(openai, { sessionId: "my-session-123" });
    expect(ai.sessionId).toBe("my-session-123");
  });

  it("includes metadata in emitted events", async () => {
    const openai = createMockOpenAI([
      {
        choices: [{ message: { content: "Hello!" } }],
        usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
        model: "gpt-4o",
      },
    ]);

    const ai = tes.wrap(openai, { metadata: { shop_domain: "test.myshopify.com" } });
    await ai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
    });

    await new Promise((r) => setTimeout(r, 10));

    const attrs = JSON.parse(fetchCalls[0].opts.body).variables.input.data.attributes;
    expect(attrs.shop_domain).toBe("test.myshopify.com");
  });

  it("supports multi-round sessions via session.chat()", async () => {
    const openai = createMockOpenAI([
      {
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
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
        model: "gpt-4o",
      },
      {
        choices: [{ message: { content: "Found shoes!" } }],
        usage: { prompt_tokens: 200, completion_tokens: 40, total_tokens: 240 },
        model: "gpt-4o",
      },
    ]);

    const ai = tes.wrap(openai);
    const session = ai.session({ sessionId: "multi-turn" });

    await session.chat({
      model: "gpt-4o",
      messages: [{ role: "user", content: "find shoes" }],
    });
    await session.chat({
      model: "gpt-4o",
      messages: [
        { role: "user", content: "find shoes" },
        { role: "tool", content: "[...]" },
      ],
    });

    await session.emitChatTurn({
      userMessage: "find shoes",
      assistantResponse: "Found shoes!",
    });

    expect(fetchCalls).toHaveLength(1);
    const attrs = JSON.parse(fetchCalls[0].opts.body).variables.input.data
      .attributes;
    expect(attrs.usage.prompt_tokens).toBe(300);
    expect(attrs.usage.ai_rounds).toBe(2);
    expect(attrs.tool_calls).toHaveLength(1);
  });

  it("accumulates tool calls and emits only on final text response", async () => {
    const openai = createMockOpenAI([
      {
        choices: [{ message: { content: "", tool_calls: [{ function: { name: "search", arguments: '{"q":"shoes"}' } }] } }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
        model: "gpt-4o",
      },
      {
        choices: [{ message: { content: "Found shoes!" } }],
        usage: { prompt_tokens: 200, completion_tokens: 40, total_tokens: 240 },
        model: "gpt-4o",
      },
    ]);

    const ai = tes.wrap(openai, { sessionId: "multi-turn" });

    // First call: tool call only, no content — should NOT emit
    await ai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "find shoes" }],
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchCalls).toHaveLength(0);

    // Second call: final text response — should emit with accumulated data
    await ai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "find shoes" }, { role: "tool", content: "[...]" }],
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchCalls).toHaveLength(1);

    const attrs = JSON.parse(fetchCalls[0].opts.body).variables.input.data.attributes;
    expect(attrs.usage.prompt_tokens).toBe(300);
    expect(attrs.usage.ai_rounds).toBe(2);
    expect(attrs.tool_calls).toHaveLength(1);
  });
});

// --- Anthropic ---

describe("tes.wrap() — Anthropic", () => {
  it("proxies non-messages methods through untouched", async () => {
    const anthropic = createMockAnthropic([]);
    const ai = tes.wrap(anthropic);
    const models = await ai.models.list();
    expect(models.data[0].id).toBe("claude-sonnet-4-6-20250514");
  });

  it("intercepts messages.create and emits CHAT_TURN", async () => {
    const anthropic = createMockAnthropic([
      {
        content: [{ type: "text", text: "Bonjour!" }],
        usage: { input_tokens: 80, output_tokens: 25 },
        model: "claude-sonnet-4-6-20250514",
      },
    ]);

    const ai = tes.wrap(anthropic);
    const result = await ai.messages.create({
      model: "claude-sonnet-4-6-20250514",
      messages: [{ role: "user", content: "Say hello in French" }],
      max_tokens: 100,
    });

    expect(result.content[0].text).toBe("Bonjour!");
    await new Promise((r) => setTimeout(r, 10));

    expect(fetchCalls).toHaveLength(1);
    const body = JSON.parse(fetchCalls[0].opts.body);
    const attrs = body.variables.input.data.attributes;
    expect(attrs.model).toBe("claude-sonnet-4-6-20250514");
    expect(attrs.usage.prompt_tokens).toBe(80);
    expect(attrs.usage.completion_tokens).toBe(25);
    expect(attrs.user_message).toBe("Say hello in French");
    expect(attrs.assistant_response).toBe("Bonjour!");
  });

  it("handles tool_use blocks via session.chat()", async () => {
    const anthropic = createMockAnthropic([
      {
        content: [
          { type: "text", text: "Let me search." },
          {
            type: "tool_use",
            id: "tu_1",
            name: "search",
            input: { query: "shoes" },
          },
        ],
        usage: { input_tokens: 100, output_tokens: 40 },
        model: "claude-sonnet-4-6-20250514",
      },
      {
        content: [{ type: "text", text: "Found red shoes!" }],
        usage: { input_tokens: 200, output_tokens: 30 },
        model: "claude-sonnet-4-6-20250514",
      },
    ]);

    const ai = tes.wrap(anthropic);
    const session = ai.session({ sessionId: "anth-multi" });

    const r1 = await session.chat({
      model: "claude-sonnet-4-6-20250514",
      messages: [{ role: "user", content: "find shoes" }],
      max_tokens: 200,
    });
    expect(r1.content[1].name).toBe("search");

    await session.chat({
      model: "claude-sonnet-4-6-20250514",
      messages: [
        { role: "user", content: "find shoes" },
        { role: "assistant", content: r1.content },
      ],
      max_tokens: 200,
    });

    await session.emitChatTurn({
      userMessage: "find shoes",
      assistantResponse: "Found red shoes!",
    });

    const attrs = JSON.parse(fetchCalls[0].opts.body).variables.input.data
      .attributes;
    expect(attrs.usage.prompt_tokens).toBe(300);
    expect(attrs.usage.ai_rounds).toBe(2);
    expect(attrs.tool_calls).toHaveLength(1);
    expect(attrs.tool_calls[0].tool).toBe("search");
  });

  it("exposes sessionId property", () => {
    const anthropic = createMockAnthropic([]);
    const ai = tes.wrap(anthropic, { sessionId: "anth-sess" });
    expect(ai.sessionId).toBe("anth-sess");
  });
});

// --- Workers AI ---

describe("tes.wrap() — Workers AI", () => {
  it("intercepts run() and emits CHAT_TURN", async () => {
    const ai = createMockWorkersAI([
      {
        response: "4",
        usage: { prompt_tokens: 30, completion_tokens: 5 },
      },
    ]);

    const wrapped = tes.wrap(ai);
    const result = await wrapped.run("@cf/meta/llama-3.1-8b-instruct", {
      messages: [{ role: "user", content: "What is 2+2?" }],
    });

    expect(result.response).toBe("4");
    await new Promise((r) => setTimeout(r, 10));

    expect(fetchCalls).toHaveLength(1);
    const attrs = JSON.parse(fetchCalls[0].opts.body).variables.input.data
      .attributes;
    expect(attrs.model).toBe("@cf/meta/llama-3.1-8b-instruct");
    expect(attrs.usage.prompt_tokens).toBe(30);
    expect(attrs.user_message).toBe("What is 2+2?");
    expect(attrs.assistant_response).toBe("4");
  });

  it("supports multi-round sessions via session.chat()", async () => {
    const ai = createMockWorkersAI([
      {
        response: "",
        tool_calls: [{ name: "lookup", arguments: { id: "123" } }],
        usage: { prompt_tokens: 50, completion_tokens: 10 },
      },
      {
        response: "Found it!",
        usage: { prompt_tokens: 80, completion_tokens: 15 },
      },
    ]);

    const wrapped = tes.wrap(ai);
    const session = wrapped.session({ sessionId: "wai-multi" });

    await session.chat("@cf/meta/llama-3.1-8b-instruct", {
      messages: [{ role: "user", content: "find item 123" }],
    });

    await session.chat("@cf/meta/llama-3.1-8b-instruct", {
      messages: [
        { role: "user", content: "find item 123" },
        { role: "tool", content: "{}" },
      ],
    });

    await session.emitChatTurn({
      userMessage: "find item 123",
      assistantResponse: "Found it!",
    });

    const attrs = JSON.parse(fetchCalls[0].opts.body).variables.input.data
      .attributes;
    expect(attrs.usage.prompt_tokens).toBe(130);
    expect(attrs.usage.ai_rounds).toBe(2);
    expect(attrs.tool_calls).toHaveLength(1);
    expect(attrs.tool_calls[0].tool).toBe("lookup");
  });

  it("exposes sessionId property", () => {
    const ai = createMockWorkersAI([]);
    const wrapped = tes.wrap(ai, { sessionId: "wai-sess" });
    expect(wrapped.sessionId).toBe("wai-sess");
  });
});

// --- Session options ---

describe("tes.wrap() — session options", () => {
  it("uses provided sessionId for all emitted events", async () => {
    const ai = createMockWorkersAI([
      {
        response: "hi",
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      },
      {
        response: "bye",
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      },
    ]);

    const wrapped = tes.wrap(ai, { sessionId: "my-session-42" });
    await wrapped.run("@cf/meta/llama-3.1-8b-instruct", {
      messages: [{ role: "user", content: "hi" }],
    });
    await wrapped.run("@cf/meta/llama-3.1-8b-instruct", {
      messages: [{ role: "user", content: "bye" }],
    });

    await new Promise((r) => setTimeout(r, 10));

    // With session accumulation, both calls go through the same session.
    // The first call emits (has text content), session resets, second also emits.
    expect(fetchCalls).toHaveLength(2);
    const id1 = JSON.parse(fetchCalls[0].opts.body).variables.input.data
      .entity_id;
    const id2 = JSON.parse(fetchCalls[1].opts.body).variables.input.data
      .entity_id;
    expect(id1).toBe("my-session-42");
    expect(id2).toBe("my-session-42");
  });

  it("exposes sessionId property on wrapped client", () => {
    const ai = createMockWorkersAI([]);
    const wrapped = tes.wrap(ai, { sessionId: "exposed-id" });
    expect(wrapped.sessionId).toBe("exposed-id");
  });

  it("exposes tesSession property on wrapped client", () => {
    const ai = createMockWorkersAI([]);
    const wrapped = tes.wrap(ai, { sessionId: "sess-test" });
    expect(wrapped.tesSession).toBeDefined();
    expect(wrapped.tesSession.sessionId).toBe("sess-test");
  });

  it("auto-generates sessionId when not provided", () => {
    const ai = createMockWorkersAI([]);
    const wrapped = tes.wrap(ai);
    expect(wrapped.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });

  it("includes metadata in emitted events", async () => {
    const ai = createMockWorkersAI([
      {
        response: "hi",
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      },
    ]);

    const wrapped = tes.wrap(ai, {
      sessionId: "meta-test",
      metadata: { shop_domain: "test.myshopify.com" },
    });
    await wrapped.run("@cf/meta/llama-3.1-8b-instruct", {
      messages: [{ role: "user", content: "hi" }],
    });

    await new Promise((r) => setTimeout(r, 10));

    const attrs = JSON.parse(fetchCalls[0].opts.body).variables.input.data
      .attributes;
    expect(attrs.shop_domain).toBe("test.myshopify.com");
  });

  it("respects autoEmit = false (no automatic emission)", async () => {
    const openai = createMockOpenAI([
      {
        choices: [{ message: { content: "Hello!" } }],
        usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
        model: "gpt-4o",
      },
    ]);

    const ai = tes.wrap(openai, { sessionId: "no-emit", autoEmit: false });
    await ai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
    });

    await new Promise((r) => setTimeout(r, 10));

    // autoEmit=false means no automatic emission, but session still tracks
    expect(fetchCalls).toHaveLength(0);
    expect(ai.tesSession.totalUsage.prompt_tokens).toBe(50);
  });
});

// --- URL rewriting ---

describe("tes.wrap() — URL rewriting", () => {
  it("rewrites URLs in OpenAI response content", async () => {
    const openai = createMockOpenAI([
      {
        choices: [
          {
            message: {
              content:
                "Check out https://store.com/shoes for great deals!",
            },
          },
        ],
        usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
        model: "gpt-4o",
      },
    ]);

    const ai = tes.wrap(openai, { sessionId: "url-test-openai" });
    const result = await ai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "recommend shoes" }],
    });

    expect(result.choices[0].message.content).not.toContain(
      "https://store.com/shoes"
    );
    expect(result.choices[0].message.content).toContain(
      "https://api.test.com/r/"
    );
  });

  it("rewrites URLs in Anthropic response content", async () => {
    const anthropic = createMockAnthropic([
      {
        content: [
          { type: "text", text: "Visit https://store.com/shoes today!" },
        ],
        usage: { input_tokens: 80, output_tokens: 25 },
        model: "claude-sonnet-4-6-20250514",
      },
    ]);

    const ai = tes.wrap(anthropic, { sessionId: "url-test-anthropic" });
    const result = await ai.messages.create({
      model: "claude-sonnet-4-6-20250514",
      messages: [{ role: "user", content: "recommend shoes" }],
      max_tokens: 100,
    });

    expect(result.content[0].text).not.toContain("https://store.com/shoes");
    expect(result.content[0].text).toContain("https://api.test.com/r/");
  });

  it("rewrites URLs in Workers AI response", async () => {
    const ai = createMockWorkersAI([
      {
        response: "Try https://store.com/shoes for options.",
        usage: { prompt_tokens: 30, completion_tokens: 10 },
      },
    ]);

    const wrapped = tes.wrap(ai, { sessionId: "url-test-workers" });
    const result = await wrapped.run("@cf/meta/llama-3.1-8b-instruct", {
      messages: [{ role: "user", content: "recommend shoes" }],
    });

    expect(result.response).not.toContain("https://store.com/shoes");
    expect(result.response).toContain("https://api.test.com/r/");
  });

  it("does not rewrite responses with no URLs", async () => {
    const openai = createMockOpenAI([
      {
        choices: [
          { message: { content: "I recommend checking a local store." } },
        ],
        usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
        model: "gpt-4o",
      },
    ]);

    const ai = tes.wrap(openai, { sessionId: "url-test-no-urls" });
    const result = await ai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "recommend shoes" }],
    });

    expect(result.choices[0].message.content).toBe(
      "I recommend checking a local store."
    );
  });
});

// --- Integration: SDK -> TES roundtrip ---

describe("tes.wrap() — SDK-to-TES roundtrip", () => {
  it("produces URLs that can be verified by the redirect endpoint", async () => {
    const { verifyPayload } = await import("../src/tracking.js");

    const ai = createMockWorkersAI([
      {
        response: "See https://store.com/shoes",
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      },
    ]);

    const wrapped = tes.wrap(ai);
    const result = await wrapped.run("@cf/meta/llama-3.1-8b-instruct", {
      messages: [{ role: "user", content: "shoes" }],
    });

    // Extract the redirect URL from the rewritten response
    const match = result.response.match(
      /https:\/\/api\.test\.com\/r\/([^?]+)\?sig=(.+)/
    );
    expect(match).not.toBeNull();

    const [, encoded, sig] = match;
    // Decode the payload
    const json = atob(encoded.replace(/-/g, "+").replace(/_/g, "/"));
    const payload = JSON.parse(json);

    // Verify using the same key the TESClient was configured with
    const valid = await verifyPayload("tes_sk_test", payload, sig);
    expect(valid).toBe(true);

    // Check payload fields
    expect(payload.u).toBe("https://store.com/shoes");
    expect(payload.e).toBe("LINK_CLICK");
    expect(payload.c).toBe("test-client");
  });
});

// --- Error cases ---

describe("tes.wrap() — unsupported client", () => {
  it("throws for unknown client shape", () => {
    expect(() => tes.wrap({})).toThrow("Unsupported client");
    expect(() => tes.wrap({ foo: "bar" })).toThrow("Unsupported client");
  });
});

// --- Memory injection (default-on) ---

describe("tes.wrap() — memory injection", () => {
  // Use a custom fetch stub for these tests so we can control the
  // semanticSearchMemories response per-test.
  let memoriesToReturn;
  let originalFetch;
  let memoryFetchCalls;

  beforeEach(() => {
    memoriesToReturn = [];
    memoryFetchCalls = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      const body = opts?.body ? JSON.parse(opts.body) : null;
      if (body?.query?.includes("semanticSearchMemories")) {
        memoryFetchCalls.push({ url, opts });
        return {
          ok: true,
          json: async () => ({
            data: { semanticSearchMemories: memoriesToReturn },
          }),
        };
      }
      // Emit calls — succeed silently
      return {
        ok: true,
        json: async () => ({
          data: { createModuleEvent: { success: true, eventId: "evt" } },
        }),
      };
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("OpenAI: prepends a system message with retrieved memories (default on)", async () => {
    memoriesToReturn = [
      { id: "m1", content: "User is in Lisbon.", similarity: 0.83 },
      { id: "m2", content: "Prefers Portuguese.", similarity: 0.74 },
    ];

    let seenParams;
    const openai = {
      chat: {
        completions: {
          create: async (params) => {
            seenParams = params;
            return {
              choices: [{ message: { content: "ok" } }],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
              model: "gpt-4o",
            };
          },
        },
      },
    };

    const ai = tes.wrap(openai);
    await ai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Where am I?" }],
    });

    expect(memoryFetchCalls).toHaveLength(1);
    expect(seenParams.messages[0].role).toBe("system");
    expect(seenParams.messages[0].content).toMatch(/Lisbon/);
    expect(seenParams.messages[0].content).toMatch(/Portuguese/);
    expect(ai.tesSession._lastMemoryStats.injected).toBe(2);
  });

  it("Anthropic: appends to system block with retrieved memories", async () => {
    memoriesToReturn = [
      { id: "m1", content: "User is in Lisbon.", similarity: 0.83 },
    ];

    let seenParams;
    const anthropic = {
      messages: {
        create: async (params) => {
          seenParams = params;
          return {
            content: [{ type: "text", text: "ok" }],
            usage: { input_tokens: 1, output_tokens: 1 },
            model: "claude-sonnet-4-6",
          };
        },
      },
    };

    const ai = tes.wrap(anthropic);
    await ai.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 64,
      system: "You are helpful.",
      messages: [{ role: "user", content: "Where am I?" }],
    });

    const sys =
      typeof seenParams.system === "string"
        ? seenParams.system
        : seenParams.system.map((b) => b.text).join("\n");
    expect(sys).toMatch(/Lisbon/);
    expect(sys).toMatch(/You are helpful/);
  });

  it("memory:false skips injection entirely (no semanticSearchMemories call)", async () => {
    memoriesToReturn = [{ id: "m1", content: "x", similarity: 0.9 }];

    let seenParams;
    const openai = {
      chat: {
        completions: {
          create: async (params) => {
            seenParams = params;
            return {
              choices: [{ message: { content: "ok" } }],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
              model: "gpt-4o",
            };
          },
        },
      },
    };

    const ai = tes.wrap(openai, { memory: false });
    await ai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(memoryFetchCalls).toHaveLength(0);
    // Customer's params reach upstream untouched
    expect(seenParams.messages).toHaveLength(1);
    expect(seenParams.messages[0].role).toBe("user");
    expect(ai.tesSession._lastMemoryStats.skipped).toBe("memory_disabled");
  });

  it("no memories returned → call proceeds with original params", async () => {
    memoriesToReturn = [];

    let seenParams;
    const openai = {
      chat: {
        completions: {
          create: async (params) => {
            seenParams = params;
            return {
              choices: [{ message: { content: "ok" } }],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
              model: "gpt-4o",
            };
          },
        },
      },
    };

    const ai = tes.wrap(openai);
    await ai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(seenParams.messages).toHaveLength(1);
    expect(seenParams.messages[0].role).toBe("user");
    expect(ai.tesSession._lastMemoryStats.skipped).toBe("no_memories");
  });

  it("memoryOpts forwards limit/minScore/timeoutMs to hostedSearch", async () => {
    memoriesToReturn = [];

    const openai = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: "ok" } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
            model: "gpt-4o",
          }),
        },
      },
    };

    const ai = tes.wrap(openai, {
      memoryOpts: { limit: 3, minScore: 0.7 },
    });
    await ai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(memoryFetchCalls).toHaveLength(1);
    const sent = JSON.parse(memoryFetchCalls[0].opts.body);
    expect(sent.variables.limit).toBe(3);
    expect(sent.variables.minScore).toBe(0.7);
  });

  it("Workers AI prompt-style: skips injection (no messages array)", async () => {
    memoriesToReturn = [{ id: "m1", content: "x", similarity: 0.9 }];

    let seenParams;
    const workersAi = {
      run: async (model, params) => {
        seenParams = params;
        return { response: "ok" };
      },
    };

    const ai = tes.wrap(workersAi);
    await ai.run("@cf/meta/llama-3.1-8b-instruct", {
      prompt: "hello world",
    });

    // Memory search was NOT called — prompt-style requests don't get
    // injection (no clean place to put a system preamble).
    expect(memoryFetchCalls).toHaveLength(0);
    expect(seenParams.prompt).toBe("hello world");
    expect(ai.tesSession._lastMemoryStats.skipped).toBe("no_user_message");
  });
});
