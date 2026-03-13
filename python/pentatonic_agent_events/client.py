import re
from .session import Session
from .wrapper import wrap_client


class TESClient:
    def __init__(self, client_id, api_key, endpoint, headers=None, capture_content=True, max_content_length=4096):
        if not client_id:
            raise ValueError("client_id is required")
        if not api_key:
            raise ValueError("api_key is required")
        if not endpoint:
            raise ValueError("endpoint is required")

        clean_endpoint = endpoint.rstrip("/")
        is_local = bool(
            re.match(r"^http://localhost(:\d+)?(/|$)", clean_endpoint)
            or re.match(r"^http://127\.0\.0\.1(:\d+)?(/|$)", clean_endpoint)
        )
        if not clean_endpoint.startswith("https://") and not is_local:
            raise ValueError("endpoint must use https:// (http:// is only allowed for localhost)")

        self.client_id = client_id
        self.endpoint = clean_endpoint
        self.capture_content = capture_content
        self.max_content_length = max_content_length
        self._api_key = api_key
        self._headers = headers or {}

    @property
    def _config(self):
        return {
            "client_id": self.client_id,
            "api_key": self._api_key,
            "endpoint": self.endpoint,
            "headers": self._headers,
            "capture_content": self.capture_content,
            "max_content_length": self.max_content_length,
        }

    def session(self, session_id=None, metadata=None):
        return Session(self._config, session_id=session_id, metadata=metadata)

    def wrap(self, client):
        return wrap_client(self._config, client)

    def __repr__(self):
        return f"TESClient(client_id={self.client_id!r}, endpoint={self.endpoint!r})"
