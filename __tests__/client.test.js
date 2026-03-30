import { TESClient } from "../src/index.js";

// Mock fetch globally
globalThis.fetch = async () => ({
  ok: true,
  json: async () => ({
    data: { emitEvent: { success: true, eventId: "evt-1" } },
  }),
});

describe("TESClient constructor", () => {
  it("throws when clientId is missing", () => {
    expect(
      () => new TESClient({ apiKey: "k", endpoint: "https://api.test.com" })
    ).toThrow("clientId is required");
  });

  it("throws when apiKey is missing", () => {
    expect(
      () => new TESClient({ clientId: "c", endpoint: "https://api.test.com" })
    ).toThrow("apiKey is required");
  });

  it("throws when endpoint is missing", () => {
    expect(
      () => new TESClient({ clientId: "c", apiKey: "k" })
    ).toThrow("endpoint is required");
  });

  it("strips trailing slash from endpoint", () => {
    const tes = new TESClient({
      clientId: "c",
      apiKey: "k",
      endpoint: "https://api.test.com/",
    });
    expect(tes.endpoint).toBe("https://api.test.com");
  });

  it("rejects http:// for non-localhost", () => {
    expect(
      () =>
        new TESClient({
          clientId: "c",
          apiKey: "k",
          endpoint: "http://production.com",
        })
    ).toThrow("endpoint must use https://");
  });

  it("allows http://localhost", () => {
    const tes = new TESClient({
      clientId: "c",
      apiKey: "k",
      endpoint: "http://localhost:8788",
    });
    expect(tes.endpoint).toBe("http://localhost:8788");
  });

  it("allows http://127.0.0.1", () => {
    const tes = new TESClient({
      clientId: "c",
      apiKey: "k",
      endpoint: "http://127.0.0.1:3000",
    });
    expect(tes.endpoint).toBe("http://127.0.0.1:3000");
  });

  it("hides apiKey from enumeration", () => {
    const tes = new TESClient({
      clientId: "c",
      apiKey: "super-secret",
      endpoint: "https://api.test.com",
    });
    expect(Object.keys(tes)).not.toContain("_apiKey");
    expect(JSON.stringify(tes)).not.toContain("super-secret");
  });

  it("hides headers from enumeration", () => {
    const tes = new TESClient({
      clientId: "c",
      apiKey: "k",
      endpoint: "https://api.test.com",
      headers: { "X-Secret": "hidden" },
    });
    expect(Object.keys(tes)).not.toContain("_headers");
    expect(JSON.stringify(tes)).not.toContain("hidden");
  });

  it("defaults captureContent to true", () => {
    const tes = new TESClient({
      clientId: "c",
      apiKey: "k",
      endpoint: "https://api.test.com",
    });
    expect(tes.captureContent).toBe(true);
  });

  it("defaults maxContentLength to 4096", () => {
    const tes = new TESClient({
      clientId: "c",
      apiKey: "k",
      endpoint: "https://api.test.com",
    });
    expect(tes.maxContentLength).toBe(4096);
  });

  it("accepts custom captureContent and maxContentLength", () => {
    const tes = new TESClient({
      clientId: "c",
      apiKey: "k",
      endpoint: "https://api.test.com",
      captureContent: false,
      maxContentLength: 1024,
    });
    expect(tes.captureContent).toBe(false);
    expect(tes.maxContentLength).toBe(1024);
  });
});

describe("TESClient._config", () => {
  it("exposes all config fields including hidden ones", () => {
    const tes = new TESClient({
      clientId: "my-client",
      apiKey: "tes_sk_test",
      endpoint: "https://api.test.com",
      headers: { "X-Foo": "bar" },
      userId: "user-1",
    });

    const config = tes._config;
    expect(config.clientId).toBe("my-client");
    expect(config.apiKey).toBe("tes_sk_test");
    expect(config.endpoint).toBe("https://api.test.com");
    expect(config.headers).toEqual({ "X-Foo": "bar" });
    expect(config.userId).toBe("user-1");
    expect(config.captureContent).toBe(true);
    expect(config.maxContentLength).toBe(4096);
  });
});

describe("TESClient.session()", () => {
  const tes = new TESClient({
    clientId: "test-client",
    apiKey: "tes_sk_test",
    endpoint: "https://api.test.com",
  });

  it("creates a Session instance", () => {
    const session = tes.session();
    expect(session).toBeDefined();
    expect(session.sessionId).toBeDefined();
  });

  it("passes sessionId through", () => {
    const session = tes.session({ sessionId: "my-session" });
    expect(session.sessionId).toBe("my-session");
  });

  it("passes metadata through", () => {
    const session = tes.session({
      sessionId: "meta-test",
      metadata: { shop: "cool.myshopify.com" },
    });
    expect(session._metadata).toEqual({ shop: "cool.myshopify.com" });
  });
});

describe("TESClient.wrap()", () => {
  const tes = new TESClient({
    clientId: "test-client",
    apiKey: "tes_sk_test",
    endpoint: "https://api.test.com",
  });

  it("returns a wrapped client object", () => {
    const mockClient = {
      chat: { completions: { create: async () => ({}) } },
    };
    const wrapped = tes.wrap(mockClient);
    expect(wrapped).toBeDefined();
    expect(wrapped.chat.completions.create).toBeDefined();
  });

  it("exposes sessionId on wrapped client", () => {
    const mockClient = {
      chat: { completions: { create: async () => ({}) } },
    };
    const wrapped = tes.wrap(mockClient, { sessionId: "wrap-sess-1" });
    expect(wrapped.sessionId).toBe("wrap-sess-1");
  });

  it("exposes tesSession on wrapped client", () => {
    const mockClient = {
      chat: { completions: { create: async () => ({}) } },
    };
    const wrapped = tes.wrap(mockClient, { sessionId: "wrap-sess-2" });
    expect(wrapped.tesSession).toBeDefined();
    expect(wrapped.tesSession.sessionId).toBe("wrap-sess-2");
  });
});
