<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Pentatonic-Ltd/ai-agent-sdk/main/.github/logo-light.svg">
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/Pentatonic-Ltd/ai-agent-sdk/main/.github/logo-dark.svg">
    <img alt="Pentatonic" src="https://raw.githubusercontent.com/Pentatonic-Ltd/ai-agent-sdk/main/.github/logo-dark.svg" width="200">
  </picture>
</p>

<h3 align="center">AI Agent SDK</h3>

<p align="center">
  Observability, memory, and analytics for LLM applications.<br>
  Provider-agnostic. JavaScript &amp; Python.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@pentatonic-ai/ai-agent-sdk"><img src="https://img.shields.io/npm/v/@pentatonic-ai/ai-agent-sdk?style=flat-square&color=00fba9&label=npm" alt="npm"></a>
  <a href="https://pypi.org/project/pentatonic-ai-agent-sdk/"><img src="https://img.shields.io/pypi/v/pentatonic-ai-agent-sdk?style=flat-square&color=00fba9&label=pypi" alt="PyPI"></a>
  <a href="https://github.com/Pentatonic-Ltd/ai-agent-sdk/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Pentatonic-Ltd/ai-agent-sdk?style=flat-square&color=333" alt="License"></a>
</p>

---

## Overview

The Pentatonic AI Agent SDK instruments your LLM applications with zero-config observability. Wrap any OpenAI, Anthropic, or Cloudflare Workers AI client and get:

- **Conversation tracking** -- every LLM call emits structured events (token usage, tool calls, model, latency)
- **Shared memory** -- semantic search across your team's AI interactions
- **Session analytics** -- conversation flows, dead-end detection, search-to-click metrics
- **Pattern detection** -- Bayesian analysis of recurring behaviors across your event stream
- **Claude Code plugin** -- automatic tracking for Claude Code sessions via hooks

## Quick Start

### 1. Create an account

```bash
npx @pentatonic-ai/ai-agent-sdk init
```

This walks you through account creation, email verification, and API key generation. You'll get:

```
TES_ENDPOINT=https://your-company.api.pentatonic.com
TES_CLIENT_ID=your-company
TES_API_KEY=tes_your-company_xxxxx
```

### 2. Install

```bash
npm install @pentatonic-ai/ai-agent-sdk
```

```bash
pip install pentatonic-ai-agent-sdk
```

### 3. Wrap your LLM client

**JavaScript**

```js
import { TESClient } from "@pentatonic-ai/ai-agent-sdk";

const tes = new TESClient({
  clientId: process.env.TES_CLIENT_ID,
  apiKey: process.env.TES_API_KEY,
  endpoint: process.env.TES_ENDPOINT,
});

// Auto-instruments every create() call
const ai = tes.wrap(new OpenAI(), { sessionId: "conv-123" });
const result = await ai.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Hello!" }],
});
```

**Python**

```python
from pentatonic_agent_events import TESClient

tes = TESClient(
    client_id=os.environ["TES_CLIENT_ID"],
    api_key=os.environ["TES_API_KEY"],
    endpoint=os.environ["TES_ENDPOINT"],
)

ai = tes.wrap(OpenAI(), session_id="conv-123")
result = ai.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "Hello!"}],
)
```

That's it. Every call emits a `CHAT_TURN` event with token usage, tool calls, and model info.

## Supported Providers

| Provider | Detection | Intercepted Method |
|----------|-----------|-------------------|
| OpenAI | `client.chat.completions.create` | `chat.completions.create()` |
| Anthropic | `client.messages.create` | `messages.create()` |
| Workers AI | `client.run` (JS only) | `run()` |

All other methods pass through unchanged.

## Tool-Calling Loops

For multi-round tool loops, just keep calling the wrapped client. Each call emits its own event, linked by `sessionId`:

```js
const ai = tes.wrap(new OpenAI(), { sessionId: "conv-101" });

// Round 1: AI requests a tool call
const r1 = await ai.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Find me running shoes" }],
  tools: [searchTool],
});

// Execute tool, feed results back...

// Round 2: AI responds with final answer
const r2 = await ai.chat.completions.create({
  model: "gpt-4o",
  messages: [...messages, { role: "tool", content: toolResult }],
});

// No manual emit needed. Both events share sessionId "conv-101".
```

## Manual Session Control

If you need full control over when events are emitted:

```js
const session = tes.session({ sessionId: "conv-123" });

const response = await openai.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "What is 2+2?" }],
});

session.record(response);
await session.emitChatTurn({
  userMessage: "What is 2+2?",
  assistantResponse: response.choices[0].message.content,
});
```

## Claude Code Plugin

Track every Claude Code conversation automatically with shared team memory.

### Install via marketplace

```
/plugin marketplace add Pentatonic-Ltd/ai-agent-sdk
```

```
/plugin install tes-memory@pentatonic-ai
```

### Set up your account

```
/tes-memory:tes-setup
```

This runs the SDK init, creates your account, and configures the plugin credentials.

### Or install manually

```bash
git clone https://github.com/Pentatonic-Ltd/ai-agent-sdk.git ~/.claude-plugins/tes-memory
claude --plugin-dir ~/.claude-plugins/tes-memory
```

### What it tracks

- **Every conversation turn** -- user messages, assistant responses, tool calls, duration
- **Session lifecycle** -- start/end events with total turns and tool usage stats
- **Shared memory** -- `search_memories` and `store_memory` MCP tools for team knowledge
- **Per-module security** -- events scoped to specific modules with permission checks

## API Reference

### `TESClient(config)`

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `clientId` | `string` | required | Your tenant identifier |
| `apiKey` | `string` | required | TES API key |
| `endpoint` | `string` | required | TES instance URL |
| `userId` | `string` | `null` | User identifier for attribution |
| `captureContent` | `boolean` | `true` | Include message content in events |
| `maxContentLength` | `number` | `4096` | Truncate content beyond this length |

### `tes.wrap(client, opts?)`

Returns an instrumented proxy. Every intercepted call emits a `CHAT_TURN` event.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `sessionId` | `string` | auto-generated UUID | Links events from the same conversation |
| `metadata` | `object` | `{}` | Custom fields on every event |

### `tes.session(opts?)`

Returns a `Session` for manual event emission.

### `session.record(response)`

Normalizes an LLM response and accumulates token usage and tool calls.

### `session.emitChatTurn({ userMessage, assistantResponse, turnNumber? })`

Emits a `CHAT_TURN` event with accumulated data, then resets.

### `session.emitToolUse({ tool, args, resultSummary?, durationMs? })`

Emits a `TOOL_USE` event for individual tool invocations.

### `session.emitSessionStart()`

Emits a `SESSION_START` event.

### `normalizeResponse(raw)`

Standalone utility to normalize any LLM response:

```js
import { normalizeResponse } from "@pentatonic-ai/ai-agent-sdk";

const { content, model, usage, toolCalls } = normalizeResponse(openaiResponse);
```

## Architecture

```
Your App --> SDK (wrap/session) --> TES API --> Event Queue
                                                   |
                                    +--------------+--------------+
                                    |              |              |
                                 Storage      Deep Memory    Analytics
                                (Postgres)   (Embeddings)   (Patterns)
```

Events flow through a queue-based pipeline. Each module processes events independently:
- **Event Storage** -- append-only event log + entity projections
- **Deep Memory** -- extracts memories, generates embeddings, enables semantic search
- **Conversation Analytics** -- session metrics, search attribution, dead-end detection
- **Bias Pattern Evolution** -- Bayesian pattern detection across your event stream
- **Predictive Modelling** -- demand forecasts and supply network analytics

## License

MIT
