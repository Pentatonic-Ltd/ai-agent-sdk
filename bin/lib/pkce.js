import { randomBytes, createHash } from "node:crypto";

/**
 * Generate a PKCE verifier + S256 challenge per RFC 7636 plus a
 * CSRF-protection state token. All three are URL-safe base64.
 *
 * Used by the SDK login command to bind the localhost callback against
 * the OAuth code we just issued — verifier is sent to /oauth/token at
 * exchange time; challenge is sent up-front at /cli-init.
 */
export function generatePKCE() {
  // 64 random bytes -> 86-char base64url verifier (within 43-128 range).
  const verifier = base64url(randomBytes(64));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  // 32 bytes -> 43-char base64url state.
  const state = base64url(randomBytes(32));
  return { verifier, challenge, state };
}

function base64url(buf) {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
