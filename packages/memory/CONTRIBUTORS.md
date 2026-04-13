# Contributing to @pentatonic/memory

## TES Compatibility

This package is consumed by [TES (Thing Event System)](https://github.com/Pentatonic-Ltd/thing-event-system) in production. TES imports from `@pentatonic/memory` and injects its own database connections and AI endpoints. **Breaking the API contract breaks TES for all hosted clients.**

### API Contract

The following must remain stable. You can add new methods and options, but you cannot change or remove existing ones.

#### `createMemorySystem(config)` — Factory

Config must accept:

| Field | Type | Required | Used by TES |
|-------|------|----------|-------------|
| `db` | `Function \| pg.Pool` | Yes | TES passes a Hyperdrive-wrapped query function |
| `schema` | `string` | No | TES passes per-tenant schema names (`module_deep_memory_{clientId}`) |
| `embedding` | `{ url, model, apiKey? }` | Yes | TES passes Pentatonic AI Gateway URL |
| `llm` | `{ url, model, apiKey? }` | Yes | TES passes Pentatonic AI Gateway URL |
| `logger` | `Function` | No | TES passes its internal logger |

#### Returned API — Methods

| Method | Signature | Notes |
|--------|-----------|-------|
| `migrate()` | `() => Promise<{applied, total}>` | Must be idempotent |
| `ensureLayers(clientId, layerNames?)` | Creates default layers | `layerNames` is optional |
| `getLayers(clientId)` | Returns array of layer objects | |
| `ingest(content, opts)` | `opts: { clientId, userId?, layerType?, metadata? }` | Returns `{ id, content, layerId }` |
| `search(query, opts)` | `opts: { clientId, limit?, minScore?, userId?, weights? }` | Returns array of scored results |
| `textSearch(query, opts)` | `opts: { clientId, limit?, userId? }` | Fallback when embeddings unavailable |
| `decay(clientId, opts?)` | Returns `{ decayed, evicted, layersProcessed }` | |
| `consolidate(clientId, opts?)` | `opts: { threshold?, limit? }` | Returns array of `{ sourceId, targetId }` |

#### `weights` Object

TES passes per-client retrieval weights:

```javascript
{ relevance: 0.6, recency: 0.25, frequency: 0.15 }
```

All three fields must be supported. Values are 0-1 floats.

#### Named Exports

These are used by TES for advanced/direct usage:

```javascript
import { createMemorySystem, createAIClient } from '@pentatonic/memory';
import { search, textSearch } from '@pentatonic/memory/search';   // not currently used, but reserved
import { ingest } from '@pentatonic/memory/ingest';                // not currently used, but reserved
```

#### Database Schema

The migrations create these tables. Column names and types must not change:

- `memory_nodes` — `id, client_id, layer_id, user_id, content, embedding, embedding_vec, content_tsv, metadata, confidence, decay_rate, access_count, last_accessed, created_at, updated_at`
- `memory_layers` — `id, client_id, name, layer_type, capacity, decay_policy, is_active, created_at`
- `memory_consolidations` — `id, client_id, source_memory_id, target_memory_id, consolidation_type, created_at`

New columns can be added. Existing columns cannot be renamed or removed.

### Testing the Contract

Run the API contract tests before submitting changes:

```bash
cd packages/memory
node --experimental-vm-modules ../../node_modules/.bin/jest src/__tests__/api-contract.test.js
```

If any contract test fails, your change breaks TES compatibility. Either:
1. Adjust your change to maintain backward compatibility
2. Add new API alongside the existing one (don't replace)
3. Coordinate with the TES team if a breaking change is truly necessary

### What You Can Freely Change

- **Internals** — how search scoring works, decay algorithms, HyDE prompts, SQL query structure
- **New methods** — add to the returned object from `createMemorySystem()`
- **New options** — add optional fields to existing method signatures
- **New migrations** — add new SQL files (004+), never modify existing ones
- **OpenClaw plugin** — `src/openclaw/` is independent of TES
- **MCP server** — `src/server.js` is independent of TES
- **Docker/Compose** — container setup is independent of TES

### What Requires Coordination

- Renaming or removing any method on the memory system object
- Changing the return type of any method
- Changing the `config` parameter shape of `createMemorySystem()`
- Modifying existing migration files
- Changing the `metadata.hypothetical_queries` JSONB key name
