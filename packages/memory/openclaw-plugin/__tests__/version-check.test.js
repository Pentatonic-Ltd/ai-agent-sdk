/**
 * Server-version mismatch warning — plugin checks the local memory
 * server's /health payload and warns loudly (stderr) when the server
 * is older than MIN_SERVER_VERSION. Catches the common footgun of
 * updating the plugin without re-running `npx ... memory` to rebuild
 * the Docker stack.
 */

import plugin from "../index.js";

const realFetch = globalThis.fetch;

// Capture console.error so tests can assert on warnings.
function captureWarnings() {
  const warnings = [];
  const orig = console.error;
  console.error = (...args) => warnings.push(args.join(" "));
  return {
    warnings,
    restore: () => {
      console.error = orig;
    },
  };
}

function mockHealth(body, ok = true) {
  globalThis.fetch = async (url) => {
    if (url.endsWith("/health")) {
      return {
        ok,
        status: ok ? 200 : 500,
        json: async () => body,
      };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
}

function makeEngine(extraConfig = {}) {
  let factory;
  plugin.register({
    pluginConfig: {
      memory_url: "http://localhost:3333",
      ...extraConfig,
    },
    registerTool: () => {},
    registerContextEngine: (_n, fn) => {
      factory = fn;
    },
  });
  return factory();
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("memory server version check", () => {
  it("warns when server is older than MIN_SERVER_VERSION", async () => {
    mockHealth({ status: "ok", version: "0.4.5" });
    const cap = captureWarnings();
    const engine = makeEngine();
    // register schedules a localHealth() call asynchronously — await it
    await new Promise((resolve) => setTimeout(resolve, 50));
    cap.restore();

    const warning = cap.warnings.find((w) =>
      w.includes("memory server is 0.4.5")
    );
    expect(warning).toBeDefined();
    expect(warning).toMatch(/npx @pentatonic-ai\/ai-agent-sdk@latest memory/);
  });

  it("does NOT warn when server is at MIN_SERVER_VERSION", async () => {
    mockHealth({ status: "ok", version: "0.5.0" });
    const cap = captureWarnings();
    makeEngine();
    await new Promise((resolve) => setTimeout(resolve, 50));
    cap.restore();

    const warning = cap.warnings.find((w) => w.includes("memory server is"));
    expect(warning).toBeUndefined();
  });

  it("does NOT warn when server is newer than MIN_SERVER_VERSION", async () => {
    mockHealth({ status: "ok", version: "1.2.3" });
    const cap = captureWarnings();
    makeEngine();
    await new Promise((resolve) => setTimeout(resolve, 50));
    cap.restore();

    const warning = cap.warnings.find((w) => w.includes("memory server is"));
    expect(warning).toBeUndefined();
  });

  it("does NOT warn when health payload lacks a version field", async () => {
    // Older servers that predate the version field in /health — silent,
    // don't spam warnings on something the user can't diagnose.
    mockHealth({ status: "ok" });
    const cap = captureWarnings();
    makeEngine();
    await new Promise((resolve) => setTimeout(resolve, 50));
    cap.restore();

    const warning = cap.warnings.find((w) => w.includes("memory server is"));
    expect(warning).toBeUndefined();
  });

  it("does NOT warn when server is unreachable", async () => {
    globalThis.fetch = async () => {
      throw new Error("connection refused");
    };
    const cap = captureWarnings();
    makeEngine();
    await new Promise((resolve) => setTimeout(resolve, 50));
    cap.restore();

    const warning = cap.warnings.find((w) => w.includes("memory server is"));
    expect(warning).toBeUndefined();
  });

  it("only warns once per server version (deduplicates)", async () => {
    mockHealth({ status: "ok", version: "0.4.0" });
    const cap = captureWarnings();
    // Register twice — simulates multiple context-engine factory calls.
    makeEngine();
    makeEngine();
    await new Promise((resolve) => setTimeout(resolve, 100));
    cap.restore();

    const warnings = cap.warnings.filter((w) =>
      w.includes("memory server is 0.4.0")
    );
    expect(warnings).toHaveLength(1);
  });
});
