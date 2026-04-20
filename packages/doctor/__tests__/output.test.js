import { renderHuman, renderJson } from "../src/output.js";
import { SEVERITY } from "../src/index.js";
import { PATHS } from "../src/detect.js";

const sampleReport = {
  timestamp: "2026-04-18T08:00:00.000Z",
  paths: [PATHS.HOSTED],
  pluginCount: 2,
  summary: { ok: 2, warning: 1, critical: 1, total: 4 },
  checks: [
    {
      name: "good",
      severity: SEVERITY.INFO,
      ok: true,
      msg: "all fine",
      detail: {},
      durationMs: 5,
    },
    {
      name: "bad",
      severity: SEVERITY.WARNING,
      ok: false,
      msg: "kinda broken",
      detail: {},
      durationMs: 5,
    },
    {
      name: "broken",
      severity: SEVERITY.CRITICAL,
      ok: false,
      msg: "very broken",
      detail: {},
      durationMs: 5,
    },
    {
      name: "good2",
      severity: SEVERITY.INFO,
      ok: true,
      msg: "fine",
      detail: {},
      durationMs: 5,
    },
  ],
};

describe("renderHuman", () => {
  it("includes detected paths line", () => {
    const out = renderHuman(sampleReport);
    expect(out).toMatch(/paths detected: hosted/);
  });

  it("includes plugin count when non-zero", () => {
    const out = renderHuman(sampleReport);
    expect(out).toMatch(/plugins loaded: 2/);
  });

  it("uses ✓ for ok checks", () => {
    expect(renderHuman(sampleReport)).toMatch(/✓ {2}good/);
  });

  it("uses ✗ for critical failures", () => {
    expect(renderHuman(sampleReport)).toMatch(/✗ {2}broken/);
  });

  it("uses ! for warnings", () => {
    expect(renderHuman(sampleReport)).toMatch(/! {2}bad/);
  });

  it("includes the summary line", () => {
    expect(renderHuman(sampleReport)).toMatch(
      /summary: 2 ok, 1 warning, 1 critical \(of 4\)/
    );
  });

  it("handles empty reports", () => {
    const out = renderHuman({
      ...sampleReport,
      checks: [],
      summary: { ok: 0, warning: 0, critical: 0, total: 0 },
    });
    expect(out).toMatch(/no checks/);
  });
});

describe("renderJson", () => {
  it("emits valid JSON", () => {
    const out = renderJson(sampleReport);
    const parsed = JSON.parse(out);
    expect(parsed.summary.total).toBe(4);
    expect(parsed.checks).toHaveLength(4);
  });
});
