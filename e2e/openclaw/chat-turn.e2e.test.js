/**
 * E2E test for CHAT_TURN emission on the OpenClaw plugin (hosted mode).
 *
 * Mocks the TES GraphQL endpoint in-process, imports the actual published
 * plugin, and drives its afterTurn hook with realistic OpenClaw inputs:
 *   - content-block arrays ([{type:"text", text:"..."}])
 *   - "Conversation info (untrusted metadata)" envelopes from Telegram
 *   - messages slice via prePromptMessageCount
 *
 * Asserts the mock TES receives correctly-shaped CHAT_TURN events with
 * real user text (not wrapper JSON or "[object Object]").
 *
 * Run:
 *   NODE_OPTIONS='--experimental-vm-modules' npx jest --config jest.config.cjs e2e/openclaw/chat-turn.e2e.test.js
 */

import { createServer } from "http";
import plugin, { _resetTurnBuffersForTest } from "../../packages/memory/openclaw-plugin/index.js";

let server;
let serverUrl;
let received;

// Start a mock TES GraphQL endpoint that captures every createModuleEvent
// call. Returns a success response so the plugin treats emission as done.
beforeAll(async () => {
  received = [];
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body);
        received.push({ url: req.url, body: parsed });
      } catch {
        /* ignore non-JSON */
      }
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          data: {
            createModuleEvent: { success: true, eventId: "mock-evt" },
          },
        })
      );
    });
  });
  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      serverUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

afterEach(() => {
  received.length = 0;
  _resetTurnBuffersForTest();
});

