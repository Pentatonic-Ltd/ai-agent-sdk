/**
 * Signature / reference extraction for corpus ingest.
 *
 * The default mode for corpus ingest. Stores POINTERS to source content
 * (path + line range + a short summary) rather than full chunk content.
 *
 * Why pointers instead of content?
 *
 *   1. Code rots. The repo on disk is the source of truth; an embedded
 *      chunk goes stale silently the moment a file is edited. Pointers
 *      "rot loudly" — a `Read` of a moved/deleted/changed file is a
 *      signal the LLM observes and adjusts to.
 *
 *   2. Privacy. Pentatonic-hosted retrieval needs only the signature
 *      and path, not the full source. Customer code stays on the
 *      customer's machine; only the index leaves.
 *
 *   3. Index size. ~50–200 chars per reference vs ~500–2000 per chunk.
 *      A 12k-chunk repo becomes a ~3k-reference index, often smaller.
 *
 * The extractor is regex-based, not AST. That means it covers ~80% of
 * common cases and falls back to a single file-level reference for
 * anything it doesn't recognise. The walker (discover.js) already
 * filters out generated/binary noise, so the inputs here are
 * generally well-formed text.
 *
 * Per-language strategies:
 *   - Markdown: per-section reference (`## Heading` + first paragraph)
 *   - JS/TS:    per top-level `function`/`class`/`export` definition
 *   - Python:   per `def`/`class` at top level (indent-aware)
 *   - JSON/YAML: top-level keys as a single reference
 *   - Other:    single file-level reference
 *
 * Each reference shape:
 *   {
 *     content,              // text that gets embedded (signature + brief body)
 *     metadata: {
 *       kind: 'code_reference',
 *       path,               // relative path within the repo
 *       symbol?,            // e.g. function/class name, when extractable
 *       start_line,         // 1-indexed
 *       end_line,           // 1-indexed
 *       language,           // 'markdown' | 'javascript' | 'typescript' | 'python' | 'json' | 'yaml' | 'text'
 *       lines,              // "<start>-<end>" — convenience for display
 *     },
 *   }
 */

const MD_EXTS = new Set([".md", ".mdx", ".markdown"]);
const JS_EXTS = new Set([".js", ".jsx", ".mjs", ".cjs"]);
const TS_EXTS = new Set([".ts", ".tsx"]);
const PY_EXTS = new Set([".py"]);
const JSON_EXTS = new Set([".json"]);
const YAML_EXTS = new Set([".yaml", ".yml"]);

function languageOf(ext) {
  if (MD_EXTS.has(ext)) return "markdown";
  if (JS_EXTS.has(ext)) return "javascript";
  if (TS_EXTS.has(ext)) return "typescript";
  if (PY_EXTS.has(ext)) return "python";
  if (JSON_EXTS.has(ext)) return "json";
  if (YAML_EXTS.has(ext)) return "yaml";
  return "text";
}

function ref(content, metadata) {
  return {
    content,
    metadata: {
      kind: "code_reference",
      ...metadata,
      lines: `${metadata.start_line}-${metadata.end_line}`,
    },
  };
}

/**
 * Markdown: one reference per H1/H2 section. Body of the reference is
 * the heading + the first paragraph of prose under it (trimmed).
 */
