import { sendEvent } from "../src/transport.js";

describe("sendEvent", () => {
  const baseConfig = {
    endpoint: "https://api.test.com",
    clientId: "test-client",
    apiKey: "tes_sk_test",
    userId: null,
    headers: {},
  };

  it("sends GraphQL mutation to correct endpoint", async () => {
    let captured;
    const mockFetch = async (url, opts) => {
      captured = { url, opts };
      return {
        ok: true,
        json: async () => ({
          data: { createModuleEvent: { success: true, eventId: "evt-1" } },
        }),
      };
    };

    await sendEvent(baseConfig, { eventType: "CHAT_TURN", data: {} }, mockFetch);

    expect(captured.url).toBe("https://api.test.com/api/graphql");
    expect(captured.opts.method).toBe("POST");
    expect(captured.opts.headers["Content-Type"]).toBe("application/json");
  });

  it("uses Bearer auth for tes_ prefixed keys", async () => {
    let captured;
    const mockFetch = async (url, opts) => {
      captured = { url, opts };
      return {
        ok: true,
        json: async () => ({
          data: { createModuleEvent: { success: true, eventId: "evt-1" } },
        }),
      };
    };

    await sendEvent(
      { ...baseConfig, apiKey: "tes_sk_my_key" },
      { eventType: "TEST", data: {} },
      mockFetch
    );

    expect(captured.opts.headers["Authorization"]).toBe("Bearer tes_sk_my_key");
    expect(captured.opts.headers["x-service-key"]).toBeUndefined();
  });

  it("uses x-service-key for non-tes_ prefixed keys", async () => {
    let captured;
    const mockFetch = async (url, opts) => {
      captured = { url, opts };
      return {
        ok: true,
        json: async () => ({
          data: { createModuleEvent: { success: true, eventId: "evt-1" } },
        }),
      };
    };

    await sendEvent(
      { ...baseConfig, apiKey: "internal_service_key_abc" },
      { eventType: "TEST", data: {} },
      mockFetch
    );

    expect(captured.opts.headers["x-service-key"]).toBe("internal_service_key_abc");
    expect(captured.opts.headers["Authorization"]).toBeUndefined();
  });

  it("sends x-client-id header", async () => {
    let captured;
    const mockFetch = async (url, opts) => {
      captured = { url, opts };
      return {
        ok: true,
        json: async () => ({
          data: { createModuleEvent: { success: true, eventId: "evt-1" } },
        }),
      };
    };

    await sendEvent(baseConfig, { eventType: "TEST", data: {} }, mockFetch);

    expect(captured.opts.headers["x-client-id"]).toBe("test-client");
  });

  it("merges custom headers", async () => {
    let captured;
    const mockFetch = async (url, opts) => {
      captured = { url, opts };
      return {
        ok: true,
        json: async () => ({
          data: { createModuleEvent: { success: true, eventId: "evt-1" } },
        }),
      };
    };

    await sendEvent(
      { ...baseConfig, headers: { "X-Custom": "val" } },
      { eventType: "TEST", data: {} },
      mockFetch
    );

    expect(captured.opts.headers["X-Custom"]).toBe("val");
  });

  it("includes userId in attributes when provided", async () => {
    let captured;
    const mockFetch = async (url, opts) => {
      captured = { url, opts };
      return {
        ok: true,
        json: async () => ({
          data: { createModuleEvent: { success: true, eventId: "evt-1" } },
        }),
      };
    };

    await sendEvent(
      { ...baseConfig, userId: "user-42" },
      { eventType: "TEST", data: { attributes: { foo: "bar" } } },
      mockFetch
    );

    const body = JSON.parse(captured.opts.body);
    expect(body.variables.input.data.attributes.userId).toBe("user-42");
    expect(body.variables.input.data.attributes.foo).toBe("bar");
  });

  it("does not add userId when null", async () => {
    let captured;
    const mockFetch = async (url, opts) => {
      captured = { url, opts };
      return {
        ok: true,
        json: async () => ({
          data: { createModuleEvent: { success: true, eventId: "evt-1" } },
        }),
      };
    };

    await sendEvent(baseConfig, { eventType: "TEST", data: { attributes: {} } }, mockFetch);

    const body = JSON.parse(captured.opts.body);
    expect(body.variables.input.data.attributes.userId).toBeUndefined();
  });

  it("throws on non-ok HTTP response", async () => {
    const mockFetch = async () => ({
      ok: false,
      status: 500,
    });

    await expect(
      sendEvent(baseConfig, { eventType: "TEST", data: {} }, mockFetch)
    ).rejects.toThrow("TES API error: 500");
  });

  it("throws on GraphQL errors", async () => {
    const mockFetch = async () => ({
      ok: true,
      json: async () => ({
        errors: [{ message: "Permission denied" }],
      }),
    });

    await expect(
      sendEvent(baseConfig, { eventType: "TEST", data: {} }, mockFetch)
    ).rejects.toThrow("TES GraphQL error: Permission denied");
  });

  it("returns createModuleEvent data on success", async () => {
    const mockFetch = async () => ({
      ok: true,
      json: async () => ({
        data: { createModuleEvent: { success: true, eventId: "evt-99" } },
      }),
    });

    const result = await sendEvent(baseConfig, { eventType: "TEST", data: {} }, mockFetch);

    expect(result).toEqual({ success: true, eventId: "evt-99" });
  });

  it("sends correct GraphQL mutation shape", async () => {
    let captured;
    const mockFetch = async (url, opts) => {
      captured = { url, opts };
      return {
        ok: true,
        json: async () => ({
          data: { createModuleEvent: { success: true, eventId: "evt-1" } },
        }),
      };
    };

    const input = {
      eventType: "CHAT_TURN",
      entityType: "conversation",
      data: {
        entity_id: "sess-1",
        attributes: { model: "gpt-4o" },
      },
    };

    await sendEvent(baseConfig, input, mockFetch);

    const body = JSON.parse(captured.opts.body);
    expect(body.query).toContain("createModuleEvent");
    expect(body.variables.moduleId).toBe("conversation-analytics");
    expect(body.variables.input.eventType).toBe("CHAT_TURN");
    expect(body.variables.input.data.entity_id).toBe("sess-1");
  });
});
