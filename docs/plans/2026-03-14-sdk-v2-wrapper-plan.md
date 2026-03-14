# SDK v2 Wrapper Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace Session-based accumulation in `wrap()` with direct per-call event emission, auto-managed session IDs, and metadata support — reducing integration from ~15 lines to 2.

**Architecture:** Each intercepted provider call normalizes the response, builds event attributes inline (no Session accumulation), and calls `sendEvent()` directly. `sessionId` and `metadata` are stored on the wrapper instance and included in every emitted event. The manual `Session` API remains unchanged for edge cases.

**Tech Stack:** JavaScript (ES modules, Proxy), Python 3.8+ (wrapper classes), Jest + pytest for testing.

---

## Reference: Current Code

| File | Lines | Role |
|------|-------|------|
| `src/wrapper.js` | 177 | JS Proxy-based wrapping + `fireAndForgetEmit` |
| `src/client.js` | 57 | `TESClient.wrap()` entry point |
| `python/pentatonic_agent_events/wrapper.py` | 189 | Python wrapper classes + `_fire_and_forget_emit` |
| `python/pentatonic_agent_events/client.py` | 48 | Python `TESClient.wrap()` entry point |
| `__tests__/wrapper.test.js` | 317 | JS wrapper tests (13 tests) |
| `python/tests/test_wrapper.py` | 266 | Python wrapper tests (10 tests) |
| `src/session.js` | 148 | JS Session (unchanged — manual API preserved) |
| `src/transport.js` | 44 | JS `sendEvent()` |
| `src/normalizer.js` | 111 | JS `normalizeResponse()` |

## What Changes

1. **`TESClient.wrap(client)`** → **`TESClient.wrap(client, { sessionId, metadata })`** — accepts optional session config
2. **`wrapClient(config, client)`** → **`wrapClient(config, client, wrapOpts)`** — passes session config down
3. **`fireAndForgetEmit` / `_fire_and_forget_emit`** — rewritten to call `sendEvent()` directly instead of creating throwaway Sessions
4. **Session subclasses removed** (`OpenAISession`, `AnthropicSession`, `WorkersAISession`) — no longer needed
5. **`.session()` method removed from wrappers** — the wrapper itself IS the session now
6. **`ai.sessionId`** — exposed as a property on the wrapped client
7. **Tests rewritten** — session-based multi-round tests become per-call emission tests

---

### Task 1: Update JS `TESClient.wrap()` to accept session options

**Files:**
- Modify: `src/client.js:54-56`

**Step 1: Update `wrap()` signature**

```js
// src/client.js — change line 54-56
wrap(client, { sessionId, metadata } = {}) {
  return wrapClient(this._config, client, { sessionId, metadata });
}
```

**Step 2: Run tests to verify nothing breaks yet**

Run: `cd /home/phil/Development/takebacks/ai-events-sdk && npm test`
Expected: All 13 wrapper tests pass (no wrap opts used yet)

**Step 3: Commit**

```bash
git add src/client.js
git commit -m "feat: accept sessionId and metadata options in TESClient.wrap()"
```

---

### Task 2: Rewrite JS wrapper with per-call emission and sessionId/metadata

**Files:**
- Modify: `src/wrapper.js` (full rewrite of lines 1-177)

**Step 1: Write the new wrapper.js**

Replace the entire file. Key changes:
- Import `normalizeResponse` and `sendEvent` (not Session)
- `wrapClient(config, client, wrapOpts)` — stores `sessionId` and `metadata`
- Each provider wrapper stores `sessionId` (auto-generated UUID if not provided) and `metadata`
- Intercepted calls: normalize → build attributes → `sendEvent()` fire-and-forget
- Expose `sessionId` as a readable property via Proxy `get` trap
- Remove `OpenAISession`, `AnthropicSession`, `WorkersAISession` classes
- Remove `.session()` method from wrappers

