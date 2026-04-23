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

  /**
   * Send an embedding request with N inputs. Shared by embed() and
   * embedBatch(). Returns an array of { embedding, dimensions, model } or
   * nulls (one per input, preserving order).
   */
  async function rawEmbed(texts, inputType) {
    if (!texts.length) return [];
    try {
      const res = await fetch(`${baseUrl}/${embeddingPath}`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          input: texts.map((t) => (t ?? "").substring(0, 8192)),
          model: config.model,
          input_type: inputType,
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) return texts.map(() => null);
      const data = await res.json();
      // OpenAI-compat: data.data = [{embedding, index}, ...]
      // Pentatonic gateway / Ollama: data.embeddings = [[...], [...], ...]
      const vectors =
        data.data?.map((d) => d.embedding) || data.embeddings || [];
      return texts.map((_, i) => {
        const embedding = vectors[i];
        if (!embedding) return null;
        return { embedding, dimensions: embedding.length, model: config.model };
      });
    } catch {
      return texts.map(() => null);
    }
  }

  return {
    /**
     * Generate an embedding vector for text.
     *
     * @param {string} text - Text to embed
     * @param {string} [inputType="passage"] - "query" or "passage"
     * @returns {Promise<{embedding: number[], dimensions: number, model: string} | null>}
     */
    async embed(text, inputType = "passage") {
      const results = await rawEmbed([text], inputType);
      return results[0];
    },

    /**
     * Generate embeddings for N texts in a single HTTP round-trip. Returns
     * an array the same length as the input; each entry is either the
     * embedding object or null on failure.
     *
     * Batching matters under load — one call instead of N cuts GPU overhead
     * and downstream queueing. Used by distill() to embed all atoms from a
     * raw memory in one shot rather than N serial calls.
     *
     * @param {string[]} texts
     * @param {string} [inputType="passage"]
     * @returns {Promise<Array<{embedding: number[], dimensions: number, model: string} | null>>}
     */
    async embedBatch(texts, inputType = "passage") {
      return rawEmbed(texts, inputType);
    },

    /**
     * Generate a chat completion.
     *
     * @param {Array<{role: string, content: string}>} messages
     * @param {object} [opts]
     * @param {number} [opts.maxTokens=150]
     * @param {number} [opts.temperature=0.7]
     * @param {number} [opts.timeout=60000] - Defaults 60s. Longer chunks +
     *   smaller/local models routinely exceed 15s; 60s keeps distill/HyDE
     *   reliable on prod-class content without catching genuine hangs.
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
          signal: AbortSignal.timeout(opts.timeout || 60000),
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
