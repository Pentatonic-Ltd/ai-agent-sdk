/**
 * Tests for CHAT_TURN emission + envelope handling on the PUBLISHED
 * OpenClaw plugin (`packages/memory/openclaw-plugin/`). This is the
 * file OpenClaw actually installs via `openclaw plugins install
 * @pentatonic-ai/openclaw-memory-plugin`, so these tests cover the
 * runtime path the dashboard depends on.
 */

import plugin, { _resetTurnBuffersForTest } from "../index.js";

const realFetch = globalThis.fetch;

function captureFetch() {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url, body });
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: { createModuleEvent: { success: true, eventId: "e" } } }),
    };
  };
  return calls;
}

// Build a hosted engine via the plugin's register hook. The published
// plugin reads config from api.pluginConfig (newer OpenClaw) or
// api.config.plugins.entries[...].config (older), whichever is set.
function makeEngine(extraConfig = {}) {
  let factory;
  plugin.register({
    pluginConfig: {
      tes_endpoint: "https://x.test",
      tes_client_id: "c",
      tes_api_key: "tes_c_xyz",
      ...extraConfig,
    },
    registerTool: () => {},
    registerContextEngine: (_name, fn) => {
      factory = fn;
    },
  });
  if (!factory) throw new Error("plugin did not register a context engine");
  return factory();
}

afterEach(() => {
  globalThis.fetch = realFetch;
  _resetTurnBuffersForTest();
});

describe("openclaw-memory-plugin — hosted CHAT_TURN via afterTurn", () => {
  it("emits CHAT_TURN when afterTurn is called with user+assistant messages", async () => {
    const calls = captureFetch();
    const engine = makeEngine();

    await engine.afterTurn({
      sessionId: "sess-1",
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "hello",
          model: "claude-3-5",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      ],
      prePromptMessageCount: 0,
    });

    const turn = calls.find(
      (c) =>
        c.body?.variables?.moduleId === "conversation-analytics" &&
        c.body?.variables?.input?.eventType === "CHAT_TURN"
    );
    expect(turn).toBeDefined();
    const attrs = turn.body.variables.input.data.attributes;
    expect(attrs.user_message).toBe("hi");
    expect(attrs.assistant_response).toBe("hello");
    expect(attrs.model).toBe("claude-3-5");
    expect(attrs.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
    expect(attrs.turn_number).toBe(1);
    expect(attrs.source).toBe("openclaw-plugin");
  });

  it("also emits STORE_MEMORY for retrieval (both events fire)", async () => {
    const calls = captureFetch();
    const engine = makeEngine();

    await engine.afterTurn({
      sessionId: "sess-2",
      messages: [
        { role: "user", content: "question" },
        { role: "assistant", content: "answer" },
      ],
      prePromptMessageCount: 0,
    });

    const storeMemory = calls.filter(
      (c) => c.body?.variables?.moduleId === "deep-memory"
    );
    const chatTurn = calls.filter(
      (c) => c.body?.variables?.moduleId === "conversation-analytics"
    );
    expect(storeMemory.length).toBeGreaterThan(0);
    expect(chatTurn.length).toBe(1);
  });

  it("handles content-block arrays (Anthropic-style) correctly", async () => {
    const calls = captureFetch();
    const engine = makeEngine();

    await engine.afterTurn({
      sessionId: "sess-blocks",
      messages: [
        { role: "user", content: [{ type: "text", text: "what do i like?" }] },
        { role: "assistant", content: [{ type: "text", text: "coffee" }] },
      ],
      prePromptMessageCount: 0,
    });

    const attrs = calls.find(
      (c) => c.body?.variables?.moduleId === "conversation-analytics"
    ).body.variables.input.data.attributes;
    expect(attrs.user_message).toBe("what do i like?");
    expect(attrs.assistant_response).toBe("coffee");
  });

  it("extracts tool_calls from wrapped Anthropic raw response", async () => {
    const calls = captureFetch();
    const engine = makeEngine();

    await engine.afterTurn({
      sessionId: "sess-tools",
      messages: [
        { role: "user", content: "search" },
        {
          role: "assistant",
          content: "looking",
          raw: {
            content: [
              { type: "text", text: "looking" },
              { type: "tool_use", name: "search", input: { q: "cheese" } },
            ],
          },
        },
      ],
      prePromptMessageCount: 0,
    });

    const attrs = calls.find(
      (c) => c.body?.variables?.moduleId === "conversation-analytics"
    ).body.variables.input.data.attributes;
    expect(attrs.tool_calls).toEqual([
      { tool: "search", args: { q: "cheese" } },
    ]);
  });

  it("increments turn_number across multiple afterTurn invocations in the same session", async () => {
    const calls = captureFetch();
    const engine = makeEngine();

    for (let i = 0; i < 3; i++) {
      await engine.afterTurn({
        sessionId: "sess-multi",
        messages: [
          { role: "user", content: `q${i}` },
          { role: "assistant", content: `a${i}` },
        ],
        prePromptMessageCount: 0,
      });
    }

    const turnNumbers = calls
      .filter(
        (c) => c.body?.variables?.moduleId === "conversation-analytics"
      )
      .map((c) => c.body.variables.input.data.attributes.turn_number);
    expect(turnNumbers).toEqual([1, 2, 3]);
  });

  it("only uses prePromptMessageCount=N to slice new messages", async () => {
    const calls = captureFetch();
    const engine = makeEngine();

    await engine.afterTurn({
      sessionId: "sess-slice",
      messages: [
        { role: "user", content: "old-user" },
        { role: "assistant", content: "old-asst" },
        { role: "user", content: "new-user" },
        { role: "assistant", content: "new-asst" },
      ],
      prePromptMessageCount: 2,
    });

    const turn = calls.find(
      (c) => c.body?.variables?.moduleId === "conversation-analytics"
    );
    expect(turn.body.variables.input.data.attributes.user_message).toBe(
      "new-user"
    );
    expect(turn.body.variables.input.data.attributes.assistant_response).toBe(
      "new-asst"
    );
  });
});
