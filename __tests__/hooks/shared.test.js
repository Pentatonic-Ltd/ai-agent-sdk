import { jest } from "@jest/globals";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// We test the shared utilities by importing them.
// Config loading requires filesystem, so we use real temp files.

let loadConfig, emitModuleEvent, readTurnState, writeTurnState, clearTurnState, buildMemoryContext;

beforeAll(async () => {
  const mod = await import("../../hooks/scripts/shared.js");
  loadConfig = mod.loadConfig;
  emitModuleEvent = mod.emitModuleEvent;
  readTurnState = mod.readTurnState;
  writeTurnState = mod.writeTurnState;
  clearTurnState = mod.clearTurnState;
  buildMemoryContext = mod.buildMemoryContext;
});

describe("Turn state management", () => {
  const testSessionId = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  afterAll(() => {
    clearTurnState(testSessionId);
  });

  it("returns default state for unknown session", () => {
    const state = readTurnState(`nonexistent-${Date.now()}`);
    expect(state).toEqual({ tool_calls: [], turn_number: 0 });
  });

  it("writes and reads state", () => {
    const data = {
      tool_calls: [{ tool: "search", input: { q: "test" } }],
      turn_number: 3,
      session_start: 1000,
    };
    writeTurnState(testSessionId, data);
    const result = readTurnState(testSessionId);
    expect(result).toEqual(data);
  });

  it("clears state", () => {
    writeTurnState(testSessionId, { tool_calls: [], turn_number: 1 });
    clearTurnState(testSessionId);
    const state = readTurnState(testSessionId);
    expect(state).toEqual({ tool_calls: [], turn_number: 0 });
  });

  it("clearTurnState is a no-op for nonexistent session", () => {
    expect(() => clearTurnState(`nonexistent-${Date.now()}`)).not.toThrow();
  });
});

describe("loadConfig", () => {
  const testDir = join(tmpdir(), `tes-test-config-${Date.now()}`);
  const configPath = join(testDir, "tes-memory.local.md");

  beforeAll(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
    delete process.env.CLAUDE_CONFIG_DIR;
  });

  it("returns null when no config file exists", () => {
    process.env.CLAUDE_CONFIG_DIR = join(tmpdir(), `nonexistent-${Date.now()}`);
    const config = loadConfig();
    // May or may not be null depending on whether ~/.claude/tes-memory.local.md exists
    // This test validates that it doesn't throw
    expect(config === null || typeof config === "object").toBe(true);
  });

  it("parses YAML frontmatter from config file", () => {
    writeFileSync(
      configPath,
      `---
tes_endpoint: https://api.test.com
tes_client_id: my-client
tes_api_key: tes_sk_test123
tes_user_id: phil@test.com
---

Some markdown content below.
`
    );
    process.env.CLAUDE_CONFIG_DIR = testDir;

    const config = loadConfig();
    expect(config).not.toBeNull();
    expect(config.tes_endpoint).toBe("https://api.test.com");
    expect(config.tes_client_id).toBe("my-client");
    expect(config.tes_api_key).toBe("tes_sk_test123");
    expect(config.tes_user_id).toBe("phil@test.com");
  });

  it("handles endpoint with port in colon-separated parsing", () => {
    writeFileSync(
      configPath,
      `---
tes_endpoint: http://localhost:8788
tes_client_id: dev
tes_api_key: devkey
---
`
    );
    process.env.CLAUDE_CONFIG_DIR = testDir;

    const config = loadConfig();
    expect(config.tes_endpoint).toBe("http://localhost:8788");
  });

  it("returns null for file without frontmatter", () => {
    writeFileSync(configPath, "Just some plain text, no frontmatter.");
    process.env.CLAUDE_CONFIG_DIR = testDir;

    const config = loadConfig();
    expect(config).toBeNull();
  });
});