function extractMarkdownReferences(file) {
  const lines = file.content.split(/\r?\n/);
  const refs = [];
  let currentHeading = null;
  let currentStart = 1;
  let currentBody = [];

  function flush(endLine) {
    if (!currentHeading) return;
    const summary = `${currentHeading}\n\n${currentBody.slice(0, 4).join(" ").trim().slice(0, 240)}`;
    refs.push(
      ref(summary, {
        path: file.relPath,
        symbol: currentHeading.replace(/^#+\s*/, "").trim(),
        start_line: currentStart,
        end_line: endLine,
        language: "markdown",
      })
    );
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headingMatch = line.match(/^(#{1,2})\s+(.+?)\s*$/);
    if (headingMatch) {
      flush(i); // close previous section at the line above
      currentHeading = line.trim();
      currentStart = i + 1;
      currentBody = [];
    } else if (currentHeading) {
      const t = line.trim();
      if (t && !t.startsWith("```")) currentBody.push(t);
    }
  }
  flush(lines.length);

  // No headings? Fall back to a single file-level reference.
  if (refs.length === 0) {
    refs.push(fileLevelReference(file, "markdown"));
  }
  return refs;
}

/**
 * JS / TS: per-top-level-symbol references. Regex over `function`,
 * `class`, `const X =`, and `export ...` declarations at indent 0.
 * Not perfect (no AST), but catches the vast majority of public-API
 * surface. Anything we miss falls into a file-level reference.
 */
function extractJsLikeReferences(file, language) {
  const lines = file.content.split(/\r?\n/);
  const refs = [];
  // Top-level only — anchored at start of line, optionally with `export`
  // (and optionally `default` / `async`).
  const decl =
    /^(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:function\s*\*?\s+([A-Za-z_$][\w$]*)|class\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=)/;

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(decl);
    if (!m) continue;
    const symbol = m[1] || m[2] || m[3];
    if (!symbol) continue;

    // Body extent — read until next blank line or matching brace count.
    // Cheap heuristic: capture up to 8 lines or end-of-block.
    const start = i + 1;
    const endIdx = Math.min(i + 8, lines.length);
    const snippet = lines.slice(i, endIdx).join("\n");
    const summary = `${file.relPath}:${start} — ${symbol}\n${snippet}`.slice(
      0,
      400
    );

    refs.push(
      ref(summary, {
        path: file.relPath,
        symbol,
        start_line: start,
        end_line: endIdx,
        language,
      })
    );
  }

  if (refs.length === 0) {
    refs.push(fileLevelReference(file, language));
  }
  return refs;
}

/**
 * Python: per top-level `def`/`class`. Indent 0 only — methods of a
 * class are not separately yielded; the class entry covers them.
 */
function extractPythonReferences(file) {
  const lines = file.content.split(/\r?\n/);
  const refs = [];
  const decl = /^(def|class)\s+([A-Za-z_][\w]*)/;

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(decl);
    if (!m) continue;
    const symbol = m[2];
    const start = i + 1;
    const endIdx = Math.min(i + 8, lines.length);
    const snippet = lines.slice(i, endIdx).join("\n");
    const summary = `${file.relPath}:${start} — ${symbol}\n${snippet}`.slice(
      0,
      400
    );
    refs.push(
      ref(summary, {
        path: file.relPath,
        symbol,
        start_line: start,
        end_line: endIdx,
        language: "python",
      })
    );
  }
  if (refs.length === 0) refs.push(fileLevelReference(file, "python"));
  return refs;
}

/**
 * JSON / YAML: collapse to a single reference whose body is the
 * top-level keys. Useful as "this config exists and contains X, Y, Z";
 * the agent reads the file for the actual values.
 */
function extractConfigReferences(file, language) {
  const lines = file.content.split(/\r?\n/);
  let keys = [];

  if (language === "json") {
    // Match top-level `"key":` at indent 2 — common json formatting.
    const seen = new Set();
    for (const line of lines) {
      const m = line.match(/^\s{0,4}"([^"]+)"\s*:/);
      if (m && !seen.has(m[1])) {
        seen.add(m[1]);
        keys.push(m[1]);
      }
    }
  } else {
    // YAML: top-level keys appear at indent 0.
    for (const line of lines) {
      const m = line.match(/^([A-Za-z_][\w-]*)\s*:/);
      if (m) keys.push(m[1]);
    }
    keys = [...new Set(keys)];
  }

  const summary = `${file.relPath} — top-level keys: ${keys.slice(0, 12).join(", ") || "(none extracted)"}`;
  return [
    ref(summary, {
      path: file.relPath,
      start_line: 1,
      end_line: lines.length,
      language,
    }),
  ];
}

function fileLevelReference(file, language) {
  const lines = file.content.split(/\r?\n/);
  const head = file.content.slice(0, 240).replace(/\s+/g, " ").trim();
  const summary = `${file.relPath} — ${head}`;
  return ref(summary, {
    path: file.relPath,
    start_line: 1,
    end_line: lines.length,
    language,
  });
}

/**
 * Public entry point. Returns an array of references, each with a
 * `content` field suitable for embedding and a `metadata` field with
 * the pointer back to the source.
 *
 * @param {{relPath: string, content: string, ext: string}} file
 * @returns {Array<{content: string, metadata: object}>}
 */
export function extractReferences(file) {
  const language = languageOf(file.ext || "");
  switch (language) {
    case "markdown":
      return extractMarkdownReferences(file);
    case "javascript":
    case "typescript":
      return extractJsLikeReferences(file, language);
    case "python":
      return extractPythonReferences(file);
    case "json":
    case "yaml":
      return extractConfigReferences(file, language);
    default:
      return [fileLevelReference(file, language)];
  }
}
