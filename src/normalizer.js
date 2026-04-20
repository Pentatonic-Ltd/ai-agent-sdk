/**
 * Normalize an LLM response from any supported provider into a common shape.
 * Detects format by duck-typing: OpenAI (choices), Anthropic (content array), Workers AI (response string).
 */
export function normalizeResponse(raw) {
  if (!raw || typeof raw !== "object") {
    return empty();
  }

  // OpenAI SDK format: { choices, usage, model }
  if (Array.isArray(raw.choices)) {
    return normalizeOpenAI(raw);
  }

  // Anthropic SDK format: { content: [{ type: "text"|"tool_use", ... }], usage: { input_tokens, output_tokens } }
  if (Array.isArray(raw.content) && raw.content[0]?.type) {
    return normalizeAnthropic(raw);
  }

  // Workers AI format: { response: "...", tool_calls: [...] }
  if (typeof raw.response === "string" || (raw.tool_calls && !raw.choices)) {
    return normalizeWorkersAI(raw);
  }

  return empty();
}

function empty() {
  return {
    content: "",
    model: null,
    usage: { prompt_tokens: 0, completion_tokens: 0 },
    toolCalls: [],
  };
}

// Anthropic-only. The conversation-analytics Token Universe tab stacks
// cache_read / cache_create alongside input / output, so we pass them
// through whenever the provider supplies them. Other providers omit
// these keys silently.
function extractCacheUsage(usage) {
  const out = {};
  if (typeof usage.cache_read_input_tokens === "number") {
    out.cache_read_input_tokens = usage.cache_read_input_tokens;
  }
  if (typeof usage.cache_creation_input_tokens === "number") {
    out.cache_creation_input_tokens = usage.cache_creation_input_tokens;
  }
  return out;
}

function normalizeOpenAI(raw) {
  const message = raw.choices?.[0]?.message || {};
  const usage = raw.usage || {};
  // Workers AI sometimes puts tool_calls at top level instead of inside message
  const rawToolCalls = message.tool_calls?.length
    ? message.tool_calls
    : raw.tool_calls || [];
  const toolCalls = rawToolCalls.map((tc) => ({
    tool: tc.function?.name || tc.name,
    args: parseArgs(tc.function?.arguments || tc.arguments),
  }));

  return {
    content: message.content || "",
    model: raw.model || null,
    usage: {
      prompt_tokens: usage.prompt_tokens || 0,
      completion_tokens: usage.completion_tokens || 0,
    },
    toolCalls,
  };
}

function normalizeAnthropic(raw) {
  const usage = raw.usage || {};
  let content = "";
  const toolCalls = [];

  for (const block of raw.content) {
    if (block.type === "text") {
      content += block.text;
    } else if (block.type === "tool_use") {
      toolCalls.push({ tool: block.name, args: block.input || {} });
    }
  }

  return {
    content,
    model: raw.model || null,
    usage: {
      prompt_tokens: usage.input_tokens || 0,
      completion_tokens: usage.output_tokens || 0,
      ...extractCacheUsage(usage),
    },
    toolCalls,
  };
}

function normalizeWorkersAI(raw) {
  const usage = raw.usage || {};
  const toolCalls = (raw.tool_calls || []).map((tc) => ({
    tool: tc.function?.name || tc.name,
    args: parseArgs(tc.function?.arguments || tc.arguments || {}),
  }));

  return {
    content: raw.response || "",
    model: raw.model || null,
    usage: {
      prompt_tokens: usage.prompt_tokens || 0,
      completion_tokens: usage.completion_tokens || 0,
    },
    toolCalls,
  };
}

function parseArgs(args) {
  if (typeof args === "string") {
    try {
      return JSON.parse(args);
    } catch {
      return {};
    }
  }
  return args || {};
}