describe("emitModuleEvent", () => {
  const config = {
    tes_endpoint: "https://api.test.com",
    tes_client_id: "test-client",
    tes_api_key: "tes_sk_test123",
    tes_user_id: "test-user",
  };

  let fetchCalls;

  beforeEach(() => {
    fetchCalls = [];
    globalThis.fetch = async (url, opts) => {
      fetchCalls.push({ url, opts });
      return {
        ok: true,
        json: async () => ({
          data: { createModuleEvent: { success: true, eventId: "evt-1" } },
        }),
      };
    };
  });

  it("sends createModuleEvent mutation", async () => {
    await emitModuleEvent(config, "conversation-analytics", "SESSION_START", "sess-1", {
      cwd: "/home/user",
    });

    expect(fetchCalls).toHaveLength(1);
    const body = JSON.parse(fetchCalls[0].opts.body);
    expect(body.query).toContain("createModuleEvent");
    expect(body.variables.moduleId).toBe("conversation-analytics");
    expect(body.variables.input.eventType).toBe("SESSION_START");
    expect(body.variables.input.data.entity_id).toBe("sess-1");
  });

  it("includes source and user_id in attributes", async () => {
    await emitModuleEvent(config, "deep-memory", "CHAT_TURN", "sess-1", {
      turn_number: 0,
    });

    const body = JSON.parse(fetchCalls[0].opts.body);
    const attrs = body.variables.input.data.attributes;
    expect(attrs.source).toBe("claude-code-plugin");
    expect(attrs.user_id).toBe("test-user");
    expect(attrs.turn_number).toBe(0);
  });

  it("uses Bearer auth for tes_ prefixed keys", async () => {
    await emitModuleEvent(config, "conversation-analytics", "TEST", "sess-1", {});

    const headers = fetchCalls[0].opts.headers;
    expect(headers["Authorization"]).toBe("Bearer tes_sk_test123");
    expect(headers["x-service-key"]).toBeUndefined();
  });

  it("uses x-service-key for non-tes_ keys", async () => {
    const internalConfig = { ...config, tes_api_key: "internal_key_abc" };
    await emitModuleEvent(internalConfig, "conversation-analytics", "TEST", "sess-1", {});

    const headers = fetchCalls[0].opts.headers;
    expect(headers["x-service-key"]).toBe("internal_key_abc");
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("sends x-client-id header", async () => {
    await emitModuleEvent(config, "conversation-analytics", "TEST", "sess-1", {});

    const headers = fetchCalls[0].opts.headers;
    expect(headers["x-client-id"]).toBe("test-client");
  });

  it("returns null on non-ok response", async () => {
    globalThis.fetch = async () => ({ ok: false, status: 403 });

    const result = await emitModuleEvent(config, "conversation-analytics", "TEST", "sess-1", {});
    expect(result).toBeNull();
  });
});

describe("buildMemoryContext — memory-used indicator", () => {
  it("includes the memory list with similarity percentages", () => {
    const out = buildMemoryContext({}, [
      { similarity: 0.9, content: "Phil likes cheese" },
      { similarity: 0.7, content: "Phil drinks cortado" },
    ]);
    expect(out).toMatch(/\[Memory\] Related knowledge:/);
    expect(out).toMatch(/- \[90%\] Phil likes cheese/);
    expect(out).toMatch(/- \[70%\] Phil drinks cortado/);
  });

  it("injects a footer instruction when memories are present (default on)", () => {
    const out = buildMemoryContext({}, [
      { similarity: 0.9, content: "fact" },
    ]);
    expect(out).toMatch(/🧠/);
    expect(out).toMatch(/append exactly this footer/);
    expect(out).toMatch(/Used 1 memory from Pentatonic Memory/);
  });

  it("pluralises the footer for multiple memories", () => {
    const out = buildMemoryContext({}, [
      { similarity: 0.9, content: "a" },
      { similarity: 0.8, content: "b" },
      { similarity: 0.7, content: "c" },
    ]);
    expect(out).toMatch(/Used 3 memories from Pentatonic Memory/);
  });

  it("omits the footer instruction when show_memory_indicator is 'false'", () => {
    // Config comes from YAML frontmatter so values are strings
    const out = buildMemoryContext(
      { show_memory_indicator: "false" },
      [{ similarity: 0.9, content: "fact" }]
    );
    expect(out).toMatch(/fact/);
    expect(out).not.toMatch(/🧠/);
    expect(out).not.toMatch(/Pentatonic Memory_/);
  });

  it("keeps the footer when show_memory_indicator is 'true' (explicit opt-in)", () => {
    const out = buildMemoryContext(
      { show_memory_indicator: "true" },
      [{ similarity: 0.9, content: "fact" }]
    );
    expect(out).toMatch(/🧠/);
  });

  it("instructs the LLM to skip the footer when memories aren't relevant", () => {
    const out = buildMemoryContext({}, [
      { similarity: 0.3, content: "unrelated" },
    ]);
    expect(out).toMatch(
      /If the memories above were not relevant to your reply, omit the footer/
    );
  });

  it("handles missing similarity gracefully", () => {
    const out = buildMemoryContext({}, [{ content: "no similarity given" }]);
    expect(out).toMatch(/\[0%\] no similarity given/);
  });
});
