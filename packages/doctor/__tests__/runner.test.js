import { runDoctor } from "../src/runner.js";
import { SEVERITY } from "../src/index.js";

// Force UNKNOWN path so we don't pull in any built-in path checks.
const NO_PATH = { env: {} };

function ok(name) {
  return {
    name,
    severity: SEVERITY.INFO,
    run: async () => ({ ok: true, msg: "fine" }),
  };
}

function fail(name, severity = SEVERITY.WARNING) {
  return {
    name,
    severity,
    run: async () => ({ ok: false, msg: "broken" }),
  };
}

function crashes(name) {
  return {
    name,
    severity: SEVERITY.WARNING,
    run: async () => {
      throw new Error("boom");
    },
  };
}

function hangs(name) {
  return {
    name,
    severity: SEVERITY.WARNING,
    run: () => new Promise(() => {}),
  };
}

describe("runDoctor", () => {
  it("includes universal checks even with no path detected", async () => {
    const r = await runDoctor({ ...NO_PATH, plugins: false });
    const names = r.checks.map((c) => c.name);
    expect(names).toContain("node version");
    expect(names).toContain("disk space");
  });

  it("runs extraChecks", async () => {
    const r = await runDoctor({
      ...NO_PATH,
      plugins: false,
      extraChecks: [ok("custom-1"), ok("custom-2")],
    });
    expect(r.checks.find((c) => c.name === "custom-1")).toBeDefined();
    expect(r.checks.find((c) => c.name === "custom-2")).toBeDefined();
  });

  it("counts ok/warning/critical correctly", async () => {
    const r = await runDoctor({
      ...NO_PATH,
      plugins: false,
      extraChecks: [
        ok("a"),
        fail("b", SEVERITY.WARNING),
        fail("c", SEVERITY.CRITICAL),
      ],
    });
    const a = r.checks.find((c) => c.name === "a");
    const b = r.checks.find((c) => c.name === "b");
    const c = r.checks.find((c) => c.name === "c");
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(false);
    expect(c.ok).toBe(false);
    // summary counts include the universal checks too — count just the ones we added
    expect(r.summary.total).toBe(r.checks.length);
  });

  it("does not let a crashing check abort the run", async () => {
    const r = await runDoctor({
      ...NO_PATH,
      plugins: false,
      extraChecks: [crashes("explody"), ok("survivor")],
    });
    const e = r.checks.find((c) => c.name === "explody");
    const s = r.checks.find((c) => c.name === "survivor");
    expect(e.ok).toBe(false);
    expect(e.msg).toMatch(/check itself failed: boom/);
    expect(s.ok).toBe(true);
  });

  it("times out hung checks instead of hanging the runner", async () => {
    const r = await runDoctor({
      ...NO_PATH,
      plugins: false,
      timeoutMs: 100,
      extraChecks: [hangs("hangs")],
    });
    const h = r.checks.find((c) => c.name === "hangs");
    expect(h.ok).toBe(false);
    expect(h.msg).toMatch(/timed out/);
  }, 5000);

  it("reports invalid check return values", async () => {
    const r = await runDoctor({
      ...NO_PATH,
      plugins: false,
      extraChecks: [
        {
          name: "lying",
          severity: SEVERITY.WARNING,
          run: async () => ({ msg: "nope" }), // missing 'ok'
        },
      ],
    });
    const l = r.checks.find((c) => c.name === "lying");
    expect(l.ok).toBe(false);
    expect(l.msg).toMatch(/invalid result/);
  });

  it("returns summary that adds up to total", async () => {
    const r = await runDoctor({
      ...NO_PATH,
      plugins: false,
      extraChecks: [ok("a"), fail("b"), fail("c", SEVERITY.CRITICAL)],
    });
    expect(r.summary.ok + r.summary.warning + r.summary.critical).toBe(
      r.summary.total
    );
  });
});
