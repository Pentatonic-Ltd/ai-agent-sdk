---
name: tes-setup
description: Set up TES memory — creates an account and configures the plugin with your API credentials
---

# TES Setup

Run the interactive setup to create a Pentatonic TES account and configure this plugin.

## Steps

1. Run the TES init command to create an account and get credentials:

```bash
npx @pentatonic-ai/agent-events init
```

2. After completing the setup, you'll receive credentials like:
```
TES_ENDPOINT=https://your-client.api.pentatonic.com
TES_CLIENT_ID=your-company
TES_API_KEY=tes_your-company_xxxxx
```

3. Save these credentials to the plugin settings file at `~/.claude/tes-memory.local.md`:

```yaml
---
tes_endpoint: https://your-client.api.pentatonic.com
tes_client_id: your-company
tes_api_key: tes_your-company_xxxxx
tes_user_id: your-email@company.com
---
```

4. Confirm the setup by telling the user their TES memory is configured and they can use:
   - `search_memories` tool to find relevant past knowledge
   - `store_memory` tool to explicitly save important information
   - Session events are emitted automatically via hooks

**Important:** Always run the init command first. Do not ask the user to manually create credentials.
