/**
 * Per-session VI signer cache.
 *
 * Generating an ES256 keypair takes ~1ms and produces a fresh signing
 * identity. We want one keypair per agent session so that a verifier
 * can correlate every signed event in a session to the same `kid`
 * thumbprint, but adjacent sessions can't impersonate each other.
 *
 * The cache is module-scoped (one Map per process). Pass an explicit
 * cache via `opts.cache` to test or to scope per-tenant.
 */

import { generateES256KeyPair, signEventVI, computeJWKThumbprint } from "./vi.js";

const defaultCache = new Map();

/**
 * Get or create the signer for a session.
 * Returns { privateKey, publicJwk, kid }.
 */
export async function getSessionSigner(sessionId, { cache = defaultCache } = {}) {
  const existing = cache.get(sessionId);
  if (existing) return existing;
  const { privateKey, publicJwk } = await generateES256KeyPair();
  const kid = await computeJWKThumbprint(publicJwk);
  const signer = { privateKey, publicJwk, kid };
  cache.set(sessionId, signer);
  return signer;
}

/**
 * Sign an event payload for a session. Returns the JWS to attach as
 * the `vi.worker_jws` sidecar on the event's data.attributes.
 *
 * Returns null on any error rather than throwing — VI signing is
 * best-effort. A failure should never block event emission, since the
 * dashboard renders unsigned events too (just as 'Unsigned' instead of
 * 'Verified'). Callers should pass through the JWS only when truthy.
 */
export async function signForSession(sessionId, eventBody, opts = {}) {
  try {
    const { privateKey, publicJwk } = await getSessionSigner(sessionId, opts);
    return await signEventVI({ sessionId, eventBody, privateKey, publicJwk });
  } catch {
    return null;
  }
}

/** Clear the in-process signer cache. Test helper. */
export function _clearSignerCacheForTest() {
  defaultCache.clear();
}
