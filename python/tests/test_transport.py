import json
from unittest.mock import patch, MagicMock
from pentatonic_ai_agent_sdk.transport import send_event


def _mock_response(data, status=200):
    resp = MagicMock()
    resp.status = status
    resp.read.return_value = json.dumps(data).encode()
    resp.__enter__ = MagicMock(return_value=resp)
    resp.__exit__ = MagicMock(return_value=False)
    return resp


class TestSendEvent:
    def test_sends_graphql_mutation_with_bearer_auth(self):
        config = {
            "endpoint": "https://api.test.com",
            "api_key": "tes_sk_test123",
            "client_id": "test-client",
            "headers": {},
        }
        event_input = {
            "eventType": "CHAT_TURN",
            "entityType": "conversation",
            "data": {"entity_id": "sess-1", "attributes": {"model": "gpt-4o"}},
        }
        mock_resp = _mock_response({
            "data": {"createModuleEvent": {"success": True, "eventId": "evt-1"}}
        })

        with patch("pentatonic_ai_agent_sdk.transport.urlopen", return_value=mock_resp) as mock_urlopen:
            result = send_event(config, event_input)

        assert result == {"success": True, "eventId": "evt-1"}

        call_args = mock_urlopen.call_args
        req = call_args[0][0]
        assert req.full_url == "https://api.test.com/api/graphql"
        assert req.get_header("Authorization") == "Bearer tes_sk_test123"
        assert req.get_header("X-client-id") == "test-client"
        assert req.get_header("Content-type") == "application/json"

        body = json.loads(req.data)
        assert "createModuleEvent" in body["query"]
        assert body["variables"]["moduleId"] == "conversation-analytics"
        assert body["variables"]["input"]["eventType"] == "CHAT_TURN"

    def test_sends_service_key_for_non_tes_tokens(self):
        config = {
            "endpoint": "https://api.test.com",
            "api_key": "internal_key_abc",
            "client_id": "test-client",
            "headers": {},
        }
        mock_resp = _mock_response({
            "data": {"createModuleEvent": {"success": True, "eventId": "evt-2"}}
        })

        with patch("pentatonic_ai_agent_sdk.transport.urlopen", return_value=mock_resp) as mock_urlopen:
            send_event(config, {"eventType": "CHAT_TURN"})

        req = mock_urlopen.call_args[0][0]
        assert req.get_header("X-service-key") == "internal_key_abc"
        assert req.get_header("Authorization") is None

    def test_routes_memory_events_to_deep_memory_module(self):
        config = {
            "endpoint": "https://api.test.com",
            "api_key": "tes_sk_test",
            "client_id": "c",
            "headers": {},
        }
        mock_resp = _mock_response({
            "data": {"createModuleEvent": {"success": True, "eventId": "evt-3"}}
        })

        with patch("pentatonic_ai_agent_sdk.transport.urlopen", return_value=mock_resp) as mock_urlopen:
            send_event(config, {"eventType": "STORE_MEMORY", "data": {"entity_id": "s1", "attributes": {}}})

        body = json.loads(mock_urlopen.call_args[0][0].data)
        assert body["variables"]["moduleId"] == "deep-memory"

    def test_routes_chat_events_to_conversation_analytics(self):
        config = {
            "endpoint": "https://api.test.com",
            "api_key": "tes_sk_test",
            "client_id": "c",
            "headers": {},
        }
        mock_resp = _mock_response({
            "data": {"createModuleEvent": {"success": True, "eventId": "evt-4"}}
        })

        with patch("pentatonic_ai_agent_sdk.transport.urlopen", return_value=mock_resp) as mock_urlopen:
            send_event(config, {"eventType": "CHAT_TURN", "data": {"entity_id": "s1", "attributes": {}}})

        body = json.loads(mock_urlopen.call_args[0][0].data)
        assert body["variables"]["moduleId"] == "conversation-analytics"

    def test_includes_custom_headers(self):
        config = {
            "endpoint": "https://api.test.com",
            "api_key": "tes_sk_test",
            "client_id": "c",
            "headers": {"X-Custom": "value"},
        }
        mock_resp = _mock_response({
            "data": {"createModuleEvent": {"success": True, "eventId": "evt-5"}}
        })

        with patch("pentatonic_ai_agent_sdk.transport.urlopen", return_value=mock_resp) as mock_urlopen:
            send_event(config, {"eventType": "CHAT_TURN"})

        req = mock_urlopen.call_args[0][0]
        assert req.get_header("X-custom") == "value"

    def test_raises_on_http_error(self):
        config = {
            "endpoint": "https://api.test.com",
            "api_key": "tes_sk_test",
            "client_id": "c",
            "headers": {},
        }

        from urllib.error import HTTPError
        import io

        with patch("pentatonic_ai_agent_sdk.transport.urlopen") as mock_urlopen:
            mock_urlopen.side_effect = HTTPError(
                "https://api.test.com/api/graphql", 500, "Internal Server Error",
                {}, io.BytesIO(b"error")
            )
            try:
                send_event(config, {"eventType": "CHAT_TURN"})
                assert False, "Should have raised"
            except Exception as e:
                assert "500" in str(e) or "Internal Server Error" in str(e)

    def test_raises_on_graphql_error(self):
        config = {
            "endpoint": "https://api.test.com",
            "api_key": "tes_sk_test",
            "client_id": "c",
            "headers": {},
        }
        mock_resp = _mock_response({
            "errors": [{"message": "Invalid input"}]
        })

        with patch("pentatonic_ai_agent_sdk.transport.urlopen", return_value=mock_resp):
            try:
                send_event(config, {"eventType": "CHAT_TURN"})
                assert False, "Should have raised"
            except Exception as e:
                assert "Invalid input" in str(e)