// Register the plugin in hosted mode pointing at the mock TES. Returns
// the context engine the plugin created.
function makeEngine(extraConfig = {}) {
  let factory;
  plugin.register({
    pluginConfig: {
      tes_endpoint: serverUrl,
      tes_client_id: "e2e",
      tes_api_key: "tes_e2e_mock",
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

function chatTurns() {
  return received.filter(
    (c) =>
      c.body?.variables?.moduleId === "conversation-analytics" &&
      c.body?.variables?.input?.eventType === "CHAT_TURN"
  );
}

function storeMemories() {
  return received.filter(
    (c) => c.body?.variables?.moduleId === "deep-memory"
  );
}

describe("OpenClaw plugin — CHAT_TURN e2e against mock TES", () => {
  it("emits CHAT_TURN with real user text from content-block arrays", async () => {
    const engine = makeEngine();

    await engine.afterTurn({
      sessionId: "sess-blocks",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "what coffee do I drink?" }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "cortado" }],
          model: "claude-3-5-sonnet",
          usage: {
            input_tokens: 42,
            output_tokens: 3,
            cache_read_input_tokens: 1000,
          },
        },
      ],
      prePromptMessageCount: 0,
    });

    const turns = chatTurns();
    expect(turns).toHaveLength(1);
    const attrs = turns[0].body.variables.input.data.attributes;
    expect(attrs.user_message).toBe("what coffee do I drink?");
    expect(attrs.assistant_response).toBe("cortado");
    expect(attrs.model).toBe("claude-3-5-sonnet");
    expect(attrs.usage.cache_read_input_tokens).toBe(1000);
    expect(attrs.source).toBe("openclaw-plugin");
  });

  it("strips OpenClaw metadata envelopes from Telegram-style user messages", async () => {
    const engine = makeEngine();

    const envelope = [
      "Conversation info (untrusted metadata):",
      "```json",
      JSON.stringify(
        { message_id: "111", sender: "phil", channel: "telegram" },
        null,
        2
      ),
      "```",
      "",
      "remember that my cat is called biscuit",
    ].join("\n");

    await engine.afterTurn({
      sessionId: "sess-envelope",
      messages: [
        { role: "user", content: envelope },
        { role: "assistant", content: "got it" },
      ],
      prePromptMessageCount: 0,
    });

    const turns = chatTurns();
    expect(turns).toHaveLength(1);
    const attrs = turns[0].body.variables.input.data.attributes;
    expect(attrs.user_message).toBe("remember that my cat is called biscuit");
    expect(attrs.user_message).not.toMatch(/Conversation info/);
    expect(attrs.user_message).not.toMatch(/json/);
  });

  it("honours prePromptMessageCount and only emits for new messages", async () => {
    const engine = makeEngine();

    await engine.afterTurn({
      sessionId: "sess-slice",
      messages: [
        { role: "user", content: "old q" },
        { role: "assistant", content: "old a" },
        { role: "user", content: "new q" },
        { role: "assistant", content: "new a" },
      ],
      prePromptMessageCount: 2,
    });

    const turns = chatTurns();
    expect(turns).toHaveLength(1);
    const attrs = turns[0].body.variables.input.data.attributes;
    expect(attrs.user_message).toBe("new q");
    expect(attrs.assistant_response).toBe("new a");
  });

  it("emits CHAT_TURN alongside STORE_MEMORY for retrieval (both fire)", async () => {
    const engine = makeEngine();

    await engine.afterTurn({
      sessionId: "sess-both",
      messages: [
        { role: "user", content: "remember something" },
        { role: "assistant", content: "noted" },
      ],
      prePromptMessageCount: 0,
    });

    expect(chatTurns()).toHaveLength(1);
    expect(storeMemories().length).toBeGreaterThanOrEqual(2); // user + assistant
  });

  it("increments turn_number across successive afterTurn calls in the same session", async () => {
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

    const turns = chatTurns();
    expect(
      turns.map((t) => t.body.variables.input.data.attributes.turn_number)
    ).toEqual([1, 2, 3]);
  });

  it("extracts tool_calls from a wrapped Anthropic raw response", async () => {
    const engine = makeEngine();

    await engine.afterTurn({
      sessionId: "sess-tools",
      messages: [
        { role: "user", content: "search for cats" },
        {
          role: "assistant",
          content: "searching",
          raw: {
            content: [
              { type: "text", text: "searching" },
              { type: "tool_use", name: "search", input: { q: "cats" } },
            ],
          },
        },
      ],
      prePromptMessageCount: 0,
    });

    const turns = chatTurns();
    expect(turns).toHaveLength(1);
    expect(turns[0].body.variables.input.data.attributes.tool_calls).toEqual([
      { tool: "search", args: { q: "cats" } },
    ]);
  });

  it("omits usage and tool_calls entirely when the assistant has none", async () => {
    // Dashboard's Token Universe distinguishes 'no data' from 'zero' —
    // zeros would render an empty band alongside real values.
    const engine = makeEngine();

    await engine.afterTurn({
      sessionId: "sess-bare",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
      prePromptMessageCount: 0,
    });

    const attrs = chatTurns()[0].body.variables.input.data.attributes;
    expect("usage" in attrs).toBe(false);
    expect("tool_calls" in attrs).toBe(false);
  });

  it("does not emit for OpenClaw internal system prompts injected as role=user", async () => {
    // OpenClaw injects "Note: The previous agent run was aborted" and
    // "System (untrusted)" blocks as role=user. These should not become
    // CHAT_TURN user_message values.
    const engine = makeEngine();

    await engine.afterTurn({
      sessionId: "sess-system",
      messages: [
        {
          role: "user",
          content: "Note: The previous agent run was aborted by the user.",
        },
        { role: "assistant", content: "ok" },
      ],
      prePromptMessageCount: 0,
    });

    // The assistant pairs with whatever user_message is buffered — in
    // this case the system-prompt user was filtered out, so the CHAT_TURN
    // is emitted without a user_message (rather than garbage).
    const turns = chatTurns();
    expect(turns).toHaveLength(1);
    const attrs = turns[0].body.variables.input.data.attributes;
    // Either undefined (no buffered user) or a non-system string —
    // never the raw system prompt.
    if (attrs.user_message !== undefined) {
      expect(attrs.user_message).not.toMatch(/Note: The previous agent run/);
    }
  });
});
