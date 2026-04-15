const CREATE_MODULE_EVENT_MUTATION = `
  mutation CreateModuleEvent($moduleId: String!, $input: ModuleEventInput!) {
    createModuleEvent(moduleId: $moduleId, input: $input) {
      success
      eventId
    }
  }
`;

// Route event types to the correct module
function getModuleId(eventType) {
  if (["STORE_MEMORY", "SESSION_START", "SESSION_END"].includes(eventType)) {
    return "deep-memory";
  }
  return "conversation-analytics";
}

export async function sendEvent({ endpoint, apiKey, clientId, userId, headers }, input, fetchFn) {
  const f = fetchFn || globalThis.fetch;

  const authHeaders = apiKey.startsWith("tes_")
    ? { Authorization: `Bearer ${apiKey}` }
    : { "x-service-key": apiKey };

  const moduleId = getModuleId(input.eventType);
  const attributes = {
    ...input.data?.attributes,
    clientId,
    ...(userId ? { userId } : {}),
  };

  const moduleInput = {
    eventType: input.eventType,
    data: {
      entity_id: input.data?.entity_id || input.entityId || "",
      attributes,
    },
  };

  const response = await f(`${endpoint}/api/graphql`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-client-id": clientId,
      ...headers,
      ...authHeaders,
    },
    body: JSON.stringify({
      query: CREATE_MODULE_EVENT_MUTATION,
      variables: { moduleId, input: moduleInput },
    }),
  });

  if (!response.ok) {
    throw new Error(`TES API error: ${response.status}`);
  }

  const json = await response.json();
  if (json.errors?.length) {
    throw new Error(`TES GraphQL error: ${json.errors[0].message}`);
  }

  return json.data.createModuleEvent;
}
