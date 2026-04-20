/**
 * Universal checks — apply regardless of install path.
 *
 * Kept deliberately small: things that any SDK user benefits from
 * regardless of which path they're on.
 */

import { statfsSync, statSync } from "fs";
import { join } from "path";
import { homedir, tmpdir } from "os";
import { existsSync } from "fs";
import { SEVERITY } from "../index.js";

function checkNodeVersion() {
  return {
    name: "node version",
    severity: SEVERITY.WARNING,
    run: async () => {
      const v = process.versions.node;
      const major = parseInt(v.split(".")[0], 10);
      // The SDK's package.json doesn't pin engines, but the memory subsystem
      // uses fetch and top-level await — needs ≥ 18.
      if (major < 18) {
        return {
          ok: false,
          msg: `Node ${v} — SDK needs ≥18`,
          detail: { version: v, major },
        };
      }
      return { ok: true, msg: `Node ${v}`, detail: { version: v } };
    },
  };
}

function checkDiskSpace() {
  return {
    name: "disk space",
    severity: SEVERITY.WARNING,
    run: async () => {
      const targets = [homedir(), tmpdir()];
      const detail = {};
      const tight = [];
      for (const p of targets) {
        try {
          const s = statfsSync(p);
          const free = Number(s.bavail) * Number(s.bsize);
          const total = Number(s.blocks) * Number(s.bsize);
          if (!total) continue;
          const pctFree = (free / total) * 100;
          detail[p] = `${pctFree.toFixed(1)}% free`;
          if (pctFree < 10) {
            tight.push(`${p}: ${pctFree.toFixed(1)}% free`);
          }
        } catch {
          // statfsSync can be missing on older Node; skip silently
        }
      }
      if (tight.length) {
        return {
          ok: false,
          msg: tight.join("; "),
          detail,
        };
      }
      const summary = Object.entries(detail)
        .map(([k, v]) => `${k}=${v}`)
        .join("; ");
      return { ok: true, msg: summary || "skipped", detail };
    },
  };
}

function checkConfigPerms() {
  return {
    name: "config file perms",
    severity: SEVERITY.CRITICAL,
    run: async () => {
      // Files most likely to contain credentials. Each is optional;
      // we only fail if a file exists with overly-permissive mode.
      const candidates = [
        join(homedir(), ".claude", "tes-memory.local.md"),
        join(homedir(), ".claude-pentatonic", "tes-memory.local.md"),
        join(homedir(), ".config", "pentatonic-ai", "config.json"),
      ];
      const bad = [];
      const checked = [];
      for (const f of candidates) {
        if (!existsSync(f)) continue;
        checked.push(f);
        const mode = statSync(f).mode & 0o777;
        // Anything readable by group/other on a credential file is too open.
        if (mode & 0o077) {
          bad.push(`${f}: mode ${mode.toString(8)}`);
        }
      }
      if (bad.length) {
        return {
          ok: false,
          msg: `${bad.length} config file(s) world-readable; chmod 600`,
          detail: { offenders: bad },
        };
      }
      if (!checked.length) {
        return {
          ok: true,
          msg: "no SDK config files present (skipped)",
          detail: { checked: [] },
        };
      }
      return {
        ok: true,
        msg: `${checked.length} config file(s) ok`,
        detail: { checked },
      };
    },
  };
}

export function universalChecks() {
  return [checkNodeVersion(), checkDiskSpace(), checkConfigPerms()];
}
