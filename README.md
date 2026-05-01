<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Pentatonic-Ltd/ai-agent-sdk/main/.github/logo-light.svg">
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/Pentatonic-Ltd/ai-agent-sdk/main/.github/logo-dark.svg">
    <img alt="Pentatonic" src="https://raw.githubusercontent.com/Pentatonic-Ltd/ai-agent-sdk/main/.github/logo-dark.svg" width="200">
  </picture>
</p>

<h3 align="center">Pentatonic AI Agent SDK</h3>

<p align="center">
  Memory and observability for AI agents.<br>
  Two products on one platform (TES). One install. JavaScript &amp; Python.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@pentatonic-ai/ai-agent-sdk"><img src="https://img.shields.io/npm/v/@pentatonic-ai/ai-agent-sdk?style=flat-square&color=00fba9&label=npm" alt="npm"></a>
  <a href="https://pypi.org/project/pentatonic-ai-agent-sdk/"><img src="https://img.shields.io/pypi/v/pentatonic-ai-agent-sdk?style=flat-square&color=00fba9&label=pypi" alt="PyPI"></a>
  <a href="https://github.com/Pentatonic-Ltd/ai-agent-sdk/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Pentatonic-Ltd/ai-agent-sdk?style=flat-square&color=333" alt="License"></a>
</p>

---

## What's in this SDK

Two products that share one TES account, one install line, and one dashboard:

| Product | What it does | When you want it |
|---|---|---|
| **Memory** | Persistent, searchable memory for your AI agent — semantic + keyword retrieval, distillation, decay, repo onboarding. Runs locally (Docker) or hosted (TES). | You want your agent to remember conversations, preferences, and codebase context across sessions. |
| **Observability** | Wrap your LLM client and capture every call — tokens, tool calls, latency, content. Events flow to TES for the dashboard, analytics, and search attribution. | You want to know what your agent is actually doing in production. |

Both products are sold separately, but you can use either, both, or neither. Plugins for **Claude Code** and **OpenClaw** install everything at once if you'd rather skip the SDK glue.

## Pick your path

