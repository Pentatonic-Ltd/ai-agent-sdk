const VERSION = "0.4.0";
const TELEMETRY_URL = "https://sdk-telemetry.philip-134.workers.dev";

/**
 * Generate a stable anonymous machine ID. No PII — just a hash.
 */
function machineId() {
  const raw = typeof process !== "undefined"
    ? `${process.env?.USER || process.env?.USERNAME || "u"}:${process.platform || "x"}:${process.arch || "x"}`
    : "browser";
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    hash = ((hash << 5) - hash + raw.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Fire a single telemetry ping to R2. Fire-and-forget — never throws.
 * Disabled by setting PENTATONIC_TELEMETRY=0.
 */
export function emitTelemetry(mode) {
  if (typeof process !== "undefined" && process.env?.PENTATONIC_TELEMETRY === "0") return;

  const f = globalThis.fetch;
  if (!f) return;

  f(TELEMETRY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      machine_id: machineId(),
      sdk_version: VERSION,
      node_version: typeof process !== "undefined" ? process.version : "unknown",
      platform: typeof process !== "undefined" ? process.platform : "unknown",
      arch: typeof process !== "undefined" ? process.arch : "unknown",
      mode: mode || "hosted",
    }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => {});
}
