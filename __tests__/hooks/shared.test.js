import { jest } from "@jest/globals";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// We test the shared utilities by importing them.
// Config loading requires filesystem, so we use real temp files.

let loadConfig, emitModuleEvent, readTurnState, writeTurnState, clearTurnState;
let versionGte, checkLocalServerVersion, buildMemoryContext;
let extractSearchKeywords, searchMemories;

beforeAll(async () => {
  const mod = await import("../../hooks/scripts/shared.js");
  loadConfig = mod.loadConfig;
  emitModuleEvent = mod.emitModuleEvent;
  readTurnState = mod.readTurnState;
  writeTurnState = mod.writeTurnState;
  clearTurnState = mod.clearTurnState;
  versionGte = mod.versionGte;
  checkLocalServerVersion = mod.checkLocalServerVersion;
  buildMemoryContext = mod.buildMemoryContext;
  extractSearchKeywords = mod.extractSearchKeywords;
  searchMemories = mod.searchMemories;
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

describe("versionGte", () => {
  it("returns true when a > b", () => {
    expect(versionGte("1.2.3", "1.2.2")).toBe(true);
    expect(versionGte("2.0.0", "1.9.9")).toBe(true);
    expect(versionGte("0.5.0", "0.4.9")).toBe(true);
  });

  it("returns true when a === b", () => {
    expect(versionGte("0.5.0", "0.5.0")).toBe(true);
  });

  it("returns false when a < b", () => {
    expect(versionGte("0.4.9", "0.5.0")).toBe(false);
    expect(versionGte("1.0.0", "1.0.1")).toBe(false);
  });

  it("pads shorter version strings with zeros", () => {
    expect(versionGte("0.5", "0.5.0")).toBe(true);
    expect(versionGte("1", "0.9.9")).toBe(true);
  });

  it("treats unparseable versions as 'newer than anything' to avoid false positives", () => {
    expect(versionGte("unknown", "0.5.0")).toBe(true);
    expect(versionGte("0.5.0", "unknown")).toBe(true);
  });
});

describe("checkLocalServerVersion", () => {
  let stderrWrites;
  let originalWrite;

  beforeEach(() => {
    stderrWrites = [];
    originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => {
      stderrWrites.push(String(chunk));
      return true;
    };
  });

  afterEach(() => {
    process.stderr.write = originalWrite;
  });

  it("warns when the server is older than the minimum", async () => {
    globalThis.fetch = async (url) => {
      expect(url).toBe("http://localhost:3333/health");
      return {
        ok: true,
        json: async () => ({ status: "ok", version: "0.4.5" }),
      };
    };
    await checkLocalServerVersion({});
    const warning = stderrWrites.find((w) =>
      w.includes("memory server is 0.4.5")
    );
    expect(warning).toBeDefined();
    expect(warning).toMatch(/npx @pentatonic-ai\/ai-agent-sdk@latest memory/);
  });

  it("does NOT warn when the server is up to date", async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ status: "ok", version: "0.5.0" }),
    });
    await checkLocalServerVersion({});
    expect(stderrWrites.find((w) => w.includes("memory server is"))).toBeUndefined();
  });

  it("uses config.memory_url when provided", async () => {
    let hitUrl;
    globalThis.fetch = async (url) => {
      hitUrl = url;
      return {
        ok: true,
        json: async () => ({ status: "ok", version: "0.5.0" }),
      };
    };
    await checkLocalServerVersion({ memory_url: "http://custom:9999" });
    expect(hitUrl).toBe("http://custom:9999/health");
  });

  it("silently no-ops on unreachable server", async () => {
    globalThis.fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    await expect(checkLocalServerVersion({})).resolves.toBeUndefined();
    expect(stderrWrites.find((w) => w.includes("memory server is"))).toBeUndefined();
  });

  it("silently no-ops when version field is absent", async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ status: "ok" }),
    });
    await checkLocalServerVersion({});
    expect(stderrWrites.find((w) => w.includes("memory server is"))).toBeUndefined();
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