```js
import { normalizeResponse } from "./normalizer.js";
import { sendEvent } from "./transport.js";

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
 * Wrap any supported LLM client with automatic per-call event emission.
 */
export function wrapClient(clientConfig, client, { sessionId, metadata } = {}) {
  const type = detectClientType(client);
  const sid = sessionId || crypto.randomUUID();
  const meta = metadata || {};

  if (type === "openai") return wrapOpenAI(clientConfig, client, sid, meta);
  if (type === "anthropic") return wrapAnthropic(clientConfig, client, sid, meta);
  if (type === "workers-ai") return wrapWorkersAI(clientConfig, client, sid, meta);

  throw new Error(
    "Unsupported client: expected OpenAI (chat.completions.create), " +
      "Anthropic (messages.create), or Workers AI (run) client"
  );
}

// --- Shared emit ---

function emitEvent(clientConfig, sessionId, metadata, messages, normalized, model) {
  const capture = clientConfig.captureContent !== false;
  const maxLen = clientConfig.maxContentLength;

  const rawContent =
    messages?.filter?.((m) => m.role === "user")?.pop()?.content || "";
  const userMsg = Array.isArray(rawContent)
    ? rawContent
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n")
    : rawContent;
  const assistantMsg = normalized.content || "";

  const attributes = {
    ...metadata,
    source: "pentatonic-ai-sdk",
    model: model || normalized.model,
    usage: {
      prompt_tokens: normalized.usage.prompt_tokens,
      completion_tokens: normalized.usage.completion_tokens,
      total_tokens: normalized.usage.prompt_tokens + normalized.usage.completion_tokens,
      ai_rounds: 1,
    },
  };

  if (normalized.toolCalls.length) {
    attributes.tool_calls = capture
      ? normalized.toolCalls.map((tc) => ({ ...tc, round: 0 }))
      : normalized.toolCalls.map(({ args, ...rest }) => ({ ...rest, round: 0 }));
  }

  if (capture) {
    attributes.user_message = _truncate(userMsg, maxLen);
    attributes.assistant_response = _truncate(assistantMsg, maxLen);

    if (messages) {
      attributes.messages = messages.map((m) => {
        if (typeof m.content === "string") {
          return { ...m, content: _truncate(m.content, maxLen) };
        }
        return m;
      });
    }
  }

  sendEvent(clientConfig, {
    eventType: "CHAT_TURN",
    entityType: "conversation",
    data: {
      entity_id: sessionId,
      attributes,
    },
  }).catch((err) => console.error("[pentatonic-ai] emit failed:", err.message));
}

function _truncate(value, maxLen) {
  if (!value || !maxLen || typeof value !== "string") return value;
  if (value.length <= maxLen) return value;
  return value.slice(0, maxLen) + "...[truncated]";
}

// --- OpenAI ---

function wrapOpenAI(config, client, sessionId, metadata) {
  return new Proxy(client, {
    get(target, prop) {
      if (prop === "chat") return wrapOpenAIChat(config, target.chat, sessionId, metadata);
      if (prop === "sessionId") return sessionId;
      return target[prop];
    },
  });
}

function wrapOpenAIChat(config, chat, sessionId, metadata) {
  return new Proxy(chat, {
    get(target, prop) {
      if (prop === "completions") return wrapOpenAICompletions(config, target.completions, sessionId, metadata);
      return target[prop];
    },
  });
}

function wrapOpenAICompletions(config, completions, sessionId, metadata) {
  return new Proxy(completions, {
    get(target, prop) {
      if (prop === "create") {
        return async (params) => {
          const result = await target.create(params);
          const normalized = normalizeResponse(result);
          emitEvent(config, sessionId, metadata, params.messages, normalized);
          return result;
        };
      }
      return target[prop];
    },
  });
}

// --- Anthropic ---

function wrapAnthropic(config, client, sessionId, metadata) {
  return new Proxy(client, {
    get(target, prop) {
      if (prop === "messages") return wrapAnthropicMessages(config, target.messages, sessionId, metadata);
      if (prop === "sessionId") return sessionId;
      return target[prop];
    },
  });
}

function wrapAnthropicMessages(config, messages, sessionId, metadata) {
  return new Proxy(messages, {
    get(target, prop) {
      if (prop === "create") {
        return async (params) => {
          const result = await target.create(params);
          const normalized = normalizeResponse(result);
          emitEvent(config, sessionId, metadata, params.messages, normalized);
          return result;
        };
      }
      return target[prop];
    },
  });
}

// --- Workers AI ---

function wrapWorkersAI(config, aiBinding, sessionId, metadata) {
  return new Proxy(aiBinding, {
    get(target, prop) {
      if (prop === "run") {
        return async (model, params, ...rest) => {
          const result = await target.run(model, params, ...rest);
          const normalized = normalizeResponse(result);
          emitEvent(config, sessionId, metadata, params?.messages, normalized, model);
          return result;
        };
      }
      if (prop === "sessionId") return sessionId;
      return target[prop];
    },
  });
}
```

**Step 2: Run tests**

Run: `cd /home/phil/Development/takebacks/ai-events-sdk && npm test`
Expected: Some tests will FAIL — specifically the 3 multi-round session tests that use `ai.session()` and `session.emitChatTurn()`. The per-call emission tests should pass.

**Step 3: Commit**

```bash
git add src/wrapper.js
git commit -m "feat: rewrite JS wrapper for per-call emission with sessionId and metadata"
```

---

### Task 3: Rewrite JS wrapper tests for v2 API

**Files:**
- Modify: `__tests__/wrapper.test.js` (full rewrite)

