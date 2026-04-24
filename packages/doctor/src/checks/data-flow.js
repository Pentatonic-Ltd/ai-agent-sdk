/**
 * Hosted TES data-flow checks.
 *
 * The existing hosted-tes checks prove the TES server is up and the API
 * key is accepted. They don't prove data is actually flowing end-to-end —
 * you can have a green doctor pass while the Claude Code hook is silently
 * dropping events, or while vector retrieval is returning nothing at the
 * configured minScore.
 *
 * These checks close that gap with three real-data probes against the
 * same GraphQL endpoint the SDK already uses at runtime:
 *
 *   - "TES event stream has data"      — events table has rows at all
 *   - "MEMORY_CREATED events present"  — memory events exist for this client
 *   - "semantic search returns hits"   — a broad probe query retrieves > 0
 *
 * All three are WARNINGs by default: a green liveness check + a "0 events"
 * warning is more informative than pretending liveness implies correctness,
 * but an empty stream on a fresh install is legitimate and shouldn't fail
 * the overall doctor pass.
 */

import { SEVERITY } from "../index.js";

async function fetchWithTimeout(url, opts = {}, timeoutMs = 5000) {
  return await fetch(url, {
    ...opts,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function graphql(endpoint, apiKey, clientId, query, variables) {
  const res = await fetchWithTimeout(
    `${endpoint.replace(/\/$/, "")}/api/graphql`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "x-client-id": clientId,
      },
      body: JSON.stringify({ query, variables }),
    },
    10_000
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
  }
  const body = await res.json();
  if (body.errors?.length) {
    throw new Error(body.errors[0].message || "graphql error");
  }
  return body.data;
}

function requireHostedEnv() {
  const endpoint = process.env.TES_ENDPOINT;
  const apiKey = process.env.TES_API_KEY;
  const clientId = process.env.TES_CLIENT_ID;
  if (!endpoint || !apiKey || !clientId) {
    return {
      missing: true,
      reason: "TES_ENDPOINT / TES_API_KEY / TES_CLIENT_ID required",
    };
  }
  return { endpoint, apiKey, clientId };
}

function checkEventStreamHasData() {
  return {
    name: "TES event stream has data",
    severity: SEVERITY.WARNING,
    run: async () => {
      const env = requireHostedEnv();
      if (env.missing) return { ok: false, msg: env.reason };
      try {
        // Deployments vary in exactly how events are counted, so we use
        // the aggregate count exposed via a small events() list+total.
        // `first: 1` keeps the payload tiny — we only care about the total.
        const data = await graphql(
          env.endpoint,
          env.apiKey,
          env.clientId,
          `query DoctorEventCount { events(first: 1) { totalCount } }`
        );
        const total = data?.events?.totalCount ?? 0;
        if (total > 0) {
          return {
            ok: true,
            msg: `${total} event(s) in stream`,
            detail: { totalCount: total },
          };
        }
        return {
          ok: false,
          msg: "0 events yet — send one prompt to your agent and re-run",
          detail: { totalCount: 0 },
        };
      } catch (err) {
        return { ok: false, msg: err.message };
      }
    },
  };
}

function checkMemoryCreatedForClient() {
  return {
    name: "MEMORY_CREATED events for client",
    severity: SEVERITY.WARNING,
    run: async () => {
      const env = requireHostedEnv();
      if (env.missing) return { ok: false, msg: env.reason };
      try {
        const data = await graphql(
          env.endpoint,
          env.apiKey,
          env.clientId,
          `query DoctorMemCount($kind: String!, $client: String!) {
             events(first: 1, filter: { kind: $kind, clientId: $client }) {
               totalCount
             }
           }`,
          { kind: "MEMORY_CREATED", client: env.clientId }
        );
        const total = data?.events?.totalCount ?? 0;
        if (total > 0) {
          return {
            ok: true,
            msg: `${total} MEMORY_CREATED event(s) for ${env.clientId}`,
            detail: { totalCount: total, clientId: env.clientId },
          };
        }
        return {
          ok: false,
          msg: `no MEMORY_CREATED events for ${env.clientId} yet — hook may not be writing memories`,
          detail: { totalCount: 0, clientId: env.clientId },
        };
      } catch (err) {
        return { ok: false, msg: err.message };
      }
    },
  };
}

function checkSemanticSearchReturnsHits() {
  return {
    name: "semanticSearchMemories returns hits",
    severity: SEVERITY.WARNING,
    run: async () => {
      const env = requireHostedEnv();
      if (env.missing) return { ok: false, msg: env.reason };
      try {
        // A broad probe query. Low minScore (0.1) because the point of this
        // check is "does retrieval work at all", not "does retrieval rank
        // well". A follow-up tuning warning can be a separate check later.
        const query = process.env.PENTATONIC_DOCTOR_PROBE_QUERY || "heartbeat";
        const minScore = 0.1;
        const data = await graphql(
          env.endpoint,
          env.apiKey,
          env.clientId,
          `query DoctorSearch($q: String!, $minScore: Float!) {
             semanticSearchMemories(query: $q, minScore: $minScore, limit: 5) {
               id
               score
             }
           }`,
          { q: query, minScore }
        );
        const hits = data?.semanticSearchMemories ?? [];
        if (hits.length > 0) {
          return {
            ok: true,
            msg: `${hits.length} hit(s) for "${query}" at minScore=${minScore}`,
            detail: { query, minScore, hits: hits.length },
          };
        }
        return {
          ok: false,
          msg: `0 hits for "${query}" at minScore=${minScore} — try lowering minScore or PENTATONIC_DOCTOR_PROBE_QUERY`,
          detail: { query, minScore, hits: 0 },
        };
      } catch (err) {
        // A "field not found" GraphQL error means the deployment doesn't
        // expose semanticSearchMemories yet — downgrade to info rather than
        // pretending retrieval is broken.
        if (/semanticSearchMemories/i.test(err.message)) {
          return {
            ok: true,
            msg: "semanticSearchMemories not exposed by this deployment (skipped)",
          };
        }
        return { ok: false, msg: err.message };
      }
    },
  };
}

export function dataFlowChecks() {
  return [
    checkEventStreamHasData(),
    checkMemoryCreatedForClient(),
    checkSemanticSearchReturnsHits(),
  ];
}
