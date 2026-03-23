import { Session } from "./session.js";
import { wrapClient } from "./wrapper.js";

export class TESClient {
  constructor({ clientId, apiKey, endpoint, headers, userId, captureContent = true, maxContentLength = 4096 }) {
    if (!clientId) throw new Error("clientId is required");
    if (!apiKey) throw new Error("apiKey is required");
    if (!endpoint) throw new Error("endpoint is required");

    const cleanEndpoint = endpoint.replace(/\/$/, "");
    const isLocalDev =
      /^http:\/\/localhost(:\d+)?(\/|$)/.test(cleanEndpoint) ||
      /^http:\/\/127\.0\.0\.1(:\d+)?(\/|$)/.test(cleanEndpoint);
    if (!cleanEndpoint.startsWith("https://") && !isLocalDev) {
      throw new Error(
        "endpoint must use https:// (http:// is only allowed for localhost)"
      );
    }

    this.clientId = clientId;
    this.endpoint = cleanEndpoint;
    this.userId = userId || null;
    this.captureContent = captureContent;
    this.maxContentLength = maxContentLength;

    // Store apiKey and headers as non-enumerable so they won't appear in
    // JSON.stringify, console.log, or error reporter serialization.
    Object.defineProperty(this, "_apiKey", {
      value: apiKey,
      enumerable: false,
      writable: false,
    });
    Object.defineProperty(this, "_headers", {
      value: headers || {},
      enumerable: false,
      writable: false,
    });
  }

  get _config() {
    return {
      clientId: this.clientId,
      apiKey: this._apiKey,
      endpoint: this.endpoint,
      headers: this._headers,
      userId: this.userId,
      captureContent: this.captureContent,
      maxContentLength: this.maxContentLength,
    };
  }

  session(opts) {
    return new Session(this._config, opts);
  }

  wrap(client, { sessionId, userId, metadata, autoEmit = true, waitUntil } = {}) {
    const config = userId ? { ...this._config, userId } : this._config;
    return wrapClient(config, client, { sessionId, metadata, autoEmit, waitUntil });
  }
}
