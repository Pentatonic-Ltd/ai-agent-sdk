import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("build output", () => {
  beforeAll(() => {
    execFileSync("npm", ["run", "build"], { cwd: ROOT, stdio: "pipe" });
  });

  it("generates ESM bundle at dist/index.js", () => {
    expect(existsSync(join(ROOT, "dist/index.js"))).toBe(true);
  });

  it("generates CJS bundle at dist/index.cjs", () => {
    expect(existsSync(join(ROOT, "dist/index.cjs"))).toBe(true);
  });

  it("ESM bundle exports TESClient", () => {
    const content = readFileSync(join(ROOT, "dist/index.js"), "utf-8");
    expect(content).toContain("TESClient");
  });

  it("ESM bundle exports Session", () => {
    const content = readFileSync(join(ROOT, "dist/index.js"), "utf-8");
    expect(content).toContain("Session");
  });

  it("ESM bundle exports normalizeResponse", () => {
    const content = readFileSync(join(ROOT, "dist/index.js"), "utf-8");
    expect(content).toContain("normalizeResponse");
  });

  it("CJS bundle exports TESClient", () => {
    const content = readFileSync(join(ROOT, "dist/index.cjs"), "utf-8");
    expect(content).toContain("TESClient");
  });

  it("ESM bundle does not contain node-specific imports", () => {
    const content = readFileSync(join(ROOT, "dist/index.js"), "utf-8");
    expect(content).not.toContain('require("fs")');
    expect(content).not.toContain('require("path")');
  });
});

describe("package.json configuration", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));

  it("main points to CJS bundle", () => {
    expect(pkg.main).toBe("./dist/index.cjs");
  });

  it("module points to ESM bundle", () => {
    expect(pkg.module).toBe("./dist/index.js");
  });

  it("exports map covers import and require", () => {
    expect(pkg.exports["."]).toBeDefined();
    expect(pkg.exports["."].import).toBe("./dist/index.js");
    expect(pkg.exports["."].require).toBe("./dist/index.cjs");
  });

  it("files array includes dist, src, bin", () => {
    expect(pkg.files).toContain("dist");
    expect(pkg.files).toContain("src");
    expect(pkg.files).toContain("bin");
  });

  it("has bin entry", () => {
    expect(pkg.bin).toBeDefined();
    expect(Object.values(pkg.bin)[0]).toBe("./bin/cli.js");
  });

  it("type is module", () => {
    expect(pkg.type).toBe("module");
  });

  it("has license", () => {
    expect(pkg.license).toBe("MIT");
  });
});
