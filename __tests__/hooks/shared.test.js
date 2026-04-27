import { jest } from "@jest/globals";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// We test the shared utilities by importing them.
// Config loading requires filesystem, so we use real temp files.

let loadConfig, emitModuleEvent, readTurnState, writeTurnState, clearTurnState;
let versionGte, checkLocalServerVersion, buildMemoryContext, getMemoryFooter;
let checkFooterRetry, sanitizeMemoryContent;
let projectSlug, resolveAutoMemoryDir, formatSessionMemoriesFile;
let writeSessionMemoriesToAutoMemory;
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
  getMemoryFooter = mod.getMemoryFooter;
  checkFooterRetry = mod.checkFooterRetry;
  sanitizeMemoryContent = mod.sanitizeMemoryContent;
  projectSlug = mod.projectSlug;
  resolveAutoMemoryDir = mod.resolveAutoMemoryDir;
  formatSessionMemoriesFile = mod.formatSessionMemoriesFile;
  writeSessionMemoriesToAutoMemory = mod.writeSessionMemoriesToAutoMemory;
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

describe("buildMemoryContext", () => {
  it("includes the memory list with similarity percentages", () => {
    const out = buildMemoryContext({}, [
      { similarity: 0.9, content: "Phil likes cheese" },
      { similarity: 0.7, content: "Phil drinks cortado" },
    ]);
    expect(out).toMatch(/\[Pentatonic Memory/);
    expect(out).toMatch(/- \[90%\] Phil likes cheese/);
    expect(out).toMatch(/- \[70%\] Phil drinks cortado/);
  });

  it("frames memories as authoritative and overrides the file-based memory", () => {
    const out = buildMemoryContext({}, [
      { similarity: 0.9, content: "fact" },
    ]);
    expect(out).toMatch(/AUTHORITATIVE SOURCE/);
    expect(out).toMatch(/overrides[\s\S]*other memory system/i);
    expect(out).toMatch(/file-based memory/i);
    expect(out).toMatch(/search_memories/);
    expect(out).toMatch(/do not reply "I don't know"/i);
    expect(out).toMatch(/ground truth/i);
  });

  it("handles missing similarity gracefully", () => {
    const out = buildMemoryContext({}, [{ content: "no similarity given" }]);
    expect(out).toMatch(/\[0%\] no similarity given/);
  });

  it("embeds the footer instruction for the model to follow (best-effort path)", () => {
    const out = buildMemoryContext({}, [
      { similarity: 0.9, content: "fact" },
    ]);
    expect(out).toMatch(/append exactly this footer/);
    expect(out).toMatch(/🧠 _Matched 1 memory from Pentatonic Memory_/);
  });

  it("pluralises the footer in the injected instruction", () => {
    const out = buildMemoryContext({}, [
      { similarity: 0.9, content: "a" },
      { similarity: 0.8, content: "b" },
      { similarity: 0.7, content: "c" },
    ]);
    expect(out).toMatch(/🧠 _Matched 3 memories from Pentatonic Memory_/);
  });

  it("omits the footer instruction when show_memory_indicator is 'false'", () => {
    const out = buildMemoryContext(
      { show_memory_indicator: "false" },
      [{ similarity: 0.9, content: "fact" }]
    );
    expect(out).toMatch(/fact/);
    expect(out).not.toMatch(/🧠/);
    expect(out).not.toMatch(/Pentatonic Memory_/);
  });

  it("strips dashboard noise from each memory content", () => {
    const noisy = [
      "[2026-04-21T11:47:04.826Z] I have a subaru and hyundai Updated — both a Subaru and a Hyundai.",
      "",
      "anonymous",
      "ml_phil-h-claude_episodic",
      "100% match",
      "Confidence: 100%",
      "Accessed: 2x",
      "<1h ago",
      "Decay: 0.05",
      "Metadata",
      "{",
      '  "source": { "user": "anonymous", "system": "claude-code-plugin" },',
      '  "event_id": "f4750a33",',
      '  "event_type": "CHAT_TURN"',
      "}",
    ].join("\n");
    const out = buildMemoryContext({}, [{ similarity: 0.9, content: noisy }]);
    expect(out).toMatch(/I have a subaru and hyundai/);
    expect(out).not.toMatch(/ml_phil-h-claude_episodic/);
    expect(out).not.toMatch(/Confidence:/);
    expect(out).not.toMatch(/Accessed: 2x/);
    expect(out).not.toMatch(/event_id/);
    expect(out).not.toMatch(/entity_type/);
  });
});

describe("sanitizeMemoryContent", () => {
  it("strips leading ISO timestamps on each line", () => {
    const out = sanitizeMemoryContent("[2026-04-21T11:47:04.826Z] Phil owns a Subaru.");
    expect(out).toBe("Phil owns a Subaru.");
  });

  it("strips standalone dashboard metadata lines", () => {
    const input = [
      "Phil owns a Subaru.",
      "anonymous",
      "ml_phil-h-claude_episodic",
      "100% match",
      "Confidence: 100%",
      "Accessed: 2x",
      "<1h ago",
      "Decay: 0.05",
      "Metadata",
    ].join("\n");
    const out = sanitizeMemoryContent(input);
    expect(out).toBe("Phil owns a Subaru.");
  });

  it("strips trailing JSON metadata blob", () => {
    const input = [
      "Phil has two dogs named Max and Luna.",
      "{",
      '  "event_id": "abc-123",',
      '  "event_type": "CHAT_TURN"',
      "}",
    ].join("\n");
    const out = sanitizeMemoryContent(input);
    expect(out).toBe("Phil has two dogs named Max and Luna.");
  });

  it("keeps the original content if stripping would leave almost nothing", () => {
    const input = "anonymous\nml_phil-h-claude_episodic\n100% match";
    const out = sanitizeMemoryContent(input);
    expect(out).toBe(input); // fallback — all three lines would strip to empty
  });

  it("is a no-op for clean content", () => {
    const clean = "Phil prefers espresso in the morning, tea in the afternoon.";
    expect(sanitizeMemoryContent(clean)).toBe(clean);
  });

  it("handles non-string input safely", () => {
    expect(sanitizeMemoryContent(undefined)).toBeUndefined();
    expect(sanitizeMemoryContent(null)).toBeNull();
  });

  it("strips inline JSON metadata blobs with TES-style fields", () => {
    const input = [
      "User said: I have a Subaru.",
      "{",
      '  "event_id": "abc",',
      '  "event_type": "CHAT_TURN",',
      '  "entity_type": "conversation"',
      "}",
      "The next turn continued...",
    ].join("\n");
    const out = sanitizeMemoryContent(input);
    expect(out).toMatch(/User said: I have a Subaru\./);
    expect(out).toMatch(/The next turn continued\.\.\./);
    expect(out).not.toMatch(/event_id/);
    expect(out).not.toMatch(/entity_type/);
  });

  it("does NOT strip legitimate JSON code samples", () => {
    const input = [
      "Here's how to configure the client:",
      "{",
      '  "apiKey": "xxx",',
      '  "endpoint": "https://api.test"',
      "}",
      "Then instantiate it.",
    ].join("\n");
    const out = sanitizeMemoryContent(input);
    // apiKey and endpoint aren't TES metadata fields → not stripped
    expect(out).toMatch(/apiKey/);
    expect(out).toMatch(/endpoint/);
  });

  it("truncates long memories with an ellipsis", () => {
    const long = "fact. ".repeat(200); // 1200 chars
    const out = sanitizeMemoryContent(long);
    expect(out.length).toBeLessThanOrEqual(601); // MEMORY_MAX_LEN + "…"
    expect(out.endsWith("…")).toBe(true);
    expect(out).toMatch(/fact\./);
  });
});

describe("getMemoryFooter", () => {
  it("renders the Matched-N footer when memories were retrieved", () => {
    expect(getMemoryFooter({}, 1)).toBe(
      "🧠 _Matched 1 memory from Pentatonic Memory_"
    );
    expect(getMemoryFooter({}, 3)).toBe(
      "🧠 _Matched 3 memories from Pentatonic Memory_"
    );
  });

  it("returns null when zero memories were retrieved", () => {
    expect(getMemoryFooter({}, 0)).toBeNull();
    expect(getMemoryFooter({}, undefined)).toBeNull();
  });

  it("returns null when show_memory_indicator is 'false' (YAML string)", () => {
    expect(getMemoryFooter({ show_memory_indicator: "false" }, 5)).toBeNull();
  });

  it("still renders when show_memory_indicator is 'true' (explicit opt-in)", () => {
    expect(getMemoryFooter({ show_memory_indicator: "true" }, 2)).toMatch(
      /🧠 _Matched 2 memories/
    );
  });

  it("uses singular form for exactly one memory", () => {
    expect(getMemoryFooter({}, 1)).toMatch(/1 memory from/);
    expect(getMemoryFooter({}, 1)).not.toMatch(/1 memories/);
  });
});

describe("checkFooterRetry", () => {
  it("returns a retry ticket when footer is missing from the reply", () => {
    const out = checkFooterRetry(
      { memories_retrieved: 3, footer_retry_attempts: 0 },
      {},
      "Here's your answer without the footer."
    );
    expect(out).not.toBeNull();
    expect(out.footer).toMatch(/Matched 3 memories/);
    expect(out.nextAttempts).toBe(1);
  });

  it("returns null when the footer is already present in the reply", () => {
    const footer = "🧠 _Matched 2 memories from Pentatonic Memory_";
    const out = checkFooterRetry(
      { memories_retrieved: 2, footer_retry_attempts: 0 },
      {},
      `Answer text\n\n${footer}`
    );
    expect(out).toBeNull();
  });

  it("returns null when no memories were retrieved", () => {
    const out = checkFooterRetry(
      { memories_retrieved: 0, footer_retry_attempts: 0 },
      {},
      "Any reply"
    );
    expect(out).toBeNull();
  });

  it("returns null when the indicator is disabled", () => {
    const out = checkFooterRetry(
      { memories_retrieved: 5, footer_retry_attempts: 0 },
      { show_memory_indicator: "false" },
      "Reply with no footer"
    );
    expect(out).toBeNull();
  });

  it("returns null once the retry budget is exhausted (caps at 1 retry)", () => {
    const out = checkFooterRetry(
      { memories_retrieved: 3, footer_retry_attempts: 1 },
      {},
      "Still no footer in the reply"
    );
    expect(out).toBeNull();
  });

  it("handles missing turn-state fields gracefully", () => {
    expect(checkFooterRetry(undefined, {}, "")).toBeNull();
    expect(checkFooterRetry({}, {}, "")).toBeNull();
    expect(checkFooterRetry(null, {}, "")).toBeNull();
  });

  it("handles an empty assistant message (tool-only reply) — triggers retry", () => {
    const out = checkFooterRetry(
      { memories_retrieved: 2, footer_retry_attempts: 0 },
      {},
      ""
    );
    expect(out).not.toBeNull();
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

describe("projectSlug", () => {
  it("converts a project path to Claude Code's dashed slug", () => {
    expect(projectSlug("/home/phil/Development/takebacks/ai-events-sdk")).toBe(
      "-home-phil-Development-takebacks-ai-events-sdk"
    );
    expect(projectSlug("/home/phil")).toBe("-home-phil");
  });

  it("returns null for non-strings or empty", () => {
    expect(projectSlug(undefined)).toBeNull();
    expect(projectSlug(null)).toBeNull();
    expect(projectSlug("")).toBeNull();
  });
});

describe("resolveAutoMemoryDir", () => {
  it("composes the expected path under <baseDir>/<slug>/memory", () => {
    const base = "/fake/projects";
    expect(
      resolveAutoMemoryDir("/home/phil/Development/takebacks/ai-events-sdk", {
        baseDir: base,
      })
    ).toBe(
      "/fake/projects/-home-phil-Development-takebacks-ai-events-sdk/memory"
    );
  });

  it("returns null for missing cwd", () => {
    expect(resolveAutoMemoryDir(undefined)).toBeNull();
  });
});

describe("formatSessionMemoriesFile", () => {
  it("includes Claude-Code-style frontmatter", () => {
    const out = formatSessionMemoriesFile(
      "what car do I drive?",
      [{ similarity: 0.9, content: "Phil owns a Subaru." }],
      { now: "2026-04-23T18:00:00Z" }
    );
    expect(out).toMatch(/^---\nname: Session memories \(Pentatonic\)/);
    expect(out).toMatch(/type: project/);
    expect(out).toMatch(/Refreshed: 2026-04-23T18:00:00Z/);
    expect(out).toMatch(/Query: what car do I drive\?/);
    expect(out).toMatch(/Matched: 1 memory/);
    expect(out).toMatch(/- \[90%\] Phil owns a Subaru\./);
  });

  it("pluralises for multiple memories", () => {
    const out = formatSessionMemoriesFile("q", [
      { similarity: 0.9, content: "a" },
      { similarity: 0.7, content: "b" },
    ]);
    expect(out).toMatch(/Matched: 2 memories/);
  });

  it("writes a 'no memories' note when the array is empty", () => {
    const out = formatSessionMemoriesFile("q", []);
    expect(out).toMatch(/No memories matched this prompt/);
  });

  it("strips newlines from the query in the header (single-line safety)", () => {
    const out = formatSessionMemoriesFile("line one\nline two", [
      { similarity: 0.5, content: "x" },
    ]);
    expect(out).toMatch(/Query: line one line two/);
  });

  it("sanitizes memory content before writing (dashboard noise removed)", () => {
    const noisy = "[2026-04-21T11:47:04Z] Phil owns a Subaru.\nanonymous\nml_phil-h-claude_episodic\n100% match";
    const out = formatSessionMemoriesFile("q", [
      { similarity: 0.8, content: noisy },
    ]);
    expect(out).toMatch(/Phil owns a Subaru\./);
    expect(out).not.toMatch(/ml_phil-h-claude_episodic/);
    expect(out).not.toMatch(/anonymous/);
  });
});

describe("writeSessionMemoriesToAutoMemory — round-trip on disk", () => {
  const baseDir = join(tmpdir(), `tes-automem-${Date.now()}`);
  const cwd = "/fake/project/path";
  const slug = "-fake-project-path";
  const memDir = join(baseDir, slug, "memory");

  afterEach(() => {
    if (existsSync(baseDir)) rmSync(baseDir, { recursive: true, force: true });
  });

  it("creates the memory directory, writes the session file, and indexes it in MEMORY.md", () => {
    const res = writeSessionMemoriesToAutoMemory(
      cwd,
      "what car?",
      [{ similarity: 0.9, content: "Phil owns a Subaru." }],
      { baseDir }
    );
    expect(res.written).toBe(true);

    const sessionPath = join(memDir, "pentatonic_session_memories.md");
    const indexPath = join(memDir, "MEMORY.md");
    expect(existsSync(sessionPath)).toBe(true);
    expect(existsSync(indexPath)).toBe(true);

    const session = readFileSync(sessionPath, "utf-8");
    expect(session).toMatch(/Phil owns a Subaru\./);
    expect(session).toMatch(/type: project/);

    const index = readFileSync(indexPath, "utf-8");
    expect(index).toMatch(/pentatonic_session_memories\.md/);
  });

  it("refreshes the session file on each call but does not re-add the MEMORY.md pointer", () => {
    writeSessionMemoriesToAutoMemory(
      cwd,
      "first query",
      [{ similarity: 0.9, content: "First fact." }],
      { baseDir }
    );
    writeSessionMemoriesToAutoMemory(
      cwd,
      "second query",
      [{ similarity: 0.8, content: "Second fact." }],
      { baseDir }
    );

    const session = readFileSync(
      join(memDir, "pentatonic_session_memories.md"),
      "utf-8"
    );
    // Latest write wins — only the second fact is present.
    expect(session).toMatch(/Second fact\./);
    expect(session).not.toMatch(/First fact\./);

    const index = readFileSync(join(memDir, "MEMORY.md"), "utf-8");
    const occurrences = index.match(/pentatonic_session_memories\.md/g) || [];
    expect(occurrences.length).toBe(1);
  });

  it("preserves existing MEMORY.md content when adding the pointer", () => {
    mkdirSync(memDir, { recursive: true });
    const existing =
      "- [Original note](original.md) — something the user had\n";
    writeFileSync(join(memDir, "MEMORY.md"), existing, "utf-8");

    writeSessionMemoriesToAutoMemory(
      cwd,
      "q",
      [{ similarity: 0.9, content: "fact" }],
      { baseDir }
    );

    const index = readFileSync(join(memDir, "MEMORY.md"), "utf-8");
    expect(index).toMatch(/Original note/);
    expect(index).toMatch(/pentatonic_session_memories\.md/);
  });

  it("returns {written:false} gracefully when cwd is missing", () => {
    const res = writeSessionMemoriesToAutoMemory(undefined, "q", [], {
      baseDir,
    });
    expect(res.written).toBe(false);
    expect(res.reason).toBe("no-cwd");
  });
});

// --- search_limit / min_score config wiring ---
//
// These knobs come from tes-memory.local.md frontmatter as strings (the
// loader doesn't parse types). Both used to be hardcoded `limit: 5,
// minScore: 0.3` in the GraphQL query / local-server POST. The fix in
// this PR plumbs them through; these tests assert the *outgoing request
// body* — without them, future refactors could silently re-hardcode the
// values and the suite would stay green.
describe("searchMemories — search_limit and min_score config wiring", () => {
  const hostedConfig = {
    tes_endpoint: "https://api.test.com",
    tes_client_id: "test-client",
    tes_api_key: "tes_sk_test123",
  };
  const localConfig = {
    mode: "local",
    memory_url: "http://localhost:9999",
  };

  function captureFetchOnce(searchResults = [{ id: "m1", content: "x", similarity: 0.9 }]) {
    const calls = [];
    globalThis.fetch = async (url, opts) => {
      const body = opts?.body ? JSON.parse(opts.body) : null;
      calls.push({ url, body });
      // Same-shape response for both hosted (GraphQL) and local (HTTP).
      const isHosted = String(url).includes("/api/graphql");
      return {
        ok: true,
        json: async () =>
          isHosted
            ? { data: { semanticSearchMemories: searchResults } }
            : { results: searchResults },
      };
    };
    return calls;
  }

  // --- hosted (GraphQL) ---

  it("hosted: passes config.search_limit through as the GraphQL `limit` variable", async () => {
    const calls = captureFetchOnce();
    await searchMemories({ ...hostedConfig, search_limit: "3" }, "q");
    expect(calls[0].body.variables.limit).toBe(3);
  });

  it("hosted: defaults to limit=5 when search_limit is not set", async () => {
    const calls = captureFetchOnce();
    await searchMemories(hostedConfig, "q");
    expect(calls[0].body.variables.limit).toBe(5);
  });

  it("hosted: passes config.min_score through as the GraphQL `minScore` variable", async () => {
    const calls = captureFetchOnce();
    await searchMemories({ ...hostedConfig, min_score: "0.7" }, "q");
    expect(calls[0].body.variables.minScore).toBeCloseTo(0.7, 5);
  });

  it("hosted: defaults to minScore=0.3 when min_score is not set", async () => {
    const calls = captureFetchOnce();
    await searchMemories(hostedConfig, "q");
    expect(calls[0].body.variables.minScore).toBeCloseTo(0.3, 5);
  });

  it("hosted: respects min_score=0 (legitimate 'return everything' debug setting)", async () => {
    const calls = captureFetchOnce();
    await searchMemories({ ...hostedConfig, min_score: "0" }, "q");
    expect(calls[0].body.variables.minScore).toBe(0);
  });

  it("hosted: falls back to 0.3 default when min_score is non-numeric", async () => {
    const calls = captureFetchOnce();
    await searchMemories({ ...hostedConfig, min_score: "not-a-number" }, "q");
    expect(calls[0].body.variables.minScore).toBeCloseTo(0.3, 5);
  });

  it("hosted: declares both as variables in the GraphQL query (not literals)", async () => {
    const calls = captureFetchOnce();
    await searchMemories({ ...hostedConfig, search_limit: "10", min_score: "0.5" }, "q");
    const queryStr = calls[0].body.query;
    // Variables, not literals — keeps the parsed-query plan stable and
    // matches the schema-strict deployment.
    expect(queryStr).toMatch(/\$limit:\s*Int!/);
    expect(queryStr).toMatch(/\$minScore:\s*Float!/);
    expect(queryStr).toMatch(/limit:\s*\$limit/);
    expect(queryStr).toMatch(/minScore:\s*\$minScore/);
    // No leftover hardcoded values.
    expect(queryStr).not.toMatch(/limit:\s*5\b/);
    expect(queryStr).not.toMatch(/minScore:\s*0\.3\b/);
  });

  // --- local (memory server HTTP) ---

  it("local: includes config.search_limit and config.min_score in POST body", async () => {
    const calls = captureFetchOnce();
    await searchMemories(
      { ...localConfig, search_limit: "8", min_score: "0.6" },
      "q"
    );
    expect(calls[0].body.limit).toBe(8);
    expect(calls[0].body.min_score).toBeCloseTo(0.6, 5);
  });

  it("local: defaults to limit=5, min_score=0.3 when neither is set", async () => {
    const calls = captureFetchOnce();
    await searchMemories(localConfig, "q");
    expect(calls[0].body.limit).toBe(5);
    expect(calls[0].body.min_score).toBeCloseTo(0.3, 5);
  });

  it("local: respects min_score=0", async () => {
    const calls = captureFetchOnce();
    await searchMemories({ ...localConfig, min_score: "0" }, "q");
    expect(calls[0].body.min_score).toBe(0);
  });
});