**Step 1: Write the new tests**

Replace the test file. Key changes:
- Remove `ai.session()` / `session.chat()` / `session.emitChatTurn()` patterns
- Each `create()`/`run()` call should emit its own event (check `fetchCalls` after each call)
- Test `ai.sessionId` property
- Test custom `sessionId` and `metadata` passed to `wrap()`
- Test multi-call scenarios (2 calls → 2 events, each with `ai_rounds: 1`)
- Keep: proxy passthrough tests, error cases, messages array inclusion

New test structure:

```
describe("tes.wrap() — OpenAI")
  ✓ proxies non-chat methods through untouched
  ✓ intercepts chat.completions.create and emits CHAT_TURN
  ✓ includes full messages array in emitted event
  ✓ exposes auto-generated sessionId
  ✓ uses custom sessionId when provided
  ✓ includes metadata in emitted events
  ✓ emits one event per call (2 calls → 2 events)

describe("tes.wrap() — Anthropic")
  ✓ proxies non-messages methods through untouched
  ✓ intercepts messages.create and emits CHAT_TURN
  ✓ handles tool_use blocks in single event
  ✓ exposes sessionId property

describe("tes.wrap() — Workers AI")
  ✓ intercepts run() and emits CHAT_TURN
  ✓ emits one event per run() call
  ✓ exposes sessionId property

describe("tes.wrap() — unsupported client")
  ✓ throws for unknown client shape
```

Full test code:

```js
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
    const result = await ai.messages.create({
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
```

**Step 2: Run tests**

Run: `cd /home/phil/Development/takebacks/ai-events-sdk && npm test`
Expected: All 15 tests pass

**Step 3: Commit**

```bash
git add __tests__/wrapper.test.js
git commit -m "test: rewrite wrapper tests for v2 per-call emission API"
```

---

### Task 4: Update Python `TESClient.wrap()` to accept session options

**Files:**
- Modify: `python/pentatonic_agent_events/client.py:44-45`

**Step 1: Update `wrap()` signature**

```python
# python/pentatonic_agent_events/client.py — change line 44-45
def wrap(self, client, session_id=None, metadata=None):
    return wrap_client(self._config, client, session_id=session_id, metadata=metadata)
```

**Step 2: Update `wrap_client()` signature in wrapper.py**

```python
# python/pentatonic_agent_events/wrapper.py — change line 23
def wrap_client(config, client, session_id=None, metadata=None):
```

And pass `session_id` and `metadata` to each wrapper constructor (next task handles this).

**Step 3: Run tests to verify nothing breaks yet**

Run: `cd /home/phil/Development/takebacks/ai-events-sdk && python -m pytest python/tests/test_wrapper.py -v`
Expected: Tests still pass (defaults match current behavior)

**Step 4: Commit**

```bash
git add python/pentatonic_agent_events/client.py
git commit -m "feat: accept session_id and metadata options in Python TESClient.wrap()"
```

---

### Task 5: Rewrite Python wrapper with per-call emission and session support

**Files:**
- Modify: `python/pentatonic_agent_events/wrapper.py` (full rewrite)

**Step 1: Write the new wrapper.py**

Replace the entire file. Key changes:
- Import `normalize_response` and `send_event` (not Session)
- `wrap_client(config, client, session_id=None, metadata=None)` — passes session info to wrappers
- Each wrapper class stores `session_id` (auto-generated UUID if omitted) and `metadata`
- Intercepted calls: normalize → build attributes → `send_event()` with try/except
- Expose `session_id` as a property
- Remove `_OpenAISession`, `_AnthropicSession`, `_WorkersAISession` classes
- Remove `.session()` method from wrappers

