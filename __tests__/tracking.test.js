import {
  signPayload,
  verifyPayload,
  buildTrackUrl,
  rewriteUrls,
} from "../src/tracking.js";

describe("signPayload", () => {
  it("returns a base64url string (no +, /, or =)", async () => {
    const sig = await signPayload("secret", { u: "https://example.com" });
    expect(sig).toBeDefined();
    expect(sig).not.toMatch(/[+/=]/);
    expect(typeof sig).toBe("string");
    expect(sig.length).toBeGreaterThan(0);
  });

  it("produces deterministic output for same inputs", async () => {
    const payload = { u: "https://example.com", t: 1000 };
    const sig1 = await signPayload("secret", payload);
    const sig2 = await signPayload("secret", payload);
    expect(sig1).toBe(sig2);
  });

  it("produces different output for different secrets", async () => {
    const payload = { u: "https://example.com" };
    const sig1 = await signPayload("secret-a", payload);
    const sig2 = await signPayload("secret-b", payload);
    expect(sig1).not.toBe(sig2);
  });

  it("produces different output for different payloads", async () => {
    const sig1 = await signPayload("secret", { u: "https://a.com" });
    const sig2 = await signPayload("secret", { u: "https://b.com" });
    expect(sig1).not.toBe(sig2);
  });
});

describe("verifyPayload", () => {
  it("returns true for valid signature", async () => {
    const payload = { u: "https://example.com", t: 12345 };
    const sig = await signPayload("my-key", payload);
    const valid = await verifyPayload("my-key", payload, sig);
    expect(valid).toBe(true);
  });

  it("returns false for tampered payload", async () => {
    const sig = await signPayload("my-key", { u: "https://example.com" });
    const valid = await verifyPayload("my-key", { u: "https://evil.com" }, sig);
    expect(valid).toBe(false);
  });

  it("returns false for wrong secret", async () => {
    const payload = { u: "https://example.com" };
    const sig = await signPayload("correct-key", payload);
    const valid = await verifyPayload("wrong-key", payload, sig);
    expect(valid).toBe(false);
  });
});

describe("buildTrackUrl", () => {
  it("returns URL in format {endpoint}/r/{encoded}?sig={sig}", async () => {
    const url = await buildTrackUrl("https://api.test.com", "api-key", {
      u: "https://example.com",
      s: "sess-1",
      c: "client-1",
      t: 1000,
    });

    expect(url).toMatch(/^https:\/\/api\.test\.com\/r\/[A-Za-z0-9_-]+\?sig=[A-Za-z0-9_-]+$/);
  });

  it("defaults payload.e to LINK_CLICK", async () => {
    const url = await buildTrackUrl("https://api.test.com", "api-key", {
      u: "https://example.com",
    });

    // Decode the payload from the URL to check
    const match = url.match(/\/r\/([^?]+)/);
    const encoded = match[1];
    // Restore base64 padding and chars
    let b64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const decoded = JSON.parse(atob(b64));
    expect(decoded.e).toBe("LINK_CLICK");
  });

  it("does not override explicitly set event type", async () => {
    const url = await buildTrackUrl("https://api.test.com", "api-key", {
      u: "https://example.com",
      e: "CUSTOM_EVENT",
    });

    const match = url.match(/\/r\/([^?]+)/);
    let b64 = match[1].replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const decoded = JSON.parse(atob(b64));
    expect(decoded.e).toBe("CUSTOM_EVENT");
  });

  it("encodes payload as base64url (no +, /, =)", async () => {
    const url = await buildTrackUrl("https://api.test.com", "api-key", {
      u: "https://example.com/path?foo=bar&baz=1",
      s: "sess-1",
      c: "client-1",
      t: 1000,
    });

    const match = url.match(/\/r\/([^?]+)/);
    const encoded = match[1];
    expect(encoded).not.toMatch(/[+/=]/);
  });
});

