import { jest } from "@jest/globals";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let runWhoamiCommand;

describe("whoami command", () => {
  let tmp;
  let logs;
  let errs;
  let log;
  let errLog;
  let fetchMock;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "tes-whoami-"));
    process.env.XDG_CONFIG_HOME = tmp;
    logs = [];
    errs = [];
    log = (m) => logs.push(m);
    errLog = (m) => errs.push(m);
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock;
    ({ runWhoamiCommand } = await import("../commands/whoami.js"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
    delete process.env.XDG_CONFIG_HOME;
  });

  async function writeCreds(creds) {
    const dir = join(tmp, "tes");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "credentials.json"), JSON.stringify(creds));
  }

  it("prints 'Not logged in' and exits 1 when no credentials", async () => {
    const result = await runWhoamiCommand({ log, errLog });
    expect(result.exitCode).toBe(1);
    expect(logs.join("\n")).toMatch(/not logged in|run login/i);
  });

  it("prints tenant identity on healthy creds", async () => {
    await writeCreds({
      endpoint: "https://tes-demo.api.pentatonic.com",
      clientId: "tes-demo",
      apiKey: "tes_xxx",
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ data: { memoryLayers: [{ id: "ml_tes-demo_episodic" }] } }),
    });
    const result = await runWhoamiCommand({ log, errLog });
    expect(result.exitCode).toBe(0);
    expect(logs.join("\n")).toMatch(/tes-demo/);
  });

  it("warns about invalid creds on 401 and exits 2", async () => {
    await writeCreds({
      endpoint: "https://tes-demo.api.pentatonic.com",
      clientId: "tes-demo",
      apiKey: "tes_xxx",
    });
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ errors: [{ message: "unauthorized" }] }),
      text: async () => "unauthorized",
    });
    const result = await runWhoamiCommand({ log, errLog });
    expect(result.exitCode).toBe(2);
    expect(errs.join("\n") + logs.join("\n")).toMatch(/invalid|run login/i);
  });
});