```python
import sys
import uuid
from .normalizer import normalize_response
from .transport import send_event


def detect_client_type(client):
    """Detect client type by duck-typing its shape."""
    try:
        if hasattr(client, "chat") and hasattr(client.chat, "completions") and hasattr(client.chat.completions, "create"):
            return "openai"
    except Exception:
        pass
    try:
        if hasattr(client, "messages") and hasattr(client.messages, "create"):
            return "anthropic"
    except Exception:
        pass
    if callable(getattr(client, "run", None)):
        return "workers-ai"
    return "unknown"


def wrap_client(config, client, session_id=None, metadata=None):
    client_type = detect_client_type(client)
    sid = session_id or str(uuid.uuid4())
    meta = metadata or {}

    if client_type == "openai":
        return _OpenAIWrapper(config, client, sid, meta)
    if client_type == "anthropic":
        return _AnthropicWrapper(config, client, sid, meta)
    if client_type == "workers-ai":
        return _WorkersAIWrapper(config, client, sid, meta)

    raise ValueError(
        "Unsupported client: expected OpenAI (chat.completions.create), "
        "Anthropic (messages.create), or Workers AI (run) client"
    )


def _truncate(value, max_len):
    if not value or not max_len or not isinstance(value, str):
        return value
    if len(value) <= max_len:
        return value
    return value[:max_len] + "...[truncated]"


def _emit_event(config, session_id, metadata, messages, normalized, model=None):
    capture = config.get("capture_content", True) is not False
    max_len = config.get("max_content_length")

    raw_content = ""
    if isinstance(messages, list):
        user_msgs = [m for m in messages if isinstance(m, dict) and m.get("role") == "user"]
        if user_msgs:
            raw_content = user_msgs[-1].get("content", "")

    if isinstance(raw_content, list):
        user_msg = "\n".join(
            b.get("text", "") for b in raw_content if isinstance(b, dict) and b.get("type") == "text"
        )
    else:
        user_msg = raw_content

    assistant_msg = normalized["content"] or ""

    attributes = {
        **metadata,
        "source": "pentatonic-ai-sdk",
        "model": model or normalized["model"],
        "usage": {
            "prompt_tokens": normalized["usage"]["prompt_tokens"],
            "completion_tokens": normalized["usage"]["completion_tokens"],
            "total_tokens": normalized["usage"]["prompt_tokens"] + normalized["usage"]["completion_tokens"],
            "ai_rounds": 1,
        },
    }

    if normalized["tool_calls"]:
        if capture:
            attributes["tool_calls"] = [{**tc, "round": 0} for tc in normalized["tool_calls"]]
        else:
            attributes["tool_calls"] = [
                {k: v for k, v in {**tc, "round": 0}.items() if k != "args"}
                for tc in normalized["tool_calls"]
            ]

    if capture:
        attributes["user_message"] = _truncate(user_msg, max_len)
        attributes["assistant_response"] = _truncate(assistant_msg, max_len)

        if messages:
            attributes["messages"] = [
                {**m, "content": _truncate(m["content"], max_len)}
                if isinstance(m.get("content"), str) else m
                for m in messages
            ]

    try:
        send_event(config, {
            "eventType": "CHAT_TURN",
            "entityType": "conversation",
            "data": {
                "entity_id": session_id,
                "attributes": attributes,
            },
        })
    except Exception as e:
        print(f"[pentatonic-ai] emit failed: {e}", file=sys.stderr)


class _WrappedOpenAICompletions:
    def __init__(self, config, completions, session_id, metadata):
        self._config = config
        self._completions = completions
        self._session_id = session_id
        self._metadata = metadata

    def create(self, **kwargs):
        result = self._completions.create(**kwargs)
        normalized = normalize_response(result)
        _emit_event(self._config, self._session_id, self._metadata, kwargs.get("messages"), normalized)
        return result

    def __getattr__(self, name):
        return getattr(self._completions, name)


class _WrappedOpenAIChat:
    def __init__(self, config, chat, session_id, metadata):
        self._config = config
        self._chat = chat
        self.completions = _WrappedOpenAICompletions(config, chat.completions, session_id, metadata)

    def __getattr__(self, name):
        if name == "completions":
            return self.completions
        return getattr(self._chat, name)


class _OpenAIWrapper:
    def __init__(self, config, client, session_id, metadata):
        self._config = config
        self._client = client
        self._session_id = session_id
        self._metadata = metadata
        self.chat = _WrappedOpenAIChat(config, client.chat, session_id, metadata)

    @property
    def session_id(self):
        return self._session_id

    def __getattr__(self, name):
        if name == "chat":
            return self.chat
        return getattr(self._client, name)


class _WrappedAnthropicMessages:
    def __init__(self, config, messages, session_id, metadata):
        self._config = config
        self._messages = messages
        self._session_id = session_id
        self._metadata = metadata

    def create(self, **kwargs):
        result = self._messages.create(**kwargs)
        normalized = normalize_response(result)
        _emit_event(self._config, self._session_id, self._metadata, kwargs.get("messages"), normalized)
        return result

    def __getattr__(self, name):
        return getattr(self._messages, name)


class _AnthropicWrapper:
    def __init__(self, config, client, session_id, metadata):
        self._config = config
        self._client = client
        self._session_id = session_id
        self._metadata = metadata
        self.messages = _WrappedAnthropicMessages(config, client.messages, session_id, metadata)

    @property
    def session_id(self):
        return self._session_id

    def __getattr__(self, name):
        if name == "messages":
            return self.messages
        return getattr(self._client, name)


class _WorkersAIWrapper:
    def __init__(self, config, ai_binding, session_id, metadata):
        self._config = config
        self._ai = ai_binding
        self._session_id = session_id
        self._metadata = metadata

    @property
    def session_id(self):
        return self._session_id

    def run(self, model, params=None, **kwargs):
        result = self._ai.run(model, params, **kwargs)
        messages = params.get("messages") if isinstance(params, dict) else None
        normalized = normalize_response(result)
        _emit_event(self._config, self._session_id, self._metadata, messages, normalized, model=model)
        return result

    def __getattr__(self, name):
        return getattr(self._ai, name)
```

