/**
 * HMAC signing and URL rewriting utilities for click tracking.
 *
 * Uses the Web Crypto API (works in browsers, Node 18+, Cloudflare Workers).
 */

const encoder = new TextEncoder();

/**
 * Encode bytes to base64url (RFC 4648 §5) — no padding.
 */
function toBase64Url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * HMAC-SHA256 sign a JSON payload, returning a base64url signature.
 *
 * @param {string} secret  Shared secret (TES_INTERNAL_SERVICE_KEY)
 * @param {object} payload Object to sign (serialised to canonical JSON)
 * @returns {Promise<string>} base64url HMAC signature
 */
export async function signPayload(secret, payload) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const data = encoder.encode(JSON.stringify(payload));
  const sig = await crypto.subtle.sign("HMAC", key, data);
  return toBase64Url(sig);
}

/**
 * Verify a payload against a base64url HMAC-SHA256 signature.
 *
 * @param {string} secret    Shared secret
 * @param {object} payload   Payload object
 * @param {string} signature base64url signature to verify
 * @returns {Promise<boolean>}
 */
export async function verifyPayload(secret, payload, signature) {
  const expected = await signPayload(secret, payload);
  return expected === signature;
}

/**
 * Build a TES redirect/tracking URL.
 *
 * @param {string} endpoint TES API base URL (no trailing slash)
 * @param {string} apiKey   Shared secret for signing
 * @param {object} payload  Tracking payload with short keys (u, s, c, t, e, a)
 * @returns {Promise<string>} Full redirect URL
 */
export async function buildTrackUrl(endpoint, apiKey, payload) {
  const p = { ...payload };
  if (!p.e) p.e = "LINK_CLICK";

  const encoded = toBase64Url(encoder.encode(JSON.stringify(p)));
  const sig = await signPayload(apiKey, p);
  return `${endpoint}/r/${encoded}?sig=${sig}`;
}

const URL_RE = /https?:\/\/[^\s"'<>)\]]+/g;

/**
 * Scan text for URLs and rewrite each as a tracked redirect URL.
 *
 * URLs already pointing at the TES redirect endpoint are left untouched.
 *
 * @param {string} text       Text (typically an LLM response) to scan
 * @param {object} config     { endpoint, apiKey, clientId }
 * @param {string} sessionId  Current session ID
 * @param {object} [metadata] Optional attributes merged into payload.a
 * @returns {Promise<string>} Text with URLs replaced
 */
export async function rewriteUrls(text, config, sessionId, metadata) {
  if (!text) return text;

  const redirectPrefix = `${config.endpoint}/r/`;
  const matches = [...text.matchAll(URL_RE)];

  if (matches.length === 0) return text;

  // Build tracked URLs for each unique original URL (preserving order)
  const replacements = new Map();
  for (const m of matches) {
    const originalUrl = m[0];
    if (originalUrl.startsWith(redirectPrefix)) continue;
    if (replacements.has(originalUrl)) continue;

    const payload = {
      u: originalUrl,
      s: sessionId,
      c: config.clientId,
      t: Math.floor(Date.now() / 1000),
    };
    if (metadata && Object.keys(metadata).length > 0) {
      payload.a = metadata;
    }

    const trackUrl = await buildTrackUrl(config.endpoint, config.apiKey, payload);
    replacements.set(originalUrl, trackUrl);
  }

  // Replace URLs in text (longest-first to avoid partial matches)
  let result = text;
  const sorted = [...replacements.entries()].sort((a, b) => b[0].length - a[0].length);
  for (const [original, tracked] of sorted) {
    result = result.split(original).join(tracked);
  }

  return result;
}
