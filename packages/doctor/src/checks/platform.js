/**
 * Self-hosted Pentatonic platform checks.
 *
 * The full platform layers HybridRAG + Qdrant + Neo4j + a vLLM/Ollama stack
 * on top of the Local-Memory pieces. URLs are entirely env-driven — no
 * container names hardcoded — so this works whether the user runs Pip,
 * Machinegenie, or any other instance with a different docker-compose
 * naming scheme.
 *
 * Required env (all optional individually; check is skipped if missing):
 *   HYBRIDRAG_URL    — e.g. http://hybridrag:8031
 *   QDRANT_URL       — e.g. http://qdrant:6333
 *   NEO4J_HTTP       — e.g. http://neo4j:7474
 *   NEO4J_USER       — defaults to 'neo4j'
 *   NEO4J_PASSWORD   — required if NEO4J_HTTP set
 *   VLLM_URL         — e.g. http://host.docker.internal:8001
 */

import { SEVERITY } from "../index.js";

async function fetchWithTimeout(url, opts = {}, timeoutMs = 5000) {
  return await fetch(url, {
    ...opts,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

function checkHybridrag() {
  return {
    name: "hybridrag reachable",
    severity: SEVERITY.CRITICAL,
    run: async () => {
      const url = process.env.HYBRIDRAG_URL;
      if (!url) {
        return { ok: true, msg: "HYBRIDRAG_URL not set (skipped)" };
      }
      try {
        const res = await fetchWithTimeout(`${url.replace(/\/$/, "")}/health`);
        if (res.ok) return { ok: true, msg: `${url} healthy` };
        // Some deployments don't expose /health — fall back to a search probe.
        const probe = await fetchWithTimeout(
          `${url.replace(/\/$/, "")}/v1/search`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query: "ping", limit: 1 }),
          }
        );
        if (probe.ok) return { ok: true, msg: `${url} healthy (search probe)` };
        return { ok: false, msg: `HTTP ${probe.status}` };
      } catch (err) {
        return { ok: false, msg: err.message };
      }
    },
  };
}

function checkQdrant() {
  return {
    name: "qdrant reachable",
    severity: SEVERITY.WARNING,
    run: async () => {
      const url = process.env.QDRANT_URL;
      if (!url) {
        return { ok: true, msg: "QDRANT_URL not set (skipped)" };
      }
      try {
        const res = await fetchWithTimeout(
          `${url.replace(/\/$/, "")}/collections`
        );
        if (!res.ok) return { ok: false, msg: `HTTP ${res.status}` };
        const data = await res.json();
        const cols = (data.result?.collections || []).map((c) => c.name);
        return {
          ok: true,
          msg: `${cols.length} collections: ${cols.slice(0, 5).join(", ")}${cols.length > 5 ? ", ..." : ""}`,
          detail: { collections: cols },
        };
      } catch (err) {
        return { ok: false, msg: err.message };
      }
    },
  };
}

function checkNeo4j() {
  return {
    name: "neo4j reachable",
    severity: SEVERITY.WARNING,
    run: async () => {
      const url = process.env.NEO4J_HTTP;
      if (!url) {
        return { ok: true, msg: "NEO4J_HTTP not set (skipped)" };
      }
      const user = process.env.NEO4J_USER || "neo4j";
      const pw = process.env.NEO4J_PASSWORD || process.env.NEO4J_PW;
      if (!pw) {
        return {
          ok: false,
          msg: "NEO4J_PASSWORD not set (NEO4J_HTTP requires auth)",
        };
      }
      try {
        const auth = Buffer.from(`${user}:${pw}`).toString("base64");
        const res = await fetchWithTimeout(
          `${url.replace(/\/$/, "")}/db/neo4j/tx/commit`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Basic ${auth}`,
            },
            body: JSON.stringify({
              statements: [{ statement: "RETURN 1 AS ok" }],
            }),
          }
        );
        if (res.status === 401) {
          return { ok: false, msg: "auth rejected — check NEO4J_PASSWORD" };
        }
        if (!res.ok) return { ok: false, msg: `HTTP ${res.status}` };
        const data = await res.json();
        if (data.errors?.length) {
          return {
            ok: false,
            msg: `query error: ${data.errors[0].message?.slice(0, 80)}`,
          };
        }
        return { ok: true, msg: "ok" };
      } catch (err) {
        return { ok: false, msg: err.message };
      }
    },
  };
}

function checkVllm() {
  return {
    name: "vllm reachable",
    severity: SEVERITY.WARNING,
    run: async () => {
      const url = process.env.VLLM_URL;
      if (!url) {
        return { ok: true, msg: "VLLM_URL not set (skipped)" };
      }
      try {
        const res = await fetchWithTimeout(
          `${url.replace(/\/$/, "")}/v1/models`
        );
        if (!res.ok) return { ok: false, msg: `HTTP ${res.status}` };
        const data = await res.json();
        const ids = (data.data || []).map((m) => m.id);
        if (!ids.length) {
          return { ok: false, msg: "no models loaded" };
        }
        return {
          ok: true,
          msg: `serving ${ids.join(", ")}`,
          detail: { models: ids },
        };
      } catch (err) {
        return { ok: false, msg: err.message };
      }
    },
  };
}

export function platformChecks() {
  return [checkHybridrag(), checkQdrant(), checkNeo4j(), checkVllm()];
}
