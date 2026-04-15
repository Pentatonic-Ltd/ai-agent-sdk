# @pentatonic-ai/openclaw-memory

Persistent, searchable memory for OpenClaw. Local (Docker + Ollama) or hosted (Pentatonic TES).

## Install

```bash
openclaw plugins install @pentatonic-ai/openclaw-memory
```

## Setup

Tell OpenClaw:

```
Set up pentatonic memory
```

Or configure manually in `openclaw.json`:

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

## What it does

Every lifecycle event is handled automatically:

- **Ingest** — every message stored with embeddings + HyDE query expansion
- **Assemble** — relevant memories injected as context before every prompt
- **Compact** — decay cycle when context window fills
- **After turn** — high-access memories consolidated to semantic layer

Plus tools: `memory_search`, `memory_store`, `memory_layers`

## Local vs Hosted

**Local**: Fully private. Requires Docker (Postgres + pgvector + Ollama). Run `npx @pentatonic-ai/ai-agent-sdk memory` to set up.

**Hosted**: Connect to Pentatonic TES for higher-dimensional embeddings, team memory, and analytics. Run `npx @pentatonic-ai/ai-agent-sdk init`.

## License

MIT
