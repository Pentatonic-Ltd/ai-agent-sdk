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

/**
 * Verify the API key can actually write events — not just read.
 *
 * Motivation: reads (introspection, eventStream, semanticSearchMemories)
 * and writes (createModuleEvent) use different permission scopes on TES.
 * A key may pass every read check — so the existing "auth ok" probe is
 * green — yet fail every hook emission with "Access denied: requires
 * create:<moduleId>:{all,self}". That's exactly how Claude Code's
 * tes-memory plugin can sit silent for days with a happy-looking doctor.
 *
 * We fire a no-op createModuleEvent against each module the plugin
 * actually uses. Tagged `test: true` + `source: "doctor"` so operators
 * can filter it out in downstream analytics.
 *
 * If the resolver rejects the write, we surface the exact missing scope
 * from the error message (the resolver is helpful enough to say which
 * scope it wanted). Operators know precisely what to grant.
 */
function checkModuleEventWrites() {
  const probed = [
    { moduleId: "conversation-analytics", eventType: "SESSION_START" },
    { moduleId: "deep-memory", eventType: "STORE_MEMORY" },
  ];

  return {
    name: "TES module-event write scopes",
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

      const mutation = `
        mutation Probe($moduleId: String!, $input: ModuleEventInput!) {
          createModuleEvent(moduleId: $moduleId, input: $input) {
            success eventId
          }
        }
      `;
      const missingScopes = [];
      const probeResults = [];

      for (const { moduleId, eventType } of probed) {
        try {
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
                query: mutation,
                variables: {
                  moduleId,
                  input: {
                    eventType,
                    data: {
                      entity_id: `doctor-probe-${Date.now()}`,
                      attributes: {
                        test: true,
                        source: "doctor",
                        content: "doctor write-scope probe",
                      },
                    },
                  },
                },
              }),
            }
          );
          if (!res.ok) {
            probeResults.push({ moduleId, status: `HTTP ${res.status}` });
            continue;
          }
          const body = await res.json();
          if (body.errors?.length) {
            // Extract the exact scope from the resolver's error message.
            // Format: "Access denied: requires create:<scope>:all or create:<scope>:self"
            const err = body.errors[0].message || "";
            const match = err.match(/create:(\S+?):(all|self)/);
            if (match) {
              missingScopes.push(`create:${match[1]}:${match[2]}`);
              probeResults.push({
                moduleId,
                status: `missing create:${match[1]}:{all,self}`,
              });
            } else {
              probeResults.push({ moduleId, status: err.slice(0, 120) });
            }
            continue;
          }
          probeResults.push({ moduleId, status: "ok" });
        } catch (err) {
          probeResults.push({ moduleId, status: err.message });
        }
      }

      const ok = probeResults.every((r) => r.status === "ok");
      if (ok) {
        return {
          ok: true,
          msg: `write scopes verified on ${probeResults.length} module(s)`,
          detail: { probeResults },
        };
      }

      const uniqueMissing = [...new Set(missingScopes)];
      const fix = uniqueMissing.length
        ? `grant the admin role: ${uniqueMissing.join(", ")} — then re-save the role so new perms propagate to API keys`
        : "check the TES error messages in detail below";

      return {
        ok: false,
        msg: `write scopes not granted for ${probeResults.filter((r) => r.status !== "ok").map((r) => r.moduleId).join(", ")}`,
        detail: { probeResults, fix },
      };
    },
  };
}

export function hostedTesChecks() {
  return [checkTesReachable(), checkTesAuth(), checkModuleEventWrites()];
}
