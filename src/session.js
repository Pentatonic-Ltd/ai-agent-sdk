import { normalizeResponse } from "./normalizer.js";
import { sendEvent } from "./transport.js";
import { buildTrackUrl } from "./tracking.js";

function truncate(value, maxLen) {
  if (!value || !maxLen || typeof value !== "string") return value;
  if (value.length <= maxLen) return value;
  return value.slice(0, maxLen) + "...[truncated]";
}

export class Session {
  constructor(clientConfig, { sessionId, metadata } = {}) {
    Object.defineProperty(this, '_config', {
      value: clientConfig,
      enumerable: false,
    });
    this.sessionId = sessionId || crypto.randomUUID();
    this._metadata = metadata || {};
    this._reset();
  }

  _reset() {
    this._promptTokens = 0;
    this._completionTokens = 0;
    this._cacheReadTokens = 0;
    this._cacheCreateTokens = 0;
    this._rounds = 0;
    this._toolCalls = [];
    this._model = null;
    this._systemPrompt = null;
  }

  get totalUsage() {
    const usage = {
      prompt_tokens: this._promptTokens,
      completion_tokens: this._completionTokens,
      total_tokens:
        this._promptTokens +
        this._completionTokens +
        this._cacheReadTokens +
        this._cacheCreateTokens,
      ai_rounds: this._rounds,
    };
    // Cache token passthrough (Anthropic only). Added only when non-zero
    // so the legacy { prompt_tokens, completion_tokens, total_tokens,
    // ai_rounds } shape is preserved when no cache is in play. The
    // conversation-analytics Token Universe tab reads these directly.
    if (this._cacheReadTokens) {
      usage.cache_read_input_tokens = this._cacheReadTokens;
    }
    if (this._cacheCreateTokens) {
      usage.cache_creation_input_tokens = this._cacheCreateTokens;
    }
    return usage;
  }

  get toolCalls() {
    return this._toolCalls;
  }

  record(rawResponse) {
    const normalized = normalizeResponse(rawResponse);
    const round = this._rounds;

    this._promptTokens += normalized.usage.prompt_tokens;
    this._completionTokens += normalized.usage.completion_tokens;
    this._cacheReadTokens += normalized.usage.cache_read_input_tokens || 0;
    this._cacheCreateTokens += normalized.usage.cache_creation_input_tokens || 0;
    this._rounds += 1;

    if (normalized.model) {
      this._model = normalized.model;
    }

    for (const tc of normalized.toolCalls) {
      this._toolCalls.push({ ...tc, round });
    }

    return normalized;
  }

  /**
   * Attach a result summary to the most recent tool call matching `toolName`.
   * Call this after executing a tool to include results in the emitted event.
   */
  recordToolResult(toolName, result) {
    for (let i = this._toolCalls.length - 1; i >= 0; i--) {
      if (this._toolCalls[i].tool === toolName && !this._toolCalls[i].result) {
        this._toolCalls[i].result = result;
        return;
      }
    }
  }

  async emitChatTurn({ userMessage, assistantResponse, turnNumber, messages }) {
    const capture = this._config.captureContent !== false;
    const maxLen = this._config.maxContentLength;

    // Spread metadata first so SDK-controlled fields always win
    const attributes = {
      ...this._metadata,
      source: "pentatonic-ai-sdk",
      model: this._model,
      usage: this.totalUsage,
      tool_calls: this._toolCalls.length
        ? (capture ? this._toolCalls : this._toolCalls.map(({ args, ...rest }) => rest))
        : undefined,
    };

    if (capture) {
      attributes.user_message = truncate(userMessage, maxLen);
      attributes.assistant_response = truncate(assistantResponse, maxLen);
      if (this._systemPrompt) {
        attributes.system_prompt = truncate(this._systemPrompt, maxLen);
      }

      if (messages) {
        attributes.messages = messages.map((m) => {
          if (typeof m.content === "string") {
            return { ...m, content: truncate(m.content, maxLen) };
          }
          return m;
        });
      }
    }

    if (turnNumber !== undefined) {
      attributes.turn_number = turnNumber;
    }

    const result = await sendEvent(this._config, {
      eventType: "CHAT_TURN",
      entityType: "conversation",
      data: {
        entity_id: this.sessionId,
        attributes,
      },
    });

    this._reset();
    return result;
  }

  async emitToolUse({ tool, args, resultSummary, durationMs, turnNumber }) {
    const capture = this._config.captureContent !== false;
    const maxLen = this._config.maxContentLength;

    const attributes = {
      ...this._metadata,
      source: "pentatonic-ai-sdk",
      tool,
      duration_ms: durationMs,
      turn_number: turnNumber,
    };

    if (capture) {
      attributes.args = args;
      attributes.result_summary = truncate(resultSummary, maxLen);
    }

    // Spread metadata first so SDK-controlled fields always win
    return sendEvent(this._config, {
      eventType: "TOOL_USE",
      entityType: "conversation",
      data: {
        entity_id: this.sessionId,
        attributes,
      },
    });
  }

  async trackUrl(url, { eventType, attributes } = {}) {
    const payload = {
      u: url,
      s: this.sessionId,
      c: this._config.clientId,
      t: Math.floor(Date.now() / 1000),
      e: eventType || "LINK_CLICK",
    };
    const meta = { ...this._metadata, ...attributes };
    if (Object.keys(meta).length) {
      payload.a = meta;
    }
    return buildTrackUrl(this._config.endpoint, this._config.apiKey, payload);
  }

  async emitSessionStart() {
    return sendEvent(this._config, {
      eventType: "SESSION_START",
      entityType: "conversation",
      data: {
        entity_id: this.sessionId,
        attributes: {
          source: "pentatonic-ai-sdk",
          metadata: this._metadata,
        },
      },
    });
  }
}