describe("rewriteUrls", () => {
  const config = {
    endpoint: "https://api.test.com",
    apiKey: "test-key",
    clientId: "client-1",
  };

  it("rewrites http and https URLs in text", async () => {
    const text = "Check out https://example.com and http://other.com for more.";
    const result = await rewriteUrls(text, config, "sess-1");

    expect(result).not.toContain("https://example.com");
    expect(result).not.toContain("http://other.com");
    expect(result).toContain("https://api.test.com/r/");
    // Should have two tracked URLs
    const matches = result.match(/https:\/\/api\.test\.com\/r\//g);
    expect(matches).toHaveLength(2);
  });

  it("skips URLs already pointing to the redirect endpoint", async () => {
    const existing = "https://api.test.com/r/abc123?sig=xyz";
    const text = `Visit ${existing} for info.`;
    const result = await rewriteUrls(text, config, "sess-1");

    // The already-tracked URL should be left alone
    expect(result).toContain(existing);
    // Only the one existing tracked URL, no double-wrapping
    const matches = result.match(/https:\/\/api\.test\.com\/r\//g);
    expect(matches).toHaveLength(1);
  });

  it("returns falsy/empty text unchanged", async () => {
    expect(await rewriteUrls("", config, "sess-1")).toBe("");
    expect(await rewriteUrls(null, config, "sess-1")).toBe(null);
    expect(await rewriteUrls(undefined, config, "sess-1")).toBe(undefined);
  });

  it("returns text with no URLs unchanged", async () => {
    const text = "No links here, just plain text.";
    const result = await rewriteUrls(text, config, "sess-1");
    expect(result).toBe(text);
  });

  it("includes sessionId and clientId in payload", async () => {
    const text = "See https://example.com";
    const result = await rewriteUrls(text, config, "sess-42");

    // Extract and decode the payload
    const match = result.match(/\/r\/([^?]+)/);
    let b64 = match[1].replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const decoded = JSON.parse(atob(b64));

    expect(decoded.u).toBe("https://example.com");
    expect(decoded.s).toBe("sess-42");
    expect(decoded.c).toBe("client-1");
    expect(decoded.e).toBe("LINK_CLICK");
    expect(typeof decoded.t).toBe("number");
  });

  it("merges optional metadata into payload.a", async () => {
    const text = "See https://example.com";
    const result = await rewriteUrls(text, config, "sess-1", {
      product_id: "prod-99",
      source: "chat",
    });

    const match = result.match(/\/r\/([^?]+)/);
    let b64 = match[1].replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const decoded = JSON.parse(atob(b64));

    expect(decoded.a).toEqual({ product_id: "prod-99", source: "chat" });
  });

  it("omits payload.a when no metadata is provided", async () => {
    const text = "See https://example.com";
    const result = await rewriteUrls(text, config, "sess-1");

    const match = result.match(/\/r\/([^?]+)/);
    let b64 = match[1].replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const decoded = JSON.parse(atob(b64));

    expect(decoded.a).toBeUndefined();
  });
});

describe("Session.trackUrl", () => {
  // Mock fetch globally since Session uses sendEvent internally
  const originalFetch = globalThis.fetch;
  beforeAll(() => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ data: { emitEvent: { success: true, eventId: "evt-1" } } }),
    });
  });
  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  // Helper to decode payload from a tracked URL
  function decodePayload(url) {
    const match = url.match(/\/r\/([^?]+)/);
    let b64 = match[1].replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    return JSON.parse(atob(b64));
  }

  let Session;
  beforeAll(async () => {
    ({ Session } = await import("../src/session.js"));
  });

  it("returns a tracked redirect URL containing the endpoint", async () => {
    const session = new Session({
      clientId: "client-1",
      apiKey: "test-key",
      endpoint: "https://api.test.com",
    });

    const result = await session.trackUrl("https://example.com");
    expect(result).toContain("https://api.test.com/r/");
    expect(result).toMatch(/\?sig=[A-Za-z0-9_-]+$/);
  });

  it("payload contains the session's sessionId and clientId", async () => {
    const session = new Session(
      { clientId: "client-42", apiKey: "test-key", endpoint: "https://api.test.com" },
      { sessionId: "sess-abc" },
    );

    const result = await session.trackUrl("https://example.com");
    const payload = decodePayload(result);

    expect(payload.s).toBe("sess-abc");
    expect(payload.c).toBe("client-42");
    expect(payload.u).toBe("https://example.com");
    expect(typeof payload.t).toBe("number");
  });

  it("includes custom eventType and attributes in the payload", async () => {
    const session = new Session(
      { clientId: "client-1", apiKey: "test-key", endpoint: "https://api.test.com" },
      { sessionId: "sess-1" },
    );

    const result = await session.trackUrl("https://example.com", {
      eventType: "PRODUCT_CLICK",
      attributes: { product_id: "prod-99" },
    });
    const payload = decodePayload(result);

    expect(payload.e).toBe("PRODUCT_CLICK");
    expect(payload.a).toEqual(expect.objectContaining({ product_id: "prod-99" }));
  });

  it("defaults eventType to LINK_CLICK", async () => {
    const session = new Session(
      { clientId: "client-1", apiKey: "test-key", endpoint: "https://api.test.com" },
      { sessionId: "sess-1" },
    );

    const result = await session.trackUrl("https://example.com");
    const payload = decodePayload(result);

    expect(payload.e).toBe("LINK_CLICK");
  });

  it("includes session metadata in attributes", async () => {
    const session = new Session(
      { clientId: "client-1", apiKey: "test-key", endpoint: "https://api.test.com" },
      { sessionId: "sess-1", metadata: { source: "chat", user_tier: "premium" } },
    );

    const result = await session.trackUrl("https://example.com");
    const payload = decodePayload(result);

    expect(payload.a).toEqual(expect.objectContaining({ source: "chat", user_tier: "premium" }));
  });

  it("merges session metadata with call-time attributes", async () => {
    const session = new Session(
      { clientId: "client-1", apiKey: "test-key", endpoint: "https://api.test.com" },
      { sessionId: "sess-1", metadata: { source: "chat" } },
    );

    const result = await session.trackUrl("https://example.com", {
      attributes: { product_id: "prod-1" },
    });
    const payload = decodePayload(result);

    expect(payload.a).toEqual(expect.objectContaining({ source: "chat", product_id: "prod-1" }));
  });
});
