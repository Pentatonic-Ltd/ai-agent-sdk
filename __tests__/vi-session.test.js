import {
  getSessionSigner,
  signForSession,
  _clearSignerCacheForTest,
} from "../src/vi-session.js";
import { verifyJWS, sha256B64U } from "../src/vi.js";

afterEach(() => _clearSignerCacheForTest());

describe("getSessionSigner", () => {
  it("returns the same signer for the same sessionId", async () => {
    const a = await getSessionSigner("sess-1");
    const b = await getSessionSigner("sess-1");
    expect(a.kid).toBe(b.kid);
    expect(a.privateKey).toBe(b.privateKey);
  });

  it("returns different signers for different sessionIds", async () => {
    const a = await getSessionSigner("sess-A");
    const b = await getSessionSigner("sess-B");
    expect(a.kid).not.toBe(b.kid);
  });

  it("supports an injected cache for tenant scoping", async () => {
    const cache = new Map();
    const a = await getSessionSigner("s", { cache });
    const b = await getSessionSigner("s", { cache: new Map() });
    expect(a.kid).not.toBe(b.kid);
  });
});

describe("signForSession", () => {
  it("produces a JWS that the SDK's own verifier accepts", async () => {
    const body = { foo: "bar", model: "claude" };
    const jws = await signForSession("sess-1", body);
    expect(typeof jws).toBe("string");
    const { publicJwk } = await getSessionSigner("sess-1");
    const result = await verifyJWS(jws, publicJwk);
    expect(result.valid).toBe(true);
    expect(result.payload.sub).toBe("sess-1");
    expect(result.payload.evt).toBe(await sha256B64U(JSON.stringify(body)));
  });

  it("returns null on a crypto failure rather than throwing", async () => {
    // Inject a cache with a busted private key to force signing to throw.
    const cache = new Map();
    cache.set("sess-broken", {
      privateKey: null, // crypto.subtle.sign(null, ...) throws
      publicJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
      kid: "fake",
    });
    const result = await signForSession("sess-broken", { x: 1 }, { cache });
    expect(result).toBeNull();
  });
});