**Step 2: Run tests**

Run: `cd /home/phil/Development/takebacks/ai-events-sdk && python -m pytest python/tests/test_wrapper.py -v`
Expected: Some tests FAIL — session-based tests use `ai.session()` and `session.emit_chat_turn()`.

**Step 3: Commit**

```bash
git add python/pentatonic_agent_events/wrapper.py
git commit -m "feat: rewrite Python wrapper for per-call emission with session_id and metadata"
```

---

### Task 6: Rewrite Python wrapper tests for v2 API

**Files:**
- Modify: `python/tests/test_wrapper.py` (full rewrite)

**Step 1: Write the new tests**

Replace the test file. Key changes:
- Remove `ai.session()` / `session.chat()` / `session.emit_chat_turn()` patterns
- Each `create()`/`run()` call should emit its own event
- Test `ai.session_id` property
- Test custom `session_id` and `metadata`
- Test multi-call scenarios (2 calls → 2 events)

New test structure:

```
TestWrapOpenAI
  ✓ test_proxies_non_chat_methods
  ✓ test_intercepts_create_and_emits
  ✓ test_includes_messages_in_emitted_event
  ✓ test_exposes_auto_generated_session_id
  ✓ test_uses_custom_session_id
  ✓ test_includes_metadata_in_events
  ✓ test_emits_one_event_per_call

TestWrapAnthropic
  ✓ test_proxies_non_messages_methods
  ✓ test_intercepts_create_and_emits
  ✓ test_handles_tool_use_in_single_event
  ✓ test_exposes_session_id

TestWrapWorkersAI
  ✓ test_intercepts_run_and_emits
  ✓ test_emits_one_event_per_run
  ✓ test_exposes_session_id

TestWrapUnsupported
  ✓ test_throws_for_unknown_client
```

Full test code:

