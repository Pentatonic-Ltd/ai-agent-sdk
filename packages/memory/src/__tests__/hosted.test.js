/**
 * Tests for the hosted-mode helpers (semanticSearchMemories +
 * createModuleEvent over HTTPS with a tes_* bearer).
 *
 * Stub global fetch and assert request/response shape — the helpers
 * have no other side effects, so this is sufficient.
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import {
  hostedSearch,
  hostedEmitChatTurn,
  hostedStoreMemory,
  buildHostedHeaders,
} from "../hosted.js";

const CONFIG = {
  endpoint: "https://acme.api.example.com",
  clientId: "acme",
  apiKey: "tes_acme_xxxxxxxxxxxxxxxx",
};

const SVC_CONFIG = {
  endpoint: "https://acme.api.example.com",
  clientId: "acme",
  apiKey: "internal-service-key",
};

let originalFetch;
let lastCall;

function stubFetch(handler) {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    lastCall = {
      url: url.toString(),
      headers: init?.headers || {},
      body: init?.body ? JSON.parse(init.body) : null,
    };
    return handler(lastCall);
  };
}

afterEach(() => {
  if (originalFetch) globalThis.fetch = originalFetch;
  originalFetch = null;
  lastCall = null;
});

// =============================================================================
// buildHostedHeaders
// =============================================================================

describe("buildHostedHeaders", () => {
  it("uses Bearer auth for tes_* keys", () => {
    const headers = buildHostedHeaders(CONFIG);
    expect(headers["Authorization"]).toBe(`Bearer ${CONFIG.apiKey}`);
    expect(headers["x-client-id"]).toBe(CONFIG.clientId);
    expect(headers["x-service-key"]).toBeUndefined();
  });

  it("uses x-service-key for non-tes_ keys", () => {
    const headers = buildHostedHeaders(SVC_CONFIG);
    expect(headers["x-service-key"]).toBe(SVC_CONFIG.apiKey);
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("accepts legacy tes_endpoint/tes_client_id/tes_api_key keys", () => {
    const legacy = {
      tes_endpoint: CONFIG.endpoint,
      tes_client_id: CONFIG.clientId,
      tes_api_key: CONFIG.apiKey,
    };
    const headers = buildHostedHeaders(legacy);
    expect(headers["Authorization"]).toBe(`Bearer ${CONFIG.apiKey}`);
  });

  it("throws on incomplete config", () => {
    expect(() => buildHostedHeaders({})).toThrow(/requires/);
  });
});

// =============================================================================
// hostedSearch
// =============================================================================

describe("hostedSearch", () => {
  it("returns memories on a successful query", async () => {
    stubFetch(() =>
      new Response(
        JSON.stringify({
          data: {
            semanticSearchMemories: [
              { id: "m1", content: "User likes blue", similarity: 0.83 },
            ],
          },
        }),
        { status: 200 }
      )
    );

    const out = await hostedSearch(CONFIG, "what colour", { limit: 4 });
    expect(out.memories).toHaveLength(1);
    expect(out.skipped).toBeUndefined();
    expect(lastCall.body.variables.clientId).toBe("acme");
    expect(lastCall.body.variables.limit).toBe(4);
    expect(lastCall.headers["Authorization"]).toBe(`Bearer ${CONFIG.apiKey}`);
  });

  it("returns { memories: [], skipped: 'no_query' } when query is empty", async () => {
    stubFetch(() => new Response("{}", { status: 200 }));
    const out = await hostedSearch(CONFIG, "");
    expect(out.skipped).toBe("no_query");
  });

  it("skips with tes_http_500 on 500 responses", async () => {
    stubFetch(() => new Response("oops", { status: 500 }));
    const out = await hostedSearch(CONFIG, "q");
    expect(out.skipped).toBe("tes_http_500");
    expect(out.memories).toEqual([]);
  });

  it("skips with tes_graphql:<reason> on graphql errors", async () => {
    stubFetch(() =>
      new Response(
        JSON.stringify({
          errors: [{ message: 'Module "deep-memory" is not enabled' }],
        }),
        { status: 200 }
      )
    );
    const out = await hostedSearch(CONFIG, "q");
    expect(out.skipped).toMatch(/^tes_graphql:/);
  });

  it("skips with tes_timeout on AbortError", async () => {
    stubFetch(() => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    });
    const out = await hostedSearch(CONFIG, "q", { timeoutMs: 5 });
    expect(out.skipped).toBe("tes_timeout");
  });

  it("skips with tes_unreachable on generic fetch failure", async () => {
    stubFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    const out = await hostedSearch(CONFIG, "q");
    expect(out.skipped).toBe("tes_unreachable");
  });
});

// =============================================================================
// hostedEmitChatTurn
// =============================================================================

describe("hostedEmitChatTurn", () => {
  it("emits createModuleEvent with conversation-analytics moduleId", async () => {
    stubFetch(() =>
      new Response(
        JSON.stringify({
          data: { createModuleEvent: { success: true, eventId: "evt_1" } },
        }),
        { status: 200 }
      )
    );

    const out = await hostedEmitChatTurn(
      CONFIG,
      {
        userMessage: "hi",
        assistantResponse: "hello!",
        model: "gpt-4o",
        sessionId: "sess_1",
      },
      { source: "my-app" }
    );

    expect(out.ok).toBe(true);
    expect(out.eventId).toBe("evt_1");
    expect(lastCall.body.variables.moduleId).toBe("conversation-analytics");
    expect(lastCall.body.variables.input.eventType).toBe("CHAT_TURN");
    expect(lastCall.body.variables.input.data.attributes.source).toBe("my-app");
    expect(lastCall.body.variables.input.data.attributes.user_message).toBe(
      "hi"
    );
    expect(lastCall.body.variables.input.data.entity_id).toBe("sess_1");
  });

  it("skips empty turns (no user + no assistant text)", async () => {
    stubFetch(() => new Response("{}", { status: 200 }));
    const out = await hostedEmitChatTurn(CONFIG, {});
    expect(out.skipped).toBe("empty_turn");
  });

  it("merges payload.extra into attributes", async () => {
    stubFetch(() =>
      new Response(
        JSON.stringify({
          data: { createModuleEvent: { success: true, eventId: "x" } },
        }),
        { status: 200 }
      )
    );
    await hostedEmitChatTurn(CONFIG, {
      userMessage: "u",
      assistantResponse: "a",
      extra: { tes_skipped_reason: "passthrough_mode", custom_flag: 1 },
    });
    const attrs = lastCall.body.variables.input.data.attributes;
    expect(attrs.tes_skipped_reason).toBe("passthrough_mode");
    expect(attrs.custom_flag).toBe(1);
  });
});

// =============================================================================
// hostedStoreMemory
// =============================================================================

describe("hostedStoreMemory", () => {
  it("emits STORE_MEMORY against deep-memory", async () => {
    stubFetch(() =>
      new Response(
        JSON.stringify({
          data: { createModuleEvent: { success: true, eventId: "stored" } },
        }),
        { status: 200 }
      )
    );
    const out = await hostedStoreMemory(
      CONFIG,
      "User owns a Subaru",
      { session_id: "abc" },
      { source: "my-app" }
    );
    expect(out.ok).toBe(true);
    expect(lastCall.body.variables.moduleId).toBe("deep-memory");
    expect(lastCall.body.variables.input.eventType).toBe("STORE_MEMORY");
    expect(lastCall.body.variables.input.data.attributes.content).toBe(
      "User owns a Subaru"
    );
    expect(lastCall.body.variables.input.data.attributes.source).toBe("my-app");
    expect(lastCall.body.variables.input.data.entity_id).toBe("abc");
  });

  it("skips with no_content if content is empty", async () => {
    stubFetch(() => new Response("{}", { status: 200 }));
    const out = await hostedStoreMemory(CONFIG, "");
    expect(out.skipped).toBe("no_content");
  });
});
