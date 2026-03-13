const EMIT_EVENT_MUTATION = `
  mutation EmitEvent($input: EventInput!) {
    emitEvent(input: $input) {
      success
      eventId
      message
    }
  }
`;

export async function sendEvent({ endpoint, apiKey, clientId, headers }, input, fetchFn) {
  const f = fetchFn || globalThis.fetch;

  // tes_ prefixed tokens are API tokens — send as Authorization: Bearer
  // Other tokens (internal service keys) go as x-service-key
  const authHeaders = apiKey.startsWith("tes_")
    ? { Authorization: `Bearer ${apiKey}` }
    : { "x-service-key": apiKey };

  const response = await f(`${endpoint}/api/graphql`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-client-id": clientId,
      ...headers,
      ...authHeaders,
    },
    body: JSON.stringify({
      query: EMIT_EVENT_MUTATION,
      variables: { input },
    }),
  });

  if (!response.ok) {
    throw new Error(`TES API error: ${response.status}`);
  }

  const json = await response.json();
  if (json.errors?.length) {
    throw new Error(`TES GraphQL error: ${json.errors[0].message}`);
  }

  return json.data.emitEvent;
}
