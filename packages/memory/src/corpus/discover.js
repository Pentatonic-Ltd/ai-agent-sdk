/**
 * Repository discovery — walk a directory and yield files eligible for
 * ingest into the memory layer. Honors .gitignore and .tesignore. Hard-
 * excludes secrets and binary/generated artifacts regardless of ignore
 * files (defense in depth).
 *
 * Pure Node — no external deps. Streams via async iterator so callers
 * can show progress without buffering the whole tree.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative, basename, extname, sep } from "node:path";

/**
 * Hard-exclude patterns. These are matched against both filename and
 * full relative path. They CANNOT be re-included by .gitignore overrides
 * or by .tesignore "!pattern" lines — the rule is: secrets and credentials
 * never leave the developer's machine.
 *
 * Update with care. Each addition should have a justification comment.
 */
const HARD_EXCLUDE_PATTERNS = [
  // Environment files (anything matching .env or .env.*)
  /(^|\/)\.env(\.|$)/,
  // Private keys and certificates
  /\.(pem|key|crt|cer|p12|pfx|jks|keystore)$/i,
  // SSH and cloud credential dirs
  /(^|\/)\.ssh(\/|$)/,
  /(^|\/)\.aws(\/|$)/,
  /(^|\/)\.gcp(\/|$)/,
  /(^|\/)\.azure(\/|$)/,
  // Package registry credentials
  /(^|\/)\.npmrc$/,
  /(^|\/)\.pypirc$/,
  /(^|\/)\.netrc$/,
  // SSH private keys (common ssh-keygen defaults; private has no extension)
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519|xmss)($|\.(?!pub$))/i,
  // Common secret filenames AND directories — `secrets/foo.json` must
  // be excluded too, not just `secrets.json`
  /(^|\/)secrets?(\/|\.|$)/i,
  /(^|\/)credentials?(\/|\.|$)/i,
  /(^|\/)\.htpasswd$/,
  /_secret(\.|$)/i,
  /_token(\.|$)/i,
  /_password(\.|$)/i,
  // Service account JSON (heuristic — files with these stems are almost
  // always GCP service account keys)
  /(^|\/)service[-_]account(\.|$)/i,
];

/**
 * Default skip directories. These are always skipped at directory level
 * (we don't recurse into them) regardless of .gitignore. Keeps the walk
 * fast and prevents accidental ingest of generated artifacts.
 */
const DEFAULT_SKIP_DIRS = new Set([
  ".git",
  ".svn",
  ".hg",
  "node_modules",
  ".pnpm",
  ".yarn",
  "venv",
  ".venv",
  "__pycache__",
  ".pytest_cache",
  "target", // Rust/Maven
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".cache",
  ".turbo",
  ".vercel",
  ".idea",
  ".vscode",
  "coverage",
  ".nyc_output",
  ".gradle",
  ".terraform",
  ".serverless",
]);

/**
 * Default file extensions to skip. Lockfiles, binaries, and generated
 * outputs that have negligible signal-to-noise for memory retrieval.
 */
const DEFAULT_SKIP_EXTENSIONS = new Set([
  // Lockfiles
  ".lock",
  // Compiled / minified
  ".min.js",
  ".min.css",
  ".map",
  // Binaries
  ".so",
  ".dylib",
  ".dll",
  ".exe",
  ".bin",
  ".o",
  ".a",
  ".class",
  ".jar",
  ".war",
  ".pyc",
  ".pyo",
  // Images / media
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".ico",
  ".bmp",
  ".tiff",
  ".pdf",
  ".mp3",
  ".mp4",
  ".mov",
  ".avi",
  ".webm",
  ".wav",
  ".ogg",
  // Archives
  ".zip",
  ".tar",
  ".gz",
  ".bz2",
  ".7z",
  ".rar",
  // Fonts
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  // Datasets (often huge, low signal)
  ".parquet",
  ".arrow",
]);

