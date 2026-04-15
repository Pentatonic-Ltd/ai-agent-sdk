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
  Run locally or use hosted TES. JavaScript &amp; Python.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@pentatonic-ai/ai-agent-sdk"><img src="https://img.shields.io/npm/v/@pentatonic-ai/ai-agent-sdk?style=flat-square&color=00fba9&label=npm" alt="npm"></a>
  <a href="https://pypi.org/project/pentatonic-ai-agent-sdk/"><img src="https://img.shields.io/pypi/v/pentatonic-ai-agent-sdk?style=flat-square&color=00fba9&label=pypi" alt="PyPI"></a>
  <a href="https://github.com/Pentatonic-Ltd/ai-agent-sdk/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Pentatonic-Ltd/ai-agent-sdk?style=flat-square&color=333" alt="License"></a>
</p>

---

## Table of Contents

- [Overview](#overview)
- [Local Memory (self-hosted)](#local-memory-self-hosted)
- [Hosted TES](#hosted-tes)
- [Claude Code Plugin](#claude-code-plugin)
- [OpenClaw Plugin](#openclaw-plugin)
- [SDK: Wrap Your LLM Client](#sdk-wrap-your-llm-client)
- [Supported Providers](#supported-providers)
- [API Reference](#api-reference)
- [Architecture](#architecture)

## Overview

Two ways to use the SDK:

**Local Memory** -- Run a fully private memory system on your own machine. PostgreSQL + pgvector + Ollama in Docker. No API keys, no cloud. Your agent gets persistent, searchable memory backed by multi-signal retrieval and HyDE query expansion.

**Hosted TES** -- Connect to Pentatonic's Thing Event System for production-grade observability, higher-dimensional embeddings, conversation analytics, and team-wide shared memory.

Both paths work with Claude Code and OpenClaw. The plugins auto-search on every prompt and auto-store every conversation turn.

## Local Memory (self-hosted)

Run the full memory stack locally. Requires Docker and ~4GB disk for models.

### 1. Set up

```bash
npx @pentatonic-ai/ai-agent-sdk memory
```

This starts PostgreSQL + pgvector, Ollama, and the memory server. It pulls embedding and chat models, and writes the local config.

### 2. Install the Claude Code plugin

```
/plugin marketplace add Pentatonic-Ltd/ai-agent-sdk
/plugin install tes-memory@pentatonic-ai
```

That's it. The plugin hooks automatically search memories on every prompt and store every conversation turn. Fully local, fully private.

### What you get

- **Automatic memory** -- every conversation turn is stored with embeddings and HyDE query expansion
- **Semantic search** -- multi-signal retrieval combining vector similarity, BM25 full-text, recency decay, and access frequency
- **Memory layers** -- episodic (recent), semantic (consolidated), procedural (how-to), working (temporary)
- **Decay and consolidation** -- memories fade over time; frequently accessed ones get promoted

### Change models

```bash
EMBEDDING_MODEL=mxbai-embed-large LLM_MODEL=qwen2.5:7b npx @pentatonic-ai/ai-agent-sdk memory
```

### Raspberry Pi

Pi 5 with 8GB RAM runs the full stack. `nomic-embed-text` (~300MB) + `llama3.2:3b` (~2GB) leaves plenty of headroom.

### Use as a library

```javascript
import { createMemorySystem } from '@pentatonic-ai/ai-agent-sdk/memory';

const memory = createMemorySystem({
  db: pgPool,
  embedding: { url: 'http://localhost:11434/v1', model: 'nomic-embed-text' },
  llm: { url: 'http://localhost:11434/v1', model: 'llama3.2:3b' },
});

await memory.migrate();
await memory.ensureLayers('my-app');
await memory.ingest('User prefers dark mode', { clientId: 'my-app' });
const results = await memory.search('preferences', { clientId: 'my-app' });
```

## Hosted TES

Connect to Pentatonic's hosted infrastructure for production use.

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

### What you get (in addition to local features)

- **Higher-dimensional embeddings** -- NV-Embed-v2 (4096d) for better retrieval accuracy
- **Conversation analytics** -- session metrics, search attribution, dead-end detection
- **Team-wide shared memory** -- semantic search across your team's AI interactions
- **Admin dashboard** -- visualize conversations, token usage, and memory explorer
- **Multi-tenancy** -- isolated databases per client

## Claude Code Plugin

Works with both local and hosted setups. Install once, switch modes via config.

### Install via marketplace

```
/plugin marketplace add Pentatonic-Ltd/ai-agent-sdk
/plugin install tes-memory@pentatonic-ai
```

### Set up

For hosted TES:
```
/tes-memory:tes-setup
```

For local memory:
```bash
npx @pentatonic-ai/ai-agent-sdk memory
```

### What it tracks

- **Every conversation turn** -- user messages, assistant responses, tool calls, duration
- **Automatic memory search** -- relevant memories injected as context on every prompt
- **Automatic memory storage** -- every turn stored with embeddings and HyDE queries
- **Token usage** -- input, output, cache read, cache creation tokens per turn

## OpenClaw Plugin

Works with both local and hosted setups. Just tell OpenClaw to set it up.

### Install

```bash
openclaw plugins install @pentatonic-ai/ai-agent-sdk
```

### Set up

Tell OpenClaw:

```
Set up pentatonic memory
```

The agent will ask whether you want **local** (private, Docker-based) or **hosted** (Pentatonic TES cloud), then walk you through the rest. For hosted mode, it handles account creation, email verification, and API key generation conversationally.

Or use the CLI directly:

```bash
openclaw pentatonic-memory local
```

### What it does

OpenClaw's context engine hooks fire on every lifecycle event:

- **Ingest** -- every user and assistant message is stored with embeddings and HyDE query expansion
- **Assemble** -- relevant memories are injected as system prompt context before every model run
- **Compact** -- decay cycle runs when the context window fills
- **After turn** -- high-access memories get consolidated to the semantic layer

Plus agent-callable tools: `memory_search`, `memory_store`, `memory_layers`.

### Configuration

After setup, config lives in `~/.openclaw/pentatonic-memory.json`. To switch modes, run setup again or edit directly.

You can also configure via `openclaw.json`:

```json
{
  "plugins": {
    "slots": { "contextEngine": "pentatonic-memory" },
    "entries": {
      "pentatonic-memory": {
        "enabled": true,
        "config": {
          "database_url": "postgres://memory:memory@localhost:5433/memory",
          "embedding_url": "http://localhost:11435/v1",
          "embedding_model": "nomic-embed-text",
          "llm_url": "http://localhost:11435/v1",
          "llm_model": "llama3.2:3b"
        }
      }
    }
  }
}
```

For hosted mode, replace the config block with:

```json
{
  "tes_endpoint": "https://your-company.api.pentatonic.com",
  "tes_client_id": "your-company",
  "tes_api_key": "tes_your-company_xxxxx"
}
```

## SDK: Wrap Your LLM Client

**JavaScript**

```js
import { TESClient } from "@pentatonic-ai/ai-agent-sdk";

const tes = new TESClient({
  clientId: process.env.TES_CLIENT_ID,
  apiKey: process.env.TES_API_KEY,
  endpoint: process.env.TES_ENDPOINT,
});

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

## Supported Providers

| Provider | Detection | Intercepted Method |
|----------|-----------|-------------------|
| OpenAI | `client.chat.completions.create` | `chat.completions.create()` |
| Anthropic | `client.messages.create` | `messages.create()` |
| Workers AI | `client.run` (JS only) | `run()` |

All other methods pass through unchanged.

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

### `session.emitChatTurn({ userMessage, assistantResponse, turnNumber? })`

Emits a `CHAT_TURN` event with accumulated data, then resets.

### `normalizeResponse(raw)`

Standalone utility to normalize any LLM response:

```js
import { normalizeResponse } from "@pentatonic-ai/ai-agent-sdk";

const { content, model, usage, toolCalls } = normalizeResponse(openaiResponse);
```

## Architecture

```
        +-------------------+     +-------------------+
        | Claude Code Plugin|     |  OpenClaw Plugin   |
        | (hooks: auto-     |     | (context engine:   |
        |  search + store)  |     |  ingest, assemble, |
        +--------+----------+     |  compact, tools)   |
                 |                +--------+----------+
                 |                         |
                 +------------+------------+
                              |
                  +-----------+-----------+
                  |                       |
            Local Memory            Hosted TES
            (Docker)                (Cloud)
                  |                       |
       +----+----+----+          +---+----+---+
       |    |    |    |          |   |    |   |
      PG  Ollama MCP HTTP      PG  R2  Queue Workers
      pgvector        API     pgvector       Modules
```

## License

MIT
