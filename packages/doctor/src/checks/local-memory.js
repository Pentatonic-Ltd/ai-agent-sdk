/**
 * Local Memory path checks.
 *
 * Targets the stack started by `npx @pentatonic-ai/ai-agent-sdk memory`:
 *   - PostgreSQL with pgvector
 *   - Ollama (or any OpenAI-compatible embedding + chat endpoint)
 *   - Memory MCP server on PORT (default 3333)
 *
 * Configuration is read from env vars used by packages/memory/src/server.js
 * (DATABASE_URL, EMBEDDING_URL/MODEL, LLM_URL/MODEL, PORT, API_KEY) so this
 * stays drift-free with the actual server.
 */

import { SEVERITY } from "../index.js";

async function fetchWithTimeout(url, opts = {}, timeoutMs = 5000) {
  return await fetch(url, {
    ...opts,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

function checkPostgres() {
  return {
    name: "postgres reachable",
    severity: SEVERITY.CRITICAL,
    run: async () => {
      const dsn = process.env.DATABASE_URL;
      if (!dsn) {
        return {
          ok: false,
          msg: "DATABASE_URL not set",
        };
      }
      // Lazy-import pg so users on hosted/platform paths don't pay the cost.
      let pg;
      try {
        pg = (await import("pg")).default;
      } catch {
        return {
          ok: false,
          msg: "'pg' not installed — run `npm install pg`",
        };
      }
      const client = new pg.Client({ connectionString: dsn });
      try {
        await client.connect();
        const v = await client.query("SELECT version()");
        return {
          ok: true,
          msg: v.rows[0].version.split(",")[0],
          detail: { version: v.rows[0].version },
        };
      } catch (err) {
        return {
          ok: false,
          msg: err.message,
        };
      } finally {
        await client.end().catch(() => {});
      }
    },
  };
}

function checkPgvector() {
  return {
    name: "pgvector extension",
    severity: SEVERITY.CRITICAL,
    run: async () => {
      const dsn = process.env.DATABASE_URL;
      if (!dsn) return { ok: false, msg: "DATABASE_URL not set" };
      let pg;
      try {
        pg = (await import("pg")).default;
      } catch {
        return { ok: false, msg: "'pg' not installed" };
      }
      const client = new pg.Client({ connectionString: dsn });
      try {
        await client.connect();
        const r = await client.query(
          "SELECT extversion FROM pg_extension WHERE extname='vector'"
        );
        if (!r.rowCount) {
          return {
            ok: false,
            msg: "pgvector not installed — run CREATE EXTENSION vector",
          };
        }
        return {
          ok: true,
          msg: `pgvector ${r.rows[0].extversion}`,
          detail: { version: r.rows[0].extversion },
        };
      } catch (err) {
        return { ok: false, msg: err.message };
      } finally {
        await client.end().catch(() => {});
      }
    },
  };
}

function checkMigrations() {
  return {
    name: "schema migrations applied",
    severity: SEVERITY.WARNING,
    run: async () => {
      const dsn = process.env.DATABASE_URL;
      if (!dsn) return { ok: false, msg: "DATABASE_URL not set" };
      let pg;
      try {
        pg = (await import("pg")).default;
      } catch {
        return { ok: false, msg: "'pg' not installed" };
      }
      const client = new pg.Client({ connectionString: dsn });
      try {
        await client.connect();
        // The migration runner creates schema_migrations on first apply.
        const r = await client.query(
          "SELECT count(*) AS n FROM schema_migrations"
        );
        const n = parseInt(r.rows[0].n, 10);
        if (n === 0) {
          return {
            ok: false,
            msg: "schema_migrations is empty — start the memory server to run migrations",
          };
        }
        return { ok: true, msg: `${n} migrations applied`, detail: { n } };
      } catch (err) {
        if (/relation .* does not exist/.test(err.message)) {
          return {
            ok: false,
            msg: "schema_migrations table missing — start the memory server first",
          };
        }
        return { ok: false, msg: err.message };
      } finally {
        await client.end().catch(() => {});
      }
    },
  };
}

function checkEmbeddingEndpoint() {
  return {
    name: "embedding endpoint",
    severity: SEVERITY.CRITICAL,
    run: async () => {
      const url = process.env.EMBEDDING_URL;
      const model = process.env.EMBEDDING_MODEL;
      if (!url || !model) {
        return {
          ok: false,
          msg: "EMBEDDING_URL or EMBEDDING_MODEL not set",
        };
      }
      // Probe with a 1-token embed call against the OpenAI-compatible API.
      try {
        const headers = { "Content-Type": "application/json" };
        if (process.env.API_KEY) {
          headers.Authorization = `Bearer ${process.env.API_KEY}`;
        }
        const res = await fetchWithTimeout(
          `${url.replace(/\/$/, "")}/embeddings`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({ model, input: "ping" }),
          }
        );
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          return {
            ok: false,
            msg: `HTTP ${res.status}: ${body.slice(0, 120)}`,
          };
        }
        const data = await res.json();
        const dim = data.data?.[0]?.embedding?.length;
        if (!dim) {
          return {
            ok: false,
            msg: "endpoint responded but returned no embedding",
          };
        }
        return {
          ok: true,
          msg: `${model} ok (${dim}-dim)`,
          detail: { url, model, dim },
        };
      } catch (err) {
        return { ok: false, msg: err.message };
      }
    },
  };
}

function checkLlmEndpoint() {
  return {
    name: "llm endpoint",
    severity: SEVERITY.CRITICAL,
    run: async () => {
      const url = process.env.LLM_URL;
      const model = process.env.LLM_MODEL;
      if (!url || !model) {
        return {
          ok: false,
          msg: "LLM_URL or LLM_MODEL not set",
        };
      }
      // /models is cheap and present on every OpenAI-compatible server.
      try {
        const headers = {};
        if (process.env.API_KEY) {
          headers.Authorization = `Bearer ${process.env.API_KEY}`;
        }
        const res = await fetchWithTimeout(
          `${url.replace(/\/$/, "")}/models`,
          { headers }
        );
        if (!res.ok) {
          return { ok: false, msg: `HTTP ${res.status}` };
        }
        const data = await res.json();
        const ids = (data.data || []).map((m) => m.id);
        if (model && !ids.includes(model)) {
          return {
            ok: false,
            msg: `${model} not loaded; available: ${ids.slice(0, 3).join(", ")}`,
            detail: { url, requested: model, available: ids },
          };
        }
        return {
          ok: true,
          msg: `${model} loaded`,
          detail: { url, model },
        };
      } catch (err) {
        return { ok: false, msg: err.message };
      }
    },
  };
}

function checkMemoryServer() {
  return {
    name: "memory server",
    severity: SEVERITY.WARNING,
    run: async () => {
      // The MCP server uses stdio by default but exposes PORT for HTTP/SSE.
      // If PORT isn't bound we can't probe — that's not an error, just info.
      const port = process.env.PORT || "3333";
      const url = `http://127.0.0.1:${port}/`;
      try {
        const res = await fetchWithTimeout(url, {}, 2000);
        return {
          ok: true,
          msg: `port ${port} reachable (HTTP ${res.status})`,
          detail: { url, status: res.status },
        };
      } catch (err) {
        // Connection refused is the common case when the server is run
        // via stdio only — surface as info so users aren't alarmed.
        if (/ECONNREFUSED|fetch failed/.test(err.message)) {
          return {
            ok: true,
            msg: `port ${port} not bound (running via stdio? — skipped)`,
            detail: { url },
          };
        }
        return { ok: false, msg: err.message };
      }
    },
  };
}

export function localMemoryChecks() {
  return [
    checkPostgres(),
    checkPgvector(),
    checkMigrations(),
    checkEmbeddingEndpoint(),
    checkLlmEndpoint(),
    checkMemoryServer(),
  ];
}
