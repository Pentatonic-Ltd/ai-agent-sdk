/**
 * File chunkers for corpus ingest.
 *
 * Each chunker takes a file (path + content + metadata) and returns
 * an array of Chunk objects ready for embedding + memory ingest.
 *
 *   { content: string, metadata: { kind, name?, lineRange?, ... } }
 *
 * Strategy by file type:
 *   - .md/.mdx/.rst/.txt  → heading-aware split with overlap
 *   - code (.ts/.js/.py/.go/.rs/.java/.rb/...) → sliding window with
 *     line-stable boundaries (split on blank lines, not mid-statement)
 *   - .json/.yaml/.yml/.toml → whole file as one chunk if small,
 *     otherwise top-level key split
 *   - everything else → sliding window
 *
 * Tree-sitter integration for proper AST-aware code chunking is a
 * follow-up (see specs/01 §10). Sliding window with blank-line snapping
 * gives 80% of the value at 5% of the dependency cost.
 */

const DEFAULT_CHUNK_TOKEN_TARGET = 800;
const DEFAULT_CHUNK_OVERLAP_TOKENS = 150;
const TOKEN_PER_CHAR_HEURISTIC = 0.25; // 4 chars ≈ 1 token

const CODE_EXTENSIONS = new Set([
  ".js", ".jsx", ".mjs", ".cjs",
  ".ts", ".tsx",
  ".py", ".pyi",
  ".go",
  ".rs",
  ".java", ".kt", ".kts", ".scala",
  ".rb",
  ".php",
  ".c", ".h", ".cpp", ".hpp", ".cc",
  ".cs",
  ".swift",
  ".sh", ".bash", ".zsh",
  ".sql",
  ".lua",
  ".pl", ".pm",
  ".r",
  ".erl", ".ex", ".exs",
  ".clj", ".cljs",
  ".dart",
  ".groovy",
]);

const PROSE_EXTENSIONS = new Set([
  ".md", ".mdx", ".markdown",
  ".rst",
  ".txt",
  ".adoc",
  ".org",
]);

const STRUCTURED_EXTENSIONS = new Set([
  ".json",
  ".yaml", ".yml",
  ".toml",
  ".ini",
  ".env.example", // not real .env (which is hard-excluded)
]);

function approxTokens(text) {
  return Math.ceil(text.length * TOKEN_PER_CHAR_HEURISTIC);
}

function tokensToChars(tokens) {
  return Math.ceil(tokens / TOKEN_PER_CHAR_HEURISTIC);
}

/**
 * Chunk a file into ingest-ready pieces.
 *
 * @param {object} file - { relPath, content, ext, basename }
 * @param {object} [opts]
 * @param {number} [opts.chunkTokens=800] - Target chunk size in tokens
 * @param {number} [opts.overlapTokens=150] - Overlap between chunks
 * @returns {Array<{content: string, metadata: object}>}
 */
export function chunkFile(file, opts = {}) {
  const { ext = "", content = "", relPath = "" } = file;
  if (!content.trim()) return [];

  const chunkTokens = opts.chunkTokens || DEFAULT_CHUNK_TOKEN_TARGET;
  const overlap = opts.overlapTokens ?? DEFAULT_CHUNK_OVERLAP_TOKENS;

  // Tiny files: one chunk, no splitting
  if (approxTokens(content) <= chunkTokens) {
    return [{
      content,
      metadata: {
        kind: classifyKind(ext),
        chunk_index: 0,
        total_chunks: 1,
      },
    }];
  }

  if (PROSE_EXTENSIONS.has(ext)) {
    return chunkMarkdown(content, chunkTokens, overlap);
  }
  if (STRUCTURED_EXTENSIONS.has(ext)) {
    return chunkStructured(content, ext, chunkTokens);
  }
  if (CODE_EXTENSIONS.has(ext)) {
    return chunkCode(content, chunkTokens, overlap, ext);
  }
  return chunkSlidingWindow(content, chunkTokens, overlap, "text");
}

function classifyKind(ext) {
  if (PROSE_EXTENSIONS.has(ext)) return "prose";
  if (CODE_EXTENSIONS.has(ext)) return "code";
  if (STRUCTURED_EXTENSIONS.has(ext)) return "config";
  return "text";
}

/**
 * Markdown chunker — splits on h1/h2/h3 headings, keeping each section
 * intact when it fits, otherwise sliding-window inside the section.
 * Each chunk carries its heading path in metadata so retrieval can
 * surface "from README.md > Installation > Local setup".
 */
