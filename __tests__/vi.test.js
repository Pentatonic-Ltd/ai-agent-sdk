import {
  generateES256KeyPair,
  importPublicKey,
  createJWS,
  verifyJWS,
  sha256B64U,
  computeJWKThumbprint,
  signEventVI,
} from "../src/vi.js";

describe("VI signing primitives", () => {
  it("generates a P-256 keypair with a public JWK", async () => {
    const { privateKey, publicKey, publicJwk } = await generateES256KeyPair();
    expect(privateKey).toBeDefined();
    expect(publicKey).toBeDefined();
    expect(publicJwk.kty).toBe("EC");
    expect(publicJwk.crv).toBe("P-256");
    // Private material must not leak through the public JWK.
    expect(publicJwk.d).toBeUndefined();
  });

  it("creates a JWS that round-trips through verifyJWS", async () => {
    const { privateKey, publicJwk } = await generateES256KeyPair();
    const jws = await createJWS(
      { alg: "ES256", typ: "JWT" },
      { sub: "abc", iat: 1234 },
      privateKey
    );
    expect(jws.split(".")).toHaveLength(3);
    const result = await verifyJWS(jws, publicJwk);
    expect(result.valid).toBe(true);
    expect(result.payload.sub).toBe("abc");
    expect(result.header.alg).toBe("ES256");
  });

  it("rejects a JWS verified with the wrong key", async () => {
    const a = await generateES256KeyPair();
    const b = await generateES256KeyPair();
    const jws = await createJWS({ alg: "ES256" }, { sub: "x" }, a.privateKey);
    const result = await verifyJWS(jws, b.publicJwk);
    expect(result.valid).toBe(false);
  });

  it("rejects a tampered JWS", async () => {
    const { privateKey, publicJwk } = await generateES256KeyPair();
    const jws = await createJWS({ alg: "ES256" }, { sub: "x" }, privateKey);
    const [h, p, s] = jws.split(".");
    const tampered = `${h}.${p}AA.${s}`;
    const result = await verifyJWS(tampered, publicJwk);
    expect(result.valid).toBe(false);
  });

  it("rejects a malformed JWS without throwing", async () => {
    const { publicJwk } = await generateES256KeyPair();
    const result = await verifyJWS("not-a-jws", publicJwk);
    expect(result.valid).toBe(false);
  });

  it("computes a stable JWK thumbprint per RFC 7638", async () => {
    const { publicJwk } = await generateES256KeyPair();
    const t1 = await computeJWKThumbprint(publicJwk);
    const t2 = await computeJWKThumbprint(publicJwk);
    expect(t1).toBe(t2);
    expect(t1.length).toBeGreaterThan(20);
  });

  it("sha256B64U is deterministic", async () => {
    expect(await sha256B64U("hello")).toBe(await sha256B64U("hello"));
    expect(await sha256B64U("hello")).not.toBe(await sha256B64U("world"));
  });

  it("signEventVI binds the signature to the exact event body", async () => {
    const { privateKey, publicJwk } = await generateES256KeyPair();
    const jws = await signEventVI({
      sessionId: "sess-1",
      eventBody: { foo: "bar", n: 1 },
      privateKey,
      publicJwk,
    });
    const verified = await verifyJWS(jws, publicJwk);
    expect(verified.valid).toBe(true);
    expect(verified.payload.iss).toBe("agent");
    expect(verified.payload.sub).toBe("sess-1");
    expect(verified.payload.evt).toBe(
      await sha256B64U(JSON.stringify({ foo: "bar", n: 1 }))
    );
    // kid in header matches kid in payload matches the JWK thumbprint
    const thumb = await computeJWKThumbprint(publicJwk);
    expect(verified.header.kid).toBe(thumb);
    expect(verified.payload.kid).toBe(thumb);
  });

  it("signEventVI changes when the body changes (no replay)", async () => {
    const { privateKey, publicJwk } = await generateES256KeyPair();
    const a = await signEventVI({
      sessionId: "s",
      eventBody: { x: 1 },
      privateKey,
      publicJwk,
    });
    const b = await signEventVI({
      sessionId: "s",
      eventBody: { x: 2 },
      privateKey,
      publicJwk,
    });
    expect(a).not.toBe(b);
  });
});