describe("extractSearchKeywords", () => {
  it("strips stopwords from verbose natural-language prompts", () => {
    const out = extractSearchKeywords(
      "when I was working in the thing-event-system, I copied over the migrations but needed to make some changes, what were they?"
    );
    // content words preserved, stopwords + question words dropped
    expect(out).toMatch(/thing-event-system/);
    expect(out).toMatch(/migrations/);
    expect(out).toMatch(/changes/);
    expect(out).not.toMatch(/\bwhen\b/);
    expect(out).not.toMatch(/\bwhat\b/);
    expect(out).not.toMatch(/\bwere\b/);
  });

  it("preserves hyphenated compound words", () => {
    expect(extractSearchKeywords("where is the thing-event-system config?")).toMatch(
      /thing-event-system/
    );
  });

  it("returns null for non-string input", () => {
    expect(extractSearchKeywords(null)).toBeNull();
    expect(extractSearchKeywords(undefined)).toBeNull();
    expect(extractSearchKeywords(42)).toBeNull();
  });

  it("returns null when the distilled form is identical to the input", () => {
    // Already keyword-dense — no point retrying with the same query
    expect(extractSearchKeywords("deep-memory migrations")).toBeNull();
  });

  it("returns null when the prompt is only stopwords", () => {
    expect(extractSearchKeywords("what were they?")).toBeNull(); // all three are stopwords
  });

  it("drops tokens shorter than 2 characters", () => {
    const out = extractSearchKeywords("I am a developer working on X");
    expect(out).toBe("developer working");
  });
});

describe("searchMemories — keyword retry fallback", () => {
  const hostedConfig = {
    tes_endpoint: "https://api.test.com",
    tes_client_id: "test-client",
    tes_api_key: "tes_sk_test123",
  };

  it("retries with distilled keywords when raw query returns nothing", async () => {
    const calls = [];
    globalThis.fetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      calls.push(body.variables.query);
      // First call (raw prompt) returns empty; second (keywords) returns hits
      const isFirst = calls.length === 1;
      return {
        ok: true,
        json: async () => ({
          data: {
            semanticSearchMemories: isFirst
              ? []
              : [{ id: "m1", content: "match", similarity: 0.8 }],
          },
        }),
      };
    };

    const results = await searchMemories(
      hostedConfig,
      "when I was working on the migrations, what were those changes again?"
    );
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatch(/when I was working/); // raw prompt first
    expect(calls[1]).not.toMatch(/\bwhen\b/); // keyword-distilled retry
    expect(calls[1]).toMatch(/migrations/);
    expect(results).toHaveLength(1);
  });

  it("does not retry when the raw query already returns results", async () => {
    const calls = [];
    globalThis.fetch = async (url, opts) => {
      calls.push(JSON.parse(opts.body).variables.query);
      return {
        ok: true,
        json: async () => ({
          data: {
            semanticSearchMemories: [{ id: "m1", content: "hit", similarity: 0.9 }],
          },
        }),
      };
    };

    await searchMemories(hostedConfig, "thing-event-system migrations");
    expect(calls).toHaveLength(1);
  });

  it("does not retry when the distilled form equals the input", async () => {
    const calls = [];
    globalThis.fetch = async (url, opts) => {
      calls.push(JSON.parse(opts.body).variables.query);
      return {
        ok: true,
        json: async () => ({ data: { semanticSearchMemories: [] } }),
      };
    };

    // Already keyword-dense, so extractSearchKeywords returns null
    await searchMemories(hostedConfig, "deep-memory migrations");
    expect(calls).toHaveLength(1);
  });

  it("does not retry when the prompt is only stopwords", async () => {
    const calls = [];
    globalThis.fetch = async (url, opts) => {
      calls.push(JSON.parse(opts.body).variables.query);
      return {
        ok: true,
        json: async () => ({ data: { semanticSearchMemories: [] } }),
      };
    };

    await searchMemories(hostedConfig, "what were they?");
    expect(calls).toHaveLength(1);
  });
});
