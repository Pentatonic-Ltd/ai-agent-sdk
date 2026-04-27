import { universalChecks } from "../src/checks/universal.js";
import { hostedTesChecks } from "../src/checks/hosted-tes.js";
import { dataFlowChecks } from "../src/checks/data-flow.js";
import { claudeCodeChecks } from "../src/checks/claude-code.js";
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

describe("data-flow checks", () => {
  beforeEach(() => {
    process.env.TES_ENDPOINT = "https://example.test";
    process.env.TES_API_KEY = "tes_test_key";
    process.env.TES_CLIENT_ID = "test-client";
  });
  afterEach(() => {
    delete process.env.TES_ENDPOINT;
    delete process.env.TES_API_KEY;
    delete process.env.TES_CLIENT_ID;
    delete process.env.PENTATONIC_DOCTOR_PROBE_QUERY;
  });

  // Capture the request bodies so tests can assert on the GraphQL
  // shape doctor sends — not just the response handling.
  function captureFetch(handler) {
    const calls = [];
    globalThis.fetch = async (url, opts) => {
      const body = opts?.body ? JSON.parse(opts.body) : null;
      calls.push({ url, headers: opts?.headers || {}, body });
      return handler(url, opts);
    };
    return calls;
  }

  it("registers the three expected probes", () => {
    const names = dataFlowChecks().map((c) => c.name);
    expect(names).toContain("TES event stream has data");
    expect(names).toContain("MEMORY_CREATED events for client");
    expect(names).toContain("semanticSearchMemories returns hits");
  });

  // --- event stream check ---

  it("event stream: sends GraphQL query with `limit:1` (not `first:1`)", async () => {
    const calls = captureFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { events: { totalCount: 5 } } }),
    }));
    const c = dataFlowChecks().find(
      (x) => x.name === "TES event stream has data"
    );
    await c.run();
    expect(calls).toHaveLength(1);
    expect(calls[0].body.query).toMatch(/events\(\s*limit:\s*1\s*\)/);
    expect(calls[0].body.query).not.toMatch(/first\s*:/);
    expect(calls[0].body.query).toMatch(/totalCount/);
  });

  it("event stream: warns when totalCount is 0", async () => {
    captureFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { events: { totalCount: 0 } } }),
    }));
    const c = dataFlowChecks().find(
      (x) => x.name === "TES event stream has data"
    );
    const r = await c.run();
    expect(r.ok).toBe(false);
    expect(r.msg).toMatch(/0 events yet/);
  });

  it("event stream: passes with a positive count", async () => {
    captureFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { events: { totalCount: 42 } } }),
    }));
    const c = dataFlowChecks().find(
      (x) => x.name === "TES event stream has data"
    );
    const r = await c.run();
    expect(r.ok).toBe(true);
    expect(r.detail.totalCount).toBe(42);
  });

  // --- memory-created check ---

  it("memory-created: filter uses eventType + StringFilterInput wrapper", async () => {
    const calls = captureFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { events: { totalCount: 3 } } }),
    }));
    const c = dataFlowChecks().find(
      (x) => x.name === "MEMORY_CREATED events for client"
    );
    await c.run();
    const { query, variables } = calls[0].body;
    // Schema requires eventType (not "kind") with a StringFilterInput
    // wrapper, and clientId likewise as a filter wrapper.
    expect(query).toMatch(/eventType:\s*\{\s*eq:\s*\$eventType\s*\}/);
    expect(query).toMatch(/clientId:\s*\{\s*eq:\s*\$client\s*\}/);
    expect(query).not.toMatch(/\bkind\b/);
    expect(variables.eventType).toBe("MEMORY_CREATED");
    expect(variables.client).toBe("test-client");
  });

  it("memory-created: flags the client id in the warning", async () => {
    captureFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { events: { totalCount: 0 } } }),
    }));
    const c = dataFlowChecks().find(
      (x) => x.name === "MEMORY_CREATED events for client"
    );
    const r = await c.run();
    expect(r.ok).toBe(false);
    expect(r.msg).toMatch(/test-client/);
  });

  // --- semantic search check ---

  it("semantic search: sends required clientId arg + selects similarity (not score)", async () => {
    const calls = captureFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: { semanticSearchMemories: [{ id: "m1", similarity: 0.8 }] },
      }),
    }));
    const c = dataFlowChecks().find(
      (x) => x.name === "semanticSearchMemories returns hits"
    );
    await c.run();
    const { query, variables } = calls[0].body;
    // clientId is required by the schema; doctor must send it.
    expect(query).toMatch(/clientId:\s*\$clientId/);
    expect(variables.clientId).toBe("test-client");
    // Result type exposes `similarity`, not `score`.
    expect(query).toMatch(/similarity/);
    expect(query).not.toMatch(/\bscore\b/);
  });

  it("semantic search: warns on 0 hits", async () => {
    captureFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { semanticSearchMemories: [] } }),
    }));
    const c = dataFlowChecks().find(
      (x) => x.name === "semanticSearchMemories returns hits"
    );
    const r = await c.run();
    expect(r.ok).toBe(false);
    expect(r.msg).toMatch(/0 hits/);
  });

  it("semantic search: passes with hits", async () => {
    captureFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: { semanticSearchMemories: [{ id: "m1", similarity: 0.8 }] },
      }),
    }));
    const c = dataFlowChecks().find(
      (x) => x.name === "semanticSearchMemories returns hits"
    );
    const r = await c.run();
    expect(r.ok).toBe(true);
    expect(r.detail.hits).toBe(1);
  });

  it("semantic search: 'cannot query field' skips gracefully", async () => {
    captureFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        errors: [{ message: 'Cannot query field "semanticSearchMemories" on type "Query"' }],
      }),
    }));
    const c = dataFlowChecks().find(
      (x) => x.name === "semanticSearchMemories returns hits"
    );
    const r = await c.run();
    expect(r.ok).toBe(true);
    expect(r.msg).toMatch(/skipped/);
  });

  it("semantic search: schema-arg mismatches surface as errors, NOT silent skips", async () => {
    // E.g. a missing required arg — error mentions the field name but
    // is NOT the "Cannot query field" wording. Doctor must report,
    // not pretend the deployment doesn't expose the field.
    captureFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        errors: [
          {
            message:
              'Field "semanticSearchMemories" argument "clientId" of type "String!" is required',
          },
        ],
      }),
    }));
    const c = dataFlowChecks().find(
      (x) => x.name === "semanticSearchMemories returns hits"
    );
    const r = await c.run();
    expect(r.ok).toBe(false);
    expect(r.msg).not.toMatch(/skipped/);
    expect(r.msg).toMatch(/required/);
  });

  it("PENTATONIC_DOCTOR_PROBE_QUERY overrides the default probe text", async () => {
    process.env.PENTATONIC_DOCTOR_PROBE_QUERY = "custom probe text";
    const calls = captureFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { semanticSearchMemories: [] } }),
    }));
    const c = dataFlowChecks().find(
      (x) => x.name === "semanticSearchMemories returns hits"
    );
    await c.run();
    expect(calls[0].body.variables.q).toBe("custom probe text");
  });

  // --- auth header branching ---

  it("uses Authorization: Bearer for tes_-prefixed keys", async () => {
    const calls = captureFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { events: { totalCount: 1 } } }),
    }));
    process.env.TES_API_KEY = "tes_user_abc";
    const c = dataFlowChecks().find(
      (x) => x.name === "TES event stream has data"
    );
    await c.run();
    expect(calls[0].headers.Authorization).toBe("Bearer tes_user_abc");
    expect(calls[0].headers["x-service-key"]).toBeUndefined();
  });

  it("uses x-service-key for non-tes_ keys (internal service tokens)", async () => {
    const calls = captureFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { events: { totalCount: 1 } } }),
    }));
    process.env.TES_API_KEY = "internal_svc_xyz";
    const c = dataFlowChecks().find(
      (x) => x.name === "TES event stream has data"
    );
    await c.run();
    expect(calls[0].headers["x-service-key"]).toBe("internal_svc_xyz");
    expect(calls[0].headers.Authorization).toBeUndefined();
  });

  it("sends x-client-id on every request", async () => {
    const calls = captureFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { events: { totalCount: 1 } } }),
    }));
    const c = dataFlowChecks().find(
      (x) => x.name === "TES event stream has data"
    );
    await c.run();
    expect(calls[0].headers["x-client-id"]).toBe("test-client");
  });

  it("all three report missing env clearly", async () => {
    delete process.env.TES_CLIENT_ID;
    for (const c of dataFlowChecks()) {
      const r = await c.run();
      expect(r.ok).toBe(false);
      expect(r.msg).toMatch(/TES_ENDPOINT|required/);
    }
  });
});

