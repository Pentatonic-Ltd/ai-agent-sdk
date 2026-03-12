import { normalizeResponse } from "./normalizer.js";
import { sendEvent } from "./transport.js";

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
    this._rounds = 0;
    this._toolCalls = [];
    this._model = null;
  }

  get totalUsage() {
    return {
      prompt_tokens: this._promptTokens,
      completion_tokens: this._completionTokens,
      total_tokens: this._promptTokens + this._completionTokens,
      ai_rounds: this._rounds,
    };
  }

  get toolCalls() {
    return this._toolCalls;
  }

  record(rawResponse) {
    const normalized = normalizeResponse(rawResponse);
    const round = this._rounds;

    this._promptTokens += normalized.usage.prompt_tokens;
    this._completionTokens += normalized.usage.completion_tokens;
    this._rounds += 1;

    if (normalized.model) {
      this._model = normalized.model;
    }

    for (const tc of normalized.toolCalls) {
      this._toolCalls.push({ ...tc, round });
    }

    return normalized;
  }

  async emitChatTurn({ userMessage, assistantResponse, turnNumber }) {
    const capture = this._config.captureContent !== false;
    const maxLen = this._config.maxContentLength;

    // Spread metadata first so SDK-controlled fields always win
    const attributes = {
      ...this._metadata,
      source: "pentatonic-ai-sdk",
      model: this._model,
      usage: this.totalUsage,
      tool_calls: this._toolCalls.length ? this._toolCalls : undefined,
    };

    if (capture) {
      attributes.user_message = truncate(userMessage, maxLen);
      attributes.assistant_response = truncate(assistantResponse, maxLen);
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
