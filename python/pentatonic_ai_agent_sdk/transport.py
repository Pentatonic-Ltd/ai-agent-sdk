import json
from urllib.request import Request, urlopen

CREATE_MODULE_EVENT_MUTATION = """
  mutation CreateModuleEvent($moduleId: String!, $input: ModuleEventInput!) {
    createModuleEvent(moduleId: $moduleId, input: $input) {
      success
      eventId
    }
  }
"""


def send_event(config, event_input):
    endpoint = config["endpoint"]
    api_key = config["api_key"]
    client_id = config["client_id"]
    extra_headers = config.get("headers") or {}

    if api_key.startswith("tes_"):
        auth_headers = {"Authorization": f"Bearer {api_key}"}
    else:
        auth_headers = {"x-service-key": api_key}

    headers = {
        "Content-Type": "application/json",
        "x-client-id": client_id,
        **extra_headers,
        **auth_headers,
    }

    user_id = config.get("user_id")
    attributes = event_input.get("data", {}).get("attributes", {})
    if user_id:
        attributes = {**attributes, "userId": user_id}

    # Route to the correct module based on event type
    event_type = event_input.get("eventType", "")
    module_id = "conversation-analytics"
    if event_type in ("STORE_MEMORY", "SESSION_START", "SESSION_END"):
        module_id = "deep-memory"

    module_input = {
        "eventType": event_type,
        "data": {
            "entity_id": event_input.get("data", {}).get("entity_id", event_input.get("entityId", "")),
            "attributes": {
                **attributes,
                "clientId": client_id,
            },
        },
    }

    body = json.dumps({
        "query": CREATE_MODULE_EVENT_MUTATION,
        "variables": {"moduleId": module_id, "input": module_input},
    }).encode()

    req = Request(f"{endpoint}/api/graphql", data=body, headers=headers, method="POST")

    with urlopen(req, timeout=10) as resp:
        data = json.loads(resp.read())

    if data.get("errors"):
        raise RuntimeError(f"TES GraphQL error: {data['errors'][0]['message']}")

    return data["data"]["createModuleEvent"]
