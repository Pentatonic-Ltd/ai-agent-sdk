/**
 * Memory injection — formats retrieved memories as a system-message preamble
 * and merges them into the upstream request body.
 *
 * Why a preamble (not a separate user-turn or tool-result):
 *   - Customer's existing system prompt is preserved verbatim, just appended.
 *   - Anthropic and OpenAI both treat system content as cache-friendly.
 *   - No conversation-history mutation — replays remain reproducible.
 *
 * Format:
 *   <tes:context>
 *     [1] (similarity 0.82) memory text...
 *     [2] (similarity 0.71) memory text...
 *   </tes:context>
 *
 * The XML-ish wrapper makes it trivial for the model to ignore on demand
 * and trivial for an evaluator to strip when measuring quality deltas.
 */

const MAX_CHARS_PER_MEMORY = 1200;

/**
 * @param {object} body                 — upstream request body, mutated copy returned
 * @param {Array<{id, content, similarity}>} memories
 * @param {"anthropic"|"openai"} provider
 * @returns {object} new body
 */
export function injectMemories(body, memories, provider) {
  if (!memories || memories.length === 0) return body;

  const preamble = formatPreamble(memories);

  if (provider === "anthropic") {
    return injectAnthropic(body, preamble);
  }
  return injectOpenAI(body, preamble);
}

function formatPreamble(memories) {
  const lines = ["<tes:context>"];
  memories.forEach((m, i) => {
    const sim =
      typeof m.similarity === "number" ? m.similarity.toFixed(2) : "?";
    const content = (m.content || "").slice(0, MAX_CHARS_PER_MEMORY);
    lines.push(`[${i + 1}] (similarity ${sim}) ${content}`);
  });
  lines.push("</tes:context>");
  return lines.join("\n");
}

function injectAnthropic(body, preamble) {
  // Anthropic accepts `system` as either a string OR an array of content
  // blocks. Preserve whichever shape the customer sent.
  const next = { ...body };
  if (typeof body.system === "string") {
    next.system = `${preamble}\n\n${body.system}`;
  } else if (Array.isArray(body.system)) {
    next.system = [{ type: "text", text: preamble }, ...body.system];
  } else {
    next.system = preamble;
  }
  return next;
}

function injectOpenAI(body, preamble) {
  // OpenAI carries the system prompt as the first message with role:'system'.
  // If one exists we prepend; otherwise we insert a fresh one at index 0.
  const messages = Array.isArray(body.messages) ? [...body.messages] : [];
  if (messages.length > 0 && messages[0].role === "system") {
    const existing = messages[0];
    const existingContent =
      typeof existing.content === "string"
        ? existing.content
        : JSON.stringify(existing.content);
    messages[0] = {
      ...existing,
      content: `${preamble}\n\n${existingContent}`,
    };
  } else {
    messages.unshift({ role: "system", content: preamble });
  }
  return { ...body, messages };
}
