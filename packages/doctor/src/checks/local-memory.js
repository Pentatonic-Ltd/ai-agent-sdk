/**
 * Local memory engine checks.
 *
 * Targets the engine stack started by:
 *   cd packages/memory-engine && docker compose up -d
 *
 * The engine exposes a compat HTTP shim on port 8099 (or whatever
 * memory_url is set to in the user's plugin config). All checks are
 * just HTTP calls + plugin-config parsing — no direct Postgres/pg_vector
 * probing. The legacy Postgres+Ollama checks were removed when the
 * v0.5.x in-process memory server was deprecated.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { SEVERITY } from "../index.js";

const DEFAULT_ENGINE_URL = "http://localhost:8099";

async function fetchWithTimeout(url, opts = {}, timeoutMs = 5000) {
  return await fetch(url, {
    ...opts,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

function parseFrontmatter(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return out;
}

function findPluginConfig() {
  const candidates = [
    process.env.CLAUDE_CONFIG_DIR,
    join(homedir(), ".claude-pentatonic"),
    join(homedir(), ".claude"),
  ].filter(Boolean);
  for (const dir of candidates) {
    const p = join(dir, "tes-memory.local.md");
    if (existsSync(p)) return p;
  }
  return null;
}

function resolveEngineUrl() {
  // 1. env var override
  if (process.env.MEMORY_ENGINE_URL) return process.env.MEMORY_ENGINE_URL;
  // 2. plugin config
  const cfgPath = findPluginConfig();
  if (cfgPath) {
    try {
      const fm = parseFrontmatter(readFileSync(cfgPath, "utf-8"));
      if (fm?.mode === "local" && fm.memory_url) return fm.memory_url;
    } catch {
      // fall through
    }
  }
  // 3. default
  return DEFAULT_ENGINE_URL;
}

function checkPluginConfig() {
  return {
    name: "plugin config (tes-memory.local.md)",
    severity: SEVERITY.WARNING,
    run: async () => {
      const cfgPath = findPluginConfig();
      if (!cfgPath) {
        return {
          ok: false,
          msg: "no tes-memory.local.md found — run `npx @pentatonic-ai/ai-agent-sdk config local`",
        };
      }
      let fm;
      try {
        fm = parseFrontmatter(readFileSync(cfgPath, "utf-8"));
      } catch (err) {
        return { ok: false, msg: `${cfgPath}: ${err.message}` };
      }
      if (!fm) {
        return { ok: false, msg: `${cfgPath}: no parseable frontmatter` };
      }
      if (fm.mode !== "local") {
        return {
          ok: false,
          msg: `${cfgPath}: mode is "${fm.mode || "(unset)"}" — expected "local"`,
          detail: { mode: fm.mode, path: cfgPath },
        };
      }
      if (!fm.memory_url) {
        return {
          ok: false,
          msg: `${cfgPath}: memory_url not set`,
          detail: { path: cfgPath },
        };
      }
      return {
        ok: true,
        msg: `${fm.memory_url} (${cfgPath})`,
        detail: { memory_url: fm.memory_url, path: cfgPath },
      };
    },
  };
}

function checkEngineHealth() {
  return {
    name: "engine /health",
    severity: SEVERITY.CRITICAL,
    run: async () => {
      const url = resolveEngineUrl();
      try {
        const res = await fetchWithTimeout(`${url.replace(/\/$/, "")}/health`);
        if (!res.ok) {
          return { ok: false, msg: `HTTP ${res.status} from ${url}/health` };
        }
        const data = await res.json();
        return {
          ok: true,
          msg: `${data.engine || "engine"} v${data.version || "?"} (${data.status})`,
          detail: data,
        };
      } catch (err) {
        return {
          ok: false,
          msg: `${url}/health unreachable: ${err.message}`,
          detail: { url },
        };
      }
    },
  };
}

function checkEngineLayers() {
  return {
    name: "engine layers (L0–L6)",
    severity: SEVERITY.WARNING,
    run: async () => {
      const url = resolveEngineUrl();
      try {
        const res = await fetchWithTimeout(`${url.replace(/\/$/, "")}/health`);
        if (!res.ok) return { ok: false, msg: `HTTP ${res.status}` };
        const data = await res.json();
        const layers = data.layers || {};
        const expected = ["l0", "l1", "l2", "l3", "l4", "l5", "l6"];
        const okList = [];
        const degradedList = [];
        for (const k of expected) {
          const status = layers[k];
          if (status === "ok") okList.push(k);
          else if (status) degradedList.push(`${k}=${status}`);
        }
        if (degradedList.length === 0) {
          return {
            ok: true,
            msg: `${okList.length}/7 ok`,
            detail: { layers },
          };
        }
        return {
          ok: false,
          msg: `${okList.length}/7 ok; degraded: ${degradedList.join(", ")}`,
          detail: { layers },
        };
      } catch (err) {
        return { ok: false, msg: err.message };
      }
    },
  };
}

function checkEmbeddingPath() {
  // Surfaces the engine's view of nv_embed (the URL it points at). If
  // that's "unreachable" or "http 4xx/5xx", L4/L5/L6 indexing won't work.
  // The engine reports this in /health under layers.nv_embed.
  return {
    name: "embedding endpoint (engine→external)",
    severity: SEVERITY.WARNING,
    run: async () => {
      const url = resolveEngineUrl();
      try {
        const res = await fetchWithTimeout(`${url.replace(/\/$/, "")}/health`);
        if (!res.ok) return { ok: false, msg: `engine /health HTTP ${res.status}` };
        const data = await res.json();
        const nv = data.layers?.nv_embed;
        if (nv === "ok") {
          return { ok: true, msg: "reachable" };
        }
        if (!nv) {
          return {
            ok: false,
            msg: "engine /health did not report nv_embed status",
          };
        }
        return {
          ok: false,
          msg: `nv_embed=${nv} — L4/L5/L6 indexing will fail. Check NV_EMBED_URL in packages/memory-engine/.env`,
          detail: { nv_embed: nv },
        };
      } catch (err) {
        return { ok: false, msg: err.message };
      }
    },
  };
}

function checkOllamaBindIfPresent() {
  // If the user is using Ollama as their embedding backend AND running
  // the engine in Docker, Ollama needs to be bound on all interfaces so
  // containers can reach it via host.docker.internal. Common gotcha.
  // We probe by checking whether Ollama is listening on something other
  // than 127.0.0.1 — we can't directly read systemd config, so we fall
  // back to probing 0.0.0.0:11434 from the host (which always works if
  // any interface is listening) vs trying to detect the bind address.
  //
  // Approach: hit /api/tags. If reachable on 127.0.0.1, Ollama is up;
  // we then warn if the user is in a Docker context (engine reachable)
  // because that's the configuration where the bind matters.
  return {
    name: "Ollama bind config (if used)",
    severity: SEVERITY.INFO,
    run: async () => {
      try {
        const res = await fetchWithTimeout(
          "http://127.0.0.1:11434/api/tags",
          {},
          1500
        );
        if (!res.ok) return { ok: true, msg: "Ollama not reachable on 127.0.0.1 — skipping (not used?)" };
      } catch {
        return { ok: true, msg: "Ollama not running locally — skipping" };
      }
      // Ollama IS running on host. Warn the user about the bind config.
      return {
        ok: true,
        msg: "Ollama running on host. If engine is containerised, ensure OLLAMA_HOST=0.0.0.0:11434 (see README)",
      };
    },
  };
}

export function localMemoryChecks() {
  return [
    checkPluginConfig(),
    checkEngineHealth(),
    checkEngineLayers(),
    checkEmbeddingPath(),
    checkOllamaBindIfPresent(),
  ];
}
