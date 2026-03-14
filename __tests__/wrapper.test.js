import { TESClient } from "../src/index.js";

let fetchCalls = [];
globalThis.fetch = async (url, opts) => {
  fetchCalls.push({ url, opts });
  return {
    ok: true,
    json: async () => ({
      data: { emitEvent: { success: true, eventId: "evt-456" } },
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
        create: async () => responses[callIndex++] || responses[responses.length - 1],
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
      create: async () => responses[callIndex++] || responses[responses.length - 1],
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

  it("includes full messages array in emitted event", async () => {
    const openai = createMockOpenAI([
      {
        choices: [{ message: { content: "Hello!" } }],
        usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
        model: "gpt-4o",
      },
    ]);

    const ai = tes.wrap(openai);
    await ai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "hi" },
      ],
    });

    await new Promise((r) => setTimeout(r, 10));

    expect(fetchCalls).toHaveLength(1);
    const body = JSON.parse(fetchCalls[0].opts.body);
    const attrs = body.variables.input.data.attributes;
    expect(attrs.messages).toHaveLength(2);
    expect(attrs.messages[0]).toEqual({ role: "system", content: "You are helpful." });
    expect(attrs.messages[1]).toEqual({ role: "user", content: "hi" });
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

  it("emits one event per call (2 calls → 2 events)", async () => {
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
    await ai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "find shoes" }],
    });
    await ai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "find shoes" }, { role: "tool", content: "[...]" }],
    });

    await new Promise((r) => setTimeout(r, 10));

    expect(fetchCalls).toHaveLength(2);

    // First event: has tool call, 100 prompt tokens
    const attrs1 = JSON.parse(fetchCalls[0].opts.body).variables.input.data.attributes;
    expect(attrs1.usage.prompt_tokens).toBe(100);
    expect(attrs1.usage.ai_rounds).toBe(1);
    expect(attrs1.tool_calls).toHaveLength(1);

    // Second event: no tool call, 200 prompt tokens
    const attrs2 = JSON.parse(fetchCalls[1].opts.body).variables.input.data.attributes;
    expect(attrs2.usage.prompt_tokens).toBe(200);
    expect(attrs2.usage.ai_rounds).toBe(1);

    // Both share same session ID
    const sid1 = JSON.parse(fetchCalls[0].opts.body).variables.input.data.entity_id;
    const sid2 = JSON.parse(fetchCalls[1].opts.body).variables.input.data.entity_id;
    expect(sid1).toBe("multi-turn");
    expect(sid2).toBe("multi-turn");
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
    const attrs = JSON.parse(fetchCalls[0].opts.body).variables.input.data.attributes;
    expect(attrs.model).toBe("claude-sonnet-4-6-20250514");
    expect(attrs.usage.prompt_tokens).toBe(80);
    expect(attrs.usage.completion_tokens).toBe(25);
    expect(attrs.user_message).toBe("Say hello in French");
    expect(attrs.assistant_response).toBe("Bonjour!");
  });

  it("handles tool_use blocks in single event", async () => {
    const anthropic = createMockAnthropic([
      {
        content: [
          { type: "text", text: "Let me search." },
          { type: "tool_use", id: "tu_1", name: "search", input: { query: "shoes" } },
        ],
        usage: { input_tokens: 100, output_tokens: 40 },
        model: "claude-sonnet-4-6-20250514",
      },
    ]);

    const ai = tes.wrap(anthropic);
    await ai.messages.create({
      model: "claude-sonnet-4-6-20250514",
      messages: [{ role: "user", content: "find shoes" }],
      max_tokens: 200,
    });

    await new Promise((r) => setTimeout(r, 10));

    expect(fetchCalls).toHaveLength(1);
    const attrs = JSON.parse(fetchCalls[0].opts.body).variables.input.data.attributes;
    expect(attrs.tool_calls).toHaveLength(1);
    expect(attrs.tool_calls[0].tool).toBe("search");
    expect(attrs.usage.ai_rounds).toBe(1);
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
    const attrs = JSON.parse(fetchCalls[0].opts.body).variables.input.data.attributes;
    expect(attrs.model).toBe("@cf/meta/llama-3.1-8b-instruct");
    expect(attrs.usage.prompt_tokens).toBe(30);
    expect(attrs.user_message).toBe("What is 2+2?");
    expect(attrs.assistant_response).toBe("4");
  });

  it("emits one event per run() call", async () => {
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

    const wrapped = tes.wrap(ai, { sessionId: "wai-multi" });
    await wrapped.run("@cf/meta/llama-3.1-8b-instruct", {
      messages: [{ role: "user", content: "find item 123" }],
    });
    await wrapped.run("@cf/meta/llama-3.1-8b-instruct", {
      messages: [{ role: "user", content: "find item 123" }, { role: "tool", content: "{}" }],
    });

    await new Promise((r) => setTimeout(r, 10));

    expect(fetchCalls).toHaveLength(2);

    const attrs1 = JSON.parse(fetchCalls[0].opts.body).variables.input.data.attributes;
    expect(attrs1.usage.prompt_tokens).toBe(50);
    expect(attrs1.tool_calls).toHaveLength(1);
    expect(attrs1.tool_calls[0].tool).toBe("lookup");

    const attrs2 = JSON.parse(fetchCalls[1].opts.body).variables.input.data.attributes;
    expect(attrs2.usage.prompt_tokens).toBe(80);
  });

  it("exposes sessionId property", () => {
    const ai = createMockWorkersAI([]);
    const wrapped = tes.wrap(ai, { sessionId: "wai-sess" });
    expect(wrapped.sessionId).toBe("wai-sess");
  });
});

// --- Error cases ---

describe("tes.wrap() — unsupported client", () => {
  it("throws for unknown client shape", () => {
    expect(() => tes.wrap({})).toThrow("Unsupported client");
    expect(() => tes.wrap({ foo: "bar" })).toThrow("Unsupported client");
  });
});
