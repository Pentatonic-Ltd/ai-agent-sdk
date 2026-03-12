# @pentatonic/ai

LLM observability SDK — track token usage, tool calls, and conversations via [Pentatonic TES](https://pentatonic.com).

Provider-agnostic: works with OpenAI, Anthropic, Cloudflare Workers AI, or any OpenAI-compatible API.

## Install

```bash
npm install @pentatonic/ai
```

## Quick Start

```js
import { TESClient } from "@pentatonic/ai";

const tes = new TESClient({
  clientId: "my-app",
  apiKey: process.env.TES_API_KEY,
  endpoint: "https://your-tes-instance.example.com",
});
```

### Option A: Wrap an OpenAI-compatible client (automatic tracking)

```js
import OpenAI from "openai";

const openai = tes.wrap(new OpenAI());

// Every call is automatically tracked and emitted as a CHAT_TURN event
const result = await openai.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Hello!" }],
});
```

### Option B: Manual session (full control)

```js
const session = tes.session({
  sessionId: "conv-123",
  metadata: { userId: "u_456" },
});

// Call your LLM however you like
const response = await openai.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "What is 2+2?" }],
});

// Record the response (accumulates tokens, tool calls, model)
session.record(response);

// Emit when the turn is complete
await session.emitChatTurn({
  userMessage: "What is 2+2?",
  assistantResponse: response.choices[0].message.content,
});
```

### Multi-round conversations

```js
const session = tes.session({ sessionId: "conv-789" });

for (const userMsg of userMessages) {
  const res = await openai.chat.completions.create({ model: "gpt-4o", messages });
  session.record(res); // accumulates across rounds

  // If the model called tools, handle them and call again
  // session.record() tracks each round's tokens and tool calls
}

// Emit once at the end — includes totals from all rounds
await session.emitChatTurn({
  userMessage: userMessages.at(-1),
  assistantResponse: finalResponse,
});
```

### Wrapped session (auto-record per call)

```js
const ai = tes.wrap(new OpenAI());
const session = ai.session({ sessionId: "conv-101" });

// .chat() calls the LLM and records the response automatically
const r1 = await session.chat({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Recommend a shoe" }],
});

const r2 = await session.chat({
  model: "gpt-4o",
  messages: [...messages, { role: "user", content: "In blue?" }],
});

await session.emitChatTurn({
  userMessage: "In blue?",
  assistantResponse: r2.choices[0].message.content,
});
```

## API Reference

### `new TESClient({ clientId, apiKey, endpoint })`

Creates a new client. All three parameters are required.

| Param | Type | Description |
|-------|------|-------------|
| `clientId` | `string` | Your application/tenant identifier |
| `apiKey` | `string` | TES service API key |
| `endpoint` | `string` | TES instance URL (e.g. `https://tes.example.com`) |

### `tes.session(opts?)`

Returns a `Session` instance.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `sessionId` | `string` | `crypto.randomUUID()` | Conversation/session identifier |
| `metadata` | `object` | `{}` | Extra fields included in every emitted event |

### `tes.wrap(openaiClient)`

Returns a Proxy around an OpenAI-compatible client. Intercepts `chat.completions.create` to auto-track usage. All other methods/properties pass through unchanged.

The wrapped client also exposes `.session(opts)` for multi-round tracking.

### `session.record(rawResponse)`

Normalizes an LLM response and accumulates token usage, tool calls, and model info. Accepts responses from OpenAI, Anthropic, or Workers AI format. Returns the normalized response.

### `session.emitChatTurn({ userMessage, assistantResponse, turnNumber? })`

Sends a `CHAT_TURN` event to TES with accumulated usage data, then resets counters.

### `session.emitToolUse({ tool, args, resultSummary?, durationMs?, turnNumber? })`

Sends a `TOOL_USE` event for individual tool invocations.

### `session.emitSessionStart()`

Sends a `SESSION_START` event.

### `session.totalUsage`

Returns current accumulated usage: `{ prompt_tokens, completion_tokens, total_tokens, ai_rounds }`.

### `normalizeResponse(raw)`

Standalone utility to normalize any LLM response into a consistent shape:

```js
import { normalizeResponse } from "@pentatonic/ai";

const normalized = normalizeResponse(openaiResponse);
// { content, model, usage: { prompt_tokens, completion_tokens }, toolCalls: [{ tool, args }] }
```

## Events Emitted

All events are sent to the TES GraphQL API (`emitEvent` mutation) authenticated via `x-service-key` and `x-client-id` headers.

| Event Type | Entity Type | When |
|------------|-------------|------|
| `CHAT_TURN` | `conversation` | After each complete user-assistant exchange |
| `TOOL_USE` | `conversation` | After individual tool invocations |
| `SESSION_START` | `conversation` | At conversation start (optional) |

## Supported LLM Formats

Response normalization auto-detects the provider format:

| Provider | Detection | Content field |
|----------|-----------|---------------|
| **OpenAI** | `choices[].message` | `choices[0].message.content` |
| **Anthropic** | `content[]` array with `type` | Text blocks joined |
| **Workers AI** | `response` string | `response` |

## Security Notes

- **API key handling:** The TES API key is sent via `x-service-key` header over HTTPS. Ensure your `endpoint` uses HTTPS in production.
- **Content transmission:** User messages and assistant responses are sent to TES for observability. Do not use this SDK if your use case prohibits transmitting conversation content to a third-party endpoint.
- **No runtime dependencies:** Zero external dependencies — only `esbuild` and `jest` in devDependencies.

## License

MIT