```python
import json
from unittest.mock import patch, MagicMock
from pentatonic_agent_events.client import TESClient


def _mock_urlopen(captured_requests):
    def mock_fn(req, **kwargs):
        captured_requests.append(req)
        resp = MagicMock()
        resp.read.return_value = json.dumps({
            "data": {"emitEvent": {"success": True, "eventId": "evt-456", "message": None}}
        }).encode()
        resp.__enter__ = MagicMock(return_value=resp)
        resp.__exit__ = MagicMock(return_value=False)
        return resp
    return mock_fn


tes = TESClient(
    client_id="test-client",
    api_key="tes_sk_test",
    endpoint="https://api.test.com",
)


class MockOpenAICompletions:
    def __init__(self, responses):
        self._responses = responses
        self._call_index = 0

    def create(self, **kwargs):
        resp = self._responses[min(self._call_index, len(self._responses) - 1)]
        self._call_index += 1
        return resp


class MockOpenAIChat:
    def __init__(self, responses):
        self.completions = MockOpenAICompletions(responses)


class MockOpenAI:
    def __init__(self, responses):
        self.chat = MockOpenAIChat(responses)
        self.models = MagicMock()
        self.models.list.return_value = {"data": [{"id": "gpt-4o"}]}


class MockAnthropicMessages:
    def __init__(self, responses):
        self._responses = responses
        self._call_index = 0

    def create(self, **kwargs):
        resp = self._responses[min(self._call_index, len(self._responses) - 1)]
        self._call_index += 1
        return resp


class MockAnthropic:
    def __init__(self, responses):
        self.messages = MockAnthropicMessages(responses)
        self.models = MagicMock()
        self.models.list.return_value = {"data": [{"id": "claude-sonnet-4-6-20250514"}]}


class MockWorkersAI:
    def __init__(self, responses):
        self._responses = responses
        self._call_index = 0

    def run(self, model, params=None, **kwargs):
        resp = self._responses[min(self._call_index, len(self._responses) - 1)]
        self._call_index += 1
        return resp


class TestWrapOpenAI:
    def test_proxies_non_chat_methods(self):
        openai = MockOpenAI([])
        ai = tes.wrap(openai)
        models = ai.models.list()
        assert models["data"][0]["id"] == "gpt-4o"

    def test_intercepts_create_and_emits(self):
        requests = []
        openai = MockOpenAI([{
            "choices": [{"message": {"content": "Hello!"}}],
            "usage": {"prompt_tokens": 50, "completion_tokens": 20, "total_tokens": 70},
            "model": "gpt-4o",
        }])
        ai = tes.wrap(openai)
        with patch("pentatonic_agent_events.transport.urlopen", side_effect=_mock_urlopen(requests)):
            result = ai.chat.completions.create(
                model="gpt-4o",
                messages=[{"role": "user", "content": "hi"}],
            )
        assert result["choices"][0]["message"]["content"] == "Hello!"
        assert len(requests) == 1
        body = json.loads(requests[0].data)
        attrs = body["variables"]["input"]["data"]["attributes"]
        assert attrs["model"] == "gpt-4o"
        assert attrs["usage"]["prompt_tokens"] == 50
        assert attrs["usage"]["ai_rounds"] == 1

    def test_includes_messages_in_emitted_event(self):
        requests = []
        openai = MockOpenAI([{
            "choices": [{"message": {"content": "Hello!"}}],
            "usage": {"prompt_tokens": 50, "completion_tokens": 20, "total_tokens": 70},
            "model": "gpt-4o",
        }])
        ai = tes.wrap(openai)
        with patch("pentatonic_agent_events.transport.urlopen", side_effect=_mock_urlopen(requests)):
            ai.chat.completions.create(
                model="gpt-4o",
                messages=[
                    {"role": "system", "content": "You are helpful."},
                    {"role": "user", "content": "hi"},
                ],
            )
        assert len(requests) == 1
        attrs = json.loads(requests[0].data)["variables"]["input"]["data"]["attributes"]
        assert len(attrs["messages"]) == 2
        assert attrs["messages"][0] == {"role": "system", "content": "You are helpful."}
        assert attrs["messages"][1] == {"role": "user", "content": "hi"}

    def test_exposes_auto_generated_session_id(self):
        openai = MockOpenAI([])
        ai = tes.wrap(openai)
        assert ai.session_id is not None
        assert isinstance(ai.session_id, str)
        assert len(ai.session_id) > 0

    def test_uses_custom_session_id(self):
        openai = MockOpenAI([])
        ai = tes.wrap(openai, session_id="my-session-123")
        assert ai.session_id == "my-session-123"

    def test_includes_metadata_in_events(self):
        requests = []
        openai = MockOpenAI([{
            "choices": [{"message": {"content": "Hello!"}}],
            "usage": {"prompt_tokens": 50, "completion_tokens": 20, "total_tokens": 70},
            "model": "gpt-4o",
        }])
        ai = tes.wrap(openai, metadata={"shop_domain": "test.myshopify.com"})
        with patch("pentatonic_agent_events.transport.urlopen", side_effect=_mock_urlopen(requests)):
            ai.chat.completions.create(
                model="gpt-4o",
                messages=[{"role": "user", "content": "hi"}],
            )
        attrs = json.loads(requests[0].data)["variables"]["input"]["data"]["attributes"]
        assert attrs["shop_domain"] == "test.myshopify.com"

    def test_emits_one_event_per_call(self):
        requests = []
        openai = MockOpenAI([
            {
                "choices": [{"message": {"content": "", "tool_calls": [{"function": {"name": "search", "arguments": '{"q":"shoes"}'}}]}}],
                "usage": {"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120},
                "model": "gpt-4o",
            },
            {
                "choices": [{"message": {"content": "Found shoes!"}}],
                "usage": {"prompt_tokens": 200, "completion_tokens": 40, "total_tokens": 240},
                "model": "gpt-4o",
            },
        ])
        ai = tes.wrap(openai, session_id="multi-turn")
        with patch("pentatonic_agent_events.transport.urlopen", side_effect=_mock_urlopen(requests)):
            ai.chat.completions.create(
                model="gpt-4o",
                messages=[{"role": "user", "content": "find shoes"}],
            )
            ai.chat.completions.create(
                model="gpt-4o",
                messages=[{"role": "user", "content": "find shoes"}, {"role": "tool", "content": "[...]"}],
            )
        assert len(requests) == 2

        # First event: has tool call
        attrs1 = json.loads(requests[0].data)["variables"]["input"]["data"]["attributes"]
        assert attrs1["usage"]["prompt_tokens"] == 100
        assert attrs1["usage"]["ai_rounds"] == 1
        assert len(attrs1["tool_calls"]) == 1

        # Second event: no tool call
        attrs2 = json.loads(requests[1].data)["variables"]["input"]["data"]["attributes"]
        assert attrs2["usage"]["prompt_tokens"] == 200
        assert attrs2["usage"]["ai_rounds"] == 1

        # Both share same session ID
        sid1 = json.loads(requests[0].data)["variables"]["input"]["data"]["entity_id"]
        sid2 = json.loads(requests[1].data)["variables"]["input"]["data"]["entity_id"]
        assert sid1 == "multi-turn"
        assert sid2 == "multi-turn"


class TestWrapAnthropic:
    def test_proxies_non_messages_methods(self):
        anthropic = MockAnthropic([])
        ai = tes.wrap(anthropic)
        models = ai.models.list()
        assert models["data"][0]["id"] == "claude-sonnet-4-6-20250514"

    def test_intercepts_create_and_emits(self):
        requests = []
        anthropic = MockAnthropic([{
            "content": [{"type": "text", "text": "Bonjour!"}],
            "usage": {"input_tokens": 80, "output_tokens": 25},
            "model": "claude-sonnet-4-6-20250514",
        }])
        ai = tes.wrap(anthropic)
        with patch("pentatonic_agent_events.transport.urlopen", side_effect=_mock_urlopen(requests)):
            result = ai.messages.create(
                model="claude-sonnet-4-6-20250514",
                messages=[{"role": "user", "content": "Say hello in French"}],
                max_tokens=100,
            )
        assert result["content"][0]["text"] == "Bonjour!"
        assert len(requests) == 1
        attrs = json.loads(requests[0].data)["variables"]["input"]["data"]["attributes"]
        assert attrs["model"] == "claude-sonnet-4-6-20250514"
        assert attrs["usage"]["prompt_tokens"] == 80
        assert attrs["user_message"] == "Say hello in French"
        assert attrs["assistant_response"] == "Bonjour!"

    def test_handles_tool_use_in_single_event(self):
        requests = []
        anthropic = MockAnthropic([{
            "content": [
                {"type": "text", "text": "Let me search."},
                {"type": "tool_use", "id": "tu_1", "name": "search", "input": {"query": "shoes"}},
            ],
            "usage": {"input_tokens": 100, "output_tokens": 40},
            "model": "claude-sonnet-4-6-20250514",
        }])
        ai = tes.wrap(anthropic)
        with patch("pentatonic_agent_events.transport.urlopen", side_effect=_mock_urlopen(requests)):
            ai.messages.create(
                model="claude-sonnet-4-6-20250514",
                messages=[{"role": "user", "content": "find shoes"}],
                max_tokens=200,
            )
        assert len(requests) == 1
        attrs = json.loads(requests[0].data)["variables"]["input"]["data"]["attributes"]
        assert len(attrs["tool_calls"]) == 1
        assert attrs["tool_calls"][0]["tool"] == "search"
        assert attrs["usage"]["ai_rounds"] == 1

    def test_exposes_session_id(self):
        anthropic = MockAnthropic([])
        ai = tes.wrap(anthropic, session_id="anth-sess")
        assert ai.session_id == "anth-sess"


class TestWrapWorkersAI:
    def test_intercepts_run_and_emits(self):
        requests = []
        ai = MockWorkersAI([{
            "response": "4",
            "usage": {"prompt_tokens": 30, "completion_tokens": 5},
        }])
        wrapped = tes.wrap(ai)
        with patch("pentatonic_agent_events.transport.urlopen", side_effect=_mock_urlopen(requests)):
            result = wrapped.run("@cf/meta/llama-3.1-8b-instruct", {
                "messages": [{"role": "user", "content": "What is 2+2?"}],
            })
        assert result["response"] == "4"
        assert len(requests) == 1
        attrs = json.loads(requests[0].data)["variables"]["input"]["data"]["attributes"]
        assert attrs["model"] == "@cf/meta/llama-3.1-8b-instruct"
        assert attrs["usage"]["prompt_tokens"] == 30
        assert attrs["user_message"] == "What is 2+2?"
        assert attrs["assistant_response"] == "4"

    def test_emits_one_event_per_run(self):
        requests = []
        ai = MockWorkersAI([
            {
                "response": "",
                "tool_calls": [{"name": "lookup", "arguments": {"id": "123"}}],
                "usage": {"prompt_tokens": 50, "completion_tokens": 10},
            },
            {
                "response": "Found it!",
                "usage": {"prompt_tokens": 80, "completion_tokens": 15},
            },
        ])
        wrapped = tes.wrap(ai, session_id="wai-multi")
        with patch("pentatonic_agent_events.transport.urlopen", side_effect=_mock_urlopen(requests)):
            wrapped.run("@cf/meta/llama-3.1-8b-instruct", {
                "messages": [{"role": "user", "content": "find item 123"}],
            })
            wrapped.run("@cf/meta/llama-3.1-8b-instruct", {
                "messages": [{"role": "user", "content": "find item 123"}, {"role": "tool", "content": "{}"}],
            })
        assert len(requests) == 2

        attrs1 = json.loads(requests[0].data)["variables"]["input"]["data"]["attributes"]
        assert attrs1["usage"]["prompt_tokens"] == 50
        assert len(attrs1["tool_calls"]) == 1
        assert attrs1["tool_calls"][0]["tool"] == "lookup"

        attrs2 = json.loads(requests[1].data)["variables"]["input"]["data"]["attributes"]
        assert attrs2["usage"]["prompt_tokens"] == 80

    def test_exposes_session_id(self):
        ai = MockWorkersAI([])
        wrapped = tes.wrap(ai, session_id="wai-sess")
        assert wrapped.session_id == "wai-sess"


class TestWrapUnsupported:
    def test_throws_for_unknown_client(self):
        import pytest
        with pytest.raises(ValueError, match="Unsupported client"):
            tes.wrap({})
        with pytest.raises(ValueError, match="Unsupported client"):
            tes.wrap({"foo": "bar"})
```

