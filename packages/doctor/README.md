# doctor

Health check subsystem for the AI Agent SDK.

## Usage

```bash
npx @pentatonic-ai/ai-agent-sdk doctor
```

Auto-detects which install path you're on (Local Memory, Hosted TES, or
self-hosted Pentatonic platform) and runs the relevant checks. Returns
exit code `0` for all-clear, `1` for warnings, `2` for critical.

### Flags

| Flag | Effect |
|---|---|
| `--json` | Emit a JSON report to stdout instead of a human table |
| `--alert` | Suppress output unless something is non-ok (good for cron) |
| `--no-plugins` | Skip user-supplied plugins for this run |
| `--path <name>` | Force a specific path: `local`, `hosted`, `platform`, `auto` |
| `--timeout <ms>` | Per-check timeout (default 10000) |

## What gets checked

### Universal (always)
- Node version ≥ 18
- Disk space at `$HOME` and `$TMPDIR`
- SDK config files (`~/.claude/tes-memory.local.md`, etc) are mode 0600

### Local Memory path
Triggered when `DATABASE_URL` + `EMBEDDING_URL` + `LLM_URL` are all set,
or `~/.claude/tes-memory.local.md` exists.
- PostgreSQL reachable
- pgvector extension installed
- Schema migrations applied
- Embedding endpoint responds + serves the configured model
- LLM endpoint responds + has the configured model loaded
- Memory server bound on `PORT`

### Hosted TES path
Triggered when `TES_ENDPOINT` + `TES_API_KEY` are both set.
- TES endpoint reachable
- API key authenticates for `TES_CLIENT_ID`

### Self-hosted platform path
Triggered when `HYBRIDRAG_URL` is set or `~/.openclaw/openclaw.json`
exists. Each individual probe is skipped if its URL env var is unset, so
partial deployments don't false-fail.
- HybridRAG proxy
- Qdrant
- Neo4j (requires `NEO4J_PASSWORD`)
- vLLM

## Plugins

Drop a `.mjs` file into `~/.config/pentatonic-ai/doctor-plugins/` and
`doctor` will load it automatically. (Use `.mjs`, not `.js` — without a
sibling `package.json` Node treats `.js` as CommonJS.)

```js
// ~/.config/pentatonic-ai/doctor-plugins/my-app.mjs
export default {
  name: "my-app",
  checks: [
    {
      name: "internal API reachable",
      severity: "warning", // 'critical' | 'warning' | 'info'
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

Plugin checks appear in the report prefixed with the plugin name
(`my-app: internal API reachable`).

A broken plugin will not abort the run — failures are logged and the
loader moves on.

## Programmatic use

```js
import { runDoctor, renderHuman } from "@pentatonic-ai/ai-agent-sdk/doctor";

const report = await runDoctor({ path: "auto" });
console.log(renderHuman(report));

if (report.summary.critical > 0) {
  process.exit(2);
}
```

`runDoctor` accepts:
- `path` — `'local' | 'hosted' | 'platform' | 'auto'`
- `plugins` — `false` to skip plugin loading
- `pluginDir` — override the plugin directory
- `timeoutMs` — per-check timeout
- `extraChecks` — additional check descriptors to merge in (useful in tests)
- `env` — override `process.env` for path detection
