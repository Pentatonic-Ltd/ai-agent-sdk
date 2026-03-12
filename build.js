import { build } from "esbuild";

// ESM
await build({
  entryPoints: ["src/index.js"],
  outfile: "dist/index.js",
  format: "esm",
  bundle: true,
  platform: "neutral",
  target: "es2020",
});

// CJS
await build({
  entryPoints: ["src/index.js"],
  outfile: "dist/index.cjs",
  format: "cjs",
  bundle: true,
  platform: "neutral",
  target: "es2020",
});

console.log("Built dist/index.js (ESM) and dist/index.cjs (CJS)");
