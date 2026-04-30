import { generatePKCE } from "../lib/pkce.js";
import { createHash } from "node:crypto";

describe("generatePKCE", () => {
  it("returns verifier between 43 and 128 chars (RFC 7636)", () => {
    const { verifier } = generatePKCE();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
  });

  it("verifier uses unreserved URL characters only", () => {
    const { verifier } = generatePKCE();
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });

  it("challenge is base64url(SHA-256(verifier)) per RFC 7636", () => {
    const { verifier, challenge } = generatePKCE();
    const expected = createHash("sha256")
      .update(verifier)
      .digest("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(challenge).toBe(expected);
  });

  it("returns a 32-byte (43-char base64url) state", () => {
    const { state } = generatePKCE();
    expect(state.length).toBeGreaterThanOrEqual(43);
    expect(state).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });

  it("two calls produce distinct verifier and state", () => {
    const a = generatePKCE();
    const b = generatePKCE();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.state).not.toBe(b.state);
  });
});
