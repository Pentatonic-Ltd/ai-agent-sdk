import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function readJSON(relativePath) {
  const full = join(ROOT, relativePath);
  return JSON.parse(readFileSync(full, "utf-8"));
}

describe("plugin.json", () => {
  const plugin = readJSON(".claude-plugin/plugin.json");

  it("has required fields", () => {
    expect(plugin.name).toBeDefined();
    expect(plugin.description).toBeDefined();
    expect(plugin.version).toBeDefined();
  });

  it("has a valid semver version", () => {
    expect(plugin.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("has license", () => {
    expect(plugin.license).toBe("MIT");
  });

  it("has author with name", () => {
    expect(plugin.author).toBeDefined();
    expect(plugin.author.name).toBeDefined();
  });

  it("has repository URL", () => {
    expect(plugin.repository).toContain("github.com");
  });
});

describe("marketplace.json", () => {
  const marketplace = readJSON(".claude-plugin/marketplace.json");

  it("has required top-level fields", () => {
    expect(marketplace.name).toBeDefined();
    expect(marketplace.owner).toBeDefined();
    expect(marketplace.owner.name).toBeDefined();
    expect(marketplace.metadata).toBeDefined();
    expect(marketplace.plugins).toBeDefined();
  });

  it("has at least one plugin", () => {
    expect(marketplace.plugins.length).toBeGreaterThan(0);
  });

  it("each plugin has name, source, and description", () => {
    for (const plugin of marketplace.plugins) {
      expect(plugin.name).toBeDefined();
      expect(plugin.source).toBeDefined();
      expect(plugin.description).toBeDefined();
    }
  });
});

describe("hooks.json", () => {
  const hooks = readJSON("hooks/hooks.json");

  it("defines hooks object", () => {
    expect(hooks.hooks).toBeDefined();
  });

  it("has all expected hook types", () => {
    const expected = ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "SessionEnd"];
    for (const hookType of expected) {
      expect(hooks.hooks[hookType]).toBeDefined();
      expect(hooks.hooks[hookType].length).toBeGreaterThan(0);
    }
  });

  it("each hook references a valid script file", () => {
    for (const [, entries] of Object.entries(hooks.hooks)) {
      for (const entry of entries) {
        for (const hook of entry.hooks) {
          expect(hook.type).toBe("command");
          expect(hook.command).toContain("node ");
          // Extract script path
          const scriptPath = hook.command
            .replace("node ${CLAUDE_PLUGIN_ROOT}/", "")
            .trim();
          expect(existsSync(join(ROOT, scriptPath))).toBe(true);
        }
      }
    }
  });

  it("each hook has a timeout", () => {
    for (const [, entries] of Object.entries(hooks.hooks)) {
      for (const entry of entries) {
        for (const hook of entry.hooks) {
          expect(typeof hook.timeout).toBe("number");
          expect(hook.timeout).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe(".mcp.json", () => {
  const mcp = readJSON(".mcp.json");

  it("defines mcpServers", () => {
    expect(mcp.mcpServers).toBeDefined();
  });

  it("has tes-memory server", () => {
    expect(mcp.mcpServers["tes-memory"]).toBeDefined();
    expect(mcp.mcpServers["tes-memory"].command).toBe("node");
  });

  it("server points to existing file", () => {
    const args = mcp.mcpServers["tes-memory"].args;
    const scriptPath = args[0].replace("${CLAUDE_PLUGIN_ROOT}/", "");
    expect(existsSync(join(ROOT, scriptPath))).toBe(true);
  });
});

describe("required files exist", () => {
  const requiredFiles = [
    "LICENSE",
    "README.md",
    "package.json",
    ".claude-plugin/plugin.json",
    ".claude-plugin/marketplace.json",
    "hooks/hooks.json",
    ".mcp.json",
    "src/index.js",
    "servers/tes-memory.js",
    "bin/cli.js",
  ];

  for (const file of requiredFiles) {
    it(`${file} exists`, () => {
      expect(existsSync(join(ROOT, file))).toBe(true);
    });
  }
});
