import json
from urllib.request import Request, urlopen

EMIT_EVENT_MUTATION = """
  mutation EmitEvent($input: EventInput!) {
    emitEvent(input: $input) {
      success
      eventId
      message
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
        **auth_headers,
        **extra_headers,
    }

    body = json.dumps({
        "query": EMIT_EVENT_MUTATION,
        "variables": {"input": event_input},
    }).encode()

    req = Request(f"{endpoint}/api/graphql", data=body, headers=headers, method="POST")

    with urlopen(req) as resp:
        data = json.loads(resp.read())

    if data.get("errors"):
        raise RuntimeError(f"TES GraphQL error: {data['errors'][0]['message']}")

    return data["data"]["emitEvent"]
