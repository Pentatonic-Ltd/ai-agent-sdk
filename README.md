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
- [Repository Onboarding (corpus ingest)](#repository-onboarding-corpus-ingest)
- [Claude Code Plugin](#claude-code-plugin)
- [OpenClaw Plugin](#openclaw-plugin)
- [SDK: Wrap Your LLM Client](#sdk-wrap-your-llm-client)
- [Supported Providers](#supported-providers)
- [API Reference](#api-reference)
- [Health Checks (`doctor`)](#health-checks-doctor)
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
- **Distilled memory** -- a background LLM pass extracts atomic facts from each raw turn and stores each as its own node in the semantic layer, linked back to the source. A query like *"what does Phil drink?"* matches *"Phil drinks cortado"* more reliably than a mixed paragraph covering food, drinks, and hobbies. Default-on; the raw turn is still preserved.
- **Decay and consolidation** -- memories fade over time; frequently accessed ones get promoted

> **Store latency note (v0.5.4+):** on the local memory server, `store_memory` now awaits distillation before returning instead of running it fire-and-forget. This fixed a bug where distillation was being killed mid-flight (atoms never got embeddings, so they were unreachable by semantic search), but it means stores now take as long as your configured LLM takes to produce atoms — typically 5–30s on `llama3.2:3b`, up to the `chat()` timeout ceiling (60s default, overridable via `opts.timeout`). Cloudflare Worker deployments pass `ctx.waitUntil` and still return fast. Set `opts.distill: false` on the ingest call if you want the old fast-return behaviour at the cost of no atoms.

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

## Repository Onboarding (corpus ingest)

The plugin's memory layer starts empty. To avoid the cold-start
problem where retrieval has nothing useful to return for the first
days of use, you can ingest your repos on day one:

```bash
# Interactive — picks repos, shows a cost preview, ingests, offers to install
# a git post-commit hook so memory stays current as you work
npx @pentatonic-ai/ai-agent-sdk onboard

# One-shot ingest of a single repo
npx @pentatonic-ai/ai-agent-sdk ingest ~/code/my-app

# See what's tracked and how big the corpus is
npx @pentatonic-ai/ai-agent-sdk status

# Delta-resync everything that's tracked (or one repo)
npx @pentatonic-ai/ai-agent-sdk resync

# Manage the tracked-repos list
npx @pentatonic-ai/ai-agent-sdk corpus list
npx @pentatonic-ai/ai-agent-sdk corpus remove ~/code/old-project
npx @pentatonic-ai/ai-agent-sdk corpus reset
```

Tenant credentials come from env vars (`TES_ENDPOINT`, `TES_CLIENT_ID`,
`TES_API_KEY`) or `~/.config/tes/credentials.json` if you used
`npx @pentatonic-ai/ai-agent-sdk init`.

### What gets ingested, what doesn't

The walker honors `.gitignore` and `.tesignore`, plus a hard-exclude
list for secrets and credentials that **cannot be overridden** even
with `!pattern` rules:

- `.env*` (any environment file)
- `*.pem`, `*.key`, `*.crt`, `*.p12`, `*.pfx`, `*.jks`
- `id_rsa`, `id_ed25519`, `id_ecdsa`, `id_dsa` (SSH private keys)
- `.ssh/`, `.aws/`, `.gcp/`, `.azure/` (whole directories)
- `.npmrc`, `.pypirc`, `.netrc`
- `secrets/`, `credentials/`, `service-account.*`
- `*_secret*`, `*_token*`, `*_password*`

Plus directory-level skips: `node_modules`, `dist`, `build`, `.next`,
`venv`, `__pycache__`, `target`, `.terraform`, etc. And extension
skips for binaries, lockfiles, and minified output.

### How it stays current

If you accept the prompt during `onboard`, a git post-commit hook is
installed at `.git/hooks/post-commit` that re-ingests files changed
in each commit. The hook is non-fatal — it never blocks a commit.
Install manually any time with:

```bash
npx @pentatonic-ai/ai-agent-sdk install-git-hook
```

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
openclaw plugins install @pentatonic-ai/openclaw-memory-plugin
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

- **Ingest** -- every user and assistant message is stored with embeddings and HyDE query expansion, then distilled into atomic facts in the background (see [Distilled memory](#what-you-get))
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

## Health Checks (`doctor`)

Run a full health check of your SDK install at any time:

```bash
npx @pentatonic-ai/ai-agent-sdk doctor
```

`doctor` auto-detects which install path you're on (Local Memory, Hosted
TES, or self-hosted Pentatonic platform) and runs only the checks that
apply. Exit code is `0` for all-clear, `1` for warnings, `2` for critical.

Common flags:

```bash
npx @pentatonic-ai/ai-agent-sdk doctor --json     # machine-readable
npx @pentatonic-ai/ai-agent-sdk doctor --alert    # silent unless issues
npx @pentatonic-ai/ai-agent-sdk doctor --no-plugins
npx @pentatonic-ai/ai-agent-sdk doctor --path local
```

What gets checked:

- **Universal** — Node version, disk space, SDK config-file permissions
- **Local Memory** — Postgres + pgvector + migrations, embedding/LLM
  endpoints, memory server port
- **Hosted TES** — endpoint reachable, API key authenticates
- **Self-hosted platform** — HybridRAG, Qdrant, Neo4j, vLLM (each
  optional, skipped when its env var is unset)

### Plugins

Drop a `.mjs` file into `~/.config/pentatonic-ai/doctor-plugins/` to add
your own checks. Useful for app-specific things — internal APIs, ingest
freshness, custom infrastructure — without forking the SDK.

```js
// ~/.config/pentatonic-ai/doctor-plugins/my-app.mjs
export default {
  name: "my-app",
  checks: [
    {
      name: "internal API",
      severity: "warning",
      run: async () => {
        const res = await fetch("https://internal/health");
        return res.ok
          ? { ok: true, msg: "200 OK" }
          : { ok: false, msg: `HTTP ${res.status}` };
      },
    },
  ],
};
```

See [`packages/doctor/README.md`](packages/doctor/README.md) for the full
plugin contract and programmatic API.

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