**Step 2: Run tests**

Run: `cd /home/phil/Development/takebacks/ai-events-sdk && python -m pytest python/tests/test_wrapper.py -v`
Expected: All 15 tests pass

**Step 3: Commit**

```bash
git add python/tests/test_wrapper.py
git commit -m "test: rewrite Python wrapper tests for v2 per-call emission API"
```

---

### Task 7: Update shopify-app to use v2 wrapper API

**Files:**
- Modify: `shopify-app/src/chat.js` (in thing-event-system repo)

**Step 1: Read the current integration code**

The current code at lines 95-107 and 258-266 in `shopify-app/src/chat.js`:

```js
// Lines 95-107: Create TES SDK session
let tesSession = null;
if (tesEnabled && tesApiUrl && tesServiceKey) {
  const tes = new TESClient({ clientId, apiKey: tesServiceKey, endpoint: tesApiUrl });
  tesSession = tes.session({ sessionId: sid, metadata: { shop_domain: shopDomain } });
}

// Line 122: Record each AI response
if (tesSession) tesSession.record(aiResult);

// Lines 258-266: Emit after tool loop
if (tesSession) {
  if (!tesSession._model) tesSession._model = MODEL;
  await tesSession.emitChatTurn({
    userMessage: message, assistantResponse: finalResponse,
    turnNumber: session.turn_number, messages: allMessages,
  });
}
```

