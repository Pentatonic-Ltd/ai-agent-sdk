/**
 * @pentatonic-ai/ai-agent-sdk/doctor
 *
 * Generic health check runner for SDK installations.
 *
 * Auto-detects the install path (local memory / hosted TES / self-hosted
 * platform), runs the appropriate built-in checks, plus any plugins the
 * user has dropped into ~/.config/pentatonic-ai/doctor-plugins/.
 *
 * Each check is a small descriptor:
 *   { name, severity: 'critical'|'warning'|'info', run: async () => result }
 * where result is { ok, msg, detail? }.
 *
 * @example
 * import { runDoctor } from '@pentatonic-ai/ai-agent-sdk/doctor';
 * const report = await runDoctor({ path: 'auto' });
 * console.log(report.summary);
 */

export { runDoctor } from "./runner.js";
export { detectPath, PATHS } from "./detect.js";
export { loadPlugins, PLUGIN_DIR } from "./plugins.js";
export { renderHuman, renderJson } from "./output.js";
export { universalChecks } from "./checks/universal.js";
export { localMemoryChecks } from "./checks/local-memory.js";
export { hostedTesChecks } from "./checks/hosted-tes.js";
export { dataFlowChecks } from "./checks/data-flow.js";
export { platformChecks } from "./checks/platform.js";
export { claudeCodeChecks } from "./checks/claude-code.js";

export const SEVERITY = Object.freeze({
  CRITICAL: "critical",
  WARNING: "warning",
  INFO: "info",
});
