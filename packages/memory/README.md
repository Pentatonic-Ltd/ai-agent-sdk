# @pentatonic/memory

Self-hosted memory system for AI agents. Give Claude Code or OpenClaw persistent, searchable memory backed by PostgreSQL, pgvector, and Ollama. Fully local — no API keys, no cloud dependencies.

## What You Get

Three MCP tools your agent can use:

| Tool | Description |
|------|-------------|
| `search_memories` | Semantic search — vector similarity + BM25 + recency + frequency |
| `store_memory` | Store content with automatic embedding + HyDE query expansion |
| `list_memories` | Browse memories by layer (episodic/semantic/procedural/working) |

When your agent stores a memory, the system automatically generates an embedding and 3 hypothetical search queries (HyDE) to improve future retrieval. When it searches, it combines vector similarity, full-text matching against both content and hypothetical queries, recency decay, and access frequency into a single relevance score.

## Setup

### 1. Start the infrastructure

You need PostgreSQL with pgvector and Ollama running. The easiest way is Docker Compose:

```bash
git clone https://github.com/Pentatonic-Ltd/memory.git
cd memory
docker compose up -d postgres ollama
```

Or use existing services if you already have them:
- **PostgreSQL 14+** with the `vector` extension enabled
- **Ollama** (or any OpenAI-compatible embedding + chat endpoint)

Pull the models (first time only):

```bash
docker compose exec ollama ollama pull nomic-embed-text
docker compose exec ollama ollama pull llama3.2:3b
```

### 2. Connect your agent

#### Claude Code

```bash
claude mcp add pentatonic-memory \
  -e DATABASE_URL=postgres://memory:memory@localhost:5432/memory \
  -e EMBEDDING_URL=http://localhost:11434/v1 \
  -e EMBEDDING_MODEL=nomic-embed-text \
  -e LLM_URL=http://localhost:11434/v1 \
  -e LLM_MODEL=llama3.2:3b \
  -- npx @pentatonic/memory-server
```

Or if you cloned the repo:

```bash
claude mcp add pentatonic-memory \
  -e DATABASE_URL=postgres://memory:memory@localhost:5432/memory \
  -e EMBEDDING_URL=http://localhost:11434/v1 \
  -e EMBEDDING_MODEL=nomic-embed-text \
  -e LLM_URL=http://localhost:11434/v1 \
  -e LLM_MODEL=llama3.2:3b \
  -- node /path/to/memory/src/server.js
```

#### OpenClaw

Add to `~/.openclaw/openclaw.json`:

```json
{
  "mcpServers": {
    "pentatonic-memory": {
      "command": "npx",
      "args": ["@pentatonic/memory-server"],
      "env": {
        "DATABASE_URL": "postgres://memory:memory@localhost:5432/memory",
        "EMBEDDING_URL": "http://localhost:11434/v1",
        "EMBEDDING_MODEL": "nomic-embed-text",
        "LLM_URL": "http://localhost:11434/v1",
        "LLM_MODEL": "llama3.2:3b"
      }
    }
  }
}
```

Or if you cloned the repo, replace `"command": "npx", "args": ["@pentatonic/memory-server"]` with `"command": "node", "args": ["/path/to/memory/src/server.js"]`.

### 3. Use it

Ask your agent to remember things:

```
remember that I prefer TypeScript over JavaScript
```

Ask it to recall:

```
what do you know about my preferences?
```

The agent will call `store_memory` and `search_memories` automatically.

## Using a Cloud LLM Instead of Ollama

If you don't want to run Ollama locally, point the LLM at any OpenAI-compatible endpoint. You still need Ollama (or similar) for embeddings.

**OpenRouter** (chat only — no embeddings):

```bash
claude mcp add pentatonic-memory \
  -e DATABASE_URL=postgres://memory:memory@localhost:5432/memory \
  -e EMBEDDING_URL=http://localhost:11434/v1 \
  -e EMBEDDING_MODEL=nomic-embed-text \
  -e LLM_URL=https://openrouter.ai/api/v1 \
  -e LLM_MODEL=google/gemma-3-4b-it:free \
  -e API_KEY=your-openrouter-key \
  -- node /path/to/memory/src/server.js
```

**Any OpenAI-compatible endpoint** works: vLLM, LiteLLM, Together AI, Groq, etc.

## Running on a Raspberry Pi

Pi 5 (8GB) runs the full stack comfortably:

```bash
docker compose up -d postgres ollama
docker compose exec ollama ollama pull nomic-embed-text  # ~300MB RAM
docker compose exec ollama ollama pull llama3.2:3b       # ~2GB RAM
```

Connect OpenClaw or Claude Code from the same machine or over your network (replace `localhost` with the Pi's IP).

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes | - | PostgreSQL connection string |
| `EMBEDDING_URL` | Yes | - | OpenAI-compatible embeddings endpoint |
| `EMBEDDING_MODEL` | Yes | - | Embedding model name |
| `LLM_URL` | Yes | - | OpenAI-compatible chat endpoint (for HyDE) |
| `LLM_MODEL` | Yes | - | Chat model name |
| `API_KEY` | No | - | API key for embedding/LLM endpoints |
| `CLIENT_ID` | No | `default` | Namespace for memories |

## Change Models

Swap models anytime — just update the env vars and restart:

```bash
# Larger embedding model
EMBEDDING_MODEL=mxbai-embed-large

# Larger chat model for better HyDE
LLM_MODEL=qwen2.5:7b
```

Pull new models in Ollama:

```bash
docker compose exec ollama ollama pull mxbai-embed-large
docker compose exec ollama ollama pull qwen2.5:7b
```

## How It Works

1. **Store** — content is saved to PostgreSQL, embedded via your chosen model, and 3 hypothetical search queries are generated (HyDE) to improve future matching
2. **Search** — multi-signal scoring combines cosine similarity, BM25 full-text (across content + HyDE queries), recency decay, and access frequency in a single Postgres query
3. **Decay** — memory confidence decays over time; recently accessed memories decay slower; frequently accessed memories get promoted from episodic to semantic layer
4. **Layers** — memories are organized by type: episodic (recent events), semantic (consolidated knowledge), procedural (how-to), working (temporary)

## Use as a Library

If you want to integrate memory into your own application:

```javascript
import { createMemorySystem } from '@pentatonic/memory';
import pg from 'pg';

const memory = createMemorySystem({
  db: new pg.Pool({ connectionString: process.env.DATABASE_URL }),
  embedding: { url: 'http://localhost:11434/v1', model: 'nomic-embed-text' },
  llm: { url: 'http://localhost:11434/v1', model: 'llama3.2:3b' },
});

await memory.migrate();
await memory.ensureLayers('my-app');
await memory.ingest('User prefers dark mode', { clientId: 'my-app' });
const results = await memory.search('user preferences', { clientId: 'my-app' });
```

## Architecture

Built by [Pentatonic](https://pentatonic.com). The same retrieval engine that powers [TES](https://pentatonic.com/tes).

## License

MIT