**Step 2: Replace with v2 wrapper**

```js
// Lines 95-107 become:
let wrappedAI = env.AI;
if (tesEnabled && tesApiUrl && tesServiceKey) {
  const tes = new TESClient({ clientId, apiKey: tesServiceKey, endpoint: tesApiUrl });
  wrappedAI = tes.wrap(env.AI, { sessionId: sid, metadata: { shop_domain: shopDomain } });
}
```

Then change line 116 to use `wrappedAI` instead of `env.AI`:

```js
const aiResult = await wrappedAI.run(MODEL, { messages, tools: TOOL_DEFINITIONS });
```

Delete the following lines:
- Line 122: `if (tesSession) tesSession.record(aiResult);`
- Lines 258-278: The entire `if (tesSession) { ... } else { ... }` block for emitting CHAT_TURN

The `else` branch (emitting via queue when TES is not configured) should remain:

```js
if (!tesEnabled || !tesApiUrl || !tesServiceKey) {
  await emitChatTurn(env, {
    sessionId: sid, clientId, userMessage: message,
    assistantResponse: finalResponse, turnNumber: session.turn_number,
    shopDomain, viWidgetJws, viWorkerJws, model: MODEL,
  });
}
```

**Step 3: Run shopify-app tests**

Run: `cd /home/phil/Development/takebacks/thing-event-system/shopify-app && npx jest`
Expected: All tests pass

**Step 4: Commit**

```bash
cd /home/phil/Development/takebacks/thing-event-system
git add shopify-app/src/chat.js
git commit -m "refactor: use v2 wrapper API in shopify chat — removes manual session tracking"
```

---

### Task 8: Verify all tests pass end-to-end

**Step 1: Run JS SDK tests**

Run: `cd /home/phil/Development/takebacks/ai-events-sdk && npm test`
Expected: All tests pass (wrapper + session + normalizer + client)

**Step 2: Run Python SDK tests**

Run: `cd /home/phil/Development/takebacks/ai-events-sdk && python -m pytest python/tests/ -v`
Expected: All tests pass

**Step 3: Run shopify-app tests**

Run: `cd /home/phil/Development/takebacks/thing-event-system/shopify-app && npx jest`
Expected: All tests pass

**Step 4: Manual sanity check**

Verify the Session class and `TESClient.session()` still work (unchanged):

```js
// This should still work — manual API preserved
const tes = new TESClient({ clientId: "x", apiKey: "tes_sk_x", endpoint: "https://example.com" });
const session = tes.session({ sessionId: "manual" });
// session.record(), session.emitChatTurn() still available
```
