# Manual test rig

Two Docker containers — fresh `claude` and `openclaw` shells with the respective CLIs installed. State persists in named volumes between runs; `reset` wipes them. Everything else (configuring tes-memory, installing the plugin, running test prompts) is manual.

## Commands

```bash
./scripts/manual-test/manual-test.sh claude       # drop into Claude Code container
./scripts/manual-test/manual-test.sh openclaw     # drop into OpenClaw container
./scripts/manual-test/manual-test.sh reset claude
./scripts/manual-test/manual-test.sh reset openclaw
./scripts/manual-test/manual-test.sh reset all
./scripts/manual-test/manual-test.sh status
```

## What's isolated

Containers use named volumes that DON'T touch your host configs:

| Volume | Mount | Holds |
|---|---|---|
| `manual-test-claude` | `/root/.claude` | Claude Code auth, plugin cache, settings, generated configs |
| `manual-test-openclaw` | `/home/node/.openclaw` | OpenClaw plugin cache, configs |

Your `~/.claude` and `~/.openclaw` on the host are untouched.

## Optional env passthrough

The script forwards these to the container if set:

- `ANTHROPIC_API_KEY` — Claude Code skips OAuth
- `OPENROUTER_API_KEY` — OpenClaw chat backend
- `TES_ENDPOINT`, `TES_CLIENT_ID`, `TES_API_KEY` — for testing against remote TES from inside the container

## Local memory testing

The container runs with `--network=host`, so to test against a local memory stack:

```bash
# in one terminal — bring up local memory on the host
npx @pentatonic-ai/ai-agent-sdk memory

# in another — start the agent container and point at it
./scripts/manual-test/manual-test.sh claude

# inside the container, write tes-memory.local.md with:
#   mode: local
#   memory_url: http://localhost:3333
```

For testing against remote TES, just set `TES_*` env vars before launching the container, then write a `tes-memory.local.md` referencing them (or use the values directly).

## Typical test flow

```bash
# fresh start
./manual-test.sh reset claude
./manual-test.sh claude

# inside the container:
claude /login                                      # if no ANTHROPIC_API_KEY
claude
> /plugin marketplace add Pentatonic-Ltd/ai-agent-sdk
> /plugin install tes-memory@pentatonic-ai
> /reload-plugins
> I drive a Subaru and a Hyundai.
> /exit

claude
> what car do I drive?
# expect: "Subaru and a Hyundai", with `Recalled N memories` indicator
```

Same idea for `openclaw` — install the plugin (`@pentatonic-ai/openclaw-memory-plugin`), configure, save a fact, restart, retrieve.
