# @pentatonic/ai-events-sdk

LLM observability SDK — track token usage, tool calls, and conversations via [Pentatonic TES](https://api.pentatonic.com).

Provider-agnostic: automatically wraps OpenAI, Anthropic, and Cloudflare Workers AI clients.

## Install

```bash
npm install @pentatonic/ai-events-sdk
```

## Quick Start

```js
import { TESClient } from "@pentatonic/ai-events-sdk";

const tes = new TESClient({
  clientId: "my-app",
  apiKey: process.env.TES_API_KEY,
  endpoint: "https://your-tes-instance.example.com",
});
```

### Wrap any LLM client (automatic tracking)

`tes.wrap()` auto-detects your client and intercepts the right method — no configuration needed.

```js
import OpenAI from "openai";

const openai = tes.wrap(new OpenAI());

// Automatically tracked and emitted as a CHAT_TURN event
const result = await openai.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Hello!" }],
});
```

```js
import Anthropic from "@anthropic-ai/sdk";

const claude = tes.wrap(new Anthropic());

// Same automatic tracking — messages.create is intercepted
const result = await claude.messages.create({
  model: "claude-sonnet-4-6-20250514",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Hello!" }],
});
```

```js
// Cloudflare Workers AI binding
const ai = tes.wrap(env.AI);

// run() is intercepted automatically
const result = await ai.run("@cf/meta/llama-3.1-8b-instruct", {
  messages: [{ role: "user", content: "Hello!" }],
});
```

### Multi-round sessions

For tool-calling loops or multi-turn conversations, use a session to accumulate usage across rounds:

```js
const openai = tes.wrap(new OpenAI());
const session = openai.session({ sessionId: "conv-101" });

// .chat() calls the LLM and records the response automatically
const r1 = await session.chat({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Recommend a shoe" }],
});

// Handle tool calls, continue the conversation...
const r2 = await session.chat({
  model: "gpt-4o",
  messages: [...messages, { role: "user", content: "In blue?" }],
});

// Emit once — includes totals from all rounds
await session.emitChatTurn({
  userMessage: "In blue?",
  assistantResponse: r2.choices[0].message.content,
});
```

Session method varies by provider:

| Provider | Session call |
|----------|-------------|
| OpenAI | `session.chat(params)` |
| Anthropic | `session.chat(params)` |
| Workers AI | `session.chat(model, params)` |

### Manual session (full control)

If you don't want to use `tes.wrap()`, create a session directly:

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

## API Reference

### `new TESClient({ clientId, apiKey, endpoint, captureContent?, maxContentLength? })`

Creates a new client.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `clientId` | `string` | *required* | Your application/tenant identifier |
| `apiKey` | `string` | *required* | TES service API key |
| `endpoint` | `string` | *required* | TES instance URL (must be `https://`, except `localhost` for dev) |
| `captureContent` | `boolean` | `true` | Whether to include message content in events |
| `maxContentLength` | `number` | `4096` | Truncate content beyond this length |

### `tes.wrap(client)`

Returns a Proxy around any supported LLM client. Auto-detects the provider:

| Client | Detection | Intercepted method |
|--------|-----------|-------------------|
| OpenAI | `client.chat.completions.create` | `chat.completions.create()` |
| Anthropic | `client.messages.create` | `messages.create()` |
| Workers AI | `client.run` | `run()` |

All other methods/properties pass through unchanged. The wrapped client also exposes `.session(opts)` for multi-round tracking.

### `tes.session(opts?)`

Returns a `Session` instance.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `sessionId` | `string` | `crypto.randomUUID()` | Conversation/session identifier |
| `metadata` | `object` | `{}` | Extra fields included in every emitted event |

### `session.record(rawResponse)`

Normalizes an LLM response and accumulates token usage, tool calls, and model info. Accepts responses from any supported provider. Returns the normalized response.

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
import { normalizeResponse } from "@pentatonic/ai-events-sdk";

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

## Supported Providers

| Provider | Auto-wrap | Manual session | Response normalization |
|----------|-----------|---------------|----------------------|
| **OpenAI** (and compatible: Azure, Groq, Together, Mistral) | Yes | Yes | Yes |
| **Anthropic** | Yes | Yes | Yes |
| **Cloudflare Workers AI** | Yes | Yes | Yes |

## Security

- **HTTPS enforced:** The SDK rejects non-HTTPS endpoints (except `localhost` for development)
- **API key protection:** Stored as a non-enumerable property — won't appear in `JSON.stringify` or error reporters
- **Content controls:** Set `captureContent: false` to omit message content from events, or use `maxContentLength` to truncate
- **No runtime dependencies:** Zero external dependencies

## License

MIT
