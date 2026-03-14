# @pentatonic-ai/agent-events

LLM observability SDK — track token usage, tool calls, and conversations via [Pentatonic TES](https://api.pentatonic.com).

Provider-agnostic: automatically wraps OpenAI, Anthropic, and Cloudflare Workers AI clients. Available for both **JavaScript** and **Python**.

## Getting Started

### 1. Create an account and get your API key

```bash
npx @pentatonic-ai/agent-events init
```

This will walk you through:
- Creating a Pentatonic account (email, company name, password)
- Choosing a data region (EU or US)
- Email verification
- Generating your API key

At the end you'll see your credentials:

```
TES_ENDPOINT=https://api.pentatonic.com
TES_CLIENT_ID=your-company
TES_API_KEY=tes_your-company_xxxxx
```

Add these to your environment (`.env`, secrets manager, etc.) and the CLI will install the SDK for you.

### 2. Or install manually

If you already have an account, install the SDK directly:

```bash
npm install @pentatonic-ai/agent-events
```

```bash
pip install pentatonic-agent-events
```

You can create API keys in the [Pentatonic dashboard](https://api.pentatonic.com).

## Quick Start

#### JavaScript

```js
import { TESClient } from "@pentatonic-ai/agent-events";

const tes = new TESClient({
  clientId: process.env.TES_CLIENT_ID,
  apiKey: process.env.TES_API_KEY,
  endpoint: process.env.TES_ENDPOINT,
});
```

#### Python

```python
from pentatonic_agent_events import TESClient
import os

tes = TESClient(
    client_id=os.environ["TES_CLIENT_ID"],
    api_key=os.environ["TES_API_KEY"],
    endpoint=os.environ["TES_ENDPOINT"],
)
```

### Wrap any LLM client (automatic tracking)

`tes.wrap()` auto-detects your client and intercepts every call — each one emits a `CHAT_TURN` event automatically. Pass an optional `sessionId` to link events from the same conversation, and `metadata` to attach custom fields.

#### JavaScript — OpenAI

```js
import OpenAI from "openai";

const ai = tes.wrap(new OpenAI(), { sessionId: "conv-123", metadata: { userId: "u_1" } });

// Every create() call automatically emits a CHAT_TURN event
const result = await ai.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Hello!" }],
});

ai.sessionId; // "conv-123" — or auto-generated UUID if not provided
```

#### Python — OpenAI

```python
from openai import OpenAI

ai = tes.wrap(OpenAI(), session_id="conv-123", metadata={"user_id": "u_1"})

# Every create() call automatically emits a CHAT_TURN event
result = ai.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "Hello!"}],
)

ai.session_id  # "conv-123" — or auto-generated UUID if not provided
```

#### JavaScript — Anthropic

```js
import Anthropic from "@anthropic-ai/sdk";

const claude = tes.wrap(new Anthropic());

const result = await claude.messages.create({
  model: "claude-sonnet-4-6-20250514",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Hello!" }],
});
```

#### Python — Anthropic

```python
from anthropic import Anthropic

claude = tes.wrap(Anthropic())

result = claude.messages.create(
    model="claude-sonnet-4-6-20250514",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}],
)
```

#### JavaScript — Cloudflare Workers AI

```js
// Cloudflare Workers AI binding
const ai = tes.wrap(env.AI, { sessionId: sid, metadata: { shop: shopDomain } });

// run() is intercepted automatically
const result = await ai.run("@cf/meta/llama-3.1-8b-instruct", {
  messages: [{ role: "user", content: "Hello!" }],
});
```

> **Note:** Workers AI is a Cloudflare-specific binding and is only available in JavaScript.

### Tool-calling loops

For multi-round tool loops, just keep calling the wrapped client. Each `create()`/`run()` call emits its own event, and they're linked by `sessionId`. The dashboard aggregates tokens, tool calls, and turns per session automatically.

#### JavaScript

```js
const ai = tes.wrap(new OpenAI(), { sessionId: "conv-101" });

// Round 1: AI requests a tool call — emits event with tool_calls
const r1 = await ai.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Find me running shoes" }],
  tools: [searchTool],
});

// Execute tool, feed results back...

// Round 2: AI responds with final answer — emits another event
const r2 = await ai.chat.completions.create({
  model: "gpt-4o",
  messages: [...messages, { role: "tool", content: toolResult }],
});

// That's it. No manual emit needed. Both events share sessionId "conv-101".
```

#### Python

```python
ai = tes.wrap(OpenAI(), session_id="conv-101")

r1 = ai.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "Find me running shoes"}],
    tools=[search_tool],
)

# Execute tool, feed results back...

r2 = ai.chat.completions.create(
    model="gpt-4o",
    messages=[*messages, {"role": "tool", "content": tool_result}],
)

# No manual emit needed.
```

### Manual session (full control)

If you don't want to use `tes.wrap()`, create a session directly:

#### JavaScript

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

#### Python

```python
session = tes.session(
    session_id="conv-123",
    metadata={"user_id": "u_456"},
)

response = openai.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "What is 2+2?"}],
)

session.record(response)

session.emit_chat_turn(
    user_message="What is 2+2?",
    assistant_response=response["choices"][0]["message"]["content"],
)
```

## API Reference

### `TESClient`

Creates a new client.

#### JavaScript

```js
new TESClient({ clientId, apiKey, endpoint, headers?, captureContent?, maxContentLength? })
```

#### Python

```python
TESClient(client_id, api_key, endpoint, headers=None, capture_content=True, max_content_length=4096)
```

| Param (JS / Python) | Type | Default | Description |
|----------------------|------|---------|-------------|
| `clientId` / `client_id` | `string` | *required* | Your application/tenant identifier |
| `apiKey` / `api_key` | `string` | *required* | TES service API key (sent as `x-service-key` header) |
| `endpoint` / `endpoint` | `string` | *required* | TES instance URL (must be `https://`, except `localhost` for dev) |
| `headers` / `headers` | `object` / `dict` | `{}` | Additional headers to include in every request |
| `captureContent` / `capture_content` | `boolean` / `bool` | `true` / `True` | Whether to include message content in events |
| `maxContentLength` / `max_content_length` | `number` / `int` | `4096` | Truncate content beyond this length |

### `tes.wrap(client, opts?)`

Returns a Proxy (JS) or wrapper (Python) around any supported LLM client. Every intercepted call emits a `CHAT_TURN` event automatically.

#### JavaScript

```js
const ai = tes.wrap(client, { sessionId, metadata });
```

#### Python

```python
ai = tes.wrap(client, session_id=None, metadata=None)
```

| Option (JS / Python) | Type | Default | Description |
|----------------------|------|---------|-------------|
| `sessionId` / `session_id` | `string` | `crypto.randomUUID()` / `uuid.uuid4()` | Links events from the same conversation |
| `metadata` / `metadata` | `object` / `dict` | `{}` | Custom fields included in every emitted event |

Auto-detects the provider:

| Client | Detection | Intercepted method |
|--------|-----------|-------------------|
| OpenAI | `client.chat.completions.create` | `chat.completions.create()` |
| Anthropic | `client.messages.create` | `messages.create()` |
| Workers AI | `client.run` (JS only) | `run()` |

All other methods/properties pass through unchanged. The wrapped client exposes `ai.sessionId` (JS) or `ai.session_id` (Python).

### `tes.session(opts?)`

Returns a `Session` instance.

| Option (JS / Python) | Type | Default | Description |
|----------------------|------|---------|-------------|
| `sessionId` / `session_id` | `string` | `crypto.randomUUID()` / `uuid.uuid4()` | Conversation/session identifier |
| `metadata` / `metadata` | `object` / `dict` | `{}` | Extra fields included in every emitted event |

### `session.record(rawResponse)`

Normalizes an LLM response and accumulates token usage, tool calls, and model info. Accepts responses from any supported provider. Returns the normalized response.

### `session.emitChatTurn()` / `session.emit_chat_turn()`

Sends a `CHAT_TURN` event to TES with accumulated usage data, then resets counters.

| Param (JS / Python) | Type | Description |
|---------------------|------|-------------|
| `userMessage` / `user_message` | `string` | The user's message |
| `assistantResponse` / `assistant_response` | `string` | The assistant's response |
| `turnNumber` / `turn_number` | `number` / `int` | Optional turn number |

### `session.emitToolUse()` / `session.emit_tool_use()`

Sends a `TOOL_USE` event for individual tool invocations.

| Param (JS / Python) | Type | Description |
|---------------------|------|-------------|
| `tool` / `tool` | `string` | Tool name |
| `args` / `args` | `object` / `dict` | Tool arguments |
| `resultSummary` / `result_summary` | `string` | Optional result summary |
| `durationMs` / `duration_ms` | `number` / `int` | Optional duration in milliseconds |
| `turnNumber` / `turn_number` | `number` / `int` | Optional turn number |

### `session.emitSessionStart()` / `session.emit_session_start()`

Sends a `SESSION_START` event.

### `session.totalUsage` / `session.total_usage`

Returns current accumulated usage: `{ prompt_tokens, completion_tokens, total_tokens, ai_rounds }`.

### `normalizeResponse(raw)` / `normalize_response(raw)`

Standalone utility to normalize any LLM response into a consistent shape:

#### JavaScript

```js
import { normalizeResponse } from "@pentatonic-ai/agent-events";

const normalized = normalizeResponse(openaiResponse);
// { content, model, usage: { prompt_tokens, completion_tokens }, toolCalls: [{ tool, args }] }
```

#### Python

```python
from pentatonic_agent_events import normalize_response

normalized = normalize_response(openai_response)
# { "content", "model", "usage": { "prompt_tokens", "completion_tokens" }, "tool_calls": [{ "tool", "args" }] }
```

> **Note:** In Python, the normalized response uses `tool_calls` (snake_case) instead of `toolCalls` (camelCase).

## Events Emitted

All events are sent to the TES GraphQL API (`emitEvent` mutation) authenticated via `x-service-key` and `x-client-id` headers.

| Event Type | Entity Type | When |
|------------|-------------|------|
| `CHAT_TURN` | `conversation` | Every `create()`/`run()` call via `wrap()`, or manually via `session.emitChatTurn()` |
| `TOOL_USE` | `conversation` | Via `session.emitToolUse()` (manual only) |
| `SESSION_START` | `conversation` | Via `session.emitSessionStart()` (manual only) |

## Supported Providers

| Provider | Auto-wrap | Manual session | Response normalization |
|----------|-----------|---------------|----------------------|
| **OpenAI** (and compatible: Azure, Groq, Together, Mistral) | JS + Python | JS + Python | JS + Python |
| **Anthropic** | JS + Python | JS + Python | JS + Python |
| **Cloudflare Workers AI** | JS only | JS only | JS + Python |

## Security

- **HTTPS enforced:** The SDK rejects non-HTTPS endpoints (except `localhost` for development)
- **API key protection:** Stored as a non-enumerable property (JS) or private attribute (Python) — won't appear in `JSON.stringify`, `repr()`, or error reporters
- **Content controls:** Set `captureContent: false` (JS) or `capture_content=False` (Python) to omit message content from events, or use `maxContentLength` / `max_content_length` to truncate
- **No runtime dependencies:** Both the JavaScript and Python SDKs have zero external runtime dependencies

## License

MIT
