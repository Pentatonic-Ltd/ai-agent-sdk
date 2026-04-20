import plugin from "../openclaw/index.js";
import { _resetTurnBuffersForTest } from "../openclaw/index.js";
import { _clearSignerCacheForTest } from "../../../../src/vi-session.js";
import { verifyJWS, sha256B64U } from "../../../../src/vi.js";
import { getSessionSigner } from "../../../../src/vi-session.js";

const realFetch = globalThis.fetch;

function captureFetch() {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url, body });
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: { createModuleEvent: { success: true, eventId: "e" } } }),
    };
  };
  return calls;
}

function makeEngine(extraConfig = {}) {
  let factory;
  plugin.register({
    config: {
      tes_endpoint: "https://x.test",
      tes_client_id: "c",
      tes_api_key: "tes_c_xyz",
      ...extraConfig,
    },
    registerTool: () => {},
    registerContextEngine: (_n, fn) => {
      factory = fn;
    },
  });
  return factory();
}

afterEach(() => {
  globalThis.fetch = realFetch;
  _resetTurnBuffersForTest();
  _clearSignerCacheForTest();
});

describe("openclaw plugin — VI signing on hosted CHAT_TURN", () => {
  it("attaches a vi.worker_jws field to emitted attributes", async () => {
    const calls = captureFetch();
    const engine = makeEngine();

    await engine.ingest({
      sessionId: "sess-vi-1",
      message: { role: "user", content: "hi" },
    });
    await engine.ingest({
      sessionId: "sess-vi-1",
      message: { role: "assistant", content: "hello" },
    });

    const turn = calls.find(
      (c) =>
        c.body?.variables?.moduleId === "conversation-analytics" &&
        c.body?.variables?.input?.eventType === "CHAT_TURN"
    );
    const attrs = turn.body.variables.input.data.attributes;
    expect(attrs.vi).toBeDefined();
    expect(typeof attrs.vi.worker_jws).toBe("string");
    expect(attrs.vi.worker_jws.split(".")).toHaveLength(3);
  });

  it("the JWS verifies against the session's signer and binds to the body", async () => {
    const calls = captureFetch();
    const engine = makeEngine();

    await engine.ingest({
      sessionId: "sess-vi-2",
      message: { role: "user", content: "q" },
    });
    await engine.ingest({
      sessionId: "sess-vi-2",
      message: { role: "assistant", content: "a", model: "claude" },
    });

    const attrs = calls.find(
      (c) => c.body?.variables?.moduleId === "conversation-analytics"
    ).body.variables.input.data.attributes;
    const { worker_jws } = attrs.vi;
    // Strip vi to recover the body that was signed.
    const { vi, ...signedBody } = attrs;
    const { publicJwk } = await getSessionSigner("sess-vi-2");
    const result = await verifyJWS(worker_jws, publicJwk);
    expect(result.valid).toBe(true);
    expect(result.payload.sub).toBe("sess-vi-2");
    expect(result.payload.evt).toBe(
      await sha256B64U(JSON.stringify(signedBody))
    );
  });

  it("respects vi_disabled=true and emits without a vi sidecar", async () => {
    const calls = captureFetch();
    const engine = makeEngine({ vi_disabled: true });

    await engine.ingest({
      sessionId: "sess-vi-3",
      message: { role: "user", content: "x" },
    });
    await engine.ingest({
      sessionId: "sess-vi-3",
      message: { role: "assistant", content: "y" },
    });

    const attrs = calls.find(
      (c) => c.body?.variables?.moduleId === "conversation-analytics"
    ).body.variables.input.data.attributes;
    expect(attrs.vi).toBeUndefined();
  });

  it("uses the same signer kid across multiple turns of the same session", async () => {
    const calls = captureFetch();
    const engine = makeEngine();

    for (let i = 0; i < 3; i++) {
      await engine.ingest({
        sessionId: "sess-vi-4",
        message: { role: "user", content: `q${i}` },
      });
      await engine.ingest({
        sessionId: "sess-vi-4",
        message: { role: "assistant", content: `a${i}` },
      });
    }

    const turns = calls.filter(
      (c) => c.body?.variables?.moduleId === "conversation-analytics"
    );
    const kids = await Promise.all(
      turns.map(async (t) => {
        const jws = t.body.variables.input.data.attributes.vi.worker_jws;
        const headerB64 = jws.split(".")[0];
        const header = JSON.parse(
          Buffer.from(headerB64, "base64url").toString("utf-8")
        );
        return header.kid;
      })
    );
    // All three turns share the same signer thumbprint.
    expect(new Set(kids).size).toBe(1);
  });
});
