import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadPlugins } from "../src/plugins.js";

function tmpPluginDir() {
  return mkdtempSync(join(tmpdir(), "doctor-plugins-"));
}

function writePlugin(dir, file, src) {
  writeFileSync(join(dir, file), src);
}

describe("loadPlugins", () => {
  let dir;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("returns [] when the plugin dir doesn't exist", async () => {
    const fake = join(tmpdir(), "doctor-does-not-exist-" + Date.now());
    expect(await loadPlugins({ dir: fake })).toEqual([]);
  });

  it("loads a valid .mjs plugin", async () => {
    dir = tmpPluginDir();
    writePlugin(
      dir,
      "good.mjs",
      `export default {
        name: "good",
        checks: [
          { name: "c1", run: async () => ({ ok: true, msg: "ok" }) },
        ],
      };`
    );
    const plugins = await loadPlugins({ dir });
    expect(plugins).toHaveLength(1);
    expect(plugins[0].name).toBe("good");
    expect(plugins[0].checks).toHaveLength(1);
  });

  it("ignores .js files (only .mjs is supported)", async () => {
    dir = tmpPluginDir();
    writePlugin(
      dir,
      "ignored.js",
      `export default { name: "ignored", checks: [] };`
    );
    expect(await loadPlugins({ dir })).toHaveLength(0);
  });

  it("ignores non-js files", async () => {
    dir = tmpPluginDir();
    writeFileSync(join(dir, "README.md"), "# notes");
    writeFileSync(join(dir, "data.json"), "{}");
    expect(await loadPlugins({ dir })).toHaveLength(0);
  });

  it("skips invalid plugins via onError without throwing", async () => {
    dir = tmpPluginDir();
    writePlugin(dir, "bad.mjs", `export default { name: 'no checks' };`);
    const errors = [];
    const plugins = await loadPlugins({ dir, onError: (e) => errors.push(e) });
    expect(plugins).toEqual([]);
    expect(errors[0]).toMatch(/not a valid plugin/);
  });

  it("skips plugins that throw at load time", async () => {
    // Note: syntax errors in dynamic-imported ESM crash the Jest worker
    // (the SyntaxError isn't catchable across the module boundary), so we
    // exercise the load-failure path with a runtime throw instead, which
    // hits the same try/catch in loadPlugins.
    dir = tmpPluginDir();
    writePlugin(dir, "throws-on-load.mjs", `throw new Error("boom at load");`);
    const errors = [];
    const plugins = await loadPlugins({ dir, onError: (e) => errors.push(e) });
    expect(plugins).toEqual([]);
    expect(errors[0]).toMatch(/failed to load/);
  });

  it("loads multiple plugins from the same dir", async () => {
    dir = tmpPluginDir();
    writePlugin(
      dir,
      "a.mjs",
      `export default { name: "a", checks: [{ name: "x", run: async () => ({ ok: true, msg: "" }) }] };`
    );
    writePlugin(
      dir,
      "b.mjs",
      `export default { name: "b", checks: [{ name: "y", run: async () => ({ ok: true, msg: "" }) }] };`
    );
    const plugins = await loadPlugins({ dir });
    expect(plugins.map((p) => p.name).sort()).toEqual(["a", "b"]);
  });

  it("rejects plugins whose checks lack run()", async () => {
    dir = tmpPluginDir();
    writePlugin(
      dir,
      "bad.mjs",
      `export default { name: "bad", checks: [{ name: "x" }] };`
    );
    const errors = [];
    const plugins = await loadPlugins({ dir, onError: (e) => errors.push(e) });
    expect(plugins).toEqual([]);
    expect(errors[0]).toMatch(/not a valid plugin/);
  });
});
