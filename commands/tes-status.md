---
name: tes-status
description: Check TES memory connection — reports the tenant you're logged into and whether the API key still validates
---

# TES Status

Call the `tes_status` tool from the tes-memory MCP server and surface the result to the user verbatim. The tool handles three cases:

1. **Not configured** — credentials file missing or incomplete. The tool returns a one-command instruction to run `npx @pentatonic-ai/ai-agent-sdk login`. Pass it through unchanged.
2. **Connected and verified** — credentials present, ping successful. The tool returns the tenant clientId, endpoint, and a layer count. Read it back to the user.
3. **Connected but invalid** — credentials present but the server rejected them (401 / token revoked / expired). Tool returns guidance to re-run `tes login`.

Do not infer any other state. The tool is the source of truth.

If the user is asking how to *change* tenants (rather than check current state), tell them: delete or update `~/.claude/tes-memory.local.md` if it exists (it overrides `~/.config/tes/credentials.json`), then run `npx @pentatonic-ai/ai-agent-sdk login` again.
