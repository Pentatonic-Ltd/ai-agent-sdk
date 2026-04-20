/**
 * Plugin loader for doctor.
 *
 * Looks in ~/.config/pentatonic-ai/doctor-plugins/ (overridable) for
 * .mjs files and dynamically imports each one. (.js is intentionally
 * not supported — without a sibling package.json setting "type":"module",
 * Node treats .js as CommonJS, which can't use `export default`. Forcing
 * .mjs sidesteps that whole class of confusion.) The default export
 * must look like:
 *
 *   export default {
 *     name: 'my-plugin',
 *     checks: [
 *       { name: 'thing reachable', severity: 'warning',
 *         run: async () => ({ ok: true, msg: '...' }) },
 *     ],
 *   };
 *
 * This is how downstream agents (e.g. Optimus on the Machinegenie stack)
 * register their own checks without forking the SDK.
 *
 * Bad plugins are skipped with a warning rather than aborting the run —
 * a broken plugin should never block a doctor pass.
 */

import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { pathToFileURL } from "url";

export const PLUGIN_DIR = join(
  homedir(),
  ".config",
  "pentatonic-ai",
  "doctor-plugins"
);

function isValidPlugin(mod) {
  if (!mod || typeof mod !== "object") return false;
  if (typeof mod.name !== "string" || !mod.name) return false;
  if (!Array.isArray(mod.checks)) return false;
  for (const c of mod.checks) {
    if (!c || typeof c.name !== "string" || typeof c.run !== "function") {
      return false;
    }
  }
  return true;
}

export async function loadPlugins({ dir = PLUGIN_DIR, onError } = {}) {
  if (!existsSync(dir)) return [];

  const warn = onError || (() => {});

  let entries;
  try {
    entries = readdirSync(dir);
  } catch (err) {
    warn(`could not read plugin dir ${dir}: ${err.message}`);
    return [];
  }

  const plugins = [];
  for (const entry of entries) {
    if (!entry.endsWith(".mjs")) continue;
    const filePath = join(dir, entry);
    try {
      const mod = await import(pathToFileURL(filePath).href);
      const plugin = mod.default || mod;
      if (!isValidPlugin(plugin)) {
        warn(`${entry}: not a valid plugin (missing name/checks)`);
        continue;
      }
      plugins.push(plugin);
    } catch (err) {
      warn(`${entry}: failed to load — ${err.message}`);
    }
  }

  return plugins;
}
