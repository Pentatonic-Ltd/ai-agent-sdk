import json
import base64
from pentatonic_agent_events.tracking import (
    sign_payload,
    verify_payload,
    build_track_url,
    rewrite_urls,
    _to_base64url,
)


class TestSignPayload:
    def test_returns_base64url_string(self):
        sig = sign_payload("my-secret", {"hello": "world"})
        assert isinstance(sig, str)
        assert len(sig) > 0
        # base64url has no +, /, or = chars
        assert "+" not in sig
        assert "/" not in sig
        assert "=" not in sig

    def test_deterministic(self):
        payload = {"foo": "bar", "n": 42}
        sig1 = sign_payload("secret", payload)
        sig2 = sign_payload("secret", payload)
        assert sig1 == sig2

    def test_different_secrets_produce_different_sigs(self):
        payload = {"data": "test"}
        sig1 = sign_payload("secret-a", payload)
        sig2 = sign_payload("secret-b", payload)
        assert sig1 != sig2

    def test_different_payloads_produce_different_sigs(self):
        sig1 = sign_payload("secret", {"a": 1})
        sig2 = sign_payload("secret", {"a": 2})
        assert sig1 != sig2


class TestVerifyPayload:
    def test_verifies_valid_signature(self):
        payload = {"url": "https://example.com", "session": "abc"}
        sig = sign_payload("my-key", payload)
        assert verify_payload("my-key", payload, sig) is True

    def test_rejects_wrong_signature(self):
        payload = {"url": "https://example.com"}
        assert verify_payload("my-key", payload, "wrong-sig") is False

    def test_rejects_wrong_secret(self):
        payload = {"url": "https://example.com"}
        sig = sign_payload("correct-key", payload)
        assert verify_payload("wrong-key", payload, sig) is False

    def test_rejects_tampered_payload(self):
        payload = {"url": "https://example.com"}
        sig = sign_payload("my-key", payload)
        tampered = {"url": "https://evil.com"}
        assert verify_payload("my-key", tampered, sig) is False


class TestBuildTrackUrl:
    def test_builds_valid_url(self):
        url = build_track_url("https://api.tes.com", "key123", {
            "u": "https://example.com",
            "s": "sess-1",
            "c": "client-1",
            "t": 1700000000,
        })
        assert url.startswith("https://api.tes.com/r/")
        assert "?sig=" in url

    def test_adds_default_event_type(self):
        url = build_track_url("https://api.tes.com", "key123", {
            "u": "https://example.com",
            "s": "sess-1",
        })
        # Decode the base64url portion to check the payload
        encoded = url.split("/r/")[1].split("?")[0]
        # Add back padding
        padded = encoded + "=" * (4 - len(encoded) % 4) if len(encoded) % 4 else encoded
        decoded = json.loads(base64.urlsafe_b64decode(padded))
        assert decoded["e"] == "LINK_CLICK"

    def test_preserves_existing_event_type(self):
        url = build_track_url("https://api.tes.com", "key123", {
            "u": "https://example.com",
            "s": "sess-1",
            "e": "CUSTOM_EVENT",
        })
        encoded = url.split("/r/")[1].split("?")[0]
        padded = encoded + "=" * (4 - len(encoded) % 4) if len(encoded) % 4 else encoded
        decoded = json.loads(base64.urlsafe_b64decode(padded))
        assert decoded["e"] == "CUSTOM_EVENT"

    def test_signature_is_verifiable(self):
        payload = {
            "u": "https://example.com",
            "s": "sess-1",
            "c": "client-1",
            "t": 1700000000,
        }
        url = build_track_url("https://api.tes.com", "key123", payload)
        sig = url.split("?sig=")[1]
        # The payload that was signed includes the default "e" key
        expected_payload = {**payload, "e": "LINK_CLICK"}
        assert verify_payload("key123", expected_payload, sig) is True


class TestRewriteUrls:
    def test_rewrites_single_url(self):
        text = "Check out https://example.com/shoes for deals!"
        config = {"endpoint": "https://api.tes.com", "api_key": "key123", "client_id": "c1"}
        result = rewrite_urls(text, config, "sess-1")
        assert "https://api.tes.com/r/" in result
        assert "?sig=" in result
        assert "https://example.com/shoes" not in result

    def test_rewrites_multiple_urls(self):
        text = "Visit https://a.com and https://b.com"
        config = {"endpoint": "https://api.tes.com", "api_key": "key123", "client_id": "c1"}
        result = rewrite_urls(text, config, "sess-1")
        assert result.count("https://api.tes.com/r/") == 2

    def test_skips_already_tracked_urls(self):
        text = "Already tracked: https://api.tes.com/r/abc123?sig=xyz"
        config = {"endpoint": "https://api.tes.com", "api_key": "key123", "client_id": "c1"}
        result = rewrite_urls(text, config, "sess-1")
        assert result == text

    def test_returns_empty_text_unchanged(self):
        config = {"endpoint": "https://api.tes.com", "api_key": "key123", "client_id": "c1"}
        assert rewrite_urls("", config, "sess-1") == ""
        assert rewrite_urls(None, config, "sess-1") is None

    def test_returns_text_without_urls_unchanged(self):
        text = "No URLs here, just plain text."
        config = {"endpoint": "https://api.tes.com", "api_key": "key123", "client_id": "c1"}
        assert rewrite_urls(text, config, "sess-1") == text

    def test_includes_metadata_in_payload(self):
        text = "Visit https://example.com"
        config = {"endpoint": "https://api.tes.com", "api_key": "key123", "client_id": "c1"}
        result = rewrite_urls(text, config, "sess-1", metadata={"shop": "test.myshopify.com"})
        # Extract and decode the payload
        encoded = result.split("/r/")[1].split("?")[0]
        padded = encoded + "=" * (4 - len(encoded) % 4) if len(encoded) % 4 else encoded
        decoded = json.loads(base64.urlsafe_b64decode(padded))
        assert decoded["a"]["shop"] == "test.myshopify.com"

    def test_supports_camelcase_config_keys(self):
        text = "Visit https://example.com"
        config = {"endpoint": "https://api.tes.com", "apiKey": "key123", "clientId": "c1"}
        result = rewrite_urls(text, config, "sess-1")
        assert "https://api.tes.com/r/" in result

    def test_deduplicates_same_url(self):
        text = "Visit https://example.com and again https://example.com"
        config = {"endpoint": "https://api.tes.com", "api_key": "key123", "client_id": "c1"}
        result = rewrite_urls(text, config, "sess-1")
        # Both occurrences should be replaced with the same tracked URL
        tracked_urls = [u for u in result.split() if u.startswith("https://api.tes.com/r/")]
        assert len(tracked_urls) == 2
        # Strip trailing punctuation-like chars for comparison
        assert tracked_urls[0] == tracked_urls[1]
