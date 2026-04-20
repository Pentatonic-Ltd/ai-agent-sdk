/**
 * Verifiable Intent (VI) signing utilities.
 *
 * Provides ES256 (ECDSA P-256 + SHA-256) JWS creation and verification
 * via the Web Crypto API. Works in Node ≥18, Cloudflare Workers, and
 * browsers — same primitives used by the TES worker pipeline so signed
 * events round-trip cleanly.
 *
 * Why this lives in the SDK: the conversation-analytics dashboard's
 * Verifiable Intent tab reads `vi_status` per event, populated by the
 * TES consumer pipeline (workers/consumers/eventStorage.js → verifyEventVI).
 * Without an SDK-side signer, every agent-emitted event lands as
 * `vi_status='unsigned'` — the tab renders 100% Unsigned regardless of
 * how many turns happen. This module gives the SDK and OpenClaw plugin
 * the primitives to sign payloads on emit.
 *
 * Algorithm: ES256 / P-256 / JWS Compact. Matches the format produced
 * by `shopify-app/src/vi.js` in the TES repo so the existing
 * `verifyJWS` consumer can verify SDK-emitted events without changes.
 */

function b64u(buffer) {
  const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer;
  let binary = "";
  for (let i = 0; i < bytes.length; i++)
    binary += String.fromCharCode(bytes[i]);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function b64uDecode(str) {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function b64uJSON(obj) {
  return b64u(new TextEncoder().encode(JSON.stringify(obj)));
}

/**
 * Generate an ephemeral ES256 keypair. Strip private/usage hints from
 * the exported public JWK so it's safe to ship to the verifier.
 */
export async function generateES256KeyPair() {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );
  const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  delete publicJwk.d;
  delete publicJwk.key_ops;
  delete publicJwk.ext;
  return {
    publicKey: keyPair.publicKey,
    privateKey: keyPair.privateKey,
    publicJwk,
  };
}

export async function importPublicKey(jwk) {
  return crypto.subtle.importKey(
    "jwk",
    { ...jwk, key_ops: ["verify"] },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"]
  );
}

export async function createJWS(header, payload, privateKey) {
  const headerB64 = b64uJSON(header);
  const payloadB64 = b64uJSON(payload);
  const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const rawSig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    signingInput
  );
  return `${headerB64}.${payloadB64}.${b64u(rawSig)}`;
}

export async function verifyJWS(jws, publicKey) {
  try {
    const parts = jws.split(".");
    if (parts.length !== 3) return { valid: false };
    const [headerB64, payloadB64, sigB64] = parts;
    const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const signature = b64uDecode(sigB64);
    const key =
      publicKey instanceof CryptoKey
        ? publicKey
        : await importPublicKey(publicKey);
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      signature,
      signingInput
    );
    if (!valid) return { valid: false };
    const header = JSON.parse(new TextDecoder().decode(b64uDecode(headerB64)));
    const payload = JSON.parse(
      new TextDecoder().decode(b64uDecode(payloadB64))
    );
    return { valid: true, header, payload };
  } catch {
    return { valid: false };
  }
}

export async function sha256B64U(input) {
  const data =
    typeof input === "string" ? new TextEncoder().encode(input) : input;
  const hash = await crypto.subtle.digest("SHA-256", data);
  return b64u(hash);
}

/**
 * RFC 7638 thumbprint of a JWK — stable identifier for a public key.
 * Used as the session signer's fingerprint when stamping events.
 */
export async function computeJWKThumbprint(jwk) {
  const canonical = JSON.stringify({
    crv: jwk.crv,
    kty: jwk.kty,
    x: jwk.x,
    y: jwk.y,
  });
  return sha256B64U(canonical);
}

/**
 * Build a VI sidecar for an event. Returns the JWS string that should
 * be attached to the event payload (the consumer pipeline reads it as
 * `event.vi.worker_jws` per the spec in shopify-app/src/vi.js).
 *
 * Claim shape (matches widget claim format):
 *   {
 *     iss: "agent",
 *     sub: <sessionId>,
 *     iat: <unix seconds>,
 *     evt: <event hash>,
 *     kid: <JWK thumbprint of signer>,
 *   }
 *
 * The event hash binds the signature to the exact payload — any
 * tampering downstream invalidates the signature.
 */
export async function signEventVI({ sessionId, eventBody, privateKey, publicJwk }) {
  const eventHash = await sha256B64U(JSON.stringify(eventBody));
  const kid = await computeJWKThumbprint(publicJwk);
  const header = { alg: "ES256", typ: "JWT", kid };
  const payload = {
    iss: "agent",
    sub: sessionId,
    iat: Math.floor(Date.now() / 1000),
    evt: eventHash,
    kid,
  };
  return createJWS(header, payload, privateKey);
}

export { b64u, b64uDecode };
