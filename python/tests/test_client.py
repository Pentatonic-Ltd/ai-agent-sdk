import pytest
from pentatonic_agent_events.client import TESClient


class TestTESClientConstructor:
    def test_requires_client_id(self):
        with pytest.raises(ValueError, match="client_id is required"):
            TESClient(client_id="", api_key="k", endpoint="https://api.test.com")

    def test_requires_api_key(self):
        with pytest.raises(ValueError, match="api_key is required"):
            TESClient(client_id="c", api_key="", endpoint="https://api.test.com")

    def test_requires_endpoint(self):
        with pytest.raises(ValueError, match="endpoint is required"):
            TESClient(client_id="c", api_key="k", endpoint="")

    def test_rejects_non_https_endpoint(self):
        with pytest.raises(ValueError, match="endpoint must use https://"):
            TESClient(client_id="c", api_key="k", endpoint="http://evil.com")

    def test_allows_http_localhost(self):
        tes = TESClient(client_id="c", api_key="k", endpoint="http://localhost:8788")
        assert tes.endpoint == "http://localhost:8788"

    def test_allows_http_127_0_0_1(self):
        tes = TESClient(client_id="c", api_key="k", endpoint="http://127.0.0.1:8788")
        assert tes.endpoint == "http://127.0.0.1:8788"

    def test_strips_trailing_slash(self):
        tes = TESClient(client_id="c", api_key="k", endpoint="https://api.test.com/")
        assert tes.endpoint == "https://api.test.com"

    def test_api_key_not_in_repr_or_str(self):
        tes = TESClient(client_id="c", api_key="secret-key", endpoint="https://api.test.com")
        assert "secret-key" not in repr(tes)
        assert "secret-key" not in str(tes)

    def test_config_includes_all_fields(self):
        tes = TESClient(
            client_id="c",
            api_key="secret-key",
            endpoint="https://api.test.com",
            headers={"X-Custom": "val"},
            capture_content=False,
            max_content_length=2048,
        )
        config = tes._config
        assert config["client_id"] == "c"
        assert config["api_key"] == "secret-key"
        assert config["endpoint"] == "https://api.test.com"
        assert config["headers"] == {"X-Custom": "val"}
        assert config["capture_content"] is False
        assert config["max_content_length"] == 2048


class TestTESClientSession:
    def test_creates_session(self):
        tes = TESClient(client_id="c", api_key="k", endpoint="https://api.test.com")
        session = tes.session(session_id="sess-1")
        assert session.session_id == "sess-1"

    def test_creates_session_with_auto_id(self):
        tes = TESClient(client_id="c", api_key="k", endpoint="https://api.test.com")
        session = tes.session()
        assert session.session_id is not None
        assert len(session.session_id) > 0

    def test_creates_session_with_metadata(self):
        tes = TESClient(client_id="c", api_key="k", endpoint="https://api.test.com")
        session = tes.session(session_id="sess-2", metadata={"user_id": "u_1"})
        assert session._metadata == {"user_id": "u_1"}
