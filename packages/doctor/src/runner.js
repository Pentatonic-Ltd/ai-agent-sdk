/**
 * Doctor runner.
 *
 * Composes the active check set from detected paths + plugins, runs each
 * check (catching its own failures so one bad check can't take the rest
 * down), and aggregates results into a single report.
 *
 * Each check is shaped:
 *   {
 *     name: string,
 *     severity: 'critical' | 'warning' | 'info',
 *     run: async () => { ok: boolean, msg: string, detail?: object }
 *   }
 *
 * The runner does not print anything itself — pass the returned report to
 * renderHuman or renderJson. This keeps the runner usable from tests, MCP
 * servers, dashboards, etc.
 */

import { detectPaths, PATHS } from "./detect.js";
import { universalChecks } from "./checks/universal.js";
import { localMemoryChecks } from "./checks/local-memory.js";
import { hostedTesChecks } from "./checks/hosted-tes.js";
import { platformChecks } from "./checks/platform.js";
import { loadPlugins } from "./plugins.js";
import { SEVERITY } from "./index.js";

const DEFAULT_TIMEOUT_MS = 10_000;

function pathChecks(path) {
  switch (path) {
    case PATHS.LOCAL:
      return localMemoryChecks();
    case PATHS.HOSTED:
      return hostedTesChecks();
    case PATHS.PLATFORM:
      return platformChecks();
    default:
      return [];
  }
}

async function runOne(check, timeoutMs) {
  const start = Date.now();
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => check.run()),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`timed out after ${timeoutMs}ms`)),
          timeoutMs
        )
      ),
    ]);
    if (!result || typeof result.ok !== "boolean") {
      throw new Error("check returned invalid result (missing ok:boolean)");
    }
    return {
      name: check.name,
      severity: check.severity || SEVERITY.WARNING,
      ok: result.ok,
      msg: result.msg || (result.ok ? "ok" : "failed"),
      detail: result.detail || {},
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      name: check.name,
      severity: check.severity || SEVERITY.WARNING,
      ok: false,
      msg: `check itself failed: ${err.message}`,
      detail: {},
      durationMs: Date.now() - start,
    };
  }
}

function summarise(results) {
  let ok = 0;
  let warning = 0;
  let critical = 0;
  for (const r of results) {
    if (r.ok) ok += 1;
    else if (r.severity === SEVERITY.CRITICAL) critical += 1;
    else warning += 1;
  }
  return { ok, warning, critical, total: results.length };
}

export async function runDoctor(opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const paths = detectPaths(opts);

  // Universal checks always run.
  const checks = [...universalChecks()];
  for (const p of paths) {
    checks.push(...pathChecks(p));
  }

  // Plugins — opt-out via opts.plugins === false.
  let pluginCount = 0;
  if (opts.plugins !== false) {
    const plugins = await loadPlugins({ dir: opts.pluginDir });
    pluginCount = plugins.length;
    for (const plugin of plugins) {
      for (const check of plugin.checks || []) {
        checks.push({
          ...check,
          name: `${plugin.name}: ${check.name}`,
        });
      }
    }
  }

  // Allow extra checks to be passed in directly (used by tests).
  if (Array.isArray(opts.extraChecks)) {
    checks.push(...opts.extraChecks);
  }

  // Run sequentially to keep network probes from contending on the same
  // hosts; a parallel mode can be added later behind opts.concurrency.
  const results = [];
  for (const check of checks) {
    results.push(await runOne(check, timeoutMs));
  }

  return {
    timestamp: new Date().toISOString(),
    // Serialise as array so JSON.stringify produces something useful;
    // detection logic still uses a Set internally for membership checks.
    paths: [...paths],
    pluginCount,
    summary: summarise(results),
    checks: results,
  };
}
