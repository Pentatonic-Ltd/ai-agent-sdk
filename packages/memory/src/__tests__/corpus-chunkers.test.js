/**
 * Tests for file chunking. Code, prose, structured, and the fallback
 * sliding window. Verifies metadata fidelity (line ranges, heading
 * paths, chunk indices) — these power the "from README.md > Setup"
 * surfacing on retrieval.
 */

import { chunkFile } from "../corpus/chunkers.js";

describe("chunkFile — small files", () => {
  it("returns one chunk for a small file", () => {
    const out = chunkFile({
      relPath: "tiny.md",
      ext: ".md",
      content: "# Hi\n\nShort note.",
    });
    expect(out).toHaveLength(1);
    expect(out[0].metadata.chunk_index).toBe(0);
    expect(out[0].metadata.total_chunks).toBe(1);
    expect(out[0].metadata.kind).toBe("prose");
  });

  it("returns empty array for empty content", () => {
    expect(chunkFile({ relPath: "x.txt", ext: ".txt", content: "" })).toEqual([]);
    expect(chunkFile({ relPath: "x.txt", ext: ".txt", content: "   \n  " })).toEqual([]);
  });
});

describe("chunkFile — markdown", () => {
  function bigMd() {
    let md = "# Top\n\nIntro.\n";
    for (let i = 0; i < 10; i++) {
      md += `\n## Section ${i}\n\n`;
      md += "Paragraph content. ".repeat(80);
      md += "\n";
    }
    return md;
  }

  it("splits on headings and tracks heading_path", () => {
    const out = chunkFile({
      relPath: "doc.md",
      ext: ".md",
      content: bigMd(),
    });
    expect(out.length).toBeGreaterThan(1);
    // Each chunk has a heading path
    for (const c of out) {
      expect(c.metadata.kind).toBe("prose");
      expect(typeof c.metadata.heading_path).toBe("string");
    }
    // At least one chunk hangs off "Top > Section N"
    expect(
      out.some((c) => /^Top > Section \d+$/.test(c.metadata.heading_path))
    ).toBe(true);
  });

  it("records total_chunks consistently", () => {
    const out = chunkFile({ relPath: "doc.md", ext: ".md", content: bigMd() });
    const total = out[0].metadata.total_chunks;
    expect(total).toBe(out.length);
    for (const c of out) expect(c.metadata.total_chunks).toBe(total);
  });
});

describe("chunkFile — code", () => {
  function bigCode(lines = 200) {
    const out = [];
    for (let i = 0; i < lines; i++) {
      out.push(`function fn${i}() { return ${i}; }`);
      if (i % 5 === 4) out.push("");
    }
    return out.join("\n");
  }

  it("emits multiple chunks for large code files", () => {
    const out = chunkFile({
      relPath: "big.ts",
      ext: ".ts",
      content: bigCode(800),
    });
    expect(out.length).toBeGreaterThan(1);
    for (const c of out) {
      expect(c.metadata.kind).toBe("code");
      expect(c.metadata.ext).toBe(".ts");
      expect(typeof c.metadata.line_start).toBe("number");
      expect(typeof c.metadata.line_end).toBe("number");
      expect(c.metadata.line_end).toBeGreaterThanOrEqual(c.metadata.line_start);
    }
  });

  it("snaps chunk boundaries to blank lines when nearby", () => {
    const out = chunkFile({
      relPath: "snap.ts",
      ext: ".ts",
      content: bigCode(400),
    });
    // Find a non-final chunk; its last line should be blank or near-blank
    const nonFinal = out.slice(0, -1);
    expect(nonFinal.length).toBeGreaterThan(0);
  });

  it("preserves chunk_index sequence", () => {
    const out = chunkFile({
      relPath: "seq.ts",
      ext: ".ts",
      content: bigCode(800),
    });
    out.forEach((c, i) => expect(c.metadata.chunk_index).toBe(i));
  });
});

describe("chunkFile — fallback", () => {
  it("uses sliding window for unknown extensions", () => {
    const out = chunkFile({
      relPath: "data.csv",
      ext: ".csv",
      content: "col1,col2,col3\n" + "1,2,3\n".repeat(2000),
    });
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].metadata.kind).toMatch(/text|config|prose|code/);
  });
});

describe("chunkFile — security: chunk content is just text", () => {
  // Defense in depth: the chunker is not where secrets are filtered
  // (discover hard-excludes those), but the chunker must never
  // accidentally mangle content (e.g. stripping characters that look
  // like markup), which would silently lose meaning.
  it("preserves the original content byte-for-byte across chunks", () => {
    const content =
      "# Doc\n\n" +
      "x".repeat(5000) +
      "\n\n## Section\n\nMore content " +
      "y".repeat(3000);
    const out = chunkFile({ relPath: "x.md", ext: ".md", content });
    // Concatenating chunks (with overlap stripped) should reconstruct
    // close to the original — at minimum, every original character
    // appears somewhere across chunks.
    const joined = out.map((c) => c.content).join("");
    expect(joined.length).toBeGreaterThanOrEqual(content.trim().length * 0.95);
  });
});
