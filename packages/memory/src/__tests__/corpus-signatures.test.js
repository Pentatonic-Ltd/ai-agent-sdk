import { extractReferences } from "../corpus/signatures.js";

function file(relPath, content, ext) {
  return {
    relPath,
    content,
    ext: ext ?? "." + relPath.split(".").pop(),
  };
}

describe("corpus/signatures.js — reference extraction", () => {
  describe("metadata shape (universal)", () => {
    it("every reference carries kind=code_reference + path + lines + language", () => {
      const refs = extractReferences(
        file("src/x.ts", "export function foo() { return 1; }")
      );
      expect(refs.length).toBeGreaterThan(0);
      for (const r of refs) {
        expect(r.metadata.kind).toBe("code_reference");
        expect(r.metadata.path).toBe("src/x.ts");
        expect(typeof r.metadata.start_line).toBe("number");
        expect(typeof r.metadata.end_line).toBe("number");
        expect(r.metadata.language).toBe("typescript");
        expect(r.metadata.lines).toBe(
          `${r.metadata.start_line}-${r.metadata.end_line}`
        );
      }
    });
  });

  describe("markdown", () => {
    it("emits one reference per H1/H2 section", () => {
      const md = [
        "# Top",
        "intro paragraph one.",
        "",
        "## Auth",
        "JWT verification middleware lives here.",
        "",
        "## Storage",
        "Postgres + R2.",
      ].join("\n");
      const refs = extractReferences(file("docs/arch.md", md));
      expect(refs.length).toBe(3);
      expect(refs[0].metadata.symbol).toBe("Top");
      expect(refs[1].metadata.symbol).toBe("Auth");
      expect(refs[2].metadata.symbol).toBe("Storage");
      expect(refs[1].content).toMatch(/JWT verification/);
    });

    it("falls back to a file-level reference when there are no headings", () => {
      const refs = extractReferences(
        file("README.txt", "no headings here, just text", ".md")
      );
      expect(refs.length).toBe(1);
      expect(refs[0].metadata.start_line).toBe(1);
      expect(refs[0].content).toMatch(/README\.txt/);
    });
  });

  describe("javascript / typescript", () => {
    it("extracts top-level function declarations", () => {
      const code = [
        "import x from 'y';",
        "",
        "export function authenticate(req) {",
        "  return verify(req);",
        "}",
        "",
        "function helper() { return 1; }",
      ].join("\n");
      const refs = extractReferences(file("src/auth.js", code));
      const symbols = refs.map((r) => r.metadata.symbol);
      expect(symbols).toContain("authenticate");
      expect(symbols).toContain("helper");
    });

    it("extracts class declarations", () => {
      const code = "export class UserService {\n  ping() {}\n}";
      const refs = extractReferences(file("src/svc.ts", code));
      expect(refs.find((r) => r.metadata.symbol === "UserService")).toBeDefined();
    });

    it("extracts top-level const/let/var bindings", () => {
      const code = "export const handler = async (req) => req;";
      const refs = extractReferences(file("src/h.js", code));
      expect(refs[0].metadata.symbol).toBe("handler");
    });

    it("ignores indented (non-top-level) declarations", () => {
      const code = [
        "function outer() {",
        "  function inner() { return 1; }",
        "}",
      ].join("\n");
      const refs = extractReferences(file("src/x.js", code));
      const symbols = refs.map((r) => r.metadata.symbol);
      expect(symbols).toContain("outer");
      expect(symbols).not.toContain("inner");
    });

    it("falls back to file-level reference when nothing matches", () => {
      const code = "// just a comment\nconsole.log('side effect');";
      const refs = extractReferences(file("src/y.js", code));
      expect(refs.length).toBe(1);
      expect(refs[0].metadata.start_line).toBe(1);
      expect(refs[0].content).toMatch(/src\/y\.js/);
    });

    it("captures path:line + symbol in the embedded content", () => {
      const code = "\n\nexport function foo() {}\n";
      const refs = extractReferences(file("a/b.ts", code));
      expect(refs[0].content).toMatch(/a\/b\.ts:3 — foo/);
    });
  });

  describe("python", () => {
    it("extracts top-level def and class declarations", () => {
      const py = [
        "import os",
        "",
        "def authenticate(req):",
        "    return True",
        "",
        "class UserService:",
        "    def ping(self): pass",
      ].join("\n");
      const refs = extractReferences(file("svc/auth.py", py));
      const symbols = refs.map((r) => r.metadata.symbol);
      expect(symbols).toContain("authenticate");
      expect(symbols).toContain("UserService");
      // Methods of the class should NOT be separately extracted
      expect(symbols).not.toContain("ping");
    });
  });

  describe("json / yaml configs", () => {
    it("collapses to a single reference of top-level keys (json)", () => {
      const json = JSON.stringify(
        { name: "x", version: "1.0", dependencies: {} },
        null,
        2
      );
      const refs = extractReferences(file("package.json", json));
      expect(refs.length).toBe(1);
      expect(refs[0].content).toMatch(/top-level keys/);
      expect(refs[0].content).toMatch(/name/);
      expect(refs[0].content).toMatch(/version/);
      expect(refs[0].content).toMatch(/dependencies/);
    });

    it("collapses to a single reference of top-level keys (yaml)", () => {
      const yaml = "name: x\nversion: 1.0\nbuild:\n  steps: []\n";
      const refs = extractReferences(file("ci.yml", yaml));
      expect(refs.length).toBe(1);
      expect(refs[0].content).toMatch(/name/);
      expect(refs[0].content).toMatch(/version/);
      expect(refs[0].content).toMatch(/build/);
      // Indented `steps:` should not appear as a top-level key
      expect(refs[0].content).not.toMatch(/\bsteps\b/);
    });
  });

  describe("unknown languages", () => {
    it("emits a single file-level reference with the head of the content", () => {
      const refs = extractReferences(
        file("data.txt", "some random text\nover multiple lines", ".txt")
      );
      expect(refs.length).toBe(1);
      expect(refs[0].metadata.language).toBe("text");
      expect(refs[0].content).toMatch(/data\.txt/);
      expect(refs[0].content).toMatch(/some random text/);
    });
  });
});
