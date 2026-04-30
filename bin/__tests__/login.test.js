import { jest } from "@jest/globals";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Buffer } from "node:buffer";

// Hoisted mock for callback-server. Real one binds a real socket; for
// login command tests we want a deterministic stub.
jest.unstable_mockModule("../lib/callback-server.js", () => ({
  startCallbackServer: jest.fn(),
}));

let runLoginCommand, runInitAlias;
let startCallbackServer;

// Build a fake JWT with given claims (unverified — login decodes claims
// without verifying).
function fakeJwt(claims) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" }))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const payload = Buffer.from(JSON.stringify(claims))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${header}.${payload}.fake-signature`;
}

describe("login command", () => {
  let tmp;
  let fetchMock;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "tes-login-"));
    process.env.XDG_CONFIG_HOME = tmp;

    const cb = await import("../lib/callback-server.js");
    startCallbackServer = cb.startCallbackServer;
    startCallbackServer.mockReset();

    startCallbackServer.mockResolvedValue({
      port: 14171,
      result: Promise.resolve({ code: "AUTH_CODE", state: "RETURNED_STATE" }),
      cancel: jest.fn(),
    });

    fetchMock = jest.fn();
    globalThis.fetch = fetchMock;

    ({ runLoginCommand, runInitAlias } = await import("../commands/login.js"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
    delete process.env.XDG_CONFIG_HOME;
  });

  it("happy path: code → access_token → tes_* key → credentials written", async () => {
    let capturedState;
    startCallbackServer.mockImplementationOnce(({ state }) => {
      capturedState = state;
      return Promise.resolve({
        port: 14171,
        result: Promise.resolve({ code: "AUTH_CODE", state }),
        cancel: jest.fn(),
      });
    });

    const accessToken = fakeJwt({ client_id: "tes-demo", email: "phil@x.com" });

    fetchMock
      // POST /oauth/token
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ access_token: accessToken, expires_in: 300 }),
      })
      // POST /api/graphql (createClientApiToken)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            createClientApiToken: {
              success: true,
              plainTextToken: "tes_tes-demo_LIVE_KEY",
            },
          },
        }),
      });

    const result = await runLoginCommand({
      endpoint: "https://api.pentatonic.com",
      openBrowser: jest.fn(),
      log: () => {},
      errLog: () => {},
    });

    expect(result.exitCode).toBe(0);
    expect(typeof capturedState).toBe("string");
    expect(capturedState.length).toBeGreaterThan(20);

    const tokenCall = fetchMock.mock.calls[0];
    expect(tokenCall[0]).toMatch(/\/oauth\/token$/);
    expect(tokenCall[1].method).toBe("POST");
    const tokenBody = new URLSearchParams(tokenCall[1].body);
    expect(tokenBody.get("grant_type")).toBe("authorization_code");
    expect(tokenBody.get("code")).toBe("AUTH_CODE");

    const credPath = join(tmp, "tes", "credentials.json");
    const creds = JSON.parse(await readFile(credPath, "utf8"));
    expect(creds.apiKey).toBe("tes_tes-demo_LIVE_KEY");
    expect(creds.endpoint).toBe("https://tes-demo.api.pentatonic.com");
    expect(creds.clientId).toBe("tes-demo");
  });

  it("fails non-zero when /oauth/token rejects the code", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: "invalid_grant" }),
    });
    const result = await runLoginCommand({
      endpoint: "https://api.pentatonic.com",
      openBrowser: jest.fn(),
      log: () => {},
      errLog: () => {},
    });
    expect(result.exitCode).not.toBe(0);
  });

  it("fails non-zero when createClientApiToken fails", async () => {
    const accessToken = fakeJwt({ client_id: "tes-demo" });
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ access_token: accessToken, expires_in: 300 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ errors: [{ message: "permission denied" }] }),
      });
    const result = await runLoginCommand({
      endpoint: "https://api.pentatonic.com",
      openBrowser: jest.fn(),
      log: () => {},
      errLog: () => {},
    });
    expect(result.exitCode).not.toBe(0);
  });

  it("propagates port-conflict failure from callback-server", async () => {
    startCallbackServer.mockRejectedValueOnce(
      new Error("Could not bind to any of ports: 14171, 14172, 14173")
    );
    const result = await runLoginCommand({
      endpoint: "https://api.pentatonic.com",
      openBrowser: jest.fn(),
      log: () => {},
      errLog: () => {},
    });
    expect(result.exitCode).not.toBe(0);
  });
});

describe("init alias", () => {
  let runInitAlias;
  let runLoginCommand;
  let startCallbackServer;
  let fetchMock;
  let tmp;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "tes-login-"));
    process.env.XDG_CONFIG_HOME = tmp;

    const cb = await import("../lib/callback-server.js");
    startCallbackServer = cb.startCallbackServer;
    startCallbackServer.mockReset();
    startCallbackServer.mockRejectedValue(new Error("not bound for this test"));

    fetchMock = jest.fn();
    globalThis.fetch = fetchMock;

    ({ runInitAlias, runLoginCommand } = await import("../commands/login.js"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
    delete process.env.XDG_CONFIG_HOME;
  });

  it("emits a one-line deprecation warning to stderr and delegates to login", async () => {
    const errs = [];
    const errLog = (m) => errs.push(m);
    const result = await runInitAlias({
      endpoint: "https://api.pentatonic.com",
      openBrowser: jest.fn(),
      log: () => {},
      errLog,
    });
    expect(errs.join("\n")).toMatch(/init.*deprecated.*login/i);
    expect(typeof result.exitCode).toBe("number");
  });
});
