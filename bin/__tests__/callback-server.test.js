import { startCallbackServer } from "../lib/callback-server.js";

async function fetchCallback(port, qs) {
  // Use 127.0.0.1 not "localhost" — undici (Node 18+) resolves localhost to
  // ::1 first, but the server binds to 127.0.0.1 only, so on IPv6-preferring
  // hosts (GitHub Actions runners) the IPv6 attempt ECONNREFUSEs.
  const url = `http://127.0.0.1:${port}/callback?${qs}`;
  const res = await fetch(url);
  return { status: res.status, text: await res.text() };
}

describe("startCallbackServer", () => {
  it("resolves with {code, state} when callback hits with matching state", async () => {
    const expectedState = "abc123";
    const { port, result } = await startCallbackServer({
      ports: [0],
      state: expectedState,
      timeoutMs: 5000,
    });
    const fetchPromise = fetchCallback(
      port,
      `code=AUTH_CODE_XYZ&state=${expectedState}`
    );
    const callback = await result;
    const httpRes = await fetchPromise;
    expect(callback.code).toBe("AUTH_CODE_XYZ");
    expect(callback.state).toBe(expectedState);
    expect(httpRes.status).toBe(200);
    expect(httpRes.text).toMatch(/close this tab/i);
  });

  it("rejects when state does not match", async () => {
    const { port, result } = await startCallbackServer({
      ports: [0],
      state: "EXPECTED",
      timeoutMs: 5000,
    });
    fetchCallback(port, "code=ANY&state=ATTACKER").catch(() => {});
    await expect(result).rejects.toThrow(/state/i);
  });

  it("rejects on timeout", async () => {
    const { result } = await startCallbackServer({
      ports: [0],
      state: "S",
      timeoutMs: 100,
    });
    await expect(result).rejects.toThrow(/timeout|timed out/i);
  });

  it("uses the first available port from the list", async () => {
    // Bind one server to a known port to force the next attempt.
    const blocker = await startCallbackServer({
      ports: [0],
      state: "BLOCKER",
      timeoutMs: 30000,
    });
    const blockedPort = blocker.port;
    // Now ask the second server to try the blocked port first, then fall
    // through to OS-assigned. We expect it to land on a different port.
    const second = await startCallbackServer({
      ports: [blockedPort, 0],
      state: "S",
      timeoutMs: 30000,
    });
    expect(second.port).not.toBe(blockedPort);
    second.cancel();
    blocker.cancel();
  });
});