- 🧠 **I want memory in my agent** → [Memory](#memory)
- 📊 **I want to instrument my LLM calls** → [Observability](#observability)
- 🔌 **I'm using Claude Code or OpenClaw** → [Plugins](#plugins)
- 📂 **I want to seed memory from my codebase or docs** → [Repository onboarding](#repository-onboarding-corpus-ingest)
- 🩺 **I want to check my install** → [Health checks (`doctor`)](#health-checks-doctor)

## Table of Contents

- [TES — the platform](#tes--the-platform)
- [Memory](#memory)
  - [Hosted (cloud)](#hosted-cloud)
  - [Local (self-hosted)](#local-self-hosted)
  - [Use as a library](#use-as-a-library)
  - [Distilled memory](#distilled-memory)
- [Observability](#observability)
  - [Wrap your LLM client](#wrap-your-llm-client)
  - [Supported providers](#supported-providers)
- [Plugins](#plugins)
  - [Claude Code](#claude-code)
  - [OpenClaw](#openclaw)
- [Repository Onboarding (corpus ingest)](#repository-onboarding-corpus-ingest)
- [API Reference](#api-reference)
- [Health Checks (`doctor`)](#health-checks-doctor)
- [Architecture](#architecture)

---

## TES — the platform

**TES** (Thing Event System) is Pentatonic's account-and-events backbone. Both products in this SDK run on it: memory writes/queries land in TES, observability events stream to it, and the dashboard reads from it.

You only need a TES account if you're using **hosted memory** or **observability** (observability always sends events to TES). **Local memory** runs entirely on your machine and needs no TES account.

```bash
# One-time: open browser, sign in or sign up, get API keys
npx @pentatonic-ai/ai-agent-sdk login
```

`login` opens your browser at the hosted sign-in page. New users click "Sign up" to create a tenant (clientId + region + email + password). After verification the CLI writes credentials to `~/.config/tes/credentials.json` (mode 0600). The Claude Code plugin, OpenClaw plugin, hooks, and corpus CLI all auto-discover this file — no manual paste step.

```
✓ Connected as you@example.com on tenant `your-clientid`
✓ Credentials written to ~/.config/tes/credentials.json
```

To check connection state later: `npx @pentatonic-ai/ai-agent-sdk whoami`. To point at a local TES dev instance: `npx @pentatonic-ai/ai-agent-sdk login --endpoint http://localhost:8788`.

(`init` still works as a one-major-release deprecation alias for `login`.)

---

## Memory

Persistent, searchable memory for AI agents. Multi-signal retrieval (vector + BM25 + recency + frequency), HyDE query expansion, atomic-fact distillation, and four memory layers (episodic, semantic, procedural, working).

Two deployment modes — same API, same plugins, same library:

### Hosted (cloud)

Run on Pentatonic's infrastructure. Higher-dimensional embeddings (NV-Embed-v2, 4096d), per-tenant Postgres, team-wide shared memory, the dashboard.

```bash
# 1. Get a TES account (see [TES — the platform](#tes--the-platform))
npx @pentatonic-ai/ai-agent-sdk login

# 2. Install the SDK
npm install @pentatonic-ai/ai-agent-sdk
# or: pip install pentatonic-ai-agent-sdk
```

That's it — memory operations now go through TES.

### Local (self-hosted)

Run the full stack on your own machine. PostgreSQL + pgvector + Ollama in Docker. No API keys, no cloud. Pi 5 with 8GB RAM works fine (`nomic-embed-text` ~300MB + `llama3.2:3b` ~2GB).

```bash
npx @pentatonic-ai/ai-agent-sdk memory
```

This starts Postgres + pgvector, Ollama, and the memory server. It pulls embedding and chat models, and writes the local config.

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
- **Cross-source retrieval** -- when memories carry source metadata (from `slack-ingest`, `gmail-ingest`, `calendar-ingest`, `corpus-ingest`, etc.), retrieved hits render grouped by source in the prompt and the visibility footer shows a per-source breakdown — `🧠 Matched 5 memories from Pentatonic Memory: 2 code · 2 slack · 1 meeting`. Single-source competitors can't render this because they only ingest one surface. Backwards-compatible: untyped memories render as a flat list.
- **Decay and consolidation** -- memories fade over time; frequently accessed ones get promoted

> **Store latency note (v0.5.4+):** on the local memory server, `store_memory` now awaits distillation before returning instead of running it fire-and-forget. This fixed a bug where distillation was being killed mid-flight (atoms never got embeddings, so they were unreachable by semantic search), but it means stores now take as long as your configured LLM takes to produce atoms — typically 5–30s on `llama3.2:3b`, up to the `chat()` timeout ceiling (60s default, overridable via `opts.timeout`). Cloudflare Worker deployments pass `ctx.waitUntil` and still return fast. Set `opts.distill: false` on the ingest call if you want the old fast-return behaviour at the cost of no atoms.

### Change models

```bash
EMBEDDING_MODEL=mxbai-embed-large LLM_MODEL=qwen2.5:7b npx @pentatonic-ai/ai-agent-sdk memory
```

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

### Distilled memory

A background LLM pass extracts atomic facts from each raw turn and stores each as its own node in the semantic layer, linked back to the source. A query like *"what does Phil drink?"* matches *"Phil drinks cortado"* more reliably than a mixed paragraph covering food, drinks, and hobbies. Default-on; the raw turn is still preserved.

> **Store latency note (v0.5.4+):** on the local memory server, `store_memory` now awaits distillation before returning instead of running it fire-and-forget. This fixed a bug where distillation was being killed mid-flight (atoms never got embeddings, so they were unreachable by semantic search), but it means stores now take as long as your configured LLM takes to produce atoms — typically 5–30s on `llama3.2:3b`, up to the `chat()` timeout ceiling (60s default, overridable via `opts.timeout`). Cloudflare Worker deployments pass `ctx.waitUntil` and still return fast. Set `opts.distill: false` on the ingest call if you want the old fast-return behaviour at the cost of no atoms.

---

## Observability

Wrap your LLM client and every call automatically emits a `CHAT_TURN` event to TES — input/output tokens, tool calls, model, latency, content. Events flow into the TES dashboard, where you get session metrics, search attribution, dead-end detection, and full-text + semantic search across conversations.

Observability requires a TES account (hosted or self-hosted Pentatonic platform). Events have nowhere to go without one.

### Wrap your LLM client

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

### Supported providers

| Provider | Detection | Intercepted Method |
|----------|-----------|-------------------|
| OpenAI | `client.chat.completions.create` | `chat.completions.create()` |
| Anthropic | `client.messages.create` | `messages.create()` |
| Workers AI | `client.run` (JS only) | `run()` |

All other methods pass through unchanged.

---

## Plugins

If you use Claude Code or OpenClaw, the plugin gives you both products at once — every conversation turn is captured (observability) AND searched/stored as memory. No SDK glue to write.

### Claude Code

Works with both local and hosted memory. Install once, switch modes via config.

For hosted TES, run `login` first so credentials exist when the plugin starts up:

```bash
npx @pentatonic-ai/ai-agent-sdk login
```

Then in Claude Code:

```
/plugin marketplace add Pentatonic-Ltd/ai-agent-sdk
/plugin install tes-memory@pentatonic-ai
```

The plugin's MCP server, hooks, and tools auto-discover the credentials at `~/.config/tes/credentials.json`. To verify the connection later, ask Claude `/tes-memory:tes-status`.

For local memory:
```bash
npx @pentatonic-ai/ai-agent-sdk memory
```

**What it tracks:**
- Every conversation turn — user messages, assistant responses, tool calls, duration
- Automatic memory search — relevant memories injected as context on every prompt
- Automatic memory storage — every turn stored with embeddings and HyDE queries
- Token usage — input, output, cache read, cache creation tokens per turn

### OpenClaw

```bash
openclaw plugins install @pentatonic-ai/openclaw-memory-plugin
```

Then tell OpenClaw:

```
Set up pentatonic memory
```

The agent will ask whether you want **local** (private, Docker-based) or **hosted** (Pentatonic TES cloud), then walk you through the rest. For hosted mode, it handles account creation, email verification, and API key generation conversationally.

Or use the CLI directly:

```bash
openclaw pentatonic-memory local
```

**What it does:** OpenClaw's context engine hooks fire on every lifecycle event — `ingest` stores user/assistant messages with embeddings + HyDE + distillation; `assemble` injects relevant memories as system-prompt context before every model run; `compact` runs the decay cycle when the context window fills; `after-turn` consolidates high-access memories into the semantic layer. Plus agent-callable tools: `memory_search`, `memory_store`, `memory_layers`.

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

---

## Repository Onboarding (corpus ingest)

The memory layer starts empty. To avoid the cold-start problem where retrieval has nothing useful to return for the first days of use, you can ingest your repos (or any folder of docs) on day one:

```bash
# Interactive — picks paths, shows a cost preview, ingests, offers
# to install a git post-commit hook so memory stays current
npx @pentatonic-ai/ai-agent-sdk onboard

# One-shot ingest of a single path
npx @pentatonic-ai/ai-agent-sdk ingest ~/code/my-app
npx @pentatonic-ai/ai-agent-sdk ingest ~/Documents/design-notes  # any folder works

# See what's tracked and how big the corpus is
npx @pentatonic-ai/ai-agent-sdk status

# Delta-resync everything that's tracked (or one path)
npx @pentatonic-ai/ai-agent-sdk resync

# Manage the tracked-paths list
npx @pentatonic-ai/ai-agent-sdk corpus list
npx @pentatonic-ai/ai-agent-sdk corpus remove ~/code/old-project
npx @pentatonic-ai/ai-agent-sdk corpus reset
```

Tenant credentials come from env vars (`TES_ENDPOINT`, `TES_CLIENT_ID`, `TES_API_KEY`) or `~/.config/tes/credentials.json` if you used `npx @pentatonic-ai/ai-agent-sdk login`. To point at a TES instance running on `localhost`, set `TES_ENDPOINT=http://localhost:8788`.

### What gets stored: references, not content

By default, ingest stores **pointers to source content** (path + line range + a short signature/summary), not full chunk content. Per-language strategies:

- **Markdown** — one reference per H1/H2 section
- **JS / TS** — one per top-level `function` / `class` / `const` / `export`
- **Python** — one per top-level `def` / `class`
- **JSON / YAML** — collapsed top-level keys
- **Other** — single file-level reference

Why pointers? **Code mutates between ingests.** Embedded chunks of old source rot silently — the LLM keeps confidently citing functions you've since rewritten, with retrieval evidence to back it up. Pointers rot loudly: when a file moves or changes, `Read` fails or returns different content, and the agent observes and adjusts. Stale-but-confident is the worst-class memory bug; loud-and-self-correcting is qualitatively better for source code.

It also means proprietary source never leaves your machine — only the index (path + summary) is sent to the hosted TES, and the agent reads actual file contents at query time on its own.

If you need a self-contained index (e.g. for air-gapped retrieval where the source isn't available at query time), opt into legacy chunk-content storage by passing `mode: "content"` to `ingestCorpus` when using the SDK as a library.

### What gets ingested, what doesn't

Any folder works — git is not required. The walker honors `.gitignore` and `.tesignore` if present, plus a hard-exclude list for secrets and credentials that **cannot be overridden** even with `!pattern` rules:

- `.env*` (any environment file)
- `*.pem`, `*.key`, `*.crt`, `*.p12`, `*.pfx`, `*.jks`
- `id_rsa`, `id_ed25519`, `id_ecdsa`, `id_dsa` (SSH private keys)
- `.ssh/`, `.aws/`, `.gcp/`, `.azure/` (whole directories)
- `.npmrc`, `.pypirc`, `.netrc`
- `secrets/`, `credentials/`, `service-account.*`
- `*_secret*`, `*_token*`, `*_password*`

Plus directory-level skips: `.git`, `node_modules`, `dist`, `build`, `.next`, `venv`, `__pycache__`, `target`, `.terraform`, etc. And extension skips for binaries, lockfiles, and minified output. Files larger than 512 KB are skipped by default (override with adapter options if you need to).

### How it stays current

For git repos, accepting the prompt during `onboard` installs a post-commit hook at `.git/hooks/post-commit` that re-ingests files changed in each commit. The hook is non-fatal — it never blocks a commit. Install manually any time with:

```bash
npx @pentatonic-ai/ai-agent-sdk install-git-hook
```

For non-git folders, re-run `ingest` or `resync` whenever the source changes. Re-ingest is cheap: the SDK keeps a content-hash per file and skips anything that hasn't changed since the last run.

---

## API Reference

### `TESClient(config)` — Observability

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

### `createMemorySystem(deps)` — Memory

Returns a memory instance with `.migrate()`, `.ensureLayers(clientId)`, `.ingest(content, opts)`, `.search(query, opts)`, and more. See [Use as a library](#use-as-a-library).

---

## Health Checks (`doctor`)

Run a full health check of your SDK install at any time:

```bash
npx @pentatonic-ai/ai-agent-sdk doctor
```

`doctor` auto-detects which install path you're on (Local Memory, Hosted TES, or self-hosted Pentatonic platform) and runs only the checks that apply. Exit code is `0` for all-clear, `1` for warnings, `2` for critical.

Common flags:

```bash
npx @pentatonic-ai/ai-agent-sdk doctor --json     # machine-readable
npx @pentatonic-ai/ai-agent-sdk doctor --alert    # silent unless issues
npx @pentatonic-ai/ai-agent-sdk doctor --no-plugins
npx @pentatonic-ai/ai-agent-sdk doctor --path local
```

What gets checked:

- **Universal** — Node version, disk space, SDK config-file permissions
- **Local Memory** — Postgres + pgvector + migrations, embedding/LLM endpoints, memory server port
- **Hosted TES** — endpoint reachable, API key authenticates
- **Self-hosted platform** — HybridRAG, Qdrant, Neo4j, vLLM (each optional, skipped when its env var is unset)

### Plugins

Drop a `.mjs` file into `~/.config/pentatonic-ai/doctor-plugins/` to add your own checks. Useful for app-specific things — internal APIs, ingest freshness, custom infrastructure — without forking the SDK.

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

See [`packages/doctor/README.md`](packages/doctor/README.md) for the full plugin contract and programmatic API.

---

## Architecture

```
                    Your code
                        |
        +---------------+---------------+
        |                               |
   Memory product              Observability product
   (createMemorySystem)         (TESClient.wrap)
        |                               |
        |                               |
   +----+----+                          |
   |         |                          |
 Local    Hosted ---------------------- TES
 (Docker)              (Cloudflare cloud)
   |                          |
PG+pgvector              PG, R2, Queues,
+ Ollama                 Workers, Modules
                         (deep-memory,
                          conversation-
                          analytics, …)
```

Plugins (Claude Code, OpenClaw) are lightweight integrations on top of both products — they call into memory and emit observability events on the user's behalf.

## License

MIT
