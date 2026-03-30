"""
HMAC signing and URL rewriting utilities for click tracking.

Uses the stdlib hmac/hashlib modules (sync, no async needed).
"""

import base64
import hashlib
import hmac
import json
import math
import re
import time


def _to_base64url(data: bytes) -> str:
    """Encode bytes to base64url (RFC 4648 section 5) with no padding."""
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def sign_payload(secret: str, payload: dict) -> str:
    """
    HMAC-SHA256 sign a JSON payload, returning a base64url signature.

    Args:
        secret:  Shared secret (e.g. TES API key)
        payload: Object to sign (serialised to canonical JSON)

    Returns:
        base64url HMAC signature string
    """
    data = json.dumps(payload, separators=(",", ":"), sort_keys=False).encode("utf-8")
    sig = hmac.new(secret.encode("utf-8"), data, hashlib.sha256).digest()
    return _to_base64url(sig)


def verify_payload(secret: str, payload: dict, signature: str) -> bool:
    """
    Verify a payload against a base64url HMAC-SHA256 signature.

    Args:
        secret:    Shared secret
        payload:   Payload object
        signature: base64url signature to verify

    Returns:
        True if signature matches
    """
    expected = sign_payload(secret, payload)
    return hmac.compare_digest(expected, signature)


def build_track_url(endpoint: str, api_key: str, payload: dict) -> str:
    """
    Build a TES redirect/tracking URL.

    Args:
        endpoint: TES API base URL (no trailing slash)
        api_key:  Shared secret for signing
        payload:  Tracking payload with short keys (u, s, c, t, e, a)

    Returns:
        Full redirect URL string
    """
    p = dict(payload)
    if not p.get("e"):
        p["e"] = "LINK_CLICK"

    encoded = _to_base64url(json.dumps(p, separators=(",", ":")).encode("utf-8"))
    sig = sign_payload(api_key, p)
    return f"{endpoint}/r/{encoded}?sig={sig}"


_URL_RE = re.compile(r"https?://[^\s\"'<>)\]]+")


def rewrite_urls(text: str, config: dict, session_id: str, metadata: dict = None) -> str:
    """
    Scan text for URLs and rewrite each as a tracked redirect URL.

    URLs already pointing at the TES redirect endpoint are left untouched.

    Args:
        text:       Text (typically an LLM response) to scan
        config:     dict with keys: endpoint, api_key (or apiKey), client_id (or clientId)
        session_id: Current session ID
        metadata:   Optional attributes merged into payload.a

    Returns:
        Text with URLs replaced by tracked redirect URLs
    """
    if not text:
        return text

    # Support both snake_case and camelCase config keys
    endpoint = config.get("endpoint", "")
    api_key = config.get("api_key") or config.get("apiKey", "")
    client_id = config.get("client_id") or config.get("clientId", "")

    redirect_prefix = f"{endpoint}/r/"
    matches = list(_URL_RE.finditer(text))

    if not matches:
        return text

    # Build tracked URLs for each unique original URL (preserving order)
    replacements = {}
    for m in matches:
        original_url = m.group(0)
        if original_url.startswith(redirect_prefix):
            continue
        if original_url in replacements:
            continue

        payload = {
            "u": original_url,
            "s": session_id,
            "c": client_id,
            "t": math.floor(time.time()),
        }
        if metadata and len(metadata) > 0:
            payload["a"] = metadata

        track_url = build_track_url(endpoint, api_key, payload)
        replacements[original_url] = track_url

    # Replace URLs in text (longest-first to avoid partial matches)
    result = text
    sorted_replacements = sorted(replacements.items(), key=lambda x: len(x[0]), reverse=True)
    for original, tracked in sorted_replacements:
        result = result.replace(original, tracked)

    return result
