import {
  _resetTurnBuffersForTest,
} from "../openclaw/index.js";
import plugin from "../openclaw/index.js";

const realFetch = globalThis.fetch;

function captureFetch() {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url, body });
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: { emitEvent: { eventId: "e", success: true } } }),
    };
  };
  return calls;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  _resetTurnBuffersForTest();
});

// Build a working hosted engine via the plugin's register(api) hook.
// The plugin uses api.registerContextEngine(name, factory) — the factory
// is called once with no args and returns the engine object.
function makeEngine() {
  let factory;
  plugin.register({
    config: {
      tes_endpoint: "https://x.test",
      tes_client_id: "c",
      tes_api_key: "tes_c_xyz",
    },
    registerTool: () => {},
    registerContextEngine: (_name, fn) => {
      factory = fn;
    },
  });
  if (!factory) {
    throw new Error("plugin did not register a context engine");
  }
  return factory();
}

describe("openclaw plugin — hosted CHAT_TURN emission", () => {
  it("emits a CHAT_TURN when an assistant message follows a user message", async () => {
    const calls = captureFetch();
    const engine = makeEngine();

    await engine.ingest({
      sessionId: "sess-1",
      message: { role: "user", content: "hi" },
    });
    await engine.ingest({
      sessionId: "sess-1",
      message: {
        role: "assistant",
        content: "hello",
        usage: { input_tokens: 12, output_tokens: 8 },
        model: "claude-3-5",
      },
    });

    const chatTurnCall = calls.find(
      (c) =>
        c.body?.variables?.moduleId === "conversation-analytics" &&
        c.body?.variables?.input?.eventType === "CHAT_TURN"
    );
    expect(chatTurnCall).toBeDefined();
    const attrs = chatTurnCall.body.variables.input.data.attributes;
    expect(attrs.user_message).toBe("hi");
    expect(attrs.assistant_response).toBe("hello");
    expect(attrs.model).toBe("claude-3-5");
    expect(attrs.usage).toEqual({ input_tokens: 12, output_tokens: 8 });
    expect(attrs.turn_number).toBe(1);
    expect(attrs.source).toBe("openclaw-plugin");
  });

  it("still emits STORE_MEMORY events alongside CHAT_TURN (existing behaviour preserved)", async () => {
    const calls = captureFetch();
    const engine = makeEngine();

    await engine.ingest({
      sessionId: "sess-2",
      message: { role: "user", content: "a question" },
    });
    await engine.ingest({
      sessionId: "sess-2",
      message: { role: "assistant", content: "an answer" },
    });

    const storeMemoryCalls = calls.filter((c) => {
      const m = c.body?.query;
      return typeof m === "string" && m.includes("createModuleEvent");
    });
    expect(storeMemoryCalls.length).toBeGreaterThan(0);
  });

  it("omits usage and tool_calls when the message has no metadata", async () => {
    const calls = captureFetch();
    const engine = makeEngine();
    await engine.ingest({
      sessionId: "sess-3",
      message: { role: "user", content: "hi" },
    });
    await engine.ingest({
      sessionId: "sess-3",
      message: { role: "assistant", content: "ok" },
    });
    const turnCall = calls.find(
      (c) =>
        c.body?.variables?.moduleId === "conversation-analytics" &&
        c.body?.variables?.input?.eventType === "CHAT_TURN"
    );
    expect("usage" in turnCall.body.variables.input.data.attributes).toBe(false);
    expect("tool_calls" in turnCall.body.variables.input.data.attributes).toBe(
      false
    );
  });

  it("extracts tool_calls from a wrapped Anthropic raw response", async () => {
    const calls = captureFetch();
    const engine = makeEngine();
    await engine.ingest({
      sessionId: "sess-4",
      message: { role: "user", content: "search" },
    });
    await engine.ingest({
      sessionId: "sess-4",
      message: {
        role: "assistant",
        content: "looking",
        raw: {
          content: [
            { type: "text", text: "looking" },
            { type: "tool_use", name: "search", input: { q: "shoes" } },
          ],
        },
      },
    });
    const attrs = calls.find(
      (c) =>
        c.body?.variables?.moduleId === "conversation-analytics" &&
        c.body?.variables?.input?.eventType === "CHAT_TURN"
    ).body.variables.input.data.attributes;
    expect(attrs.tool_calls).toEqual([
      { tool: "search", args: { q: "shoes" } },
    ]);
  });

  it("increments turn_number per buffered user message in the same session", async () => {
    const calls = captureFetch();
    const engine = makeEngine();
    for (let i = 0; i < 3; i++) {
      await engine.ingest({
        sessionId: "sess-5",
        message: { role: "user", content: `q${i}` },
      });
      await engine.ingest({
        sessionId: "sess-5",
        message: { role: "assistant", content: `a${i}` },
      });
    }
    const turns = calls.filter(
      (c) =>
        c.body?.variables?.moduleId === "conversation-analytics" &&
        c.body?.variables?.input?.eventType === "CHAT_TURN"
    );
    expect(turns.map((t) => t.body.variables.input.data.attributes.turn_number)).toEqual(
      [1, 2, 3]
    );
  });

  it("emits even when assistant arrives with no buffered user message", async () => {
    const calls = captureFetch();
    const engine = makeEngine();
    await engine.ingest({
      sessionId: "sess-6",
      message: { role: "assistant", content: "hi without prompt" },
    });
    const turn = calls.find(
      (c) =>
        c.body?.variables?.moduleId === "conversation-analytics" &&
        c.body?.variables?.input?.eventType === "CHAT_TURN"
    );
    expect(turn).toBeDefined();
    expect(turn.body.variables.input.data.attributes.user_message).toBeUndefined();
  });
});
