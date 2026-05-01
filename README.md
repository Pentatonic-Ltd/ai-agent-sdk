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
| **Memory** | Persistent, searchable memory for your AI agent — 7-layer hybrid retrieval (BM25 + vector + KG + reranker), repo onboarding via references. Runs locally (Docker) or hosted (TES). | You want your agent to remember conversations, preferences, and codebase context across sessions. |
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
  - [Local (self-hosted)](#local-self-hosted)
  - [Hosted (cloud)](#hosted-cloud)
  - [Use as a library](#use-as-a-library)
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

Persistent, searchable memory for AI agents. Backed by a 7-layer hybrid retrieval engine — BM25 keyword (L0), core files (L1), HybridRAG orchestrator (L2), Knowledge Graph entities (L3), vector index (L4), comms-namespace vectors (L5), and a document store with cross-encoder reranker (L6). Reciprocal Rank Fusion stitches them at query time.

Same engine, same wire format (`/store`, `/search`, `/forget`, `/store-batch`, `/health`), two deployment modes:

### Local (self-hosted)

Run the full engine stack on your own machine via Docker. No API keys, no cloud, fully offline. Embeddings come from your local Ollama; quality depends on the model you pull (768d `nomic-embed-text` is the default and works fine on a laptop).

**Prerequisites**

- Docker + Docker Compose v2
- Ollama installed on the host (https://ollama.com)
- A pulled embedding model: `ollama pull nomic-embed-text`

If you'll run Claude Code (or anything else) inside a Docker container that needs to reach the engine, **make Ollama listen on all interfaces** so containers can reach it via `host.docker.internal`:

```bash
sudo mkdir -p /etc/systemd/system/ollama.service.d
echo -e '[Service]\nEnvironment="OLLAMA_HOST=0.0.0.0:11434"' \
  | sudo tee /etc/systemd/system/ollama.service.d/override.conf
sudo systemctl daemon-reload
sudo systemctl restart ollama
```

**Bring up the engine**

```bash
git clone https://github.com/Pentatonic-Ltd/ai-agent-sdk.git
cd ai-agent-sdk/packages/memory-engine

# Default .env points at Ollama on the host. Edit if your Ollama is
# elsewhere or you want to use a higher-quality model (e.g. mxbai-embed-large
# at 1024d → set EMBED_DIM=1024 and EMBED_MODEL_NAME=mxbai-embed-large).
cat > .env <<'EOF'
PME_NV_EMBED_ENABLED=false
NV_EMBED_URL=http://host.docker.internal:11434/v1/embeddings
EMBED_MODEL_NAME=nomic-embed-text
EMBED_DIM=768
OLLAMA_DIM=768
PME_OLLAMA_URL=http://host.docker.internal:11434/api/embeddings
PME_EMBED_MODEL=nomic-embed-text
L5_OLLAMA_EMBED_URL=http://host.docker.internal:11434/api/embed
L5_OLLAMA_EMBED_MODEL=nomic-embed-text
PME_HYDE_ENABLED=false
PME_RERANK_ENABLED=true
PME_PORT=8099
CLIENT_ID=local
NEO4J_AUTH=neo4j/local-dev-pw
NEO4J_PASSWORD=local-dev-pw
EOF

docker compose up -d --scale nv-embed=0
```

First run pulls images and builds engine containers — ~10–15 min. Subsequent restarts are seconds.

**Verify**

```bash
curl -s http://localhost:8099/health | jq
# Status should be "ok" or "degraded" with most layers reporting ok.

curl -sX POST http://localhost:8099/store \
  -H "content-type: application/json" \
  -d '{"content":"hello memory","metadata":{"arena":"local"}}' | jq

curl -sX POST http://localhost:8099/search \
  -H "content-type: application/json" \
  -d '{"query":"hello","limit":3,"min_score":0.001}' | jq
```

If `/search` returns the row from `/store`, the engine is live.

**Connect Claude Code**

The `tes-memory` plugin's hooks already speak the engine's wire format. Three steps:

1. Install the plugin (once):
   ```
   /plugin marketplace add Pentatonic-Ltd/ai-agent-sdk
   /plugin install tes-memory@pentatonic-ai
   ```
2. Point it at your local engine — one command writes the plugin config:
   ```bash
   npx @pentatonic-ai/ai-agent-sdk config local
   ```
   This writes `~/.claude-pentatonic/tes-memory.local.md` with `mode: local` and `memory_url: http://localhost:8099`. If you want a different URL, pass `--engine-url <url>`. To switch back to hosted later, run `tes config hosted` (delegates to `login`).
3. Reload: `/reload-plugins` (or restart Claude Code if status reports stale state — MCP server processes need a full restart to pick up plugin updates).

Inspect what's currently configured at any time:

```bash
npx @pentatonic-ai/ai-agent-sdk config show
```

Verify:

```
/tes-memory:tes-status
```

Should report `✓ Connected to local memory engine`. Now every prompt auto-searches engine memory and every turn auto-stores. The footer `🧠 Matched N memories from Pentatonic Memory` shows hits.

**Seed memory from your codebase or docs (optional)**

Drop the cold-start problem on day one by pre-populating the engine with references to your code/docs:

```bash
MEMORY_ENGINE_URL=http://localhost:8099 \
  npx @pentatonic-ai/ai-agent-sdk ingest ~/code/my-project
```

References-mode by default — stores path + signature pointers, not full file contents. See [Repository Onboarding](#repository-onboarding-corpus-ingest) for details.

**Tuning**

Change embedding model: pull a different one, edit `EMBED_MODEL_NAME` + `EMBED_DIM` in `.env`, then `docker compose down -v && docker compose up -d --scale nv-embed=0` (the `-v` is required because Milvus collections are dim-locked at creation; switching dims means recreating).

| Model | Dim | Notes |
|---|---|---|
| `nomic-embed-text` (default) | 768 | Smallest; works on any laptop |
| `mxbai-embed-large` | 1024 | Better recall; ~600 MB download |
| `nv-embed-v2` (via gateway) | 4096 | Production-grade; needs a hosted endpoint or GPU |

### Hosted (cloud)

Run on Pentatonic's infrastructure. NV-Embed-v2 (4096d) embeddings via the AI gateway, managed Postgres/Neo4j/Qdrant/Milvus, dashboard. The engine still ships in this repo — hosted just deploys it for you.

```bash
# 1. Get a TES account
npx @pentatonic-ai/ai-agent-sdk login

# 2. Install the SDK
npm install @pentatonic-ai/ai-agent-sdk
# or: pip install pentatonic-ai-agent-sdk
```

Memory operations route through TES → engine. No client-side change between local and hosted.

### Use as a library

```javascript
import { engineAdapter, ingestCorpus } from '@pentatonic-ai/ai-agent-sdk/memory/corpus';

const adapter = engineAdapter({
  engineUrl: 'http://localhost:8099',
  arena: 'my-app',
});
await adapter.init();
await adapter.ingestChunk('User prefers dark mode', { kind: 'note' });
```

For raw `/search` and `/store`, just `fetch()` against `${engineUrl}/search` etc. The wire format is documented in `packages/memory-engine/docs/MIGRATION.md`.

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

```
/plugin marketplace add Pentatonic-Ltd/ai-agent-sdk
/plugin install tes-memory@pentatonic-ai
```

**Local engine** — bring up the engine first ([Memory > Local](#local-self-hosted)), then write the plugin config:

```bash
npx @pentatonic-ai/ai-agent-sdk config local
```

**Hosted TES** — run `login` once, the plugin auto-discovers `~/.config/tes/credentials.json`:

```bash
npx @pentatonic-ai/ai-agent-sdk login
# equivalent: npx @pentatonic-ai/ai-agent-sdk config hosted
```

Either way, verify with `/tes-memory:tes-status` in Claude Code, or from the shell:

```bash
npx @pentatonic-ai/ai-agent-sdk config show
```

The plugin's MCP server, hooks, and tools all read the same config — switching modes is a single CLI call away.

**What it tracks (auto, every turn):**
- Memory search at prompt time — relevant memories injected as context
- Memory store at turn end — every conversation turn persisted
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

**What it does:** OpenClaw's context engine hooks fire on every lifecycle event — `ingest` stores user/assistant messages via the engine's `/store` endpoint (BM25 + vector + KG indexing in parallel); `assemble` calls `/search` to inject relevant memories as system-prompt context; `compact` and `after-turn` are managed by the engine's own decay/consolidation. Plus agent-callable tools: `memory_search`, `memory_store`, `memory_layers`.

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
          "memory_url": "http://localhost:8099"
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

### `engineAdapter(config)` — Memory

Thin HTTP client for the memory engine. `config = { engineUrl, arena, apiKey? }`. Returns `{ ingestChunk(content, metadata), deleteByCorpusFile(repoAbs, relPath), init() }`. See [Use as a library](#use-as-a-library).

For raw `/store` / `/search` calls, just `fetch()` against `${engineUrl}` directly — the wire format is documented in `packages/memory-engine/docs/MIGRATION.md`.

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
- **Local engine** — engine `/health`, per-layer health (L0–L6), embedding endpoint reachability
- **Hosted TES** — endpoint reachable, API key authenticates
- **Plugin config** — `tes-memory.local.md` parses, `memory_url` reachable

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
                    Your code / Claude Code plugin / OpenClaw plugin
                                  |
              +-------------------+--------------------+
              |                                        |
         Memory product                        Observability product
         (engine HTTP API)                     (TESClient.wrap)
              |                                        |
              | POST /store /search /forget            | CHAT_TURN events
              ▼                                        ▼
      +----------------+                       +-----------------+
      | memory engine  |                       |       TES       |
      |  (compat shim) |                       | (Cloudflare)    |
      +----------------+                       |  Workers, R2,   |
              |                                |  Queues, Pages  |
   +----------+----------+                     +--------+--------+
   |                     |                              |
 Local                Hosted ---------------------------+
 (your machine)    (Pentatonic-managed)
   |                     |
docker compose      AWS/GCP container cluster
+ host Ollama       + AI gateway (NV-Embed-v2)
```

Plugins (Claude Code, OpenClaw) are lightweight integrations on top of both products — they call into memory and emit observability events on the user's behalf.

## License

MIT
