---
name: tes-setup
description: Connect TES memory — runs `tes login` (browser-based OAuth) and points the plugin at the credentials it writes
---

# TES Setup

This plugin reads credentials from `~/.config/tes/credentials.json`. To create that file, the user runs **one command** in their terminal:

```bash
npx @pentatonic-ai/ai-agent-sdk login
```

That's it. No copy-paste, no manual config file, no `init` flow.

## What `login` does

1. Opens the user's browser to a hosted sign-in page.
2. User signs in (or clicks "Sign up" to create a new tenant — clientId + region + email + password).
3. After verification, the CLI receives an OAuth callback and mints a long-lived API token.
4. Writes `{ endpoint, clientId, apiKey }` to `~/.config/tes/credentials.json` (mode 0600).
5. Prints "✓ Connected as you@example.com on tenant `your-clientid`".

## After login

- The Claude Code plugin (this one) and the OpenClaw plugin both auto-discover the credentials file.
- Restart Claude Code (or `/restart`) so the MCP server picks up the new credentials.
- Verify with `npx @pentatonic-ai/ai-agent-sdk whoami`.

## Edge cases

- **Inside a container with no display** — browser auto-open will fail; the CLI prints the URL, user opens it in the host browser. Localhost callback works as long as the container has loopback connectivity to the host (or `--network=host`).
- **Already configured a different tenant via `~/.claude/tes-memory.local.md`** — that file's frontmatter wins over `~/.config/tes/credentials.json`. To switch tenants, delete or update the `.local.md` file.

## When to recommend manual config

Almost never. The only legitimate use cases for editing `tes-memory.local.md` directly:
- Multi-account workflows on one machine (per-CLAUDE_CONFIG_DIR override)
- Service-account keys minted out-of-band by an admin

For everyone else, `tes login` is the answer.