describe("Claude Code plugin check", () => {
  it("reports installed + version when manifest is present at ~/.claude", async () => {
    const [check] = claudeCodeChecks({
      fileExists: (p) => p === "/home/fake/.claude/plugins/marketplaces/pentatonic-ai/.claude-plugin/plugin.json",
      readFile: () =>
        JSON.stringify({ name: "tes-memory", version: "0.5.3" }),
      homedir: () => "/home/fake",
      env: {},
    });
    const r = await check.run();
    expect(r.ok).toBe(true);
    expect(r.msg).toMatch(/tes-memory v0\.5\.3 installed/);
    expect(r.detail.version).toBe("0.5.3");
    expect(r.detail.path).toMatch(/\.claude\/plugins/);
  });

  it("falls through to ~/.claude-pentatonic when ~/.claude is empty", async () => {
    const pentatonicPath =
      "/home/fake/.claude-pentatonic/plugins/marketplaces/pentatonic-ai/.claude-plugin/plugin.json";
    const [check] = claudeCodeChecks({
      fileExists: (p) => p === pentatonicPath,
      readFile: () =>
        JSON.stringify({ name: "tes-memory", version: "0.5.3" }),
      homedir: () => "/home/fake",
      env: {},
    });
    const r = await check.run();
    expect(r.ok).toBe(true);
    expect(r.detail.path).toBe(pentatonicPath);
  });

  it("respects CLAUDE_CONFIG_DIR override (highest precedence)", async () => {
    const overridePath =
      "/custom/cfg/plugins/marketplaces/pentatonic-ai/.claude-plugin/plugin.json";
    const [check] = claudeCodeChecks({
      fileExists: (p) => p === overridePath,
      readFile: () =>
        JSON.stringify({ name: "tes-memory", version: "9.9.9" }),
      homedir: () => "/home/fake",
      env: { CLAUDE_CONFIG_DIR: "/custom/cfg" },
    });
    const r = await check.run();
    expect(r.ok).toBe(true);
    expect(r.detail.path).toBe(overridePath);
    expect(r.detail.version).toBe("9.9.9");
  });

  it("reports the install command + all candidate paths when none exist", async () => {
    const [check] = claudeCodeChecks({
      fileExists: () => false,
      homedir: () => "/home/fake",
      env: { CLAUDE_CONFIG_DIR: "/custom/cfg" },
    });
    const r = await check.run();
    expect(r.ok).toBe(false);
    expect(r.msg).toMatch(/plugin install tes-memory/);
    expect(r.detail.candidates).toEqual(
      expect.arrayContaining([
        expect.stringContaining("/custom/cfg/plugins"),
        expect.stringContaining("/home/fake/.claude/plugins"),
        expect.stringContaining("/home/fake/.claude-pentatonic/plugins"),
      ])
    );
  });

  it("handles corrupt manifest json without throwing", async () => {
    const [check] = claudeCodeChecks({
      fileExists: () => true,
      readFile: () => "{ not json",
      homedir: () => "/home/fake",
      env: {},
    });
    const r = await check.run();
    expect(r.ok).toBe(false);
    expect(r.msg).toMatch(/unreadable/);
  });
});