function chunkMarkdown(content, chunkTokens, overlap) {
  const lines = content.split("\n");
  const chunks = [];
  const headingStack = []; // [{level, text}]
  let buffer = [];
  let bufferStartLine = 0;

  function flush() {
    if (!buffer.length) return;
    const text = buffer.join("\n").trim();
    if (!text) {
      buffer = [];
      return;
    }
    if (approxTokens(text) > chunkTokens) {
      // Section too big — fall back to sliding window inside it
      const sub = chunkSlidingWindow(text, chunkTokens, overlap, "prose");
      for (const c of sub) {
        chunks.push({
          content: c.content,
          metadata: {
            kind: "prose",
            heading_path: headingPath(),
            line_start: bufferStartLine + 1,
            chunk_index: chunks.length,
          },
        });
      }
    } else {
      chunks.push({
        content: text,
        metadata: {
          kind: "prose",
          heading_path: headingPath(),
          line_start: bufferStartLine + 1,
          line_end: bufferStartLine + buffer.length,
          chunk_index: chunks.length,
        },
      });
    }
    buffer = [];
  }

  function headingPath() {
    return headingStack.map((h) => h.text).join(" > ");
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (m) {
      flush();
      const level = m[1].length;
      while (
        headingStack.length &&
        headingStack[headingStack.length - 1].level >= level
      ) {
        headingStack.pop();
      }
      headingStack.push({ level, text: m[2] });
      bufferStartLine = i;
      buffer.push(line);
    } else {
      if (!buffer.length) bufferStartLine = i;
      buffer.push(line);
    }
  }
  flush();

  // Stamp total_chunks
  for (const c of chunks) c.metadata.total_chunks = chunks.length;
  return chunks;
}

/**
 * Code chunker — sliding window that snaps to blank-line boundaries so
 * we don't split mid-function. Tracks line ranges in metadata.
 */
function chunkCode(content, chunkTokens, overlap, ext) {
  const lines = content.split("\n");
  const targetChars = tokensToChars(chunkTokens);
  const overlapChars = tokensToChars(overlap);
  const chunks = [];

  let cursor = 0;
  let charCount = 0;
  let chunkStart = 0;
  let lineCharOffsets = [0];
  for (let i = 0; i < lines.length; i++) {
    lineCharOffsets.push(lineCharOffsets[i] + lines[i].length + 1);
  }

  function emit(startLine, endLine) {
    const text = lines.slice(startLine, endLine + 1).join("\n").trim();
    if (!text) return;
    chunks.push({
      content: text,
      metadata: {
        kind: "code",
        ext,
        line_start: startLine + 1,
        line_end: endLine + 1,
        chunk_index: chunks.length,
      },
    });
  }

  while (cursor < lines.length) {
    let endLine = cursor;
    let chunkChars = 0;
    while (endLine < lines.length && chunkChars < targetChars) {
      chunkChars += lines[endLine].length + 1;
      endLine++;
    }
    // Snap end to a blank line if one is within +/- 5 lines
    let snapTarget = endLine;
    for (let k = 0; k < 5 && endLine - 1 - k > cursor; k++) {
      if (!lines[endLine - 1 - k].trim()) {
        snapTarget = endLine - k;
        break;
      }
    }
    snapTarget = Math.min(snapTarget, lines.length);

    emit(cursor, snapTarget - 1);

    if (snapTarget >= lines.length) break;

    // Compute overlap in lines: walk back until overlapChars consumed
    let overlapStart = snapTarget;
    let oc = 0;
    while (overlapStart > cursor + 1 && oc < overlapChars) {
      overlapStart--;
      oc += lines[overlapStart].length + 1;
    }
    cursor = overlapStart;
  }

  for (const c of chunks) c.metadata.total_chunks = chunks.length;
  return chunks;
}

/**
 * Structured-data chunker — small files become one chunk; bigger ones
 * split at top-level keys (JSON/YAML) or at section boundaries (TOML/INI).
 * Doesn't try to parse; uses heuristics so we don't crash on malformed
 * configs.
 */
function chunkStructured(content, ext, chunkTokens) {
  if (approxTokens(content) <= chunkTokens) {
    return [{
      content,
      metadata: { kind: "config", ext, chunk_index: 0, total_chunks: 1 },
    }];
  }

  // For larger configs, just sliding-window — config files at this size
  // are usually generated and unlikely to be hand-edited reference material.
  return chunkSlidingWindow(content, chunkTokens, 0, "config", { ext });
}

/**
 * Generic sliding-window chunker. Used as fallback and inside other
 * chunkers when a section is too large.
 */
function chunkSlidingWindow(content, chunkTokens, overlap, kind, extraMeta = {}) {
  const targetChars = tokensToChars(chunkTokens);
  const overlapChars = tokensToChars(overlap);
  const chunks = [];

  let cursor = 0;
  while (cursor < content.length) {
    let end = Math.min(cursor + targetChars, content.length);

    // Snap to nearest newline if within 200 chars
    if (end < content.length) {
      const nl = content.lastIndexOf("\n", end);
      if (nl > cursor && end - nl < 200) end = nl;
    }

    const text = content.slice(cursor, end).trim();
    if (text) {
      chunks.push({
        content: text,
        metadata: {
          kind,
          chunk_index: chunks.length,
          char_start: cursor,
          char_end: end,
          ...extraMeta,
        },
      });
    }

    if (end >= content.length) break;
    cursor = Math.max(end - overlapChars, cursor + 1);
  }

  for (const c of chunks) c.metadata.total_chunks = chunks.length;
  return chunks;
}

export { CODE_EXTENSIONS, PROSE_EXTENSIONS, STRUCTURED_EXTENSIONS, approxTokens };
