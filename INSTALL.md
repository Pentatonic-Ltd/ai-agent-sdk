# TES Memory Plugin for Claude Code

Shared team memory + automatic conversation tracking for Claude Code. Every session and conversation turn is captured as TES events.

## Install via Marketplace

### 1. Add the marketplace

In Claude Code, run:

```
/plugin marketplace add Pentatonic-Ltd/ai-agent-sdk
```

### 2. Install the plugin

```
/plugin install tes-memory@pentatonic-ai
```

### 3. Create your account

Run `/tes-memory:tes-setup` inside Claude Code. This will guide you through creating a TES account and generating API credentials.

### 4. Restart Claude Code

The plugin will start tracking automatically.

## Alternative: Manual Install

```bash
git clone https://github.com/Pentatonic-Ltd/ai-agent-sdk.git ~/.claude-plugins/tes-memory
claude --plugin-dir ~/.claude-plugins/tes-memory
```

## What it does

- **Conversation tracking** — automatically captures every conversation turn (user messages, assistant responses, tool calls) as TES events via `createModuleEvent`
- **Session analytics** — tracks session start/end, duration, total tool usage
- **Shared memory** — `search_memories` and `store_memory` MCP tools for shared team knowledge
- **Per-module security** — events are scoped to specific modules with permission checks

## What gets tracked

Every conversation turn emits a `CHAT_TURN` event containing:
- User message
- Assistant response
- Tool calls (name + input)
- Turn number and duration
- User ID

Sessions emit `SESSION_START` and `SESSION_END` events with summaries (total turns, total tool calls, session duration).

## Updating

Marketplace plugins update automatically. For manual installs:

```bash
cd ~/.claude-plugins/tes-memory && git pull
```

## Feedback

Report issues or ideas via [GitHub Issues](https://github.com/Pentatonic-Ltd/ai-agent-sdk/issues).
