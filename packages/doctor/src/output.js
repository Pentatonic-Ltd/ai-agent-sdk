/**
 * Output renderers for doctor reports.
 *
 * Two formats: human (table-ish, emoji per result) and JSON (machine).
 * Both consume the report shape from runner.js.
 */

import { SEVERITY } from "./index.js";

const EMOJI = {
  ok: "✓",
  critical: "✗",
  warning: "!",
  info: "i",
};

function emojiFor(result) {
  if (result.ok) return EMOJI.ok;
  if (result.severity === SEVERITY.CRITICAL) return EMOJI.critical;
  return EMOJI.warning;
}

function pad(s, width) {
  if (s.length >= width) return s;
  return s + " ".repeat(width - s.length);
}

export function renderHuman(report) {
  if (!report.checks.length) {
    return "no checks were run";
  }
  const width = Math.min(
    40,
    report.checks.reduce((m, c) => Math.max(m, c.name.length), 0)
  );
  const lines = [];
  lines.push(`paths detected: ${report.paths.join(", ")}`);
  if (report.pluginCount) {
    lines.push(`plugins loaded: ${report.pluginCount}`);
  }
  lines.push("");
  for (const r of report.checks) {
    lines.push(`${emojiFor(r)}  ${pad(r.name, width)}  ${r.msg}`);
  }
  lines.push("");
  const { ok, warning, critical, total } = report.summary;
  lines.push(
    `summary: ${ok} ok, ${warning} warning, ${critical} critical (of ${total})`
  );
  return lines.join("\n");
}

export function renderJson(report, { pretty = true } = {}) {
  return JSON.stringify(report, null, pretty ? 2 : 0);
}
