/**
 * Hosted TES path checks.
 *
 * Verifies that TES_ENDPOINT is reachable and TES_API_KEY is accepted
 * for the configured TES_CLIENT_ID. Uses a tiny GraphQL probe so we
 * exercise the same auth path the SDK uses at runtime.
 */

import { SEVERITY } from "../index.js";

async function fetchWithTimeout(url, opts = {}, timeoutMs = 5000) {
  return await fetch(url, {
    ...opts,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

function checkTesReachable() {
  return {
    name: "TES endpoint reachable",
    severity: SEVERITY.CRITICAL,
    run: async () => {
      const endpoint = process.env.TES_ENDPOINT;
      if (!endpoint) {
        return { ok: false, msg: "TES_ENDPOINT not set" };
      }
      try {
        const res = await fetchWithTimeout(`${endpoint.replace(/\/$/, "")}/api/health`);
        if (res.ok) {
          return { ok: true, msg: `${endpoint} reachable` };
        }
        // Many TES deployments don't expose /api/health; fall back to a
        // GraphQL introspection ping which is always available.
        const probe = await fetchWithTimeout(
          `${endpoint.replace(/\/$/, "")}/api/graphql`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query: "{ __typename }" }),
          }
        );
        if (probe.ok || probe.status === 401) {
          // 401 is fine here — it proves the server is alive; auth is
          // a separate check below.
          return { ok: true, msg: `${endpoint} reachable (graphql)` };
        }
        return { ok: false, msg: `HTTP ${probe.status}` };
      } catch (err) {
        return { ok: false, msg: err.message };
      }
    },
  };
}

function checkTesAuth() {
  return {
    name: "TES API key valid",
    severity: SEVERITY.CRITICAL,
    run: async () => {
      const endpoint = process.env.TES_ENDPOINT;
      const apiKey = process.env.TES_API_KEY;
      const clientId = process.env.TES_CLIENT_ID;
      if (!endpoint || !apiKey || !clientId) {
        return {
          ok: false,
          msg: "TES_ENDPOINT / TES_API_KEY / TES_CLIENT_ID required",
        };
      }
      try {
        // viewer / me-style query — exact name varies by deployment, so
        // we use a generic introspection that should always require auth.
        const res = await fetchWithTimeout(
          `${endpoint.replace(/\/$/, "")}/api/graphql`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
              "x-client-id": clientId,
            },
            body: JSON.stringify({
              query: "{ __schema { queryType { name } } }",
            }),
          }
        );
        if (res.status === 401 || res.status === 403) {
          return {
            ok: false,
            msg: `auth rejected (HTTP ${res.status}) — check API key + client ID`,
          };
        }
        if (!res.ok) {
          return { ok: false, msg: `HTTP ${res.status}` };
        }
        return {
          ok: true,
          msg: `key accepted for ${clientId}`,
          detail: { clientId, endpoint },
        };
      } catch (err) {
        return { ok: false, msg: err.message };
      }
    },
  };
}

export function hostedTesChecks() {
  return [checkTesReachable(), checkTesAuth()];
}
