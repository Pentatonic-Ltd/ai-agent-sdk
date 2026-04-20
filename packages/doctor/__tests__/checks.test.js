import { universalChecks } from "../src/checks/universal.js";
import { hostedTesChecks } from "../src/checks/hosted-tes.js";
import { platformChecks } from "../src/checks/platform.js";

// fetch mocking — we don't want any real network in unit tests.
const realFetch = globalThis.fetch;

function mockFetch(handler) {
  globalThis.fetch = async (url, opts) => handler(url, opts);
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("universal checks", () => {
  it("registers the expected names", () => {
    const names = universalChecks().map((c) => c.name);
    expect(names).toContain("node version");
    expect(names).toContain("disk space");
    expect(names).toContain("config file perms");
  });

  it("node version returns ok on Node ≥18", async () => {
    const node = universalChecks().find((c) => c.name === "node version");
    const r = await node.run();
    expect(r.ok).toBe(true);
  });
});

describe("hosted TES checks", () => {
  beforeEach(() => {
    delete process.env.TES_ENDPOINT;
    delete process.env.TES_API_KEY;
    delete process.env.TES_CLIENT_ID;
  });

  it("reports missing env clearly", async () => {
    const reach = hostedTesChecks().find(
      (c) => c.name === "TES endpoint reachable"
    );
    const r = await reach.run();
    expect(r.ok).toBe(false);
    expect(r.msg).toMatch(/TES_ENDPOINT/);
  });

  it("treats /api/health 200 as reachable", async () => {
    process.env.TES_ENDPOINT = "https://example.test";
    mockFetch(async () => ({
      ok: true,
      status: 200,
      text: async () => "",
      json: async () => ({}),
    }));
    const reach = hostedTesChecks().find(
      (c) => c.name === "TES endpoint reachable"
    );
    const r = await reach.run();
    expect(r.ok).toBe(true);
  });

  it("falls back to graphql when /api/health 404s", async () => {
    process.env.TES_ENDPOINT = "https://example.test";
    let calls = 0;
    mockFetch(async (url) => {
      calls++;
      if (url.endsWith("/api/health")) {
        return { ok: false, status: 404, text: async () => "" };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });
    const reach = hostedTesChecks().find(
      (c) => c.name === "TES endpoint reachable"
    );
    const r = await reach.run();
    expect(r.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it("rejects 401 from auth check", async () => {
    process.env.TES_ENDPOINT = "https://example.test";
    process.env.TES_API_KEY = "bad";
    process.env.TES_CLIENT_ID = "c";
    mockFetch(async () => ({ ok: false, status: 401, text: async () => "" }));
    const auth = hostedTesChecks().find((c) => c.name === "TES API key valid");
    const r = await auth.run();
    expect(r.ok).toBe(false);
    expect(r.msg).toMatch(/auth rejected/);
  });

  it("accepts 200 from auth check", async () => {
    process.env.TES_ENDPOINT = "https://example.test";
    process.env.TES_API_KEY = "good";
    process.env.TES_CLIENT_ID = "c";
    mockFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { __schema: {} } }),
    }));
    const auth = hostedTesChecks().find((c) => c.name === "TES API key valid");
    const r = await auth.run();
    expect(r.ok).toBe(true);
  });
});

describe("platform checks", () => {
  beforeEach(() => {
    delete process.env.HYBRIDRAG_URL;
    delete process.env.QDRANT_URL;
    delete process.env.NEO4J_HTTP;
    delete process.env.NEO4J_PASSWORD;
    delete process.env.VLLM_URL;
  });

  it("skips each check when its URL env is unset", async () => {
    const checks = platformChecks();
    for (const c of checks) {
      const r = await c.run();
      expect(r.ok).toBe(true);
      expect(r.msg).toMatch(/not set \(skipped\)/);
    }
  });

  it("hybridrag falls back to search probe when /health 404s", async () => {
    process.env.HYBRIDRAG_URL = "http://hybridrag:8031";
    mockFetch(async (url) => {
      if (url.endsWith("/health")) {
        return { ok: false, status: 404, text: async () => "" };
      }
      return { ok: true, status: 200, json: async () => ({ results: [] }) };
    });
    const c = platformChecks().find((x) => x.name === "hybridrag reachable");
    const r = await c.run();
    expect(r.ok).toBe(true);
  });

  it("neo4j requires NEO4J_PASSWORD when NEO4J_HTTP is set", async () => {
    process.env.NEO4J_HTTP = "http://neo4j:7474";
    const c = platformChecks().find((x) => x.name === "neo4j reachable");
    const r = await c.run();
    expect(r.ok).toBe(false);
    expect(r.msg).toMatch(/NEO4J_PASSWORD/);
  });

  it("neo4j flags 401 specifically", async () => {
    process.env.NEO4J_HTTP = "http://neo4j:7474";
    process.env.NEO4J_PASSWORD = "wrong";
    mockFetch(async () => ({
      status: 401,
      ok: false,
      text: async () => "",
      json: async () => ({}),
    }));
    const c = platformChecks().find((x) => x.name === "neo4j reachable");
    const r = await c.run();
    expect(r.ok).toBe(false);
    expect(r.msg).toMatch(/auth rejected/);
  });

  it("qdrant lists collections", async () => {
    process.env.QDRANT_URL = "http://qdrant:6333";
    mockFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        result: { collections: [{ name: "a" }, { name: "b" }] },
      }),
    }));
    const c = platformChecks().find((x) => x.name === "qdrant reachable");
    const r = await c.run();
    expect(r.ok).toBe(true);
    expect(r.detail.collections).toEqual(["a", "b"]);
  });

  it("vllm flags 'no models loaded' when /v1/models is empty", async () => {
    process.env.VLLM_URL = "http://vllm:8001";
    mockFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [] }),
    }));
    const c = platformChecks().find((x) => x.name === "vllm reachable");
    const r = await c.run();
    expect(r.ok).toBe(false);
    expect(r.msg).toMatch(/no models loaded/);
  });
});
