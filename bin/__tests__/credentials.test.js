import { writeCredentials, readCredentials, credentialsPath } from "../lib/credentials.js";
import { mkdtemp, rm, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("credentials helpers", () => {
  let tmp;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "tes-cred-"));
    process.env.XDG_CONFIG_HOME = tmp;
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
    delete process.env.XDG_CONFIG_HOME;
  });

  it("writeCredentials creates ~/.config/tes/credentials.json with mode 0600", async () => {
    await writeCredentials({
      endpoint: "https://api.pentatonic.com",
      clientId: "tes-demo",
      apiKey: "tes_tes-demo_xxxxxx",
    });
    const path = credentialsPath();
    expect(path).toBe(join(tmp, "tes", "credentials.json"));
    const st = await stat(path);
    expect(st.mode & 0o777).toBe(0o600);
    const parsed = JSON.parse(await readFile(path, "utf8"));
    expect(parsed).toEqual({
      endpoint: "https://api.pentatonic.com",
      clientId: "tes-demo",
      apiKey: "tes_tes-demo_xxxxxx",
    });
  });

  it("readCredentials returns null when the file does not exist", async () => {
    const got = await readCredentials();
    expect(got).toBeNull();
  });

  it("readCredentials round-trips a write", async () => {
    await writeCredentials({
      endpoint: "https://api.pentatonic.com",
      clientId: "tes-demo",
      apiKey: "tes_xxx",
    });
    const got = await readCredentials();
    expect(got.clientId).toBe("tes-demo");
  });

  it("writeCredentials overwrites an existing file (login = re-auth)", async () => {
    await writeCredentials({ endpoint: "a", clientId: "b", apiKey: "c" });
    await writeCredentials({ endpoint: "x", clientId: "y", apiKey: "z" });
    const got = await readCredentials();
    expect(got).toEqual({ endpoint: "x", clientId: "y", apiKey: "z" });
  });
});
