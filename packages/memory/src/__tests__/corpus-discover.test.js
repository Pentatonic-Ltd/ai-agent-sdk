/**
 * Tests for corpus discovery — the file walker, ignore-rule handling,
 * and the security exclusions.
 *
 * Critical guarantee: NO secret-pattern file may EVER be yielded by
 * discover(), even if .gitignore explicitly un-ignores it. This is the
 * "Uber engineer" expectation — the credential walker is paranoid.
 */

import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";

import { discover, isPathEligible } from "../corpus/discover.js";

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), "tes-discover-"));
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "node_modules", "lodash"), { recursive: true });
  await mkdir(join(root, "secrets"), { recursive: true });
  await mkdir(join(root, ".aws"), { recursive: true });
  await mkdir(join(root, ".ssh"), { recursive: true });

  await writeFile(join(root, "src", "index.ts"), "export const x = 1;\n");
  await writeFile(join(root, "src", "util.ts"), "// util\nexport const y = 2;\n");
  await writeFile(join(root, "README.md"), "# Project\n\nHello.\n");
  await writeFile(join(root, "package.json"), '{"name":"x"}');
  await writeFile(
    join(root, "node_modules", "lodash", "index.js"),
    "module.exports = {};"
  );

  // Files that MUST NEVER be returned
  await writeFile(join(root, ".env"), "API_KEY=should_never_leak\n");
  await writeFile(join(root, ".env.local"), "DB_URL=secret\n");
  await writeFile(join(root, "id_rsa"), "PRIVATE KEY DATA\n");
  await writeFile(join(root, "server.pem"), "CERT DATA\n");
  await writeFile(join(root, "secrets", "api.json"), '{"key":"abc"}');
  await writeFile(join(root, ".aws", "credentials"), "[default]\naws_access_key_id=AKIA...");
  await writeFile(join(root, ".ssh", "config"), "Host github\n  User git");
  await writeFile(join(root, "service-account.json"), '{"private_key":"..."}');

  // .gitignore that tries to exclude src/util.ts and re-include .env
  await writeFile(
    join(root, ".gitignore"),
    "src/util.ts\n!.env\n!secrets/\n"
  );

  return root;
}

async function collectAll(repoRoot, opts = {}) {
  const files = [];
  for await (const f of discover(repoRoot, opts)) files.push(f);
  return files;
}

describe("discover", () => {
  let repoRoot;

  beforeAll(async () => {
    repoRoot = await makeFixture();
  });

  afterAll(async () => {
    await fsp.rm(repoRoot, { recursive: true, force: true });
  });

  it("yields code, prose, and config files", async () => {
    const files = await collectAll(repoRoot);
    const paths = files.map((f) => f.relPath).sort();
    expect(paths).toContain("src/index.ts");
    expect(paths).toContain("README.md");
    expect(paths).toContain("package.json");
  });

  it("NEVER yields .env files even if .gitignore un-ignores them", async () => {
    const files = await collectAll(repoRoot);
    const paths = files.map((f) => f.relPath);
    expect(paths).not.toContain(".env");
    expect(paths).not.toContain(".env.local");
  });

  it("NEVER yields private key or cert files", async () => {
    const files = await collectAll(repoRoot);
    const paths = files.map((f) => f.relPath);
    expect(paths).not.toContain("id_rsa");
    expect(paths).not.toContain("server.pem");
  });

  it("NEVER yields files inside .aws/ or .ssh/", async () => {
    const files = await collectAll(repoRoot);
    const paths = files.map((f) => f.relPath);
    for (const p of paths) {
      expect(p).not.toMatch(/^\.aws\//);
      expect(p).not.toMatch(/^\.ssh\//);
    }
  });

  it("NEVER yields files in secrets/ even with .gitignore !secrets/", async () => {
    const files = await collectAll(repoRoot);
    const paths = files.map((f) => f.relPath);
    expect(paths.some((p) => p.startsWith("secrets/"))).toBe(false);
  });

  it("excludes service-account JSON heuristically", async () => {
    const files = await collectAll(repoRoot);
    const paths = files.map((f) => f.relPath);
    expect(paths).not.toContain("service-account.json");
  });

  it("skips node_modules at directory level", async () => {
    const files = await collectAll(repoRoot);
    const paths = files.map((f) => f.relPath);
    expect(paths.some((p) => p.startsWith("node_modules/"))).toBe(false);
  });

  it("respects .gitignore for non-secret paths", async () => {
    const files = await collectAll(repoRoot);
    const paths = files.map((f) => f.relPath);
    expect(paths).not.toContain("src/util.ts");
  });

  it("can skip .gitignore honoring when asked", async () => {
    const files = await collectAll(repoRoot, { honorGitignore: false });
    const paths = files.map((f) => f.relPath);
    expect(paths).toContain("src/util.ts");
    // But hard-excludes still apply
    expect(paths).not.toContain(".env");
  });

  it("attaches a content hash and size to each file", async () => {
    const files = await collectAll(repoRoot);
    for (const f of files) {
      expect(f.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(typeof f.size).toBe("number");
      expect(f.size).toBeGreaterThan(0);
    }
  });

  it("emits warnings for hard-excluded files (visibility)", async () => {
    const warnings = [];
    await collectAll(repoRoot, { onWarning: (m) => warnings.push(m) });
    // At least one secret-exclusion warning fired
    expect(warnings.some((w) => w.includes(".env"))).toBe(true);
  });
});

describe("isPathEligible", () => {
  it("rejects hard-excluded paths", () => {
    expect(isPathEligible(".env").eligible).toBe(false);
    expect(isPathEligible("config/.env.production").eligible).toBe(false);
    expect(isPathEligible("server.key").eligible).toBe(false);
    expect(isPathEligible(".aws/credentials").eligible).toBe(false);
  });

  it("rejects paths inside skip dirs", () => {
    expect(isPathEligible("node_modules/foo/index.js").eligible).toBe(false);
    expect(isPathEligible("dist/bundle.js").eligible).toBe(false);
    expect(isPathEligible("__pycache__/foo.pyc").eligible).toBe(false);
  });

  it("rejects skipped extensions", () => {
    expect(isPathEligible("yarn.lock").eligible).toBe(false);
    expect(isPathEligible("vendor.min.js").eligible).toBe(false);
    expect(isPathEligible("logo.png").eligible).toBe(false);
  });

  it("accepts normal source files", () => {
    expect(isPathEligible("src/index.ts").eligible).toBe(true);
    expect(isPathEligible("README.md").eligible).toBe(true);
    expect(isPathEligible("config/app.yaml").eligible).toBe(true);
  });
});
