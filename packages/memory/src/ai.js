/**
 * OpenAI-compatible AI client for embeddings and chat completions.
 *
 * Works with: Ollama, vLLM, LiteLLM, OpenAI, Pentatonic AI Gateway,
 * or any endpoint that implements the OpenAI API spec.
 */

/**
 * Create an AI client from config.
 *
 * Defaults to OpenAI-standard paths (`/embeddings`, `/chat/completions`).
 * Override with `embeddingPath` / `chatPath` for gateways that use
 * different routes — e.g. Pentatonic AI Gateway exposes `/embed`.
 *
 * @param {object} config
 * @param {string} config.url - Base URL (e.g. "http://ollama:11434/v1")
 * @param {string} config.model - Model name
 * @param {string} [config.apiKey] - Optional API key
 * @param {string} [config.embeddingPath="embeddings"] - Path appended to url
 * @param {string} [config.chatPath="chat/completions"] - Path appended to url
 * @param {number} [config.dimensions] - Expected embedding dimensions
 * @returns {object} Client with embed() and chat() methods
 */
export function createAIClient(config) {
  const headers = { "Content-Type": "application/json" };
  if (config.apiKey) {
    headers["Authorization"] = `Bearer ${config.apiKey}`;
    headers["X-API-Key"] = config.apiKey;
  }

  // Strip leading slashes so callers can use "embed" or "/embed"
  // interchangeably. Base url may or may not have a trailing slash.
  // Plain loops (not regex) to avoid polynomial-regex scanner flags.
  const stripLeading = (s) => {
    let i = 0;
    while (i < s.length && s[i] === "/") i++;
    return i === 0 ? s : s.slice(i);
  };
  const stripTrailing = (s) => {
    let i = s.length;
    while (i > 0 && s[i - 1] === "/") i--;
    return i === s.length ? s : s.slice(0, i);
  };
  const embeddingPath = stripLeading(config.embeddingPath || "embeddings");
  const chatPath = stripLeading(config.chatPath || "chat/completions");
  const baseUrl = stripTrailing(config.url);

  return {
    /**
     * Generate an embedding vector for text.
     *
     * @param {string} text - Text to embed
     * @param {string} [inputType="passage"] - "query" or "passage"
     * @returns {Promise<{embedding: number[], dimensions: number, model: string} | null>}
     */
    async embed(text, inputType = "passage") {
      try {
        const res = await fetch(`${baseUrl}/${embeddingPath}`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            input: [text.substring(0, 8192)],
            model: config.model,
            input_type: inputType,
          }),
          signal: AbortSignal.timeout(30000),
        });

        if (!res.ok) return null;

        const data = await res.json();
        const embedding = data.data?.[0]?.embedding || data.embeddings?.[0];
        if (!embedding) return null;

        return {
          embedding,
          dimensions: embedding.length,
          model: config.model,
        };
      } catch {
        return null;
      }
    },

    /**
     * Generate a chat completion.
     *
     * @param {Array<{role: string, content: string}>} messages
     * @param {object} [opts]
     * @param {number} [opts.maxTokens=150]
     * @param {number} [opts.temperature=0.7]
     * @returns {Promise<string>} The assistant's response text
     */
    async chat(messages, opts = {}) {
      try {
        const res = await fetch(`${baseUrl}/${chatPath}`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: config.model,
            messages,
            max_tokens: opts.maxTokens || 150,
            temperature: opts.temperature ?? 0.7,
          }),
          signal: AbortSignal.timeout(opts.timeout || 15000),
        });

        if (!res.ok) return "";

        const data = await res.json();
        return data.choices?.[0]?.message?.content?.trim() || "";
      } catch {
        return "";
      }
    },
  };
}
