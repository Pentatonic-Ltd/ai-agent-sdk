---
name: tes-setup
description: Set up TES memory — sign in via browser-based OAuth and configure the plugin
---

# TES Setup

Connect this plugin to a Pentatonic TES account. The CLI uses browser-based OAuth (sign-in or sign-up in your browser, not the terminal) and writes credentials to a shared file the plugin auto-discovers.

## Steps

1. Run the TES login command. It will open your browser:

```bash
npx @pentatonic-ai/ai-agent-sdk login
```

2. In the browser:
   - **Returning user**: enter your client ID, sign in.
   - **New user**: click "Sign up", create a new tenant (clientId + region + email + password), verify your email, then sign in.
   - You'll land on a "Connected" tab — close it.

3. The CLI writes credentials to `~/.config/tes/credentials.json` and prints:

```
✓ Connected as you@example.com on tenant `your-clientid`
✓ Credentials written to ~/.config/tes/credentials.json
```

4. Restart Claude Code so the `tes-memory` MCP server picks up the new credentials. The plugin reads `~/.config/tes/credentials.json` automatically — no manual paste step.

5. Confirm the setup by trying these tools in Claude:
   - `search_memories` — find relevant past knowledge
   - `store_memory` — save important information explicitly
   - Session events are emitted automatically via hooks.

## Notes

- If the browser doesn't auto-open (e.g. inside a container with no display), the CLI prints the URL — open it manually in your host browser. Localhost callback works as long as the CLI's host has the loopback reachable.
- If the user already has `~/.claude/tes-memory.local.md` configured for a different tenant, that file wins over `~/.config/tes/credentials.json`. Delete or update it to switch tenants.
- The old `npx @pentatonic-ai/ai-agent-sdk init` command still works as a one-major-release alias for `login` (it emits a deprecation warning).