/**
 * Default cap on individual file size. Files larger than this are
 * skipped — usually generated, vendored, or otherwise low signal.
 * Configurable per call.
 */
const DEFAULT_MAX_FILE_BYTES = 512 * 1024; // 512 KB

/**
 * Match a path against a glob-ish pattern subset (the bits we use from
 * .gitignore: `*`, `?`, `**`, leading `/` for anchored, trailing `/` for
 * directory-only, and `!` for negation handled by the caller).
 *
 * Not a full gitignore implementation — we use the official `git
 * check-ignore` when available (see honorGitignore) for accuracy.
 */
function globToRegex(pattern) {
  let p = pattern.trim();
  if (!p || p.startsWith("#")) return null;
  // Negation handled by caller
  if (p.startsWith("!")) p = p.slice(1);
  const dirOnly = p.endsWith("/");
  if (dirOnly) p = p.slice(0, -1);
  const anchored = p.startsWith("/");
  if (anchored) p = p.slice(1);

  let regex = "";
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (ch === "*") {
      if (p[i + 1] === "*") {
        regex += "(?:.+)?";
        i++;
      } else {
        regex += "[^/]*";
      }
    } else if (ch === "?") {
      regex += "[^/]";
    } else if ("\\^$.+|()[]{}".includes(ch)) {
      regex += "\\" + ch;
    } else {
      regex += ch;
    }
  }
  const prefix = anchored ? "^" : "(^|/)";
  const suffix = dirOnly ? "(/.*)?$" : "$";
  return new RegExp(prefix + regex + suffix);
}

/**
 * Read an ignore file (.gitignore, .tesignore) and return a list of
 * { regex, negate } rules. Last rule wins on conflict.
 */
async function readIgnoreFile(filePath) {
  if (!existsSync(filePath)) return [];
  const content = await readFile(filePath, "utf-8");
  const rules = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const negate = trimmed.startsWith("!");
    const regex = globToRegex(trimmed);
    if (regex) rules.push({ regex, negate });
  }
  return rules;
}

/**
 * Apply ignore rules. Returns true if the path is ignored.
 * Iterates rules in order, last match wins, so later negations can
 * un-ignore earlier matches (matches gitignore semantics).
 */
function isIgnored(relativePath, rules) {
  let ignored = false;
  for (const { regex, negate } of rules) {
    if (regex.test(relativePath)) {
      ignored = !negate;
    }
  }
  return ignored;
}

/**
 * Check if a path matches any hard-exclude pattern. These cannot be
 * overridden — secrets and credentials never get ingested.
 */
function isHardExcluded(relativePath) {
  return HARD_EXCLUDE_PATTERNS.some((rx) => rx.test(relativePath));
}

/**
 * Compute SHA-256 content hash (hex). Used for delta sync — if a file's
 * hash hasn't changed since last ingest, we can skip re-embedding it.
 */
function hashContent(content) {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Walk a repository root and yield ingest-eligible files.
 *
 * @param {string} repoRoot - Absolute path to the repo root.
 * @param {object} [opts]
 * @param {Set<string>} [opts.skipDirs] - Override default skip directories
 * @param {Set<string>} [opts.skipExtensions] - Override default skip extensions
 * @param {number} [opts.maxFileBytes] - Override default max file size
 * @param {boolean} [opts.honorGitignore=true] - Honor .gitignore
 * @param {boolean} [opts.honorTesignore=true] - Honor .tesignore
 * @param {Function} [opts.onWarning] - (msg) => void for non-fatal issues
 * @returns {AsyncIterable<{path: string, relPath: string, size: number, hash: string, content: string}>}
 */
export async function* discover(repoRoot, opts = {}) {
  const skipDirs = opts.skipDirs || DEFAULT_SKIP_DIRS;
  const skipExtensions = opts.skipExtensions || DEFAULT_SKIP_EXTENSIONS;
  const maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const onWarning = opts.onWarning || (() => {});

  const ignoreRules = [];
  if (opts.honorGitignore !== false) {
    ignoreRules.push(...(await readIgnoreFile(join(repoRoot, ".gitignore"))));
  }
  if (opts.honorTesignore !== false) {
    ignoreRules.push(...(await readIgnoreFile(join(repoRoot, ".tesignore"))));
  }

  yield* walk(repoRoot, repoRoot, {
    skipDirs,
    skipExtensions,
    maxFileBytes,
    ignoreRules,
    onWarning,
  });
}

async function* walk(currentDir, repoRoot, ctx) {
  let entries;
  try {
    entries = await readdir(currentDir, { withFileTypes: true });
  } catch (err) {
    ctx.onWarning(`discover: cannot read ${currentDir}: ${err.message}`);
    return;
  }

  for (const entry of entries) {
    const fullPath = join(currentDir, entry.name);
    const relPath = relative(repoRoot, fullPath).split(sep).join("/");

    if (entry.isDirectory()) {
      if (ctx.skipDirs.has(entry.name)) continue;
      if (isHardExcluded(relPath + "/")) continue;
      if (isIgnored(relPath + "/", ctx.ignoreRules)) continue;
      yield* walk(fullPath, repoRoot, ctx);
      continue;
    }

    if (!entry.isFile()) continue;

    if (isHardExcluded(relPath)) {
      ctx.onWarning(`discover: hard-excluded ${relPath} (secret pattern)`);
      continue;
    }
    if (isIgnored(relPath, ctx.ignoreRules)) continue;

    const ext = extname(entry.name).toLowerCase();
    // .min.X is an extension chain; check the full filename too
    const isMin = entry.name.endsWith(".min.js") || entry.name.endsWith(".min.css");
    if (ctx.skipExtensions.has(ext) || isMin) continue;

    let s;
    try {
      s = await stat(fullPath);
    } catch (err) {
      ctx.onWarning(`discover: cannot stat ${relPath}: ${err.message}`);
      continue;
    }
    if (s.size === 0) continue;
    if (s.size > ctx.maxFileBytes) {
      ctx.onWarning(
        `discover: skipping ${relPath} (${s.size} bytes > ${ctx.maxFileBytes} cap)`
      );
      continue;
    }

    let content;
    try {
      content = await readFile(fullPath, "utf-8");
    } catch (err) {
      ctx.onWarning(`discover: cannot read ${relPath}: ${err.message}`);
      continue;
    }

    // Reject likely-binary content (NUL byte heuristic)
    if (content.includes("\0")) {
      ctx.onWarning(`discover: skipping ${relPath} (binary content)`);
      continue;
    }

    yield {
      path: fullPath,
      relPath,
      size: s.size,
      hash: hashContent(content),
      content,
      ext,
      basename: entry.name,
    };
  }
}

/**
 * Exported for tests and for callers who want to validate a single path
 * without walking the tree (e.g. a git-hook handler that gets a list of
 * changed files and needs to know which are eligible).
 */
export function isPathEligible(relPath, opts = {}) {
  const skipDirs = opts.skipDirs || DEFAULT_SKIP_DIRS;
  const skipExtensions = opts.skipExtensions || DEFAULT_SKIP_EXTENSIONS;

  if (isHardExcluded(relPath)) return { eligible: false, reason: "hard_excluded" };

  for (const part of relPath.split("/")) {
    if (skipDirs.has(part)) return { eligible: false, reason: "skip_dir" };
  }

  const ext = extname(relPath).toLowerCase();
  const isMin = relPath.endsWith(".min.js") || relPath.endsWith(".min.css");
  if (skipExtensions.has(ext) || isMin) {
    return { eligible: false, reason: "skip_extension" };
  }

  return { eligible: true };
}

export { HARD_EXCLUDE_PATTERNS, DEFAULT_SKIP_DIRS, DEFAULT_SKIP_EXTENSIONS };
